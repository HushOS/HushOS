//! lopdf's side of Edit pages against e2e/fixtures/pdfs (expected.json, worked out by make.py from
//! what it wrote, not by either engine; the web's pdf-lib twin is held to the same file). Every
//! output is read back two ways: by this module's own reader, and by qpdf's structure check where
//! qpdf is installed.

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;

use super::*;

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../e2e/fixtures/pdfs")
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(fixture_dir().join(name)).unwrap()
}

fn expected() -> Value {
    serde_json::from_slice(&fixture("expected.json")).unwrap()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}

fn control() -> Arc<RunControl> {
    RunControl::new(30_000, None)
}

fn pages_json(pages: &[PdfPage]) -> Value {
    Value::Array(
        pages
            .iter()
            .map(|page| serde_json::json!({ "width": page.width, "height": page.height, "rotate": page.rotate }))
            .collect(),
    )
}

/* The same numbers, whatever JSON made them integers or floats. */
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => (x.as_f64().unwrap() - y.as_f64().unwrap()).abs() < 1e-6,
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

/* qpdf --check over the bytes when qpdf is installed: Some(clean), or None without qpdf. */
fn qpdf_clean(bytes: &[u8]) -> Option<bool> {
    Command::new("qpdf").arg("--version").output().ok()?;
    let dir = std::env::temp_dir().join(format!("hushos-pdf-tools-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(format!("{:x}.pdf", Sha256Lite::of(bytes)));
    std::fs::write(&file, bytes).unwrap();
    let output = Command::new("qpdf").arg("--check").arg(&file).output().unwrap();
    let _ = std::fs::remove_file(&file);
    Some(output.status.success())
}

/* A name for a temporary file: no two outputs share one. */
struct Sha256Lite;
impl Sha256Lite {
    fn of(bytes: &[u8]) -> u64 {
        use sha2::{Digest, Sha256};
        u64::from_be_bytes(Sha256::digest(bytes)[..8].try_into().unwrap())
    }
}

fn layer_count(source: &Source) -> (u64, u64) {
    source.layers.as_ref().map_or((0, 0), |layers| (layers.groups.len() as u64, layers.off.len() as u64))
}

/* A PDF of `objects` (numbered from 1, the catalog first), with a cross-reference table. */
fn pdf_of(objects: &[&str]) -> Vec<u8> {
    let mut out = String::from("%PDF-1.7\n");
    let mut offsets = Vec::new();
    for (index, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.push_str(&format!("{} 0 obj\n{body}\nendobj\n", index + 1));
    }
    let xref = out.len();
    out.push_str(&format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1));
    for offset in offsets {
        out.push_str(&format!("{offset:010} 00000 n \n"));
    }
    out.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
        objects.len() + 1
    ));
    out.into_bytes()
}

#[test]
fn pages_below_one_node_share_what_it_gives_them() {
    // Three pages that set nothing inheritable: one copy of the tree's Resources for all of them, not one each.
    let bytes = pdf_of(&[
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 /MediaBox [0 0 100 100] /Resources << /Big [1 2 3 4 5 6 7 8] >> >>",
        "<< /Type /Page /Parent 2 0 R >>",
        "<< /Type /Page /Parent 2 0 R >>",
        "<< /Type /Page /Parent 2 0 R /Rotate 90 >>",
    ]);
    let source =
        super::read(&bytes, PDF_TOOLS_MAX_PAGES as usize, PDF_TOOLS_MAX_OUTPUT_BYTES, &control()).unwrap();
    assert!(Arc::ptr_eq(&source.pages[0].inherited, &source.pages[1].inherited));
    // A page that sets one of them has its own.
    assert!(!Arc::ptr_eq(&source.pages[0].inherited, &source.pages[2].inherited));
    assert_eq!(source.pages[2].info.rotate, 90);
}

#[test]
fn every_fixture_reads_as_expected_json_says() {
    let expected = expected();
    let files = expected["files"].as_array().unwrap();
    assert!(files.len() >= 15);
    for file in files {
        let name = file["file"].as_str().unwrap();
        let outcome = file["outcome"].as_str().unwrap();
        let result = pdf_inspect(fixture(name), control());
        if outcome != "ok" {
            assert_eq!(result, Err(PdfToolsError::Refused { code: outcome.into() }), "{name}");
            continue;
        }
        let read = result.unwrap_or_else(|error| panic!("{name}: {error:?}"));
        assert!(same(&pages_json(&read.pages), &file["pages"]), "{name}: {:?}", read.pages);
        assert_eq!(read.signed, file["signed"].as_bool().unwrap(), "{name}");
        assert_eq!(read.outline, file["outline"].as_bool().unwrap(), "{name}");
        assert_eq!(read.form, file["form"].as_bool().unwrap(), "{name}");
        let source =
            super::read(&fixture(name), PDF_TOOLS_MAX_PAGES as usize, PDF_TOOLS_MAX_OUTPUT_BYTES, &control())
                .unwrap();
        assert_eq!(
            layer_count(&source),
            (file["layers"].as_u64().unwrap(), file["hiddenLayers"].as_u64().unwrap()),
            "{name}"
        );
    }
}

