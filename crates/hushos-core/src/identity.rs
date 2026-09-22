//! The identity: an X25519 key for sealing shares and an ML-KEM-768 key for
//! the post-quantum half, both kept wrapped under the account key exactly as
//! `packages/crypto/identity.ts` writes them. Opening checks the private
//! halves against the published public keys, so a swapped envelope cannot put
//! a stranger's key in the session.

use crate::bytes::{decode, encode, expect_len, random, KEY_BYTES};
use crate::envelope::{context, open_with_nonce, seal_with_nonce};
use crate::error::{input, CoreError, CoreResult};
use ed25519_dalek::SigningKey;
use hkdf::Hkdf;
use ml_kem::array::Array;
use ml_kem::{ml_kem_768, Decapsulate, KeyExport, Seed};
use serde_json::json;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

pub(crate) const KEM_SEED_BYTES: usize = 64;
pub(crate) const KEM_PUBLIC_KEY_BYTES: usize = 1184;
pub(crate) const KEM_CIPHERTEXT_BYTES: usize = 1088;

/// The identity's public half and the wrapped private half, as the server stores it.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct IdentityKem {
    pub public_key: String,
    pub seed_nonce: String,
    pub encrypted_seed: String,
    pub signature: String,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct IdentityEnvelope {
    pub version: u32,
    pub key_version: u64,
    pub wrapping_salt: String,
    pub encryption_public_key: String,
    pub encryption_private_key_nonce: String,
    pub encrypted_encryption_private_key: String,
    pub signing_public_key: String,
    pub signing_seed_nonce: String,
    pub encrypted_signing_seed: String,
    /// Absent on identities made before hybrid sharing.
    pub kem: Option<IdentityKem>,
}

/// The private halves, opened: what opens a share sealed to this account.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct IdentityKeys {
    pub encryption_public_key: String,
    /// X25519, 32 bytes.
    pub encryption_private_key: Vec<u8>,
    /// The ML-KEM-768 seed, 64 bytes; empty for an identity without a KEM key yet.
    pub kem_seed: Vec<u8>,
    pub kem_public_key: Option<String>,
}

fn wrapping_key(root: &[u8], salt: &[u8], purpose: &str) -> CoreResult<[u8; KEY_BYTES]> {
    let mut wrap = [0u8; KEY_BYTES];
    Hkdf::<Sha256>::new(Some(salt), root)
        .expand(format!("hushos/identity/{purpose}/v1").as_bytes(), &mut wrap)
        .map_err(|_| input("HKDF failed"))?;
    Ok(wrap)
}

fn identity_context(user_id: &str, key_version: u64, purpose: &str, public_key: &str) -> Vec<u8> {
    context(&[
        json!("hushos/identity"),
        json!(1),
        json!(user_id.to_lowercase()),
        json!(key_version),
        json!(purpose),
        json!(public_key),
    ])
}

fn decapsulation_key(seed: &[u8]) -> CoreResult<ml_kem_768::DecapsulationKey> {
    expect_len("kem seed", seed, KEM_SEED_BYTES)?;
    let seed: Seed = Array::try_from(seed).map_err(|_| input("kem seed"))?;
    Ok(ml_kem_768::DecapsulationKey::from_seed(seed))
}

pub(crate) fn kem_public_key_from_seed(seed: &[u8]) -> CoreResult<Vec<u8>> {
    Ok(decapsulation_key(seed)?.encapsulation_key().to_bytes().to_vec())
}

/* ML-KEM-768 encapsulation to a public key: the ciphertext and the shared secret, from fresh randomness. */
pub(crate) fn kem_encapsulate(public_key: &[u8]) -> CoreResult<(Vec<u8>, [u8; 32])> {
    expect_len("kem public key", public_key, KEM_PUBLIC_KEY_BYTES)
        .map_err(|_| input("Invalid identity key."))?;
    let key = ml_kem_768::EncapsulationKey::new(&Array::try_from(public_key).map_err(|_| input("kem key"))?)
        .map_err(|_| input("Invalid identity key."))?;
    let m: ml_kem::B32 = Array::try_from(crate::bytes::random(32).as_slice()).expect("32 bytes");
    let (ciphertext, shared) = key.encapsulate_deterministic(&m);
    Ok((ciphertext.to_vec(), shared.into()))
}

