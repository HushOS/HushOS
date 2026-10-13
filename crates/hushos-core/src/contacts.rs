//! Contacts: the fingerprint two people compare before trusting a key, and
//! the account settings document that keeps the pins, exactly as
//! `packages/crypto/contacts.ts` writes it. Version 2 is sealed under a random
//! settings key wrapped under the account root. Version 1, under a key off the
//! identity's X25519 private key (which a stolen identity key opened), is
//! neither written nor read: it opens as no settings. The server stores the
//! envelope and a version for compare-and-set.

use crate::bytes::{decode, encode, expect_len, random, SecretBytes, KEY_BYTES, NONCE_BYTES};
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

fn hkdf(ikm: &[u8], info: &[u8]) -> CoreResult<Zeroizing<[u8; KEY_BYTES]>> {
    let mut key = Zeroizing::new([0u8; KEY_BYTES]);
    Hkdf::<Sha256>::new(Some(&[0u8; 32]), ikm)
        .expand(info, key.as_mut())
        .map_err(|_| input("HKDF failed"))?;
    Ok(key)
}

/// The settings key as the server keeps it: wrapped under the account root.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SettingsKeyEnvelope {
    /// 24 bytes.
    pub nonce: String,
    /// 48 bytes: the 32-byte key and its tag.
    pub ciphertext: String,
}

/// A fresh settings key and its envelope.
#[derive(Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct CreatedSettingsKey {
    pub key: SecretBytes,
    /// Store once with `PUT /api/auth/settings-key`; on 409 open the stored one instead.
    pub envelope: SettingsKeyEnvelope,
}

impl std::fmt::Debug for CreatedSettingsKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreatedSettingsKey")
            .field("key", &crate::bytes::Redacted)
            .field("envelope", &self.envelope)
            .finish()
    }
}

fn wrap_settings_key(user_id: &str, account_key: &[u8], key: &[u8]) -> CoreResult<SettingsKeyEnvelope> {
    expect_len("accountKey", account_key, KEY_BYTES)?;
    let wrap = hkdf(account_key, b"hushos/settings-key-wrap/v1")?;
    let nonce = random(NONCE_BYTES);
    let sealed = seal_with_nonce(wrap.as_slice(), &nonce, key, user_id.to_lowercase().as_bytes())?;
    Ok(SettingsKeyEnvelope { nonce: encode(&nonce), ciphertext: encode(&sealed) })
}

/// A random settings key, wrapped under the account key
/// (`HKDF(root, zeros, "hushos/settings-key-wrap/v1")`, XChaCha20-Poly1305,
/// the lowercase user id as associated data).
///
/// ```
/// use hushos_core::{random_bytes, settings_key_create, settings_key_open};
/// let root = random_bytes(32)?;
/// let made = settings_key_create("User-1".into(), root.clone())?;
/// assert_eq!(settings_key_open("user-1".into(), root, made.envelope)?, made.key);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn settings_key_create(user_id: String, account_key: Vec<u8>) -> CoreResult<CreatedSettingsKey> {
    let key = random(KEY_BYTES);
    Ok(CreatedSettingsKey { envelope: wrap_settings_key(&user_id, &account_key, &key)?, key: key.into() })
}

/// The settings key out of its envelope, under the account key.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn settings_key_open(
    user_id: String,
    account_key: Vec<u8>,
    envelope: SettingsKeyEnvelope,
) -> CoreResult<Vec<u8>> {
    expect_len("accountKey", &account_key, KEY_BYTES)?;
    let wrap = hkdf(&account_key, b"hushos/settings-key-wrap/v1")?;
    let key = open_with_nonce(
        wrap.as_slice(),
        &decode("nonce", &envelope.nonce, Some(NONCE_BYTES))?,
        &decode("ciphertext", &envelope.ciphertext, Some(KEY_BYTES + 16))?,
        user_id.to_lowercase().as_bytes(),
    )?;
    expect_len("settings key", &key, KEY_BYTES)?;
    Ok(key)
}

