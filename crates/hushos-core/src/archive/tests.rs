//! The archive rules against the fixtures in e2e/fixtures/archives and their expected.json, the
//! same table the web is held to (apps/web/src/lib/archives/zip-archive.test.ts). The committed
//! fixtures are read from disk; the large ones are written here, as make.ts writes them (the
//! Rust job in CI has no Bun), and checked for what they claim before they are used.

use super::*;
use std::io::Write as _;
use std::path::PathBuf;

const PASSWORD: &str = "correct horse battery";
const CANARY: &str = "HUSHOS-CANARY-ZIP-5b1e9c";

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../e2e/fixtures/archives")
}

fn table() -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(fixture_dir().join("expected.json")).unwrap()).unwrap()
}

// ---------------------------------------------------------------------------
// A minimal writer for the large fixtures (the same bytes make.ts lays out)
// ---------------------------------------------------------------------------

struct Spec {
    name: String,
    method: u16,
    packed: Vec<u8>,
    size: u64,
    crc: u32,
    zip64: bool,
    comment: Vec<u8>,
}

fn stored(name: &str) -> Spec {
    Spec {
        name: name.into(),
        method: 0,
        packed: Vec::new(),
        size: 0,
        crc: 0,
        zip64: false,
        comment: Vec::new(),
    }
}

fn deflated_text(name: &str, text: &str) -> Spec {
    let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    encoder.write_all(text.as_bytes()).unwrap();
    Spec {
        name: name.into(),
        method: 8,
        packed: encoder.finish().unwrap(),
        size: text.len() as u64,
        crc: crc32fast::hash(text.as_bytes()),
        zip64: false,
        comment: Vec::new(),
    }
}

/* Raw deflate of `mib` MiB of zeros: one full-flushed block of 1 MiB, repeated, then an empty final block. */
fn deflated_zeros(mib: u64) -> (Vec<u8>, u32) {
    let mut compressor = flate2::Compress::new(flate2::Compression::best(), false);
    let mut block = Vec::with_capacity(4096);
    compressor.compress_vec(&vec![0u8; MIB as usize], &mut block, flate2::FlushCompress::Full).unwrap();
    let mut out = Vec::with_capacity(block.len() * mib as usize + 2);
    for _ in 0..mib {
        out.extend_from_slice(&block);
    }
    out.extend_from_slice(&[0x03, 0x00]);
    // The CRC of the zeros by doubling, as make.ts does.
    let mut unit = crc32fast::Hasher::new();
    unit.update(&vec![0u8; MIB as usize]);
    let mut total = crc32fast::Hasher::new();
    let mut remaining = mib;
    while remaining > 0 {
        if remaining % 2 == 1 {
            total.combine(&unit);
        }
        let copy = unit.clone();
        unit.combine(&copy);
        remaining /= 2;
    }
    (out, total.finalize())
}

