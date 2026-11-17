//! Browsing zip archives in the phone apps (docs/file-tools-design.md, section 1 (a) and
//! section 6): the list of what is inside, read from the central directory alone, and an entry's
//! bytes, read through the `zip` crate. The web's twin is `apps/web/src/lib/archives/zip-format.ts`
//! (the rules) with zip.js (the data); both are held to `e2e/fixtures/archives/expected.json`, so a
//! change to one is a change to both.
//!
//! The directory parser is strict on purpose. Archives come from anyone, and two readers that see
//! different files in one archive is an attack of its own, so anything ambiguous is refused rather
//! than reconciled. The `zip` crate parses the directory a second time, once, when the first entry
//! is opened; every entry it reads is first checked against this listing (offset, sizes, name).
//!
//! Every limit is enforced on the bytes as they are produced: an entry stops at the byte past its
//! declared size, a preview at 200 times the compressed bytes read once 1 MiB has come out, and the
//! CRC or the AES authentication code is checked at the end. A password the person typed is held
//! by the open archive, in memory, and wiped when it is closed or dropped.

use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::{Arc, Mutex, MutexGuard};

use zeroize::Zeroizing;

use crate::tools::{FetchError, ObjectSource, RunControl, VersionReader};
use crate::{Content, CoreError};

const MIB: u64 = 1024 * 1024;
/// The largest central directory read.
pub const ZIP_DIRECTORY_MAX_BYTES: u64 = 64 * MIB;
/// The most entries listed.
pub const ZIP_ENTRIES_MAX: u64 = 100_000;
const RATIO: u64 = 200;
const RATIO_FROM: u64 = MIB;
const ASK_ABOVE: u64 = 4 * 1024 * MIB;
/// An unlock decrypts the smallest locked entry in full when it is at most this large.
const UNLOCK_CHECK_BYTES: u64 = 16 * MIB;
/// Whether this build decodes Deflate64 (method 9): the `zip` crate's `deflate64` feature does, as zip.js does on the web.
const DEFLATE64: bool = true;
/// How much of a download is handed to the app at a time.
const CHUNK_BYTES: usize = 1024 * 1024;

