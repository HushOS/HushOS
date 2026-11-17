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
        // As Python's zipfile writes it: the end record's counts 0xffff, no ZIP64 records.
        "entries-65535.zip" => {
            write_zip(&(0..65_535).map(|i| stored(&i.to_string())).collect::<Vec<_>>(), false)
        }
        "directory-65m.zip" => write_zip(
            &(0..1_100)
                .map(|i| Spec { comment: vec![b' '; 62_000], ..stored(&format!("c/{i:04}")) })
                .collect::<Vec<_>>(),
            false,
        ),
        "compressible.zip" => {
            // make.ts's compressibleFixture: 20,480 lines of 1,024 bytes, 20 MiB that deflate about 186:1.
            let mut text = String::with_capacity(20 * 1024 * 1024);
            for i in 0..20 * 1024 {
                let mut line = format!("line {}: {}", i % 97, "the quick brown fox ".repeat(48));
                while line.len() < 1023 {
                    line.push('.');
                }
                text.push_str(&line);
                text.push('\n');
            }
            write_zip(&[deflated_text("compressible.txt", &text)], false)
        }
        "front-loaded.zip" => {
            // make.ts's frontLoadedFixture: 12 MiB of zeros, then 1 MiB of noise (about 12:1 in all).
            let mut data = vec![0u8; 13 * MIB as usize];
            let mut x: u32 = 4242;
            for byte in &mut data[12 * MIB as usize..] {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                *byte = x as u8;
            }
            let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
            encoder.write_all(&data).unwrap();
            let packed = encoder.finish().unwrap();
            write_zip(
                &[Spec {
                    name: "front-loaded.bin".into(),
                    method: 8,
                    packed,
                    size: data.len() as u64,
                    crc: crc32fast::hash(&data),
                    zip64: false,
                    comment: vec![],
                }],
                false,
            )
        }
        "folders-2m.zip" => {
            // make.ts's folders2MFixture: 50,000 entries of 42 parts, a folder of their own each.
            write_zip(
                &(0..50_000)
                    .map(|i| Spec {
                        packed: b"x".to_vec(),
                        size: 1,
                        crc: crc32fast::hash(b"x"),
                        ..stored(&format!("{i:x}/{}f", "a/".repeat(40)))
                    })
                    .collect::<Vec<_>>(),
                false,
            )
        }
        "wide.zip" => {
            // make.ts's wideFixture: 1,000 entries of 256 parts.
            let folders: Vec<String> = (0..255).map(|d| format!("p{d}")).collect();
            let folders = folders.join("/");
            write_zip(
                &(0..1_000)
                    .map(|i| Spec {
                        packed: b"x".to_vec(),
                        size: 1,
                        crc: crc32fast::hash(b"x"),
                        ..stored(&format!("{folders}/f{i}"))
                    })
                    .collect::<Vec<_>>(),
                false,
            )
        }
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
    std::io::Read::read_to_end(&mut flate2::read::DeflateDecoder::new(&packed[..]), &mut inflated).unwrap();
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
    // The compressible entry sits under 200:1, as the web's does.
    let text = large("compressible.zip");
    let ratio = u32_at(&text, 22) as f64 / u32_at(&text, 18) as f64;
    assert!(ratio > 150.0 && ratio < 200.0, "{ratio}");
}