#[test]
fn every_operation_builds_what_expected_json_says() {
    let expected = expected();
    let info_canary = expected["infoCanary"].as_str().unwrap().as_bytes().to_vec();
    let operations = expected["operations"].as_array().unwrap();
    assert!(operations.len() >= 10);
    for operation in operations {
        let name = operation["name"].as_str().unwrap();
        let outputs = operation["outputs"].as_array().unwrap();
        let mut files: Vec<String> = Vec::new();
        for page in outputs.iter().flat_map(|output| output["pages"].as_array().unwrap()) {
            let file = page["file"].as_str().unwrap().to_string();
            if !files.contains(&file) {
                files.push(file);
            }
        }
        let writer = PdfPagesWriter::new();
        for file in &files {
            writer.add(fixture(file), control()).unwrap();
        }
        for output in outputs {
            let plan: Vec<PdfPagePlan> = output["pages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|page| PdfPagePlan {
                    source: files.iter().position(|file| file == page["file"].as_str().unwrap()).unwrap()
                        as u32,
                    page: page["page"].as_u64().unwrap() as u32,
                    rotate: page["rotate"].as_u64().unwrap() as u32,
                })
                .collect();
            let made = writer.build(plan, control()).unwrap_or_else(|error| panic!("{name}: {error:?}"));
            let read = pdf_inspect(made.clone(), control()).unwrap();
            assert!(same(&pages_json(&read.pages), &output["expected"]), "{name}: {:?}", read.pages);
            // Nothing of the source's catalog, no document information, no object streams.
            assert_eq!((read.signed, read.outline, read.form), (false, false, false), "{name}");
            assert!(!contains(&made, &info_canary), "{name}: the source's Info");
            for key in [&b"/Info"[..], b"/Producer", b"/Creator", b"/CreationDate", b"/ModDate", b"/ObjStm"] {
                assert!(!contains(&made, key), "{name}: {}", String::from_utf8_lossy(key));
            }
            assert!(made.starts_with(b"%PDF-1.7"), "{name}");
            // The image bytes of the pages kept are there; those of the pages left out are not.
            for canary in output["present"].as_array().unwrap() {
                assert!(contains(&made, canary.as_str().unwrap().as_bytes()), "{name}: {canary} missing");
            }
            for canary in output["absent"].as_array().unwrap() {
                assert!(!contains(&made, canary.as_str().unwrap().as_bytes()), "{name}: {canary} carried");
            }
            // Layers come along, those off still off.
            let again =
                super::read(&made, PDF_TOOLS_MAX_PAGES as usize, PDF_TOOLS_MAX_OUTPUT_BYTES, &control())
                    .unwrap();
            assert_eq!(
                layer_count(&again),
                (output["layers"].as_u64().unwrap(), output["hiddenLayers"].as_u64().unwrap()),
                "{name}"
            );
            if let Some(clean) = qpdf_clean(&made) {
                assert!(clean, "{name}: qpdf --check failed");
            }
        }
    }
}

#[test]
fn a_page_copied_alone_brings_no_other_page_of_its_source() {
    let writer = PdfPagesWriter::new();
    writer.add(fixture("plain.pdf"), control()).unwrap();
    let made = writer.build(vec![PdfPagePlan { source: 0, page: 1, rotate: 0 }], control()).unwrap();
    assert!(contains(&made, b"(Page 2)"));
    assert!(!contains(&made, b"(Page 1)"));
    assert!(!contains(&made, b"(Page 3)"));
    // The signed page's widget points back at its own page: it lands on the copy, not a second page.
    let signed = PdfPagesWriter::new();
    signed.add(fixture("signed.pdf"), control()).unwrap();
    let alone = signed.build(vec![PdfPagePlan { source: 0, page: 0, rotate: 0 }], control()).unwrap();
    assert_eq!(pdf_inspect(alone.clone(), control()).unwrap().pages.len(), 1);
    let doc = Document::load_mem(&alone).unwrap();
    let page_id = doc.get_pages()[&1];
    let page = doc.get_dictionary(page_id).unwrap();
    let annots = page.get(b"Annots").unwrap().as_array().unwrap();
    let widget = doc.get_dictionary(annots[0].as_reference().unwrap()).unwrap();
    assert_eq!(widget.get(b"P").unwrap().as_reference().unwrap(), page_id);
    // Only one page object in the whole file.
    let pages = doc
        .objects
        .values()
        .filter(
            |object| matches!(object, Object::Dictionary(dict) if is_name(dict.get(b"Type").ok(), b"Page")),
        )
        .count();
    assert_eq!(pages, 1);
}