const SIG_EOCD: u32 = 0x0605_4b50;
const SIG_ZIP64_EOCD: u32 = 0x0606_4b50;
const SIG_ZIP64_LOCATOR: u32 = 0x0706_4b50;
const SIG_CENTRAL: u32 = 0x0201_4b50;
const SIG_LOCAL: u32 = 0x0403_4b50;
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
    Crc,
    Auth,
    Size,
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
            Refusal::Crc => "crc",
            Refusal::Auth => "auth",
            Refusal::Size => "size",
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
    if sentinel && locator.is_none() {
        return refused(Refusal::Damaged);
    }
    if !sentinel && (disk != 0 || directory_disk != 0) {
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
    if count > ZIP_ENTRIES_MAX {
        return refused(Refusal::TooManyEntries);
    }
    if directory_size > ZIP_DIRECTORY_MAX_BYTES {
        return refused(Refusal::DirectoryTooLarge);
    }
    if directory_offset + directory_size != end {
        return refused(Refusal::Damaged);
    }
    if count * CENTRAL_LENGTH as u64 > directory_size {
        return refused(Refusal::Damaged);
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
    /* The real method inside WinZip AES. */
    pub aes_method: Option<u16>,
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
    if header.len() < LOCAL_LENGTH + name_length + extra_length {
        return refused(Refusal::Damaged);
    }
    if header[LOCAL_LENGTH..LOCAL_LENGTH + name_length] != entry.raw[..] {
        return refused(Refusal::Local);
    }
    if method != entry.method as u64 || (flags & 1) != (entry.flags as u64 & 1) {
        return refused(Refusal::Local);
    }
    let fields = extra_fields(&header[LOCAL_LENGTH + name_length..LOCAL_LENGTH + name_length + extra_length]);
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
    let start = entry.offset + (LOCAL_LENGTH + name_length + extra_length) as u64;
    if start + entry.packed + if descriptor { 12 } else { 0 } > entry.bound {
        return refused(Refusal::Overlap);
    }
    Ok(start)
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
    /// Its folders and name for the list: `/` and `\` both separate; empty and `.` parts are dropped.
    pub parts: Vec<String>,
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
}

const ARCHIVE_EXTENSIONS: &[&str] = &[
    "zip", "zipx", "jar", "war", "ear", "apk", "aab", "ipa", "xpi", "7z", "rar", "tar", "gz", "tgz", "bz2",
    "tbz", "tbz2", "xz", "txz", "zst", "tzst", "lz", "lzma", "z", "cab", "iso", "dmg",
];

pub(crate) fn path_parts(path: &str) -> Vec<String> {
    path.split(['/', '\\']).filter(|part| !part.is_empty() && *part != ".").map(str::to_owned).collect()
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

pub(crate) fn list_entries(entries: &[Entry]) -> Vec<ArchiveEntry> {
    let mut listed: Vec<ArchiveEntry> = entries
        .iter()
        .map(|entry| {
            let mut parts = path_parts(&entry.path);
            if parts.is_empty() && !entry.directory {
                parts = vec![if entry.path.is_empty() { "_".into() } else { entry.path.clone() }];
            }
            let name = parts.last().cloned().unwrap_or_default();
            let link = entry.link && !entry.directory;
            ArchiveEntry {
                index: entry.index,
                path: entry.path.clone(),
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
                hidden: false,
                stored: !entry.directory && !entry.link && entry.method == 0 && entry.lock == Lock::None,
                parts,
            }
        })
        .collect();
    let mut known = HashSet::new();
    for item in &listed {
        for depth in 1..=item.parts.len() {
            known.insert(item.parts[..depth].join("/"));
        }
    }
    for item in &mut listed {
        if item.parts.first().map(String::as_str) == Some("__MACOSX") {
            item.hidden = true;
            continue;
        }
        if let Some(name) = item.parts.last() {
            if !item.directory && name.starts_with("._") && name.chars().count() > 2 {
                let mut twin = item.parts[..item.parts.len() - 1].to_vec();
                twin.push(name[2..].to_owned());
                if known.contains(&twin.join("/")) {
                    item.hidden = true;
                }
            }
        }
    }
    listed.retain(|item| !item.parts.is_empty() || !item.directory);
    listed
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
    pub fn finish(&self) -> std::result::Result<(), Refusal> {
        if self.produced != self.declared {
            return Err(Refusal::Size);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// The `zip` crate's view, over whichever source the current read uses
// ---------------------------------------------------------------------------

struct Tally {
    start: u64,
    end: u64,
    consumed: u64,
}

#[derive(Default)]
struct Slot {
    source: Mutex<Option<Arc<dyn RangeRead>>>,
    tally: Mutex<Option<Tally>>,
    size: u64,
}

/// A `Read + Seek` the `zip` crate parses once and every later read reuses, reading from the
/// source the current operation set (each operation of the phones has a reader of its own).
#[derive(Clone)]
struct SlotReader {
    slot: Arc<Slot>,
    position: u64,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Read for SlotReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let source = lock(&self.slot.source).clone().ok_or_else(|| io::Error::other("closed"))?;
        let want = (buf.len() as u64).min(CHUNK_BYTES as u64);
        let bytes = source.read_at(self.position, want).map_err(io::Error::other)?;
        buf[..bytes.len()].copy_from_slice(&bytes);
        if let Some(tally) = lock(&self.slot.tally).as_mut() {
            let end = self.position + bytes.len() as u64;
            let overlap = end.min(tally.end).saturating_sub(self.position.max(tally.start));
            tally.consumed += overlap;
        }
        self.position += bytes.len() as u64;
        Ok(bytes.len())
    }
}

impl Seek for SlotReader {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let target = match from {
            SeekFrom::Start(at) => at as i128,
            SeekFrom::End(delta) => self.slot.size as i128 + delta as i128,
            SeekFrom::Current(delta) => self.position as i128 + delta as i128,
        };
        if target < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "seek before the start"));
        }
        self.position = target as u64;
        Ok(self.position)
    }
}

fn refusal_of(error: &zip::result::ZipError) -> Refusal {
    use zip::result::ZipError;
    match error {
        ZipError::InvalidPassword => Refusal::WrongPassword,
        ZipError::UnsupportedArchive(message) if *message == ZipError::PASSWORD_REQUIRED => Refusal::Password,
        ZipError::CompressionMethodNotSupported(_) => Refusal::Method,
        ZipError::Io(io) => io_refusal(io),
        _ => Refusal::Damaged,
    }
}

