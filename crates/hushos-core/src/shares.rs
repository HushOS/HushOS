//! A share: one node's key sealed to one grantee, as `packages/crypto/shares.ts`
//! writes it. Suite 1 (72 bytes) is XChaCha under the X25519 pair key; suite 2
//! (1160 bytes) adds an ML-KEM-768 encapsulation, the body key being HKDF over
//! both secrets salted with the KEM ciphertext. Either side derives the same
//! key from its own private halves and the other's public keys.

use crate::bytes::{expect_len, random, KEY_BYTES, NONCE_BYTES, TAG_BYTES};
use crate::envelope::{context, open_with_nonce, seal_with_nonce};
use crate::error::{input, CoreError, CoreResult};
use crate::identity::{kem_decapsulate, kem_encapsulate, IdentityKeys, KEM_CIPHERTEXT_BYTES, KEM_SEED_BYTES};
use hkdf::Hkdf;
use salsa20::cipher::consts::U10;
use salsa20::hsalsa;
use serde_json::json;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize as _, Zeroizing};

const SHARE_ENVELOPE_BYTES: usize = NONCE_BYTES + KEY_BYTES + TAG_BYTES;
const HYBRID_SHARE_ENVELOPE_BYTES: usize = NONCE_BYTES + KEM_CIPHERTEXT_BYTES + KEY_BYTES + TAG_BYTES;
const SHARE_KEY_INFO: &[u8] = b"hushos/drive/share-key/v2";

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

/// Seals a node key to a grantee, as the granter: suite 2 (hybrid), always.
/// Without the grantee's ML-KEM key nothing is sealed; suite 1 envelopes made
/// before still open. The caller pins the grantee's keys first; sealing to an
/// unchecked key is sealing to a stranger.
///
/// ```
/// # let (node_key, granter_private, grantee_public) = (vec![0u8; 32], vec![1u8; 32], vec![2u8; 32]);
/// # let ctx = hushos_core::ShareContext { workspace_id: "w".into(), node_id: "n".into(), key_epoch: 1, grantee_user_id: "a".into(), granter_user_id: "b".into() };
/// assert!(hushos_core::share_seal(ctx, node_key, granter_private, grantee_public, None).is_err());
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn share_seal(
    ctx: ShareContext,
    node_key: Vec<u8>,
    granter_private_key: Vec<u8>,
    grantee_public_key: Vec<u8>,
    grantee_kem_public_key: Option<Vec<u8>>,
) -> CoreResult<Vec<u8>> {
    expect_len("node key", &node_key, KEY_BYTES)?;
    let pair = pair_key(&grantee_public_key, &granter_private_key)?;
    let nonce = random(NONCE_BYTES);
    let mut out = nonce.clone();
    match grantee_kem_public_key {
        // Hybrid only: suite 1 is still opened, never made. A share sealed to X25519 alone is a
        // harvest-now, decrypt-later target, and withholding the KEM key is all it would take.
        None => return Err(input("This person has no post-quantum key yet, so nothing was shared.")),
        Some(public) => {
            let (ciphertext, secret) = kem_encapsulate(&public)?;
            let body_key = hybrid_key(pair.as_slice(), secret.as_slice(), &ciphertext)?;
            out.extend_from_slice(&ciphertext);
            out.extend(seal_with_nonce(body_key.as_slice(), &nonce, &node_key, &share_context(&ctx, 2))?);
        }
    }
    Ok(out)
}

