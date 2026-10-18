//! Contacts: the fingerprint two people compare before trusting a key
//! (version 3, over all four public keys), and the account settings document
//! that keeps the pins, exactly as `packages/crypto/contacts.ts` writes it. Version 2 is sealed under a random
//! settings key wrapped under the account root. Version 1, under a key off the
//! identity's X25519 private key (which a stolen identity key opened), is
//! neither written nor read: it opens as no settings. The server stores the
//! envelope and a version for compare-and-set.

use crate::bytes::{decode, encode, expect_len, random, SecretBytes, KEY_BYTES, NONCE_BYTES};
use crate::envelope::{context, open_with_nonce, seal_with_nonce};
use crate::error::{input, CoreError, CoreResult};
use crate::identity::KEM_PUBLIC_KEY_BYTES;
use crate::pq::ML_DSA_PUBLIC_KEY_BYTES;
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

/// What two people read to each other over another channel before trusting
/// a key the server handed them (version 3, docs/identity-pq-design.md):
/// SHA-256 over a domain prefix, the identity's X25519 and Ed25519 public keys
/// and the SHA-256 digests of its ML-DSA and ML-KEM public keys, the first 20
/// bytes as ten groups of four hex digits. The two lattice keys enter by their
/// digests, which is what a pin keeps of them ([`key_digest`], as bytes).
/// Covering the ML-DSA key is what makes the words post-quantum: a key only
/// Ed25519 vouched for would fall with Ed25519.
///
/// ```
/// let print = hushos_core::identity_fingerprint(vec![1u8; 32], vec![2u8; 32], vec![3u8; 32], vec![4u8; 32])?;
/// assert_eq!(print, "8b16 2a14 2a5b cb5b 1070 8017 ae93 b2e6 b496 7640");
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn identity_fingerprint(
    encryption_public_key: Vec<u8>,
    signing_public_key: Vec<u8>,
    ml_dsa_public_key_digest: Vec<u8>,
    kem_public_key_digest: Vec<u8>,
) -> CoreResult<String> {
    for part in
        [&encryption_public_key, &signing_public_key, &ml_dsa_public_key_digest, &kem_public_key_digest]
    {
        expect_len("identity key", part, 32).map_err(|_| input("Invalid identity key."))?;
    }
    let mut hasher = Sha256::new();
    hasher.update(b"hushos/identity/fingerprint/v3");
    hasher.update(&encryption_public_key);
    hasher.update(&signing_public_key);
    hasher.update(&ml_dsa_public_key_digest);
    hasher.update(&kem_public_key_digest);
    let digest = hasher.finalize();
    let hex: String = digest[..20].iter().map(|b| format!("{b:02x}")).collect();
    Ok(hex.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).expect("hex")).collect::<Vec<_>>().join(" "))
}

/// The version 3 fingerprint from the four public keys themselves, digesting
/// the ML-DSA (1952 bytes) and ML-KEM (1184 bytes) keys.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn identity_fingerprint_of_keys(
    encryption_public_key: Vec<u8>,
    signing_public_key: Vec<u8>,
    ml_dsa_public_key: Vec<u8>,
    kem_public_key: Vec<u8>,
) -> CoreResult<String> {
    if ml_dsa_public_key.len() != ML_DSA_PUBLIC_KEY_BYTES || kem_public_key.len() != KEM_PUBLIC_KEY_BYTES {
        return Err(input("Invalid identity key."));
    }
    identity_fingerprint(
        encryption_public_key,
        signing_public_key,
        Sha256::digest(&ml_dsa_public_key).to_vec(),
        Sha256::digest(&kem_public_key).to_vec(),
    )
}

/// SHA-256 of a public key as lowercase hex: what a version 3 pin keeps of a
/// contact's ML-DSA and ML-KEM keys instead of 3 KB.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn key_digest(public_key: Vec<u8>) -> String {
    Sha256::digest(&public_key).iter().map(|b| format!("{b:02x}")).collect()
}

/// A 32-byte key digest as a contact pin keeps it (lowercase hex) from the
/// base64url a group statement or group pin carries it as. Contact pins and
/// group pins are only ever compared through these, as the same bytes.
///
/// ```
/// let hex = "07".repeat(32);
/// let base64url = hushos_core::digest_base64url(hex.clone())?;
/// assert_eq!(hushos_core::digest_hex(base64url.clone())?, hex);
/// assert!(hushos_core::same_key_digest(Some(hex), base64url));
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn digest_hex(base64url: String) -> CoreResult<String> {
    Ok(decode("key digest", &base64url, Some(32))
        .map_err(|_| input("Invalid key digest."))?
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// The base64url of a 32-byte key digest kept as lowercase hex; see [`digest_hex`].
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn digest_base64url(hex: String) -> CoreResult<String> {
    digest_bytes(&hex).map(|bytes| encode(&bytes)).ok_or_else(|| input("Invalid key digest."))
}

/// Whether a pin's hex digest and a statement's base64url digest name the same key; malformed is never.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn same_key_digest(hex: Option<String>, base64url: String) -> bool {
    hex.is_some_and(|hex| digest_hex(base64url).is_ok_and(|ours| ours == hex))
}

/* Lowercase hex to bytes, refusing anything but a 32-byte digest. */
fn digest_bytes(hex: &str) -> Option<Vec<u8>> {
    if hex.len() != 64 || !hex.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        return None;
    }
    (0..64).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok()).collect()
}