fn io_refusal(error: &io::Error) -> Refusal {
    let text = error.to_string();
    if text.contains("Invalid checksum") {
        Refusal::Crc
    } else if text.contains("Invalid authentication code") {
        Refusal::Auth
    } else if text.contains("larger than its declared uncompressed size") {
        // The crate's own cap at the declared size, met before the counter's: the same refusal.
        Refusal::Size
    } else {
        Refusal::Damaged
    }
}

/* The `zip` crate's archive, and its entries' indexes by local header offset. */
type Engine = (zip::ZipArchive<SlotReader>, HashMap<u64, usize>);

/// An open archive: its listing, the `zip` crate's view once an entry has been opened, and the
/// password while one is held.
pub(crate) struct Zip {
    entries: Vec<Entry>,
    listed: Vec<ArchiveEntry>,
    slot: Arc<Slot>,
    /* The `zip` crate's view, and its index of each entry by where its local header starts. */
    engine: Mutex<Option<Engine>>,
    password: Mutex<Option<Zeroizing<Vec<u8>>>>,
}

/* Where a source the current operation set is cleared again, whatever happens. */
struct Using<'a>(&'a Slot);

impl Drop for Using<'_> {
    fn drop(&mut self) {
        lock(&self.0.source).take();
        lock(&self.0.tally).take();
    }
}

impl Zip {
    pub fn open(source: &dyn RangeRead) -> Result<Zip> {
        let directory = find_directory(source)?;
        let bytes = source.read_at(directory.offset, directory.size)?;
        let entries = read_directory(&bytes, &directory)?;
        let listed = list_entries(&entries);
        Ok(Zip {
            entries,
            listed,
            slot: Arc::new(Slot { size: source.size(), ..Default::default() }),
            engine: Mutex::new(None),
            password: Mutex::new(None),
        })
    }

    pub fn hidden(&self) -> u32 {
        self.listed.iter().filter(|item| item.hidden && !item.directory).count() as u32
    }

    fn listed_of(&self, index: u32) -> Option<&ArchiveEntry> {
        self.listed.iter().find(|item| item.index == index)
    }

    fn entry(&self, index: u32) -> Result<&Entry> {
        let Some(entry) = self.entries.get(index as usize) else { return refused(Refusal::Damaged) };
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

    fn use_source(&self, source: Arc<dyn RangeRead>) -> Using<'_> {
        *lock(&self.slot.source) = Some(source);
        Using(&self.slot)
    }

    /// The entry's bytes through `write`, each piece counted; the CRC or authentication code
    /// checked at the end (by the `zip` crate). `ratio` holds a preview to 200:1 after 1 MiB.
    fn inflate(
        &self,
        source: Arc<dyn RangeRead>,
        entry: &Entry,
        ratio: bool,
        password: Option<&[u8]>,
        write: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        let _using = self.use_source(source.clone());
        let header = source.read_at(entry.offset, local_header_read(entry))?;
        let start = check_local_header(entry, &header)?;
        if entry.lock != Lock::None && password.is_none() {
            return refused(Refusal::Password);
        }
        let mut engine = lock(&self.engine);
        if engine.is_none() {
            let reader = SlotReader { slot: self.slot.clone(), position: 0 };
            let config = zip::read::Config { archive_offset: zip::read::ArchiveOffset::Known(0) };
            let archive = zip::ZipArchive::with_config(config, reader).map_err(|_| Refusal::Damaged)?;
            // By where each local header starts: the crate keys its own index by name, and a name
            // it took from a Unicode path field, or one that two entries share, isn't ours.
            let mut by_offset = HashMap::new();
            for i in 0..archive.len() {
                let data = archive.by_index_data(i).map_err(|_| Refusal::Damaged)?;
                by_offset.insert(data.header_start(), i);
            }
            *engine = Some((archive, by_offset));
        }
        let (archive, by_offset) = engine.as_mut().unwrap();
        let found = *by_offset.get(&entry.offset).ok_or(Refusal::Damaged)?;
        {
            let data = archive.by_index_data(found).map_err(|_| Refusal::Damaged)?;
            if data.header_start() != entry.offset
                || data.compressed_size() != entry.packed
                || data.size() != entry.size
                || data.encrypted() != (entry.lock != Lock::None)
            {
                return refused(Refusal::Damaged);
            }
        }
        *lock(&self.slot.tally) = Some(Tally { start, end: start + entry.packed, consumed: 0 });
        let options = zip::read::ZipReadOptions::new().password(password);
        let mut file = archive.by_index_with_options(found, options).map_err(|error| refusal_of(&error))?;
        let mut counter = InflateCounter::new(entry.size, ratio);
        let mut buffer = Zeroizing::new(vec![0u8; 256 * 1024]);
        loop {
            let read = match file.read(&mut buffer) {
                Ok(read) => read,
                Err(error) => {
                    // A failure of the read underneath (a cancel, the network) is that failure, in its words.
                    if let Some(inner) =
                        error.get_ref().and_then(|inner| inner.downcast_ref::<ArchiveError>())
                    {
                        return Err(inner.clone());
                    }
                    if let Some(zip) =
                        error.get_ref().and_then(|inner| inner.downcast_ref::<zip::result::ZipError>())
                    {
                        return refused(refusal_of(zip));
                    }
                    return refused(io_refusal(&error));
                }
            };
            if read == 0 {
                break;
            }
            let consumed = lock(&self.slot.tally).as_ref().map_or(0, |tally| tally.consumed);
            counter.consumed = consumed;
            counter.wrote(read as u64)?;
            write(&buffer[..read])?;
        }
        counter.finish()?;
        Ok(())
    }

