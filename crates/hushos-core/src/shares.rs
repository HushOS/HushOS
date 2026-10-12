//! A share: one node's key sealed to one grantee, as `packages/crypto/shares.ts`
//! writes it. Suite 3 (1256 bytes), the only one sealed: a fresh X25519 key
//! agreed with the grantee's identity key beside an ML-KEM-768 encapsulation,
//! HKDF over both secrets salted with a digest of the KEM ciphertext and both
//! X25519 public keys, and the granter's Ed25519 signature over the sealed
//! bytes, checked against the pinned signing key before anything is
//! decapsulated. Suites 1 (72 bytes, the static pair key) and 2 (1160 bytes,
//! the pair key and ML-KEM) still open.

use crate::bytes::{expect_len, random, KEY_BYTES, NONCE_BYTES, TAG_BYTES};
use crate::envelope::{context, open_with_nonce, seal_with_nonce};
use crate::error::{input, CoreError, CoreResult};
use crate::identity::{kem_decapsulate, kem_encapsulate, IdentityKeys, KEM_CIPHERTEXT_BYTES, KEM_SEED_BYTES};
use crate::signatures::{digest, sign, verify, SIGNATURE_BYTES};
use hkdf::Hkdf;
use salsa20::cipher::consts::U10;
use salsa20::hsalsa;
use serde_json::json;
use sha2::Digest as _;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize as _, Zeroizing};

const SHARE_ENVELOPE_BYTES: usize = NONCE_BYTES + KEY_BYTES + TAG_BYTES;
const HYBRID_SHARE_ENVELOPE_BYTES: usize = NONCE_BYTES + KEM_CIPHERTEXT_BYTES + KEY_BYTES + TAG_BYTES;
const SIGNED_PART_BYTES: usize = 32 + KEM_CIPHERTEXT_BYTES + NONCE_BYTES + KEY_BYTES + TAG_BYTES;
const SIGNED_SHARE_ENVELOPE_BYTES: usize = SIGNED_PART_BYTES + SIGNATURE_BYTES; // 1256
const SHARE_KEY_INFO: &[u8] = b"hushos/drive/share-key/v2";
const SIGNED_SHARE_KEY_INFO: &[u8] = b"hushos/drive/share-key/v3";

/// What binds a share to its node, epoch and the two people.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ShareContext {
    pub workspace_id: String,
    pub node_id: String,
    pub key_epoch: u64,
    pub grantee_user_id: String,
    pub granter_user_id: String,
}

fn share_context(ctx: &ShareContext, suite: u32) -> Vec<u8> {
    context(&[
        json!("hushos/drive/share"),
        json!(suite),
        json!(ctx.workspace_id.to_lowercase()),
        json!(ctx.node_id.to_lowercase()),
        json!(ctx.key_epoch),
        json!(ctx.grantee_user_id.to_lowercase()),
        json!(ctx.granter_user_id.to_lowercase()),
    ])
}

/* libsodium's crypto_box_beforenm: X25519, then HSalsa20 with a zero nonce. */
pub(crate) fn pair_key(their_public: &[u8], my_private: &[u8]) -> CoreResult<Zeroizing<[u8; KEY_BYTES]>> {
    expect_len("identity public key", their_public, 32).map_err(|_| input("Invalid identity key."))?;
    expect_len("identity private key", my_private, 32).map_err(|_| input("Invalid identity key."))?;
    let public: [u8; 32] = their_public.try_into().expect("32 bytes");
    let secret = Zeroizing::new(<[u8; 32]>::try_from(my_private).expect("32 bytes"));
    let shared = StaticSecret::from(*secret).diffie_hellman(&PublicKey::from(public));
    if !shared.was_contributory() {
        return Err(input("Invalid identity key."));
    }
    // HSalsa20 (20 rounds, ten double rounds) as libsodium's crypto_core_hsalsa20.
    let mut key = hsalsa::<U10>(shared.as_bytes().into(), &[0u8; 16].into());
    let out = Zeroizing::new(key.into());
    key.as_mut_slice().zeroize();
    Ok(out)
}