/// Whether a pin stands for a words check over the keys it holds: a version 3
/// pin, carrying the X25519 and Ed25519 keys (base64url), the hex digests of
/// the ML-DSA and ML-KEM keys, and the version 3 fingerprint over all four.
/// Pins made before (version 2, without the ML-DSA digest) trust nothing until
/// the two people compare words again, whatever the server serves.
///
/// ```
/// use hushos_core::*;
/// let (x, ed, ml_dsa, kem) = (vec![1u8; 32], vec![2u8; 32], vec![3u8; 1952], vec![4u8; 1184]);
/// let print = identity_fingerprint_of_keys(x.clone(), ed.clone(), ml_dsa.clone(), kem.clone())?;
/// let (x, ed) = (base64url_encode(x), base64url_encode(ed));
/// assert!(pin_verified(x.clone(), ed.clone(), Some(key_digest(ml_dsa)), Some(key_digest(kem.clone())), print.clone()));
/// // A version 2 pin, without the ML-DSA digest, trusts nothing.
/// assert!(!pin_verified(x, ed, None, Some(key_digest(kem)), print));
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn pin_verified(
    encryption_public_key: String,
    signing_public_key: String,
    ml_dsa_public_key_hash: Option<String>,
    kem_public_key_hash: Option<String>,
    fingerprint: String,
) -> bool {
    let check = || -> Option<bool> {
        let print = identity_fingerprint(
            decode("encryptionPublicKey", &encryption_public_key, Some(32)).ok()?,
            decode("signingPublicKey", &signing_public_key, Some(32)).ok()?,
            digest_bytes(ml_dsa_public_key_hash.as_deref()?)?,
            digest_bytes(kem_public_key_hash.as_deref()?)?,
        )
        .ok()?;
        Some(print == fingerprint)
    };
    check().unwrap_or(false)
}

