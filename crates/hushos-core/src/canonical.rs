//! The canonical encoding of group statements (docs/groups-design.md 2.1), as
//! `packages/crypto/canonical.ts` applies it: every statement is the compact
//! JSON array `JSON.stringify` writes, built only from values these checks let
//! through, so a verifier can rebuild it from the parsed fields and refuse any
//! document whose bytes differ.
//!
//! - Ids are 36-character lowercase hyphenated UUIDs, never lowercased for the
//!   caller: anything else is refused.
//! - Byte strings, digests included, are canonical base64url without padding.
//! - Integers run from 1 to 2^53 - 1, so this crate and the web agree on every
//!   value either accepts.
//! - Lists are strictly ascending by the bytes of their sort key.
//!
//! Beneath those field rules, every statement keeps one grammar, enforced by
//! `encode_statement` and `parse_statement` alike (design 2.1), as the web does:
//! - at most `MAX_STATEMENT_BYTES` bytes, no byte-order mark;
//! - a JSON array, nested at most four deep, of strings and integers only (no
//!   objects, booleans, null, floats, exponents or -0);
//! - strings of printable ASCII other than `"` and `\`, so there is never an
//!   escape, a lone surrogate or a non-ASCII byte;
//! - integers from 0 to 2^53 - 1;
//! - the bytes are exactly the compact encoding of what they hold.

use crate::bytes::decode;
use crate::envelope::context;
use crate::error::{input, CoreResult};
use serde_json::Value;

/// The largest integer a statement carries: 2^53 - 1, the web's largest safe integer.
pub(crate) const MAX_STATEMENT_INTEGER: u64 = (1 << 53) - 1;

/// The most bytes a statement may have: 4 MiB, far beyond the largest roster allowed.
pub(crate) const MAX_STATEMENT_BYTES: usize = 4 * 1024 * 1024;

/* Whether `value` keeps the statement grammar: arrays (at most four deep) of plain strings and safe integers. */
fn grammatical(value: &Value, depth: usize) -> bool {
    match value {
        Value::String(text) => text.bytes().all(|c| (0x20..=0x7e).contains(&c) && c != b'"' && c != b'\\'),
        // `as_u64` is none for floats and negative numbers.
        Value::Number(number) => number.as_u64().is_some_and(|n| n <= MAX_STATEMENT_INTEGER),
        Value::Array(items) => depth < 4 && items.iter().all(|item| grammatical(item, depth + 1)),
        _ => false,
    }
}

fn invalid(what: &str) -> crate::error::CoreError {
    input(format!("Invalid {what}."))
}

/* A lowercase hyphenated UUID, or refused. */
pub(crate) fn uuid<'a>(value: &'a str, what: &str) -> CoreResult<&'a str> {
    let bytes = value.as_bytes();
    let shaped = bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        });
    if !shaped {
        return Err(invalid(what));
    }
    Ok(value)
}

/* An integer from 1 to 2^53 - 1, or refused. */
pub(crate) fn integer(value: u64, what: &str) -> CoreResult<u64> {
    if !(1..=MAX_STATEMENT_INTEGER).contains(&value) {
        return Err(invalid(what));
    }
    Ok(value)
}

/* Canonical base64url of exactly `length` bytes, or refused; never empty, as the web refuses it. */
pub(crate) fn bytes_of<'a>(value: &'a str, length: usize, what: &str) -> CoreResult<&'a str> {
    if value.is_empty() {
        return Err(invalid(what));
    }
    decode(what, value, Some(length)).map_err(|_| invalid(what))?;
    Ok(value)
}

/* A SHA-256 digest as a statement carries it: base64url of 32 bytes, never hex. */
pub(crate) fn digest_of<'a>(value: &'a str, what: &str) -> CoreResult<&'a str> {
    bytes_of(value, 32, what)
}

/* Strictly ascending by bytes, so neither order nor duplicates can vary. */
pub(crate) fn ascending<S: AsRef<str>>(values: &[S], what: &str) -> CoreResult<()> {
    if values.windows(2).all(|pair| pair[0].as_ref().as_bytes() < pair[1].as_ref().as_bytes()) {
        Ok(())
    } else {
        Err(invalid(what))
    }
}

pub(crate) fn encode_statement(parts: &[Value]) -> CoreResult<Vec<u8>> {
    if !parts.iter().all(|part| grammatical(part, 1)) {
        return Err(invalid("statement"));
    }
    let bytes = context(parts);
    if bytes.len() > MAX_STATEMENT_BYTES {
        return Err(invalid("statement"));
    }
    Ok(bytes)
}

/*
 * The JSON array a statement's bytes hold, or refused: too long, not UTF-8, a
 * byte-order mark, not JSON, outside the grammar, or not exactly the compact
 * encoding of what it holds.
 */
pub(crate) fn parse_statement(bytes: &[u8], what: &str) -> CoreResult<Vec<Value>> {
    if bytes.len() > MAX_STATEMENT_BYTES {
        return Err(invalid(what));
    }
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Array(parts))
            if parts.iter().all(|part| grammatical(part, 1)) && context(&parts) == bytes =>
        {
            Ok(parts)
        }
        _ => Err(invalid(what)),
    }
}

