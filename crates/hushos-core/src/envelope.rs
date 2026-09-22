//! XChaCha20-Poly1305 envelopes as `packages/crypto` writes them: a 24-byte
//! nonce, then the ciphertext with its 16-byte tag, bound to a context that is
//! a compact JSON array, byte for byte what `JSON.stringify` produces.

use crate::bytes::{random, KEY_BYTES, NONCE_BYTES, TAG_BYTES};
use crate::error::{input, CoreError, CoreResult};
use chacha20poly1305::aead::{Aead as _, KeyInit as _, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde_json::Value;

const OPEN_FAILED: &str = "This encrypted envelope could not be opened. It may belong to a different account or version, or it may be damaged.";
const DAMAGED: &str = "This encrypted envelope is damaged.";

pub(crate) fn context(parts: &[Value]) -> Vec<u8> {
    Value::Array(parts.to_vec()).to_string().into_bytes()
}

fn cipher(key: &[u8]) -> CoreResult<XChaCha20Poly1305> {
    if key.len() != KEY_BYTES {
        return Err(input("key must be 32 bytes"));
    }
    Ok(XChaCha20Poly1305::new(key.into()))
}

/* Ciphertext and tag only, under a nonce the caller chose (content chunks). */
pub(crate) fn seal_with_nonce(key: &[u8], nonce: &[u8], plaintext: &[u8], aad: &[u8]) -> CoreResult<Vec<u8>> {
    if nonce.len() != NONCE_BYTES {
        return Err(input("nonce must be 24 bytes"));
    }
    cipher(key)?
        .encrypt(XNonce::from_slice(nonce), Payload { msg: plaintext, aad })
        .map_err(|_| CoreError::Sealed("encryption failed".into()))
}

pub(crate) fn open_with_nonce(
    key: &[u8],
    nonce: &[u8],
    ciphertext: &[u8],
    aad: &[u8],
) -> CoreResult<Vec<u8>> {
    if nonce.len() != NONCE_BYTES {
        return Err(input("nonce must be 24 bytes"));
    }
    cipher(key)?
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ciphertext, aad })
        .map_err(|_| CoreError::Sealed(OPEN_FAILED.into()))
}

/* A full envelope: a fresh nonce, then the ciphertext and tag. */
pub(crate) fn seal(key: &[u8], plaintext: &[u8], aad: &[u8]) -> CoreResult<Vec<u8>> {
    let mut out = random(NONCE_BYTES);
    let sealed = seal_with_nonce(key, &out, plaintext, aad)?;
    out.extend_from_slice(&sealed);
    Ok(out)
}

pub(crate) fn open(key: &[u8], envelope: &[u8], aad: &[u8]) -> CoreResult<Vec<u8>> {
    if envelope.len() <= NONCE_BYTES + TAG_BYTES {
        return Err(CoreError::Sealed(DAMAGED.into()));
    }
    open_with_nonce(key, &envelope[..NONCE_BYTES], &envelope[NONCE_BYTES..], aad)
}

/* A key wrapped under another: exactly 32 bytes inside. */
pub(crate) fn open_key(key: &[u8], envelope: &[u8], aad: &[u8], what: &str) -> CoreResult<Vec<u8>> {
    let opened = open(key, envelope, aad)?;
    if opened.len() != KEY_BYTES {
        return Err(CoreError::Sealed(format!("Invalid {what}.")));
    }
    Ok(opened)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn context_is_the_compact_json_array_the_web_writes() {
        let aad = context(&[json!("hushos/drive/node-key"), json!(1), json!("ws"), json!(7u64)]);
        assert_eq!(aad, br#"["hushos/drive/node-key",1,"ws",7]"#);
    }

    #[test]
    fn an_envelope_is_nonce_then_ciphertext_and_tag() {
        let key = [1u8; KEY_BYTES];
        let envelope = seal(&key, b"hello", b"aad").unwrap();
        assert_eq!(envelope.len(), NONCE_BYTES + 5 + TAG_BYTES);
        assert_eq!(open(&key, &envelope, b"aad").unwrap(), b"hello");
    }

    #[test]
    fn opening_fails_on_a_flipped_byte_a_wrong_key_or_a_wrong_context() {
        let key = [1u8; KEY_BYTES];
        let envelope = seal(&key, b"hello", b"aad").unwrap();
        for index in [0, NONCE_BYTES, envelope.len() - 1] {
            let mut damaged = envelope.clone();
            damaged[index] ^= 0x80;
            assert!(matches!(open(&key, &damaged, b"aad"), Err(CoreError::Sealed(_))), "byte {index}");
        }
        assert!(matches!(open(&[2u8; KEY_BYTES], &envelope, b"aad"), Err(CoreError::Sealed(_))));
        assert!(matches!(open(&key, &envelope, b"other"), Err(CoreError::Sealed(_))));
    }

    #[test]
    fn short_envelopes_and_wrong_key_lengths_are_refused_before_decrypting() {
        assert!(matches!(
            open(&[1u8; KEY_BYTES], &[0u8; NONCE_BYTES + TAG_BYTES], b""),
            Err(CoreError::Sealed(_))
        ));
        assert!(matches!(seal(&[1u8; 16], b"x", b""), Err(CoreError::Input(_))));
        assert!(matches!(
            seal_with_nonce(&[1u8; KEY_BYTES], &[0u8; 12], b"x", b""),
            Err(CoreError::Input(_))
        ));
    }
}
