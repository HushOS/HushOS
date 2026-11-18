//! Browsing zip archives in the phone apps (docs/file-tools-design.md, section 1 (a) and
//! section 6): the list of what is inside, read from the central directory alone, and an entry's
//! bytes, decoded here from the entry's own listing record. The web's twin is `apps/web/src/lib/archives/zip-format.ts`
//! (the rules) with zip.js (the data); both are held to `e2e/fixtures/archives/expected.json`, so a
//! change to one is a change to both.
//!
//! The directory parser is strict on purpose. Archives come from anyone, and two readers that see
//! different files in one archive is an attack of its own, so anything ambiguous is refused rather
//! than reconciled. Nothing else parses the directory: each entry is decoded from its own listing
//! record (its offset, method, flags, CRC and sizes), with flate2 for Deflate, the `deflate64`
//! crate for Deflate64, and ZipCrypto and WinZip AES written out here, so no second reader can
//! read an entry under a different record (the web gives zip.js a one-entry archive written from
//! the same record, for the same reason).
//!
//! Every limit is enforced on the bytes as they are produced: an entry stops at the byte past its
//! declared size, a preview at 200 times the compressed bytes read once 1 MiB has come out, and the
//! CRC or the AES authentication code is checked at the end. A password the person typed is held
//! by the open archive, in memory, and wiped when it is closed or dropped.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use zeroize::{Zeroize, Zeroizing};

use crate::tools::{FetchError, ObjectSource, RunControl, VersionReader};
use crate::{Content, CoreError};

const MIB: u64 = 1024 * 1024;
/// The largest central directory read.
pub const ZIP_DIRECTORY_MAX_BYTES: u64 = 16 * MIB;
/// The most entries listed.
pub const ZIP_ENTRIES_MAX: u64 = 50_000;

/// The most entries a zip's list takes here, for the words that say so.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn zip_entries_max() -> u64 {
    ZIP_ENTRIES_MAX
}
const RATIO: u64 = 200;
const RATIO_FROM: u64 = MIB;
const ASK_ABOVE: u64 = 4 * 1024 * MIB;
/// The most an unlock inflates of an entry, by what it declares, to be sure of a password. An
/// entry past it, or past the declared ratio, is never inflated to probe: a 16 MiB stream of
/// zeros can declare gigabytes.
const UNLOCK_CHECK_BYTES: u64 = 16 * MIB;

/// Whether an unlock may inflate `entry` in full to prove a password.
fn probes(entry: &Entry) -> bool {
    entry.size <= UNLOCK_CHECK_BYTES && !declares_too_much(entry.size, entry.packed)
}
/// Whether `entry` read whole proves a password: an empty ZipCrypto entry has only its one check
/// byte (it passes 1 wrong password in 256); an empty AES entry still carries its keyed code.
fn proves(entry: &Entry) -> bool {
    entry.size > 0 || entry.lock == Lock::Aes
}
/// How far one try of a password goes: at most three entries and 32 MiB read, however many are locked.
const UNLOCK_ENTRIES_MAX: usize = 3;
const UNLOCK_READ_MAX: u64 = 32 * MIB;
/// Whether this build decodes Deflate64 (method 9): the `deflate64` crate does, as zip.js does on the web.
const DEFLATE64: bool = true;
/// How much of a download is handed to the app at a time.
const CHUNK_BYTES: usize = 1024 * 1024;

const SIG_EOCD: u32 = 0x0605_4b50;
const SIG_ZIP64_EOCD: u32 = 0x0606_4b50;
const SIG_ZIP64_LOCATOR: u32 = 0x0706_4b50;
const SIG_CENTRAL: u32 = 0x0201_4b50;
const SIG_LOCAL: u32 = 0x0403_4b50;
const SIG_DESCRIPTOR: u32 = 0x0807_4b50;
const SIG_ARCHIVE_EXTRA: u32 = 0x0806_4b50;
const EOCD_LENGTH: u64 = 22;
const LOCATOR_LENGTH: u64 = 20;
const ZIP64_EOCD_LENGTH: u64 = 56;
const CENTRAL_LENGTH: usize = 46;
const LOCAL_LENGTH: usize = 30;
const MAX16: u64 = 0xffff;
const MAX32: u64 = 0xffff_ffff;

/// Why an archive or an entry was refused. Its `code` is the web's (zip-format.ts), and the apps
/// put it into words (`ArchiveWords`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Damaged,
    DirectoryTooLarge,
    TooManyEntries,
    EncryptedDirectory,
    Split,
    Overlap,
    Local,
    Method,
    Encryption,
    Password,
    WrongPassword,
    /* The password held passed only its verifier, and a locked entry then read as damaged: let go of, asked for again. */
    PasswordUnproven,
    Crc,
    Auth,
    Size,
    Short,
    Ratio,
    Nested,
    Link,
    Directory,
    TooLarge,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Refusal::Damaged => "damaged",
            Refusal::DirectoryTooLarge => "directory-too-large",
            Refusal::TooManyEntries => "too-many-entries",
            Refusal::EncryptedDirectory => "encrypted-directory",
            Refusal::Split => "split",
            Refusal::Overlap => "overlap",
            Refusal::Local => "local",
            Refusal::Method => "method",
            Refusal::Encryption => "encryption",
            Refusal::Password => "password",
            Refusal::WrongPassword => "wrong-password",
            Refusal::PasswordUnproven => "password-unproven",
            Refusal::Crc => "crc",
            Refusal::Auth => "auth",
            Refusal::Size => "size",
            Refusal::Short => "short",
            Refusal::Ratio => "ratio",
            Refusal::Nested => "nested",
            Refusal::Link => "link",
            Refusal::Directory => "directory",
            Refusal::TooLarge => "too-large",
        }
    }
}

/// What opening an archive or reading an entry met: a refusal with its code, or a failure of the
/// read underneath (the network, a cancel, the watchdog) in the person's words.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Error))]
pub enum ArchiveError {
    #[error("{code}")]
    Refused { code: String },
    /* Not `message`, which Kotlin's Throwable already has. */
    #[error("{reason}")]
    Failed { reason: String },
}

impl From<Refusal> for ArchiveError {
    fn from(refusal: Refusal) -> Self {
        ArchiveError::Refused { code: refusal.code().into() }
    }
}

impl From<CoreError> for ArchiveError {
    fn from(error: CoreError) -> Self {
        ArchiveError::Failed { reason: error.to_string() }
    }
}

type Result<T> = std::result::Result<T, ArchiveError>;

fn refused<T>(refusal: Refusal) -> Result<T> {
    Err(refusal.into())
}

// ---------------------------------------------------------------------------
// Reading by range
// ---------------------------------------------------------------------------

/// Bytes of the archive by range: a version through the core's reader, or memory in the tests.
pub(crate) trait RangeRead: Send + Sync {
    fn size(&self) -> u64;
    /// Up to `length` bytes from `offset`, fewer only at the end.
    fn read_at(&self, offset: u64, length: u64) -> Result<Vec<u8>>;
    /// The decoder over these bytes got on: the call's watchdog starts over (a long preview or a
    /// password's probe is work, not a stall). Fails once the call has ended.
    fn progress(&self) -> Result<()> {
        Ok(())
    }
}

impl RangeRead for Vec<u8> {
    fn size(&self) -> u64 {
        self.len() as u64
    }
    fn read_at(&self, offset: u64, length: u64) -> Result<Vec<u8>> {
        let start = offset.min(self.len() as u64) as usize;
        let end = offset.saturating_add(length).min(self.len() as u64) as usize;
        Ok(self[start..end].to_vec())
    }
}

struct VersionSource(Arc<VersionReader>);

impl RangeRead for VersionSource {
    fn size(&self) -> u64 {
        self.0.size()
    }
    fn progress(&self) -> Result<()> {
        Ok(self.0.progress()?)
    }
    fn read_at(&self, offset: u64, length: u64) -> Result<Vec<u8>> {
        // The reader hands back at most 64 MiB at once; the directory cap is the same.
        let mut out = Vec::with_capacity(length.min(self.0.size()) as usize);
        let mut at = offset;
        let end = offset.saturating_add(length).min(self.0.size());
        while at < end {
            let piece = self.0.read_at(at, (end - at).min(ZIP_DIRECTORY_MAX_BYTES))?;
            if piece.is_empty() {
                break;
            }
            at += piece.len() as u64;
            out.extend_from_slice(&piece);
        }
        Ok(out)
    }
}

fn u16_at(bytes: &[u8], at: usize) -> u64 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]]) as u64
}
fn u32_at(bytes: &[u8], at: usize) -> u64 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as u64
}
/// A u64 that must fit the web's safe integers (2^53 - 1), or the archive is damaged, as there.
fn u64_at(bytes: &[u8], at: usize) -> Result<u64> {
    let value = u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
    if value > (1u64 << 53) - 1 {
        return refused(Refusal::Damaged);
    }
    Ok(value)
}

// ---------------------------------------------------------------------------
// The directory
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub(crate) struct Directory {
    pub offset: u64,
    pub size: u64,
    pub count: u64,
}

