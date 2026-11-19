//! Which files the phones' text editor opens, and whether it may change them:
//! the twin of `apps/web/src/lib/text-edit.ts` (docs/editing-design.md section 1,
//! Editing 1a). An edit is saved byte for byte except for what the person
//! changed, so a file opens for editing only when its bytes come back out of the
//! editor exactly as they went in: UTF-8 without a byte order mark, lines ending
//! in LF alone, and text rather than binary. Anything else opens read-only.
//! Both twins are held to `fixtures/text-edit-cases.json`.

/// The largest file the editor opens for editing (the web's text preview limit, 8 MiB).
pub const TEXT_EDIT_LIMIT: u64 = 8 * 1024 * 1024;

/// How much of the start the viewer's text sniff looks at for control characters.
const SNIFF_BYTES: usize = 8 * 1024;

/// Why a text file opens read-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum TextReadOnly {
    TooLarge,
    ByteOrderMark,
    Utf16,
    Encoding,
    Binary,
    LineEndings,
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
/// or `None` when they can. In the web's order: the size, a byte order mark
/// (UTF-8, then UTF-16 either way), bytes that aren't UTF-8, binary (a NUL
/// anywhere, or more than 2% control characters in the first 8 KiB), then a
/// carriage return anywhere.
///
/// ```
/// use hushos_core::{text_read_only, TextReadOnly};
/// assert_eq!(text_read_only(b"notes\n".to_vec()), None);
/// assert_eq!(text_read_only(b"a\r\nb".to_vec()), Some(TextReadOnly::LineEndings));
/// assert_eq!(text_read_only(vec![0x63, 0x61, 0x66, 0xe9]), Some(TextReadOnly::Encoding));
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn text_read_only(bytes: Vec<u8>) -> Option<TextReadOnly> {
    read_only(&bytes)
}

pub(crate) fn read_only(bytes: &[u8]) -> Option<TextReadOnly> {
    if bytes.len() as u64 > TEXT_EDIT_LIMIT {
        return Some(TextReadOnly::TooLarge);
    }
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Some(TextReadOnly::ByteOrderMark);
    }
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        return Some(TextReadOnly::Utf16);
    }
    if std::str::from_utf8(bytes).is_err() {
        return Some(TextReadOnly::Encoding);
    }
    if bytes.contains(&0) {
        return Some(TextReadOnly::Binary);
    }
    let sample = &bytes[..bytes.len().min(SNIFF_BYTES)];
    let control = sample.iter().filter(|&&b| b < 32 && !matches!(b, 9 | 10 | 12 | 13)).count();
    // As the web computes it: control / length > 0.02, in whole numbers.
    if !sample.is_empty() && control * 50 > sample.len() {
        return Some(TextReadOnly::Binary);
    }
    if bytes.contains(&13) {
        return Some(TextReadOnly::LineEndings);
    }
    None
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
