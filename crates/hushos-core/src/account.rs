//! The account key: unwrapped from the OPAQUE export key after a login, then
//! remembered on the device under a fresh AES-256-GCM key that the app keeps
//! in the platform keychain, and restored from that memory on later launches.

use crate::bytes::{decode, encode, expect_len, random, KEY_BYTES};
use crate::envelope::{context, open_with_nonce, seal_with_nonce};
use crate::error::{input, CoreError, CoreResult};
use aes_gcm::aead::{Aead as _, Payload};
use aes_gcm::{Aes256Gcm, KeyInit as _, Nonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::Sha256;

const GCM_NONCE_BYTES: usize = 12;
const WRAPPED_KEY_BYTES: usize = KEY_BYTES + 16;

/// The account key sealed under the password, as the server hands it out.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct AccountKeyEnvelope {
    pub envelope_version: u32,
    pub key_version: u64,
    pub credential_version: u64,
    pub wrapping_salt: String,
    pub wrapping_nonce: String,
    pub encrypted_key: String,
}

/// OPAQUE export key -> HKDF wrapping key -> the account key, as the web's `unlock`.
/// The envelope comes from `GET /api/auth/session` (or the login finish response)
/// and the export key from [`crate::opaque_finish_login`].
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn account_unlock(
    user_id: String,
    export_key: Vec<u8>,
    envelope: AccountKeyEnvelope,
) -> CoreResult<Vec<u8>> {
    if envelope.envelope_version != 1 || envelope.key_version < 1 || envelope.credential_version < 1 {
        return Err(input("This account-key version is not supported."));
    }
    let salt = decode("wrappingSalt", &envelope.wrapping_salt, Some(32))?;
    let nonce = decode("wrappingNonce", &envelope.wrapping_nonce, Some(24))?;
    let ciphertext = decode("encryptedKey", &envelope.encrypted_key, Some(WRAPPED_KEY_BYTES))?;
    let mut wrap = [0u8; KEY_BYTES];
    Hkdf::<Sha256>::new(Some(&salt), &export_key)
        .expand(b"hushos/account-key/password-wrap/v1", &mut wrap)
        .map_err(|_| input("HKDF failed"))?;
    let aad = context(&[
        json!("hushos/account-key/password-wrap"),
        json!(1),
        json!(user_id.to_lowercase()),
        json!(envelope.key_version),
        json!(envelope.credential_version),
    ]);
    let key = open_with_nonce(&wrap, &nonce, &ciphertext, &aad)?;
    expect_len("account key", &key, KEY_BYTES)
        .map_err(|_| CoreError::Sealed("Invalid account key.".into()))?;
    Ok(key)
}

/// The account key sealed under a fresh OPAQUE export key, for a password
/// change: the server keeps `key_version`, bumps `credential_version` by one,
/// and the client seals the same account key it opened with the old password.
///
/// ```
/// use hushos_core::{account_seal, account_unlock, random_bytes};
/// let export_key = random_bytes(64)?;
/// let account_key = random_bytes(32)?;
/// let envelope = account_seal("User-1".into(), export_key.clone(), account_key.clone(), 2, 4)?;
/// assert_eq!(envelope.credential_version, 4);
/// assert_eq!(account_unlock("user-1".into(), export_key, envelope)?, account_key);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn account_seal(
    user_id: String,
    export_key: Vec<u8>,
    account_key: Vec<u8>,
    key_version: u64,
    credential_version: u64,
) -> CoreResult<AccountKeyEnvelope> {
    expect_len("accountKey", &account_key, KEY_BYTES)?;
    if export_key.is_empty() {
        return Err(input("exportKey is empty"));
    }
    if key_version < 1 || credential_version < 1 {
        return Err(input("keyVersion and credentialVersion start at 1"));
    }
    let salt = random(32);
    let nonce = random(24);
    let mut wrap = [0u8; KEY_BYTES];
    Hkdf::<Sha256>::new(Some(&salt), &export_key)
        .expand(b"hushos/account-key/password-wrap/v1", &mut wrap)
        .map_err(|_| input("HKDF failed"))?;
    let aad = context(&[
        json!("hushos/account-key/password-wrap"),
        json!(1),
        json!(user_id.to_lowercase()),
        json!(key_version),
        json!(credential_version),
    ]);
    let sealed = seal_with_nonce(&wrap, &nonce, &account_key, &aad)?;
    Ok(AccountKeyEnvelope {
        envelope_version: 1,
        key_version,
        credential_version,
        wrapping_salt: encode(&salt),
        wrapping_nonce: encode(&nonce),
        encrypted_key: encode(&sealed),
    })
}

/// The account key wrapped under a device key: what the app stores beside the
/// key in the keychain, and what the Files extensions read to open the Drive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RememberedDevice {
    pub version: u32,
    pub user_id: String,
    pub key_version: u64,
    pub credential_version: u64,
    pub device_key_id: String,
    pub nonce: String,
    pub encrypted_key: String,
}

