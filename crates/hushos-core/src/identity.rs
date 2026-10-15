//! The identity, as `packages/crypto/identity.ts` writes it
//! (docs/identity-pq-design.md). Version 2, the only one written, holds four
//! key pairs, each private half wrapped under the account key: X25519 and
//! ML-KEM-768 to receive shares, Ed25519 and ML-DSA-65 to sign. One statement,
//! signed with both signing keys, binds the four public keys to the account
//! (the keys statement). Version 1 had no ML-DSA key and bound its ML-KEM key
//! with an Ed25519 signature alone; it is still read (opened, upgraded,
//! rewrapped, kept in history), but nothing about it is trusted.
//!
//! Opening checks every private half against its published public key, so a
//! swapped envelope cannot put a stranger's key in the session. An identity is
//! replaced by a succession: the next one, minted at the next key version and
//! vouched for by the old identity's hybrid signature.

use crate::bytes::{decode, encode, expect_len, random, Redacted, SecretBytes, KEY_BYTES};
use crate::envelope::{context, open_with_nonce, seal_with_nonce};
use crate::error::{input, CoreError, CoreResult};
use crate::pq::{ml_dsa_public_key, ML_DSA_PUBLIC_KEY_BYTES, ML_DSA_SEED_BYTES};
use crate::signatures::{
    keys_statement, sign_hybrid, succession_statement, verify_hybrid, HybridPublicKey, HYBRID_SIGNATURE_BYTES,
};
use ed25519_dalek::SigningKey;
use hkdf::Hkdf;
use ml_kem::array::Array;
use ml_kem::{ml_kem_768, Decapsulate, KeyExport, Seed};
use serde_json::json;
use sha2::Sha256;
use std::fmt;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize as _, Zeroizing};

pub(crate) const KEM_SEED_BYTES: usize = 64;
pub(crate) const KEM_PUBLIC_KEY_BYTES: usize = 1184;
pub(crate) const KEM_CIPHERTEXT_BYTES: usize = 1088;

const ENCRYPTION_PURPOSE: &str = "encryption-private-wrap";
const SIGNING_PURPOSE: &str = "signing-seed-wrap";
const KEM_PURPOSE: &str = "kem-seed-wrap";
const ML_DSA_PURPOSE: &str = "ml-dsa-seed-wrap";
const MISMATCH: &str = "Identity keys do not match.";

/// The identity's ML-KEM-768 key: the public half and the wrapped 64-byte seed.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct IdentityKem {
    pub public_key: String,
    pub seed_nonce: String,
    pub encrypted_seed: String,
    /// Version 1 only: the Ed25519 binding, no longer a path to trust. None on
    /// version 2, whose keys statement binds the KEM key instead.
    pub signature: Option<String>,
}

/// The identity's ML-DSA-65 key (version 2): the public half and the wrapped
/// 32-byte seed ξ.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct IdentityMlDsa {
    pub public_key: String,
    pub seed_nonce: String,
    pub encrypted_seed: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct IdentityEnvelope {
    /// 2 is the only one written; 1 is read (opened, upgraded, rewrapped).
    pub version: u32,
    pub key_version: u64,
    pub wrapping_salt: String,
    pub encryption_public_key: String,
    pub encryption_private_key_nonce: String,
    pub encrypted_encryption_private_key: String,
    pub signing_public_key: String,
    pub signing_seed_nonce: String,
    pub encrypted_signing_seed: String,
    /// Required on version 2; absent on version 1 identities made before hybrid sharing.
    pub kem: Option<IdentityKem>,
    /// Version 2 only.
    pub ml_dsa: Option<IdentityMlDsa>,
    /// Version 2 only: base64url, 3373 bytes, the hybrid signature over the keys statement.
    pub keys_signature: Option<String>,
}

/// The private halves, opened: what opens a share sealed to this account and
/// signs what it writes. Each private half is [`SecretBytes`]: wiped when the
/// record is dropped.
#[derive(Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct IdentityKeys {
    /// The envelope's version: 2, or 1 for an identity still to be upgraded.
    pub identity_version: u32,
    /// The identity's generation: 1, then one more with each succession.
    pub key_version: u64,
    pub encryption_public_key: String,
    /// X25519, 32 bytes.
    pub encryption_private_key: SecretBytes,
    /// Ed25519, checked against the signing seed.
    pub signing_public_key: String,
    /// The Ed25519 seed, 32 bytes: signs metadata and versions, and is half of every hybrid signature.
    pub signing_seed: SecretBytes,
    /// The ML-KEM-768 seed, 64 bytes; empty for an identity without a KEM key yet.
    pub kem_seed: SecretBytes,
    pub kem_public_key: Option<String>,
    /// The ML-DSA-65 seed ξ, 32 bytes: the other half of every hybrid signature. Empty on version 1.
    pub ml_dsa_seed: SecretBytes,
    pub ml_dsa_public_key: Option<String>,
}

impl fmt::Debug for IdentityKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IdentityKeys")
            .field("identity_version", &self.identity_version)
            .field("key_version", &self.key_version)
            .field("encryption_public_key", &self.encryption_public_key)
            .field("encryption_private_key", &Redacted)
            .field("signing_public_key", &self.signing_public_key)
            .field("signing_seed", &Redacted)
            .field("kem_seed", &Redacted)
            .field("kem_public_key", &self.kem_public_key)
            .field("ml_dsa_seed", &Redacted)
            .field("ml_dsa_public_key", &self.ml_dsa_public_key)
            .finish()
    }
}

/// The public keys of a version 2 identity, as the keys statement and
/// contacts see them, with the keys statement's hybrid signature (base64url).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct PublicIdentity {
    pub key_version: u64,
    pub encryption_public_key: String,
    pub signing_public_key: String,
    pub ml_dsa_public_key: String,
    pub kem_public_key: String,
    pub keys_signature: String,
}

fn wrapping_key(root: &[u8], salt: &[u8], purpose: &str) -> CoreResult<Zeroizing<[u8; KEY_BYTES]>> {
    let mut wrap = Zeroizing::new([0u8; KEY_BYTES]);
    Hkdf::<Sha256>::new(Some(salt), root)
        .expand(format!("hushos/identity/{purpose}/v1").as_bytes(), wrap.as_mut())
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
pub(crate) fn kem_encapsulate(public_key: &[u8]) -> CoreResult<(Vec<u8>, Zeroizing<[u8; 32]>)> {
    expect_len("kem public key", public_key, KEM_PUBLIC_KEY_BYTES)
        .map_err(|_| input("Invalid identity key."))?;
    let key = ml_kem_768::EncapsulationKey::new(&Array::try_from(public_key).map_err(|_| input("kem key"))?)
        .map_err(|_| input("Invalid identity key."))?;
    // The encapsulation randomness decides the shared secret, so it is wiped like one.
    let random = Zeroizing::new(crate::bytes::random(32));
    let mut m: ml_kem::B32 = Array::try_from(random.as_slice()).expect("32 bytes");
    let (ciphertext, mut shared) = key.encapsulate_deterministic(&m);
    m.as_mut_slice().zeroize();
    let secret = Zeroizing::new(shared.into());
    shared.as_mut_slice().zeroize();
    Ok((ciphertext.to_vec(), secret))
}

pub(crate) fn kem_decapsulate(seed: &[u8], ciphertext: &[u8]) -> CoreResult<Zeroizing<[u8; 32]>> {
    expect_len("kem ciphertext", ciphertext, KEM_CIPHERTEXT_BYTES)?;
    let key = decapsulation_key(seed)?;
    let ct: ml_kem_768::Ciphertext = Array::try_from(ciphertext).map_err(|_| input("kem ciphertext"))?;
    let mut shared = key.decapsulate(&ct);
    let secret = Zeroizing::new(shared.into());
    shared.as_mut_slice().zeroize();
    Ok(secret)
}

/* Version 1 or 2 at a positive key version; version 2 carries all of its lattice parts. */
fn check_envelope(envelope: &IdentityEnvelope) -> CoreResult<()> {
    let complete = envelope.kem.is_some() && envelope.ml_dsa.is_some() && envelope.keys_signature.is_some();
    if !matches!(envelope.version, 1 | 2) || envelope.key_version < 1 || (envelope.version == 2 && !complete)
    {
        return Err(input("Unsupported identity envelope."));
    }
    Ok(())
}

/* The size of the private half each purpose wraps. */
fn private_bytes(purpose: &str) -> usize {
    if purpose == KEM_PURPOSE {
        KEM_SEED_BYTES
    } else {
        32
    }
}

/* The public key a private half derives, by purpose: what an opened half is checked against. */
fn derived_public_key(purpose: &str, private: &[u8]) -> CoreResult<Vec<u8>> {
    let mismatch = || CoreError::Sealed("Invalid identity key.".into());
    Ok(match purpose {
        ENCRYPTION_PURPOSE => {
            let secret = Zeroizing::new(<[u8; 32]>::try_from(private).map_err(|_| mismatch())?);
            PublicKey::from(&StaticSecret::from(*secret)).as_bytes().to_vec()
        }
        SIGNING_PURPOSE => {
            let seed = Zeroizing::new(<[u8; 32]>::try_from(private).map_err(|_| mismatch())?);
            SigningKey::from_bytes(&seed).verifying_key().as_bytes().to_vec()
        }
        KEM_PURPOSE => kem_public_key_from_seed(private).map_err(|_| mismatch())?,
        ML_DSA_PURPOSE => ml_dsa_public_key(private).map_err(|_| mismatch())?,
        _ => return Err(input("Unknown key purpose.")),
    })
}

/* A wrapped private half as an envelope carries it: its public key, nonce and ciphertext. */
struct Wrapped<'a> {
    public_key: &'a str,
    nonce: &'a str,
    encrypted: &'a str,
}

