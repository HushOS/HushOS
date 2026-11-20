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
    let resources = page.get(b"Resources").unwrap().as_reference().unwrap();
    let hush = doc.get_dictionary(resources).unwrap().get(b"Hush").unwrap().as_reference().unwrap();
    let back = doc.get_dictionary(hush).unwrap();
    assert_eq!(back.get(b"Back").unwrap().as_reference().unwrap(), resources);
    assert_eq!(back.get(b"Self").unwrap().as_reference().unwrap(), hush);
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
    let mut big = Source { doc: source.doc.clone(), pages: Vec::new(), tree: HashSet::new() };
    for index in 0..1_998 {
        let page = &source.pages[index % 3];
        big.pages.push(PageNode {
            leaf: page.leaf.clone(),
            id: page.id,
            inherited: page.inherited.clone(),
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