/// A fresh device key and the account key sealed under it.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct DeviceMemory {
    /// Keep in the platform keychain, never beside the bundle in plain storage.
    pub device_key: Vec<u8>,
    pub bundle: RememberedDevice,
}

fn device_context(bundle: &RememberedDevice) -> Vec<u8> {
    context(&[
        json!("hushos/device-unlock"),
        json!(bundle.version),
        json!(bundle.user_id.to_lowercase()),
        json!(bundle.key_version),
        json!(bundle.credential_version),
        json!(bundle.device_key_id),
    ])
}

/// Seal the account key under a fresh device key so later launches, and the
/// Files extensions, can open the Drive without the password.
///
/// ```
/// use hushos_core::{device_remember, device_restore, random_bytes};
/// let account_key = random_bytes(32)?;
/// let memory = device_remember("User-1".into(), account_key.clone(), 1, 1, "device-a".into())?;
/// // `memory.device_key` goes to the keychain; `memory.bundle` can sit in plain storage.
/// assert_eq!(device_restore(memory.bundle, memory.device_key)?, account_key);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn device_remember(
    user_id: String,
    account_key: Vec<u8>,
    key_version: u64,
    credential_version: u64,
    device_key_id: String,
) -> CoreResult<DeviceMemory> {
    expect_len("accountKey", &account_key, KEY_BYTES)?;
    if key_version < 1 || credential_version < 1 {
        return Err(input("keyVersion and credentialVersion start at 1"));
    }
    let device_key = random(KEY_BYTES);
    let nonce = random(GCM_NONCE_BYTES);
    let mut bundle = RememberedDevice {
        version: 1,
        user_id,
        key_version,
        credential_version,
        device_key_id,
        nonce: encode(&nonce),
        encrypted_key: String::new(),
    };
    let sealed = Aes256Gcm::new(device_key.as_slice().into())
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: &account_key, aad: &device_context(&bundle) })
        .map_err(|_| CoreError::Sealed("encryption failed".into()))?;
    bundle.encrypted_key = encode(&sealed);
    Ok(DeviceMemory { device_key, bundle })
}

/// The inverse of [`device_remember`]: the account key from the bundle and the device key.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn device_restore(bundle: RememberedDevice, device_key: Vec<u8>) -> CoreResult<Vec<u8>> {
    if bundle.version != 1 || bundle.key_version < 1 || bundle.credential_version < 1 {
        return Err(input("This saved account-key version is not supported."));
    }
    expect_len("deviceKey", &device_key, KEY_BYTES)?;
    let nonce = decode("nonce", &bundle.nonce, Some(GCM_NONCE_BYTES))?;
    let ciphertext = decode("encryptedKey", &bundle.encrypted_key, Some(WRAPPED_KEY_BYTES))?;
    let key = Aes256Gcm::new(device_key.as_slice().into())
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: &ciphertext, aad: &device_context(&bundle) })
        .map_err(|_| CoreError::Sealed("The saved account key could not be opened.".into()))?;
    expect_len("account key", &key, KEY_BYTES)
        .map_err(|_| CoreError::Sealed("Invalid saved account key.".into()))?;
    Ok(key)
}

