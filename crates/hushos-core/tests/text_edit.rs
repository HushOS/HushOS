//! Text editability (`fixtures/text-edit-cases.json`, hand-written outcomes) as
//! this core gives it; `apps/web/src/lib/text-edit.test.ts` holds the web to the
//! same file. A verdict the twins give differently is a file one client lets the
//! person edit and another doesn't, or one a phone saves with bytes changed.

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

fn word(reason: Option<TextReadOnly>) -> Option<&'static str> {
    reason.map(|reason| match reason {
        TextReadOnly::TooLarge => "too-large",
        TextReadOnly::ByteOrderMark => "byte-order-mark",
        TextReadOnly::Utf16 => "utf-16",
        TextReadOnly::Encoding => "encoding",
        TextReadOnly::Binary => "binary",
        TextReadOnly::LineEndings => "line-endings",
    })
}

#[test]
fn every_byte_case_opens_as_the_web_opens_it() {
    let cases = cases();
    let list = cases["bytes"].as_array().expect("bytes");
    assert!(list.len() >= 20);
    for case in list {
        let bytes = bytes_of(&case["bytes"]);
        assert_eq!(word(text_read_only(bytes)), case["reason"].as_str(), "{}", case["name"]);
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
