//! Text editing (`fixtures/text-edit-cases.json`, hand-written outcomes) as this
//! core gives it; `apps/web/src/lib/text-edit.test.ts` holds the web to the same
//! file, and the phones' own tests hold them. A verdict the twins give differently
//! is a file one client lets the person edit and another doesn't, or one a client
//! saves with bytes changed that nobody touched.

use hushos_core::*;
use serde_json::Value;

fn cases() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/text-edit-cases.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("JSON")
}

fn bytes_of(parts: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    for part in parts.as_array().expect("parts") {
        let hex = part["hex"].as_str().expect("hex");
        let one: Vec<u8> =
            (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex")).collect();
        for _ in 0..part["repeat"].as_u64().unwrap_or(1) {
            out.extend_from_slice(&one);
        }
    }
    out
}

fn word(reason: TextReadOnly) -> &'static str {
    match reason {
        TextReadOnly::TooLarge => "too-large",
        TextReadOnly::Encoding => "encoding",
        TextReadOnly::Binary => "binary",
        TextReadOnly::LineEndings => "line-endings",
    }
}

fn encoding(encoding: TextEncoding) -> &'static str {
    match encoding {
        TextEncoding::Utf8 => "utf-8",
        TextEncoding::Utf8Bom => "utf-8-bom",
        TextEncoding::Utf16Le => "utf-16le",
        TextEncoding::Utf16Be => "utf-16be",
    }
}

fn ending(ending: LineEnding) -> &'static str {
    match ending {
        LineEnding::Lf => "lf",
        LineEnding::Crlf => "crlf",
    }
}

#[test]
fn every_byte_case_opens_as_the_fixture_says() {
    let cases = cases();
    let list = cases["bytes"].as_array().expect("bytes");
    assert!(list.len() >= 40);
    for case in list {
        let name = &case["name"];
        let bytes = bytes_of(&case["bytes"]);
        assert_eq!(text_read_only(bytes.clone()).map(word), case["reason"].as_str(), "{name}");
        match text_open(bytes) {
            TextOpened::Editable { format, text } => {
                assert_eq!(Some(encoding(format.encoding)), case["encoding"].as_str(), "{name}");
                assert_eq!(Some(ending(format.line_ending)), case["lineEnding"].as_str(), "{name}");
                assert_eq!(Some(format.mixed), case["mixed"].as_bool(), "{name}");
                if let Some(expected) = case["text"].as_str() {
                    assert_eq!(text, expected, "{name}");
                }
                assert!(!text.contains('\r'), "{name}: the editor's text holds no carriage return");
            }
            TextOpened::ReadOnly { reason, .. } => {
                assert_eq!(Some(word(reason)), case["reason"].as_str(), "{name}")
            }
        }
    }
}

/// One editing session as every client keeps it: the format found at open, and
/// the text and bytes last opened or saved. A save writes those bytes again while
/// the text is unchanged, otherwise the text in the format found at open.
struct Session {
    format: TextFormat,
    text: String,
    bytes: Vec<u8>,
}

impl Session {
    fn open(bytes: Vec<u8>) -> Option<Self> {
        match text_open(bytes.clone()) {
            TextOpened::Editable { format, text } => Some(Self { format, text, bytes }),
            TextOpened::ReadOnly { .. } => None,
        }
    }

    fn save(&mut self, text: &str) -> Vec<u8> {
        if text != self.text {
            self.bytes = text_encode(self.format, text.to_owned());
            self.text = text.to_owned();
        }
        self.bytes.clone()
    }
}

fn text_of(parts: &Value) -> String {
    let mut out = String::new();
    for part in parts.as_array().expect("parts") {
        for _ in 0..part["repeat"].as_u64().unwrap_or(1) {
            out.push_str(part["text"].as_str().expect("text"));
        }
    }
    out
}

#[test]
fn every_editable_case_saved_without_an_edit_is_its_own_bytes() {
    let cases = cases();
    for case in cases["bytes"].as_array().expect("bytes") {
        let bytes = bytes_of(&case["bytes"]);
        if let Some(mut session) = Session::open(bytes.clone()) {
            let text = session.text.clone();
            assert!(session.save(&text) == bytes, "{}", case["name"]);
        }
    }
}

#[test]
fn every_edit_writes_what_the_fixture_says() {
    let cases = cases();
    let list = cases["edits"].as_array().expect("edits");
    assert!(list.iter().any(|case| case["saved"].is_null()));
    for case in list {
        let session = Session::open(bytes_of(&case["bytes"]));
        let text = case["text"].as_str().expect("text");
        let expected = (!case["saved"].is_null()).then(|| bytes_of(&case["saved"]));
        assert_eq!(session.map(|mut session| session.save(text)), expected, "{}", case["name"]);
    }
}

#[test]
fn every_save_of_a_session_writes_what_the_fixture_says() {
    let cases = cases();
    let list = cases["sessions"].as_array().expect("sessions");
    assert!(list.len() >= 5);
    for case in list {
        let mut session = Session::open(bytes_of(&case["bytes"])).expect("editable");
        for (at, save) in case["saves"].as_array().expect("saves").iter().enumerate() {
            let written = session.save(&text_of(&save["text"]));
            assert!(written == bytes_of(&save["saved"]), "{}, save {}", case["name"], at + 1);
        }
    }
}

#[test]
fn every_name_opens_in_the_editor_as_on_the_web() {
    let cases = cases();
    let list = cases["names"].as_array().expect("names");
    assert!(list.iter().any(|case| case["editable"] == false));
    for case in list {
        let name = case["name"].as_str().expect("name").to_owned();
        let mime = case["mime"].as_str().map(str::to_owned);
        assert_eq!(text_editable_kind(name, mime), case["editable"].as_bool().expect("editable"), "{case}");
    }
}