#[test]
fn a_reference_cycle_and_deep_nesting_end_and_are_bounded() {
    // Resources that reach themselves through references: copied once each, the cycle kept.
    let writer = PdfPagesWriter::new();
    writer.add(fixture("reference-cycle.pdf"), control()).unwrap();
    let made = writer.build(vec![PdfPagePlan { source: 0, page: 0, rotate: 90 }], control()).unwrap();
    let doc = Document::load_mem(&made).unwrap();
    let page = doc.get_dictionary(doc.get_pages()[&1]).unwrap();
    // The page's resources are its own, cut to what it draws; what they reach comes as the cycle it was.
    let resources = page.get(b"Resources").unwrap().as_dict().unwrap();
    let hush = resources.get(b"Hush").unwrap().as_reference().unwrap();
    let back = doc.get_dictionary(hush).unwrap();
    assert_eq!(back.get(b"Self").unwrap().as_reference().unwrap(), hush);
    let original = back.get(b"Back").unwrap().as_reference().unwrap();
    assert_eq!(doc.get_dictionary(original).unwrap().get(b"Hush").unwrap().as_reference().unwrap(), hush);
    // The tree's cycle, 300 levels and 50,000 brackets: refused, never walked forever or recursed into.
    for name in ["tree-cycle.pdf", "deep-tree.pdf", "deep-array.pdf"] {
        assert_eq!(
            pdf_inspect(fixture(name), control()),
            Err(PdfToolsError::Refused { code: "damaged".into() }),
            "{name}"
        );
    }
}

#[test]
fn direct_nesting_past_the_bound_is_damage_when_copied() {
    // A page whose own dictionary nests arrays 600 deep, written directly: lopdf parses up to its
    // own bound of 100 brackets, so build the deep value in memory, as a parser that allowed it would.
    let writer = PdfPagesWriter::new();
    writer.add(fixture("plain.pdf"), control()).unwrap();
    let mut deep = Object::Array(vec![]);
    for _ in 0..(NESTING_MAX_DEPTH + 10) {
        deep = Object::Array(vec![deep]);
    }
    lock(&writer.state).sources[0].pages[0].leaf.set("Deep", deep);
    assert_eq!(
        writer.build(vec![PdfPagePlan { source: 0, page: 0, rotate: 0 }], control()),
        Err(PdfToolsError::Refused { code: "damaged".into() })
    );
}

#[test]
fn a_cancelled_run_stops_reading_and_building() {
    let run = control();
    run.cancel();
    assert!(matches!(pdf_inspect(fixture("plain.pdf"), run.clone()), Err(PdfToolsError::Failed { .. })));
    let writer = PdfPagesWriter::new();
    let live = control();
    writer.add(fixture("plain.pdf"), live.clone()).unwrap();
    live.cancel();
    assert!(matches!(
        writer.build(vec![PdfPagePlan { source: 0, page: 0, rotate: 0 }], live),
        Err(PdfToolsError::Failed { .. })
    ));
}

