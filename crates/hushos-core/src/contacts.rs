//! Contacts: the fingerprint two people compare before trusting a key, and
//! the account settings document that keeps the pins, sealed under a key off
//! the identity's X25519 private key exactly as `packages/crypto/contacts.ts`
//! writes it. The server stores the envelope and a version for compare-and-set.

use crate::bytes::{decode, encode, expect_len, random, KEY_BYTES, NONCE_BYTES};
use crate::envelope::{context, open_with_nonce, seal_with_nonce};
use crate::error::{input, CoreError, CoreResult};
use hkdf::Hkdf;
use serde_json::json;
use sha2::{Digest as _, Sha256};
use zeroize::Zeroizing;

const SETTINGS_MAX_BYTES: usize = 64 * 1024;

/// The settings document as the server keeps it.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SettingsEnvelope {
    pub version: u32,
    pub settings_version: u64,
    pub nonce: String,
    pub ciphertext: String,
}

/// What two people read to each other over another channel: SHA-256 over a
/// domain prefix, the identity's X25519 public key and its Ed25519 signing
/// key, the first 20 bytes as ten groups of four hex digits. The signing key
/// is in it because that key vouches for the ML-KEM key: a fingerprint over
/// X25519 alone would let a server swap the post-quantum half unnoticed.
///
/// ```
/// let print = hushos_core::identity_fingerprint(vec![7u8; 32], vec![9u8; 32])?;
/// assert_eq!(print.split(' ').count(), 10);
/// assert!(print.chars().all(|c| c.is_ascii_hexdigit() || c == ' '));
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn identity_fingerprint(
    encryption_public_key: Vec<u8>,
    signing_public_key: Vec<u8>,
) -> CoreResult<String> {
    expect_len("identity public key", &encryption_public_key, 32)
        .map_err(|_| input("Invalid identity key."))?;
    expect_len("signing public key", &signing_public_key, 32).map_err(|_| input("Invalid identity key."))?;
    let mut hasher = Sha256::new();
    hasher.update(b"hushos/identity/fingerprint/v2");
    hasher.update(&encryption_public_key);
    hasher.update(&signing_public_key);
    let digest = hasher.finalize();
    let hex: String = digest[..20].iter().map(|b| format!("{b:02x}")).collect();
    Ok(hex.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).expect("hex")).collect::<Vec<_>>().join(" "))
}

/// SHA-256 of a public key as hex: what a pin keeps of a contact's ML-KEM key instead of 1184 bytes.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn key_digest(public_key: Vec<u8>) -> String {
    Sha256::digest(&public_key).iter().map(|b| format!("{b:02x}")).collect()
}

fn settings_key(identity_private_key: &[u8]) -> CoreResult<Zeroizing<[u8; KEY_BYTES]>> {
    expect_len("identity private key", identity_private_key, 32)
        .map_err(|_| input("Invalid identity key."))?;
    let mut key = Zeroizing::new([0u8; KEY_BYTES]);
    Hkdf::<Sha256>::new(Some(&[0u8; 32]), identity_private_key)
        .expand(b"hushos/settings/v1", key.as_mut())
        .map_err(|_| input("HKDF failed"))?;
    Ok(key)
}

/// Settings are padded with trailing spaces (which JSON ignores) to 1 KiB
/// steps before sealing, as the web pads them, so the envelope's length says
/// little about how many people are pinned or what the ledger holds; the
/// server refuses an envelope that is not.
pub const SETTINGS_PAD_STEP: usize = 1024;

fn padded_settings(json: &str) -> Zeroizing<Vec<u8>> {
    let target = json.len().div_ceil(SETTINGS_PAD_STEP).max(1) * SETTINGS_PAD_STEP;
    let mut out = Zeroizing::new(Vec::with_capacity(target));
    out.extend_from_slice(json.as_bytes());
    out.resize(target.min(SETTINGS_MAX_BYTES).max(json.len()), b' ');
    out
}

fn settings_context(user_id: &str, settings_version: u64) -> Vec<u8> {
    context(&[json!("hushos/settings"), json!(1), json!(user_id.to_lowercase()), json!(settings_version)])
}

/// Seals the settings JSON (`{"version":1,"contacts":{...}}`) at the version
/// the caller will send as the next one; the server accepts it only if the
/// stored version is the one the caller read.
///
/// ```
/// use hushos_core::{settings_open, settings_seal};
/// let key = vec![9u8; 32];
/// let sealed = settings_seal(key.clone(), "User-1".into(), 3, r#"{"version":1,"contacts":{}}"#.into())?;
/// assert_eq!(sealed.settings_version, 3);
/// assert_eq!(settings_open(key, "user-1".into(), sealed)?, r#"{"version":1,"contacts":{}}"#);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn settings_seal(
    identity_private_key: Vec<u8>,
    user_id: String,
    settings_version: u64,
    json: String,
) -> CoreResult<SettingsEnvelope> {
    if settings_version < 1 {
        return Err(input("Invalid settings version."));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&json).map_err(|_| input("Settings are not JSON."))?;
    if parsed["version"] != json!(1) || !parsed["contacts"].is_object() {
        return Err(input("Unsupported settings document."));
    }
    if json.len() > SETTINGS_MAX_BYTES {
        return Err(input("Settings are too large."));
    }
    let key = settings_key(&identity_private_key)?;
    let nonce = random(NONCE_BYTES);
    let sealed = seal_with_nonce(
        key.as_slice(),
        &nonce,
        &padded_settings(&json),
        &settings_context(&user_id, settings_version),
    )?;
    Ok(SettingsEnvelope { version: 1, settings_version, nonce: encode(&nonce), ciphertext: encode(&sealed) })
}