fn write_zip(specs: &[Spec], zip64_directory: bool) -> Vec<u8> {
    let mut out = Vec::new();
    let mut offsets = Vec::new();
    let put16 = |out: &mut Vec<u8>, n: u64| out.extend_from_slice(&(n as u16).to_le_bytes());
    let put32 = |out: &mut Vec<u8>, n: u64| out.extend_from_slice(&(n as u32).to_le_bytes());
    let put64 = |out: &mut Vec<u8>, n: u64| out.extend_from_slice(&n.to_le_bytes());
    for spec in specs {
        offsets.push(out.len() as u64);
        put32(&mut out, 0x0403_4b50);
        put16(&mut out, if spec.zip64 { 45 } else { 20 });
        put16(&mut out, 0x800);
        put16(&mut out, spec.method as u64);
        put16(&mut out, 0);
        put16(&mut out, 0x5b63);
        put32(&mut out, spec.crc as u64);
        put32(&mut out, if spec.zip64 { MAX32 } else { spec.packed.len() as u64 });
        put32(&mut out, if spec.zip64 { MAX32 } else { spec.size });
        put16(&mut out, spec.name.len() as u64);
        put16(&mut out, if spec.zip64 { 20 } else { 0 });
        out.extend_from_slice(spec.name.as_bytes());
        if spec.zip64 {
            put16(&mut out, 1);
            put16(&mut out, 16);
            put64(&mut out, spec.size);
            put64(&mut out, spec.packed.len() as u64);
        }
        out.extend_from_slice(&spec.packed);
    }
    let directory_offset = out.len() as u64;
    for (spec, offset) in specs.iter().zip(&offsets) {
        put32(&mut out, 0x0201_4b50);
        put16(&mut out, (3 << 8) | 45);
        put16(&mut out, if spec.zip64 { 45 } else { 20 });
        put16(&mut out, 0x800);
        put16(&mut out, spec.method as u64);
        put16(&mut out, 0);
        put16(&mut out, 0x5b63);
        put32(&mut out, spec.crc as u64);
        put32(&mut out, if spec.zip64 { MAX32 } else { spec.packed.len() as u64 });
        put32(&mut out, if spec.zip64 { MAX32 } else { spec.size });
        put16(&mut out, spec.name.len() as u64);
        put16(&mut out, if spec.zip64 { 28 } else { 0 });
        put16(&mut out, spec.comment.len() as u64);
        put16(&mut out, 0);
        put16(&mut out, 0);
        put32(&mut out, 0o100644 << 16);
        put32(&mut out, if spec.zip64 { MAX32 } else { *offset });
        out.extend_from_slice(spec.name.as_bytes());
        if spec.zip64 {
            put16(&mut out, 1);
            put16(&mut out, 24);
            put64(&mut out, spec.size);
            put64(&mut out, spec.packed.len() as u64);
            put64(&mut out, *offset);
        }
        out.extend_from_slice(&spec.comment);
    }
    let directory_size = out.len() as u64 - directory_offset;
    let count = specs.len() as u64;
    if zip64_directory {
        let record = out.len() as u64;
        put32(&mut out, 0x0606_4b50);
        put64(&mut out, 44);
        put16(&mut out, (3 << 8) | 45);
        put16(&mut out, 45);
        put32(&mut out, 0);
        put32(&mut out, 0);
        put64(&mut out, count);
        put64(&mut out, count);
        put64(&mut out, directory_size);
        put64(&mut out, directory_offset);
        put32(&mut out, 0x0706_4b50);
        put32(&mut out, 0);
        put64(&mut out, record);
        put32(&mut out, 1);
    }
    put32(&mut out, 0x0605_4b50);
    put16(&mut out, 0);
    put16(&mut out, 0);
    put16(&mut out, if zip64_directory { MAX16 } else { count.min(MAX16) });
    put16(&mut out, if zip64_directory { MAX16 } else { count.min(MAX16) });
    put32(&mut out, if zip64_directory { MAX32 } else { directory_size });
    put32(&mut out, if zip64_directory { MAX32 } else { directory_offset });
    put16(&mut out, 0);
    out
}

fn large(name: &str) -> Vec<u8> {
    match name {
        "zeros-1g.zip" => {
            let (packed, crc) = deflated_zeros(1024);
            write_zip(
                &[Spec {
                    name: "zeros.bin".into(),
                    method: 8,
                    packed,
                    size: 1024 * MIB,
                    crc,
                    zip64: false,
                    comment: vec![],
                }],
                false,
            )
        }
        "zip64-5g.zip" => {
            let (packed, crc) = deflated_zeros(5 * 1024);
            write_zip(
                &[
                    Spec {
                        name: "zeros-5g.bin".into(),
                        method: 8,
                        packed,
                        size: 5 * 1024 * MIB,
                        crc,
                        zip64: true,
                        comment: vec![],
                    },
                    deflated_text("readme.txt", &format!("Beside five gibibytes of zeros.\n{CANARY}\n")),
                ],
                true,
            )
        }
        "entries-100001.zip" => {
            write_zip(&(0..100_001).map(|i| stored(&format!("e/{i:06}"))).collect::<Vec<_>>(), true)
        }
        "directory-65m.zip" => write_zip(
            &(0..1_100)
                .map(|i| Spec { comment: vec![b' '; 62_000], ..stored(&format!("c/{i:04}")) })
                .collect::<Vec<_>>(),
            false,
        ),
        other => panic!("no large fixture {other}"),
    }
}

fn bytes_of(name: &str, generated: bool) -> Arc<dyn RangeRead> {
    Arc::new(if generated { large(name) } else { std::fs::read(fixture_dir().join(name)).unwrap() })
}

fn outcome(result: Result<()>) -> String {
    match result {
        Ok(()) => "ok".into(),
        Err(ArchiveError::Refused { code }) => code,
        Err(ArchiveError::Failed { reason }) => panic!("failed underneath: {reason}"),
    }
}