/*
 * Opens one wrapped private half under the root and proves it is the one the
 * envelope names: the public key is in the associated data, and the half must
 * derive it.
 */
fn open_half(
    root: &[u8],
    salt: &[u8],
    user_id: &str,
    key_version: u64,
    purpose: &str,
    wrapped: Wrapped<'_>,
) -> CoreResult<Zeroizing<Vec<u8>>> {
    let private = Zeroizing::new(open_with_nonce(
        wrapping_key(root, salt, purpose)?.as_slice(),
        &decode("nonce", wrapped.nonce, Some(24))?,
        &decode("ciphertext", wrapped.encrypted, Some(private_bytes(purpose) + 16))?,
        &identity_context(user_id, key_version, purpose, wrapped.public_key),
    )?);
    if encode(&derived_public_key(purpose, &private)?) != wrapped.public_key {
        return Err(CoreError::Sealed(MISMATCH.into()));
    }
    Ok(private)
}

/* Wraps a private half under the root for `purpose`, with its public key in the associated data: (nonce, ciphertext). */
fn wrap_half(
    root: &[u8],
    salt: &[u8],
    user_id: &str,
    key_version: u64,
    purpose: &str,
    private: &[u8],
    public_key: &str,
) -> CoreResult<(String, String)> {
    let nonce = random(24);
    let sealed = seal_with_nonce(
        wrapping_key(root, salt, purpose)?.as_slice(),
        &nonce,
        private,
        &identity_context(user_id, key_version, purpose, public_key),
    )?;
    Ok((encode(&nonce), encode(&sealed)))
}

/* A fresh ML-KEM seed wrapped under the root, and the seed. */
fn mint_kem(
    root: &[u8],
    salt: &[u8],
    user_id: &str,
    key_version: u64,
) -> CoreResult<(IdentityKem, Zeroizing<Vec<u8>>)> {
    let seed = Zeroizing::new(random(KEM_SEED_BYTES));
    let public_key = encode(&kem_public_key_from_seed(&seed)?);
    let (seed_nonce, encrypted_seed) =
        wrap_half(root, salt, user_id, key_version, KEM_PURPOSE, &seed, &public_key)?;
    Ok((IdentityKem { public_key, seed_nonce, encrypted_seed, signature: None }, seed))
}

/*
 * A fresh ML-DSA seed wrapped under the root, opened again before anything
 * uses it: a seed that does not open back to the same public key (a bug, the
 * wrong associated data) must never be uploaded, since an identity whose
 * signing key cannot be opened can never sign again (docs/identity-pq-design.md 2).
 */
fn mint_ml_dsa(
    root: &[u8],
    salt: &[u8],
    user_id: &str,
    key_version: u64,
) -> CoreResult<(IdentityMlDsa, Zeroizing<Vec<u8>>)> {
    let seed = Zeroizing::new(random(ML_DSA_SEED_BYTES));
    let public_key = encode(&ml_dsa_public_key(&seed)?);
    #[cfg(test)]
    let key_version_wrapped = tests::MISWRAP_ML_DSA.with(|miswrap| key_version + u64::from(miswrap.get()));
    #[cfg(not(test))]
    let key_version_wrapped = key_version;
    let (seed_nonce, encrypted_seed) =
        wrap_half(root, salt, user_id, key_version_wrapped, ML_DSA_PURPOSE, &seed, &public_key)?;
    let wrapped = IdentityMlDsa { public_key, seed_nonce, encrypted_seed };
    reopens_ml_dsa(root, salt, user_id, key_version, &wrapped)?;
    Ok((wrapped, seed))
}

/* Whether a wrapped ML-DSA seed opens under the root to the public key it names. */
fn reopens_ml_dsa(
    root: &[u8],
    salt: &[u8],
    user_id: &str,
    key_version: u64,
    wrapped: &IdentityMlDsa,
) -> CoreResult<()> {
    open_half(
        root,
        salt,
        user_id,
        key_version,
        ML_DSA_PURPOSE,
        Wrapped {
            public_key: &wrapped.public_key,
            nonce: &wrapped.seed_nonce,
            encrypted: &wrapped.encrypted_seed,
        },
    )
    .map(drop)
}

/* The keys statement over an envelope's public keys, for a version 2 envelope. */
fn keys_message(user_id: &str, envelope: &IdentityEnvelope) -> CoreResult<Vec<u8>> {
    let (Some(kem), Some(ml_dsa)) = (&envelope.kem, &envelope.ml_dsa) else {
        return Err(input("Unsupported identity envelope."));
    };
    keys_statement(
        user_id.to_string(),
        envelope.key_version,
        envelope.encryption_public_key.clone(),
        envelope.signing_public_key.clone(),
        ml_dsa.public_key.clone(),
        kem.public_key.clone(),
    )
}

/// Opens the identity's private keys under the account key and checks each
/// against its published public key, the signing and ML-DSA seeds included,
/// so the fingerprint shown for this account covers keys it really holds. A
/// version 2 identity is used only once its keys statement holds. A version 1
/// identity opens too (its `identity_version` says so): upgrade it with
/// [`identity_upgrade`] before it signs anything hybrid.
///
/// ```
/// use hushos_core::{identity_create, identity_open, random_bytes};
/// let root = random_bytes(32)?;
/// let keys = identity_open("user-1".into(), root.clone(), identity_create("user-1".into(), root, 1)?)?;
/// assert_eq!((keys.identity_version, keys.ml_dsa_seed.len(), keys.kem_seed.len()), (2, 32, 64));
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn identity_open(
    user_id: String,
    account_key: Vec<u8>,
    envelope: IdentityEnvelope,
) -> CoreResult<IdentityKeys> {
    let account_key = Zeroizing::new(account_key);
    check_envelope(&envelope)?;
    expect_len("accountKey", &account_key, KEY_BYTES)?;
    let salt = decode("wrappingSalt", &envelope.wrapping_salt, Some(32))?;
    let kv = envelope.key_version;
    let half = |purpose: &str, public_key: &str, nonce: &str, encrypted: &str| {
        open_half(&account_key, &salt, &user_id, kv, purpose, Wrapped { public_key, nonce, encrypted })
    };
    let private_key = half(
        ENCRYPTION_PURPOSE,
        &envelope.encryption_public_key,
        &envelope.encryption_private_key_nonce,
        &envelope.encrypted_encryption_private_key,
    )?;
    let signing_seed = half(
        SIGNING_PURPOSE,
        &envelope.signing_public_key,
        &envelope.signing_seed_nonce,
        &envelope.encrypted_signing_seed,
    )?;
    let mut keys = IdentityKeys {
        identity_version: envelope.version,
        key_version: kv,
        encryption_public_key: envelope.encryption_public_key.clone(),
        encryption_private_key: private_key.to_vec().into(),
        signing_public_key: envelope.signing_public_key.clone(),
        signing_seed: signing_seed.to_vec().into(),
        kem_seed: SecretBytes::default(),
        kem_public_key: None,
        ml_dsa_seed: SecretBytes::default(),
        ml_dsa_public_key: None,
    };
    if let Some(kem) = &envelope.kem {
        decode("kem publicKey", &kem.public_key, Some(KEM_PUBLIC_KEY_BYTES))?;
        let seed = half(KEM_PURPOSE, &kem.public_key, &kem.seed_nonce, &kem.encrypted_seed)?;
        keys.kem_seed = seed.to_vec().into();
        keys.kem_public_key = Some(kem.public_key.clone());
    }
    if let Some(ml_dsa) = &envelope.ml_dsa {
        decode("mlDsa publicKey", &ml_dsa.public_key, Some(ML_DSA_PUBLIC_KEY_BYTES))?;
        let seed = half(ML_DSA_PURPOSE, &ml_dsa.public_key, &ml_dsa.seed_nonce, &ml_dsa.encrypted_seed)?;
        keys.ml_dsa_seed = seed.to_vec().into();
        keys.ml_dsa_public_key = Some(ml_dsa.public_key.clone());
    }
    if envelope.version == 2 && !identity_verify_keys(user_id.clone(), public_identity(envelope)?) {
        return Err(CoreError::Sealed(MISMATCH.into()));
    }
    Ok(keys)
}

