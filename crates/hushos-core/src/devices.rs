//! The device key (`docs/devices-design.md`, step 1): an Ed25519 key each app
//! installation makes for itself and uses to come back to its own device row
//! at the next sign-in. The app keeps the 32-byte seed in the Keychain or the
//! Keystore-backed preferences; this crate makes it, builds the statement and
//! signs it. The statement is the compact JSON the web and the server build:
//!
//! ```text
//! ["hushos/device/session",1,userId,deviceId,sha256(attemptToken)]
//! ```
//!
//! with ids lowercased and the digest the SHA-256 of the attempt token's UTF-8
//! bytes, base64url. The server consumes the attempt before it checks
//! anything, so a signature is good for one sign-in only.

use crate::bytes::{encode, random, SecretBytes};
use crate::envelope::context;
use crate::error::{input, CoreResult};
use crate::signatures::{sign, verify};
use ed25519_dalek::SigningKey;
use serde_json::json;
use sha2::{Digest as _, Sha256};
use zeroize::Zeroizing;

const DOMAIN: &str = "hushos/device/session";
const SEED_BYTES: usize = 32;

/// A new device key: the seed to keep on the device, and the public key to
/// register (`signingPublicKey`, base64url of these 32 bytes).
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct DeviceSigningKey {
    pub seed: SecretBytes,
    pub public_key: Vec<u8>,
}

fn public_key_of(seed: &[u8]) -> CoreResult<Vec<u8>> {
    if seed.len() != SEED_BYTES {
        return Err(input("A device key seed is 32 bytes."));
    }
    let seed = Zeroizing::new(<[u8; SEED_BYTES]>::try_from(seed).expect("32 bytes"));
    Ok(SigningKey::from_bytes(&seed).verifying_key().to_bytes().to_vec())
}

/// Makes a device key from fresh randomness.
///
/// ```
/// use hushos_core::*;
/// let key = device_signing_create()?;
/// assert_eq!((key.seed.len(), key.public_key.len()), (32, 32));
/// assert_ne!(device_signing_create()?.public_key, key.public_key);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn device_signing_create() -> CoreResult<DeviceSigningKey> {
    let seed = random(SEED_BYTES);
    let public_key = public_key_of(&seed)?;
    Ok(DeviceSigningKey { seed: SecretBytes::new(seed), public_key })
}

/// SHA-256 of the email trimmed and lowercased, base64url: kept beside the
/// device key, so the proof goes only with a sign-in to the account it was
/// made for, and the address itself is not stored.
///
/// ```
/// use hushos_core::device_email_hash;
/// assert_eq!(device_email_hash(" Maya@Example.org ".into()), device_email_hash("maya@example.org".into()));
/// assert_ne!(device_email_hash("maya@example.org".into()), device_email_hash("sam@example.org".into()));
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn device_email_hash(email: String) -> String {
    encode(&Sha256::digest(email.trim().to_lowercase().as_bytes()))
}

fn identifier(value: &str, what: &str) -> CoreResult<String> {
    if value.is_empty() {
        return Err(input(format!("Invalid {what}.")));
    }
    Ok(value.to_lowercase())
}

/// The bytes a device signs to come back to `device_id` of `user_id` in the
/// sign-in that `attempt_token` (from `login/start`) names.
///
/// ```
/// use hushos_core::device_session_statement;
/// let statement = device_session_statement("U".into(), "D".into(), "token".into())?;
/// assert!(String::from_utf8(statement)?.starts_with(r#"["hushos/device/session",1,"u","d",""#));
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn device_session_statement(
    user_id: String,
    device_id: String,
    attempt_token: String,
) -> CoreResult<Vec<u8>> {
    if attempt_token.is_empty() {
        return Err(input("Invalid sign-in attempt."));
    }
    Ok(context(&[
        json!(DOMAIN),
        json!(1),
        json!(identifier(&user_id, "user id")?),
        json!(identifier(&device_id, "device id")?),
        json!(encode(&Sha256::digest(attempt_token.as_bytes()))),
    ]))
}