pub(crate) fn hkdf(ikm: &[u8], info: &[u8]) -> CoreResult<Zeroizing<[u8; KEY_BYTES]>> {
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

pub(crate) fn settings_context(user_id: &str, version: u32, settings_version: u64) -> Vec<u8> {
    context(&[
        json!("hushos/settings"),
        json!(version),
        json!(user_id.to_lowercase()),
        json!(settings_version),
    ])
}

/// Seals the settings JSON (`{"version":2,"contacts":{...}}`) as envelope
/// version 2 under the settings key, at the settings version the caller will
/// send as the next one; the server accepts it only if the stored version is
/// the one the caller read. The document is always written as version 2, the
/// only one that may hold version 3 pins: one read as version 1 is sealed
/// with its version raised (and its keys re-serialised in serde_json's order).
///
/// ```
/// use hushos_core::{settings_open, settings_seal};
/// let key = vec![9u8; 32];
/// let sealed = settings_seal("User-1".into(), key.clone(), 3, r#"{"version":2,"contacts":{}}"#.into())?;
/// assert_eq!((sealed.version, sealed.settings_version), (2, 3));
/// assert_eq!(settings_open("user-1".into(), Some(key.clone()), sealed)?.as_deref(), Some(r#"{"version":2,"contacts":{}}"#));
/// let raised = settings_seal("User-1".into(), key.clone(), 4, r#"{"version":1,"contacts":{}}"#.into())?;
/// assert_eq!(settings_open("user-1".into(), Some(key), raised)?.as_deref(), Some(r#"{"contacts":{},"version":2}"#));
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

/* A settings document's version: 1 or 2 when read, with its contacts an object; anything else is none. */
fn document_version(parsed: &serde_json::Value) -> Option<u64> {
    match parsed["version"].as_u64() {
        Some(version @ (1 | 2)) if parsed["contacts"].is_object() => Some(version),
        _ => None,
    }
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
    let mut parsed: serde_json::Value =
        serde_json::from_str(json).map_err(|_| input("Settings are not JSON."))?;
    let raised;
    let json = match document_version(&parsed) {
        Some(2) => json,
        Some(_) => {
            // Always written as version 2, whatever was read (docs/envelope-migrations.md 2).
            parsed["version"] = json!(2);
            raised = parsed.to_string();
            raised.as_str()
        }
        None => return Err(input("Unsupported settings document.")),
    };
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

/// Any plaintext sealed as a version 2 settings envelope, padded as the real
/// one is, for the shared fixtures only: documents [`settings_seal`] refuses
/// to write (another version, `contacts` null) must still reach the readers.
#[cfg(feature = "fixtures")]
#[doc(hidden)]
pub fn settings_seal_raw(
    user_id: &str,
    settings_key: &[u8],
    settings_version: u64,
    text: &str,
) -> CoreResult<SettingsEnvelope> {
    let nonce = random(NONCE_BYTES);
    let sealed = seal_with_nonce(
        settings_key,
        &nonce,
        &padded_settings(text),
        &settings_context(user_id, 2, settings_version),
    )?;
    Ok(SettingsEnvelope { version: 2, settings_version, nonce: encode(&nonce), ciphertext: encode(&sealed) })
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
    if document_version(&parsed).is_none() {
        return Err(CoreError::Sealed("Unsupported settings document.".into()));
    }
    Ok(Some(text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::TAG_BYTES;

    #[test]
    fn the_fingerprint_is_the_web_s_version_3_and_changes_with_any_of_the_four_keys() {
        // The same vector packages/crypto's fingerprint.test.ts checks: both clients must agree.
        let keys = || [vec![1u8; 32], vec![2u8; 32], vec![3u8; 32], vec![4u8; 32]];
        let print = |[a, b, c, d]: [Vec<u8>; 4]| identity_fingerprint(a, b, c, d);
        let a = print(keys()).unwrap();
        assert_eq!(a, "8b16 2a14 2a5b cb5b 1070 8017 ae93 b2e6 b496 7640");
        for at in 0..4 {
            let mut changed = keys();
            changed[at][0] ^= 1;
            assert_ne!(print(changed).unwrap(), a, "key {at} must show, the ML-KEM key's included");
            let mut short = keys();
            short[at].pop();
            assert!(matches!(print(short), Err(CoreError::Input(_))), "key {at}");
        }
        // The lattice keys enter by their SHA-256.
        let (ml_dsa, kem) = (vec![5u8; ML_DSA_PUBLIC_KEY_BYTES], vec![6u8; KEM_PUBLIC_KEY_BYTES]);
        assert_eq!(
            identity_fingerprint_of_keys(vec![1; 32], vec![2; 32], ml_dsa.clone(), kem.clone()).unwrap(),
            identity_fingerprint(
                vec![1; 32],
                vec![2; 32],
                Sha256::digest(&ml_dsa).to_vec(),
                Sha256::digest(&kem).to_vec()
            )
            .unwrap()
        );
        // A digest is not a key: the full-key form refuses one.
        assert!(identity_fingerprint_of_keys(vec![1; 32], vec![2; 32], vec![3; 32], kem).is_err());
        assert_eq!(
            key_digest(b"abc".to_vec()),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn a_pin_is_verified_only_as_version_3_with_its_own_fingerprint() {
        let (x, ed) = (vec![1u8; 32], vec![2u8; 32]);
        let (ml_dsa, kem) = (vec![3u8; ML_DSA_PUBLIC_KEY_BYTES], vec![4u8; KEM_PUBLIC_KEY_BYTES]);
        let print = identity_fingerprint_of_keys(x.clone(), ed.clone(), ml_dsa.clone(), kem.clone()).unwrap();
        let pin = |ml: Option<String>, k: Option<String>, f: &str| {
            pin_verified(encode(&x), encode(&ed), ml, k, f.into())
        };
        let (ml_hash, kem_hash) = (key_digest(ml_dsa.clone()), key_digest(kem.clone()));
        assert!(pin(Some(ml_hash.clone()), Some(kem_hash.clone()), &print));
        // Version 2 pins (no ML-DSA digest), no KEM digest, another key's digest, or a version 2 fingerprint.
        assert!(!pin(None, Some(kem_hash.clone()), &print));
        assert!(!pin(Some(ml_hash.clone()), None, &print));
        assert!(!pin(Some(key_digest(kem.clone())), Some(kem_hash.clone()), &print));
        assert!(!pin(Some(ml_hash.to_uppercase()), Some(kem_hash.clone()), &print), "hex is lowercase");
        assert!(!pin(
            Some(ml_hash.clone()),
            Some(kem_hash.clone()),
            "8e5f 7614 6df7 df81 0a13 a5aa 35c7 ac7d b5db 2e38"
        ));
        assert!(!pin_verified(encode(&x), encode(&x), Some(ml_hash), Some(kem_hash), print));
    }

    const EMPTY: &str = r#"{"version":2,"contacts":{}}"#;

    #[test]
    fn version_2_opens_only_with_the_same_key_user_and_version() {
        let key = random(32);
        let sealed =
            settings_seal("u".into(), key.clone(), 2, r#"{"version":2,"contacts":{"x":{}}}"#.into()).unwrap();
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
            Some(r#"{"version":2,"contacts":{"x":{}}}"#)
        );
    }

    #[test]
    fn a_document_read_as_version_1_is_sealed_as_version_2_and_both_open() {
        let key = random(32);
        let legacy = r#"{"version":1,"contacts":{"x":{"name":"X","pinnedAt":"t"}},"sharing":{"shares":{},"links":{}}}"#;
        let sealed = settings_seal("u".into(), key.clone(), 2, legacy.into()).unwrap();
        let opened = settings_open("u".into(), Some(key.clone()), sealed).unwrap().unwrap();
        let mut expected: serde_json::Value = serde_json::from_str(legacy).unwrap();
        expected["version"] = json!(2);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&opened).unwrap(),
            expected,
            "only the version changed"
        );
        // A version 1 document inside a version 2 envelope, as clients sealed them before, still opens.
        let older =
            seal_with_nonce(&key, &[7; NONCE_BYTES], &padded_settings(legacy), &settings_context("u", 2, 3))
                .unwrap();
        let envelope = SettingsEnvelope {
            version: 2,
            settings_version: 3,
            nonce: encode(&[7; NONCE_BYTES]),
            ciphertext: encode(&older),
        };
        assert_eq!(settings_open("u".into(), Some(key.clone()), envelope).unwrap().as_deref(), Some(legacy));
        // A version 3 document, from a client that knows more than this one, is refused whole.
        let newer = seal_with_nonce(
            &key,
            &[7; NONCE_BYTES],
            &padded_settings(r#"{"version":3,"contacts":{}}"#),
            &settings_context("u", 2, 3),
        )
        .unwrap();
        let envelope = SettingsEnvelope {
            version: 2,
            settings_version: 3,
            nonce: encode(&[7; NONCE_BYTES]),
            ciphertext: encode(&newer),
        };
        assert!(matches!(settings_open("u".into(), Some(key), envelope), Err(CoreError::Sealed(_))));
    }

    #[test]
    fn fifty_version_3_pins_fit_under_the_cap() {
        let key = random(32);
        let contacts: serde_json::Map<String, serde_json::Value> = (0..50)
            .map(|i| {
                let id = format!("{i:08x}-1111-4111-8111-111111111111");
                let pin = json!({
                    "userId": id, "email": format!("person{i}@example.com"), "name": format!("Person {i}"),
                    "encryptionPublicKey": encode(&random(32)), "signingPublicKey": encode(&random(32)),
                    "mlDsaPublicKeyHash": key_digest(random(ML_DSA_PUBLIC_KEY_BYTES)),
                    "kemPublicKeyHash": key_digest(random(KEM_PUBLIC_KEY_BYTES)),
                    "fingerprint": "8b16 2a14 2a5b cb5b 1070 8017 ae93 b2e6 b496 7640",
                    "pinnedAt": "2026-10-15T00:00:00.000Z", "keyVersion": 1,
                });
                (id, pin)
            })
            .collect();
        let document = json!({ "version": 2, "contacts": contacts }).to_string();
        let sealed = settings_seal("u".into(), key.clone(), 1, document.clone()).unwrap();
        assert_eq!(settings_open("u".into(), Some(key), sealed).unwrap(), Some(document));
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
        let mut larger = String::from(r#"{"version":2,"contacts":{},"note":""#);
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
            settings_seal("u".into(), key, 1, r#"{"version":2,"contacts":{"someone":{}}}"#.into()).unwrap();
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
            settings_seal("u".into(), key.clone(), 1, r#"{"version":3,"contacts":{}}"#.into()),
            Err(CoreError::Input(_))
        ));
        assert!(matches!(
            settings_seal("u".into(), key.clone(), 1, r#"{"version":2,"contacts":[]}"#.into()),
            Err(CoreError::Input(_))
        ));
        assert!(matches!(settings_seal("u".into(), key.clone(), 0, EMPTY.into()), Err(CoreError::Input(_))));
        assert!(matches!(settings_seal("u".into(), random(31), 1, EMPTY.into()), Err(CoreError::Input(_))));
        let huge = format!(r#"{{"version":2,"contacts":{{"a":"{}"}}}}"#, "x".repeat(SETTINGS_MAX_BYTES));
        assert!(matches!(settings_seal("u".into(), key, 1, huge), Err(CoreError::Input(_))));
    }
}