fn hybrid_key(
    pair: &[u8],
    kem_secret: &[u8],
    kem_ciphertext: &[u8],
) -> CoreResult<Zeroizing<[u8; KEY_BYTES]>> {
    let mut material = Zeroizing::new(Vec::with_capacity(pair.len() + kem_secret.len()));
    material.extend_from_slice(pair);
    material.extend_from_slice(kem_secret);
    let mut key = Zeroizing::new([0u8; KEY_BYTES]);
    Hkdf::<Sha256>::new(Some(kem_ciphertext), &material)
        .expand(SHARE_KEY_INFO, key.as_mut())
        .map_err(|_| input("HKDF failed"))?;
    Ok(key)
}

/// The granter of a share as the grantee pinned them: the signing key opens
/// suite 3, the X25519 key suites 1 and 2. A suite that needs a missing key refuses.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ShareGranter {
    pub encryption_public_key: Option<Vec<u8>>,
    pub signing_public_key: Option<Vec<u8>>,
}

/* ["hushos/drive/sig/share",3,ws,node,epoch,grantee,granter,sha256(eph || kemCt || nonce || body)] */
fn share_message(ctx: &ShareContext, sealed: &[u8]) -> CoreResult<Vec<u8>> {
    if ctx.key_epoch < 1 {
        return Err(input("Invalid key epoch."));
    }
    Ok(context(&[
        json!("hushos/drive/sig/share"),
        json!(3),
        json!(ctx.workspace_id.to_lowercase()),
        json!(ctx.node_id.to_lowercase()),
        json!(ctx.key_epoch),
        json!(ctx.grantee_user_id.to_lowercase()),
        json!(ctx.granter_user_id.to_lowercase()),
        json!(digest(sealed)),
    ]))
}

/* Raw X25519, refusing a low-order key whose agreement says nothing. */
fn agree(my_private: &[u8], their_public: &[u8]) -> CoreResult<Zeroizing<[u8; 32]>> {
    let public: [u8; 32] = their_public.try_into().map_err(|_| input("Invalid identity key."))?;
    let secret =
        Zeroizing::new(<[u8; 32]>::try_from(my_private).map_err(|_| input("Invalid identity key."))?);
    let shared = StaticSecret::from(*secret).diffie_hellman(&PublicKey::from(public));
    if !shared.was_contributory() {
        return Err(input("Invalid identity key."));
    }
    Ok(Zeroizing::new(*shared.as_bytes()))
}

/* HKDF(salt = SHA-256(kemCt || eph || granteePublic), ikm = dh || kemSs, info v3) */
fn signed_share_key(
    dh: &[u8],
    kem_secret: &[u8],
    kem_ciphertext: &[u8],
    ephemeral_public: &[u8],
    grantee_public: &[u8],
) -> CoreResult<Zeroizing<[u8; KEY_BYTES]>> {
    let salt = Sha256::new()
        .chain_update(kem_ciphertext)
        .chain_update(ephemeral_public)
        .chain_update(grantee_public)
        .finalize();
    let mut material = Zeroizing::new(Vec::with_capacity(dh.len() + kem_secret.len()));
    material.extend_from_slice(dh);
    material.extend_from_slice(kem_secret);
    let mut key = Zeroizing::new([0u8; KEY_BYTES]);
    Hkdf::<Sha256>::new(Some(&salt), &material)
        .expand(SIGNED_SHARE_KEY_INFO, key.as_mut())
        .map_err(|_| input("HKDF failed"))?;
    Ok(key)
}