#[test]
fn every_fixture_as_expected_json_says() {
    let table = table();
    let fixtures = table["fixtures"].as_object().unwrap();
    for (name, expected) in fixtures {
        let generated = expected["generated"].as_bool().unwrap_or(false);
        let source = bytes_of(name, generated);
        let source = source.as_ref();
        let listing = Zip::open(source).map(|_| ());
        // The phones list at most 50,000 entries (the web 100,000): `listingCore` says where that differs.
        let wanted = expected["listingCore"].as_str().or(expected["listing"].as_str()).unwrap();
        assert_eq!(outcome(listing.clone()), wanted, "{name}: listing");
        if listing.is_err() {
            continue;
        }
        let zip = Zip::open(source).unwrap();
        let list = zip.listing().unwrap();
        let folders = folders_of(&zip.take_folders());
        // Every entry sits where its path puts it, or flat at the top, through one folder per name.
        assert_listed_where_its_path_says(&list, &folders, name);
        if let Some(count) = expected["count"].as_u64() {
            assert_eq!(list.listed.len() as u64, count, "{name}: count");
            assert!(
                list.listed.iter().all(|item| parts_of(&folders, item).len() == LIST_DEPTH_MAX),
                "{name}: none flat"
            );
            continue;
        }
        if let Some(count) = expected["entryCount"].as_u64() {
            assert_eq!(list.listed.len() as u64, count, "{name}: how many entries");
            continue;
        }
        let wanted = expected["entries"].as_array().unwrap();
        // The decoded names are the list's (an entry keeps only its raw name once listed).
        let path_of = |index: u32| {
            list.listed.iter().find(|item| item.index == index).map_or("", |item| item.path.as_str())
        };
        let paths: Vec<&str> = list.entries.iter().map(|entry| path_of(entry.index)).collect();
        let want_paths: Vec<&str> = wanted.iter().map(|entry| entry["path"].as_str().unwrap()).collect();
        assert_eq!(paths, want_paths, "{name}: paths");
        assert_eq!(zip.hidden() as u64, expected["hidden"].as_u64().unwrap(), "{name}: hidden");
        for (index, want) in wanted.iter().enumerate() {
            let entry = &list.entries[index];
            let listed = list.listed.iter().find(|item| item.index == index as u32).unwrap();
            let label = format!("{name}: {}", path_of(entry.index).chars().take(40).collect::<String>());
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
                outcome(zip.check(source, index, password)),
                want["check"].as_str().unwrap(),
                "{label}: check"
            );
            // Hashed only where the table pins the bytes: SHA-256 unoptimised over 5 GiB takes minutes.
            let pinned = want["downloadSha256"].as_str();
            let mut hash = sha2::Sha256::default();
            assert_eq!(
                outcome(zip.download(source, index, password, &mut |chunk| {
                    if pinned.is_some() {
                        sha2::Digest::update(&mut hash, chunk);
                    }
                    Ok(())
                })),
                want["download"].as_str().unwrap(),
                "{label}: download"
            );
            if let Some(digest) = pinned {
                let got: String =
                    sha2::Digest::finalize(hash).iter().map(|byte| format!("{byte:02x}")).collect();
                assert_eq!(got, digest, "{label}: the bytes downloaded");
            }
            if let Some(code) = want["withoutPassword"].as_str() {
                assert_eq!(outcome(zip.check(source, index, None)), code, "{label}: without a password");
            }
            if let Some(code) = want["wrongPassword"].as_str() {
                assert_eq!(
                    outcome(zip.check(source, index, Some(b"not it"))),
                    code,
                    "{label}: a wrong password"
                );
            }
        }
        if let Some(parts) = expected["parts"].as_object() {
            for (path, want) in parts {
                let got = &parts_of(&folders, list.listed.iter().find(|item| &item.path == path).unwrap());
                let want: Vec<String> =
                    want.as_array().unwrap().iter().map(|part| part.as_str().unwrap().to_owned()).collect();
                assert_eq!(got, &want, "{name}: parts of {path}");
            }
        }
        if let Some(lengths) = expected["partsLength"].as_object() {
            for (path, want) in lengths {
                let got =
                    parts_of(&folders, list.listed.iter().find(|item| &item.path == path).unwrap()).len();
                assert_eq!(got as u64, want.as_u64().unwrap(), "{name}: parts of a path {} long", path.len());
            }
        }
        if let Some(names) = expected["saveNames"].as_object() {
            for (path, want) in names {
                let got = &list.listed.iter().find(|item| &item.path == path).unwrap().save_name;
                assert_eq!(got, want.as_str().unwrap(), "{name}: the name {path:?} is saved as");
            }
        }
        if let Some(unlock) = expected.get("unlock") {
            let right = Zip::open(source).unwrap().unlock(source, PASSWORD.as_bytes(), None).unwrap();
            let wrong = Zip::open(source).unwrap().unlock(source, b"not it", None).unwrap();
            assert_eq!(right, unlock["right"].as_bool().unwrap(), "{name}: unlock with the password");
            assert_eq!(wrong, unlock["wrong"].as_bool().unwrap(), "{name}: unlock with another");
        }
        if let Some(unproven) = expected.get("unproven") {
            let password = unproven["password"].as_str().unwrap().as_bytes();
            let index = list
                .listed
                .iter()
                .find(|item| item.path == unproven["entry"].as_str().unwrap())
                .unwrap()
                .index;
            let zip = Zip::open(source).unwrap();
            // Only its check byte passed: held, then let go of by the damage a sibling's download reads,
            // on the archive as well, as the session does after every read.
            assert!(
                zip.unlock(source, password, None).unwrap(),
                "{name}: the wrong password passes its check byte"
            );
            let sibling = zip.sibling().unwrap();
            let read = sibling.download(source, index, Some(password), &mut |_| Ok(()));
            assert_eq!(outcome(sibling.unproven(index, Some(password), read)), "password-unproven", "{name}");
            assert!(zip.password().is_none(), "{name}: let go of on the archive too");
            assert_eq!(outcome(zip.download(source, index, None, &mut |_| Ok(()))), "password", "{name}");
        }
        if let Some(entry) = expected["damagedTwice"].as_str() {
            let index = list.listed.iter().find(|item| item.path == entry).unwrap().index;
            let damage =
                expected["entries"].as_array().unwrap().iter().find(|item| item["path"] == entry).unwrap()
                    ["download"]
                    .as_str()
                    .unwrap()
                    .to_string();
            let zip = Zip::open(source).unwrap();
            let password = PASSWORD.as_bytes();
            let read = |zip: &Zip| {
                let result = zip.download(source, index, Some(password), &mut |_| Ok(()));
                outcome(zip.unproven(index, Some(password), result))
            };
            assert!(zip.unlock(source, password, Some(index)).unwrap(), "{name}: unlock");
            assert_eq!(read(&zip), "password-unproven", "{name}: the first damage lets it go");
            // Typed again, the same password is kept and the damage said, not asked for again.
            assert!(zip.unlock(source, password, Some(index)).unwrap(), "{name}: unlock again");
            assert_eq!(read(&zip), damage, "{name}: the second damage is said");
            assert!(zip.password().is_some(), "{name}: and the password kept");
        }
        if let Some(skips) = expected["unlockSkips"].as_str() {
            let counted = Counting(source, Mutex::new(Vec::new()));
            let zip = Zip::open(&counted).unwrap();
            counted.1.lock().unwrap().clear();
            assert!(zip.unlock(&counted, PASSWORD.as_bytes(), None).unwrap(), "{name}: unlock");
            let read: u64 = counted.1.lock().unwrap().iter().map(|&(_, length)| length).sum();
            let packed = list.entries.iter().find(|entry| path_of(entry.index) == skips).unwrap().packed;
            assert!(read < packed, "{name}: the unlock read {read} bytes of {skips}'s {packed}");
        }
        if let Some(with) = expected.get("unlockWith") {
            let password = with["password"].as_str().unwrap().as_bytes();
            let anywhere = Zip::open(source).unwrap().unlock(source, password, None).unwrap();
            assert_eq!(
                anywhere,
                with["anywhere"].as_bool().unwrap(),
                "{name}: another password, aimed at none"
            );
            for (path, right) in with["at"].as_object().unwrap() {
                let index = list.listed.iter().find(|item| &item.path == path).unwrap().index;
                let got = Zip::open(source).unwrap().unlock(source, password, Some(index)).unwrap();
                assert_eq!(got, right.as_bool().unwrap(), "{name}: another password, aimed at {path}");
            }
        }
    }
}