/// The proof `login/finish` carries as `device.signature`: the device key's
/// signature over its session statement, base64url (64 bytes).
///
/// ```
/// use hushos_core::*;
/// let key = device_signing_create()?;
/// let signature = device_session_sign(key.seed.to_vec(), "u".into(), "d".into(), "attempt".into())?;
/// let bytes = base64url_decode(signature.clone())?;
/// assert!(device_session_verify(key.public_key.clone(), "u".into(), "d".into(), "attempt".into(), bytes.clone()));
/// // Good for that attempt only.
/// assert!(!device_session_verify(key.public_key, "u".into(), "d".into(), "another".into(), bytes));
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn device_session_sign(
    seed: Vec<u8>,
    user_id: String,
    device_id: String,
    attempt_token: String,
) -> CoreResult<String> {
    let seed = Zeroizing::new(seed);
    if seed.len() != SEED_BYTES {
        return Err(input("A device key seed is 32 bytes."));
    }
    let statement = device_session_statement(user_id, device_id, attempt_token)?;
    Ok(encode(&sign(&seed, &statement)?))
}

/// Whether `signature` is the device key `public_key`'s proof for this
/// attempt. The server checks the same; apps use it in tests.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn device_session_verify(
    public_key: Vec<u8>,
    user_id: String,
    device_id: String,
    attempt_token: String,
    signature: Vec<u8>,
) -> bool {
    device_session_statement(user_id, device_id, attempt_token)
        .map(|statement| verify(&public_key, &statement, &signature))
        .unwrap_or(false)
}

/// The public key of a stored device key seed, to check what is kept.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn device_signing_public_key(seed: Vec<u8>) -> CoreResult<Vec<u8>> {
    let seed = Zeroizing::new(seed);
    public_key_of(&seed)
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 8032, section 7.1, test 1: the seed and public key; the core derives the same key.
    const RFC_SEED: &str = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
    const RFC_PUBLIC: &str = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

    fn hex(value: &str) -> Vec<u8> {
        (0..value.len()).step_by(2).map(|i| u8::from_str_radix(&value[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn the_public_key_is_the_rfc_8032_one_for_its_seed() {
        assert_eq!(device_signing_public_key(hex(RFC_SEED)).unwrap(), hex(RFC_PUBLIC));
        assert!(device_signing_public_key(vec![1; 31]).is_err());
    }

    #[test]
    fn the_statement_is_lowercased_and_names_the_attempt_by_its_digest() {
        let statement = device_session_statement(
            "0F8FAD5B-D9CB-469F-A165-70867728950E".into(),
            "7C9E6679-7425-40DE-944B-E07FC1F90AE7".into(),
            "abc".into(),
        )
        .unwrap();
        // SHA-256("abc"), base64url without padding.
        assert_eq!(
            String::from_utf8(statement).unwrap(),
            r#"["hushos/device/session",1,"0f8fad5b-d9cb-469f-a165-70867728950e","7c9e6679-7425-40de-944b-e07fc1f90ae7","ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0"]"#
        );
    }

    #[test]
    fn a_proof_holds_for_its_own_account_device_and_attempt_only() {
        let key = device_signing_create().unwrap();
        let signature =
            base64url(&device_session_sign(key.seed.to_vec(), "u".into(), "d".into(), "a".into()).unwrap());
        let holds = |user: &str, device: &str, attempt: &str, public: &[u8]| {
            device_session_verify(
                public.to_vec(),
                user.into(),
                device.into(),
                attempt.into(),
                signature.clone(),
            )
        };
        assert!(holds("u", "d", "a", &key.public_key));
        assert!(!holds("v", "d", "a", &key.public_key), "another account");
        assert!(!holds("u", "e", "a", &key.public_key), "another device");
        assert!(!holds("u", "d", "b", &key.public_key), "another attempt");
        assert!(!holds("u", "d", "a", &device_signing_create().unwrap().public_key), "another key");
        let mut flipped = signature.clone();
        flipped[10] ^= 1;
        assert!(!device_session_verify(key.public_key.clone(), "u".into(), "d".into(), "a".into(), flipped));
    }

    #[test]
    fn the_email_hash_ignores_case_and_surrounding_space_only() {
        assert_eq!(device_email_hash("  A@B.c\n".into()), device_email_hash("a@b.c".into()));
        assert_ne!(device_email_hash("a@b.c".into()), device_email_hash("a@b.co".into()));
        assert_ne!(device_email_hash("a@b.c".into()), device_email_hash("a.@b.c".into()));
    }

    fn base64url(value: &str) -> Vec<u8> {
        crate::bytes::decode("signature", value, Some(64)).unwrap()
    }
}
