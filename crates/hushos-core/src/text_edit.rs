//! Which files the phones' text editor opens, whether it may change them, and the
//! bytes a save writes: the twin of `apps/web/src/lib/text-edit.ts`
//! (docs/editing-design.md section 1, Editing 1a and 1b). An edit is saved byte
//! for byte except for what the person changed, so a file opens for editing only
//! when the editor can write it back in its own encoding, byte order mark and line
//! endings: UTF-8 with or without a byte order mark, or UTF-16 either way with
//! one; lines ending in LF or CRLF (a file mixing them keeps the majority on an
//! edit); text rather than binary. Anything else opens read-only, never
//! transcoded. All twins are held to `fixtures/text-edit-cases.json`.

/// The largest file the editor opens for editing (the web's text preview limit, 8 MiB).
pub const TEXT_EDIT_LIMIT: u64 = 8 * 1024 * 1024;

/// How much of the start the viewer's text sniff looks at for control characters.
const SNIFF_BYTES: usize = 8 * 1024;

const UTF8_BOM: [u8; 3] = [0xef, 0xbb, 0xbf];
const UTF16_LE_BOM: [u8; 2] = [0xff, 0xfe];
const UTF16_BE_BOM: [u8; 2] = [0xfe, 0xff];

/// Why a text file opens read-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum TextReadOnly {
    /// Past the 8 MiB limit.
    TooLarge,
    /// Not UTF-8 or UTF-16 with a byte order mark (Latin-1, UTF-16 without one,
    /// invalid sequences): editing would change bytes nobody touched.
    Encoding,
    /// A NUL, or more than 2% control characters in the first 8 KiB.
    Binary,
    /// A carriage return on its own (classic Mac line endings).
    LineEndings,
}

/// How a file's text is written: the encoding and its byte order mark.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum TextEncoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
}

/// The line break a save writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum LineEnding {
    Lf,
    Crlf,
}

/// What an editable file is: its encoding, the line break a save writes (the
/// majority when it mixes them, the first one's on a tie, LF when it has none),
/// and whether it mixes LF and CRLF (the editor says so: an edit rewrites the
/// minority).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct TextFormat {
    pub encoding: TextEncoding,
    pub line_ending: LineEnding,
    pub mixed: bool,
}

/// A file as the editor opens it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum TextOpened {
    /// `text`: without the byte order mark, every line break as LF.
    Editable { format: TextFormat, text: String },
    /// `text`: the words to show where they decode (never past the limit, never
    /// binary, never a guess at another encoding), never saved.
    ReadOnly { reason: TextReadOnly, text: Option<String> },
}

/// The largest file the editor opens for editing, in bytes.
///
/// ```
/// assert_eq!(hushos_core::text_edit_limit(), 8 * 1024 * 1024);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn text_edit_limit() -> u64 {
    TEXT_EDIT_LIMIT
}

/// Why these bytes can't be edited without changing what the person didn't touch,
/// or `None` when they can (`text_open` says the rest).
///
/// ```
/// use hushos_core::{text_read_only, TextReadOnly};
/// assert_eq!(text_read_only(b"notes\r\n".to_vec()), None);
/// assert_eq!(text_read_only(b"a\rb".to_vec()), Some(TextReadOnly::LineEndings));
/// assert_eq!(text_read_only(vec![0x63, 0x61, 0x66, 0xe9]), Some(TextReadOnly::Encoding));
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn text_read_only(bytes: Vec<u8>) -> Option<TextReadOnly> {
    match open(&bytes) {
        TextOpened::Editable { .. } => None,
        TextOpened::ReadOnly { reason, .. } => Some(reason),
    }
}

/// The bytes as the editor holds them. In this order: the size, the encoding (a
/// UTF-8 or UTF-16 byte order mark, else UTF-8; UTF-16 without one, or bytes that
/// don't decode, are `Encoding`), binary (a NUL anywhere, or more than 2% control
/// characters in the first 8 KiB of the text's bytes, counted in UTF-16 code
/// units for UTF-16), then a lone carriage return anywhere.
///
/// ```
/// use hushos_core::{text_open, LineEnding, TextEncoding, TextOpened};
/// let TextOpened::Editable { format, text } = text_open(vec![0xff, 0xfe, b'a', 0, b'\r', 0, b'\n', 0]) else { panic!() };
/// assert_eq!((format.encoding, format.line_ending, text.as_str()), (TextEncoding::Utf16Le, LineEnding::Crlf, "a\n"));
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn text_open(bytes: Vec<u8>) -> TextOpened {
    open(&bytes)
}