/// The same settings key under a new account key, for a master-key rotation.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn settings_key_rewrap(
    user_id: String,
    old_root: Vec<u8>,
    new_root: Vec<u8>,
    envelope: SettingsKeyEnvelope,
) -> CoreResult<SettingsKeyEnvelope> {
    let key = Zeroizing::new(settings_key_open(user_id.clone(), old_root, envelope)?);
    wrap_settings_key(&user_id, &new_root, &key)
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

fn settings_context(user_id: &str, version: u32, settings_version: u64) -> Vec<u8> {
    context(&[
        json!("hushos/settings"),
        json!(version),
        json!(user_id.to_lowercase()),
        json!(settings_version),
    ])
}

/// Seals the settings JSON (`{"version":1,"contacts":{...}}`) as envelope
/// version 2 under the settings key, at the settings version the caller will
/// send as the next one; the server accepts it only if the stored version is
/// the one the caller read.
///
/// ```
/// use hushos_core::{settings_open, settings_seal};
/// let key = vec![9u8; 32];
/// let sealed = settings_seal("User-1".into(), key.clone(), 3, r#"{"version":1,"contacts":{}}"#.into())?;
/// assert_eq!((sealed.version, sealed.settings_version), (2, 3));
/// assert_eq!(settings_open("user-1".into(), Some(key), sealed)?.as_deref(), Some(r#"{"version":1,"contacts":{}}"#));
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn settings_seal(
    user_id: String,
    settings_key: Vec<u8>,
    settings_version: u64,
    json: String,
) -> CoreResult<SettingsEnvelope> {
    expect_len("settings key", &settings_key, KEY_BYTES)?;
    seal_settings(&settings_key, &user_id, 2, settings_version, &json)
}

fn seal_settings(
    key: &[u8],
    user_id: &str,
    version: u32,
    settings_version: u64,
    json: &str,
) -> CoreResult<SettingsEnvelope> {
    if settings_version < 1 {
        return Err(input("Invalid settings version."));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(json).map_err(|_| input("Settings are not JSON."))?;
    if parsed["version"] != json!(1) || !parsed["contacts"].is_object() {
        return Err(input("Unsupported settings document."));
    }
    if json.len() > SETTINGS_MAX_BYTES {
        return Err(input("Settings are too large."));
    }
    let nonce = random(NONCE_BYTES);
    let sealed = seal_with_nonce(
        key,
        &nonce,
        &padded_settings(json),
        &settings_context(user_id, version, settings_version),
    )?;
    Ok(SettingsEnvelope { version, settings_version, nonce: encode(&nonce), ciphertext: encode(&sealed) })
}

/// The settings JSON out of a version 2 envelope, under the settings key.
/// A version 1 envelope is `None`: it is not opened (a stolen identity key
/// opened those), and the app treats it as no settings, subject to its own
/// rollback mark. Any other version, or version 2 without the key, refuses.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn settings_open(
    user_id: String,
    settings_key: Option<Vec<u8>>,
    envelope: SettingsEnvelope,
) -> CoreResult<Option<String>> {
    if envelope.settings_version < 1 {
        return Err(input("Unsupported settings envelope."));
    }
    let key: Zeroizing<[u8; KEY_BYTES]> = match envelope.version {
        1 => return Ok(None),
        2 => {
            let key = Zeroizing::new(settings_key.ok_or_else(|| input("Open your settings key first."))?);
            Zeroizing::new(key.as_slice().try_into().map_err(|_| input("Invalid settings key."))?)
        }
        _ => return Err(input("Unsupported settings envelope.")),
    };
    let plaintext = Zeroizing::new(open_with_nonce(
        key.as_slice(),
        &decode("nonce", &envelope.nonce, Some(NONCE_BYTES))?,
        &decode("ciphertext", &envelope.ciphertext, None)?,
        &settings_context(&user_id, envelope.version, envelope.settings_version),
    )?);
    let mut text = String::from_utf8(plaintext.to_vec())
        .map_err(|_| CoreError::Sealed("Unsupported settings document.".into()))?;
    text.truncate(text.trim_end_matches(' ').len());
    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| CoreError::Sealed("Unsupported settings document.".into()))?;
    if parsed["version"] != json!(1) || !parsed["contacts"].is_object() {
        return Err(CoreError::Sealed("Unsupported settings document.".into()));
    }
    Ok(Some(text))
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

    const EMPTY: &str = r#"{"version":1,"contacts":{}}"#;

    #[test]
    fn version_2_opens_only_with_the_same_key_user_and_version() {
        let key = random(32);
        let sealed =
            settings_seal("u".into(), key.clone(), 2, r#"{"version":1,"contacts":{"x":{}}}"#.into()).unwrap();
        assert_eq!(sealed.version, 2);
        assert!(matches!(
            settings_open("u".into(), Some(random(32)), sealed.clone()),
            Err(CoreError::Sealed(_))
        ));
        assert!(matches!(
            settings_open("v".into(), Some(key.clone()), sealed.clone()),
            Err(CoreError::Sealed(_))
        ));
        let mut bumped = sealed.clone();
        bumped.settings_version = 3;
        assert!(matches!(settings_open("u".into(), Some(key.clone()), bumped), Err(CoreError::Sealed(_))));
        // The same bytes presented as version 1 are not opened at all: no settings.
        let as_legacy = SettingsEnvelope { version: 1, ..sealed.clone() };
        assert_eq!(settings_open("u".into(), Some(key.clone()), as_legacy).unwrap(), None);
        assert!(matches!(settings_open("u".into(), None, sealed.clone()), Err(CoreError::Input(_))));
        let as_three = SettingsEnvelope { version: 3, ..sealed.clone() };
        assert!(matches!(settings_open("u".into(), Some(key.clone()), as_three), Err(CoreError::Input(_))));
        assert_eq!(
            settings_open("U".into(), Some(key), sealed).unwrap().as_deref(),
            Some(r#"{"version":1,"contacts":{"x":{}}}"#)
        );
    }

    #[test]
    fn version_1_no_longer_opens_and_reads_as_no_settings() {
        // A genuine version 1 document, under the key a stolen identity key derives.
        let identity = random(32);
        let legacy_key = hkdf(&identity, b"hushos/settings/v1").unwrap();
        let legacy = seal_settings(legacy_key.as_slice(), "u", 1, 4, EMPTY).unwrap();
        assert_eq!(settings_open("u".into(), None, legacy.clone()).unwrap(), None);
        assert_eq!(settings_open("u".into(), Some(legacy_key.to_vec()), legacy.clone()).unwrap(), None);
        // Relabelled as version 2 it is refused, never read under the identity's key.
        let relabelled = SettingsEnvelope { version: 2, ..legacy };
        assert!(settings_open("u".into(), Some(legacy_key.to_vec()), relabelled).is_err());
    }

    #[test]
    fn the_settings_key_opens_under_its_root_and_account_and_follows_a_rotation() {
        let root = random(32);
        let made = settings_key_create("u".into(), root.clone()).unwrap();
        assert_eq!(decode("c", &made.envelope.ciphertext, None).unwrap().len(), 48);
        assert!(!format!("{made:?}").contains(&encode(&made.key)));
        assert_eq!(settings_key_open("U".into(), root.clone(), made.envelope.clone()).unwrap(), made.key);
        assert!(settings_key_open("v".into(), root.clone(), made.envelope.clone()).is_err());
        let next = random(32);
        assert!(settings_key_open("u".into(), next.clone(), made.envelope.clone()).is_err());
        let rewrapped =
            settings_key_rewrap("u".into(), root.clone(), next.clone(), made.envelope.clone()).unwrap();
        assert_eq!(settings_key_open("u".into(), next.clone(), rewrapped.clone()).unwrap(), made.key);
        assert!(settings_key_open("u".into(), root.clone(), rewrapped).is_err());
        assert!(settings_key_rewrap("u".into(), next, root, made.envelope).is_err());
    }

    #[test]
    fn settings_are_padded_to_whole_kibibytes_and_open_without_the_padding() {
        let key = random(32);
        let mut larger = String::from(r#"{"version":1,"contacts":{},"note":""#);
        larger.push_str(&"x".repeat(1500));
        larger.push_str(r#""}"#);
        for json in [EMPTY, larger.as_str()] {
            let sealed = settings_seal("u".into(), key.clone(), 1, json.into()).unwrap();
            let body = decode("ciphertext", &sealed.ciphertext, None).unwrap().len() - TAG_BYTES;
            assert_eq!(body % SETTINGS_PAD_STEP, 0, "{body} bytes is not a whole step");
            assert_eq!(settings_open("u".into(), Some(key.clone()), sealed).unwrap().as_deref(), Some(json));
        }
        let a = settings_seal("u".into(), key.clone(), 1, EMPTY.into()).unwrap();
        let b =
            settings_seal("u".into(), key, 1, r#"{"version":1,"contacts":{"someone":{}}}"#.into()).unwrap();
        assert_eq!(a.ciphertext.len(), b.ciphertext.len());
    }

    #[test]
    fn malformed_or_oversized_settings_are_refused_before_sealing() {
        let key = random(32);
        assert!(matches!(
            settings_seal("u".into(), key.clone(), 1, "not json".into()),
            Err(CoreError::Input(_))
        ));
        assert!(matches!(
            settings_seal("u".into(), key.clone(), 1, r#"{"version":2,"contacts":{}}"#.into()),
            Err(CoreError::Input(_))
        ));
        assert!(matches!(settings_seal("u".into(), key.clone(), 0, EMPTY.into()), Err(CoreError::Input(_))));
        assert!(matches!(settings_seal("u".into(), random(31), 1, EMPTY.into()), Err(CoreError::Input(_))));
        let huge = format!(r#"{{"version":1,"contacts":{{"a":"{}"}}}}"#, "x".repeat(SETTINGS_MAX_BYTES));
        assert!(matches!(settings_seal("u".into(), key, 1, huge), Err(CoreError::Input(_))));
    }
}