/// Seals a node key to a grantee in suite 3, signed by the granter's identity
/// (its signing seed; nothing else of the granter's is secret here). Both of
/// the grantee's keys must be the pinned ones: sealing to an unchecked key is
/// sealing to a stranger.
///
/// ```
/// use hushos_core::*;
/// let (root_a, root_b) = (random_bytes(32)?, random_bytes(32)?);
/// let granter = identity_open("a".into(), root_a.clone(), identity_create("a".into(), root_a, 1)?)?;
/// let grantee_envelope = identity_create("b".into(), root_b.clone(), 1)?;
/// let grantee = identity_open("b".into(), root_b, grantee_envelope.clone())?;
/// let ctx = ShareContext { workspace_id: "w".into(), node_id: "n".into(), key_epoch: 1, grantee_user_id: "b".into(), granter_user_id: "a".into() };
/// let node_key = random_bytes(32)?;
/// let envelope = share_seal(ctx.clone(), node_key.clone(), granter.clone(),
///     base64url_decode(grantee.encryption_public_key.clone())?, base64url_decode(grantee.kem_public_key.clone().unwrap())?)?;
/// assert_eq!(envelope.len(), 1256);
/// let pinned = ShareGranter { encryption_public_key: None, signing_public_key: Some(base64url_decode(granter.signing_public_key)?) };
/// assert_eq!(share_open(envelope, pinned, grantee, ctx)?, node_key);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn share_seal(
    ctx: ShareContext,
    node_key: Vec<u8>,
    granter: IdentityKeys,
    grantee_public_key: Vec<u8>,
    grantee_kem_public_key: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    expect_len("node key", &node_key, KEY_BYTES)?;
    expect_len("identity public key", &grantee_public_key, 32).map_err(|_| input("Invalid identity key."))?;
    let ephemeral = Zeroizing::new(random(32));
    let ephemeral_public =
        PublicKey::from(&StaticSecret::from(<[u8; 32]>::try_from(ephemeral.as_slice()).expect("32 bytes")))
            .to_bytes();
    let dh = agree(&ephemeral, &grantee_public_key)?;
    let (ciphertext, secret) = kem_encapsulate(&grantee_kem_public_key)?;
    let key = signed_share_key(
        dh.as_slice(),
        secret.as_slice(),
        &ciphertext,
        &ephemeral_public,
        &grantee_public_key,
    )?;
    let nonce = random(NONCE_BYTES);
    let mut out = Vec::with_capacity(SIGNED_SHARE_ENVELOPE_BYTES);
    out.extend_from_slice(&ephemeral_public);
    out.extend_from_slice(&ciphertext);
    out.extend_from_slice(&nonce);
    out.extend(seal_with_nonce(key.as_slice(), &nonce, &node_key, &share_context(&ctx, 3))?);
    let signature = sign(&granter.signing_seed, &share_message(&ctx, &out)?)?;
    out.extend_from_slice(&signature);
    Ok(out)
}

