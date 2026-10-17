//! XChaCha20-Poly1305 envelopes as `packages/crypto` writes them: a 24-byte
//! nonce, then the ciphertext with its 16-byte tag, bound to a context that is
//! a compact JSON array, byte for byte what `JSON.stringify` produces.

use crate::bytes::{random, KEY_BYTES, NONCE_BYTES, TAG_BYTES};
use crate::error::{input, CoreError, CoreResult};
use chacha20::cipher::consts::U10;
use chacha20::hchacha;
use chacha20poly1305::aead::{Aead as _, KeyInit as _, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Nonce, XChaCha20Poly1305, XNonce};
use serde_json::Value;
use zeroize::Zeroizing;

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

/*
 * A raw re-seal: the plaintext exactly as it was sealed (padding, field order
 * and all) sealed again under `new_key` with a fresh nonce and the same
 * associated data. Nothing is parsed or cleaned, so a re-keyed record's
 * origin and its current envelope hold the same bytes and a reader can
 * compare them (docs/integrity-design.md, "Re-keyed records").
 */
pub(crate) fn rekey(old_key: &[u8], new_key: &[u8], envelope: &[u8], aad: &[u8]) -> CoreResult<Vec<u8>> {
    cipher(new_key)?;
    let plaintext = Zeroizing::new(open(old_key, envelope, aad)?);
    seal(new_key, &plaintext, aad)
}

/*
 * The key that opens this one envelope and no other: XChaCha20-Poly1305's
 * own subkey, HChaCha20 of the key and the first 16 bytes of the envelope's
 * nonce. It opens only envelopes sealed under `key` with that nonce prefix,
 * so handing it out reveals nothing else `key` sealed.
 */
pub(crate) fn opening_key(key: &[u8], envelope: &[u8]) -> CoreResult<Zeroizing<[u8; KEY_BYTES]>> {
    if key.len() != KEY_BYTES {
        return Err(input("key must be 32 bytes"));
    }
    if envelope.len() <= NONCE_BYTES + TAG_BYTES {
        return Err(CoreError::Sealed(DAMAGED.into()));
    }
    let subkey = hchacha::<U10>(key.into(), envelope[..16].into());
    Ok(Zeroizing::new(subkey.into()))
}

/*
 * An envelope opened with its opening key: ChaCha20-Poly1305 (IETF) under the
 * subkey, with the nonce four zero bytes and then the envelope nonce's last
 * eight, which is what XChaCha20-Poly1305 does after deriving it.
 */
pub(crate) fn open_with_opening_key(subkey: &[u8], envelope: &[u8], aad: &[u8]) -> CoreResult<Vec<u8>> {
    if subkey.len() != KEY_BYTES {
        return Err(input("key must be 32 bytes"));
    }
    if envelope.len() <= NONCE_BYTES + TAG_BYTES {
        return Err(CoreError::Sealed(DAMAGED.into()));
    }
    let mut nonce = [0u8; 12];
    nonce[4..].copy_from_slice(&envelope[16..NONCE_BYTES]);
    ChaCha20Poly1305::new(subkey.into())
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: &envelope[NONCE_BYTES..], aad })
        .map_err(|_| CoreError::Sealed(OPEN_FAILED.into()))
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

    #[test]
    fn hchacha20_is_the_draft_s_known_answer() {
        // draft-irtf-cfrg-xchacha-03, 2.2.1: key 00..1f, input 000000090000004a0000000031415927.
        let key: Vec<u8> = (0u8..32).collect();
        let mut envelope = vec![0, 0, 0, 9, 0, 0, 0, 0x4a, 0, 0, 0, 0, 0x31, 0x41, 0x59, 0x27];
        envelope.resize(NONCE_BYTES + TAG_BYTES + 1, 0);
        assert_eq!(
            crate::bytes::encode(opening_key(&key, &envelope).unwrap().as_slice()),
            crate::bytes::encode(&[
                0x82, 0x41, 0x3b, 0x42, 0x27, 0xb2, 0x7b, 0xfe, 0xd3, 0x0e, 0x42, 0x50, 0x8a, 0x87, 0x7d,
                0x73, 0xa0, 0xf9, 0xe4, 0xd5, 0x8a, 0x74, 0xa8, 0x53, 0xc1, 0x2e, 0xc4, 0x13, 0x26, 0xd3,
                0xec, 0xdc,
            ])
        );
    }

    #[test]
    fn an_opening_key_opens_its_own_envelope_and_nothing_else_the_key_sealed() {
        let key = [3u8; KEY_BYTES];
        let envelope = seal(&key, b"the writer's bytes", b"aad").unwrap();
        let subkey = opening_key(&key, &envelope).unwrap();
        assert_ne!(subkey.as_slice(), &key, "the subkey is not the key");
        assert_eq!(
            open_with_opening_key(subkey.as_slice(), &envelope, b"aad").unwrap(),
            b"the writer's bytes"
        );
        // Another envelope under the same key and context: another nonce, so another subkey.
        let other = seal(&key, b"something else", b"aad").unwrap();
        assert!(matches!(
            open_with_opening_key(subkey.as_slice(), &other, b"aad"),
            Err(CoreError::Sealed(_))
        ));
        // The same nonce prefix with other trailing nonce bytes: same subkey, but the nonce is in the tag.
        let mut moved = envelope.clone();
        moved[20] ^= 1;
        assert!(matches!(
            open_with_opening_key(subkey.as_slice(), &moved, b"aad"),
            Err(CoreError::Sealed(_))
        ));
        assert!(matches!(
            open_with_opening_key(subkey.as_slice(), &envelope, b"other"),
            Err(CoreError::Sealed(_))
        ));
        // The subkey is no XChaCha key for the envelope.
        assert!(matches!(open(subkey.as_slice(), &envelope, b"aad"), Err(CoreError::Sealed(_))));
    }

    #[test]
    fn a_rekey_keeps_the_plaintext_byte_for_byte_under_a_fresh_nonce() {
        let (old, new) = ([1u8; KEY_BYTES], [2u8; KEY_BYTES]);
        // Not JSON, trailing spaces kept: a re-seal never parses.
        let plaintext = b"{\"name\":\"a\",\"extra\":1}   \xff".to_vec();
        let envelope = seal(&old, &plaintext, b"aad").unwrap();
        let rekeyed = rekey(&old, &new, &envelope, b"aad").unwrap();
        assert_eq!(rekeyed.len(), envelope.len());
        assert_ne!(rekeyed[..NONCE_BYTES], envelope[..NONCE_BYTES], "a fresh nonce");
        assert_eq!(open(&new, &rekeyed, b"aad").unwrap(), plaintext);
        assert!(matches!(open(&old, &rekeyed, b"aad"), Err(CoreError::Sealed(_))));
        assert!(
            matches!(rekey(&new, &old, &envelope, b"aad"), Err(CoreError::Sealed(_))),
            "the wrong old key"
        );
        assert!(matches!(rekey(&old, &new, &envelope, b"other"), Err(CoreError::Sealed(_))));
        assert!(matches!(rekey(&old, &[2u8; 16], &envelope, b"aad"), Err(CoreError::Input(_))));
    }
}
