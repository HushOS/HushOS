//! The identity: an X25519 key and an ML-KEM-768 key that shares are sealed
//! to, and an Ed25519 key that signs every write, share and succession, all
//! kept wrapped under the account key exactly as `packages/crypto/identity.ts`
//! writes them. Opening checks the private halves against the published
//! public keys, so a swapped envelope cannot put a stranger's key in the
//! session. An identity is replaced by a succession: the next one, minted at
//! the next key version and vouched for by the old signing key.

use crate::bytes::{decode, encode, expect_len, random, Redacted, SecretBytes, KEY_BYTES};
use crate::envelope::{context, open_with_nonce, seal_with_nonce};
use crate::error::{input, CoreError, CoreResult};
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

/// The private halves, opened: what opens a share sealed to this account and
/// signs what it writes. Each private half is [`SecretBytes`]: wiped when the
/// record is dropped.
#[derive(Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct IdentityKeys {
    /// The identity's generation: 1, then one more with each succession.
    pub key_version: u64,
    pub encryption_public_key: String,
    /// X25519, 32 bytes.
    pub encryption_private_key: SecretBytes,
    /// Ed25519, checked against the signing seed: what this account's fingerprint covers beside the X25519 key.
    pub signing_public_key: String,
    /// The Ed25519 seed, 32 bytes: signs metadata, versions, shares and a succession.
    pub signing_seed: SecretBytes,
    /// The ML-KEM-768 seed, 64 bytes; empty for an identity without a KEM key yet.
    pub kem_seed: SecretBytes,
    pub kem_public_key: Option<String>,
}

impl fmt::Debug for IdentityKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IdentityKeys")
            .field("key_version", &self.key_version)
            .field("encryption_public_key", &self.encryption_public_key)
            .field("encryption_private_key", &Redacted)
            .field("signing_public_key", &self.signing_public_key)
            .field("signing_seed", &Redacted)
            .field("kem_seed", &Redacted)
            .field("kem_public_key", &self.kem_public_key)
            .finish()
    }
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

/// Opens the identity's private keys under the account key and checks each
/// against its published public key, the signing seed included, so the
/// fingerprint shown for this account covers keys it really holds.
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
    let account_key = Zeroizing::new(account_key);
    if envelope.version != 1 || envelope.key_version < 1 {
        return Err(input("Unsupported identity envelope."));
    }
    expect_len("accountKey", &account_key, KEY_BYTES)?;
    let salt = decode("wrappingSalt", &envelope.wrapping_salt, Some(32))?;
    let wrap = wrapping_key(&account_key, &salt, "encryption-private-wrap")?;
    let private_key = Zeroizing::new(open_with_nonce(
        wrap.as_slice(),
        &decode("encryptionPrivateKeyNonce", &envelope.encryption_private_key_nonce, Some(24))?,
        &decode("encryptedEncryptionPrivateKey", &envelope.encrypted_encryption_private_key, Some(48))?,
        &identity_context(
            &user_id,
            envelope.key_version,
            "encryption-private-wrap",
            &envelope.encryption_public_key,
        ),
    )?);
    let secret: Zeroizing<[u8; 32]> = Zeroizing::new(
        private_key.as_slice().try_into().map_err(|_| CoreError::Sealed("Invalid identity key.".into()))?,
    );
    let derived = PublicKey::from(&StaticSecret::from(*secret));
    if encode(derived.as_bytes()) != envelope.encryption_public_key {
        return Err(CoreError::Sealed("Identity keys do not match.".into()));
    }
    let signing_seed = Zeroizing::new(open_with_nonce(
        wrapping_key(&account_key, &salt, "signing-seed-wrap")?.as_slice(),
        &decode("signingSeedNonce", &envelope.signing_seed_nonce, Some(24))?,
        &decode("encryptedSigningSeed", &envelope.encrypted_signing_seed, Some(48))?,
        &identity_context(&user_id, envelope.key_version, "signing-seed-wrap", &envelope.signing_public_key),
    )?);
    let signing_seed: Zeroizing<[u8; 32]> = Zeroizing::new(
        signing_seed.as_slice().try_into().map_err(|_| CoreError::Sealed("Invalid identity key.".into()))?,
    );
    if encode(SigningKey::from_bytes(&signing_seed).verifying_key().as_bytes()) != envelope.signing_public_key
    {
        return Err(CoreError::Sealed("Identity keys do not match.".into()));
    }
    let mut keys = IdentityKeys {
        key_version: envelope.key_version,
        encryption_public_key: envelope.encryption_public_key.clone(),
        encryption_private_key: private_key.to_vec().into(),
        signing_public_key: envelope.signing_public_key.clone(),
        signing_seed: signing_seed.to_vec().into(),
        kem_seed: SecretBytes::default(),
        kem_public_key: None,
    };
    if let Some(kem) = envelope.kem {
        decode("kem publicKey", &kem.public_key, Some(KEM_PUBLIC_KEY_BYTES))?;
        let wrap = wrapping_key(&account_key, &salt, "kem-seed-wrap")?;
        let seed = Zeroizing::new(open_with_nonce(
            wrap.as_slice(),
            &decode("seedNonce", &kem.seed_nonce, Some(24))?,
            &decode("encryptedSeed", &kem.encrypted_seed, Some(KEM_SEED_BYTES + 16))?,
            &identity_context(&user_id, envelope.key_version, "kem-seed-wrap", &kem.public_key),
        )?);
        if encode(&kem_public_key_from_seed(&seed)?) != kem.public_key {
            return Err(CoreError::Sealed("Identity keys do not match.".into()));
        }
        keys.kem_seed = seed.to_vec().into();
        keys.kem_public_key = Some(kem.public_key);
    }
    Ok(keys)
}