/* A string field of a parsed statement, or refused. */
pub(crate) fn text<'a>(value: &'a Value, what: &str) -> CoreResult<&'a str> {
    value.as_str().ok_or_else(|| invalid(what))
}

/* An integer field of a parsed statement, or refused; `1.0`, `-1` and anything past 2^53 - 1 included. */
pub(crate) fn number(value: &Value, what: &str) -> CoreResult<u64> {
    integer(value.as_u64().ok_or_else(|| invalid(what))?, what)
}

/*
 * Refuses a statement whose bytes are not the canonical encoding of what was
 * parsed out of them: another spacing, escape or number form. A statement
 * then has exactly one encoding, and no two clients read signed bytes apart.
 */
pub(crate) fn require_canonical(served: &[u8], rebuilt: &[u8], what: &str) -> CoreResult<()> {
    if served != rebuilt {
        return Err(invalid(what));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ids_are_lowercase_hyphenated_uuids_and_nothing_else() {
        assert!(uuid("0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a", "id").is_ok());
        for bad in [
            "0A0A0A0A-0A0A-4A0A-8A0A-0A0A0A0A0A0A",
            "0a0a0a0a0a0a4a0a8a0a0a0a0a0a0a0a",
            "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0",
            "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0g",
            "{0a0a0a0-0a0a-4a0a-8a0a-0a0a0a0a0a0a",
        ] {
            assert!(uuid(bad, "id").is_err(), "{bad}");
        }
    }

    #[test]
    fn integers_stop_where_the_web_s_safe_integers_do() {
        assert_eq!(integer(MAX_STATEMENT_INTEGER, "v").unwrap(), 9_007_199_254_740_991);
        assert!(integer(MAX_STATEMENT_INTEGER + 1, "v").is_err());
        assert!(integer(0, "v").is_err());
        assert!(number(&json!(9_007_199_254_740_992u64), "v").is_err());
        assert!(number(&json!(1.0), "v").is_err());
        assert!(number(&json!(-1), "v").is_err());
        assert!(number(&json!("1"), "v").is_err());
    }

    #[test]
    fn digests_are_base64url_never_hex() {
        let digest = crate::bytes::encode(&[7; 32]);
        assert!(digest_of(&digest, "d").is_ok());
        assert!(digest_of(&"07".repeat(32), "d").is_err());
        assert!(digest_of(&format!("{digest}="), "d").is_err());
    }

    #[test]
    fn lists_are_strictly_ascending() {
        assert!(ascending(&["a", "b", "c"], "l").is_ok());
        assert!(ascending::<&str>(&[], "l").is_ok());
        assert!(ascending(&["b", "a"], "l").is_err());
        assert!(ascending(&["a", "a"], "l").is_err());
    }

    /* Round 8 (Codex 5, 6): one grammar for every statement, parsed or encoded, and no empty bytes. */
    #[test]
    fn statements_keep_one_grammar_and_a_size_cap() {
        let accepted: [&[u8]; 3] = [br#"["a",1,[2,["b"]]]"#, b"[9007199254740991]", br#"[[[["a"]]]]"#];
        for bytes in accepted {
            assert!(parse_statement(bytes, "x").is_ok(), "{}", String::from_utf8_lossy(bytes));
        }
        let refused: Vec<Vec<u8>> = vec![
            br#"[[[[["a"]]]]]"#.to_vec(),
            [&[0xef, 0xbb, 0xbf][..], b"[]"].concat(),
            br#"["\ud800"]"#.to_vec(),
            br#"["a\"b"]"#.to_vec(),
            "[\"\u{e9}\"]".as_bytes().to_vec(),
            b"[9007199254740993]".to_vec(),
            b"[1.0]".to_vec(),
            b"[-0]".to_vec(),
            b"[-1]".to_vec(),
            b"[1e0]".to_vec(),
            b"[{}]".to_vec(),
            b"[true]".to_vec(),
            b"[null]".to_vec(),
            b"[ 1]".to_vec(),
            br#""a""#.to_vec(),
            vec![b' '; MAX_STATEMENT_BYTES + 1],
            format!("[\"{}\"]", "a".repeat(MAX_STATEMENT_BYTES)).into_bytes(),
        ];
        for bytes in refused {
            assert!(
                parse_statement(&bytes, "x").is_err(),
                "{}",
                String::from_utf8_lossy(&bytes[..bytes.len().min(40)])
            );
        }
        assert!(encode_statement(&[json!("a".repeat(MAX_STATEMENT_BYTES))]).is_err());
        for bad in [
            json!(1.5),
            json!(-1),
            json!(true),
            json!({}),
            json!("a\"b"),
            json!("\u{e9}"),
            json!([[[["deep"]]]]),
        ] {
            assert!(encode_statement(std::slice::from_ref(&bad)).is_err(), "{bad}");
        }
        assert!(bytes_of("", 0, "x").is_err());
    }
}
