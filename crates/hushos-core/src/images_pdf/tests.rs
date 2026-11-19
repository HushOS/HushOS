//! The cutter and the geometry against e2e/fixtures/images (expected.json and geometry.json, worked
//! out by make.py, not by either twin), and the writer's output read back as a reader would.

use std::io::Read as _;
use std::path::PathBuf;

use flate2::read::ZlibDecoder;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::*;

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../e2e/fixtures/images")
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(fixture_dir().join(name)).unwrap()
}

fn json(name: &str) -> Value {
    serde_json::from_slice(&fixture(name)).unwrap()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}

/// What must never be inside a cut JPEG or a PDF: EXIF's and XMP's and IPTC's own signatures,
/// the fixtures' canary strings and the GPS latitude's bytes.
fn leaks(bytes: &[u8]) -> Vec<String> {
    let expected = json("expected.json");
    let mut needles: Vec<Vec<u8>> = vec![
        b"Exif\0\0".to_vec(),
        b"http://ns.adobe.com/xap/1.0/".to_vec(),
        b"Photoshop 3.0".to_vec(),
        b"8BIM".to_vec(),
        b"MPF\0".to_vec(),
    ];
    for text in expected["canaries"]["text"].as_array().unwrap() {
        needles.push(text.as_str().unwrap().as_bytes().to_vec());
    }
    for gps in expected["canaries"]["gpsLatitudeHex"].as_array().unwrap() {
        needles.push(unhex(gps.as_str().unwrap()));
    }
    needles
        .into_iter()
        .filter(|needle| contains(bytes, needle))
        .map(|needle| String::from_utf8_lossy(&needle).into_owned())
        .collect()
}

#[test]
fn every_jpeg_cuts_as_expected_json_says() {
    let expected = json("expected.json");
    let cases = expected["cut"].as_array().unwrap();
    assert!(cases.len() > 25);
    for case in cases {
        let name = case["file"].as_str().unwrap();
        let outcome = case["outcome"].as_str().unwrap();
        let result = cut_jpeg(&fixture(name));
        match outcome {
            "ok" => {
                let cut = result.unwrap_or_else(|refusal| panic!("{name}: refused as {refusal:?}"));
                assert_eq!(hex(&Sha256::digest(&cut.bytes)), case["sha256"].as_str().unwrap(), "{name}");
                assert_eq!(cut.bytes.len() as u64, case["length"].as_u64().unwrap(), "{name}");
                assert_eq!(cut.width as u64, case["width"].as_u64().unwrap(), "{name}");
                assert_eq!(cut.height as u64, case["height"].as_u64().unwrap(), "{name}");
                assert_eq!(cut.components as u64, case["components"].as_u64().unwrap(), "{name}");
                assert_eq!(cut.orientation as u64, case["orientation"].as_u64().unwrap(), "{name}");
                assert_eq!(cut.adobe, case["adobe"].as_bool().unwrap(), "{name}");
                assert_eq!(leaks(&cut.bytes), Vec::<String>::new(), "{name}");
                let profile = jpeg_icc_profile(&cut.bytes, cut.components);
                match &case["icc"] {
                    Value::Null => assert_eq!(profile, None, "{name}"),
                    icc => assert_eq!(
                        hex(&Sha256::digest(profile.expect(name))),
                        icc["sha256"].as_str().unwrap(),
                        "{name}"
                    ),
                }
            }
            code => {
                let refusal = result.expect_err(name);
                assert_eq!(refusal.code(), code, "{name}");
            }
        }
    }
}

#[test]
fn the_fixtures_carry_what_the_cutter_must_cut() {
    // A fixture that stopped holding its metadata would let a cutter that keeps it pass.
    for (name, needle) in [
        ("gps.jpg", &b"Exif\0\0"[..]),
        ("xmp.jpg", b"HUSHOS-CANARY-XMP"),
        ("iptc.jpg", b"HUSHOS-CANARY-IPTC"),
        ("between-scans.jpg", b"HushCanaryCam"),
        ("mpf-trailer.jpg", b"HUSHOS-CANARY-MPF"),
        ("progressive.jpg", b"HUSHOS-CANARY-COM"),
        ("jfif-thumbnail.jpg", b"HUSHOS-CANARY-JFIF"),
    ] {
        assert!(contains(&fixture(name), needle), "{name}");
    }
    assert!(contains(&fixture("icc.jpg"), b"ICC_PROFILE\0"));
    assert!(contains(&cut_jpeg(&fixture("icc.jpg")).unwrap().bytes, b"ICC_PROFILE\0"));
    assert!(contains(&cut_jpeg(&fixture("adobe-cmyk.jpg")).unwrap().bytes, b"Adobe"));
}