#[test]
fn limits_hold_pages_outputs_and_a_closed_writer() {
    // An output past the writer's limit is refused, never handed back.
    let writer = PdfPagesWriter::new();
    writer.add(fixture("plain.pdf"), control()).unwrap();
    writer.limit_output(200);
    assert_eq!(
        writer.build(vec![PdfPagePlan { source: 0, page: 0, rotate: 0 }], control()),
        Err(PdfToolsError::Refused { code: "too-large".into() })
    );
    // limit_output never raises the limit.
    writer.limit_output(u64::MAX);
    assert!(writer.build(vec![PdfPagePlan { source: 0, page: 0, rotate: 0 }], control()).is_err());
    // A page that isn't there, and a rotation that isn't a quarter turn, are refused.
    let fresh = PdfPagesWriter::new();
    fresh.add(fixture("plain.pdf"), control()).unwrap();
    assert!(fresh.build(vec![PdfPagePlan { source: 0, page: 3, rotate: 0 }], control()).is_err());
    assert!(fresh.build(vec![PdfPagePlan { source: 1, page: 0, rotate: 0 }], control()).is_err());
    assert!(fresh.build(vec![PdfPagePlan { source: 0, page: 0, rotate: 45 }], control()).is_err());
    assert!(fresh.build(vec![], control()).is_err());
    // Closed: the PDFs read are let go of and nothing more is done.
    fresh.clear();
    assert!(lock(&fresh.state).sources.is_empty());
    assert!(fresh.build(vec![PdfPagePlan { source: 0, page: 0, rotate: 0 }], control()).is_err());
    assert!(fresh.add(fixture("plain.pdf"), control()).is_err());
}

#[test]
fn the_page_cap_counts_every_pdf_added() {
    // A PDF of 1,998 pages already in the run: one of three more would pass 2,000, so it is refused.
    let writer = PdfPagesWriter::new();
    let plain = fixture("plain.pdf");
    let source = read(&plain, 3, PDF_TOOLS_MAX_OUTPUT_BYTES, &control()).unwrap();
    let mut big = Source { doc: source.doc.clone(), pages: Vec::new(), tree: HashSet::new(), layers: None };
    for index in 0..1_998 {
        let page = &source.pages[index % 3];
        big.pages.push(PageNode {
            leaf: page.leaf.clone(),
            id: page.id,
            inherited: Arc::clone(&page.inherited),
            info: page.info,
        });
    }
    lock(&writer.state).sources.push(big);
    assert_eq!(
        writer.add(plain.clone(), control()),
        Err(PdfToolsError::Refused { code: "too-many-pages".into() })
    );
    // One page fewer before it, and it fits.
    lock(&writer.state).sources[0].pages.pop();
    assert_eq!(writer.add(plain, control()).unwrap().pages.len(), 3);
}

#[test]
fn rotations_and_image_sizes_follow_the_same_rules_as_the_web() {
    let rotations: Vec<u32> =
        [Some(90.0), Some(-90.0), Some(450.0), Some(180.0), Some(45.0), Some(0.5), Some(f64::NAN), None]
            .into_iter()
            .map(rotation_of)
            .collect();
    assert_eq!(rotations, vec![90, 270, 90, 180, 0, 0, 0, 0]);
    assert_eq!(pdf_image_size(612.0, 792.0, 0, 150), vec![1275, 1650]);
    assert_eq!(pdf_image_size(720.0, 405.0, 90, 150), vec![844, 1500]);
    assert_eq!(pdf_image_size(0.1, 0.1, 0, 150), vec![1, 1]);
    let limits = pdf_tools_limits(1 << 30);
    assert_eq!(limits.max_input_bytes, 64 * MIB);
    assert_eq!(limits.card_bytes, 16 * MIB);
    assert_eq!(pdf_tools_limits(0).max_input_bytes, 32 * MIB);
}

#[test]
fn a_page_to_draw_carries_its_annotations_in_its_content() {
    let writer = PdfPagesWriter::new();
    writer.add(fixture("annotated.pdf"), control()).unwrap();
    let plan = PdfPagePlan { source: 0, page: 0, rotate: 0 };
    // Kept outputs keep their annotations; the page to draw has them in its content instead.
    let kept = Document::load_mem(&writer.build(vec![plan], control()).unwrap()).unwrap();
    assert!(kept.get_dictionary(kept.get_pages()[&1]).unwrap().has(b"Annots"));
    let drawn = Document::load_mem(&writer.drawable(plan, control()).unwrap()).unwrap();
    let page = drawn.get_dictionary(drawn.get_pages()[&1]).unwrap();
    assert!(!page.has(b"Annots"));
    let content = String::from_utf8(drawn.get_page_content(drawn.get_pages()[&1])).unwrap();
    // Its appearance's 200 by 200 box fitted to the Rect [100 300 300 500]: moved, not scaled.
    assert!(
        content.contains("q 1.0000 0.0000 0.0000 1.0000 100.0000 300.0000 cm /HushAnnot0 Do Q"),
        "{content}"
    );
    // The page's own content first, wrapped so its graphics state ends before the annotation is drawn.
    assert!(content.starts_with("q\n") && content.contains("(Page 1) Tj"));
    let resources = drawn
        .get_dictionary(page.get(b"Resources").unwrap().as_reference().unwrap_or((0, 0)))
        .ok()
        .cloned()
        .unwrap_or_else(|| page.get(b"Resources").unwrap().as_dict().unwrap().clone());
    let xobjects = resources.get(b"XObject").unwrap().as_dict().unwrap();
    let form = drawn.get_object(xobjects.get(b"HushAnnot0").unwrap().as_reference().unwrap()).unwrap();
    assert!(matches!(form, Object::Stream(stream) if stream.content == b"0 0 1 rg 0 0 200 200 re f"));
}