#[test]
fn the_large_fixtures_written_here_are_what_they_claim() {
    // 1 GiB of zeros as about a MiB, with the CRC zlib would give the whole of it.
    let (packed, crc) = deflated_zeros(64);
    let mut inflated = Vec::new();
    flate2::read::DeflateDecoder::new(&packed[..]).read_to_end(&mut inflated).unwrap();
    assert_eq!(inflated.len() as u64, 64 * MIB);
    assert!(inflated.iter().all(|&byte| byte == 0));
    assert_eq!(crc, crc32fast::hash(&inflated));
    assert!(packed.len() < 70 * 1024);
    // The 65 MiB directory is really that large; 100,001 entries really that many.
    let dir = large("directory-65m.zip");
    let end = dir.len() - 22;
    assert!(u32_at(&dir, end + 12) > 65 * MIB);
    let many = large("entries-100001.zip");
    let locator = many.len() - 22 - 20;
    let record = u64_at(&many, locator + 8).unwrap() as usize;
    assert_eq!(u64_at(&many, record + 32).unwrap(), 100_001);
}

#[test]
fn every_fixture_as_expected_json_says() {
    let table = table();
    let fixtures = table["fixtures"].as_object().unwrap();
    for (name, expected) in fixtures {
        let generated = expected["generated"].as_bool().unwrap_or(false);
        let source = bytes_of(name, generated);
        let listing = Zip::open(source.as_ref()).map(|_| ());
        assert_eq!(outcome(listing.clone()), expected["listing"].as_str().unwrap(), "{name}: listing");
        if listing.is_err() {
            continue;
        }
        let zip = Zip::open(source.as_ref()).unwrap();
        let wanted = expected["entries"].as_array().unwrap();
        let paths: Vec<&str> = zip.entries.iter().map(|entry| entry.path.as_str()).collect();
        let want_paths: Vec<&str> = wanted.iter().map(|entry| entry["path"].as_str().unwrap()).collect();
        assert_eq!(paths, want_paths, "{name}: paths");
        assert_eq!(zip.hidden() as u64, expected["hidden"].as_u64().unwrap(), "{name}: hidden");
        for (index, want) in wanted.iter().enumerate() {
            let entry = &zip.entries[index];
            let listed = zip.listed.iter().find(|item| item.index == index as u32).unwrap();
            let label = format!("{name}: {}", entry.path);
            let flag = |key: &str| want[key].as_bool().unwrap_or(false);
            assert_eq!(entry.directory, flag("directory"), "{label}: directory");
            assert_eq!(listed.hidden, flag("hidden"), "{label}: hidden");
            assert_eq!(listed.lock, want["lock"].as_str().unwrap_or("none"), "{label}: lock");
            assert_eq!(listed.support, want["support"].as_str().unwrap_or("ok"), "{label}: support");
            assert_eq!(listed.link, flag("link"), "{label}: link");
            assert_eq!(listed.nested, flag("nested"), "{label}: nested");
            assert_eq!(listed.stored, flag("stored"), "{label}: stored");
            if let Some(size) = want["size"].as_u64() {
                assert_eq!(entry.size, size, "{label}: size");
            }
            if let Some(asks) = want["asksFirst"].as_bool() {
                assert_eq!(zip_entry_asks_first(entry.size, entry.packed), asks, "{label}: asks first");
            }
            let password = (entry.lock != Lock::None).then_some(PASSWORD.as_bytes());
            let index = index as u32;
            assert_eq!(
                outcome(zip.check(source.clone(), index, password)),
                want["check"].as_str().unwrap(),
                "{label}: check"
            );
            assert_eq!(
                outcome(zip.download(source.clone(), index, password, &mut |_| Ok(()))),
                want["download"].as_str().unwrap(),
                "{label}: download"
            );
            if let Some(code) = want["withoutPassword"].as_str() {
                assert_eq!(
                    outcome(zip.check(source.clone(), index, None)),
                    code,
                    "{label}: without a password"
                );
            }
            if let Some(code) = want["wrongPassword"].as_str() {
                assert_eq!(
                    outcome(zip.check(source.clone(), index, Some(b"not it"))),
                    code,
                    "{label}: a wrong password"
                );
            }
        }
        if let Some(parts) = expected["parts"].as_object() {
            for (path, want) in parts {
                let got = &zip.listed.iter().find(|item| &item.path == path).unwrap().parts;
                let want: Vec<String> =
                    want.as_array().unwrap().iter().map(|part| part.as_str().unwrap().to_owned()).collect();
                assert_eq!(got, &want, "{name}: parts of {path}");
            }
        }
        if let Some(unlock) = expected.get("unlock") {
            let right =
                Zip::open(source.as_ref()).unwrap().unlock(source.clone(), PASSWORD.as_bytes()).unwrap();
            let wrong = Zip::open(source.as_ref()).unwrap().unlock(source.clone(), b"not it").unwrap();
            assert_eq!(right, unlock["right"].as_bool().unwrap(), "{name}: unlock with the password");
            assert_eq!(wrong, unlock["wrong"].as_bool().unwrap(), "{name}: unlock with another");
        }
    }
}