#[test]
fn a_jpeg_cut_in_every_place_is_refused_or_ended_never_a_panic() {
    let whole = fixture("between-scans.jpg");
    for end in 0..whole.len() {
        if let Ok(cut) = cut_jpeg(&whole[..end]) {
            assert!(cut.bytes.ends_with(&[0xFF, 0xD9]), "{end}");
            assert_eq!(leaks(&cut.bytes), Vec::<String>::new(), "{end}");
        }
    }
}

#[test]
fn orientation_is_read_from_both_byte_orders_and_only_the_first_exif() {
    assert_eq!(cut_jpeg(&fixture("orientation-3.jpg")).unwrap().orientation, 3); // big-endian
    assert_eq!(cut_jpeg(&fixture("orientation-6.jpg")).unwrap().orientation, 6); // little-endian
                                                                                 // Out of range, the wrong type, or a directory past the end: upright.
    let tiff = |entry: [u8; 12]| {
        let mut bytes = b"II*\0\x08\0\0\0\x01\0".to_vec();
        bytes.extend_from_slice(&entry);
        bytes
    };
    assert_eq!(exif_orientation(&tiff([0x12, 0x01, 3, 0, 1, 0, 0, 0, 8, 0, 0, 0])), Some(8));
    assert_eq!(exif_orientation(&tiff([0x12, 0x01, 3, 0, 1, 0, 0, 0, 9, 0, 0, 0])), None);
    assert_eq!(exif_orientation(&tiff([0x12, 0x01, 4, 0, 1, 0, 0, 0, 6, 0, 0, 0])), None);
    assert_eq!(exif_orientation(&tiff([0x12, 0x01, 3, 0, 2, 0, 0, 0, 6, 0, 0, 0])), None);
    assert_eq!(exif_orientation(b"II*\0\xff\xff\xff\x7f"), None);
}

#[test]
fn every_layout_matches_geometry_json() {
    let cases = json("geometry.json");
    for case in cases["cases"].as_array().unwrap() {
        let size = match case["size"].as_str().unwrap() {
            "fit" => PageSize::Fit,
            "a4" => PageSize::A4,
            _ => PageSize::Letter,
        };
        let layout = page_layout(
            case["width"].as_u64().unwrap() as u32,
            case["height"].as_u64().unwrap() as u32,
            case["orientation"].as_u64().unwrap() as u8,
            size,
            case["margin"].as_bool().unwrap(),
        );
        let page = case["page"].as_array().unwrap();
        let close = |a: f64, b: &Value| (a - b.as_f64().unwrap()).abs() < 1e-6;
        assert!(close(layout.width, &page[0]) && close(layout.height, &page[1]), "{case}");
        for (got, want) in layout.matrix.iter().zip(case["matrix"].as_array().unwrap()) {
            assert!(close(*got, want), "{case}: {:?}", layout.matrix);
        }
    }
}

#[test]
fn numbers_are_written_plainly() {
    assert_eq!(number(595.2755905511812), "595.2756");
    assert_eq!(number(612.0), "612");
    assert_eq!(number(-0.00001), "0");
    assert_eq!(number(-240.5), "-240.5");
}

// ---------------------------------------------------------------------------
// The writer, read back
// ---------------------------------------------------------------------------