/// The settings JSON out of its envelope.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn settings_open(
    identity_private_key: Vec<u8>,
    user_id: String,
    envelope: SettingsEnvelope,
) -> CoreResult<String> {
    if envelope.version != 1 || envelope.settings_version < 1 {
        return Err(input("Unsupported settings envelope."));
    }
    let key = settings_key(&identity_private_key)?;
    let plaintext = open_with_nonce(
        key.as_slice(),
        &decode("nonce", &envelope.nonce, Some(NONCE_BYTES))?,
        &decode("ciphertext", &envelope.ciphertext, None)?,
        &settings_context(&user_id, envelope.settings_version),
    )?;
    let mut text = String::from_utf8(plaintext)
        .map_err(|_| CoreError::Sealed("Unsupported settings document.".into()))?;
    text.truncate(text.trim_end_matches(' ').len());
    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| CoreError::Sealed("Unsupported settings document.".into()))?;
    if parsed["version"] != json!(1) || !parsed["contacts"].is_object() {
        return Err(CoreError::Sealed("Unsupported settings document.".into()));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::TAG_BYTES;

    #[test]
    fn the_fingerprint_is_the_web_layout_and_changes_with_either_key() {
        // The same vector packages/crypto's fingerprint.test.ts checks: both clients must agree.
        let a = identity_fingerprint(vec![1u8; 32], vec![2u8; 32]).unwrap();
        assert_eq!(a, "8e5f 7614 6df7 df81 0a13 a5aa 35c7 ac7d b5db 2e38");
        assert_ne!(
            a,
            identity_fingerprint(vec![1u8; 32], vec![3u8; 32]).unwrap(),
            "a swapped signing key must show"
        );
        assert_ne!(a, identity_fingerprint(vec![4u8; 32], vec![2u8; 32]).unwrap());
        assert!(matches!(identity_fingerprint(vec![1u8; 31], vec![2u8; 32]), Err(CoreError::Input(_))));
        assert!(matches!(identity_fingerprint(vec![1u8; 32], vec![2u8; 31]), Err(CoreError::Input(_))));
        assert_eq!(key_digest(vec![]).len(), 64);
    }

    #[test]
    fn settings_open_only_for_the_same_identity_user_and_version() {
        let key = random(32);
        let sealed =
            settings_seal(key.clone(), "u".into(), 2, r#"{"version":1,"contacts":{"x":{}}}"#.into()).unwrap();
        assert!(matches!(settings_open(random(32), "u".into(), sealed.clone()), Err(CoreError::Sealed(_))));
        assert!(matches!(settings_open(key.clone(), "v".into(), sealed.clone()), Err(CoreError::Sealed(_))));
        let mut bumped = sealed.clone();
        bumped.settings_version = 3;
        assert!(matches!(settings_open(key.clone(), "u".into(), bumped), Err(CoreError::Sealed(_))));
        assert_eq!(settings_open(key, "U".into(), sealed).unwrap(), r#"{"version":1,"contacts":{"x":{}}}"#);
    }

    #[test]
    fn settings_are_padded_to_whole_kibibytes_and_open_without_the_padding() {
        let key = random(32);
        let small = r#"{"version":1,"contacts":{}}"#;
        let mut larger = String::from(r#"{"version":1,"contacts":{},"note":""#);
        larger.push_str(&"x".repeat(1500));
        larger.push_str(r#""}"#);
        for json in [small, larger.as_str()] {
            let sealed = settings_seal(key.clone(), "u".into(), 1, json.into()).unwrap();
            let body = decode("ciphertext", &sealed.ciphertext, None).unwrap().len() - TAG_BYTES;
            assert_eq!(body % SETTINGS_PAD_STEP, 0, "{body} bytes is not a whole step");
            assert_eq!(settings_open(key.clone(), "u".into(), sealed).unwrap(), json);
        }
        // Two documents of different sizes in the same step are the same length on the wire.
        let a = settings_seal(key.clone(), "u".into(), 1, small.into()).unwrap();
        let b =
            settings_seal(key, "u".into(), 1, r#"{"version":1,"contacts":{"someone":{}}}"#.into()).unwrap();
        assert_eq!(a.ciphertext.len(), b.ciphertext.len());
    }

    #[test]
    fn malformed_or_oversized_settings_are_refused_before_sealing() {
        let key = random(32);
        assert!(matches!(
            settings_seal(key.clone(), "u".into(), 1, "not json".into()),
            Err(CoreError::Input(_))
        ));
        assert!(matches!(
            settings_seal(key.clone(), "u".into(), 1, r#"{"version":2,"contacts":{}}"#.into()),
            Err(CoreError::Input(_))
        ));
        assert!(matches!(
            settings_seal(key.clone(), "u".into(), 0, r#"{"version":1,"contacts":{}}"#.into()),
            Err(CoreError::Input(_))
        ));
        let huge = format!(r#"{{"version":1,"contacts":{{"a":"{}"}}}}"#, "x".repeat(SETTINGS_MAX_BYTES));
        assert!(matches!(settings_seal(key, "u".into(), 1, huge), Err(CoreError::Input(_))));
    }
}