    /// For the viewer: the entry inflated whole, at most `limit` bytes declared, under the ratio,
    /// checked to the end.
    pub fn preview(
        &self,
        source: Arc<dyn RangeRead>,
        index: u32,
        limit: u64,
        password: Option<&[u8]>,
    ) -> Result<Vec<u8>> {
        let entry = self.entry(index)?;
        if self.listed_of(index).is_some_and(|item| item.nested) {
            return refused(Refusal::Nested);
        }
        if entry.size > limit {
            return refused(Refusal::TooLarge);
        }
        let mut out = Vec::with_capacity(entry.size as usize);
        self.inflate(source, entry, true, password, &mut |chunk| {
            out.extend_from_slice(chunk);
            Ok(())
        })?;
        Ok(out)
    }

    /// The rules a preview meets without its size limit, the bytes thrown away (the shared table).
    #[cfg(test)]
    pub fn check(&self, source: Arc<dyn RangeRead>, index: u32, password: Option<&[u8]>) -> Result<()> {
        let entry = self.entry(index)?;
        if self.listed_of(index).is_some_and(|item| item.nested) {
            return refused(Refusal::Nested);
        }
        self.inflate(source, entry, true, password, &mut |_| Ok(()))
    }

    /// For a download or an export: every piece as it comes, held to the declared size only.
    pub fn download(
        &self,
        source: Arc<dyn RangeRead>,
        index: u32,
        password: Option<&[u8]>,
        write: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        let entry = self.entry(index)?;
        self.inflate(source, entry, false, password, write)
    }

    /// Tries `password` on the smallest locked entry that can be read (in full up to 16 MiB); kept only if it opens.
    pub fn unlock(&self, source: Arc<dyn RangeRead>, password: &[u8]) -> Result<bool> {
        let Some(entry) = self
            .entries
            .iter()
            .filter(|entry| {
                entry.lock != Lock::None && !entry.directory && !entry.link && support_of(entry) == "ok"
            })
            .min_by_key(|entry| entry.packed)
        else {
            return Ok(false);
        };
        let outcome = if entry.packed <= UNLOCK_CHECK_BYTES {
            self.inflate(source, entry, true, Some(password), &mut |_| Ok(()))
        } else {
            // Only the password check at the start of its data: open it, read one piece.
            let mut first = true;
            self.inflate(source, entry, false, Some(password), &mut |_| {
                if first {
                    first = false;
                    Err(ArchiveError::Refused { code: "checked".into() })
                } else {
                    Ok(())
                }
            })
            .or_else(|error| match &error {
                ArchiveError::Refused { code } if code == "checked" => Ok(()),
                _ => Err(error),
            })
        };
        match outcome {
            Ok(()) => {
                *lock(&self.password) = Some(Zeroizing::new(password.to_vec()));
                Ok(true)
            }
            Err(ArchiveError::Refused { code }) => {
                if ["wrong-password", "auth", "crc", "damaged", "size", "ratio"].contains(&code.as_str()) {
                    Ok(false)
                } else {
                    Err(ArchiveError::Refused { code })
                }
            }
            Err(error) => Err(error),
        }
    }