#[test]
fn a_preview_is_held_to_its_limit_and_a_password_is_kept_only_once_it_opens() {
    let source = bytes_of("basic.zip", false);
    let zip = Zip::open(source.as_ref()).unwrap();
    let readme = zip.entries.iter().position(|entry| entry.path == "docs/readme.txt").unwrap() as u32;
    let text = zip.preview(source.clone(), readme, 1024, None).unwrap();
    assert!(String::from_utf8(text).unwrap().contains("Read me. This entry is deflated."));
    assert_eq!(outcome(zip.preview(source.clone(), readme, 10, None).map(|_| ())), "too-large");

    let source = bytes_of("aes.zip", false);
    let zip = Zip::open(source.as_ref()).unwrap();
    assert!(!zip.unlock(source.clone(), b"not it").unwrap());
    assert!(zip.password().is_none());
    assert!(zip.unlock(source.clone(), PASSWORD.as_bytes()).unwrap());
    let opened = zip.preview(source.clone(), 0, 1024, zip.password().as_deref().map(Vec::as_slice)).unwrap();
    assert!(String::from_utf8(opened).unwrap().contains("AE-2"));
    zip.close();
    assert!(zip.password().is_none());
}

#[test]
fn refuses_more_entries_or_a_larger_directory_than_the_caps_before_reading_it() {
    /* A source that remembers what was read. */
    struct Counting(Vec<u8>, Mutex<Vec<(u64, u64)>>);
    impl RangeRead for Counting {
        fn size(&self) -> u64 {
            self.0.len() as u64
        }
        fn read_at(&self, offset: u64, length: u64) -> Result<Vec<u8>> {
            self.1.lock().unwrap().push((offset, length));
            self.0.read_at(offset, length)
        }
    }
    for name in ["entries-100001.zip", "directory-65m.zip"] {
        let source = Counting(large(name), Mutex::new(Vec::new()));
        assert!(Zip::open(&source).is_err());
        assert!(source.1.lock().unwrap().iter().all(|&(_, length)| length <= EOCD_LENGTH + MAX16), "{name}");
    }
}

#[test]
fn names_follow_the_flag_the_unicode_field_strict_utf8_then_cp437() {
    let cp437 = [0x63, 0x61, 0x66, 0x82, 0x9b, 0xff];
    assert_eq!(decode_name("día".as_bytes(), 0x800, &HashMap::new()), "día");
    assert_eq!(decode_name(&cp437, 0x800, &HashMap::new()), "caf\u{fffd}\u{fffd}\u{fffd}");
    assert_eq!(decode_name(&cp437, 0, &HashMap::new()), "café¢\u{a0}");
    assert_eq!(decode_name("naïve.txt".as_bytes(), 0, &HashMap::new()), "naïve.txt");
    assert_eq!(decode_name(&[0x61, 0xc3], 0, &HashMap::new()), "a├");
    let mut field = vec![1u8];
    field.extend_from_slice(&crc32fast::hash(&cp437).to_le_bytes());
    field.extend_from_slice("Ünïcødé.txt".as_bytes());
    let fields = HashMap::from([(0x7075u16, &field[..])]);
    assert_eq!(decode_name(&cp437, 0, &fields), "Ünïcødé.txt");
    field[1] ^= 1;
    let stale = HashMap::from([(0x7075u16, &field[..])]);
    assert_eq!(decode_name(&cp437, 0, &stale), "café¢\u{a0}");
}