/// The same identity under a new account key, for a master-key rotation:
/// every private half (the ML-DSA seed included) is opened under the old key,
/// checked against its public key, and sealed again under the new one with a
/// fresh salt. Public keys never change, and neither does the key version (it
/// counts the identity's generations, not the root's revisions), so pins,
/// chains and the keys statement keep holding. Earlier identities in the
/// account's history, version 1 ones included, are rewrapped the same way.
///
/// ```
/// use hushos_core::{identity_create, identity_open, identity_rewrap, random_bytes};
/// let (old_root, new_root) = (random_bytes(32)?, random_bytes(32)?);
/// let envelope = identity_create("user-1".into(), old_root.clone(), 2)?;
/// let rewrapped = identity_rewrap("user-1".into(), old_root, new_root.clone(), envelope.clone())?;
/// assert_eq!((rewrapped.key_version, &rewrapped.keys_signature), (2, &envelope.keys_signature));
/// assert_eq!(identity_open("user-1".into(), new_root, rewrapped)?.ml_dsa_public_key, envelope.ml_dsa.map(|k| k.public_key));
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn identity_rewrap(
    user_id: String,
    old_root: Vec<u8>,
    new_root: Vec<u8>,
    envelope: IdentityEnvelope,
) -> CoreResult<IdentityEnvelope> {
    check_envelope(&envelope)?;
    let key_version = envelope.key_version;
    let (old_root, new_root) = (Zeroizing::new(old_root), Zeroizing::new(new_root));
    expect_len("old account key", &old_root, KEY_BYTES)?;
    expect_len("new account key", &new_root, KEY_BYTES)?;
    let old_salt = decode("wrappingSalt", &envelope.wrapping_salt, Some(32))?;
    let salt = random(32);
    let rewrap =
        |purpose: &str, public_key: &str, nonce: &str, encrypted: &str| -> CoreResult<(String, String)> {
            let private = open_half(
                &old_root,
                &old_salt,
                &user_id,
                key_version,
                purpose,
                Wrapped { public_key, nonce, encrypted },
            )?;
            wrap_half(&new_root, &salt, &user_id, key_version, purpose, &private, public_key)
        };
    let (encryption_nonce, encrypted_encryption) = rewrap(
        ENCRYPTION_PURPOSE,
        &envelope.encryption_public_key,
        &envelope.encryption_private_key_nonce,
        &envelope.encrypted_encryption_private_key,
    )?;
    let (signing_nonce, encrypted_signing) = rewrap(
        SIGNING_PURPOSE,
        &envelope.signing_public_key,
        &envelope.signing_seed_nonce,
        &envelope.encrypted_signing_seed,
    )?;
    let kem = match &envelope.kem {
        None => None,
        Some(kem) => {
            let (seed_nonce, encrypted_seed) =
                rewrap(KEM_PURPOSE, &kem.public_key, &kem.seed_nonce, &kem.encrypted_seed)?;
            Some(IdentityKem { seed_nonce, encrypted_seed, ..kem.clone() })
        }
    };
    let ml_dsa = match &envelope.ml_dsa {
        None => None,
        Some(ml_dsa) => {
            let (seed_nonce, encrypted_seed) =
                rewrap(ML_DSA_PURPOSE, &ml_dsa.public_key, &ml_dsa.seed_nonce, &ml_dsa.encrypted_seed)?;
            Some(IdentityMlDsa { seed_nonce, encrypted_seed, ..ml_dsa.clone() })
        }
    };
    Ok(IdentityEnvelope {
        wrapping_salt: encode(&salt),
        encryption_private_key_nonce: encryption_nonce,
        encrypted_encryption_private_key: encrypted_encryption,
        signing_seed_nonce: signing_nonce,
        encrypted_signing_seed: encrypted_signing,
        kem,
        ml_dsa,
        ..envelope
    })
}

/// A new identity under the account key at `key_version`, version 2: fresh
/// X25519, Ed25519, ML-KEM-768 and ML-DSA-65 keys, each private half wrapped
/// under the root with its public key in the associated data (the ML-DSA seed
/// opened again before it is used), and the keys statement signed with both
/// signing keys, exactly as the web's `createIdentity` makes one.
///
/// ```
/// use hushos_core::{identity_create, identity_verify_keys, public_identity, random_bytes};
/// let root = random_bytes(32)?;
/// let envelope = identity_create("user-1".into(), root, 1)?;
/// assert_eq!(envelope.version, 2);
/// assert!(identity_verify_keys("user-1".into(), public_identity(envelope)?));
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn identity_create(
    user_id: String,
    account_key: Vec<u8>,
    key_version: u64,
) -> CoreResult<IdentityEnvelope> {
    let account_key = Zeroizing::new(account_key);
    if key_version < 1 {
        return Err(input("Invalid key version."));
    }
    expect_len("accountKey", &account_key, KEY_BYTES)?;
    let secret = Zeroizing::new(random(32));
    let signing_seed = Zeroizing::new(random(32));
    let encryption_public_key = encode(&derived_public_key(ENCRYPTION_PURPOSE, &secret)?);
    let signing_public_key = encode(&derived_public_key(SIGNING_PURPOSE, &signing_seed)?);
    let salt = random(32);
    let wrap = |purpose: &str, private: &[u8], public_key: &str| {
        wrap_half(&account_key, &salt, &user_id, key_version, purpose, private, public_key)
    };
    let (encryption_nonce, encrypted_encryption) = wrap(ENCRYPTION_PURPOSE, &secret, &encryption_public_key)?;
    let (signing_nonce, encrypted_signing) = wrap(SIGNING_PURPOSE, &signing_seed, &signing_public_key)?;
    let (kem, _kem_seed) = mint_kem(&account_key, &salt, &user_id, key_version)?;
    let (ml_dsa, ml_dsa_seed) = mint_ml_dsa(&account_key, &salt, &user_id, key_version)?;
    let mut identity = IdentityEnvelope {
        version: 2,
        key_version,
        wrapping_salt: encode(&salt),
        encryption_public_key,
        encryption_private_key_nonce: encryption_nonce,
        encrypted_encryption_private_key: encrypted_encryption,
        signing_public_key,
        signing_seed_nonce: signing_nonce,
        encrypted_signing_seed: encrypted_signing,
        kem: Some(kem),
        ml_dsa: Some(ml_dsa),
        keys_signature: None,
    };
    let signature = sign_hybrid(&signing_seed, &ml_dsa_seed, &keys_message(&user_id, &identity)?)?;
    identity.keys_signature = Some(encode(&signature));
    Ok(identity)
}

