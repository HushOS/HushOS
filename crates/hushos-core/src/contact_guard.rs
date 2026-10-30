//! The contact guard as a phone keeps it (docs/optional-verification.md 2.8):
//! one record per account, sealed at rest so a phone holds only ciphertext of
//! whom its account shared with. The web keeps one row per person
//! (`packages/crypto/src/contact-guard.ts`); the key is the same derivation,
//! the record's layout is the phone's own.
//!
//! Sealed in the device-store envelope (`[1][24-byte nonce][XChaCha20-Poly1305]`,
//! base64url, `packages/crypto/src/device-store.ts`) under a key from the
//! settings key (HKDF-SHA-256, salt 32 zero bytes, info
//! `hushos/contact-guard/v1`, the web's). A master-key rotation only re-wraps
//! the settings key, so a guard written before one still opens after it. The
//! associated data `["hushos/contact-guard",1,userId,slot,kind]` binds a record
//! to its account (the user id, lowercased), its slot (which also names the
//! server) and what it is, so a record moved to another account, slot or kind
//! does not open.
//!
//! The slot needs no key (SHA-256 of `hushos/contact-guard/slot/v1`, a zero
//! byte, the origin, a zero byte and the user id, cut to 16 bytes, base64url),
//! as the rollback marks' does: a slot worked out under the settings key would
//! make a record sealed under another settings key look absent, which is first
//! use for everyone on the account. Found without a key, a record that is there
//! and does not open is refused, never read as none. It names nobody to whoever
//! does not already know the account's id and server.

use crate::bytes::{decode, encode, random, NONCE_BYTES, TAG_BYTES};
use crate::canonical::encode_statement;
use crate::contacts::hkdf;
use crate::envelope::{open_with_nonce, seal_with_nonce};
use crate::error::{input, CoreError, CoreResult};
use serde_json::json;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const KEY_INFO: &[u8] = b"hushos/contact-guard/v1";
const SLOT_LABEL: &str = "hushos/contact-guard/slot/v1";
const DOMAIN: &str = "hushos/contact-guard";
const VERSION: u8 = 1;
const UNREADABLE: &str = "This saved contact record could not be opened.";

fn account(user_id: &str) -> CoreResult<String> {
    let user = user_id.trim().to_lowercase();
    if user.is_empty() {
        return Err(input("Invalid user id."));
    }
    Ok(user)
}

/// Where an account's guard is kept on the device: found without a key, and
/// naming neither the account nor its server.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn contact_guard_slot(origin: String, user_id: String) -> CoreResult<String> {
    let user = account(&user_id)?;
    let origin = origin.trim().trim_end_matches('/').to_lowercase();
    let digest = Sha256::digest(format!("{SLOT_LABEL}\u{0}{origin}\u{0}{user}").as_bytes());
    Ok(encode(&digest[..16]))
}

fn context(user: &str, slot: &str, kind: &str) -> CoreResult<Vec<u8>> {
    if slot.is_empty() || kind.is_empty() {
        return Err(input("Invalid contact guard record."));
    }
    encode_statement(&[json!(DOMAIN), json!(VERSION), json!(user), json!(slot), json!(kind)])
}

fn sealing_key(settings_key: &[u8]) -> CoreResult<Zeroizing<[u8; 32]>> {
    if settings_key.len() != 32 {
        return Err(input("Invalid settings key."));
    }
    hkdf(settings_key, KEY_INFO)
}

fn refused() -> CoreError {
    CoreError::Sealed(UNREADABLE.into())
}

/// `record` (the guard's JSON) sealed for this account, slot and kind.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn contact_guard_seal(
    settings_key: Vec<u8>,
    user_id: String,
    slot: String,
    kind: String,
    record: String,
) -> CoreResult<String> {
    let user = account(&user_id)?;
    let context = context(&user, &slot, &kind)?;
    let key = sealing_key(&settings_key)?;
    let plaintext = Zeroizing::new(record.into_bytes());
    let nonce = random(NONCE_BYTES);
    let sealed = seal_with_nonce(key.as_slice(), &nonce, &plaintext, &context)?;
    let mut out = Vec::with_capacity(1 + NONCE_BYTES + sealed.len());
    out.push(VERSION);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(encode(&out))
}