#[test]
fn a_hidden_annotation_is_not_drawn_and_a_scaled_one_fits_its_rect() {
    let bytes = pdf_of(&[
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Annots [4 0 R 5 0 R] >>",
        "<< /Type /Annot /Subtype /Square /F 2 /Rect [0 0 100 100] /AP << /N 6 0 R >> >>",
        "<< /Type /Annot /Subtype /Square /Rect [200 200 400 300] /AP << /N 6 0 R >> >>",
        "<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Length 23 >>\nstream\n0 0 1 rg 0 0 100 100 re f\nendstream",
    ]);
    let writer = PdfPagesWriter::new();
    writer.add(bytes, control()).unwrap();
    let drawn = Document::load_mem(
        &writer.drawable(PdfPagePlan { source: 0, page: 0, rotate: 90 }, control()).unwrap(),
    )
    .unwrap();
    let content = String::from_utf8(drawn.get_page_content(drawn.get_pages()[&1])).unwrap();
    // The hidden one (F 2) not at all; the other scaled 2 by 1 into [200 200 400 300].
    assert_eq!(content.matches(" Do Q").count(), 1, "{content}");
    assert!(
        content.contains("q 2.0000 0.0000 0.0000 1.0000 200.0000 200.0000 cm /HushAnnot0 Do Q"),
        "{content}"
    );
    assert_eq!(
        drawn.get_dictionary(drawn.get_pages()[&1]).unwrap().get(b"Rotate").unwrap().as_i64().unwrap(),
        90
    );
}

#[test]
fn a_content_stream_names_only_what_it_draws() {
    let mut used = Used::default();
    // Names inside strings, arrays, dictionaries and inline image data are not operands.
    let content = b"/F1 12 Tf (not /Im9 Do) Tj [/Im8] TJ /OC << /Im7 1 >> BDC /P1 scn /Sh1 sh /GS1 gs /CS1 cs /DeviceRGB CS \
        q /Im1 Do Q BI /W 1 /H 1 /CS /CS2 /BPC 8 ID \x00/Im6 Do EI /MC0 BDC EMC";
    scan_content(content, &mut used);
    let names = |category: &[u8]| {
        let mut names: Vec<String> = used
            .names
            .get(category)
            .map(|set| set.iter().map(|n| String::from_utf8_lossy(n).into_owned()).collect())
            .unwrap_or_default();
        names.sort();
        names
    };
    assert_eq!(names(b"XObject"), vec!["Im1"]);
    assert_eq!(names(b"Font"), vec!["F1"]);
    assert_eq!(names(b"Pattern"), vec!["P1"]);
    assert_eq!(names(b"Shading"), vec!["Sh1"]);
    assert_eq!(names(b"ExtGState"), vec!["GS1"]);
    assert_eq!(names(b"ColorSpace"), vec!["CS1", "CS2"]);
    assert_eq!(names(b"Properties"), Vec::<String>::new());
}

#[test]
fn a_page_whose_content_cannot_be_decoded_is_refused_not_copied_with_everything() {
    // Its shared resources hold another page's image; its content claims a filter nothing decodes.
    let bytes = pdf_of(&[
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 100 100] /Resources << /XObject << /Im1 5 0 R /Im2 6 0 R >> >> >>",
        "<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>",
        "<< /Type /Page /Parent 2 0 R /Contents 8 0 R >>",
        "<< /Type /XObject /Subtype /Image /Width 4 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\nONE!\nendstream",
        "<< /Type /XObject /Subtype /Image /Width 4 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\nTWO!\nendstream",
        "<< /Filter /JBIG2Decode /Length 7 >>\nstream\n/Im1 Do\nendstream",
        "<< /Length 7 >>\nstream\n/Im2 Do\nendstream",
    ]);
    let writer = PdfPagesWriter::new();
    writer.add(bytes, control()).unwrap();
    assert_eq!(
        writer.build(vec![PdfPagePlan { source: 0, page: 0, rotate: 0 }], control()),
        Err(PdfToolsError::Refused { code: "damaged".into() })
    );
    // The other page decodes, and carries only its own image.
    let made = writer.build(vec![PdfPagePlan { source: 0, page: 1, rotate: 0 }], control()).unwrap();
    assert!(contains(&made, b"TWO!") && !contains(&made, b"ONE!"));
}