/// The upgrade of a version 1 identity to version 2 (docs/identity-pq-design.md
/// 2): the same X25519, Ed25519 and ML-KEM keys and the same key version, plus
/// a fresh ML-DSA key (opened again before it is used) and the keys statement
/// signed with both signing keys. A version 1 identity without an ML-KEM key
/// gets one too. The Ed25519 KEM binding is dropped. Nothing is installed:
/// send it with `POST /api/auth/identity/upgrade`, and open whatever the
/// server answers with (another device's upgrade, on 409 `stale`).
///
/// ```
/// use hushos_core::{identity_create, identity_upgrade, random_bytes, CoreError};
/// let root = random_bytes(32)?;
/// let current = identity_create("user-1".into(), root.clone(), 1)?;
/// // Already version 2: never a second ML-DSA key.
/// assert!(matches!(identity_upgrade("user-1".into(), root, current), Err(CoreError::Input(_))));
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn identity_upgrade(
    user_id: String,
    account_key: Vec<u8>,
    envelope: IdentityEnvelope,
) -> CoreResult<IdentityEnvelope> {
    let account_key = Zeroizing::new(account_key);
    check_envelope(&envelope)?;
    if envelope.version != 1 {
        return Err(input("This identity is already upgraded."));
    }
    // Every wrapped half, the KEM seed included, opens to its key before any of them is vouched for.
    let keys = identity_open(user_id.clone(), account_key.to_vec(), envelope.clone())?;
    let salt = decode("wrappingSalt", &envelope.wrapping_salt, Some(32))?;
    let kem = match &envelope.kem {
        Some(kem) => IdentityKem { signature: None, ..kem.clone() },
        None => mint_kem(&account_key, &salt, &user_id, envelope.key_version)?.0,
    };
    let (ml_dsa, ml_dsa_seed) = mint_ml_dsa(&account_key, &salt, &user_id, envelope.key_version)?;
    let mut upgraded = IdentityEnvelope {
        version: 2,
        kem: Some(kem),
        ml_dsa: Some(ml_dsa),
        keys_signature: None,
        ..envelope
    };
    let signature = sign_hybrid(&keys.signing_seed, &ml_dsa_seed, &keys_message(&user_id, &upgraded)?)?;
    upgraded.keys_signature = Some(encode(&signature));
    Ok(upgraded)
}

/// The public keys of a version 2 envelope and its keys signature, as the keys
/// statement and contacts see them. A version 1 envelope is refused.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn public_identity(envelope: IdentityEnvelope) -> CoreResult<PublicIdentity> {
    let (2, Some(kem), Some(ml_dsa), Some(keys_signature)) =
        (envelope.version, envelope.kem, envelope.ml_dsa, envelope.keys_signature)
    else {
        return Err(input("Unsupported identity envelope."));
    };
    Ok(PublicIdentity {
        key_version: envelope.key_version,
        encryption_public_key: envelope.encryption_public_key,
        signing_public_key: envelope.signing_public_key,
        ml_dsa_public_key: ml_dsa.public_key,
        kem_public_key: kem.public_key,
        keys_signature,
    })
}

/// Whether a version 2 identity's keys statement holds: both halves of its
/// hybrid signature, under the Ed25519 and ML-DSA keys it names, over its four
/// public keys, its account and its key version. It proves the identity holds
/// both signing keys and ties the ML-KEM key to them; it is not by itself a
/// reason to trust anyone, which only a words check over the version 3
/// fingerprint is. Anything malformed is false.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn identity_verify_keys(user_id: String, identity: PublicIdentity) -> bool {
    let check = || -> CoreResult<bool> {
        let message = keys_statement(
            user_id.clone(),
            identity.key_version,
            identity.encryption_public_key.clone(),
            identity.signing_public_key.clone(),
            identity.ml_dsa_public_key.clone(),
            identity.kem_public_key.clone(),
        )?;
        let signer = HybridPublicKey {
            signing_public_key: decode("signingPublicKey", &identity.signing_public_key, Some(32))?,
            ml_dsa_public_key: decode(
                "mlDsaPublicKey",
                &identity.ml_dsa_public_key,
                Some(ML_DSA_PUBLIC_KEY_BYTES),
            )?,
        };
        let signature = decode("keysSignature", &identity.keys_signature, Some(HYBRID_SIGNATURE_BYTES))?;
        Ok(verify_hybrid(&signer, &message, &signature))
    };
    check().unwrap_or(false)
}

/// A link of a succession chain, as the server serves it: the old identity's
/// keys, the new one's, and the old identity's hybrid signature over the
/// version 2 statement ([`crate::succession_statement`]).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SuccessionLink {
    pub old_key_version: u64,
    pub new_key_version: u64,
    pub old_encryption_public_key: String,
    pub old_signing_public_key: String,
    pub old_ml_dsa_public_key: String,
    pub new_encryption_public_key: String,
    pub new_signing_public_key: String,
    pub new_ml_dsa_public_key: String,
    pub new_kem_public_key: String,
    /// base64url, 3373 bytes.
    pub signature: String,
}

/// A new identity and the succession signature that vouches for it.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct IdentitySuccession {
    /// Send as `identity` to `POST /api/auth/identity/succession`.
    pub identity: IdentityEnvelope,
    /// base64url, 3373 bytes (the hybrid signature): send as `signature`.
    pub signature: String,
}

/// The keys a contact was pinned with, from a version 3 pin: X25519 and
/// Ed25519 (base64url) and the SHA-256 of the ML-DSA key as lowercase hex
/// ([`crate::key_digest`]). `key_version` is none for a pin made without
/// one; the chain is then found from the keys.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct PinnedKeys {
    pub key_version: Option<u64>,
    pub encryption_public_key: String,
    pub signing_public_key: String,
    pub ml_dsa_public_key_hash: String,
}

/// The keys the server serves for a contact now, in full.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ServedKeys {
    pub key_version: u64,
    pub encryption_public_key: String,
    pub signing_public_key: String,
    pub ml_dsa_public_key: String,
    pub kem_public_key: String,
}

/// The keys a reader already trusts for one position of a chain (the pinned
/// ones, or the previous link's new ones), base64url.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SuccessionSigner {
    pub signing_public_key: String,
    pub ml_dsa_public_key: String,
}

/// Replaces the account's identity: opens `current` under the account key
/// (proving both signing seeds; a version 1 identity is refused: upgrade it
/// first), mints the next version 2 identity at `key_version + 1` and signs
/// the version 2 succession statement with the current hybrid signature.
/// Nothing is installed; once the server accepts it, open the new identity
/// and keep the old one's keys for shares sealed to them.
///
/// ```
/// use hushos_core::*;
/// let root = random_bytes(32)?;
/// let current = identity_create("user-1".into(), root.clone(), 1)?;
/// let next = identity_succeed("user-1".into(), root, current.clone())?;
/// assert_eq!(next.identity.key_version, 2);
/// let mut link = SuccessionLink {
///     old_key_version: 1, new_key_version: 2,
///     old_encryption_public_key: current.encryption_public_key.clone(), old_signing_public_key: current.signing_public_key.clone(),
///     old_ml_dsa_public_key: current.ml_dsa.clone().unwrap().public_key,
///     new_encryption_public_key: next.identity.encryption_public_key.clone(), new_signing_public_key: next.identity.signing_public_key.clone(),
///     new_ml_dsa_public_key: next.identity.ml_dsa.clone().unwrap().public_key,
///     new_kem_public_key: next.identity.kem.clone().unwrap().public_key, signature: next.signature,
/// };
/// let signer = SuccessionSigner { signing_public_key: current.signing_public_key, ml_dsa_public_key: current.ml_dsa.unwrap().public_key };
/// assert!(succession_verify("user-1".into(), link.clone(), signer.clone()));
/// // Stripped to its Ed25519 half, it is no succession.
/// link.signature = base64url_encode(base64url_decode(link.signature)?[..64].to_vec());
/// assert!(!succession_verify("user-1".into(), link, signer));
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn identity_succeed(
    user_id: String,
    account_key: Vec<u8>,
    current: IdentityEnvelope,
) -> CoreResult<IdentitySuccession> {
    // Every copy of the account key is wiped: this one on return, each callee's own on theirs.
    let account_key = Zeroizing::new(account_key);
    check_envelope(&current)?;
    if current.version != 2 {
        return Err(input("Upgrade this identity first."));
    }
    // The opened keys wipe themselves when dropped.
    let keys = identity_open(user_id.clone(), account_key.to_vec(), current.clone())?;
    let identity = identity_create(user_id.clone(), account_key.to_vec(), current.key_version + 1)?;
    let lattice =
        |envelope: &IdentityEnvelope| envelope.ml_dsa.as_ref().expect("version 2").public_key.clone();
    let link = SuccessionLink {
        old_key_version: current.key_version,
        new_key_version: identity.key_version,
        old_encryption_public_key: current.encryption_public_key.clone(),
        old_signing_public_key: current.signing_public_key.clone(),
        old_ml_dsa_public_key: lattice(&current),
        new_encryption_public_key: identity.encryption_public_key.clone(),
        new_signing_public_key: identity.signing_public_key.clone(),
        new_ml_dsa_public_key: lattice(&identity),
        new_kem_public_key: identity.kem.as_ref().expect("minted with a KEM key").public_key.clone(),
        signature: String::new(),
    };
    let signature =
        sign_hybrid(&keys.signing_seed, &keys.ml_dsa_seed, &succession_statement(user_id, link)?)?;
    Ok(IdentitySuccession { identity, signature: encode(&signature) })
}