/// What a save writes for `text`, the editor's words, when it opened `original`:
/// `original` itself while the text is still what it opened as (a file opened and
/// saved without an edit is byte for byte the same, a mixed one included);
/// otherwise the text in the file's encoding, with its byte order mark, and every
/// line break (LF, CRLF or a lone CR typed or pasted) as the file's. `None` when
/// `original` isn't editable.
///
/// ```
/// use hushos_core::text_save;
/// let mixed = b"a\r\nb\nc\r\n".to_vec();
/// assert_eq!(text_save(mixed.clone(), "a\nb\nc\n".into()), Some(mixed));
/// assert_eq!(text_save(b"a\r\nb\nc\r\n".to_vec(), "a\nb\nc!\n".into()), Some(b"a\r\nb\r\nc!\r\n".to_vec()));
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn text_save(original: Vec<u8>, text: String) -> Option<Vec<u8>> {
    match open(&original) {
        TextOpened::Editable { text: opened, .. } if opened == text => Some(original),
        TextOpened::Editable { format, .. } => Some(encode(format, &text)),
        TextOpened::ReadOnly { .. } => None,
    }
}

fn open(bytes: &[u8]) -> TextOpened {
    let read_only = |reason, text| TextOpened::ReadOnly { reason, text };
    if bytes.len() as u64 > TEXT_EDIT_LIMIT {
        return read_only(TextReadOnly::TooLarge, None);
    }
    let (encoding, payload) = if let Some(rest) = bytes.strip_prefix(&UTF8_BOM) {
        (TextEncoding::Utf8Bom, rest)
    } else if let Some(rest) = bytes.strip_prefix(&UTF16_LE_BOM) {
        (TextEncoding::Utf16Le, rest)
    } else if let Some(rest) = bytes.strip_prefix(&UTF16_BE_BOM) {
        (TextEncoding::Utf16Be, rest)
    } else {
        (TextEncoding::Utf8, bytes)
    };
    let decoded = match encoding {
        TextEncoding::Utf8 | TextEncoding::Utf8Bom => {
            if encoding == TextEncoding::Utf8 && utf16_without_bom(payload) {
                return read_only(TextReadOnly::Encoding, None);
            }
            match std::str::from_utf8(payload) {
                Ok(text) => text.to_owned(),
                Err(_) => {
                    let shown = String::from_utf8_lossy(payload).into_owned();
                    return read_only(TextReadOnly::Encoding, Some(shown));
                }
            }
        }
        TextEncoding::Utf16Le | TextEncoding::Utf16Be => match decode_utf16(payload, encoding) {
            Some(text) => text,
            None => return read_only(TextReadOnly::Encoding, None),
        },
    };
    if binary(payload, encoding) {
        return read_only(TextReadOnly::Binary, None);
    }
    let Some((line_ending, mixed)) = line_endings(&decoded) else {
        return read_only(TextReadOnly::LineEndings, Some(decoded));
    };
    let text = if decoded.contains('\r') { decoded.replace("\r\n", "\n") } else { decoded };
    TextOpened::Editable { format: TextFormat { encoding, line_ending, mixed }, text }
}

/// UTF-16 code units of `payload`, or `None` for an odd length or a surrogate
/// without its pair.
fn decode_utf16(payload: &[u8], encoding: TextEncoding) -> Option<String> {
    if !payload.len().is_multiple_of(2) {
        return None;
    }
    let units = payload.chunks_exact(2).map(|pair| unit(pair, encoding));
    char::decode_utf16(units).collect::<Result<String, _>>().ok()
}

fn unit(pair: &[u8], encoding: TextEncoding) -> u16 {
    match encoding {
        TextEncoding::Utf16Be => u16::from_be_bytes([pair[0], pair[1]]),
        _ => u16::from_le_bytes([pair[0], pair[1]]),
    }
}

/// UTF-16 that came without a byte order mark: an even length whose NUL bytes in
/// the first 8 KiB all sit on one side of each pair and make up at least half of
/// those pairs (Latin text, whose every other byte is zero). Never transcoded:
/// it says the encoding note rather than "not plain text".
fn utf16_without_bom(bytes: &[u8]) -> bool {
    if bytes.len() < 2 || !bytes.len().is_multiple_of(2) {
        return false;
    }
    let sample = &bytes[..bytes.len().min(SNIFF_BYTES)];
    let (mut even, mut odd) = (0usize, 0usize);
    for (at, byte) in sample.iter().enumerate() {
        if *byte == 0 {
            if at % 2 == 0 {
                even += 1;
            } else {
                odd += 1;
            }
        }
    }
    let pairs = sample.len() / 2;
    (even == 0 && odd * 2 >= pairs) || (odd == 0 && even * 2 >= pairs)
}

fn is_control(value: u32) -> bool {
    value < 32 && !matches!(value, 9 | 10 | 12 | 13)
}