/// The same identity under a new account key, for a master-key rotation:
/// every private half is opened under the old key, checked against its public
/// key, and sealed again under the new one with a fresh salt. Public keys
/// never change, so shares and pins made against them keep working, and
/// neither does the key version: it counts the identity's generations, not
/// the root's revisions. Earlier identities in the account's history are
/// rewrapped the same way, each with its own version.
///
/// ```
/// use hushos_core::{identity_create, identity_open, identity_rewrap, random_bytes};
/// let (old_root, new_root) = (random_bytes(32)?, random_bytes(32)?);
/// let envelope = identity_create("user-1".into(), old_root.clone(), 2)?;
/// let rewrapped = identity_rewrap("user-1".into(), old_root, new_root.clone(), envelope.clone())?;
/// assert_eq!(rewrapped.key_version, 2);
/// assert_eq!(identity_open("user-1".into(), new_root, rewrapped)?.signing_public_key, envelope.signing_public_key);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn identity_rewrap(
    user_id: String,
    old_root: Vec<u8>,
    new_root: Vec<u8>,
    envelope: IdentityEnvelope,
) -> CoreResult<IdentityEnvelope> {
    if envelope.version != 1 || envelope.key_version < 1 {
        return Err(input("Unsupported identity envelope."));
    }
    let key_version = envelope.key_version;
    let (old_root, new_root) = (Zeroizing::new(old_root), Zeroizing::new(new_root));
    expect_len("old account key", &old_root, KEY_BYTES)?;
    expect_len("new account key", &new_root, KEY_BYTES)?;
    let old_salt = decode("wrappingSalt", &envelope.wrapping_salt, Some(32))?;
    let salt = random(32);
    let rewrap = |ciphertext: &str,
                  nonce: &str,
                  purpose: &str,
                  public_key: &str,
                  size: usize|
     -> CoreResult<(Zeroizing<Vec<u8>>, String, String)> {
        let private = Zeroizing::new(open_with_nonce(
            wrapping_key(&old_root, &old_salt, purpose)?.as_slice(),
            &decode("nonce", nonce, Some(24))?,
            &decode("ciphertext", ciphertext, Some(size + 16))?,
            &identity_context(&user_id, envelope.key_version, purpose, public_key),
        )?);
        let next_nonce = random(24);
        let sealed = seal_with_nonce(
            wrapping_key(&new_root, &salt, purpose)?.as_slice(),
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
    let secret: Zeroizing<[u8; 32]> = Zeroizing::new(
        secret.as_slice().try_into().map_err(|_| CoreError::Sealed("Invalid identity key.".into()))?,
    );
    if encode(PublicKey::from(&StaticSecret::from(*secret)).as_bytes()) != envelope.encryption_public_key {
        return Err(CoreError::Sealed("Identity keys do not match.".into()));
    }
    let (seed, signing_nonce, encrypted_signing) = rewrap(
        &envelope.encrypted_signing_seed,
        &envelope.signing_seed_nonce,
        "signing-seed-wrap",
        &envelope.signing_public_key,
        32,
    )?;
    let seed: Zeroizing<[u8; 32]> = Zeroizing::new(
        seed.as_slice().try_into().map_err(|_| CoreError::Sealed("Invalid identity key.".into()))?,
    );
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

/* What the identity's signing key signs to vouch for its KEM key. */
fn kem_binding(user_id: &str, encryption_public_key: &str, kem_public_key: &str) -> Vec<u8> {
    context(&[
        json!("hushos/identity/kem"),
        json!(1),
        json!(user_id.to_lowercase()),
        json!(encryption_public_key),
        json!(kem_public_key),
    ])
}

/// A new identity under the account key at `key_version`: fresh X25519,
/// Ed25519 and ML-KEM-768 keys, each private half wrapped under the root with
/// its public key in the associated data, and the KEM key's binding signed by
/// the new signing key, exactly as the web's `createIdentity` makes one.
///
/// ```
/// use hushos_core::{identity_create, identity_open, kem_binding_verify, random_bytes};
/// let root = random_bytes(32)?;
/// let envelope = identity_create("user-1".into(), root.clone(), 1)?;
/// let kem = envelope.kem.clone().unwrap();
/// assert!(kem_binding_verify("user-1".into(), envelope.encryption_public_key.clone(), envelope.signing_public_key.clone(), kem.public_key, kem.signature));
/// assert_eq!(identity_open("user-1".into(), root, envelope)?.key_version, 1);
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
    let secret = Zeroizing::new(<[u8; 32]>::try_from(random(32).as_slice()).expect("32 bytes"));
    let signing_seed = Zeroizing::new(<[u8; 32]>::try_from(random(32).as_slice()).expect("32 bytes"));
    let kem_seed = Zeroizing::new(random(KEM_SEED_BYTES));
    let encryption_public_key = encode(PublicKey::from(&StaticSecret::from(*secret)).as_bytes());
    let signing_public_key = encode(SigningKey::from_bytes(&signing_seed).verifying_key().as_bytes());
    let kem_public_key = encode(&kem_public_key_from_seed(&kem_seed)?);
    let salt = random(32);
    let wrap = |purpose: &str, private: &[u8], public_key: &str| -> CoreResult<(String, String)> {
        let nonce = random(24);
        let sealed = seal_with_nonce(
            wrapping_key(&account_key, &salt, purpose)?.as_slice(),
            &nonce,
            private,
            &identity_context(&user_id, key_version, purpose, public_key),
        )?;
        Ok((encode(&nonce), encode(&sealed)))
    };
    let (encryption_nonce, encrypted_encryption) =
        wrap("encryption-private-wrap", secret.as_slice(), &encryption_public_key)?;
    let (signing_nonce, encrypted_signing) =
        wrap("signing-seed-wrap", signing_seed.as_slice(), &signing_public_key)?;
    let (seed_nonce, encrypted_seed) = wrap("kem-seed-wrap", &kem_seed, &kem_public_key)?;
    let signature = crate::signatures::sign(
        signing_seed.as_slice(),
        &kem_binding(&user_id, &encryption_public_key, &kem_public_key),
    )?;
    Ok(IdentityEnvelope {
        version: 1,
        key_version,
        wrapping_salt: encode(&salt),
        encryption_public_key,
        encryption_private_key_nonce: encryption_nonce,
        encrypted_encryption_private_key: encrypted_encryption,
        signing_public_key,
        signing_seed_nonce: signing_nonce,
        encrypted_signing_seed: encrypted_signing,
        kem: Some(IdentityKem {
            public_key: kem_public_key,
            seed_nonce,
            encrypted_seed,
            signature: encode(&signature),
        }),
    })
}

/// A link of a succession chain, as the server serves it: the old identity's
/// keys, the new one's, and the old signing key's signature over the statement.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SuccessionLink {
    pub old_key_version: u64,
    pub new_key_version: u64,
    pub old_encryption_public_key: String,
    pub old_signing_public_key: String,
    pub new_encryption_public_key: String,
    pub new_signing_public_key: String,
    pub new_kem_public_key: String,
    pub signature: String,
}

/// A new identity and the succession signature that vouches for it.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct IdentitySuccession {
    /// Send as `identity` to `POST /api/auth/identity/succession`.
    pub identity: IdentityEnvelope,
    /// base64url, 64 bytes: send as `signature`.
    pub signature: String,
}