/// Opens a share sealed to this identity: the node key inside. Suite 3 opens
/// only once its signature verifies under the granter's pinned signing key;
/// nothing is decapsulated before. After a succession, try each of the
/// account's identities ([`IdentityKeys`] of the history) until one opens it.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn share_open(
    envelope: Vec<u8>,
    granter: ShareGranter,
    grantee: IdentityKeys,
    ctx: ShareContext,
) -> CoreResult<Vec<u8>> {
    let missing = || input("This share needs the key of the person who shared it.");
    let node_key = match envelope.len() {
        SIGNED_SHARE_ENVELOPE_BYTES => {
            let signing = granter.signing_public_key.ok_or_else(missing)?;
            let (sealed, signature) = envelope.split_at(SIGNED_PART_BYTES);
            if !verify(&signing, &share_message(&ctx, sealed)?, signature) {
                return Err(CoreError::Sealed(
                    "This share is not signed by the person who shared it.".into(),
                ));
            }
            if grantee.kem_seed.len() != KEM_SEED_BYTES {
                return Err(input(
                    "This share was sealed to a key this account does not hold yet. Unlock again and retry.",
                ));
            }
            let ephemeral_public = &sealed[..32];
            let ciphertext = &sealed[32..32 + KEM_CIPHERTEXT_BYTES];
            let nonce = &sealed[32 + KEM_CIPHERTEXT_BYTES..32 + KEM_CIPHERTEXT_BYTES + NONCE_BYTES];
            let body = &sealed[32 + KEM_CIPHERTEXT_BYTES + NONCE_BYTES..];
            let dh = agree(&grantee.encryption_private_key, ephemeral_public)?;
            let secret = kem_decapsulate(&grantee.kem_seed, ciphertext)?;
            let grantee_public =
                crate::bytes::decode("identity public key", &grantee.encryption_public_key, Some(32))?;
            let key = signed_share_key(
                dh.as_slice(),
                secret.as_slice(),
                ciphertext,
                ephemeral_public,
                &grantee_public,
            )?;
            open_with_nonce(key.as_slice(), nonce, body, &share_context(&ctx, 3))?
        }
        SHARE_ENVELOPE_BYTES | HYBRID_SHARE_ENVELOPE_BYTES => {
            let granter_public = granter.encryption_public_key.ok_or_else(missing)?;
            let pair = pair_key(&granter_public, &grantee.encryption_private_key)?;
            let nonce = &envelope[..NONCE_BYTES];
            if envelope.len() == SHARE_ENVELOPE_BYTES {
                open_with_nonce(pair.as_slice(), nonce, &envelope[NONCE_BYTES..], &share_context(&ctx, 1))?
            } else {
                if grantee.kem_seed.len() != KEM_SEED_BYTES {
                    return Err(input(
                        "This share was sealed to a key this account does not hold yet. Unlock again and retry.",
                    ));
                }
                let ciphertext = &envelope[NONCE_BYTES..NONCE_BYTES + KEM_CIPHERTEXT_BYTES];
                let secret = kem_decapsulate(&grantee.kem_seed, ciphertext)?;
                let key = hybrid_key(pair.as_slice(), secret.as_slice(), ciphertext)?;
                open_with_nonce(
                    key.as_slice(),
                    nonce,
                    &envelope[NONCE_BYTES + KEM_CIPHERTEXT_BYTES..],
                    &share_context(&ctx, 2),
                )?
            }
        }
        _ => return Err(input("Invalid share envelope.")),
    };
    expect_len("node key", &node_key, KEY_BYTES)
        .map_err(|_| CoreError::Sealed("Invalid share envelope.".into()))?;
    Ok(node_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::{decode, random};
    use crate::identity::{identity_create, identity_open};

    fn ctx() -> ShareContext {
        ShareContext {
            workspace_id: "WS".into(),
            node_id: "N1".into(),
            key_epoch: 3,
            grantee_user_id: "Grantee".into(),
            granter_user_id: "Granter".into(),
        }
    }

    fn person(user_id: &str) -> IdentityKeys {
        let root = random(32);
        identity_open(user_id.into(), root.clone(), identity_create(user_id.into(), root, 1).unwrap())
            .unwrap()
    }

    fn public(keys: &IdentityKeys) -> Vec<u8> {
        decode("k", &keys.encryption_public_key, Some(32)).unwrap()
    }

    fn kem(keys: &IdentityKeys) -> Vec<u8> {
        decode("k", keys.kem_public_key.as_ref().unwrap(), None).unwrap()
    }

    fn pinned(keys: &IdentityKeys) -> ShareGranter {
        ShareGranter {
            encryption_public_key: Some(public(keys)),
            signing_public_key: Some(decode("k", &keys.signing_public_key, Some(32)).unwrap()),
        }
    }

    #[test]
    fn suite_3_opens_for_the_grantee_from_the_granter_who_signed_it() {
        let (owner, guest) = (person("granter"), person("grantee"));
        let node_key = random(32);
        let envelope =
            share_seal(ctx(), node_key.clone(), owner.clone(), public(&guest), kem(&guest)).unwrap();
        assert_eq!(envelope.len(), SIGNED_SHARE_ENVELOPE_BYTES);
        assert_eq!(share_open(envelope.clone(), pinned(&owner), guest.clone(), ctx()).unwrap(), node_key);
        let again = share_seal(ctx(), node_key, owner, public(&guest), kem(&guest)).unwrap();
        assert_ne!(again[..32], envelope[..32], "every share has its own ephemeral key");
    }

    #[test]
    fn suite_3_is_refused_before_decapsulating_unless_the_pinned_granter_signed_it() {
        let (owner, guest, intruder) = (person("granter"), person("grantee"), person("intruder"));
        let envelope = share_seal(ctx(), random(32), owner.clone(), public(&guest), kem(&guest)).unwrap();
        // Without a KEM key the grantee still hears the signature is wrong: it is checked first.
        let no_kem = IdentityKeys { kem_seed: Vec::new(), ..guest.clone() };
        assert!(matches!(
            share_open(envelope.clone(), pinned(&intruder), no_kem.clone(), ctx()),
            Err(CoreError::Sealed(message)) if message.contains("not signed")
        ));
        assert!(matches!(
            share_open(envelope.clone(), pinned(&owner), no_kem, ctx()),
            Err(CoreError::Input(_))
        ));
        // A key of someone else's choosing sealed in the granter's name.
        let planted = share_seal(ctx(), random(32), intruder, public(&guest), kem(&guest)).unwrap();
        assert!(share_open(planted, pinned(&owner), guest.clone(), ctx()).is_err());
        for at in
            [0, 32 + 5, 32 + KEM_CIPHERTEXT_BYTES + 3, SIGNED_PART_BYTES - 1, SIGNED_SHARE_ENVELOPE_BYTES - 1]
        {
            let mut tampered = envelope.clone();
            tampered[at] ^= 1;
            assert!(
                matches!(
                    share_open(tampered, pinned(&owner), guest.clone(), ctx()),
                    Err(CoreError::Sealed(message)) if message.contains("not signed")
                ),
                "byte {at}"
            );
        }
        for change in [
            ShareContext { key_epoch: 4, ..ctx() },
            ShareContext { node_id: "n2".into(), ..ctx() },
            ShareContext { grantee_user_id: "other".into(), ..ctx() },
            ShareContext { granter_user_id: "other".into(), ..ctx() },
        ] {
            assert!(share_open(envelope.clone(), pinned(&owner), guest.clone(), change).is_err());
        }
        let no_signing = ShareGranter { signing_public_key: None, ..pinned(&owner) };
        assert!(matches!(share_open(envelope, no_signing, guest, ctx()), Err(CoreError::Input(_))));
    }

    #[test]
    fn suite_3_needs_both_of_the_grantee_s_halves_and_the_granter_s_keys_open_nothing() {
        let (owner, guest, stranger) = (person("granter"), person("grantee"), person("stranger"));
        let envelope = share_seal(ctx(), random(32), owner.clone(), public(&guest), kem(&guest)).unwrap();
        for keys in [
            stranger.clone(),
            IdentityKeys { encryption_private_key: stranger.encryption_private_key.clone(), ..guest.clone() },
            IdentityKeys { kem_seed: stranger.kem_seed.clone(), ..guest.clone() },
            // The granter's own keys, stolen: they open none of the granter's shares.
            owner.clone(),
        ] {
            assert!(matches!(
                share_open(envelope.clone(), pinned(&owner), keys, ctx()),
                Err(CoreError::Sealed(_))
            ));
        }
    }

    #[test]
    fn suites_1_and_2_made_before_still_open_with_the_granter_s_x25519_key() {
        let guest = person("grantee");
        let granter_secret: [u8; 32] = random(32).try_into().unwrap();
        let granter = ShareGranter {
            encryption_public_key: Some(
                PublicKey::from(&StaticSecret::from(granter_secret)).to_bytes().to_vec(),
            ),
            signing_public_key: None,
        };
        let node_key = random(32);
        let pair = pair_key(&public(&guest), &granter_secret).unwrap();
        let nonce = random(NONCE_BYTES);
        let mut one = nonce.clone();
        one.extend(seal_with_nonce(pair.as_slice(), &nonce, &node_key, &share_context(&ctx(), 1)).unwrap());
        let (ciphertext, secret) = kem_encapsulate(&kem(&guest)).unwrap();
        let key = hybrid_key(pair.as_slice(), secret.as_slice(), &ciphertext).unwrap();
        let mut two = nonce.clone();
        two.extend_from_slice(&ciphertext);
        two.extend(seal_with_nonce(key.as_slice(), &nonce, &node_key, &share_context(&ctx(), 2)).unwrap());
        assert_eq!((one.len(), two.len()), (SHARE_ENVELOPE_BYTES, HYBRID_SHARE_ENVELOPE_BYTES));
        for envelope in [one, two] {
            assert_eq!(
                share_open(envelope.clone(), granter.clone(), guest.clone(), ctx()).unwrap(),
                node_key
            );
            assert!(share_open(
                envelope.clone(),
                granter.clone(),
                guest.clone(),
                ShareContext { key_epoch: 4, ..ctx() }
            )
            .is_err());
            assert!(share_open(envelope.clone(), granter.clone(), person("stranger"), ctx()).is_err());
            let unpinned = ShareGranter { encryption_public_key: None, ..granter.clone() };
            assert!(matches!(share_open(envelope, unpinned, guest.clone(), ctx()), Err(CoreError::Input(_))));
        }
    }

    #[test]
    fn pair_key_matches_libsodium_crypto_box_beforenm() {
        // libsodium: crypto_box_beforenm(pk = scalarmult_base(1..32), sk = 32..64) for known bytes.
        let sk: Vec<u8> = (1..=32).collect();
        let their_pk = PublicKey::from(&StaticSecret::from(
            <[u8; 32]>::try_from((33..=64).collect::<Vec<u8>>()).unwrap(),
        ))
        .to_bytes();
        let key = pair_key(&their_pk, &sk).unwrap();
        assert_eq!(crate::bytes::encode(key.as_slice()), "7Ij24Tsiv58E1IDg2FJcCKx-L0jiEnQry8r6EEp0sI0");
    }
}