/// The viewer's binary rule on the text's own bytes (after any byte order mark):
/// a NUL anywhere, or control characters in more than 2% of the first 8 KiB, in
/// bytes for UTF-8 and in code units for UTF-16.
fn binary(payload: &[u8], encoding: TextEncoding) -> bool {
    let sample = &payload[..payload.len().min(SNIFF_BYTES)];
    match encoding {
        TextEncoding::Utf8 | TextEncoding::Utf8Bom => {
            if payload.contains(&0) {
                return true;
            }
            let control = sample.iter().filter(|&&b| is_control(u32::from(b))).count();
            // As the web computes it: control / length > 0.02, in whole numbers.
            !sample.is_empty() && control * 50 > sample.len()
        }
        TextEncoding::Utf16Le | TextEncoding::Utf16Be => {
            if payload.chunks_exact(2).any(|pair| unit(pair, encoding) == 0) {
                return true;
            }
            let units = sample.len() / 2;
            let control =
                sample.chunks_exact(2).filter(|pair| is_control(u32::from(unit(pair, encoding)))).count();
            units > 0 && control * 50 > units
        }
    }
}

/// The line break a save writes and whether the file mixes LF and CRLF, or `None`
/// for a carriage return on its own. The majority wins; a tie goes to the first
/// break in the file; no break at all is LF.
fn line_endings(text: &str) -> Option<(LineEnding, bool)> {
    let bytes = text.as_bytes();
    let (mut lf, mut crlf) = (0usize, 0usize);
    let mut first = None;
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'\r' if bytes.get(at + 1) == Some(&b'\n') => {
                crlf += 1;
                first.get_or_insert(LineEnding::Crlf);
                at += 2;
                continue;
            }
            b'\r' => return None,
            b'\n' => {
                lf += 1;
                first.get_or_insert(LineEnding::Lf);
            }
            _ => {}
        }
        at += 1;
    }
    let ending = if crlf > lf {
        LineEnding::Crlf
    } else if lf > crlf {
        LineEnding::Lf
    } else {
        first.unwrap_or(LineEnding::Lf)
    };
    Some((ending, lf > 0 && crlf > 0))
}

/// The editor's text written in `format`: every CRLF, lone CR or LF as the file's
/// line break, then encoded, the byte order mark first.
fn encode(format: TextFormat, text: &str) -> Vec<u8> {
    let ending = match format.line_ending {
        LineEnding::Lf => "\n",
        LineEnding::Crlf => "\r\n",
    };
    let mut lines = String::with_capacity(text.len() + text.len() / 16);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                lines.push_str(ending);
            }
            '\n' => lines.push_str(ending),
            other => lines.push(other),
        }
    }
    match format.encoding {
        TextEncoding::Utf8 => lines.into_bytes(),
        TextEncoding::Utf8Bom => [&UTF8_BOM[..], lines.as_bytes()].concat(),
        TextEncoding::Utf16Le => {
            let mut out = UTF16_LE_BOM.to_vec();
            out.extend(lines.encode_utf16().flat_map(u16::to_le_bytes));
            out
        }
        TextEncoding::Utf16Be => {
            let mut out = UTF16_BE_BOM.to_vec();
            out.extend(lines.encode_utf16().flat_map(u16::to_be_bytes));
            out
        }
    }
}