/// The JSON a record holds, or `Sealed` when it does not open here: another
/// settings key, another account, slot or kind, or altered bytes. Never "none".
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn contact_guard_open(
    settings_key: Vec<u8>,
    user_id: String,
    slot: String,
    kind: String,
    envelope: String,
) -> CoreResult<String> {
    let user = account(&user_id)?;
    let context = context(&user, &slot, &kind)?;
    let key = sealing_key(&settings_key)?;
    let bytes = decode("contact guard", &envelope, None).map_err(|_| refused())?;
    if bytes.len() < 1 + NONCE_BYTES + TAG_BYTES || bytes[0] != VERSION {
        return Err(refused());
    }
    let plaintext = Zeroizing::new(
        open_with_nonce(key.as_slice(), &bytes[1..1 + NONCE_BYTES], &bytes[1 + NONCE_BYTES..], &context)
            .map_err(|_| refused())?,
    );
    String::from_utf8(plaintext.to_vec()).map_err(|_| refused())
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "6B1A3F0E-2C4D-4E5F-8A9B-0C1D2E3F4A5B";
    const OTHER: &str = "0d4f2a1b-9c8e-4f7a-b6d5-e4c3b2a1f0e9";
    const ORIGIN: &str = "https://hushos.com";
    const RECORD: &str = r#"{"entries":{"maya":{"revision":1}},"pending":{},"v":1}"#;

    fn slot(user: &str) -> String {
        contact_guard_slot(ORIGIN.into(), user.into()).unwrap()
    }

    fn sealed(key: [u8; 32]) -> String {
        contact_guard_seal(key.to_vec(), USER.into(), slot(USER), "record".into(), RECORD.into()).unwrap()
    }

    #[test]
    fn a_record_opens_under_its_own_key_account_slot_and_kind() {
        let envelope = sealed([7; 32]);
        let opened =
            contact_guard_open(vec![7; 32], USER.to_lowercase(), slot(USER), "record".into(), envelope)
                .unwrap();
        assert_eq!(opened, RECORD);
    }

    #[test]
    fn another_settings_key_opens_nothing() {
        let envelope = sealed([7; 32]);
        let err =
            contact_guard_open(vec![8; 32], USER.into(), slot(USER), "record".into(), envelope).unwrap_err();
        assert!(matches!(err, CoreError::Sealed(_)));
    }

    #[test]
    fn a_record_moved_to_another_account_slot_or_kind_is_refused() {
        let envelope = sealed([7; 32]);
        let open = |user: &str, slot: String, kind: &str| {
            contact_guard_open(vec![7; 32], user.into(), slot, kind.into(), envelope.clone())
        };
        assert!(matches!(open(OTHER, slot(USER), "record"), Err(CoreError::Sealed(_))));
        assert!(matches!(open(USER, slot(OTHER), "record"), Err(CoreError::Sealed(_))));
        let staging = contact_guard_slot("https://staging.hushos.com".into(), USER.into()).unwrap();
        assert!(matches!(open(USER, staging, "record"), Err(CoreError::Sealed(_))));
        assert!(matches!(open(USER, slot(USER), "pending"), Err(CoreError::Sealed(_))));
    }

    #[test]
    fn tampered_or_truncated_bytes_are_refused() {
        let envelope = sealed([7; 32]);
        let mut bytes = decode("t", &envelope, None).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        let flipped = encode(&bytes);
        for bad in [flipped, encode(&bytes[..20]), "not base64!".to_string(), String::new()] {
            let err =
                contact_guard_open(vec![7; 32], USER.into(), slot(USER), "record".into(), bad).unwrap_err();
            assert!(matches!(err, CoreError::Sealed(_)));
        }
        // Another version byte is not this format.
        let mut versioned = decode("t", &envelope, None).unwrap();
        versioned[0] = 2;
        assert!(contact_guard_open(
            vec![7; 32],
            USER.into(),
            slot(USER),
            "record".into(),
            encode(&versioned)
        )
        .is_err());
    }

    #[test]
    fn the_slot_names_neither_account_nor_server_and_tells_them_apart() {
        let here = slot(USER);
        assert_eq!(here, slot(&USER.to_lowercase()));
        assert_eq!(here, contact_guard_slot(format!("{ORIGIN}/"), USER.into()).unwrap());
        assert_ne!(here, slot(OTHER));
        assert!(!here.to_lowercase().contains("6b1a3f0e") && !here.contains("hushos"));
        assert_eq!(decode("slot", &here, Some(16)).unwrap().len(), 16);
    }

    #[test]
    fn the_sealed_record_holds_no_plaintext_and_a_short_key_is_an_input_error() {
        let envelope = sealed([7; 32]);
        let bytes = decode("t", &envelope, None).unwrap();
        assert!(!bytes.windows(4).any(|w| w == b"maya"));
        assert!(matches!(
            contact_guard_seal(vec![7; 16], USER.into(), slot(USER), "record".into(), RECORD.into()),
            Err(CoreError::Input(_))
        ));
    }
}