#[test]
fn the_counter_stops_at_the_byte_past_the_size_and_at_the_ratio_after_a_mib() {
    let mut counter = InflateCounter::new(10, false);
    assert!(counter.wrote(10).is_ok());
    assert_eq!(counter.wrote(1), Err(Refusal::Size));
    // Under a MiB, any ratio passes; past it, 200:1 of what was read.
    let mut counter = InflateCounter::new(u64::MAX, true);
    counter.read(1);
    assert!(counter.wrote(MIB).is_ok());
    assert_eq!(counter.wrote(1), Err(Refusal::Ratio));
    let mut counter = InflateCounter::new(u64::MAX, true);
    counter.read(MIB / 50);
    assert!(counter.wrote(2 * MIB).is_ok());
    assert_eq!(counter.wrote(3 * MIB), Err(Refusal::Ratio));
    assert!(InflateCounter::new(5, false).finish().is_err());
}

#[test]
fn the_session_reads_through_the_version_reader_and_wipes_the_password_on_close() {
    /* The archive exactly as an upload stores it, served chunk by chunk. */
    struct Sealed(Vec<u8>);
    impl ObjectSource for Sealed {
        fn fetch(&self, range: crate::ByteRange, _drain: bool) -> std::result::Result<Vec<u8>, FetchError> {
            Ok(self.0[range.start as usize..=range.end as usize].to_vec())
        }
        fn drain_later(&self, _ranges: Vec<crate::ByteRange>) {}
    }
    let plain = std::fs::read(fixture_dir().join("aes.zip")).unwrap();
    let content = Content {
        workspace_id: "11111111-1111-4111-8111-111111111111".into(),
        object_id: "66666666-6666-4666-8666-666666666666".into(),
        suite: 3,
        key: vec![7u8; 32].into(),
        nonce: vec![9u8; 16],
        plaintext_size: plain.len() as u64,
        thumbnail_bytes: 0,
    };
    let layout = crate::content_layout(3, plain.len() as u64, 0).unwrap();
    let mut object = Vec::new();
    for index in 0..layout.chunk_count {
        let start = (index * layout.chunk_bytes).min(plain.len() as u64) as usize;
        let length = crate::chunk_length(content.plaintext_size, index) as usize;
        object.extend(
            crate::chunk_encrypt(content.clone(), index, plain[start..start + length].to_vec()).unwrap(),
        );
    }
    let source: Arc<dyn ObjectSource> = Arc::new(Sealed(object));
    let control = RunControl::new(30_000, None);
    let session = ZipArchiveSession::open(source.clone(), content, control.clone()).unwrap();
    assert_eq!(session.entries().len(), 3);
    assert_eq!(session.entries()[0].lock, "aes");
    assert!(!session.unlock("not it".into(), RunControl::new(30_000, None)).unwrap());
    assert_eq!(
        session.preview(0, 1024, RunControl::new(30_000, None)),
        Err(ArchiveError::Refused { code: "password".into() })
    );
    assert!(session.unlock(PASSWORD.into(), RunControl::new(30_000, None)).unwrap());
    let text = session.preview(0, 1024, RunControl::new(30_000, None)).unwrap();
    assert!(String::from_utf8(text).unwrap().contains(CANARY));
    // A cancelled read stops with the cancel, not a refusal.
    let cancelled = RunControl::new(30_000, None);
    cancelled.cancel();
    assert!(matches!(session.preview(0, 1024, cancelled), Err(ArchiveError::Failed { .. })));
    session.close_archive();
    assert!(!session.unlocked());
    assert_eq!(
        session.preview(0, 1024, RunControl::new(30_000, None)),
        Err(ArchiveError::Refused { code: "password".into() })
    );
}

#[test]
fn phones_preview_entries_up_to_the_section_3_limits_halved_on_small_devices() {
    let big = 8 * 1024 * MIB;
    let small = 3 * 1024 * MIB;
    assert_eq!(
        zip_entry_preview_limits("image".into(), big),
        PreviewLimits { threshold: Some(100 * MIB / 3), ceiling: 100 * MIB }
    );
    assert_eq!(zip_entry_preview_limits("image".into(), small).ceiling, 50 * MIB);
    assert_eq!(zip_entry_preview_limits("pdf".into(), big).ceiling, 64 * MIB);
    assert_eq!(
        zip_entry_preview_limits("text".into(), small),
        PreviewLimits { threshold: None, ceiling: 8 * MIB }
    );
    // 4 GB exactly counts as small.
    assert_eq!(zip_entry_preview_limits("media".into(), 4 * 1024 * MIB).ceiling, 32 * MIB);
}
