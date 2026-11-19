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

#[test]
fn every_editable_case_saved_without_an_edit_is_its_own_bytes() {
    let cases = cases();
    for case in cases["bytes"].as_array().expect("bytes") {
        let bytes = bytes_of(&case["bytes"]);
        match text_open(bytes.clone()) {
            TextOpened::Editable { text, .. } => {
                assert!(text_save(bytes.clone(), text).as_deref() == Some(&bytes[..]), "{}", case["name"])
            }
            TextOpened::ReadOnly { .. } => {
                assert_eq!(text_save(bytes, String::new()), None, "{}", case["name"])
            }
        }
    }
}

#[test]
fn every_edit_writes_what_the_fixture_says() {
    let cases = cases();
    let list = cases["edits"].as_array().expect("edits");
    assert!(list.iter().any(|case| case["saved"].is_null()));
    for case in list {
        let bytes = bytes_of(&case["bytes"]);
        let text = case["text"].as_str().expect("text").to_owned();
        let expected = (!case["saved"].is_null()).then(|| bytes_of(&case["saved"]));
        assert_eq!(text_save(bytes, text), expected, "{}", case["name"]);
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