#[test]
fn a_preview_is_held_to_its_limit_and_a_password_is_kept_only_once_it_opens() {
    let source = bytes_of("basic.zip", false);
    let source = source.as_ref();
    let zip = Zip::open(source).unwrap();
    let readme =
        zip.listing().unwrap().listed.iter().find(|item| item.path == "docs/readme.txt").unwrap().index;
    let text = zip.preview(source, readme, 1024, None).unwrap();
    assert!(String::from_utf8(text).unwrap().contains("Read me. This entry is deflated."));
    assert_eq!(outcome(zip.preview(source, readme, 10, None).map(|_| ())), "too-large");

    let source = bytes_of("aes.zip", false);
    let source = source.as_ref();
    let zip = Zip::open(source).unwrap();
    assert!(!zip.unlock(source, b"not it", None).unwrap());
    assert!(zip.password().is_none());
    assert!(zip.unlock(source, PASSWORD.as_bytes(), None).unwrap());
    let opened = zip.preview(source, 0, 1024, zip.password().as_deref().map(Vec::as_slice)).unwrap();
    assert!(String::from_utf8(opened).unwrap().contains("AE-2"));
    zip.close();
    assert!(zip.password().is_none());
    // Closed, nothing reads any more, an entry it opened or not, and no password comes back.
    assert!(matches!(
        zip.preview(source, 0, 1024, Some(PASSWORD.as_bytes())),
        Err(ArchiveError::Failed { .. })
    ));
    assert!(matches!(zip.preview(source, 2, 1024, None), Err(ArchiveError::Failed { .. })));
    assert!(matches!(zip.unlock(source, PASSWORD.as_bytes(), None), Err(ArchiveError::Failed { .. })));
    assert!(zip.password().is_none());
}