/// The keys a contact was pinned with; `key_version` is none for a pin made
/// before successions, and the chain is then found from the keys.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct PinnedKeys {
    pub key_version: Option<u64>,
    pub encryption_public_key: String,
    pub signing_public_key: String,
}

/// The keys the server serves for a contact now.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ServedKeys {
    pub key_version: u64,
    pub encryption_public_key: String,
    pub signing_public_key: String,
    pub kem_public_key: String,
}

/* ["hushos/identity/succession",1,userId,oldVersion,newVersion,oldX25519,oldEd25519,newX25519,newEd25519,sha256(newKem)] */
fn succession_message(user_id: &str, link: &SuccessionLink) -> CoreResult<Vec<u8>> {
    // Minted at old + 1; a reader asks only that it rose (a rotation may lift it in between).
    if link.old_key_version < 1 || link.new_key_version <= link.old_key_version {
        return Err(input("Invalid key version."));
    }
    // Canonical base64url of the right length, or refused.
    decode("oldEncryptionPublicKey", &link.old_encryption_public_key, Some(32))?;
    decode("oldSigningPublicKey", &link.old_signing_public_key, Some(32))?;
    decode("newEncryptionPublicKey", &link.new_encryption_public_key, Some(32))?;
    decode("newSigningPublicKey", &link.new_signing_public_key, Some(32))?;
    let kem = decode("newKemPublicKey", &link.new_kem_public_key, Some(KEM_PUBLIC_KEY_BYTES))?;
    Ok(context(&[
        json!("hushos/identity/succession"),
        json!(1),
        json!(user_id.to_lowercase()),
        json!(link.old_key_version),
        json!(link.new_key_version),
        json!(link.old_encryption_public_key),
        json!(link.old_signing_public_key),
        json!(link.new_encryption_public_key),
        json!(link.new_signing_public_key),
        json!(crate::signatures::digest(&kem)),
    ]))
}