/// Opens a share sealed to this identity: the node key inside.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn share_open(
    envelope: Vec<u8>,
    granter_public_key: Vec<u8>,
    grantee: IdentityKeys,
    ctx: ShareContext,
) -> CoreResult<Vec<u8>> {
    let pair = pair_key(&granter_public_key, &grantee.encryption_private_key)?;
    let nonce = envelope.get(..NONCE_BYTES).ok_or_else(|| input("Invalid share envelope."))?;
    match envelope.len() {
        SHARE_ENVELOPE_BYTES => {
            let key =
                open_with_nonce(pair.as_slice(), nonce, &envelope[NONCE_BYTES..], &share_context(&ctx, 1))?;
            expect_len("node key", &key, KEY_BYTES)
                .map_err(|_| CoreError::Sealed("Invalid share envelope.".into()))?;
            Ok(key)
        }
        HYBRID_SHARE_ENVELOPE_BYTES => {
            if grantee.kem_seed.len() != KEM_SEED_BYTES {
                return Err(input(
                    "This share was sealed to a key this account does not hold yet. Unlock again and retry.",
                ));
            }
            let ciphertext = &envelope[NONCE_BYTES..NONCE_BYTES + KEM_CIPHERTEXT_BYTES];
            let secret = kem_decapsulate(&grantee.kem_seed, ciphertext)?;
            let key = hybrid_key(pair.as_slice(), secret.as_slice(), ciphertext)?;
            let node_key = open_with_nonce(
                key.as_slice(),
                nonce,
                &envelope[NONCE_BYTES + KEM_CIPHERTEXT_BYTES..],
                &share_context(&ctx, 2),
            )?;
            expect_len("node key", &node_key, KEY_BYTES)
                .map_err(|_| CoreError::Sealed("Invalid share envelope.".into()))?;
            Ok(node_key)
        }
        _ => Err(input("Invalid share envelope.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::random;
    use crate::identity::tests::make_identity;
    use crate::identity::{identity_open, kem_public_key_from_seed};

    fn ctx() -> ShareContext {
        ShareContext {
            workspace_id: "WS".into(),
            node_id: "N1".into(),
            key_epoch: 3,
            grantee_user_id: "Grantee".into(),
            granter_user_id: "Granter".into(),
        }
    }

    fn seal(
        node_key: &[u8],
        grantee_public: &[u8],
        grantee_kem_public: Option<&[u8]>,
        granter_secret: &[u8],
        ctx: &ShareContext,
    ) -> Vec<u8> {
        share_seal(
            ctx.clone(),
            node_key.to_vec(),
            granter_secret.to_vec(),
            grantee_public.to_vec(),
            grantee_kem_public.map(|k| k.to_vec()),
        )
        .unwrap()
    }

    #[test]
    fn both_suites_open_for_the_grantee_and_for_nobody_else() {
        let root = random(32);
        let (envelope, _, kem_seed) = make_identity("grantee", &root);
        let grantee = identity_open("grantee".into(), root.clone(), envelope.clone()).unwrap();
        let granter_secret: [u8; 32] = random(32).try_into().unwrap();
        let granter_public = PublicKey::from(&StaticSecret::from(granter_secret)).to_bytes().to_vec();
        let grantee_public = crate::bytes::decode("k", &envelope.encryption_public_key, Some(32)).unwrap();
        let node_key = random(32);

        // Nothing is sealed to X25519 alone any more.
        assert!(matches!(
            share_seal(ctx(), node_key.clone(), granter_secret.to_vec(), grantee_public.clone(), None),
            Err(CoreError::Input(_))
        ));

        let hybrid = seal(
            &node_key,
            &grantee_public,
            Some(&kem_public_key_from_seed(&kem_seed).unwrap()),
            &granter_secret,
            &ctx(),
        );
        assert_eq!(hybrid.len(), HYBRID_SHARE_ENVELOPE_BYTES);
        assert_eq!(
            share_open(hybrid.clone(), granter_public.clone(), grantee.clone(), ctx()).unwrap(),
            node_key
        );

        // Another epoch, another granter, or a tampered KEM ciphertext: the body refuses.
        let mut other_epoch = ctx();
        other_epoch.key_epoch = 4;
        assert!(matches!(
            share_open(hybrid.clone(), granter_public.clone(), grantee.clone(), other_epoch),
            Err(CoreError::Sealed(_))
        ));
        assert!(matches!(
            share_open(hybrid.clone(), random(32), grantee.clone(), ctx()),
            Err(CoreError::Sealed(_))
        ));
        let mut damaged = hybrid.clone();
        damaged[NONCE_BYTES + 5] ^= 1;
        assert!(matches!(
            share_open(damaged, granter_public.clone(), grantee.clone(), ctx()),
            Err(CoreError::Sealed(_))
        ));
        // A grantee without a KEM key cannot open a hybrid share, and says so.
        let mut without_kem = grantee;
        without_kem.kem_seed = Vec::new();
        assert!(matches!(share_open(hybrid, granter_public, without_kem, ctx()), Err(CoreError::Input(_))));
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