/// The objects a PDF's cross-reference table points at, each checked to start where it says.
fn objects(pdf: &[u8]) -> Vec<(usize, Vec<u8>)> {
    // Byte offsets throughout: the streams between are binary.
    let start = pdf.windows(10).rposition(|window| window == b"startxref\n").unwrap() + 10;
    let tail = std::str::from_utf8(&pdf[start..]).unwrap();
    let xref: usize = tail.lines().next().unwrap().parse().unwrap();
    let table = std::str::from_utf8(&pdf[xref..]).unwrap();
    assert!(table.starts_with("xref\n"), "startxref points at the table");
    let mut lines = table.lines().skip(1);
    let header: Vec<usize> = lines.next().unwrap().split(' ').map(|n| n.parse().unwrap()).collect();
    assert_eq!(header[0], 0);
    let entries: Vec<&str> = lines.by_ref().take(header[1]).collect();
    assert_eq!(entries[0], "0000000000 65535 f ");
    assert!(table.contains(&format!("/Size {}", header[1])));
    let mut found = Vec::new();
    for (number, entry) in entries.iter().enumerate().skip(1) {
        assert_eq!(entry.len(), 19, "a 20-byte entry with its newline");
        let offset: usize = entry[..10].parse().unwrap();
        let head = format!("{number} 0 obj\n");
        assert!(pdf[offset..].starts_with(head.as_bytes()), "object {number} at {offset}");
        let end = offset + find(&pdf[offset..], b"\nendobj\n").unwrap();
        found.push((number, pdf[offset + head.len()..end].to_vec()));
    }
    found
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

/// A stream object's data, cut out by its own /Length.
fn stream_data(body: &[u8]) -> (String, Vec<u8>) {
    let at = find(body, b"stream\n").unwrap();
    let dictionary = String::from_utf8_lossy(&body[..at]).into_owned();
    let length: usize =
        dictionary.split("/Length ").nth(1).unwrap().split(' ').next().unwrap().parse().unwrap();
    let data = body[at + 7..at + 7 + length].to_vec();
    assert_eq!(&body[at + 7 + length..], b"\nendstream", "the stream ends where /Length says");
    (dictionary, data)
}

fn page_boxes(pdf: &[u8]) -> Vec<String> {
    objects(pdf)
        .into_iter()
        .filter_map(|(_, body)| {
            let text = String::from_utf8_lossy(&body).into_owned();
            text.contains("/Type /Page ")
                .then(|| text.split("/MediaBox [").nth(1).unwrap().split(']').next().unwrap().to_string())
        })
        .collect()
}

/// A red disc on a transparent ground, the way a decoder hands over a PNG with transparency.
fn disc(premultiplied: bool) -> (Vec<u8>, u32, u32) {
    let (width, height) = (64u32, 48u32);
    let mut rgba = Vec::new();
    for y in 0..height {
        for x in 0..width {
            let inside = (x as i32 - 32).pow(2) + (y as i32 - 24).pow(2) < 20 * 20;
            let edge = (x as i32 - 32).pow(2) + (y as i32 - 24).pow(2) < 22 * 22;
            let alpha: u32 = if inside {
                255
            } else if edge {
                128
            } else {
                0
            };
            let red = if premultiplied { (200 * alpha + 127) / 255 } else { 200 };
            rgba.extend_from_slice(&[red as u8, 0, 0, alpha as u8]);
        }
    }
    (rgba, width, height)
}

/// The PDF e2e/fixtures/images/core-made.pdf holds, which a web test opens with pdf.js.
fn core_made() -> Vec<u8> {
    let control = RunControl::new(30_000, None);
    let writer = ImagesPdfWriter::new(PageSize::A4, true);
    for name in ["page-1.jpg", "phone-rotated.jpg", "adobe-cmyk.jpg", "grey.jpg", "gps.jpg", "plain-cmyk.jpg"]
    {
        writer.add_jpeg(fixture(name), control.clone()).unwrap();
    }
    let (rgba, width, height) = disc(true);
    writer.add_pixels(rgba, width, height, true, control.clone()).unwrap();
    writer.finish().unwrap()
}

#[test]
fn the_pdf_holds_each_cut_jpeg_byte_for_byte_and_nothing_it_cut() {
    let pdf = core_made();
    assert!(pdf.starts_with(b"%PDF-1.7\n"));
    assert!(pdf.ends_with(b"%%EOF\n"));
    let found = objects(&pdf);
    for name in ["page-1.jpg", "phone-rotated.jpg", "adobe-cmyk.jpg", "grey.jpg", "gps.jpg", "plain-cmyk.jpg"]
    {
        let cut = cut_jpeg(&fixture(name)).unwrap();
        let stream = found
            .iter()
            .map(|(_, body)| body)
            .filter(|body| find(body, b"/DCTDecode").is_some())
            .map(|body| stream_data(body))
            .find(|(_, data)| *data == cut.bytes);
        let (dictionary, _) = stream.unwrap_or_else(|| panic!("{name} is not in the PDF as cut"));
        assert!(dictionary.contains(&format!("/Width {} /Height {}", cut.width, cut.height)), "{name}");
        // Only Adobe's complemented CMYK is turned back by /Decode; plain CMYK reads as it is.
        let space = match cut.components {
            1 => "/DeviceGray /Bits",
            4 if cut.adobe => "/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]",
            4 => "/DeviceCMYK /Bits",
            _ => "/DeviceRGB /Bits",
        };
        assert!(dictionary.contains(space), "{name}: {dictionary}");
    }
    assert_eq!(leaks(&pdf), Vec::<String>::new());
    assert!(!contains(&pdf, b"/Info"), "no document information");
    let tree = found.iter().find(|(number, _)| *number == PAGE_TREE).unwrap();
    assert!(String::from_utf8_lossy(&tree.1).contains("/Count 7"));
}

#[test]
fn pages_turn_to_their_images_and_the_rotated_photo_stands_up() {
    let pdf = core_made();
    let a4 = (number(210.0 * PT_PER_MM), number(297.0 * PT_PER_MM));
    let landscape = format!("0 0 {} {}", a4.1, a4.0);
    // page-1 is 300x200 (landscape); the phone photo is stored 300x400 and shown 400x300
    // (landscape: its orientation 6 is applied); the CMYK one 200x120; grey 120x90; gps 240x160;
    // plain-cmyk 200x120; the disc 64x48.
    assert_eq!(page_boxes(&pdf), vec![landscape; 7]);
    let drawings: Vec<String> = objects(&pdf)
        .into_iter()
        .filter_map(|(_, body)| {
            let text = String::from_utf8_lossy(&body).into_owned();
            text.contains("cm /Im0 Do").then(|| String::from_utf8_lossy(&stream_data(&body).1).into_owned())
        })
        .collect();
    // The phone photo: drawn turned a quarter clockwise (b negative, c positive), never as stored.
    let expected = page_layout(300, 400, 6, PageSize::A4, true).matrix;
    let rotated = format!(
        "q {} {} {} {} {} {} cm /Im0 Do Q",
        number(expected[0]),
        number(expected[1]),
        number(expected[2]),
        number(expected[3]),
        number(expected[4]),
        number(expected[5])
    );
    assert_eq!(drawings[1], rotated);
    assert!(expected[0] == 0.0 && expected[1] < 0.0 && expected[2] > 0.0 && expected[3] == 0.0);
}

#[test]
fn transparency_becomes_a_soft_mask_and_premultiplied_colour_is_undone() {
    let control = RunControl::new(30_000, None);
    for premultiplied in [false, true] {
        let writer = ImagesPdfWriter::new(PageSize::Fit, false);
        let (rgba, width, height) = disc(premultiplied);
        writer.add_pixels(rgba, width, height, premultiplied, control.clone()).unwrap();
        let pdf = writer.finish().unwrap();
        let found = objects(&pdf);
        let images: Vec<(String, Vec<u8>)> = found
            .iter()
            .filter(|(_, body)| find(body, b"/FlateDecode").is_some())
            .map(|(_, body)| stream_data(body))
            .collect();
        let (colour, colour_data) = images.iter().find(|(d, _)| d.contains("/DeviceRGB")).unwrap();
        let (_, mask_data) = images.iter().find(|(d, _)| d.contains("/DeviceGray")).unwrap();
        assert!(colour.contains("/SMask"));
        let mut rgb = Vec::new();
        ZlibDecoder::new(&colour_data[..]).read_to_end(&mut rgb).unwrap();
        let mut alpha = Vec::new();
        ZlibDecoder::new(&mask_data[..]).read_to_end(&mut alpha).unwrap();
        assert_eq!(rgb.len(), 64 * 48 * 3);
        assert_eq!(alpha.len(), 64 * 48);
        // The disc's half-transparent rim: alpha 128, and its colour the full red, either way.
        let rim = (24 * 64 + 32 + 21) as usize;
        assert_eq!(alpha[rim], 128);
        // Premultiplying at 8 bits loses a little: back within one of the red, never the 100 it was stored as.
        assert!(rgb[rim * 3].abs_diff(200) <= 1, "premultiplied {premultiplied}: {}", rgb[rim * 3]);
        assert_eq!(&rgb[rim * 3 + 1..rim * 3 + 3], &[0, 0]);
        assert_eq!(alpha[0], 0);
        assert_eq!(page_boxes(&pdf), vec!["0 0 64 48".to_string()]);
    }
    // Opaque pixels carry no mask.
    let writer = ImagesPdfWriter::new(PageSize::Fit, false);
    writer.add_pixels([10, 20, 30, 255].repeat(4), 2, 2, false, control.clone()).unwrap();
    let pdf = writer.finish().unwrap();
    assert!(!contains(&pdf, b"/SMask") && !contains(&pdf, b"/DeviceGray"));
}

#[test]
fn the_committed_core_made_pdf_is_what_the_writer_makes() {
    // The web opens this file with pdf.js (apps/web/src/lib/images-pdf/core-made.test.ts); a
    // writer that changed without it would leave that test reading an old PDF.
    let path = fixture_dir().join("core-made.pdf");
    let made = core_made();
    if std::env::var_os("HUSHOS_WRITE_FIXTURES").is_some() {
        std::fs::write(&path, &made).unwrap();
    }
    assert!(
        std::fs::read(&path).unwrap() == made,
        "run with HUSHOS_WRITE_FIXTURES=1 to rewrite core-made.pdf"
    );
}

#[test]
fn qpdf_finds_nothing_wrong_when_it_is_installed() {
    let Ok(status) = std::process::Command::new("qpdf").arg("--version").output() else {
        return;
    };
    if !status.status.success() {
        return;
    }
    let path = std::env::temp_dir().join(format!("hushos-images-pdf-{}.pdf", std::process::id()));
    std::fs::write(&path, core_made()).unwrap();
    let check = std::process::Command::new("qpdf").arg("--check").arg(&path).output().unwrap();
    let _ = std::fs::remove_file(&path);
    let out = String::from_utf8_lossy(&check.stdout);
    assert!(check.status.success(), "{out}{}", String::from_utf8_lossy(&check.stderr));
    assert!(out.contains("No syntax or stream encoding errors"), "{out}");
}

#[test]
fn refusals_and_the_run_ending() {
    let control = RunControl::new(30_000, None);
    let writer = ImagesPdfWriter::new(PageSize::Letter, false);
    assert_eq!(writer.finish(), Err(ImagesPdfError::Refused { code: "damaged".into() }), "a PDF of no pages");
    let writer = ImagesPdfWriter::new(PageSize::Letter, false);
    assert_eq!(
        writer.add_jpeg(fixture("arithmetic.jpg"), control.clone()),
        Err(ImagesPdfError::Refused { code: "unsupported".into() })
    );
    assert_eq!(
        writer.add_pixels(vec![0; 12], 2, 2, false, control.clone()),
        Err(ImagesPdfError::Refused { code: "damaged".into() }),
        "fewer bytes than the size says"
    );
    assert_eq!(writer.pages(), 0, "a refused image adds no page");
    writer.add_jpeg(fixture("plain.jpg"), control.clone()).unwrap();
    writer.finish().unwrap();
    assert!(matches!(
        writer.add_jpeg(fixture("plain.jpg"), control.clone()),
        Err(ImagesPdfError::Failed { .. })
    ));
    assert!(matches!(writer.finish(), Err(ImagesPdfError::Failed { .. })));

    // Past the output limit: refused as too large.
    let small = ImagesPdfWriter::with_limit(PageSize::Fit, false, 4_000);
    small.add_jpeg(fixture("plain.jpg"), control.clone()).unwrap();
    assert_eq!(
        small.add_jpeg(fixture("plain.jpg"), control.clone()),
        Err(ImagesPdfError::Refused { code: "too-large".into() })
    );

    // A cancelled run: the next call fails, and writes nothing.
    let cancelled = RunControl::new(30_000, None);
    cancelled.cancel();
    let writer = ImagesPdfWriter::new(PageSize::Fit, false);
    assert!(matches!(
        writer.add_jpeg(fixture("plain.jpg"), cancelled.clone()),
        Err(ImagesPdfError::Failed { .. })
    ));
    assert_eq!(writer.pages(), 0);
}

#[test]
fn too_many_pixels_is_refused_by_the_size_alone() {
    let control = RunControl::new(30_000, None);
    let writer = ImagesPdfWriter::new(PageSize::Fit, false);
    // Just past 100 megapixels, refused before the bytes are looked at; just under is a size
    // like any other (the wrong byte count refuses it as damaged).
    assert_eq!(
        writer.add_pixels(vec![0; 4], 10_001, 10_000, false, control.clone()),
        Err(ImagesPdfError::Refused { code: "too-many-pixels".into() })
    );
    assert_eq!(
        writer.add_pixels(vec![0; 4], 10_000, 10_000, false, control),
        Err(ImagesPdfError::Refused { code: "damaged".into() })
    );
}

#[test]
fn a_phone_decodes_as_many_pixels_as_its_memory_allows() {
    assert_eq!(images_pdf_max_pixels(2 << 30), 33_554_432);
    assert_eq!(images_pdf_max_pixels(512 << 20), 16_000_000, "never under 16 megapixels");
    assert_eq!(images_pdf_max_pixels(64 << 30), IMAGES_PDF_MAX_PIXELS, "never over the web's 100");
}

#[test]
fn an_image_past_the_limit_is_refused_before_the_pdf_grows() {
    let control = RunControl::new(30_000, None);
    // Noise does not compress: 256x256 of it is about 196 KiB of RGB, past a 50,000-byte PDF.
    let mut seed = 7u32;
    let rgba: Vec<u8> = (0..256 * 256 * 4)
        .map(|i| {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            if i % 4 == 3 {
                255
            } else {
                (seed >> 16) as u8
            }
        })
        .collect();
    let writer = ImagesPdfWriter::with_limit(PageSize::Fit, false, 50_000);
    let before = lock(&writer.state).out.len();
    assert_eq!(
        writer.add_pixels(rgba, 256, 256, false, control.clone()),
        Err(ImagesPdfError::Refused { code: "too-large".into() })
    );
    assert_eq!(lock(&writer.state).out.len(), before, "nothing of it was written");
    // A JPEG larger than what is left, likewise.
    let writer = ImagesPdfWriter::with_limit(PageSize::Fit, false, 2_000);
    assert_eq!(
        writer.add_jpeg(fixture("plain.jpg"), control),
        Err(ImagesPdfError::Refused { code: "too-large".into() })
    );
    assert_eq!(lock(&writer.state).out.len(), before);
}

#[test]
fn a_jpeg_with_its_profile_is_drawn_in_it() {
    let control = RunControl::new(30_000, None);
    for (name, icc) in [("icc.jpg", true), ("icc-mismatch.jpg", false), ("plain.jpg", false)] {
        let writer = ImagesPdfWriter::new(PageSize::Fit, false);
        writer.add_jpeg(fixture(name), control.clone()).unwrap();
        let pdf = writer.finish().unwrap();
        let found = objects(&pdf);
        let image =
            found.iter().map(|(_, body)| body).find(|body| find(body, b"/DCTDecode").is_some()).unwrap();
        let dictionary = stream_data(image).0;
        assert_eq!(dictionary.contains("/ColorSpace [/ICCBased"), icc, "{name}: {dictionary}");
        if icc {
            let cut = cut_jpeg(&fixture(name)).unwrap();
            let profile = jpeg_icc_profile(&cut.bytes, cut.components).unwrap();
            let stream = found
                .iter()
                .filter(|(_, body)| find(body, b"/N 3 /Alternate /DeviceRGB").is_some())
                .map(|(_, body)| stream_data(body))
                .next()
                .unwrap();
            assert_eq!(stream.1, profile, "the profile as the JPEG carries it");
        }
    }
}

#[test]
fn a_lowered_limit_refuses_what_the_256_mib_one_would_take() {
    let control = RunControl::new(30_000, None);
    let writer = ImagesPdfWriter::new(PageSize::Fit, false);
    writer.limit_output(3_000);
    writer.limit_output(u64::MAX);
    assert_eq!(
        writer.add_jpeg(fixture("plain.jpg"), control),
        Err(ImagesPdfError::Refused { code: "too-large".into() }),
        "a later, higher figure never raises it again"
    );
}