/// Replaces the account's identity: opens `current` under the account key
/// (proving its signing seed), mints the next identity at `key_version + 1`
/// and signs the succession statement with the current signing key. Nothing
/// is installed; once the server accepts it, open the new identity and keep
/// the old one's keys for shares sealed to them.
///
/// ```
/// use hushos_core::{identity_create, identity_succeed, random_bytes, succession_verify, SuccessionLink};
/// let root = random_bytes(32)?;
/// let current = identity_create("user-1".into(), root.clone(), 1)?;
/// let next = identity_succeed("user-1".into(), root, current.clone())?;
/// assert_eq!(next.identity.key_version, 2);
/// let link = SuccessionLink {
///     old_key_version: 1, new_key_version: 2,
///     old_encryption_public_key: current.encryption_public_key, old_signing_public_key: current.signing_public_key,
///     new_encryption_public_key: next.identity.encryption_public_key.clone(), new_signing_public_key: next.identity.signing_public_key.clone(),
///     new_kem_public_key: next.identity.kem.clone().unwrap().public_key, signature: next.signature,
/// };
/// assert!(succession_verify("user-1".into(), link));
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
    // The opened keys wipe themselves when dropped; only the signing seed is needed.
    let keys = identity_open(user_id.clone(), account_key.to_vec(), current.clone())?;
    let signing_seed = keys.signing_seed.clone();
    drop(keys);
    let identity = identity_create(user_id.clone(), account_key.to_vec(), current.key_version + 1)?;
    let link = SuccessionLink {
        old_key_version: current.key_version,
        new_key_version: identity.key_version,
        old_encryption_public_key: current.encryption_public_key,
        old_signing_public_key: current.signing_public_key,
        new_encryption_public_key: identity.encryption_public_key.clone(),
        new_signing_public_key: identity.signing_public_key.clone(),
        new_kem_public_key: identity.kem.as_ref().expect("minted with a KEM key").public_key.clone(),
        signature: String::new(),
    };
    let signature = crate::signatures::sign(&signing_seed, &succession_message(&user_id, &link)?)?;
    Ok(IdentitySuccession { identity, signature: encode(&signature) })
}