/// The bundle as JSON, the one storage format every platform and the web share.
///
/// ```
/// use hushos_core::{remembered_device_from_json, remembered_device_to_json, RememberedDevice};
/// let bundle = RememberedDevice {
///     version: 1, user_id: "u1".into(), key_version: 1, credential_version: 2,
///     device_key_id: "d1".into(), nonce: "AAAAAAAAAAAAAAAA".into(), encrypted_key: "AA".into(),
/// };
/// let json = remembered_device_to_json(bundle.clone());
/// assert!(json.contains(r#""deviceKeyId":"d1""#), "camelCase, as the web stores it");
/// assert_eq!(remembered_device_from_json(json).unwrap().credential_version, 2);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn remembered_device_to_json(bundle: RememberedDevice) -> String {
    serde_json::to_string(&bundle).expect("a remembered device is plain data")
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn remembered_device_from_json(json: String) -> CoreResult<RememberedDevice> {
    serde_json::from_str(&json).map_err(|error| input(format!("not a remembered device; {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::random;
    use chacha20poly1305::aead::Payload as XPayload;
    use chacha20poly1305::{XChaCha20Poly1305, XNonce};

    /* What `packages/crypto` does at account setup: seal the account key under the export key. */
    fn sealed_by_the_web(user_id: &str, export_key: &[u8], account_key: &[u8]) -> AccountKeyEnvelope {
        let salt = random(32);
        let nonce = random(24);
        let mut wrap = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&salt), export_key)
            .expand(b"hushos/account-key/password-wrap/v1", &mut wrap)
            .unwrap();
        let aad = format!(r#"["hushos/account-key/password-wrap",1,"{}",3,2]"#, user_id.to_lowercase());
        let sealed = XChaCha20Poly1305::new((&wrap).into())
            .encrypt(XNonce::from_slice(&nonce), XPayload { msg: account_key, aad: aad.as_bytes() })
            .unwrap();
        AccountKeyEnvelope {
            envelope_version: 1,
            key_version: 3,
            credential_version: 2,
            wrapping_salt: encode(&salt),
            wrapping_nonce: encode(&nonce),
            encrypted_key: encode(&sealed),
        }
    }

    #[test]
    fn account_unlock_opens_what_the_web_sealed_and_ignores_user_id_case() {
        let export_key = random(64);
        let account_key = random(32);
        let envelope = sealed_by_the_web("USER-1", &export_key, &account_key);
        assert_eq!(
            account_unlock("user-1".into(), export_key.clone(), envelope.clone()).unwrap(),
            account_key
        );
        assert!(matches!(
            account_unlock("user-2".into(), export_key.clone(), envelope.clone()),
            Err(CoreError::Sealed(_))
        ));
        assert!(matches!(
            account_unlock("user-1".into(), random(64), envelope.clone()),
            Err(CoreError::Sealed(_))
        ));
        let mut wrong_version = envelope.clone();
        wrong_version.credential_version = 1;
        assert!(
            matches!(
                account_unlock("user-1".into(), export_key.clone(), wrong_version),
                Err(CoreError::Sealed(_))
            ),
            "the versions are in the context"
        );
        let mut unsupported = envelope;
        unsupported.envelope_version = 2;
        assert!(matches!(account_unlock("user-1".into(), export_key, unsupported), Err(CoreError::Input(_))));
    }

    #[test]
    fn account_seal_binds_the_versions_and_the_user() {
        let export_key = random(64);
        let account_key = random(32);
        let envelope = account_seal("User-1".into(), export_key.clone(), account_key.clone(), 2, 4).unwrap();
        assert_eq!(decode("k", &envelope.encrypted_key, None).unwrap().len(), 48);
        assert_eq!(
            account_unlock("user-1".into(), export_key.clone(), envelope.clone()).unwrap(),
            account_key
        );
        let mut older = envelope.clone();
        older.credential_version = 3;
        assert!(matches!(
            account_unlock("user-1".into(), export_key.clone(), older),
            Err(CoreError::Sealed(_))
        ));
        assert!(matches!(
            account_unlock("user-2".into(), export_key.clone(), envelope),
            Err(CoreError::Sealed(_))
        ));
        assert!(matches!(account_seal("u".into(), vec![], account_key, 1, 1), Err(CoreError::Input(_))));
    }

    #[test]
    fn device_memory_is_bound_to_the_device_key_and_the_bundle_fields() {
        let account_key = random(32);
        let memory = device_remember("User-1".into(), account_key.clone(), 1, 1, "device-a".into()).unwrap();
        assert_eq!(memory.device_key.len(), 32);
        assert_eq!(decode("n", &memory.bundle.nonce, None).unwrap().len(), 12);
        assert_eq!(decode("k", &memory.bundle.encrypted_key, None).unwrap().len(), 48);
        assert_eq!(
            memory.bundle.user_id, "User-1",
            "the bundle keeps the id as given; the context lowercases it"
        );
        assert_eq!(device_restore(memory.bundle.clone(), memory.device_key.clone()).unwrap(), account_key);
        assert!(matches!(device_restore(memory.bundle.clone(), random(32)), Err(CoreError::Sealed(_))));
        let mut other_device = memory.bundle.clone();
        other_device.device_key_id = "device-b".into();
        assert!(matches!(device_restore(other_device, memory.device_key.clone()), Err(CoreError::Sealed(_))));
        let mut other_user = memory.bundle;
        other_user.user_id = "user-2".into();
        assert!(matches!(device_restore(other_user, memory.device_key), Err(CoreError::Sealed(_))));
    }

    #[test]
    fn device_remember_refuses_a_short_key_and_zero_versions() {
        assert!(matches!(
            device_remember("u".into(), random(16), 1, 1, "d".into()),
            Err(CoreError::Input(_))
        ));
        assert!(matches!(
            device_remember("u".into(), random(32), 0, 1, "d".into()),
            Err(CoreError::Input(_))
        ));
    }

    #[test]
    fn the_json_form_round_trips_and_refuses_other_shapes() {
        let memory = device_remember("u".into(), random(32), 1, 1, "d".into()).unwrap();
        let json = remembered_device_to_json(memory.bundle.clone());
        assert_eq!(remembered_device_from_json(json).unwrap(), memory.bundle);
        assert!(matches!(remembered_device_from_json(r#"{"version":1}"#.into()), Err(CoreError::Input(_))));
    }
}