pub(crate) fn kem_decapsulate(seed: &[u8], ciphertext: &[u8]) -> CoreResult<[u8; 32]> {
    expect_len("kem ciphertext", ciphertext, KEM_CIPHERTEXT_BYTES)?;
    let key = decapsulation_key(seed)?;
    let ct: ml_kem_768::Ciphertext = Array::try_from(ciphertext).map_err(|_| input("kem ciphertext"))?;
    let shared = key.decapsulate(&ct);
    Ok(shared.into())
}

/// Opens the identity's private keys under the account key and checks each
/// against its published public key.
///
/// ```no_run
/// # let (account_key, envelope) = (vec![0u8; 32], todo!());
/// let keys = hushos_core::identity_open("user-1".into(), account_key, envelope)?;
/// assert_eq!(keys.encryption_private_key.len(), 32);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn identity_open(
    user_id: String,
    account_key: Vec<u8>,
    envelope: IdentityEnvelope,
) -> CoreResult<IdentityKeys> {
    if envelope.version != 1 || envelope.key_version < 1 {
        return Err(input("Unsupported identity envelope."));
    }
    expect_len("accountKey", &account_key, KEY_BYTES)?;
    let salt = decode("wrappingSalt", &envelope.wrapping_salt, Some(32))?;
    let wrap = wrapping_key(&account_key, &salt, "encryption-private-wrap")?;
    let private_key = open_with_nonce(
        &wrap,
        &decode("encryptionPrivateKeyNonce", &envelope.encryption_private_key_nonce, Some(24))?,
        &decode("encryptedEncryptionPrivateKey", &envelope.encrypted_encryption_private_key, Some(48))?,
        &identity_context(
            &user_id,
            envelope.key_version,
            "encryption-private-wrap",
            &envelope.encryption_public_key,
        ),
    )?;
    let secret: [u8; 32] =
        private_key.as_slice().try_into().map_err(|_| CoreError::Sealed("Invalid identity key.".into()))?;
    let derived = PublicKey::from(&StaticSecret::from(secret));
    if encode(derived.as_bytes()) != envelope.encryption_public_key {
        return Err(CoreError::Sealed("Identity keys do not match.".into()));
    }
    let mut keys = IdentityKeys {
        encryption_public_key: envelope.encryption_public_key.clone(),
        encryption_private_key: private_key,
        kem_seed: Vec::new(),
        kem_public_key: None,
    };
    if let Some(kem) = envelope.kem {
        decode("kem publicKey", &kem.public_key, Some(KEM_PUBLIC_KEY_BYTES))?;
        let wrap = wrapping_key(&account_key, &salt, "kem-seed-wrap")?;
        let seed = open_with_nonce(
            &wrap,
            &decode("seedNonce", &kem.seed_nonce, Some(24))?,
            &decode("encryptedSeed", &kem.encrypted_seed, Some(KEM_SEED_BYTES + 16))?,
            &identity_context(&user_id, envelope.key_version, "kem-seed-wrap", &kem.public_key),
        )?;
        if encode(&kem_public_key_from_seed(&seed)?) != kem.public_key {
            return Err(CoreError::Sealed("Identity keys do not match.".into()));
        }
        keys.kem_seed = seed;
        keys.kem_public_key = Some(kem.public_key);
    }
    Ok(keys)
}