#[test]
fn an_unlock_racing_a_close_never_brings_the_password_back() {
    /* A source whose reads wait until the test lets them go, so the close lands mid-unlock. */
    struct Gate {
        bytes: Vec<u8>,
        go: std::sync::Barrier,
        waited: std::sync::atomic::AtomicBool,
    }
    impl RangeRead for Gate {
        fn size(&self) -> u64 {
            self.bytes.len() as u64
        }
        fn read_at(&self, offset: u64, length: u64) -> Result<Vec<u8>> {
            // The first read of entry data waits for the close.
            if offset < 64 && !self.waited.swap(true, std::sync::atomic::Ordering::SeqCst) {
                self.go.wait();
                self.go.wait();
            }
            self.bytes.read_at(offset, length)
        }
    }
    let bytes = std::fs::read(fixture_dir().join("zipcrypto.zip")).unwrap();
    let opened = Zip::open(&bytes).unwrap();
    let gate = Arc::new(Gate { bytes, go: std::sync::Barrier::new(2), waited: Default::default() });
    let zip = Arc::new(opened);
    let (zip2, gate2) = (zip.clone(), gate.clone());
    let unlock = std::thread::spawn(move || zip2.unlock(gate2.as_ref(), PASSWORD.as_bytes(), None));
    gate.go.wait();
    zip.close();
    gate.go.wait();
    let result = unlock.join().unwrap();
    assert!(matches!(result, Err(ArchiveError::Failed { .. }) | Ok(false)), "{result:?}");
    assert!(zip.password().is_none());
}

#[test]
fn opening_checks_the_whole_span_and_the_local_header_s_sizes_and_crc() {
    // Stage two: the local extra field pushes the data past the next entry's header.
    let bytes = std::fs::read(fixture_dir().join("local-overrun.zip")).unwrap();
    let zip = Zip::open(&bytes).unwrap();
    assert_eq!(outcome(zip.check(&bytes, 0, None)), "overlap");
    assert_eq!(outcome(zip.check(&bytes, 1, None)), "ok");
    // The same archive with the local header's size, then its CRC, made to differ from the directory's.
    let bytes = std::fs::read(fixture_dir().join("basic.zip")).unwrap();
    let zip = Zip::open(&bytes).unwrap();
    let listing = zip.listing().unwrap();
    let index = listing.listed.iter().find(|item| item.path == "docs/readme.txt").unwrap().index;
    let readme = listing.entries[index as usize].clone();
    let at = readme.offset as usize;
    for field in [22usize, 14] {
        let mut changed = bytes.clone();
        changed[at + field] ^= 1;
        let zip = Zip::open(&changed).unwrap();
        assert_eq!(outcome(zip.check(&changed, readme.index, None)), "local", "field at {field}");
    }
}

impl RangeRead for &dyn RangeRead {
    fn size(&self) -> u64 {
        (**self).size()
    }
    fn read_at(&self, offset: u64, length: u64) -> Result<Vec<u8>> {
        (**self).read_at(offset, length)
    }
}

/* A source that remembers what was read. */
struct Counting<S: RangeRead>(S, Mutex<Vec<(u64, u64)>>);
impl<S: RangeRead> RangeRead for Counting<S> {
    fn size(&self) -> u64 {
        self.0.size()
    }
    fn read_at(&self, offset: u64, length: u64) -> Result<Vec<u8>> {
        self.1.lock().unwrap().push((offset, length));
        self.0.read_at(offset, length)
    }
}

#[test]
fn refuses_more_entries_or_a_larger_directory_than_the_caps_before_reading_it() {
    for name in ["entries-100001.zip", "directory-65m.zip"] {
        let source = Counting(large(name), Mutex::new(Vec::new()));
        assert!(Zip::open(&source).is_err());
        assert!(source.1.lock().unwrap().iter().all(|&(_, length)| length <= EOCD_LENGTH + MAX16), "{name}");
    }
}

#[test]
fn a_deep_path_costs_its_parts_not_their_prefixes() {
    // 32,768 parts in one name: listed flat, under its whole path, and fast.
    let bytes = std::fs::read(fixture_dir().join("deep.zip")).unwrap();
    let started = std::time::Instant::now();
    let zip = Zip::open(&bytes).unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    let list = zip.listing().unwrap();
    let folders = folders_of(&zip.take_folders());
    assert_eq!(parts_of(&folders, &list.listed[0]), vec![list.listed[0].path.clone()]);
    assert_eq!(parts_of(&folders, &list.listed[1]).len(), LIST_DEPTH_MAX);
}