const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico"];
const VIDEO_EXT: &[&str] = &["mp4", "m4v", "webm", "mov", "ogv"];
const TRANSPORT_STREAM: &[&str] = &["video/mp2t", "video/vnd.dlna.mpeg-tts"];
const AUDIO_EXT: &[&str] = &["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "weba"];
const OFFICE_EXT: &[&str] =
    &["docx", "docm", "dotx", "xlsx", "xlsm", "xls", "ods", "numbers", "csv", "tsv", "pptx", "pptm", "potx"];
const OFFICE_MIME: &[&str] = &[
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "application/vnd.oasis.opendocument.spreadsheet",
    "text/csv",
    "text/tab-separated-values",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];
const ZIP_MIME: &[&str] = &["application/zip", "application/x-zip-compressed"];
const TEXT_MIME: &[&str] = &[
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-sh",
    "application/toml",
    "application/yaml",
];
const TEXT_EXT: &[&str] = &[
    "txt",
    "md",
    "markdown",
    "json",
    "csv",
    "tsv",
    "log",
    "xml",
    "yaml",
    "yml",
    "toml",
    "ini",
    "env",
    "sh",
    "bash",
    "zsh",
    "js",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "jsx",
    "css",
    "scss",
    "html",
    "htm",
    "py",
    "rb",
    "rs",
    "go",
    "java",
    "kt",
    "swift",
    "c",
    "h",
    "cpp",
    "hpp",
    "cs",
    "php",
    "sql",
    "graphql",
    "lock",
    "gitignore",
];
/// The web viewer's highlighted languages (`languageFor`): by extension, after the last dot.
const LANGUAGE_EXT: &[&str] = &[
    "ts",
    "mts",
    "cts",
    "tsx",
    "js",
    "mjs",
    "cjs",
    "jsx",
    "json",
    "jsonc",
    "json5",
    "css",
    "scss",
    "html",
    "htm",
    "xml",
    "svg",
    "plist",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "env",
    "md",
    "markdown",
    "mdx",
    "sh",
    "bash",
    "zsh",
    "fish",
    "py",
    "rb",
    "rs",
    "go",
    "java",
    "kt",
    "kts",
    "swift",
    "c",
    "h",
    "cpp",
    "cc",
    "cxx",
    "hpp",
    "hh",
    "cs",
    "php",
    "sql",
    "graphql",
    "gql",
    "dockerfile",
    "makefile",
    "mk",
    "diff",
    "patch",
    "lua",
    "dart",
    "ex",
    "exs",
    "hs",
    "zig",
    "r",
    "tex",
    "nix",
    "ps1",
    "csv",
    "tsv",
];
/// ... and by whole name.
const LANGUAGE_NAME: &[&str] =
    &["dockerfile", "makefile", ".gitignore", ".gitattributes", ".editorconfig", ".env", ".npmrc"];

/// Whether a file is one the editor opens, by its name and recorded type: what the
/// web viewer shows as text or Markdown, CSV and TSV (as text), and SVG (always as
/// text). Its bytes decide after that (`text_read_only`).
///
/// ```
/// use hushos_core::text_editable_kind;
/// assert!(text_editable_kind("notes.md".into(), None));
/// assert!(text_editable_kind("main.ts".into(), Some("video/mp2t".into())));
/// assert!(!text_editable_kind("photo.jpg".into(), Some("text/plain".into())));
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn text_editable_kind(name: String, mime: Option<String>) -> bool {
    let recorded = mime.unwrap_or_default().to_lowercase();
    let essence = recorded.split(';').next().unwrap_or("").trim().to_owned();
    let lower = name.to_lowercase();
    let dot = lower.rfind('.');
    // The web's extensionOf: after the last dot, with a name before it.
    let ext = match dot {
        Some(at) if at > 0 => &lower[at + 1..],
        _ => "",
    };
    if essence == "image/svg+xml" || ext == "svg" {
        return true;
    }
    if essence == "text/csv" || essence == "text/tab-separated-values" || ext == "csv" || ext == "tsv" {
        return true;
    }
    // The web's previewKindOf, in its order, on the whole recorded type.
    let mime = recorded.as_str();
    if mime.starts_with("image/") || IMAGE_EXT.contains(&ext) {
        return false;
    }
    if mime == "application/pdf" || ext == "pdf" {
        return false;
    }
    if (mime.starts_with("video/") && !TRANSPORT_STREAM.contains(&mime)) || VIDEO_EXT.contains(&ext) {
        return false;
    }
    if mime.starts_with("audio/") || AUDIO_EXT.contains(&ext) {
        return false;
    }
    if mime == "text/markdown" || matches!(ext, "md" | "markdown" | "mdx") {
        return true;
    }
    if OFFICE_MIME.contains(&mime) || OFFICE_EXT.contains(&ext) {
        return false;
    }
    if ZIP_MIME.contains(&mime) || ext == "zip" {
        return false;
    }
    // languageFor: a whole name first, then whatever follows the last dot (".env" included).
    let language = LANGUAGE_NAME.contains(&lower.as_str())
        || dot.is_some_and(|at| LANGUAGE_EXT.contains(&&lower[at + 1..]));
    mime.starts_with("text/") || TEXT_MIME.contains(&mime) || TEXT_EXT.contains(&ext) || language
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_only(bytes: &[u8]) -> Option<TextReadOnly> {
        text_read_only(bytes.to_vec())
    }

    #[test]
    fn the_limit_is_the_last_byte_allowed() {
        let at = vec![b'a'; TEXT_EDIT_LIMIT as usize];
        assert_eq!(read_only(&at), None);
        let past = vec![b'a'; TEXT_EDIT_LIMIT as usize + 1];
        assert_eq!(read_only(&past), Some(TextReadOnly::TooLarge));
    }

    #[test]
    fn control_characters_count_only_in_the_first_eight_kibibytes() {
        let mut bytes = vec![b'a'; SNIFF_BYTES];
        bytes.extend(std::iter::repeat_n(1u8, 1000));
        assert_eq!(read_only(&bytes), None);
        let mut front = vec![1u8; 200];
        front.extend(vec![b'a'; SNIFF_BYTES]);
        assert_eq!(read_only(&front), Some(TextReadOnly::Binary));
    }

    #[test]
    fn two_percent_exactly_is_still_text() {
        let mut bytes = vec![b'a'; 980];
        bytes.extend([1u8; 20]);
        assert_eq!(read_only(&bytes), None);
        bytes.push(1);
        assert_eq!(read_only(&bytes), Some(TextReadOnly::Binary));
    }
}