/// The same identity under a new account key, for a master-key rotation:
/// every private half is opened under the old key, checked against its public
/// key, and sealed again under the new one with a fresh salt. Public keys
/// never change, so shares and pins made against them keep working.
///
/// ```no_run
/// # let (old_root, new_root, envelope) = (vec![0u8; 32], vec![1u8; 32], todo!());
/// let rewrapped = hushos_core::identity_rewrap("user-1".into(), old_root, new_root, envelope, 2)?;
/// assert_eq!(rewrapped.key_version, 2);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn identity_rewrap(
    user_id: String,
    old_root: Vec<u8>,
    new_root: Vec<u8>,
    envelope: IdentityEnvelope,
    key_version: u64,
) -> CoreResult<IdentityEnvelope> {
    if envelope.version != 1 || envelope.key_version < 1 {
        return Err(input("Unsupported identity envelope."));
    }
    expect_len("old account key", &old_root, KEY_BYTES)?;
    expect_len("new account key", &new_root, KEY_BYTES)?;
    let old_salt = decode("wrappingSalt", &envelope.wrapping_salt, Some(32))?;
    let salt = random(32);
    let rewrap = |ciphertext: &str,
                  nonce: &str,
                  purpose: &str,
                  public_key: &str,
                  size: usize|
     -> CoreResult<(Vec<u8>, String, String)> {
        let private = open_with_nonce(
            &wrapping_key(&old_root, &old_salt, purpose)?,
            &decode("nonce", nonce, Some(24))?,
            &decode("ciphertext", ciphertext, Some(size + 16))?,
            &identity_context(&user_id, envelope.key_version, purpose, public_key),
        )?;
        let next_nonce = random(24);
        let sealed = seal_with_nonce(
            &wrapping_key(&new_root, &salt, purpose)?,
            &next_nonce,
            &private,
            &identity_context(&user_id, key_version, purpose, public_key),
        )?;
        Ok((private, encode(&next_nonce), encode(&sealed)))
    };
    let (secret, encryption_nonce, encrypted_encryption) = rewrap(
        &envelope.encrypted_encryption_private_key,
        &envelope.encryption_private_key_nonce,
        "encryption-private-wrap",
        &envelope.encryption_public_key,
        32,
    )?;
    let secret: [u8; 32] =
        secret.try_into().map_err(|_| CoreError::Sealed("Invalid identity key.".into()))?;
    if encode(PublicKey::from(&StaticSecret::from(secret)).as_bytes()) != envelope.encryption_public_key {
        return Err(CoreError::Sealed("Identity keys do not match.".into()));
    }
    let (seed, signing_nonce, encrypted_signing) = rewrap(
        &envelope.encrypted_signing_seed,
        &envelope.signing_seed_nonce,
        "signing-seed-wrap",
        &envelope.signing_public_key,
        32,
    )?;
    let seed: [u8; 32] = seed.try_into().map_err(|_| CoreError::Sealed("Invalid identity key.".into()))?;
    if encode(SigningKey::from_bytes(&seed).verifying_key().as_bytes()) != envelope.signing_public_key {
        return Err(CoreError::Sealed("Identity keys do not match.".into()));
    }
    let kem = match &envelope.kem {
        None => None,
        Some(kem) => {
            let (kem_seed, seed_nonce, encrypted_seed) = rewrap(
                &kem.encrypted_seed,
                &kem.seed_nonce,
                "kem-seed-wrap",
                &kem.public_key,
                KEM_SEED_BYTES,
            )?;
            if encode(&kem_public_key_from_seed(&kem_seed)?) != kem.public_key {
                return Err(CoreError::Sealed("Identity keys do not match.".into()));
            }
            Some(IdentityKem {
                public_key: kem.public_key.clone(),
                seed_nonce,
                encrypted_seed,
                signature: kem.signature.clone(),
            })
        }
    };
    Ok(IdentityEnvelope {
        version: 1,
        key_version,
        wrapping_salt: encode(&salt),
        encryption_public_key: envelope.encryption_public_key,
        encryption_private_key_nonce: encryption_nonce,
        encrypted_encryption_private_key: encrypted_encryption,
        signing_public_key: envelope.signing_public_key,
        signing_seed_nonce: signing_nonce,
        encrypted_signing_seed: encrypted_signing,
        kem,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::bytes::random;
    use crate::envelope::seal_with_nonce;

    /* What the web does at account setup: mint both keys and wrap them under the root. */
    pub(crate) fn make_identity(user_id: &str, root: &[u8]) -> (IdentityEnvelope, [u8; 32], Vec<u8>) {
        let secret: [u8; 32] = random(32).try_into().unwrap();
        let public = PublicKey::from(&StaticSecret::from(secret));
        let kem_seed = random(KEM_SEED_BYTES);
        let kem_public = kem_public_key_from_seed(&kem_seed).unwrap();
        let salt = random(32);
        let enc_nonce = random(24);
        let kem_nonce = random(24);
        let sign_nonce = random(24);
        let signing_seed: [u8; 32] = random(32).try_into().unwrap();
        let signing_public_key = encode(SigningKey::from_bytes(&signing_seed).verifying_key().as_bytes());
        let encryption_public_key = encode(public.as_bytes());
        let kem_public_key = encode(&kem_public);
        let enc_wrap = wrapping_key(root, &salt, "encryption-private-wrap").unwrap();
        let sign_wrap = wrapping_key(root, &salt, "signing-seed-wrap").unwrap();
        let kem_wrap = wrapping_key(root, &salt, "kem-seed-wrap").unwrap();
        let envelope = IdentityEnvelope {
            version: 1,
            key_version: 1,
            wrapping_salt: encode(&salt),
            encryption_public_key: encryption_public_key.clone(),
            encryption_private_key_nonce: encode(&enc_nonce),
            encrypted_encryption_private_key: encode(
                &seal_with_nonce(
                    &enc_wrap,
                    &enc_nonce,
                    &secret,
                    &identity_context(user_id, 1, "encryption-private-wrap", &encryption_public_key),
                )
                .unwrap(),
            ),
            signing_public_key: signing_public_key.clone(),
            signing_seed_nonce: encode(&sign_nonce),
            encrypted_signing_seed: encode(
                &seal_with_nonce(
                    &sign_wrap,
                    &sign_nonce,
                    &signing_seed,
                    &identity_context(user_id, 1, "signing-seed-wrap", &signing_public_key),
                )
                .unwrap(),
            ),
            kem: Some(IdentityKem {
                public_key: kem_public_key.clone(),
                seed_nonce: encode(&kem_nonce),
                encrypted_seed: encode(
                    &seal_with_nonce(
                        &kem_wrap,
                        &kem_nonce,
                        &kem_seed,
                        &identity_context(user_id, 1, "kem-seed-wrap", &kem_public_key),
                    )
                    .unwrap(),
                ),
                signature: encode(&random(64)),
            }),
        };
        (envelope, secret, kem_seed)
    }

    #[test]
    fn identity_open_checks_both_private_halves_against_the_published_keys() {
        let root = random(32);
        let (envelope, secret, kem_seed) = make_identity("User-1", &root);
        let keys = identity_open("user-1".into(), root.clone(), envelope.clone()).unwrap();
        assert_eq!(keys.encryption_private_key, secret.to_vec());
        assert_eq!(keys.kem_seed, kem_seed);
        assert_eq!(keys.kem_public_key.as_deref(), envelope.kem.as_ref().map(|k| k.public_key.as_str()));
        assert!(matches!(
            identity_open("user-2".into(), root.clone(), envelope.clone()),
            Err(CoreError::Sealed(_))
        ));
        assert!(matches!(
            identity_open("user-1".into(), random(32), envelope.clone()),
            Err(CoreError::Sealed(_))
        ));
        let mut swapped = envelope.clone();
        swapped.encryption_public_key = encode(&random(32));
        assert!(
            matches!(identity_open("user-1".into(), root.clone(), swapped), Err(CoreError::Sealed(_))),
            "the public key is in the context"
        );
        let mut legacy = envelope;
        legacy.kem = None;
        let keys = identity_open("user-1".into(), root, legacy).unwrap();
        assert!(keys.kem_seed.is_empty() && keys.kem_public_key.is_none());
    }

    #[test]
    fn identity_rewrap_keeps_the_public_keys_and_opens_only_under_the_new_root() {
        let old_root = random(32);
        let new_root = random(32);
        let (envelope, secret, kem_seed) = make_identity("user-1", &old_root);
        let rewrapped =
            identity_rewrap("user-1".into(), old_root.clone(), new_root.clone(), envelope.clone(), 2)
                .unwrap();
        assert_eq!(rewrapped.key_version, 2);
        assert_eq!(rewrapped.encryption_public_key, envelope.encryption_public_key);
        assert_eq!(rewrapped.signing_public_key, envelope.signing_public_key);
        assert_eq!(rewrapped.kem.as_ref().unwrap().public_key, envelope.kem.as_ref().unwrap().public_key);
        assert_ne!(rewrapped.wrapping_salt, envelope.wrapping_salt);
        let keys = identity_open("user-1".into(), new_root.clone(), rewrapped.clone()).unwrap();
        assert_eq!((keys.encryption_private_key, keys.kem_seed), (secret.to_vec(), kem_seed));
        assert!(matches!(
            identity_open("user-1".into(), old_root.clone(), rewrapped),
            Err(CoreError::Sealed(_))
        ));
        assert!(
            matches!(
                identity_rewrap("user-1".into(), new_root.clone(), old_root.clone(), envelope.clone(), 2),
                Err(CoreError::Sealed(_))
            ),
            "the old root must open it"
        );
        let mut swapped = envelope;
        swapped.signing_public_key = encode(&random(32));
        assert!(matches!(
            identity_rewrap("user-1".into(), old_root, new_root, swapped, 2),
            Err(CoreError::Sealed(_))
        ));
    }
}