/// Where the central directory is, from the end of the file, with every cap checked before the
/// directory itself is read.
pub(crate) fn find_directory(source: &dyn RangeRead) -> Result<Directory> {
    let size = source.size();
    if size < EOCD_LENGTH {
        return refused(Refusal::Damaged);
    }
    let tail_length = size.min(EOCD_LENGTH + MAX16);
    let tail_start = size - tail_length;
    let tail = source.read_at(tail_start, tail_length)?;
    if tail.len() as u64 != tail_length {
        return refused(Refusal::Damaged);
    }
    let mut found = None;
    let mut i = tail.len() as i64 - EOCD_LENGTH as i64;
    while i >= 0 {
        let at = i as usize;
        if u32_at(&tail, at) == SIG_EOCD as u64
            && at as u64 + EOCD_LENGTH + u16_at(&tail, at + 20) == tail.len() as u64
        {
            found = Some(at);
            break;
        }
        i -= 1;
    }
    let Some(at) = found else { return refused(Refusal::Damaged) };
    let eocd_offset = tail_start + at as u64;
    let disk = u16_at(&tail, at + 4);
    let directory_disk = u16_at(&tail, at + 6);
    let mut on_disk = u16_at(&tail, at + 8);
    let mut count = u16_at(&tail, at + 10);
    let mut directory_size = u32_at(&tail, at + 12);
    let mut directory_offset = u32_at(&tail, at + 16);
    let mut end = eocd_offset;
    let locator = if eocd_offset >= LOCATOR_LENGTH {
        let bytes = source.read_at(eocd_offset - LOCATOR_LENGTH, LOCATOR_LENGTH)?;
        (bytes.len() as u64 == LOCATOR_LENGTH && u32_at(&bytes, 0) == SIG_ZIP64_LOCATOR as u64)
            .then_some(bytes)
    } else {
        None
    };
    let sentinel = disk == MAX16
        || directory_disk == MAX16
        || on_disk == MAX16
        || count == MAX16
        || directory_size == MAX32
        || directory_offset == MAX32;
    // Without a ZIP64 locator, 0xffff entries is a count like any other: Python's zipfile writes an
    // archive of exactly 65,535 entries so. Only the counts may say it; any other field at its
    // sentinel without a locator is damage.
    let classic = locator.is_none()
        && on_disk == MAX16
        && count == MAX16
        && disk != MAX16
        && directory_disk != MAX16
        && directory_size != MAX32
        && directory_offset != MAX32;
    if sentinel && locator.is_none() && !classic {
        return refused(Refusal::Damaged);
    }
    if (!sentinel || classic) && (disk != 0 || directory_disk != 0) {
        return refused(Refusal::Split);
    }
    if let Some(locator) = locator {
        if u32_at(&locator, 4) != 0 || u32_at(&locator, 16) > 1 {
            return refused(Refusal::Split);
        }
        let record_offset = u64_at(&locator, 8)?;
        if record_offset + ZIP64_EOCD_LENGTH > eocd_offset - LOCATOR_LENGTH {
            return refused(Refusal::Damaged);
        }
        let record = source.read_at(record_offset, ZIP64_EOCD_LENGTH)?;
        if record.len() as u64 != ZIP64_EOCD_LENGTH || u32_at(&record, 0) != SIG_ZIP64_EOCD as u64 {
            return refused(Refusal::Damaged);
        }
        let record_size = u64_at(&record, 4)?;
        // Version 2 of the record carries how a strong-encrypted directory is encrypted.
        if record_size > ZIP64_EOCD_LENGTH - 12 && u16_at(&record, 14) >= 62 {
            return refused(Refusal::EncryptedDirectory);
        }
        if record_offset + 12 + record_size != eocd_offset - LOCATOR_LENGTH {
            return refused(Refusal::Damaged);
        }
        if u32_at(&record, 16) != 0 || u32_at(&record, 20) != 0 {
            return refused(Refusal::Split);
        }
        let pick = |stored: u64, max: u64, wide: u64| -> Result<u64> {
            if stored == max {
                Ok(wide)
            } else if stored != wide {
                refused(Refusal::Damaged)
            } else {
                Ok(stored)
            }
        };
        on_disk = pick(on_disk, MAX16, u64_at(&record, 24)?)?;
        count = pick(count, MAX16, u64_at(&record, 32)?)?;
        directory_size = pick(directory_size, MAX32, u64_at(&record, 40)?)?;
        directory_offset = pick(directory_offset, MAX32, u64_at(&record, 48)?)?;
        end = record_offset;
    }
    if on_disk != count {
        return refused(Refusal::Split);
    }
    // What the end records say must hold together before any cap is weighed, as on the web: the
    // caps differ (the phones list 50,000 entries, the web 100,000), and a damaged archive is
    // then damaged on both, whatever count it claims.
    if directory_offset + directory_size != end {
        return refused(Refusal::Damaged);
    }
    if count * CENTRAL_LENGTH as u64 > directory_size {
        return refused(Refusal::Damaged);
    }
    if count > ZIP_ENTRIES_MAX {
        return refused(Refusal::TooManyEntries);
    }
    if directory_size > ZIP_DIRECTORY_MAX_BYTES {
        return refused(Refusal::DirectoryTooLarge);
    }
    Ok(Directory { offset: directory_offset, size: directory_size, count })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Lock {
    None,
    ZipCrypto,
    Aes,
    Other,
}

impl Lock {
    fn code(self) -> &'static str {
        match self {
            Lock::None => "none",
            Lock::ZipCrypto => "zipcrypto",
            Lock::Aes => "aes",
            Lock::Other => "other",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Entry {
    pub index: u32,
    pub raw: Vec<u8>,
    pub path: String,
    pub directory: bool,
    pub flags: u16,
    pub method: u16,
    pub crc: u32,
    pub packed: u64,
    pub size: u64,
    pub offset: u64,
    pub bound: u64,
    pub dos: u32,
    pub mtime: Option<i64>,
    pub lock: Lock,
    /* The real method inside WinZip AES, its key strength (1 to 3) and vendor version (1 or 2). */
    pub aes_method: Option<u16>,
    pub aes_strength: u8,
    pub aes_version: u16,
    pub link: bool,
}

/// Each extra field by id (the first of an id wins); a field that overruns the rest is where reading stops.
fn extra_fields(extra: &[u8]) -> HashMap<u16, &[u8]> {
    let mut fields = HashMap::new();
    let mut at = 0usize;
    while at + 4 <= extra.len() {
        let id = u16_at(extra, at) as u16;
        let length = u16_at(extra, at + 2) as usize;
        if at + 4 + length > extra.len() {
            break;
        }
        fields.entry(id).or_insert(&extra[at + 4..at + 4 + length]);
        at += 4 + length;
    }
    fields
}

const CP437: [char; 128] = [
    'Ç', 'ü', 'é', 'â', 'ä', 'à', 'å', 'ç', 'ê', 'ë', 'è', 'ï', 'î', 'ì', 'Ä', 'Å', 'É', 'æ', 'Æ', 'ô', 'ö',
    'ò', 'û', 'ù', 'ÿ', 'Ö', 'Ü', '¢', '£', '¥', '₧', 'ƒ', 'á', 'í', 'ó', 'ú', 'ñ', 'Ñ', 'ª', 'º', '¿', '⌐',
    '¬', '½', '¼', '¡', '«', '»', '░', '▒', '▓', '│', '┤', '╡', '╢', '╖', '╕', '╣', '║', '╗', '╝', '╜', '╛',
    '┐', '└', '┴', '┬', '├', '─', '┼', '╞', '╟', '╚', '╔', '╩', '╦', '╠', '═', '╬', '╧', '╨', '╤', '╥', '╙',
    '╘', '╒', '╓', '╫', '╪', '┘', '┌', '█', '▄', '▌', '▐', '▀', 'α', 'ß', 'Γ', 'π', 'Σ', 'σ', 'µ', 'τ', 'Φ',
    'Θ', 'Ω', 'δ', '∞', 'φ', 'ε', '∩', '≡', '±', '≥', '≤', '⌠', '⌡', '÷', '≈', '°', '∙', '·', '√', 'ⁿ', '²',
    '■', '\u{a0}',
];

/// The name as the person sees it: UTF-8 when the flag says so, or from the Unicode path field
/// (0x7075) when its CRC matches the stored name; otherwise the stored bytes as strict UTF-8 if
/// they are that, else as CP437.
pub(crate) fn decode_name(raw: &[u8], flags: u16, fields: &HashMap<u16, &[u8]>) -> String {
    if flags & 0x800 != 0 {
        return String::from_utf8_lossy(raw).into_owned();
    }
    if let Some(unicode) = fields.get(&0x7075) {
        if unicode.len() >= 5 && unicode[0] == 1 && u32_at(unicode, 1) as u32 == crc32fast::hash(raw) {
            return String::from_utf8_lossy(&unicode[5..]).into_owned();
        }
    }
    match std::str::from_utf8(raw) {
        Ok(text) => text.to_owned(),
        Err(_) => raw
            .iter()
            .map(|&byte| if byte < 0x80 { byte as char } else { CP437[byte as usize - 0x80] })
            .collect(),
    }
}

/// Every record of the directory, in order, exactly as many as declared and filling it exactly;
/// then the overlap check.
pub(crate) fn read_directory(bytes: &[u8], directory: &Directory) -> Result<Vec<Entry>> {
    if bytes.len() as u64 != directory.size {
        return refused(Refusal::Damaged);
    }
    if bytes.len() >= 4 && u32_at(bytes, 0) == SIG_ARCHIVE_EXTRA as u64 {
        return refused(Refusal::EncryptedDirectory);
    }
    let mut entries = Vec::with_capacity(directory.count as usize);
    let mut at = 0usize;
    for index in 0..directory.count {
        if at + CENTRAL_LENGTH > bytes.len() || u32_at(bytes, at) != SIG_CENTRAL as u64 {
            return refused(Refusal::Damaged);
        }
        let made_by = u16_at(bytes, at + 4);
        let flags = u16_at(bytes, at + 8) as u16;
        let method = u16_at(bytes, at + 10) as u16;
        let time = u16_at(bytes, at + 12) as u32;
        let date = u16_at(bytes, at + 14) as u32;
        let crc = u32_at(bytes, at + 16) as u32;
        let mut packed = u32_at(bytes, at + 20);
        let mut size = u32_at(bytes, at + 24);
        let name_length = u16_at(bytes, at + 28) as usize;
        let extra_length = u16_at(bytes, at + 30) as usize;
        let comment_length = u16_at(bytes, at + 32) as usize;
        let mut disk = u16_at(bytes, at + 34);
        let external = u32_at(bytes, at + 38) as u32;
        let mut offset = u32_at(bytes, at + 42);
        let next = at + CENTRAL_LENGTH + name_length + extra_length + comment_length;
        if next > bytes.len() {
            return refused(Refusal::Damaged);
        }
        let raw = bytes[at + CENTRAL_LENGTH..at + CENTRAL_LENGTH + name_length].to_vec();
        let extra =
            &bytes[at + CENTRAL_LENGTH + name_length..at + CENTRAL_LENGTH + name_length + extra_length];
        let fields = extra_fields(extra);
        if size == MAX32 || packed == MAX32 || offset == MAX32 || disk == MAX16 {
            let Some(wide) = fields.get(&0x0001) else { return refused(Refusal::Damaged) };
            let mut p = 0usize;
            let mut take = || -> Result<u64> {
                if p + 8 > wide.len() {
                    return refused(Refusal::Damaged);
                }
                let value = u64_at(wide, p)?;
                p += 8;
                Ok(value)
            };
            if size == MAX32 {
                size = take()?;
            }
            if packed == MAX32 {
                packed = take()?;
            }
            if offset == MAX32 {
                offset = take()?;
            }
            if disk == MAX16 {
                if p + 4 > wide.len() {
                    return refused(Refusal::Damaged);
                }
                disk = u32_at(wide, p);
            }
        }
        if disk != 0 {
            return refused(Refusal::Split);
        }
        let mut lock = Lock::None;
        let mut aes_method = None;
        let mut aes_strength = 0u8;
        let mut aes_version = 0u16;
        if flags & 1 != 0 {
            if flags & 0x40 != 0 {
                lock = Lock::Other;
            } else if method == 99 {
                lock = Lock::Other;
                if let Some(field) = fields.get(&0x9901) {
                    if field.len() >= 7 && field[2] == b'A' && field[3] == b'E' {
                        let version = u16_at(field, 0);
                        let strength = field[4];
                        if (version == 1 || version == 2) && (1..=3).contains(&strength) {
                            lock = Lock::Aes;
                            aes_method = Some(u16_at(field, 5) as u16);
                            aes_strength = strength;
                            aes_version = version as u16;
                        }
                    }
                }
            } else {
                lock = Lock::ZipCrypto;
            }
        }
        let host = made_by >> 8;
        let kind = (external >> 16) & 0o170000;
        let directory_flag = matches!(raw.last(), Some(b'/') | Some(b'\\'));
        let dos_directory = host == 0 && external & 0x10 != 0 && size == 0 && packed == 0;
        let mtime = fields
            .get(&0x5455)
            .filter(|stamp| stamp.len() >= 5 && stamp[0] & 1 != 0)
            .map(|stamp| i32::from_le_bytes(stamp[1..5].try_into().unwrap()) as i64 * 1000);
        entries.push(Entry {
            index: index as u32,
            path: decode_name(&raw, flags, &fields),
            raw,
            directory: directory_flag || dos_directory,
            flags,
            method,
            crc,
            packed,
            size,
            offset,
            bound: 0,
            dos: (date << 16) | time,
            mtime,
            lock,
            aes_method,
            aes_strength,
            aes_version,
            link: (host == 3 || host == 19) && kind == 0o120000,
        });
        at = next;
    }
    if at != bytes.len() {
        return refused(Refusal::Damaged);
    }
    check_overlap(&mut entries, directory.offset)?;
    Ok(entries)
}

/// No two entries' spans may overlap. From the directory alone the local extra field's length is
/// unknown, so this checks the least each span can be (30 + name + data); opening an entry checks
/// the whole of it against `bound`.
pub(crate) fn check_overlap(entries: &mut [Entry], directory_offset: u64) -> Result<()> {
    let mut order: Vec<usize> = (0..entries.len()).collect();
    order.sort_by_key(|&i| (entries[i].offset, entries[i].index));
    for (position, &i) in order.iter().enumerate() {
        let bound = order.get(position + 1).map_or(directory_offset, |&next| entries[next].offset);
        let entry = &mut entries[i];
        if entry.offset + LOCAL_LENGTH as u64 > directory_offset {
            return refused(Refusal::Damaged);
        }
        if entry.offset + LOCAL_LENGTH as u64 + entry.raw.len() as u64 + entry.packed > bound {
            return refused(Refusal::Overlap);
        }
        entry.bound = bound;
    }
    Ok(())
}

/// The local header must agree with the directory; its whole span, data descriptor included, must
/// end by the entry's bound. Returns where the entry's data starts.
pub(crate) fn check_local_header(entry: &Entry, header: &[u8]) -> Result<u64> {
    if header.len() < LOCAL_LENGTH {
        return refused(Refusal::Damaged);
    }
    if u32_at(header, 0) != SIG_LOCAL as u64 {
        return refused(Refusal::Local);
    }
    let flags = u16_at(header, 6);
    let method = u16_at(header, 8);
    let crc = u32_at(header, 14);
    let mut packed = u32_at(header, 18);
    let mut size = u32_at(header, 22);
    let name_length = u16_at(header, 26) as usize;
    let extra_length = u16_at(header, 28) as usize;
    // What the fixed part says first: the method, and the encryption (0x1), data-descriptor (0x8)
    // and UTF-8 (0x800) flags, each of which must say the same in both places.
    if method != entry.method as u64 || (flags & 0x809) != (entry.flags as u64 & 0x809) {
        return refused(Refusal::Local);
    }
    // Then the whole span: a header whose name and extra field run past the next entry overlaps it.
    let start = entry.offset + (LOCAL_LENGTH + name_length + extra_length) as u64;
    if start + entry.packed + if flags & 8 != 0 { 12 } else { 0 } > entry.bound {
        return refused(Refusal::Overlap);
    }
    if header.len() < LOCAL_LENGTH + name_length + extra_length {
        return refused(Refusal::Damaged);
    }
    if header[LOCAL_LENGTH..LOCAL_LENGTH + name_length] != entry.raw[..] {
        return refused(Refusal::Local);
    }
    let fields = extra_fields(&header[LOCAL_LENGTH + name_length..LOCAL_LENGTH + name_length + extra_length]);
    // A WinZip AES entry says so in both places, alike: its version, key strength and real method.
    // A local field missing or saying otherwise describes another entry.
    if entry.lock == Lock::Aes {
        let same = fields.get(&0x9901).is_some_and(|field| {
            field.len() >= 7
                && field[2] == b'A'
                && field[3] == b'E'
                && u16_at(field, 0) as u16 == entry.aes_version
                && field[4] == entry.aes_strength
                && Some(u16_at(field, 5) as u16) == entry.aes_method
        });
        if !same {
            return refused(Refusal::Local);
        }
    }
    // Its data descriptor at its real width without a signature (`data_start` adds one it finds there).
    if flags & 8 != 0 && start + entry.packed + descriptor_length(&fields) > entry.bound {
        return refused(Refusal::Overlap);
    }
    if size == MAX32 || packed == MAX32 {
        let Some(wide) = fields.get(&0x0001) else { return refused(Refusal::Local) };
        let mut p = 0usize;
        if size == MAX32 {
            if p + 8 > wide.len() {
                return refused(Refusal::Local);
            }
            size = u64_at(wide, p)?;
            p += 8;
        }
        if packed == MAX32 {
            if p + 8 > wide.len() {
                return refused(Refusal::Local);
            }
            packed = u64_at(wide, p)?;
        }
    }
    let descriptor = flags & 8 != 0;
    let agrees = |local: u64, central: u64| local == central || (descriptor && local == 0);
    if !agrees(crc, entry.crc as u64) || !agrees(packed, entry.packed) || !agrees(size, entry.size) {
        return refused(Refusal::Local);
    }
    Ok(start)
}

/// A data descriptor's length without its optional signature: the CRC and two sizes, 4 bytes each,
/// or 8 each when the local header carries ZIP64 sizes (its 0x0001 field): 12 or 20.
fn descriptor_length(fields: &HashMap<u16, &[u8]>) -> u64 {
    if fields.contains_key(&0x0001) {
        20
    } else {
        12
    }
}

/// The local header read and checked against the directory: where the entry's data starts. A data
/// descriptor with its signature is 4 bytes longer: where it would start is read, and the whole of
/// it held to the entry's bound, as on the web.
fn data_start(source: &dyn RangeRead, entry: &Entry) -> Result<u64> {
    let header = source.read_at(entry.offset, local_header_read(entry))?;
    let start = check_local_header(entry, &header)?;
    if entry.flags & 8 != 0 {
        let after = start + entry.packed;
        let name_length = u16_at(&header, 26) as usize;
        let extra_length = u16_at(&header, 28) as usize;
        let at = LOCAL_LENGTH + name_length;
        let width = descriptor_length(&extra_fields(&header[at..at + extra_length]));
        let head = source.read_at(after, 16.min(entry.bound - after))?;
        if descriptor_signed(&head, entry, width == 20) && after + width + 4 > entry.bound {
            return refused(Refusal::Overlap);
        }
    }
    Ok(start)
}

/// Whether the descriptor starting with `head` (up to 16 bytes, from the end of the entry's data)
/// carries its optional signature. The signature's 4 bytes can also be a CRC: when the bytes read
/// unsigned hold the entry's CRC and packed size and read signed don't, it has none (as the web).
fn descriptor_signed(head: &[u8], entry: &Entry, wide: bool) -> bool {
    let word = |at: usize| (head.len() >= at + 4).then(|| u32_at(head, at));
    let size = |at: usize| {
        if wide {
            (head.len() >= at + 8).then(|| u64::from_le_bytes(head[at..at + 8].try_into().unwrap()))
        } else {
            word(at)
        }
    };
    if word(0) != Some(SIG_DESCRIPTOR as u64) {
        return false;
    }
    let signed = word(4) == Some(entry.crc as u64) && size(8) == Some(entry.packed);
    let unsigned = word(0) == Some(entry.crc as u64) && size(4) == Some(entry.packed);
    signed || !unsigned
}

fn local_header_read(entry: &Entry) -> u64 {
    (LOCAL_LENGTH as u64 + entry.raw.len() as u64 + MAX16).min(entry.bound - entry.offset)
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/// One entry of the list, for the apps: the same fields the web's worker sends its page.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ArchiveEntry {
    pub index: u32,
    pub path: String,
    /// The folder it is listed in (`ArchiveFolders`; 0 is the top) and its name there: the last part
    /// of its path (`/` and `\` both separate; empty and `.` parts are dropped), or its whole path
    /// when it is listed flat at the top (deeper than 256 parts, or a file named by separators
    /// alone). A Mac resource entry under `__MACOSX/` is in no folder: 0, and never shown.
    pub folder: u32,
    pub name: String,
    pub directory: bool,
    pub size: u64,
    pub packed: u64,
    /// MS-DOS date and time as stored (date << 16 | time), and the Unix time when the archive kept one.
    pub dos: u32,
    pub mtime_millis: Option<i64>,
    /// "none", "zipcrypto", "aes" or "other".
    pub lock: String,
    /// "ok", "method" or "encryption".
    pub support: String,
    pub link: bool,
    pub nested: bool,
    pub hidden: bool,
    pub stored: bool,
    /// What a download of it is saved as: `save_name` of its last part.
    pub save_name: String,
}

const ARCHIVE_EXTENSIONS: &[&str] = &[
    "zip", "zipx", "jar", "war", "ear", "apk", "aab", "ipa", "xpi", "7z", "rar", "tar", "gz", "tgz", "bz2",
    "tbz", "tbz2", "xz", "txz", "zst", "tzst", "lz", "lzma", "z", "cab", "iso", "dmg",
];

/// The archive's folders, as the list shows them. Folder 0 is the top; folder `k` (from 1) has its
/// parent, always below `k`, as the `k`th little-endian u32 of `parents`, and its name as the `k`th
/// of `names`, each name followed by `/` (no name holds `/` or `\`). Bytes rather than a list of
/// numbers, so an app holds them as one array, not millions of boxed values.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ArchiveFolders {
    pub parents: Vec<u8>,
    pub names: String,
}

/// Where the next part of `path` from byte `from` starts and ends: `/` and `\` both separate, and
/// empty and `.` parts are skipped.
pub(crate) fn next_part(path: &str, from: usize) -> Option<(usize, usize)> {
    let bytes = path.as_bytes();
    let separator = |byte: u8| byte == b'/' || byte == b'\\';
    let mut at = from;
    loop {
        while at < bytes.len() && separator(bytes[at]) {
            at += 1;
        }
        if at >= bytes.len() {
            return None;
        }
        let start = at;
        while at < bytes.len() && !separator(bytes[at]) {
            at += 1;
        }
        if &path[start..at] != "." {
            return Some((start, at));
        }
    }
}

/// A path's folders and name (`next_part` after `next_part`).
#[cfg(test)]
pub(crate) fn path_parts(path: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut from = 0;
    while let Some((start, end)) = next_part(path, from) {
        parts.push(path[start..end].to_owned());
        from = end;
    }
    parts
}

fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

fn support_of(entry: &Entry) -> &'static str {
    if entry.lock == Lock::Other {
        return "encryption";
    }
    let method = if entry.lock == Lock::Aes { entry.aes_method.unwrap_or(u16::MAX) } else { entry.method };
    if method == 0 || method == 8 || (method == 9 && DEFLATE64) {
        "ok"
    } else {
        "method"
    }
}

/// How deep the list goes: an entry more than 256 parts deep is listed flat, under its whole path,
/// at the top (the web's LIST_DEPTH_MAX).
pub const LIST_DEPTH_MAX: usize = 256;
/// The most folders a list makes: past it the archive is refused as `directory-too-large`, as on
/// the web (zip-format.ts's ZIP_LIMITS.folders). 2,000,000 folders are about 24 MB in an app's
/// arrays; a 16 MiB directory of nothing but folders could make 7.6 million, more than a phone's
/// heap should hold for one list.
pub const LIST_FOLDERS_MAX: u32 = 2_000_000;

/* Characters no file system takes, or that change how a name reads (controls, bidi marks): the web's save-file.ts set. */
fn unsafe_char(code: u32) -> bool {
    matches!(char::from_u32(code), Some('\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        || code < 0x20
        || (0x7f..=0x9f).contains(&code)
        || code == 0x061c
        || code == 0x200e
        || code == 0x200f
        || (0x202a..=0x202e).contains(&code)
        || (0x2066..=0x2069).contains(&code)
}

/* Dots and the whitespace JavaScript's \s matches, written out as the web writes them. */
fn edge_char(code: u32) -> bool {
    matches!(
        code,
        0x2e | 0x09
            | 0x0a
            | 0x0b
            | 0x0c
            | 0x0d
            | 0x20
            | 0xa0
            | 0x1680
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    ) || (0x2000..=0x200a).contains(&code)
}

fn trim_edges(chars: &[char]) -> &[char] {
    let mut start = 0;
    let mut end = chars.len();
    while start < end && edge_char(chars[start] as u32) {
        start += 1;
    }
    while end > start && edge_char(chars[end - 1] as u32) {
        end -= 1;
    }
    &chars[start..end]
}

/* Names Windows keeps for devices, with or without an extension, any case. */
fn reserved(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let stem = lower.split('.').next().unwrap_or("");
    let rest = &lower[stem.len()..];
    if !(rest.is_empty() || rest.starts_with('.')) {
        return false;
    }
    matches!(stem, "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.as_bytes()[3].is_ascii_digit())
}

/// The name an entry is saved as when downloaded, from the last part of its path (the web's
/// `saveName`, ported as is): NFC, forbidden and invisible characters (controls, bidi overrides)
/// as `_`, no leading or trailing dots or spaces, a Windows device name given a leading `_`, and
/// at most 255 bytes of UTF-8, cut between code points before an extension of at most 32 bytes.
pub fn save_name(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let mapped: Vec<char> = name.nfc().map(|c| if unsafe_char(c as u32) { '_' } else { c }).collect();
    let mut text: String = trim_edges(&mapped).iter().collect();
    if text.is_empty() {
        return "Untitled".into();
    }
    if reserved(&text) {
        text = format!("_{text}");
    }
    if text.len() <= 255 {
        return text;
    }
    let (stem, extension) = match text.rfind('.') {
        Some(dot) if dot > 0 && text.len() - dot <= 32 => (&text[..dot], &text[dot..]),
        _ => (&text[..], ""),
    };
    let room = 255 - extension.len();
    let mut base = Vec::new();
    let mut bytes = 0;
    for c in stem.chars() {
        if bytes + c.len_utf8() > room {
            break;
        }
        bytes += c.len_utf8();
        base.push(c);
    }
    let kept: String = trim_edges(&base).iter().collect();
    if kept.is_empty() {
        "Untitled".into()
    } else {
        kept + extension
    }
}

/// The list and its folders, from the entries; each entry's decoded name moves into it (an entry
/// keeps its raw name to check against), so the two are never held twice.
///
/// The folders are made a level at a time: every entry still going deeper takes its next part, and
/// a map of this level's names under their parents finds each folder made already. Only that map
/// and a few numbers an entry are held while it runs, and the folders come out as one array and one
/// string, so memory grows with the directory's bytes and nothing else: no entry keeps its parts,
/// and no path's prefixes are ever made.
pub(crate) fn list_entries(entries: &mut [Entry]) -> Result<(Vec<ArchiveEntry>, ArchiveFolders)> {
    let count = entries.len();
    // Where each entry sits: its folder, and its name's span in its path (the whole path when flat).
    let mut folder = vec![0u32; count];
    let mut name = vec![(0usize, 0usize); count];
    let mut hidden = vec![false; count];
    // Its parts (counted to one past the cap), the next one's start, and the folder reached so far.
    let mut depth = vec![0u16; count];
    let mut at = vec![0u32; count];
    let mut node = vec![0u32; count];
    let mut made: u32 = 1;
    let mut active: Vec<u32> = Vec::new();
    let mut flat: Vec<u32> = Vec::new();
    let list: &[Entry] = entries;
    // At most a folder for every part but a file's last, each name with its `/`: the room the
    // folders are given at once, so they never grow by doubling (the pages never written are
    // never held), then trimmed to what they took.
    let (mut most, mut most_bytes) = (0usize, 0usize);
    for (i, entry) in list.iter().enumerate() {
        let (mut parts, mut from, mut bytes, mut last) = (0usize, 0usize, 0usize, 0usize);
        while parts <= LIST_DEPTH_MAX {
            let Some((start, end)) = next_part(&entry.path, from) else { break };
            parts += 1;
            bytes += end - start + 1;
            last = end - start + 1;
            from = end;
        }
        depth[i] = parts as u16;
        if parts > LIST_DEPTH_MAX || (parts == 0 && !entry.directory) {
            name[i] = (0, entry.path.len());
            flat.push(i as u32);
        } else if parts > 0 {
            active.push(i as u32);
            let file = !entry.directory as usize;
            most += parts - file;
            most_bytes += bytes - last * file;
        }
    }
    let mut parents: Vec<u8> = Vec::with_capacity(4 * (most + 1));
    parents.extend_from_slice(&[0; 4]);
    let mut names = String::with_capacity(most_bytes);
    let flat_name = |i: usize| if list[i].path.is_empty() { "_" } else { list[i].path.as_str() };
    let mut level = 0usize;
    let mut children: HashMap<(u32, &str), u32> = HashMap::new();
    // Level 0 runs even with nothing nested: the flat entries are names of the top too.
    while level == 0 || !active.is_empty() {
        children.clear();
        if level == 0 {
            for &i in &flat {
                children.entry((0, flat_name(i as usize))).or_insert(0);
            }
        }
        let mut next = Vec::with_capacity(active.len());
        for &i in &active {
            let i = i as usize;
            let path = list[i].path.as_str();
            let Some((start, end)) = next_part(path, at[i] as usize) else { continue };
            at[i] = end as u32;
            let part = &path[start..end];
            let parent = node[i];
            let last = level + 1 == depth[i] as usize;
            // Only what is under a top folder __MACOSX: a plain file of that name is anyone's file.
            if level == 0 && part == "__MACOSX" && !(last && !list[i].directory) {
                // Mac resource entries: hidden, and no folder made for them.
                hidden[i] = true;
                children.entry((0, part)).or_insert(0);
                let mut from = end;
                name[i] = (start, end);
                while let Some(span) = next_part(path, from) {
                    name[i] = span;
                    from = span.1;
                }
                continue;
            }
            if last && !list[i].directory {
                folder[i] = parent;
                name[i] = (start, end);
                children.entry((parent, part)).or_insert(0);
                continue;
            }
            let slot = children.entry((parent, part)).or_insert(0);
            if *slot == 0 {
                if made > LIST_FOLDERS_MAX {
                    return refused(Refusal::DirectoryTooLarge);
                }
                *slot = made;
                made += 1;
                parents.extend_from_slice(&parent.to_le_bytes());
                names.push_str(part);
                names.push('/');
            }
            if last {
                folder[i] = parent;
                name[i] = (start, end);
            } else {
                node[i] = *slot;
                next.push(i as u32);
            }
        }
        // A `._x` is hidden only beside an `x`: a file or folder of this level under the same parent.
        for &i in &active {
            let i = i as usize;
            if hidden[i] || list[i].directory || level + 1 != depth[i] as usize {
                continue;
            }
            let part = &list[i].path[name[i].0..name[i].1];
            if part.starts_with("._")
                && part.chars().count() > 2
                && children.contains_key(&(folder[i], &part[2..]))
            {
                hidden[i] = true;
            }
        }
        if level == 0 {
            for &i in &flat {
                let i = i as usize;
                let part = flat_name(i);
                if !list[i].directory
                    && part.starts_with("._")
                    && part.chars().count() > 2
                    && children.contains_key(&(0, &part[2..]))
                {
                    hidden[i] = true;
                }
            }
        }
        active = next;
        level += 1;
    }
    drop(children);
    parents.shrink_to_fit();
    names.shrink_to_fit();
    let listed = entries
        .iter_mut()
        .enumerate()
        .filter(|(i, entry)| depth[*i] > 0 || !entry.directory)
        .map(|(i, entry)| {
            let name = if entry.path.is_empty() {
                "_".to_owned()
            } else {
                entry.path[name[i].0..name[i].1].to_owned()
            };
            let link = entry.link && !entry.directory;
            ArchiveEntry {
                index: entry.index,
                path: std::mem::take(&mut entry.path),
                folder: folder[i],
                directory: entry.directory,
                size: entry.size,
                packed: entry.packed,
                dos: entry.dos,
                mtime_millis: entry.mtime,
                lock: entry.lock.code().into(),
                support: support_of(entry).into(),
                link,
                nested: !entry.directory
                    && !entry.link
                    && ARCHIVE_EXTENSIONS.contains(&extension_of(&name).as_str()),
                hidden: hidden[i],
                stored: !entry.directory && !entry.link && entry.method == 0 && entry.lock == Lock::None,
                save_name: save_name(&name),
                name,
            }
        })
        .collect();
    Ok((listed, ArchiveFolders { parents, names }))
}

/// Whether an entry declares more than 200 times what it packs, once it declares over 1 MiB: a
/// preview refuses it before reading a byte. Nothing more is needed while inflating: what comes
/// out is held to the declared size at the byte past it, so the declared ratio bounds the real one.
/// A running ratio would only refuse honest files that start blank (a scanned page, a disk image).
pub(crate) fn declares_too_much(size: u64, packed: u64) -> bool {
    size > RATIO_FROM && size > RATIO.saturating_mul(packed)
}

/// Whether downloading an entry asks first: over 4 GiB declared, at more than 200 to 1.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn zip_entry_asks_first(size: u64, packed: u64) -> bool {
    size > ASK_ABOVE && size > RATIO.saturating_mul(packed)
}

/// When the phones' large-file card shows for an archive entry, by what it previews as: past
/// `threshold` it says what opening costs and offers Continue beside Download; past `ceiling` it
/// offers Download only. Section 3's entry limits (images 100 MiB, text 8 MiB, PDF and media
/// 64 MiB inflated) are the ceilings on a phone with more than 4 GB of memory, half of them at
/// 4 GB or less; the card offers Continue from a third of the ceiling. Both apps ask here, so
/// they agree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct PreviewLimits {
    pub threshold: Option<u64>,
    pub ceiling: u64,
}

/// `kind` is "image", "text", "pdf", "media" or "other"; `memory_bytes` the device's physical memory.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn zip_entry_preview_limits(kind: String, memory_bytes: u64) -> PreviewLimits {
    let small = memory_bytes <= 4 * 1024 * MIB;
    let full = match kind.as_str() {
        "image" => 100 * MIB,
        "text" => 8 * MIB,
        "pdf" | "media" | "other" => 64 * MIB,
        _ => 8 * MIB,
    };
    let ceiling = if small && kind != "text" { full / 2 } else { full };
    // Text is shown in part, not refused, below its ceiling: no card before it.
    let threshold = (kind != "text").then_some(ceiling / 3);
    PreviewLimits { threshold, ceiling }
}

// ---------------------------------------------------------------------------
// Bombs: the counter every inflated byte goes through
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub(crate) struct InflateCounter {
    declared: u64,
    ratio: bool,
    pub produced: u64,
    pub consumed: u64,
}

impl InflateCounter {
    pub fn new(declared: u64, ratio: bool) -> Self {
        InflateCounter { declared, ratio, produced: 0, consumed: 0 }
    }
    #[cfg(test)]
    pub fn read(&mut self, bytes: u64) {
        self.consumed += bytes;
    }
    /// The compressed bytes consumed so far, as how far into the entry's data reading has reached.
    pub fn reached(&mut self, position: u64) {
        self.consumed = self.consumed.max(position);
    }
    pub fn wrote(&mut self, bytes: u64) -> std::result::Result<(), Refusal> {
        self.produced += bytes;
        if self.produced > self.declared {
            return Err(Refusal::Size);
        }
        if self.ratio && self.produced > RATIO_FROM && self.produced > RATIO.saturating_mul(self.consumed) {
            return Err(Refusal::Ratio);
        }
        Ok(())
    }
    /// At the end: more than declared is a bomb, fewer is damage, each said as such.
    pub fn finish(&self) -> std::result::Result<(), Refusal> {
        if self.produced > self.declared {
            return Err(Refusal::Size);
        }
        if self.produced < self.declared {
            return Err(Refusal::Short);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Decryption: traditional PKWARE (ZipCrypto) and WinZip AES, by hand
// ---------------------------------------------------------------------------

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
}
const CRC_TABLE: [u32; 256] = crc_table();

fn crc_byte(crc: u32, byte: u8) -> u32 {
    CRC_TABLE[((crc ^ byte as u32) & 0xff) as usize] ^ (crc >> 8)
}

/// The traditional PKWARE cipher's three keys, wiped when dropped.
struct ZipCrypto([u32; 3]);

impl Drop for ZipCrypto {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl ZipCrypto {
    fn new(password: &[u8]) -> Self {
        let mut keys = ZipCrypto([0x1234_5678, 0x2345_6789, 0x3456_7890]);
        for &byte in password {
            keys.update(byte);
        }
        keys
    }
    fn update(&mut self, byte: u8) {
        self.0[0] = crc_byte(self.0[0], byte);
        self.0[1] = self.0[1].wrapping_add(self.0[0] & 0xff).wrapping_mul(134_775_813).wrapping_add(1);
        self.0[2] = crc_byte(self.0[2], (self.0[1] >> 24) as u8);
    }
    fn decrypt(&mut self, bytes: &mut [u8]) {
        for byte in bytes {
            let temp = self.0[2] | 2;
            let plain = *byte ^ ((temp.wrapping_mul(temp ^ 1) >> 8) & 0xff) as u8;
            self.update(plain);
            *byte = plain;
        }
    }
}

enum AesKey {
    A128(Box<aes::Aes128>),
    A192(Box<aes::Aes192>),
    A256(Box<aes::Aes256>),
}

/*
 * SHA-1 and HMAC-SHA1 over state of our own, so every byte of it (the keyed midstates included,
 * which are as good as the MAC key) is wiped when it is dropped: the `hmac` and `sha1` crates'
 * own state can't be, without unsafe code this crate forbids. Only the block function is sha1's.
 */
#[derive(Clone)]
struct Sha1State {
    h: [u32; 5],
    block: [u8; 64],
    filled: usize,
    total: u64,
}

impl Drop for Sha1State {
    fn drop(&mut self) {
        self.h.zeroize();
        self.block.zeroize();
        self.filled = 0;
        self.total = 0;
    }
}

impl Sha1State {
    fn new() -> Self {
        Sha1State {
            h: [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0],
            block: [0; 64],
            filled: 0,
            total: 0,
        }
    }

    fn compress(h: &mut [u32; 5], block: &[u8; 64]) {
        let mut wrapped = sha1::digest::generic_array::GenericArray::from(*block);
        sha1::compress(h, std::slice::from_ref(&wrapped));
        wrapped.zeroize();
    }

    fn update(&mut self, mut bytes: &[u8]) {
        self.total = self.total.wrapping_add(bytes.len() as u64);
        while !bytes.is_empty() {
            let take = (64 - self.filled).min(bytes.len());
            self.block[self.filled..self.filled + take].copy_from_slice(&bytes[..take]);
            self.filled += take;
            bytes = &bytes[take..];
            if self.filled == 64 {
                Self::compress(&mut self.h, &self.block);
                self.filled = 0;
            }
        }
    }

    fn finalize(mut self) -> Zeroizing<[u8; 20]> {
        let bits = self.total.wrapping_mul(8);
        self.update(&[0x80]);
        while self.filled != 56 {
            self.update(&[0]);
        }
        self.update(&bits.to_be_bytes());
        let mut out = Zeroizing::new([0u8; 20]);
        for (i, word) in self.h.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        out
    }
}

/// HMAC-SHA1 (RFC 2104): the inner state keyed with the key and ipad, and the key with opad for the outer.
#[derive(Clone)]
struct HmacSha1 {
    inner: Sha1State,
    outer_key: Zeroizing<[u8; 64]>,
}

impl HmacSha1 {
    fn new(key: &[u8]) -> Self {
        let mut padded = Zeroizing::new([0u8; 64]);
        if key.len() > 64 {
            let mut hash = Sha1State::new();
            hash.update(key);
            padded[..20].copy_from_slice(&hash.finalize()[..]);
        } else {
            padded[..key.len()].copy_from_slice(key);
        }
        let mut inner_key = Zeroizing::new([0u8; 64]);
        let mut outer_key = Zeroizing::new([0u8; 64]);
        for i in 0..64 {
            inner_key[i] = padded[i] ^ 0x36;
            outer_key[i] = padded[i] ^ 0x5c;
        }
        let mut inner = Sha1State::new();
        inner.update(&inner_key[..]);
        HmacSha1 { inner, outer_key }
    }

    fn update(&mut self, bytes: &[u8]) {
        self.inner.update(bytes);
    }

    fn finalize(self) -> Zeroizing<[u8; 20]> {
        let HmacSha1 { inner, outer_key } = self;
        let inner = inner.finalize();
        let mut outer = Sha1State::new();
        outer.update(&outer_key[..]);
        outer.update(&inner[..]);
        outer.finalize()
    }
}

/// WinZip AES: CTR with a little-endian counter from 1, HMAC-SHA1 over the ciphertext. The block
/// cipher wipes its key schedule when dropped (the aes crate's `zeroize`); the rest is wiped here.
struct WinZipAes {
    key: AesKey,
    counter: u128,
    stream: [u8; 16],
    used: usize,
    mac: Option<HmacSha1>,
}

impl Drop for WinZipAes {
    fn drop(&mut self) {
        self.counter.zeroize();
        self.stream.zeroize();
    }
}

/// PBKDF2-HMAC-SHA1 (RFC 8018), as WinZip AES derives its keys: 1,000 iterations; every block
/// and keyed state wiped as it goes.
fn pbkdf2_sha1(password: &[u8], salt: &[u8], length: usize) -> Zeroizing<Vec<u8>> {
    pbkdf2_sha1_rounds(password, salt, 1000, length)
}

fn pbkdf2_sha1_rounds(password: &[u8], salt: &[u8], rounds: u32, length: usize) -> Zeroizing<Vec<u8>> {
    let prf = HmacSha1::new(password);
    let mut out = Zeroizing::new(Vec::with_capacity(length));
    let mut block = 1u32;
    while out.len() < length {
        let mut u = prf.clone();
        u.update(salt);
        u.update(&block.to_be_bytes());
        let mut last = u.finalize();
        let mut total = Zeroizing::new(*last);
        for _ in 1..rounds {
            let mut u = prf.clone();
            u.update(&last[..]);
            last = u.finalize();
            for (t, l) in total.iter_mut().zip(last.iter()) {
                *t ^= l;
            }
        }
        let take = (length - out.len()).min(20);
        out.extend_from_slice(&total[..take]);
        block += 1;
    }
    out
}

impl WinZipAes {
    /// The keys from the password and salt, or None when the two-byte verifier says the password is wrong.
    fn new(strength: u8, password: &[u8], salt: &[u8], verifier: &[u8]) -> Option<Self> {
        use aes::cipher::KeyInit;
        let length = match strength {
            1 => 16,
            2 => 24,
            _ => 32,
        };
        let derived = pbkdf2_sha1(password, salt, length * 2 + 2);
        if derived[length * 2..] != verifier[..2] {
            return None;
        }
        let key = &derived[..length];
        let key = match strength {
            1 => AesKey::A128(Box::new(aes::Aes128::new_from_slice(key).ok()?)),
            2 => AesKey::A192(Box::new(aes::Aes192::new_from_slice(key).ok()?)),
            _ => AesKey::A256(Box::new(aes::Aes256::new_from_slice(key).ok()?)),
        };
        let mac = HmacSha1::new(&derived[length..length * 2]);
        Some(WinZipAes { key, counter: 0, stream: [0; 16], used: 16, mac: Some(mac) })
    }

    fn decrypt(&mut self, bytes: &mut [u8]) {
        use aes::cipher::BlockEncrypt;
        if let Some(mac) = self.mac.as_mut() {
            mac.update(bytes);
        }
        for byte in bytes {
            if self.used == 16 {
                self.counter = self.counter.wrapping_add(1);
                let mut block = aes::Block::from(self.counter.to_le_bytes());
                match &self.key {
                    AesKey::A128(cipher) => cipher.encrypt_block(&mut block),
                    AesKey::A192(cipher) => cipher.encrypt_block(&mut block),
                    AesKey::A256(cipher) => cipher.encrypt_block(&mut block),
                }
                self.stream = block.into();
                self.used = 0;
            }
            *byte ^= self.stream[self.used];
            self.used += 1;
        }
    }

    /// Whether the stored code (10 bytes) is the HMAC of everything decrypted, compared in constant time.
    fn verify(mut self, code: &[u8]) -> bool {
        let Some(mac) = self.mac.take() else { return false };
        let digest = mac.finalize();
        code.len() == 10 && digest[..10].iter().zip(code).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
    }
}

enum Cipher {
    Plain,
    ZipCrypto(ZipCrypto),
    Aes(Box<WinZipAes>),
}

impl Cipher {
    fn decrypt(&mut self, bytes: &mut [u8]) {
        match self {
            Cipher::Plain => {}
            Cipher::ZipCrypto(keys) => keys.decrypt(bytes),
            Cipher::Aes(aes) => aes.decrypt(bytes),
        }
    }
}

// ---------------------------------------------------------------------------
// Decompression: stored, Deflate (flate2), Deflate64
// ---------------------------------------------------------------------------

enum Inflater {
    Stored,
    Deflate(Box<flate2::Decompress>, bool),
    Deflate64(Box<deflate64::InflaterManaged>),
}

impl Inflater {
    /// Feeds `input` whole, handing every piece produced to `out`, through `buffer` (the decoder's
    /// own, made once per entry: a stored entry's input goes straight through, and needs none).
    fn feed(
        &mut self,
        input: &[u8],
        buffer: &mut [u8],
        out: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        match self {
            Inflater::Stored => out(input),
            Inflater::Deflate(inflate, ended) => {
                let mut at = 0;
                while !*ended {
                    let (before_in, before_out) = (inflate.total_in(), inflate.total_out());
                    let status = inflate
                        .decompress(&input[at..], buffer, flate2::FlushDecompress::None)
                        .map_err(|_| ArchiveError::from(Refusal::Damaged))?;
                    let consumed = (inflate.total_in() - before_in) as usize;
                    let produced = (inflate.total_out() - before_out) as usize;
                    at += consumed;
                    if produced > 0 {
                        out(&buffer[..produced])?;
                    }
                    if status == flate2::Status::StreamEnd {
                        *ended = true;
                    }
                    if consumed == 0 && produced == 0 {
                        break;
                    }
                }
                // Bytes after the stream's end, inside the entry's packed size: refused, as on the web.
                if *ended && at < input.len() {
                    return refused(Refusal::Damaged);
                }
                Ok(())
            }
            Inflater::Deflate64(inflate) => {
                let mut at = 0;
                while !inflate.finished() {
                    let result = inflate.inflate(&input[at..], buffer);
                    if result.data_error {
                        return refused(Refusal::Damaged);
                    }
                    at += result.bytes_consumed;
                    if result.bytes_written > 0 {
                        out(&buffer[..result.bytes_written])?;
                    }
                    if result.bytes_consumed == 0 && result.bytes_written == 0 {
                        break;
                    }
                }
                if inflate.finished() && at < input.len() {
                    return refused(Refusal::Damaged);
                }
                Ok(())
            }
        }
    }

    /// The input is all in: whatever the inflater still holds, then whether its stream ended.
    fn finish(&mut self, buffer: &mut [u8], out: &mut dyn FnMut(&[u8]) -> Result<()>) -> Result<()> {
        match self {
            Inflater::Stored => Ok(()),
            Inflater::Deflate(inflate, ended) => {
                while !*ended {
                    let before = inflate.total_out();
                    let status = inflate
                        .decompress(&[], buffer, flate2::FlushDecompress::Finish)
                        .map_err(|_| ArchiveError::from(Refusal::Damaged))?;
                    let produced = (inflate.total_out() - before) as usize;
                    if produced > 0 {
                        out(&buffer[..produced])?;
                    }
                    if status == flate2::Status::StreamEnd {
                        *ended = true;
                    } else if produced == 0 {
                        return refused(Refusal::Damaged);
                    }
                }
                Ok(())
            }
            Inflater::Deflate64(inflate) => {
                while !inflate.finished() {
                    let result = inflate.inflate(&[], buffer);
                    if result.data_error {
                        return refused(Refusal::Damaged);
                    }
                    if result.bytes_written > 0 {
                        out(&buffer[..result.bytes_written])?;
                    } else {
                        return refused(Refusal::Damaged);
                    }
                }
                Ok(())
            }
        }
    }
}

/// What the inflater is fed at a time, and so how finely the ratio is counted.
const FEED_BYTES: u64 = 16 * 1024;
/// What is read from the archive at a time.
const READ_BYTES: u64 = 64 * 1024;
const CLOSED: &str = "The archive was closed.";

fn closed_error() -> ArchiveError {
    ArchiveError::Failed { reason: CLOSED.into() }
}

// ---------------------------------------------------------------------------
// An open archive
// ---------------------------------------------------------------------------

/// The listing and what each entry is.
pub(crate) struct Listing {
    pub entries: Vec<Entry>,
    pub listed: Vec<ArchiveEntry>,
}

/* The password, and whether the archive is closed: one lock, so an unlock racing a close can't publish a password after it. */
#[derive(Default)]
struct Lifecycle {
    closed: bool,
}

/*
 * The password held, shared by an archive and its siblings (a download's), and whether an entry
 * decoded whole proved it. One proven only by its verifier (ZipCrypto's one byte passes 1 wrong
 * password in 256) is let go of by the first locked entry that then reads as damaged, on any of
 * them, and that entry asks for it again (`password-unproven`). `failed` is the password let go
 * of on each entry: typed again and damaged again there, it is kept and the damage said, rather
 * than asked for without end.
 */
#[derive(Default)]
struct Held {
    password: Option<Zeroizing<Vec<u8>>>,
    proven: bool,
    failed: HashMap<u32, Zeroizing<Vec<u8>>>,
}

/// An open archive: its listing, and the password while one is held. Each entry is decoded from
/// its own listing record (its offset, method, flags, CRC and sizes): no second parser reads the
/// directory, so an entry can't be read under any other record.
pub(crate) struct Zip {
    listing: Mutex<Option<Arc<Listing>>>,
    /* The list's folders until the app takes them: nothing here reads them, so none are kept after. */
    folders: Mutex<Option<ArchiveFolders>>,
    life: Mutex<Lifecycle>,
    held: Arc<Mutex<Held>>,
    /* A sibling never wipes the password its archive still holds. */
    sibling: bool,
    closed: std::sync::atomic::AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Zip {
    pub fn open(source: &dyn RangeRead) -> Result<Zip> {
        let directory = find_directory(source)?;
        let bytes = source.read_at(directory.offset, directory.size)?;
        let mut entries = read_directory(&bytes, &directory)?;
        // The directory's bytes go before the list is made: on a phone they are up to 16 MiB.
        drop(bytes);
        let (listed, folders) = list_entries(&mut entries)?;
        Ok(Zip {
            listing: Mutex::new(Some(Arc::new(Listing { entries, listed }))),
            folders: Mutex::new(Some(folders)),
            life: Mutex::new(Lifecycle::default()),
            held: Arc::new(Mutex::new(Held::default())),
            sibling: false,
            closed: std::sync::atomic::AtomicBool::new(false),
        })
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The list's folders, handed over once.
    pub fn take_folders(&self) -> ArchiveFolders {
        lock(&self.folders).take().unwrap_or_default()
    }

    pub fn listing(&self) -> Result<Arc<Listing>> {
        lock(&self.listing).clone().ok_or_else(closed_error)
    }

    pub fn hidden(&self) -> u32 {
        self.listing().map_or(0, |listing| {
            listing.listed.iter().filter(|item| item.hidden && !item.directory).count() as u32
        })
    }

    fn entry(listing: &Listing, index: u32) -> Result<&Entry> {
        let Some(entry) = listing.entries.get(index as usize) else { return refused(Refusal::Damaged) };
        if entry.directory {
            return refused(Refusal::Directory);
        }
        if entry.link {
            return refused(Refusal::Link);
        }
        match support_of(entry) {
            "method" => refused(Refusal::Method),
            "encryption" => refused(Refusal::Encryption),
            _ => Ok(entry),
        }
    }

    fn nested(listing: &Listing, index: u32) -> bool {
        listing.listed.iter().any(|item| item.index == index && item.nested)
    }

    /// The entry's bytes through `write`, each piece counted: never past its declared size (with
    /// `ratio`, a running 200:1 too, which zip entries never ask for: their declared size and
    /// declared ratio bound them, `declares_too_much`). The AES code,
    /// then the CRC, then the size are checked at the end. With `check_only`, only the password's
    /// check at the start of the data.
    fn inflate(
        &self,
        source: &dyn RangeRead,
        entry: &Entry,
        ratio: bool,
        password: Option<&[u8]>,
        check_only: bool,
        write: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        if self.is_closed() {
            return Err(closed_error());
        }
        let start = data_start(source, entry)?;
        if entry.lock != Lock::None && password.is_none() {
            return refused(Refusal::Password);
        }
        // Stored and plain, the bytes are the entry: more or fewer than declared is known at once.
        if entry.method == 0 && entry.lock == Lock::None && entry.packed != entry.size {
            return refused(if entry.packed > entry.size { Refusal::Size } else { Refusal::Short });
        }
        let end = start + entry.packed;
        let mut at = start;
        let mut data_end = end;
        let mut cipher = Cipher::Plain;
        match entry.lock {
            Lock::ZipCrypto => {
                if entry.packed < 12 {
                    return refused(Refusal::Damaged);
                }
                let mut head = source.read_at(start, 12)?;
                if head.len() != 12 {
                    return refused(Refusal::Damaged);
                }
                let mut keys = ZipCrypto::new(password.unwrap_or_default());
                keys.decrypt(&mut head);
                let check =
                    if entry.flags & 8 != 0 { (entry.dos & 0xffff) >> 8 } else { entry.crc >> 24 } as u8;
                if head[11] != check {
                    return refused(Refusal::WrongPassword);
                }
                at += 12;
                cipher = Cipher::ZipCrypto(keys);
            }
            Lock::Aes => {
                let salt = match entry.aes_strength {
                    1 => 8,
                    2 => 12,
                    _ => 16,
                };
                if entry.packed < salt + 2 + 10 {
                    return refused(Refusal::Damaged);
                }
                let head = source.read_at(start, salt + 2)?;
                if head.len() as u64 != salt + 2 {
                    return refused(Refusal::Damaged);
                }
                let aes = WinZipAes::new(
                    entry.aes_strength,
                    password.unwrap_or_default(),
                    &head[..salt as usize],
                    &head[salt as usize..],
                )
                .ok_or(Refusal::WrongPassword)?;
                at += salt + 2;
                data_end = end - 10;
                cipher = Cipher::Aes(Box::new(aes));
            }
            _ => {}
        }
        if check_only {
            return Ok(());
        }
        let method =
            if entry.lock == Lock::Aes { entry.aes_method.unwrap_or(u16::MAX) } else { entry.method };
        let mut inflater = match method {
            0 => Inflater::Stored,
            8 => Inflater::Deflate(Box::new(flate2::Decompress::new(false)), false),
            9 => Inflater::Deflate64(deflate64::InflaterManaged::new().into()),
            _ => return refused(Refusal::Method),
        };
        // The decoder's output buffer, once per entry and wiped with it; a stored entry needs none.
        let mut buffer = Zeroizing::new(if matches!(inflater, Inflater::Stored) {
            Vec::new()
        } else {
            vec![0u8; 64 * 1024]
        });
        let checks_crc = match entry.lock {
            Lock::Aes => entry.aes_version == 1,
            _ => true,
        };
        let mut counter = InflateCounter::new(entry.size, ratio);
        let mut crc = crc32fast::Hasher::new();
        // How far into the data the inflater has been fed: the ratio counter's input.
        let reached = std::cell::Cell::new(0u64);
        let mut emit = |piece: &[u8]| -> Result<()> {
            counter.reached(reached.get());
            counter.wrote(piece.len() as u64)?;
            if checks_crc {
                crc.update(piece);
            }
            write(piece)
        };
        while at < data_end {
            if self.is_closed() {
                return Err(closed_error());
            }
            let mut bytes = Zeroizing::new(source.read_at(at, (data_end - at).min(READ_BYTES))?);
            if bytes.is_empty() {
                return refused(Refusal::Damaged);
            }
            let mut fed = 0;
            while fed < bytes.len() {
                let stop = (fed + FEED_BYTES as usize).min(bytes.len());
                let piece = &mut bytes[fed..stop];
                let length = piece.len();
                cipher.decrypt(piece);
                reached.set(at + (fed + length) as u64 - start);
                inflater.feed(piece, &mut buffer, &mut emit)?;
                fed += length;
                // Each piece decoded is work: a long preview or probe isn't the watchdog's stall.
                source.progress()?;
            }
            at += bytes.len() as u64;
        }
        inflater.finish(&mut buffer, &mut emit)?;
        if let Cipher::Aes(aes) = cipher {
            let code = source.read_at(data_end, 10)?;
            if !aes.verify(&code) {
                return refused(Refusal::Auth);
            }
        }
        if checks_crc && crc.finalize() != entry.crc {
            return refused(Refusal::Crc);
        }
        counter.finish()?;
        Ok(())
    }

    /// For the viewer: the entry decoded whole, at most `limit` bytes declared and at most 200:1
    /// declared, checked to its end (the CRC included for a stored one).
    pub fn preview(
        &self,
        source: &dyn RangeRead,
        index: u32,
        limit: u64,
        password: Option<&[u8]>,
    ) -> Result<Vec<u8>> {
        let listing = self.listing()?;
        let entry = Self::entry(&listing, index)?;
        if Self::nested(&listing, index) {
            return refused(Refusal::Nested);
        }
        if entry.size > limit {
            return refused(Refusal::TooLarge);
        }
        if declares_too_much(entry.size, entry.packed) {
            return refused(Refusal::Ratio);
        }
        let mut out = Vec::with_capacity(entry.size as usize);
        self.inflate(source, entry, false, password, false, &mut |chunk| {
            out.extend_from_slice(chunk);
            Ok(())
        })?;
        Ok(out)
    }

    /// The rules a preview meets without its size limit, the bytes thrown away (the shared table).
    #[cfg(test)]
    pub fn check(&self, source: &dyn RangeRead, index: u32, password: Option<&[u8]>) -> Result<()> {
        let listing = self.listing()?;
        let entry = Self::entry(&listing, index)?;
        if Self::nested(&listing, index) {
            return refused(Refusal::Nested);
        }
        if declares_too_much(entry.size, entry.packed) {
            return refused(Refusal::Ratio);
        }
        self.inflate(source, entry, false, password, false, &mut |_| Ok(()))
    }

    /// For a download or an export: every piece as it comes, held to the declared size only.
    pub fn download(
        &self,
        source: &dyn RangeRead,
        index: u32,
        password: Option<&[u8]>,
        write: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        let listing = self.listing()?;
        let entry = Self::entry(&listing, index)?;
        self.inflate(source, entry, false, password, false, write)
    }

    /// Tries `password`, on entry `index` first when given (the entry the password was asked for),
    /// then on the locked entries with bytes: first those it may inflate in full (`probes`:
    /// declaring at most 16 MiB, within the declared ratio), smallest first, whose CRC or
    /// authentication code then proves the password; then the rest, to their password check
    /// alone. So when no entry qualifies, the password verifier alone decides (AES's two bytes;
    /// ZipCrypto's one check byte, which passes 1 wrong password in 256: a download then fails its
    /// CRC). An empty ZipCrypto entry proves nothing (its one check byte is all there is), so it
    /// comes last, to that check alone, unless it is the entry asked for; an empty AES entry's
    /// authentication code does prove it. A wrong password ends it; an
    /// entry that fails for another reason (damage, a bad authentication code or CRC, which may be
    /// tampering) says nothing certain of the password, and the next is tried: at most three
    /// entries and 32 MiB read in all, past which a try reads only an entry's password check.
    /// Kept only if it opens one, and never once the archive is closed; the password already held,
    /// accepted again, stays as proven as it was.
    pub fn unlock(&self, source: &dyn RangeRead, password: &[u8], index: Option<u32>) -> Result<bool> {
        let listing = self.listing()?;
        let mut candidates: Vec<&Entry> = listing
            .entries
            .iter()
            .filter(|entry| {
                entry.lock != Lock::None && !entry.directory && !entry.link && support_of(entry) == "ok"
            })
            .collect();
        candidates.sort_by_key(|entry| (!proves(entry), !probes(entry), entry.packed, entry.index));
        if let Some(first) = index.and_then(|index| candidates.iter().position(|entry| entry.index == index))
        {
            let entry = candidates.remove(first);
            candidates.insert(0, entry);
        }
        let mut read = 0u64;
        for entry in candidates.into_iter().take(UNLOCK_ENTRIES_MAX) {
            if self.is_closed() {
                return Err(closed_error());
            }
            let check_only = !proves(entry) || !probes(entry) || read + entry.packed > UNLOCK_READ_MAX;
            if !check_only {
                read += entry.packed;
            }
            let outcome = self.inflate(source, entry, false, Some(password), check_only, &mut |_| Ok(()));
            match outcome {
                Ok(()) => {
                    let life = lock(&self.life);
                    if life.closed {
                        return Err(closed_error());
                    }
                    let mut held = lock(&self.held);
                    let again = held.password.as_deref().map(Vec::as_slice) == Some(password);
                    held.proven = (again && held.proven) || !check_only;
                    held.password = Some(Zeroizing::new(password.to_vec()));
                    return Ok(true);
                }
                // Only the password check says the password is wrong; a bad code or CRC may be tampering.
                Err(ArchiveError::Refused { code }) if code == "wrong-password" => return Ok(false),
                Err(ArchiveError::Refused { .. }) => continue,
                Err(error) => return Err(error),
            }
        }
        Ok(false)
    }

    /// The same listing and password, open on its own: closing one doesn't close the other.
    pub fn sibling(&self) -> Result<Zip> {
        let listing = self.listing()?;
        let life = lock(&self.life);
        if life.closed {
            return Err(closed_error());
        }
        Ok(Zip {
            listing: Mutex::new(Some(listing)),
            // A sibling reads entries, never lists: its app has the folders already.
            folders: Mutex::new(None),
            life: Mutex::new(Lifecycle::default()),
            held: self.held.clone(),
            sibling: true,
            closed: std::sync::atomic::AtomicBool::new(false),
        })
    }

    /*
     * After a call on entry `index` read with `used`: a locked entry that read as damaged (its
     * stream, size, CRC or AES code) under a password only its verifier passed lets that password
     * go, on this archive and its siblings, and says so (`password-unproven`), so it is asked for
     * again rather than every locked entry reading as damaged. The same password damaged again on
     * the same entry is kept, and the damage said: that entry can't prove it. The caller keeps a
     * stop (a cancel, the watchdog, a close) away from here: it is no damage.
     */
    pub fn unproven<T>(&self, index: u32, used: Option<&[u8]>, result: Result<T>) -> Result<T> {
        let Err(ArchiveError::Refused { code }) = &result else { return result };
        let damaged = matches!(code.as_str(), "damaged" | "size" | "short" | "crc" | "auth");
        let locked = self
            .listing()
            .ok()
            .and_then(|listing| listing.entries.get(index as usize).map(|entry| entry.lock != Lock::None))
            .unwrap_or(false);
        let (Some(used), true, true) = (used, damaged, locked) else { return result };
        let mut held = lock(&self.held);
        if held.proven
            || held.password.as_deref().map(Vec::as_slice) != Some(used)
            || held.failed.get(&index).map(|failed| failed.as_slice()) == Some(used)
        {
            return result;
        }
        held.password = None;
        held.failed.insert(index, Zeroizing::new(used.to_vec()));
        refused(Refusal::PasswordUnproven)
    }

    pub fn password(&self) -> Option<Zeroizing<Vec<u8>>> {
        lock(&self.held).password.clone()
    }

    /// Closes the archive: the password wiped, the listing dropped, every later call refused.
    /// Never waits on a read in flight: that read stops at its next piece.
    pub fn close(&self) {
        {
            let mut life = lock(&self.life);
            life.closed = true;
            if !self.sibling {
                *lock(&self.held) = Held::default();
            }
        }
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        lock(&self.listing).take();
        lock(&self.folders).take();
    }
}

// ---------------------------------------------------------------------------
// For the apps
// ---------------------------------------------------------------------------

/// Where an entry being downloaded or exported goes, a piece at a time: the app's own export path.
#[cfg_attr(feature = "uniffi", uniffi::export(with_foreign))]
pub trait EntrySink: Send + Sync {
    fn write(&self, chunk: Vec<u8>) -> std::result::Result<(), FetchError>;
}

/// A zip open in a phone's viewer. One reader over the version serves every call, re-armed with
/// each call's `RunControl` (the app's cancel and watchdog), so the archive's last chunk and the
/// padding after it are fetched once for the session, not once a call. Browsing is a viewer, not
/// a run: the app does not hold the one-run slot for it. `close_archive` (or dropping it) wipes
/// the password, the reader's chunks and key, and the listing; every later call fails.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct ZipArchiveSession {
    zip: Zip,
    reader: Mutex<Option<Backing>>,
    /* One call at a time over the one reader. */
    turn: Mutex<()>,
}

impl std::fmt::Debug for ZipArchiveSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ZipArchiveSession").field("closed", &self.zip.is_closed()).finish()
    }
}

/// The bytes of a zip this phone keeps (an offline copy), by range: read from where the app keeps
/// it, into memory, a range at a time. No key and no network; nothing is written.
#[cfg_attr(feature = "uniffi", uniffi::export(with_foreign))]
pub trait LocalSource: Send + Sync {
    fn size(&self) -> u64;
    fn read_at(&self, offset: u64, length: u64) -> std::result::Result<Vec<u8>, FetchError>;
}

/* Where a session reads: a version through the core's reader, or a copy the phone keeps. */
#[derive(Clone)]
enum Backing {
    Version(Arc<VersionReader>),
    Local(Arc<dyn LocalSource>),
}

/* A kept copy under one call's control: every read first checks the call has not ended. */
struct LocalRead {
    source: Arc<dyn LocalSource>,
    control: Arc<RunControl>,
}

impl RangeRead for LocalRead {
    fn size(&self) -> u64 {
        self.source.size()
    }
    fn progress(&self) -> Result<()> {
        Ok(self.control.progress()?)
    }
    fn read_at(&self, offset: u64, length: u64) -> Result<Vec<u8>> {
        self.control.check()?;
        let end = offset.saturating_add(length).min(self.source.size());
        if end <= offset {
            return Ok(Vec::new());
        }
        let bytes = self
            .source
            .read_at(offset, end - offset)
            .map_err(|FetchError::Failed { reason }| ArchiveError::Failed { reason })?;
        if bytes.len() as u64 != end - offset {
            return refused(Refusal::Damaged);
        }
        Ok(bytes)
    }
}

impl ZipArchiveSession {
    /* The session's reader for this call (a version's re-armed with its control); refused once closed. */
    fn reader(&self, control: &Arc<RunControl>) -> Result<Box<dyn RangeRead>> {
        match lock(&self.reader).clone().ok_or_else(closed_error)? {
            Backing::Version(reader) => {
                reader.rearm(control.clone());
                Ok(Box::new(VersionSource(reader)))
            }
            Backing::Local(source) => Ok(Box::new(LocalRead { source, control: control.clone() })),
        }
    }

    /*
     * A preview's or download's result: a stop (the app's cancel, the watchdog, a close) said as
     * itself, never as damage that lets the password go; anything else judged by `Zip::unproven`.
     * A failed write (the sink's) is `Failed`, never a refusal, so it never reaches that either.
     */
    fn judged<T>(
        &self,
        index: u32,
        used: Option<&[u8]>,
        control: &RunControl,
        result: Result<T>,
    ) -> Result<T> {
        if result.is_err() {
            if self.zip.is_closed() {
                return Err(closed_error());
            }
            control.check()?;
        }
        self.after(self.zip.unproven(index, used, result))
    }

    /* A call's failure, said as the close when the archive closed under it. */
    fn after<T>(&self, result: Result<T>) -> Result<T> {
        match result {
            Err(_) if self.zip.is_closed() => Err(closed_error()),
            other => other,
        }
    }
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl ZipArchiveSession {
    /// Reads the archive's directory under `control`, with every cap and refusal of section 3.
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn open(
        source: Arc<dyn ObjectSource>,
        content: Content,
        control: Arc<RunControl>,
    ) -> Result<Arc<Self>> {
        let reader = VersionReader::open_session(source, content)?;
        reader.rearm(control.clone());
        let zip = Zip::open(&VersionSource(reader.clone()));
        let zip = match zip {
            Ok(zip) => zip,
            Err(error) => {
                reader.wipe();
                return Err(error);
            }
        };
        control.check()?;
        Ok(Arc::new(ZipArchiveSession {
            zip,
            reader: Mutex::new(Some(Backing::Version(reader))),
            turn: Mutex::new(()),
        }))
    }

    /// The same, over a copy of the zip this phone keeps (offline): read by range from it, into
    /// memory, so a kept zip opens without a connection and without another plaintext copy.
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn open_local(source: Arc<dyn LocalSource>, control: Arc<RunControl>) -> Result<Arc<Self>> {
        let zip = Zip::open(&LocalRead { source: source.clone(), control: control.clone() })?;
        control.check()?;
        Ok(Arc::new(ZipArchiveSession {
            zip,
            reader: Mutex::new(Some(Backing::Local(source))),
            turn: Mutex::new(()),
        }))
    }

    /// The list; empty once closed.
    pub fn entries(&self) -> Vec<ArchiveEntry> {
        self.zip.listing().map(|listing| listing.listed.clone()).unwrap_or_default()
    }

    /// The list's folders (`ArchiveEntry::folder`), handed over once: the session keeps none, since
    /// nothing it does reads them, so they are held once, by the app. Later calls, and calls once
    /// closed, return none.
    pub fn take_folders(&self) -> ArchiveFolders {
        if self.zip.is_closed() {
            return ArchiveFolders::default();
        }
        self.zip.take_folders()
    }

    /// Mac resource files left out of the list.
    pub fn hidden(&self) -> u32 {
        self.zip.hidden()
    }

    /// Whether a password is held.
    pub fn unlocked(&self) -> bool {
        self.zip.password().is_some()
    }

    /// Whether `password` opens the archive's locked entries, tried on entry `index` first when
    /// given; held, in memory, if it does.
    pub fn unlock(&self, password: String, index: Option<u32>, control: Arc<RunControl>) -> Result<bool> {
        let _turn = lock(&self.turn);
        let password = Zeroizing::new(password.into_bytes());
        let result =
            self.reader(&control).and_then(|source| self.zip.unlock(source.as_ref(), &password, index));
        let opened = self.after(result)?;
        control.check()?;
        Ok(opened)
    }

    /// For the viewer: the entry's bytes, at most `limit` declared, checked to the end. Kept in
    /// memory by the app, never written to a file.
    pub fn preview(&self, index: u32, limit: u64, control: Arc<RunControl>) -> Result<Vec<u8>> {
        let _turn = lock(&self.turn);
        let password = self.zip.password();
        let used = password.as_deref().map(Vec::as_slice);
        let result =
            self.reader(&control).and_then(|source| self.zip.preview(source.as_ref(), index, limit, used));
        let bytes = self.judged(index, used, &control, result)?;
        control.check()?;
        Ok(bytes)
    }

    /// The entry into `sink`, a MiB at a time, held to its declared size.
    pub fn download(&self, index: u32, sink: Arc<dyn EntrySink>, control: Arc<RunControl>) -> Result<()> {
        let _turn = lock(&self.turn);
        let password = self.zip.password();
        let mut pending: Vec<u8> = Vec::with_capacity(CHUNK_BYTES);
        let flush = |pending: &mut Vec<u8>| -> Result<()> {
            if pending.is_empty() {
                return Ok(());
            }
            control.progress()?;
            // A wait on the app's destination (a slow disk, a provider over the network): the
            // watchdog's clock stops for it, as for a fetch. A cancel meanwhile ends it the
            // moment the write returns.
            let written = {
                let _waiting = control.hold();
                sink.write(std::mem::take(pending))
            };
            written.map_err(|FetchError::Failed { reason }| ArchiveError::Failed { reason })?;
            control.progress()?;
            Ok(())
        };
        let used = password.as_deref().map(Vec::as_slice);
        let result = self.reader(&control).and_then(|source| {
            self.zip.download(source.as_ref(), index, used, &mut |chunk| {
                pending.extend_from_slice(chunk);
                if pending.len() >= CHUNK_BYTES {
                    flush(&mut pending)?;
                }
                Ok(())
            })
        });
        self.judged(index, used, &control, result)?;
        flush(&mut pending)?;
        control.check()?;
        Ok(())
    }

    /// The same archive, open a second time with the listing and the password it holds and a
    /// reader of its own, so a long call (a download) on one doesn't hold up the other's (a
    /// preview). Each is closed on its own, and sign-out must close both.
    pub fn sibling(&self) -> Result<Arc<Self>> {
        let zip = self.zip.sibling()?;
        let backing = match lock(&self.reader).clone().ok_or_else(closed_error)? {
            Backing::Version(reader) => Backing::Version(reader.sibling()?),
            Backing::Local(source) => Backing::Local(source),
        };
        Ok(Arc::new(ZipArchiveSession { zip, reader: Mutex::new(Some(backing)), turn: Mutex::new(()) }))
    }

    /// Closes the archive: the password wiped, the reader's chunks and key dropped, the listing
    /// gone; every later call fails. Never waits on a call in flight, which stops at its next read.
    /// Not `close`: Kotlin's bindings make every object `AutoCloseable`, whose `close()` that would clash with.
    pub fn close_archive(&self) {
        self.zip.close();
        if let Some(Backing::Version(reader)) = lock(&self.reader).take() {
            reader.wipe();
        }
    }
}

impl Drop for ZipArchiveSession {
    fn drop(&mut self) {
        self.close_archive();
    }
}

#[cfg(test)]
mod tests;