/* Each folder's parent and name (folder 0, the top, has none). */
fn folders_of(folders: &ArchiveFolders) -> Vec<(u32, String)> {
    let parents: Vec<u32> =
        folders.parents.chunks(4).map(|b| u32::from_le_bytes(b.try_into().unwrap())).collect();
    let names: Vec<&str> = folders.names.split_terminator('/').collect();
    assert_eq!(names.len() + 1, parents.len(), "a name for every folder");
    assert!(folders.names.is_empty() || folders.names.ends_with('/'));
    std::iter::once((0, String::new()))
        .chain(parents[1..].iter().zip(names).map(|(&p, n)| (p, n.to_owned())))
        .collect()
}

/* An entry's folders and name, from the top, as the list shows them. */
fn parts_of(folders: &[(u32, String)], item: &ArchiveEntry) -> Vec<String> {
    let mut parts = vec![item.name.clone()];
    let mut at = item.folder;
    while at != 0 {
        parts.push(folders[at as usize].1.clone());
        at = folders[at as usize].0;
    }
    parts.reverse();
    parts
}

fn assert_listed_where_its_path_says(list: &Listing, folders: &[(u32, String)], name: &str) {
    let mut seen = std::collections::HashSet::new();
    for (k, (parent, folder)) in folders.iter().enumerate().skip(1) {
        assert!((*parent as usize) < k, "{name}: folder {k} comes after its parent");
        assert!(
            !folder.is_empty() && !folder.contains(['/', '\\']) && folder != ".",
            "{name}: folder {k} named {folder:?}"
        );
        assert!(seen.insert((*parent, folder.clone())), "{name}: two folders named {folder:?} in one");
    }
    for item in &list.listed {
        if item.hidden && path_parts(&item.path).first().map(String::as_str) == Some("__MACOSX") {
            assert_eq!(item.folder, 0, "{name}: {} in no folder", item.path);
            continue;
        }
        let parts = path_parts(&item.path);
        let want = if parts.is_empty() || parts.len() > LIST_DEPTH_MAX {
            vec![if item.path.is_empty() { "_".to_owned() } else { item.path.clone() }]
        } else {
            parts
        };
        assert_eq!(parts_of(folders, item), want, "{name}: where {} is listed", item.path);
    }
}

#[test]
fn save_names_are_safe_on_every_system() {
    assert_eq!(save_name("rtl\u{202e}txt.exe"), "rtl_txt.exe");
    assert_eq!(save_name("nul\u{0}name.txt"), "nul_name.txt");
    assert_eq!(save_name("CON"), "_CON");
    assert_eq!(save_name("lpt1.log"), "_lpt1.log");
    assert_eq!(save_name("lpt10.log"), "lpt10.log");
    assert_eq!(save_name(" .hidden. "), "hidden");
    assert_eq!(save_name("..."), "Untitled");
    assert_eq!(save_name("e\u{301}.txt"), "\u{e9}.txt");
    let long = format!("{}.txt", "é".repeat(200));
    let saved = save_name(&long);
    assert!(saved.len() <= 255 && saved.ends_with(".txt"), "{saved}");
}

#[test]
fn names_follow_the_flag_the_unicode_field_strict_utf8_then_cp437() {
    let cp437 = [0x63, 0x61, 0x66, 0x82, 0x9b, 0xff];
    assert_eq!(decode_name("día".as_bytes(), 0x800, &HashMap::new()), "día");
    assert_eq!(decode_name(&cp437, 0x800, &HashMap::new()), "caf\u{fffd}\u{fffd}\u{fffd}");
    assert_eq!(decode_name(&cp437, 0, &HashMap::new()), "café¢\u{a0}");
    assert_eq!(decode_name("naïve.txt".as_bytes(), 0, &HashMap::new()), "naïve.txt");
    assert_eq!(decode_name(&[0x61, 0xc3], 0, &HashMap::new()), "a├");
    // A byte order mark stays part of the name, as on the web.
    assert_eq!(decode_name("\u{feff}a".as_bytes(), 0x800, &HashMap::new()), "\u{feff}a");
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
    // Reached by position: reading the same range again counts once.
    let mut counter = InflateCounter::new(u64::MAX, true);
    counter.reached(MIB / 50);
    counter.reached(MIB / 100);
    assert_eq!(counter.consumed, MIB / 50);
    assert_eq!(InflateCounter::new(5, false).finish(), Err(Refusal::Short));
}