#[test]
fn an_output_past_its_limit_is_refused_while_it_is_written() {
    let mut sink = CappedSink { bytes: Vec::new(), max: 10, over: false };
    use std::io::Write as _;
    sink.write_all(b"12345").unwrap();
    assert!(sink.write_all(b"678901").is_err());
    // Refused at the write that would pass it: nothing past the limit held, and the rest let go.
    assert!(sink.over && sink.bytes.is_empty());
}

#[test]
fn an_annotation_on_a_layer_that_is_off_is_not_drawn() {
    // Groups 7 (on) and 8 (off). Annotations: on 7; on 8; on an OCMD AllOn over both; on an OCMD AnyOn over both;
    // on an OCMD with a visibility expression.
    let bytes = pdf_of(&[
        "<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [7 0 R 8 0 R] /D << /OFF [8 0 R] >> >> >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Annots [4 0 R 5 0 R 9 0 R 10 0 R 11 0 R] >>",
        "<< /Type /Annot /Subtype /Square /OC 7 0 R /Rect [0 0 10 10] /AP << /N 6 0 R >> >>",
        "<< /Type /Annot /Subtype /Square /OC 8 0 R /Rect [20 0 30 10] /AP << /N 6 0 R >> >>",
        "<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length 3 >>\nstream\n0 g\nendstream",
        "<< /Type /OCG /Name (On) >>",
        "<< /Type /OCG /Name (Off) >>",
        "<< /Type /Annot /Subtype /Square /OC 12 0 R /Rect [40 0 50 10] /AP << /N 6 0 R >> >>",
        "<< /Type /Annot /Subtype /Square /OC 13 0 R /Rect [60 0 70 10] /AP << /N 6 0 R >> >>",
        "<< /Type /Annot /Subtype /Square /OC 14 0 R /Rect [80 0 90 10] /AP << /N 6 0 R >> >>",
        "<< /Type /OCMD /OCGs [7 0 R 8 0 R] /P /AllOn >>",
        "<< /Type /OCMD /OCGs [7 0 R 8 0 R] >>",
        "<< /Type /OCMD /OCGs [7 0 R] /VE [/Not 7 0 R] >>",
    ]);
    let writer = PdfPagesWriter::new();
    writer.add(bytes, control()).unwrap();
    let drawn = Document::load_mem(
        &writer.drawable(PdfPagePlan { source: 0, page: 0, rotate: 0 }, control()).unwrap(),
    )
    .unwrap();
    let content = String::from_utf8(drawn.get_page_content(drawn.get_pages()[&1])).unwrap();
    // Only the one on the visible group, and the AnyOn one: at x 0 and x 60.
    assert_eq!(content.matches(" Do Q").count(), 2, "{content}");
    assert!(content.contains("0.0000 0.0000 cm /HushAnnot0 Do Q"), "{content}");
    assert!(content.contains("60.0000 0.0000 cm /HushAnnot1 Do Q"), "{content}");
}

#[test]
fn a_flattened_annotation_never_takes_a_name_the_page_uses() {
    let bytes = pdf_of(&[
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Resources << /XObject << /HushAnnot0 5 0 R >> >> /Contents 6 0 R /Annots [4 0 R] >>",
        "<< /Type /Annot /Subtype /Square /Rect [0 0 10 10] /AP << /N 7 0 R >> >>",
        "<< /Type /XObject /Subtype /Image /Width 4 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\nMINE\nendstream",
        "<< /Length 14 >>\nstream\n/HushAnnot0 Do\nendstream",
        "<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length 3 >>\nstream\n0 g\nendstream",
    ]);
    let writer = PdfPagesWriter::new();
    writer.add(bytes, control()).unwrap();
    let made = writer.drawable(PdfPagePlan { source: 0, page: 0, rotate: 0 }, control()).unwrap();
    let drawn = Document::load_mem(&made).unwrap();
    let content = String::from_utf8(drawn.get_page_content(drawn.get_pages()[&1])).unwrap();
    assert!(content.contains("/HushAnnot1 Do Q"), "{content}");
    // The page's own image keeps its name.
    assert!(contains(&made, b"MINE"));
}