/// Whether one link holds: its statement signed by the old signing key it names.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn succession_verify(user_id: String, link: SuccessionLink) -> bool {
    let check = || -> CoreResult<bool> {
        let message = succession_message(&user_id, &link)?;
        let key = decode("oldSigningPublicKey", &link.old_signing_public_key, Some(32))?;
        let signature = decode("signature", &link.signature, Some(64))?;
        Ok(crate::signatures::verify(&key, &message, &signature))
    };
    check().unwrap_or(false)
}

/// Whether `links` carry a contact from the keys pinned to the keys served.
/// Continuity is by keys, not version numbers (a master-key rotation may lift
/// an identity's version between two successions): the chain starts at the
/// link whose old keys are the pinned ones, each link's old keys are the
/// previous link's new keys and its signature is by the signing key it
/// replaces, versions only rise, and the last link's new X25519, Ed25519 and
/// ML-KEM keys are the served ones. Anything else is a changed key.
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
    }) else {
        return false;
    };
    let (mut version, mut encryption, mut signing, mut kem) = (
        pinned.key_version.unwrap_or(0),
        pinned.encryption_public_key,
        pinned.signing_public_key,
        String::new(),
    );
    for link in &links[start..] {
        if link.old_key_version < version
            || link.old_encryption_public_key != encryption
            || link.old_signing_public_key != signing
            || !succession_verify(user_id.clone(), link.clone())
        {
            return false;
        }
        version = link.new_key_version;
        encryption = link.new_encryption_public_key.clone();
        signing = link.new_signing_public_key.clone();
        kem = link.new_kem_public_key.clone();
    }
    served.key_version >= version
        && encryption == served.encryption_public_key
        && signing == served.signing_public_key
        && kem == served.kem_public_key
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
                    enc_wrap.as_slice(),
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
                    sign_wrap.as_slice(),
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
                        kem_wrap.as_slice(),
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
    fn identity_open_checks_every_private_half_against_the_published_keys() {
        let root = random(32);
        let (envelope, secret, kem_seed) = make_identity("User-1", &root);
        let keys = identity_open("user-1".into(), root.clone(), envelope.clone()).unwrap();
        assert_eq!(keys.encryption_private_key.to_vec(), secret.to_vec());
        assert_eq!(keys.kem_seed.to_vec(), kem_seed);
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
        assert_eq!(keys.signing_public_key, envelope.signing_public_key);
        let mut other_signer = envelope.clone();
        other_signer.signing_public_key = encode(&random(32));
        assert!(
            matches!(identity_open("user-1".into(), root.clone(), other_signer), Err(CoreError::Sealed(_))),
            "a served signing key the seed does not make is refused: the fingerprint covers it"
        );
        let mut legacy = envelope;
        legacy.kem = None;
        let keys = identity_open("user-1".into(), root, legacy).unwrap();
        assert!(keys.kem_seed.is_empty() && keys.kem_public_key.is_none());
    }

    #[test]
    fn a_debug_print_of_the_opened_identity_hides_both_private_halves() {
        let root = random(32);
        let (envelope, secret, kem_seed) = make_identity("user-1", &root);
        let keys = identity_open("user-1".into(), root, envelope).unwrap();
        let printed = format!("{keys:?}");
        assert!(!crate::bytes::shows(&printed, &secret), "{printed}");
        assert!(!crate::bytes::shows(&printed, &kem_seed), "{printed}");
        assert!(printed.contains(&keys.encryption_public_key));
    }

    #[test]
    fn identity_rewrap_keeps_the_public_keys_and_opens_only_under_the_new_root() {
        let old_root = random(32);
        let new_root = random(32);
        let (envelope, secret, kem_seed) = make_identity("user-1", &old_root);
        let rewrapped =
            identity_rewrap("user-1".into(), old_root.clone(), new_root.clone(), envelope.clone()).unwrap();
        assert_eq!(rewrapped.key_version, envelope.key_version, "a rotation keeps the identity's version");
        assert_eq!(rewrapped.encryption_public_key, envelope.encryption_public_key);
        assert_eq!(rewrapped.signing_public_key, envelope.signing_public_key);
        assert_eq!(rewrapped.kem.as_ref().unwrap().public_key, envelope.kem.as_ref().unwrap().public_key);
        assert_ne!(rewrapped.wrapping_salt, envelope.wrapping_salt);
        let keys = identity_open("user-1".into(), new_root.clone(), rewrapped.clone()).unwrap();
        assert_eq!(
            (keys.encryption_private_key.to_vec(), keys.kem_seed.to_vec()),
            (secret.to_vec(), kem_seed)
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
        let mut swapped = envelope;
        swapped.signing_public_key = encode(&random(32));
        assert!(matches!(
            identity_rewrap("user-1".into(), old_root, new_root, swapped),
            Err(CoreError::Sealed(_))
        ));
    }

    fn link(old: &IdentityEnvelope, next: &IdentitySuccession) -> SuccessionLink {
        SuccessionLink {
            old_key_version: old.key_version,
            new_key_version: next.identity.key_version,
            old_encryption_public_key: old.encryption_public_key.clone(),
            old_signing_public_key: old.signing_public_key.clone(),
            new_encryption_public_key: next.identity.encryption_public_key.clone(),
            new_signing_public_key: next.identity.signing_public_key.clone(),
            new_kem_public_key: next.identity.kem.as_ref().unwrap().public_key.clone(),
            signature: next.signature.clone(),
        }
    }

    fn served(identity: &IdentityEnvelope) -> ServedKeys {
        ServedKeys {
            key_version: identity.key_version,
            encryption_public_key: identity.encryption_public_key.clone(),
            signing_public_key: identity.signing_public_key.clone(),
            kem_public_key: identity.kem.as_ref().unwrap().public_key.clone(),
        }
    }

    #[test]
    fn identity_create_mints_keys_the_web_s_open_accepts_and_signs_the_kem_binding() {
        let root = random(32);
        let envelope = identity_create("User-1".into(), root.clone(), 4).unwrap();
        let keys = identity_open("user-1".into(), root.clone(), envelope.clone()).unwrap();
        assert_eq!(keys.key_version, 4);
        assert_eq!(keys.signing_seed.len(), 32);
        assert_eq!(
            encode(&crate::signatures::signing_public_key(keys.signing_seed.to_vec()).unwrap()),
            envelope.signing_public_key
        );
        let kem = envelope.kem.clone().unwrap();
        assert!(crate::kem_binding_verify(
            "user-1".into(),
            envelope.encryption_public_key.clone(),
            envelope.signing_public_key.clone(),
            kem.public_key,
            kem.signature
        ));
        assert!(identity_open("user-1".into(), random(32), envelope).is_err());
        assert!(identity_create("u".into(), root, 0).is_err());
    }

    #[test]
    fn a_succession_is_signed_by_the_old_key_and_a_chain_follows_keys_not_numbers() {
        let root = random(32);
        let first = identity_create("user-1".into(), root.clone(), 1).unwrap();
        let second = identity_succeed("user-1".into(), root.clone(), first.clone()).unwrap();
        assert_eq!(second.identity.key_version, 2);
        assert_ne!(second.identity.signing_public_key, first.signing_public_key);
        let one = link(&first, &second);
        assert!(succession_verify("user-1".into(), one.clone()));
        assert!(!succession_verify("user-2".into(), one.clone()), "the account is in the statement");
        // A rotation lifted v2 to 5 before the next succession: the chain still holds by keys.
        let lifted = IdentityEnvelope { key_version: 5, ..second.identity.clone() };
        let third = {
            // The device succeeds from v2's keys, now numbered 5.
            let keys = identity_open("user-1".into(), root.clone(), second.identity.clone()).unwrap();
            let next = identity_create("user-1".into(), root.clone(), 6).unwrap();
            let unsigned = SuccessionLink {
                old_key_version: 5,
                new_key_version: 6,
                old_encryption_public_key: lifted.encryption_public_key.clone(),
                old_signing_public_key: lifted.signing_public_key.clone(),
                new_encryption_public_key: next.encryption_public_key.clone(),
                new_signing_public_key: next.signing_public_key.clone(),
                new_kem_public_key: next.kem.as_ref().unwrap().public_key.clone(),
                signature: String::new(),
            };
            let signature = crate::signatures::sign(
                &keys.signing_seed,
                &succession_message("user-1", &unsigned).unwrap(),
            )
            .unwrap();
            (next, SuccessionLink { signature: encode(&signature), ..unsigned })
        };
        let pinned = PinnedKeys {
            key_version: Some(1),
            encryption_public_key: first.encryption_public_key.clone(),
            signing_public_key: first.signing_public_key.clone(),
        };
        let links = vec![one.clone(), third.1.clone()];
        assert!(succession_chain_verify("user-1".into(), pinned.clone(), served(&third.0), links.clone()));
        assert!(succession_chain_verify(
            "user-1".into(),
            PinnedKeys { key_version: None, ..pinned.clone() },
            served(&third.0),
            links.clone()
        ));
        // Served keys beside the chain's, a rolled-back version, a gap, a flipped signature: refused.
        assert!(!succession_chain_verify(
            "user-1".into(),
            pinned.clone(),
            served(&second.identity),
            links.clone()
        ));
        let mut rolled_back = served(&third.0);
        rolled_back.key_version = 3;
        assert!(!succession_chain_verify("user-1".into(), pinned.clone(), rolled_back, links.clone()));
        assert!(!succession_chain_verify(
            "user-1".into(),
            pinned.clone(),
            served(&third.0),
            vec![third.1.clone()]
        ));
        let mut flipped = third.1.clone();
        let mut bytes = decode("s", &flipped.signature, Some(64)).unwrap();
        bytes[0] ^= 1;
        flipped.signature = encode(&bytes);
        assert!(!succession_chain_verify(
            "user-1".into(),
            pinned.clone(),
            served(&third.0),
            vec![one.clone(), flipped]
        ));
        // A successor signed by a key the server holds, not the replaced one.
        let forged = identity_succeed(
            "user-1".into(),
            root.clone(),
            identity_create("user-1".into(), root, 2).unwrap(),
        )
        .unwrap();
        let mut planted = link(&second.identity, &forged);
        planted.old_key_version = 2;
        assert!(!succession_chain_verify(
            "user-1".into(),
            pinned,
            served(&forged.identity),
            vec![one, planted]
        ));
    }
}