/* The archive exactly as an upload stores it, served chunk by chunk, counting what was fetched. */
struct Sealed(Vec<u8>, std::sync::atomic::AtomicU64);
impl ObjectSource for Sealed {
    fn fetch(&self, range: crate::ByteRange, _drain: bool) -> std::result::Result<Vec<u8>, FetchError> {
        self.1.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(self.0[range.start as usize..=range.end as usize].to_vec())
    }
    fn drain_later(&self, _ranges: Vec<crate::ByteRange>) {}
}

fn sealed(name: &str) -> (Arc<Sealed>, Content) {
    let plain = std::fs::read(fixture_dir().join(name)).unwrap();
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
    (Arc::new(Sealed(object, Default::default())), content)
}

#[test]
fn the_session_reads_through_one_reader_and_closing_ends_it() {
    let (store, content) = sealed("aes.zip");
    let source: Arc<dyn ObjectSource> = store.clone();
    let control = RunControl::new(30_000, None);
    let session = ZipArchiveSession::open(source, content, control.clone()).unwrap();
    control.finish();
    let fetched = store.1.load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(session.entries().len(), 3);
    assert_eq!(session.entries()[0].lock, "aes");
    assert!(!session.unlock("not it".into(), None, RunControl::new(30_000, None)).unwrap());
    assert_eq!(
        session.preview(0, 1024, RunControl::new(30_000, None)),
        Err(ArchiveError::Refused { code: "password".into() })
    );
    assert!(session.unlock(PASSWORD.into(), Some(1), RunControl::new(30_000, None)).unwrap());
    let call = RunControl::new(30_000, None);
    let text = session.preview(0, 1024, call.clone()).unwrap();
    // A call's run finishing leaves the session's reader as it was: the next call fetches nothing.
    call.finish();
    assert!(String::from_utf8(text).unwrap().contains(CANARY));
    assert!(session.preview(1, 1024, RunControl::new(30_000, None)).is_ok());
    assert_eq!(store.1.load(std::sync::atomic::Ordering::SeqCst), fetched, "one chunk, fetched once");
    // A cancelled call stops with the cancel, not a refusal, and the session goes on.
    let cancelled = RunControl::new(30_000, None);
    cancelled.cancel();
    assert!(matches!(session.preview(0, 1024, cancelled), Err(ArchiveError::Failed { .. })));
    assert!(session.preview(0, 1024, RunControl::new(30_000, None)).is_ok());
    session.close_archive();
    assert!(!session.unlocked());
    assert!(session.entries().is_empty());
    for result in [
        session.preview(0, 1024, RunControl::new(30_000, None)).map(|_| ()),
        session.unlock(PASSWORD.into(), None, RunControl::new(30_000, None)).map(|_| ()),
    ] {
        assert_eq!(result, Err(ArchiveError::Failed { reason: CLOSED.into() }));
    }
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

#[test]
fn a_kept_copy_opens_from_the_phone_and_closes_like_any_archive() {
    struct Kept(Vec<u8>);
    impl LocalSource for Kept {
        fn size(&self) -> u64 {
            self.0.len() as u64
        }
        fn read_at(&self, offset: u64, length: u64) -> std::result::Result<Vec<u8>, FetchError> {
            Ok(self.0[offset as usize..(offset + length) as usize].to_vec())
        }
    }
    let kept = Arc::new(Kept(std::fs::read(fixture_dir().join("aes.zip")).unwrap()));
    let session = ZipArchiveSession::open_local(kept, RunControl::new(30_000, None)).unwrap();
    assert!(session.unlock(PASSWORD.into(), None, RunControl::new(30_000, None)).unwrap());
    let text = session.preview(0, 1024, RunControl::new(30_000, None)).unwrap();
    assert!(String::from_utf8(text).unwrap().contains(CANARY));
    // A cancelled call reads nothing.
    let cancelled = RunControl::new(30_000, None);
    cancelled.cancel();
    assert!(session.preview(1, 1024, cancelled).is_err());
    session.close_archive();
    assert!(session.preview(2, 1024, RunControl::new(30_000, None)).is_err());
}

#[test]
fn a_sibling_reads_beside_the_archive_with_its_password_and_closes_on_its_own() {
    struct Kept(Vec<u8>);
    impl LocalSource for Kept {
        fn size(&self) -> u64 {
            self.0.len() as u64
        }
        fn read_at(&self, offset: u64, length: u64) -> std::result::Result<Vec<u8>, FetchError> {
            Ok(self.0[offset as usize..(offset + length) as usize].to_vec())
        }
    }
    let kept = Arc::new(Kept(std::fs::read(fixture_dir().join("aes.zip")).unwrap()));
    let session = ZipArchiveSession::open_local(kept, RunControl::new(30_000, None)).unwrap();
    assert!(session.unlock(PASSWORD.into(), None, RunControl::new(30_000, None)).unwrap());
    let sibling = session.sibling().unwrap();
    // The password came along: the sibling opens the locked entry without asking.
    assert!(String::from_utf8(sibling.preview(0, 1024, RunControl::new(30_000, None)).unwrap())
        .unwrap()
        .contains(CANARY));
    sibling.close_archive();
    assert!(sibling.preview(0, 1024, RunControl::new(30_000, None)).is_err());
    assert!(session.preview(0, 1024, RunControl::new(30_000, None)).is_ok());
    session.close_archive();
    assert!(session.sibling().is_err());
}

#[test]
fn hmac_sha1_and_pbkdf2_meet_their_published_vectors() {
    // RFC 2202, test cases 1 and 2; RFC 6070, PBKDF2-HMAC-SHA1.
    let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let mut mac = HmacSha1::new(&[0x0b; 20]);
    mac.update(b"Hi There");
    assert_eq!(hex(&mac.finalize()[..]), "b617318655057264e28bc0b6fb378c8ef146be00");
    let mut mac = HmacSha1::new(b"Jefe");
    mac.update(b"what do ya want for nothing?");
    assert_eq!(hex(&mac.finalize()[..]), "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
    // A key longer than a block is hashed first (RFC 2202, test case 6).
    let mut mac = HmacSha1::new(&[0xaa; 80]);
    mac.update(b"Test Using Larger Than Block-Size Key - Hash Key First");
    assert_eq!(hex(&mac.finalize()[..]), "aa4ae5e15272d00e95705637ce8a3b55ed402112");
    assert_eq!(
        hex(&pbkdf2_sha1_rounds(b"password", b"salt", 1, 20)),
        "0c60c80f961f0e71f3a9b524af6012062fe037a6"
    );
    assert_eq!(
        hex(&pbkdf2_sha1_rounds(b"password", b"salt", 4096, 20)),
        "4b007901b765489abead49d926f721d065a429c1"
    );
    assert_eq!(
        hex(&pbkdf2_sha1_rounds(
            b"passwordPASSWORDpassword",
            b"saltSALTsaltSALTsaltSALTsaltSALTsalt",
            4096,
            25
        )),
        "3d2eec4fe41c849b80c8d83662c0e44a8b291a964cf2f07038"
    );
}

#[test]
fn a_try_of_a_password_goes_no_further_than_three_entries() {
    // aes-tampered.zip: the two smallest are tampered (a bad code says nothing certain of the
    // password: the next is tried), and ok.txt, the third, opens.
    let source = bytes_of("aes-tampered.zip", false);
    let zip = Zip::open(source.as_ref()).unwrap();
    assert!(zip.unlock(source.as_ref(), PASSWORD.as_bytes(), None).unwrap());
    // Asked first for ae1-bad-crc (a bad CRC, the 4th entry), the try then has two left: the two
    // tampered ones, and gives up before ok.txt.
    let zip = Zip::open(source.as_ref()).unwrap();
    assert!(!zip.unlock(source.as_ref(), PASSWORD.as_bytes(), Some(3)).unwrap());
}

#[test]
fn a_zip_entry_is_held_to_its_declared_ratio_not_a_running_one() {
    assert!(declares_too_much(MIB + 1, (MIB + 1) / 201));
    assert!(!declares_too_much(MIB, 1));
    assert!(!declares_too_much(200 * MIB, MIB));
    assert!(declares_too_much(200 * MIB + 1, MIB));
}

/* unproven.zip under the right password, which only its check byte proves: a stopped download is no damage. */
#[test]
fn a_cancelled_download_keeps_a_password_only_its_check_byte_proved() {
    struct Cancelling(Arc<RunControl>);
    impl EntrySink for Cancelling {
        fn write(&self, _: Vec<u8>) -> std::result::Result<(), FetchError> {
            self.0.cancel();
            Ok(())
        }
    }
    #[derive(Default)]
    struct Counted(Mutex<u64>);
    impl EntrySink for Counted {
        fn write(&self, chunk: Vec<u8>) -> std::result::Result<(), FetchError> {
            *self.0.lock().unwrap() += chunk.len() as u64;
            Ok(())
        }
    }
    let (store, content) = sealed("unproven.zip");
    let session = ZipArchiveSession::open(store, content, RunControl::new(30_000, None)).unwrap();
    assert!(session.unlock(PASSWORD.into(), Some(0), RunControl::new(30_000, None)).unwrap());
    let size = session.entries()[0].size;
    for session in [session.clone(), session.sibling().unwrap()] {
        let call = RunControl::new(30_000, None);
        let stopped = session.download(0, Arc::new(Cancelling(call.clone())), call);
        assert!(
            matches!(stopped, Err(ArchiveError::Failed { .. })),
            "a cancel is said as itself: {stopped:?}"
        );
        assert!(session.unlocked(), "and the password stays held");
        let whole = Arc::new(Counted::default());
        session.download(0, whole.clone(), RunControl::new(30_000, None)).unwrap();
        assert_eq!(*whole.0.lock().unwrap(), size);
    }
}

/* A password accepted again by an entry that can only check it stays proven: the damage there is said. */
#[test]
fn a_re_accepted_password_stays_as_proven_as_it_was() {
    let source = bytes_of("zipcrypto-empty.zip", false);
    let source = source.as_ref();
    let zip = Zip::open(source).unwrap();
    let listing = zip.listing().unwrap();
    let at = |path: &str| listing.listed.iter().find(|item| item.path == path).unwrap().index;
    let (empty, secret) = (at("empty.txt"), at("secret.txt"));
    let password = PASSWORD.as_bytes();
    assert!(zip.unlock(source, password, Some(secret)).unwrap());
    assert!(zip.unlock(source, password, Some(empty)).unwrap());
    // Damage read on the empty entry: the password was proven, so it is kept.
    let damaged: Result<()> = refused(Refusal::Crc);
    assert_eq!(outcome(zip.unproven(empty, Some(password), damaged)), "crc");
    assert!(zip.password().is_some());
}

/* A sink that waits on its destination past the watchdog: held, it isn't the archive's stall. */
#[test]
fn a_download_waits_on_a_slow_sink_past_the_watchdog_and_a_cancel_still_ends_it() {
    struct Manual(std::sync::atomic::AtomicU64);
    impl crate::tools::ToolClock for Manual {
        fn now_millis(&self) -> u64 {
            self.0.load(std::sync::atomic::Ordering::SeqCst)
        }
    }
    struct Kept(Vec<u8>);
    impl LocalSource for Kept {
        fn size(&self) -> u64 {
            self.0.len() as u64
        }
        fn read_at(&self, offset: u64, length: u64) -> std::result::Result<Vec<u8>, FetchError> {
            let start = (offset as usize).min(self.0.len());
            Ok(self.0[start..(start + length as usize).min(self.0.len())].to_vec())
        }
    }
    /* Each write: the destination takes a minute (the clock moved on, the app's poll asks the watchdog), then `after`. */
    struct Slow {
        clock: Arc<Manual>,
        control: Mutex<Option<Arc<RunControl>>>,
        cancel: bool,
        writes: Mutex<u32>,
        fired: Mutex<bool>,
    }
    impl EntrySink for Slow {
        fn write(&self, _chunk: Vec<u8>) -> std::result::Result<(), FetchError> {
            *self.writes.lock().unwrap() += 1;
            let control = self.control.lock().unwrap().clone().unwrap();
            // A minute, the app asking the watchdog each second as it does.
            for _ in 0..60 {
                self.clock.0.fetch_add(1_000, std::sync::atomic::Ordering::SeqCst);
                *self.fired.lock().unwrap() |= control.check_watchdog();
            }
            if self.cancel {
                control.cancel();
            }
            Ok(())
        }
    }
    let bytes = large("compressible.zip");
    for cancel in [false, true] {
        let clock = Arc::new(Manual(std::sync::atomic::AtomicU64::new(0)));
        let open = RunControl::new(30_000, Some(clock.clone()));
        let session = ZipArchiveSession::open_local(Arc::new(Kept(bytes.clone())), open).unwrap();
        let control = RunControl::new(30_000, Some(clock.clone()));
        let sink = Arc::new(Slow {
            clock: clock.clone(),
            control: Mutex::new(Some(control.clone())),
            cancel,
            writes: Mutex::new(0),
            fired: Mutex::new(false),
        });
        let result = session.download(0, sink.clone(), control.clone());
        assert!(!*sink.fired.lock().unwrap(), "the watchdog never fires on a wait for the sink");
        if cancel {
            assert!(
                matches!(result, Err(ArchiveError::Failed { .. })),
                "a cancel during the wait ends it: {result:?}"
            );
            assert_eq!(*sink.writes.lock().unwrap(), 1, "and nothing more is written");
        } else {
            assert_eq!(result, Ok(()), "twenty slow writes, each a minute, and the download is whole");
            assert_eq!(*sink.writes.lock().unwrap(), 20);
        }
    }
}