/// Whether one link holds: its version 2 statement, signed with both halves
/// of the hybrid signature under `signer`, the keys the reader already trusts
/// for that position of the chain (the pinned ones, or the previous link's
/// new ones). Never under keys only the link itself names.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn succession_verify(user_id: String, link: SuccessionLink, signer: SuccessionSigner) -> bool {
    let check = || -> CoreResult<bool> {
        let signature = decode("signature", &link.signature, Some(HYBRID_SIGNATURE_BYTES))?;
        let keys = HybridPublicKey {
            signing_public_key: decode("signingPublicKey", &signer.signing_public_key, Some(32))?,
            ml_dsa_public_key: decode(
                "mlDsaPublicKey",
                &signer.ml_dsa_public_key,
                Some(ML_DSA_PUBLIC_KEY_BYTES),
            )?,
        };
        Ok(verify_hybrid(&keys, &succession_statement(user_id.clone(), link.clone())?, &signature))
    };
    check().unwrap_or(false)
}

/* SHA-256 of a base64url ML-DSA public key, as hex; None when it is not one. */
fn ml_dsa_digest_of(public_key: &str) -> Option<String> {
    decode("mlDsaPublicKey", public_key, Some(ML_DSA_PUBLIC_KEY_BYTES)).ok().map(crate::contacts::key_digest)
}