    pub fn password(&self) -> Option<Zeroizing<Vec<u8>>> {
        lock(&self.password).clone()
    }

    pub fn close(&self) {
        lock(&self.password).take();
        lock(&self.engine).take();
        lock(&self.slot.source).take();
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

/// A zip open in a phone's viewer. Each call reads under the `RunControl` it is given (the app's
/// cancel and watchdog), through a reader of its own over the version, which the control wipes
/// when the call's run finishes; the listing is kept. Browsing is a viewer, not a run: the app
/// does not hold the one-run slot for it. `close` (or dropping it) wipes the password.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct ZipArchiveSession {
    source: Arc<dyn ObjectSource>,
    content: Content,
    zip: Zip,
    /* One call at a time: the `zip` crate's view reads through one slot. */
    turn: Mutex<()>,
}

impl std::fmt::Debug for ZipArchiveSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ZipArchiveSession").field("entries", &self.zip.entries.len()).finish()
    }
}

impl ZipArchiveSession {
    fn reader(&self, control: &Arc<RunControl>) -> Result<Arc<dyn RangeRead>> {
        let reader = VersionReader::open(self.source.clone(), self.content.clone(), Some(control.clone()))?;
        Ok(Arc::new(VersionSource(reader)))
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
        let reader = VersionReader::open(source.clone(), content.clone(), Some(control.clone()))?;
        let zip = Zip::open(&VersionSource(reader))?;
        control.check()?;
        Ok(Arc::new(ZipArchiveSession { source, content, zip, turn: Mutex::new(()) }))
    }

    pub fn entries(&self) -> Vec<ArchiveEntry> {
        self.zip.listed.clone()
    }

    /// Mac resource files left out of the list.
    pub fn hidden(&self) -> u32 {
        self.zip.hidden()
    }

    /// Whether a password is held.
    pub fn unlocked(&self) -> bool {
        self.zip.password().is_some()
    }

    /// Whether `password` opens the archive's locked entries; held, in memory, if it does.
    pub fn unlock(&self, password: String, control: Arc<RunControl>) -> Result<bool> {
        let _turn = lock(&self.turn);
        let password = Zeroizing::new(password.into_bytes());
        let opened = self.zip.unlock(self.reader(&control)?, &password)?;
        control.check()?;
        Ok(opened)
    }

    /// For the viewer: the entry's bytes, at most `limit` declared, checked to the end. Kept in
    /// memory by the app, never written to a file.
    pub fn preview(&self, index: u32, limit: u64, control: Arc<RunControl>) -> Result<Vec<u8>> {
        let _turn = lock(&self.turn);
        let password = self.zip.password();
        let bytes =
            self.zip.preview(self.reader(&control)?, index, limit, password.as_deref().map(Vec::as_slice))?;
        control.check()?;
        Ok(bytes)
    }

    /// The entry into `sink`, a MiB at a time, held to its declared size.
    pub fn download(&self, index: u32, sink: Arc<dyn EntrySink>, control: Arc<RunControl>) -> Result<()> {
        let _turn = lock(&self.turn);
        let password = self.zip.password();
        let mut pending: Vec<u8> = Vec::with_capacity(CHUNK_BYTES);
        let control_for_write = control.clone();
        let flush = |pending: &mut Vec<u8>| -> Result<()> {
            if pending.is_empty() {
                return Ok(());
            }
            control_for_write.progress()?;
            sink.write(std::mem::take(pending))
                .map_err(|FetchError::Failed { reason }| ArchiveError::Failed { reason })
        };
        self.zip.download(
            self.reader(&control)?,
            index,
            password.as_deref().map(Vec::as_slice),
            &mut |chunk| {
                pending.extend_from_slice(chunk);
                if pending.len() >= CHUNK_BYTES {
                    flush(&mut pending)?;
                }
                Ok(())
            },
        )?;
        flush(&mut pending)?;
        control.check()?;
        Ok(())
    }

    /// Wipes the password and lets go of the `zip` crate's view. Not `close`: Kotlin's bindings
    /// make every object `AutoCloseable`, whose `close()` that would clash with.
    pub fn close_archive(&self) {
        self.zip.close();
    }
}

impl Drop for ZipArchiveSession {
    fn drop(&mut self) {
        self.zip.close();
    }
}

#[cfg(test)]
mod tests;