/// Whether `links` carry a contact from the keys pinned to the keys served
/// (docs/identity-pq-design.md 2). Continuity is by keys, not version numbers
/// (a master-key rotation may lift an identity's version between two
/// successions):
/// - the chain starts only at a link whose old X25519, Ed25519 and ML-DSA keys
///   are the pin's (the ML-DSA key by its digest);
/// - each link's old keys are the previous link's new keys, ML-DSA included,
///   and versions only rise;
/// - each signature verifies, both halves, under the pinned keys or the
///   previous link's new keys;
/// - the last link's new X25519, Ed25519, ML-DSA and ML-KEM keys are the
///   served ones.
///
/// Any gap, fork or bad signature and the chain does not hold: that is the
/// changed-key warning, never a silent update.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn succession_chain_verify(
    user_id: String,
    pinned: PinnedKeys,
    served: ServedKeys,
    links: Vec<SuccessionLink>,
) -> bool {
    let Some(start) = links.iter().position(|link| {
        link.old_encryption_public_key == pinned.encryption_public_key
            && link.old_signing_public_key == pinned.signing_public_key
            && ml_dsa_digest_of(&link.old_ml_dsa_public_key).as_deref()
                == Some(pinned.ml_dsa_public_key_hash.as_str())
    }) else {
        return false;
    };
    let chain = &links[start..];
    let mut version = pinned.key_version.unwrap_or(0);
    let mut encryption = pinned.encryption_public_key;
    let mut signer = SuccessionSigner {
        signing_public_key: pinned.signing_public_key,
        // The first link's old ML-DSA key, matched to the pin by digest above.
        ml_dsa_public_key: chain[0].old_ml_dsa_public_key.clone(),
    };
    let mut kem = String::new();
    for link in chain {
        if link.old_key_version < version
            || link.old_encryption_public_key != encryption
            || link.old_signing_public_key != signer.signing_public_key
            || link.old_ml_dsa_public_key != signer.ml_dsa_public_key
            || !succession_verify(user_id.clone(), link.clone(), signer.clone())
        {
            return false;
        }
        version = link.new_key_version;
        encryption = link.new_encryption_public_key.clone();
        signer = SuccessionSigner {
            signing_public_key: link.new_signing_public_key.clone(),
            ml_dsa_public_key: link.new_ml_dsa_public_key.clone(),
        };
        kem = link.new_kem_public_key.clone();
    }
    served.key_version >= version
        && encryption == served.encryption_public_key
        && signer.signing_public_key == served.signing_public_key
        && signer.ml_dsa_public_key == served.ml_dsa_public_key
        && kem == served.kem_public_key
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::bytes::random;
    use crate::contacts::key_digest;
    use crate::signatures::sign;

    const USER: &str = "11111111-1111-4111-8111-111111111111";
    const FRIEND: &str = "33333333-3333-4333-8333-333333333333";

    thread_local! {
        /*
         * Makes `mint_ml_dsa` wrap the seed at the wrong key version (the wrong
         * associated data, the bug its re-open guards against), on this test
         * thread only.
         */
        pub(crate) static MISWRAP_ML_DSA: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }

    /* A version 1 identity as accounts held them before the release, from a version 2 one's keys. */
    pub(crate) fn version_one(envelope: &IdentityEnvelope, with_kem: bool) -> IdentityEnvelope {
        IdentityEnvelope {
            version: 1,
            kem: if with_kem {
                envelope.kem.clone().map(|kem| IdentityKem { signature: Some(encode(&[0; 64])), ..kem })
            } else {
                None
            },
            ml_dsa: None,
            keys_signature: None,
            ..envelope.clone()
        }
    }

    fn ml_dsa_of(envelope: &IdentityEnvelope) -> String {
        envelope.ml_dsa.as_ref().unwrap().public_key.clone()
    }

    fn link(old: &IdentityEnvelope, next: &IdentityEnvelope, signature: &str) -> SuccessionLink {
        SuccessionLink {
            old_key_version: old.key_version,
            new_key_version: next.key_version,
            old_encryption_public_key: old.encryption_public_key.clone(),
            old_signing_public_key: old.signing_public_key.clone(),
            old_ml_dsa_public_key: ml_dsa_of(old),
            new_encryption_public_key: next.encryption_public_key.clone(),
            new_signing_public_key: next.signing_public_key.clone(),
            new_ml_dsa_public_key: ml_dsa_of(next),
            new_kem_public_key: next.kem.as_ref().unwrap().public_key.clone(),
            signature: signature.into(),
        }
    }

    fn signer(identity: &IdentityEnvelope) -> SuccessionSigner {
        SuccessionSigner {
            signing_public_key: identity.signing_public_key.clone(),
            ml_dsa_public_key: ml_dsa_of(identity),
        }
    }

    fn pinned(identity: &IdentityEnvelope) -> PinnedKeys {
        PinnedKeys {
            key_version: Some(identity.key_version),
            encryption_public_key: identity.encryption_public_key.clone(),
            signing_public_key: identity.signing_public_key.clone(),
            ml_dsa_public_key_hash: key_digest(decode("k", &ml_dsa_of(identity), None).unwrap()),
        }
    }

    fn served(identity: &IdentityEnvelope) -> ServedKeys {
        ServedKeys {
            key_version: identity.key_version,
            encryption_public_key: identity.encryption_public_key.clone(),
            signing_public_key: identity.signing_public_key.clone(),
            ml_dsa_public_key: ml_dsa_of(identity),
            kem_public_key: identity.kem.as_ref().unwrap().public_key.clone(),
        }
    }

    fn flip(value: &str, at: usize) -> String {
        let mut bytes = decode("v", value, None).unwrap();
        bytes[at] ^= 1;
        encode(&bytes)
    }

    #[test]
    fn identity_open_checks_every_private_half_against_the_published_keys() {
        let root = random(32);
        let envelope = identity_create("User-1".into(), root.clone(), 1).unwrap();
        let keys = identity_open("user-1".into(), root.clone(), envelope.clone()).unwrap();
        assert_eq!(keys.identity_version, 2);
        assert_eq!(encode(&ml_dsa_public_key(&keys.ml_dsa_seed).unwrap()), ml_dsa_of(&envelope));
        assert_eq!(
            encode(&kem_public_key_from_seed(&keys.kem_seed).unwrap()),
            envelope.kem.clone().unwrap().public_key
        );
        assert!(matches!(
            identity_open("user-2".into(), root.clone(), envelope.clone()),
            Err(CoreError::Sealed(_))
        ));
        assert!(matches!(
            identity_open("user-1".into(), random(32), envelope.clone()),
            Err(CoreError::Sealed(_))
        ));
        let stranger = identity_create("user-1".into(), random(32), 1).unwrap();
        // Each served public key swapped for someone else's: the seed does not make it.
        let swaps = [
            IdentityEnvelope {
                encryption_public_key: stranger.encryption_public_key.clone(),
                ..envelope.clone()
            },
            IdentityEnvelope { signing_public_key: stranger.signing_public_key.clone(), ..envelope.clone() },
            IdentityEnvelope {
                kem: Some(IdentityKem {
                    public_key: stranger.kem.clone().unwrap().public_key,
                    ..envelope.kem.clone().unwrap()
                }),
                ..envelope.clone()
            },
            IdentityEnvelope {
                ml_dsa: Some(IdentityMlDsa {
                    public_key: ml_dsa_of(&stranger),
                    ..envelope.ml_dsa.clone().unwrap()
                }),
                ..envelope.clone()
            },
        ];
        for swapped in swaps {
            assert!(matches!(
                identity_open("user-1".into(), root.clone(), swapped),
                Err(CoreError::Sealed(_))
            ));
        }
        // A version 2 identity whose keys statement does not hold is not used, though every seed opens.
        let mut unsigned = envelope.clone();
        unsigned.keys_signature = Some(flip(envelope.keys_signature.as_ref().unwrap(), 70));
        assert!(matches!(identity_open("user-1".into(), root.clone(), unsigned), Err(CoreError::Sealed(_))));
        // Version 2 without its lattice parts is no envelope at all.
        for incomplete in [
            IdentityEnvelope { ml_dsa: None, ..envelope.clone() },
            IdentityEnvelope { kem: None, ..envelope.clone() },
            IdentityEnvelope { keys_signature: None, ..envelope.clone() },
            IdentityEnvelope { version: 3, ..envelope.clone() },
        ] {
            assert!(matches!(
                identity_open("user-1".into(), root.clone(), incomplete),
                Err(CoreError::Input(_))
            ));
        }
        // Version 1 still opens, with or without its KEM key, and says what it is.
        let legacy = identity_open("user-1".into(), root.clone(), version_one(&envelope, true)).unwrap();
        assert_eq!((legacy.identity_version, legacy.ml_dsa_seed.len(), legacy.kem_seed.len()), (1, 0, 64));
        let older = identity_open("user-1".into(), root, version_one(&envelope, false)).unwrap();
        assert!(
            older.kem_seed.is_empty() && older.kem_public_key.is_none() && older.ml_dsa_public_key.is_none()
        );
    }

    #[test]
    fn a_debug_print_of_the_opened_identity_hides_every_private_half() {
        let root = random(32);
        let keys =
            identity_open("u".into(), root.clone(), identity_create("u".into(), root, 1).unwrap()).unwrap();
        let printed = format!("{keys:?}");
        for secret in [&keys.encryption_private_key, &keys.signing_seed, &keys.kem_seed, &keys.ml_dsa_seed] {
            assert!(!crate::bytes::shows(&printed, secret), "{printed}");
        }
        assert!(printed.contains(keys.ml_dsa_public_key.as_ref().unwrap()));
    }

    #[test]
    fn the_keys_statement_binds_all_four_keys_the_account_and_the_version() {
        let root = random(32);
        let envelope = identity_create(USER.into(), root.clone(), 3).unwrap();
        let public = public_identity(envelope.clone()).unwrap();
        assert!(identity_verify_keys(USER.into(), public.clone()));
        assert!(identity_verify_keys(USER.to_uppercase(), public.clone()), "ids are lowercased");
        assert!(!identity_verify_keys(FRIEND.into(), public.clone()));
        let other = public_identity(identity_create(USER.into(), random(32), 3).unwrap()).unwrap();
        for changed in [
            PublicIdentity { key_version: 4, ..public.clone() },
            PublicIdentity { encryption_public_key: other.encryption_public_key.clone(), ..public.clone() },
            PublicIdentity { signing_public_key: other.signing_public_key.clone(), ..public.clone() },
            PublicIdentity { ml_dsa_public_key: other.ml_dsa_public_key.clone(), ..public.clone() },
            PublicIdentity { kem_public_key: other.kem_public_key.clone(), ..public.clone() },
        ] {
            assert!(!identity_verify_keys(USER.into(), changed));
        }
        let signature = decode("s", &public.keys_signature, Some(HYBRID_SIGNATURE_BYTES)).unwrap();
        // One half broken, the other intact, each way round; and the Ed25519 half alone.
        for at in [5, 64 + 100] {
            assert!(!identity_verify_keys(
                USER.into(),
                PublicIdentity { keys_signature: flip(&public.keys_signature, at), ..public.clone() }
            ));
        }
        let stripped = PublicIdentity { keys_signature: encode(&signature[..64]), ..public.clone() };
        assert!(!identity_verify_keys(USER.into(), stripped));
        // The Ed25519 half followed by an ML-DSA signature under the group key's context.
        let keys = identity_open(USER.into(), root, envelope.clone()).unwrap();
        let message = keys_message(USER, &envelope).unwrap();
        let mut grouped = signature[..64].to_vec();
        grouped.extend(crate::pq::ml_dsa_sign(&keys.ml_dsa_seed, &message, b"hushos/group/v1").unwrap());
        assert!(!identity_verify_keys(
            USER.into(),
            PublicIdentity { keys_signature: encode(&grouped), ..public }
        ));
        assert!(public_identity(version_one(&envelope, true)).is_err());
    }

    #[test]
    fn identity_rewrap_moves_every_seed_and_keeps_the_public_keys_version_and_keys_signature() {
        let (old_root, new_root) = (random(32), random(32));
        let envelope = identity_create("user-1".into(), old_root.clone(), 2).unwrap();
        let before = identity_open("user-1".into(), old_root.clone(), envelope.clone()).unwrap();
        let rewrapped =
            identity_rewrap("user-1".into(), old_root.clone(), new_root.clone(), envelope.clone()).unwrap();
        assert_eq!(public_identity(rewrapped.clone()).unwrap(), public_identity(envelope.clone()).unwrap());
        assert_ne!(rewrapped.wrapping_salt, envelope.wrapping_salt);
        let after = identity_open("user-1".into(), new_root.clone(), rewrapped.clone()).unwrap();
        assert_eq!(
            (
                after.encryption_private_key.to_vec(),
                after.signing_seed.to_vec(),
                after.kem_seed.to_vec(),
                after.ml_dsa_seed.to_vec()
            ),
            (
                before.encryption_private_key.to_vec(),
                before.signing_seed.to_vec(),
                before.kem_seed.to_vec(),
                before.ml_dsa_seed.to_vec()
            )
        );
        assert!(matches!(
            identity_open("user-1".into(), old_root.clone(), rewrapped),
            Err(CoreError::Sealed(_))
        ));
        assert!(
            matches!(
                identity_rewrap("user-1".into(), new_root.clone(), old_root.clone(), envelope.clone()),
                Err(CoreError::Sealed(_))
            ),
            "the old root must open it"
        );
        let stranger = identity_create("user-1".into(), random(32), 2).unwrap();
        let swapped = IdentityEnvelope {
            ml_dsa: Some(IdentityMlDsa {
                public_key: ml_dsa_of(&stranger),
                ..envelope.ml_dsa.clone().unwrap()
            }),
            ..envelope.clone()
        };
        assert!(matches!(
            identity_rewrap("user-1".into(), old_root.clone(), new_root.clone(), swapped),
            Err(CoreError::Sealed(_))
        ));
        // A version 1 identity in the history is rewrapped as it is, binding and all.
        let legacy = version_one(&envelope, true);
        let moved = identity_rewrap("user-1".into(), old_root, new_root.clone(), legacy.clone()).unwrap();
        assert_eq!(
            (moved.version, moved.kem.as_ref().unwrap().signature.clone()),
            (1, legacy.kem.unwrap().signature)
        );
        assert_eq!(
            identity_open("user-1".into(), new_root, moved).unwrap().kem_seed.to_vec(),
            before.kem_seed.to_vec()
        );
    }

    #[test]
    fn the_upgrade_keeps_the_keys_and_version_adds_an_ml_dsa_key_that_opens_and_drops_the_binding() {
        let root = random(32);
        let envelope = identity_create(USER.into(), root.clone(), 3).unwrap();
        let legacy = version_one(&envelope, true);
        let upgraded = identity_upgrade(USER.into(), root.clone(), legacy.clone()).unwrap();
        assert_eq!(upgraded.version, 2);
        assert_eq!(upgraded.key_version, legacy.key_version);
        assert_eq!(upgraded.encryption_public_key, legacy.encryption_public_key);
        assert_eq!(upgraded.signing_public_key, legacy.signing_public_key);
        assert_eq!(upgraded.kem.as_ref().unwrap().public_key, legacy.kem.as_ref().unwrap().public_key);
        assert_eq!(upgraded.kem.as_ref().unwrap().signature, None, "the Ed25519 binding is dropped");
        assert_ne!(ml_dsa_of(&upgraded), ml_dsa_of(&envelope), "a fresh ML-DSA key");
        assert!(identity_verify_keys(USER.into(), public_identity(upgraded.clone()).unwrap()));
        let keys = identity_open(USER.into(), root.clone(), upgraded.clone()).unwrap();
        assert_eq!(keys.ml_dsa_public_key, Some(ml_dsa_of(&upgraded)));
        // The private halves are the same ones: what was sealed to them still opens.
        let before = identity_open(USER.into(), root.clone(), legacy.clone()).unwrap();
        assert_eq!(keys.encryption_private_key.to_vec(), before.encryption_private_key.to_vec());
        assert_eq!(keys.kem_seed.to_vec(), before.kem_seed.to_vec());
        // Only once: never a second ML-DSA key.
        assert!(matches!(
            identity_upgrade(USER.into(), root.clone(), upgraded.clone()),
            Err(CoreError::Input(_))
        ));
        // A master-key rotation afterwards keeps the ML-DSA seed openable.
        let next_root = random(32);
        let rotated =
            identity_rewrap(USER.into(), root.clone(), next_root.clone(), upgraded.clone()).unwrap();
        assert_eq!(
            identity_open(USER.into(), next_root, rotated).unwrap().ml_dsa_seed.to_vec(),
            keys.ml_dsa_seed.to_vec()
        );
        // From before hybrid sharing: it gains an ML-KEM key as well.
        let older = identity_upgrade(USER.into(), root.clone(), version_one(&envelope, false)).unwrap();
        assert_ne!(older.kem.as_ref().unwrap().public_key, envelope.kem.as_ref().unwrap().public_key);
        assert_eq!(
            identity_open(USER.into(), root.clone(), older.clone()).unwrap().kem_public_key,
            Some(older.kem.unwrap().public_key)
        );
    }

    #[test]
    fn the_upgrade_refuses_an_identity_whose_keys_do_not_open_under_this_root() {
        let root = random(32);
        let envelope = identity_create(USER.into(), root.clone(), 1).unwrap();
        let stranger = identity_create(USER.into(), random(32), 1).unwrap();
        let legacy = version_one(&envelope, true);
        for broken in [
            IdentityEnvelope { signing_public_key: stranger.signing_public_key.clone(), ..legacy.clone() },
            IdentityEnvelope {
                encryption_public_key: stranger.encryption_public_key.clone(),
                ..legacy.clone()
            },
            IdentityEnvelope {
                kem: Some(IdentityKem {
                    public_key: stranger.kem.clone().unwrap().public_key,
                    ..legacy.kem.clone().unwrap()
                }),
                ..legacy.clone()
            },
            // Another key version: the wrapped halves name the version they were sealed at.
            IdentityEnvelope { key_version: 2, ..legacy.clone() },
        ] {
            assert!(identity_upgrade(USER.into(), root.clone(), broken).is_err());
        }
        assert!(identity_upgrade(USER.into(), random(32), legacy.clone()).is_err());
        assert!(identity_upgrade(FRIEND.into(), root, legacy).is_err());
    }

    #[test]
    fn an_identity_whose_ml_dsa_seed_was_wrapped_so_it_does_not_open_is_never_made_or_upgraded() {
        let root = random(32);
        let legacy = version_one(&identity_create(USER.into(), root.clone(), 2).unwrap(), true);
        MISWRAP_ML_DSA.with(|miswrap| miswrap.set(true));
        let created = identity_create(USER.into(), root.clone(), 2);
        let upgraded = identity_upgrade(USER.into(), root.clone(), legacy.clone());
        MISWRAP_ML_DSA.with(|miswrap| miswrap.set(false));
        // Signing with the seed still in memory would succeed; uploading the result would strand the account.
        assert!(
            matches!(created, Err(CoreError::Sealed(_))),
            "identity_create made an unopenable ML-DSA seed"
        );
        assert!(
            matches!(upgraded, Err(CoreError::Sealed(_))),
            "identity_upgrade made an unopenable ML-DSA seed"
        );
        // The same calls with an honest wrap go through.
        assert!(identity_create(USER.into(), root.clone(), 2).is_ok());
        assert!(identity_upgrade(USER.into(), root, legacy).is_ok());
    }

    #[test]
    fn a_wrapped_ml_dsa_seed_that_does_not_open_again_to_its_key_is_refused_before_it_is_used() {
        let (root, salt) = (random(32), random(32));
        let (wrapped, _) = mint_ml_dsa(&root, &salt, USER, 1).unwrap();
        assert!(reopens_ml_dsa(&root, &salt, USER, 1, &wrapped).is_ok());
        // Sealed under the wrong root, the wrong salt, or naming a key the seed does not make.
        assert!(reopens_ml_dsa(&random(32), &salt, USER, 1, &wrapped).is_err());
        assert!(reopens_ml_dsa(&root, &random(32), USER, 1, &wrapped).is_err());
        let seed = random(32);
        let (seed_nonce, encrypted_seed) =
            wrap_half(&root, &salt, USER, 1, ML_DSA_PURPOSE, &seed, &wrapped.public_key).unwrap();
        let mislabelled =
            IdentityMlDsa { public_key: wrapped.public_key.clone(), seed_nonce, encrypted_seed };
        assert!(
            matches!(reopens_ml_dsa(&root, &salt, USER, 1, &mislabelled), Err(CoreError::Sealed(m)) if m == MISMATCH)
        );
    }

    #[test]
    fn a_succession_is_signed_by_both_old_keys_and_binds_the_new_ones() {
        let root = random(32);
        let first = identity_create(USER.into(), root.clone(), 1).unwrap();
        let next = identity_succeed(USER.into(), root.clone(), first.clone()).unwrap();
        assert_eq!(next.identity.key_version, 2);
        assert_eq!(next.identity.version, 2);
        assert_ne!(ml_dsa_of(&next.identity), ml_dsa_of(&first));
        let one = link(&first, &next.identity, &next.signature);
        assert_eq!(decode("s", &next.signature, None).unwrap().len(), HYBRID_SIGNATURE_BYTES);
        assert!(succession_verify(USER.into(), one.clone(), signer(&first)));
        assert!(
            !succession_verify(FRIEND.into(), one.clone(), signer(&first)),
            "the account is in the statement"
        );
        let other = identity_create(USER.into(), root.clone(), 2).unwrap();
        assert!(!succession_verify(
            USER.into(),
            SuccessionLink { new_ml_dsa_public_key: ml_dsa_of(&other), ..one.clone() },
            signer(&first)
        ));
        assert!(!succession_verify(
            USER.into(),
            SuccessionLink { new_kem_public_key: other.kem.clone().unwrap().public_key, ..one.clone() },
            signer(&first)
        ));
        // Under the new keys, or keys the link itself names, it is no succession of the old ones.
        assert!(!succession_verify(USER.into(), one.clone(), signer(&next.identity)));
        // A version 1 identity cannot succeed: it has no hybrid signature to vouch with.
        assert!(matches!(
            identity_succeed(USER.into(), root, version_one(&first, true)),
            Err(CoreError::Input(_))
        ));
    }

    #[test]
    fn a_succession_with_either_half_broken_or_signed_with_ed25519_alone_does_not_hold() {
        let root = random(32);
        let first = identity_create(USER.into(), root.clone(), 1).unwrap();
        let next = identity_succeed(USER.into(), root.clone(), first.clone()).unwrap();
        let one = link(&first, &next.identity, &next.signature);
        for at in [5, 64 + 100, HYBRID_SIGNATURE_BYTES - 1] {
            assert!(
                !succession_verify(
                    USER.into(),
                    SuccessionLink { signature: flip(&next.signature, at), ..one.clone() },
                    signer(&first)
                ),
                "byte {at}"
            );
        }
        let bytes = decode("s", &next.signature, None).unwrap();
        let stripped = SuccessionLink { signature: encode(&bytes[..64]), ..one.clone() };
        assert!(!succession_verify(USER.into(), stripped, signer(&first)));
        // A genuine Ed25519 signature over the statement on its own, as version 1 signed.
        let seed = identity_open(USER.into(), root, first.clone()).unwrap().signing_seed;
        let classical = sign(&seed, &succession_statement(USER.into(), one.clone()).unwrap()).unwrap();
        assert!(!succession_verify(
            USER.into(),
            SuccessionLink { signature: encode(&classical), ..one.clone() },
            signer(&first)
        ));
        // And padded out to the hybrid length with zeros: the ML-DSA half must verify.
        let mut padded = classical;
        padded.resize(HYBRID_SIGNATURE_BYTES, 0);
        assert!(!succession_verify(
            USER.into(),
            SuccessionLink { signature: encode(&padded), ..one },
            signer(&first)
        ));
    }

    /* Three generations of one account: the first pinned by a contact, the third served now. */
    fn generations() -> (Vec<u8>, [IdentityEnvelope; 3], Vec<SuccessionLink>) {
        let root = random(32);
        let first = identity_create(USER.into(), root.clone(), 1).unwrap();
        let second = identity_succeed(USER.into(), root.clone(), first.clone()).unwrap();
        let third = identity_succeed(USER.into(), root.clone(), second.identity.clone()).unwrap();
        let links = vec![
            link(&first, &second.identity, &second.signature),
            link(&second.identity, &third.identity, &third.signature),
        ];
        (root, [first, second.identity, third.identity], links)
    }

    #[test]
    fn a_chain_holds_from_the_pinned_keys_to_the_served_ones_and_nothing_else_does() {
        let (root, [first, second, third], links) = generations();
        let pin = pinned(&first);
        let now = served(&third);
        assert!(succession_chain_verify(USER.into(), pin.clone(), now.clone(), links.clone()));
        assert!(succession_chain_verify(
            USER.into(),
            PinnedKeys { key_version: None, ..pin.clone() },
            now.clone(),
            links.clone()
        ));
        // A pin of the second identity starts at the second link, whatever comes before.
        assert!(succession_chain_verify(USER.into(), pinned(&second), now.clone(), links.clone()));
        assert!(succession_chain_verify(USER.into(), pinned(&second), now.clone(), links[1..].to_vec()));
        // The real chain does not vouch for keys served beside it.
        let forged = identity_create(USER.into(), root.clone(), 3).unwrap();
        for changed in [
            ServedKeys { key_version: 2, ..now.clone() },
            ServedKeys { encryption_public_key: forged.encryption_public_key.clone(), ..now.clone() },
            ServedKeys { signing_public_key: forged.signing_public_key.clone(), ..now.clone() },
            ServedKeys { ml_dsa_public_key: ml_dsa_of(&forged), ..now.clone() },
            ServedKeys { kem_public_key: forged.kem.clone().unwrap().public_key, ..now.clone() },
        ] {
            assert!(!succession_chain_verify(USER.into(), pin.clone(), changed, links.clone()));
        }
        // A gap, links out of order, a flipped signature, a fork, no chain, another account.
        assert!(!succession_chain_verify(USER.into(), pin.clone(), now.clone(), links[1..].to_vec()));
        assert!(!succession_chain_verify(
            USER.into(),
            pin.clone(),
            now.clone(),
            vec![links[1].clone(), links[0].clone()]
        ));
        let flipped = SuccessionLink { signature: flip(&links[1].signature, 3), ..links[1].clone() };
        assert!(!succession_chain_verify(
            USER.into(),
            pin.clone(),
            now.clone(),
            vec![links[0].clone(), flipped]
        ));
        let branch = link(&first, &third, &links[1].signature);
        assert!(!succession_chain_verify(USER.into(), pin.clone(), now.clone(), vec![branch]));
        assert!(!succession_chain_verify(USER.into(), pin.clone(), now.clone(), vec![]));
        assert!(!succession_chain_verify(FRIEND.into(), pin.clone(), now.clone(), links.clone()));
        // A server that mints its own successor and signs the link with keys it holds.
        let own = identity_open(USER.into(), root, forged.clone()).unwrap();
        let unsigned = link(&second, &forged, "");
        let signature = sign_hybrid(
            &own.signing_seed,
            &own.ml_dsa_seed,
            &succession_statement(USER.into(), unsigned.clone()).unwrap(),
        )
        .unwrap();
        let planted = SuccessionLink { signature: encode(&signature), ..unsigned };
        assert!(!succession_chain_verify(USER.into(), pin, served(&forged), vec![links[0].clone(), planted]));
    }

    #[test]
    fn a_chain_never_verifies_a_half_under_an_ml_dsa_key_the_pin_did_not_name() {
        let (root, [first, second, third], links) = generations();
        // A quantum forger of Ed25519: the pinned X25519 and Ed25519 keys with an ML-DSA key of
        // their own. The Ed25519 half is made with the real key (as such a forger could), the
        // ML-DSA half with theirs, and the link names theirs as the old one.
        let forger = identity_create(USER.into(), root.clone(), 2).unwrap();
        let forger_keys = identity_open(USER.into(), root.clone(), forger.clone()).unwrap();
        let real = identity_open(USER.into(), root.clone(), first.clone()).unwrap();
        let hijack =
            SuccessionLink { old_ml_dsa_public_key: ml_dsa_of(&forger), ..link(&first, &forger, "") };
        let signature = sign_hybrid(
            &real.signing_seed,
            &forger_keys.ml_dsa_seed,
            &succession_statement(USER.into(), hijack.clone()).unwrap(),
        )
        .unwrap();
        let hijack = SuccessionLink { signature: encode(&signature), ..hijack };
        // Both halves verify under the keys the link itself names...
        let named = SuccessionSigner {
            signing_public_key: first.signing_public_key.clone(),
            ml_dsa_public_key: ml_dsa_of(&forger),
        };
        assert!(succession_verify(USER.into(), hijack.clone(), named));
        // ...but the chain starts only where the pin's ML-DSA digest matches, so it never starts.
        assert!(!succession_chain_verify(USER.into(), pinned(&first), served(&forger), vec![hijack]));
        // A later link whose old ML-DSA key is not the previous link's new one breaks the chain,
        // under a signature valid for the keys that link names.
        let second_keys = identity_open(USER.into(), root, second.clone()).unwrap();
        let swapped =
            SuccessionLink { old_ml_dsa_public_key: ml_dsa_of(&forger), ..link(&second, &third, "") };
        let signature = sign_hybrid(
            &second_keys.signing_seed,
            &forger_keys.ml_dsa_seed,
            &succession_statement(USER.into(), swapped.clone()).unwrap(),
        )
        .unwrap();
        let swapped = SuccessionLink { signature: encode(&signature), ..swapped };
        assert!(!succession_chain_verify(
            USER.into(),
            pinned(&first),
            served(&third),
            vec![links[0].clone(), swapped]
        ));
        // A pin whose ML-DSA digest is not the first link's old key's: no start.
        let wrong = PinnedKeys {
            ml_dsa_public_key_hash: key_digest(decode("k", &ml_dsa_of(&forger), None).unwrap()),
            ..pinned(&first)
        };
        assert!(!succession_chain_verify(USER.into(), wrong, served(&third), links.clone()));
        // A version 1 pin (no digest) carries nothing.
        let unpinned = PinnedKeys { ml_dsa_public_key_hash: String::new(), ..pinned(&first) };
        assert!(!succession_chain_verify(USER.into(), unpinned, served(&third), links));
    }

    #[test]
    fn versions_only_rise_along_a_chain() {
        let (root, [first, second, _], links) = generations();
        // Signed by the second identity's keys, but numbered below where the chain stands.
        let keys = identity_open(USER.into(), root.clone(), second.clone()).unwrap();
        let next = identity_create(USER.into(), root, 2).unwrap();
        let lowered = IdentityEnvelope { key_version: 1, ..second.clone() };
        let unsigned = link(&lowered, &next, "");
        let signature = sign_hybrid(
            &keys.signing_seed,
            &keys.ml_dsa_seed,
            &succession_statement(USER.into(), unsigned.clone()).unwrap(),
        )
        .unwrap();
        let fallen = SuccessionLink { signature: encode(&signature), ..unsigned };
        assert!(succession_verify(USER.into(), fallen.clone(), signer(&second)));
        assert!(!succession_chain_verify(
            USER.into(),
            pinned(&first),
            served(&next),
            vec![links[0].clone(), fallen]
        ));
    }
}
