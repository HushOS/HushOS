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
use serde_json::json;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

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

/* HSalsa20 as libsodium's crypto_core_hsalsa20: the Salsa20 core over sigma, the key and a 16-byte input, 20 rounds. */
fn hsalsa20(key: &[u8; 32], input: &[u8; 16]) -> [u8; 32] {
    let word = |bytes: &[u8]| u32::from_le_bytes(bytes.try_into().expect("4 bytes"));
    let mut x = [0u32; 16];
    let sigma = [0x6170_7865u32, 0x3320_646e, 0x7962_2d32, 0x6b20_6574];
    x[0] = sigma[0];
    x[5] = sigma[1];
    x[10] = sigma[2];
    x[15] = sigma[3];
    for i in 0..4 {
        x[1 + i] = word(&key[4 * i..4 * i + 4]);
        x[11 + i] = word(&key[16 + 4 * i..20 + 4 * i]);
        x[6 + i] = word(&input[4 * i..4 * i + 4]);
    }
    let qr = |x: &mut [u32; 16], a: usize, b: usize, c: usize, d: usize| {
        x[b] ^= x[a].wrapping_add(x[d]).rotate_left(7);
        x[c] ^= x[b].wrapping_add(x[a]).rotate_left(9);
        x[d] ^= x[c].wrapping_add(x[b]).rotate_left(13);
        x[a] ^= x[d].wrapping_add(x[c]).rotate_left(18);
    };
    for _ in 0..10 {
        qr(&mut x, 0, 4, 8, 12);
        qr(&mut x, 5, 9, 13, 1);
        qr(&mut x, 10, 14, 2, 6);
        qr(&mut x, 15, 3, 7, 11);
        qr(&mut x, 0, 1, 2, 3);
        qr(&mut x, 5, 6, 7, 4);
        qr(&mut x, 10, 11, 8, 9);
        qr(&mut x, 15, 12, 13, 14);
    }
    let mut out = [0u8; 32];
    for (slot, index) in [0usize, 5, 10, 15, 6, 7, 8, 9].iter().enumerate() {
        out[4 * slot..4 * slot + 4].copy_from_slice(&x[*index].to_le_bytes());
    }
    out
}

/* libsodium's crypto_box_beforenm: X25519, then HSalsa20 with a zero nonce. */
pub(crate) fn pair_key(their_public: &[u8], my_private: &[u8]) -> CoreResult<[u8; KEY_BYTES]> {
    expect_len("identity public key", their_public, 32).map_err(|_| input("Invalid identity key."))?;
    expect_len("identity private key", my_private, 32).map_err(|_| input("Invalid identity key."))?;
    let public: [u8; 32] = their_public.try_into().expect("32 bytes");
    let secret: [u8; 32] = my_private.try_into().expect("32 bytes");
    let shared = StaticSecret::from(secret).diffie_hellman(&PublicKey::from(public));
    if !shared.was_contributory() {
        return Err(input("Invalid identity key."));
    }
    Ok(hsalsa20(shared.as_bytes(), &[0u8; 16]))
}

fn hybrid_key(pair: &[u8], kem_secret: &[u8], kem_ciphertext: &[u8]) -> CoreResult<[u8; KEY_BYTES]> {
    let mut material = Vec::with_capacity(pair.len() + kem_secret.len());
    material.extend_from_slice(pair);
    material.extend_from_slice(kem_secret);
    let mut key = [0u8; KEY_BYTES];
    Hkdf::<Sha256>::new(Some(kem_ciphertext), &material)
        .expand(SHARE_KEY_INFO, &mut key)
        .map_err(|_| input("HKDF failed"))?;
    Ok(key)
}

/// Seals a node key to a grantee, as the granter: suite 2 (hybrid) when the
/// grantee's ML-KEM key is given, suite 1 otherwise. The caller pins the
/// grantee's keys first; sealing to an unchecked key is sealing to a stranger.
///
/// ```
/// # let (node_key, granter_private, grantee_public) = (vec![0u8; 32], vec![1u8; 32], vec![2u8; 32]);
/// # let ctx = hushos_core::ShareContext { workspace_id: "w".into(), node_id: "n".into(), key_epoch: 1, grantee_user_id: "a".into(), granter_user_id: "b".into() };
/// let envelope = hushos_core::share_seal(ctx, node_key, granter_private, grantee_public, None)?;
/// assert_eq!(envelope.len(), 72);
/// # Ok::<(), hushos_core::CoreError>(())
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
        None => out.extend(seal_with_nonce(&pair, &nonce, &node_key, &share_context(&ctx, 1))?),
        Some(public) => {
            let (ciphertext, secret) = kem_encapsulate(&public)?;
            let body_key = hybrid_key(&pair, &secret, &ciphertext)?;
            out.extend_from_slice(&ciphertext);
            out.extend(seal_with_nonce(&body_key, &nonce, &node_key, &share_context(&ctx, 2))?);
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
            let key = open_with_nonce(&pair, nonce, &envelope[NONCE_BYTES..], &share_context(&ctx, 1))?;
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
            let key = hybrid_key(&pair, &secret, ciphertext)?;
            let node_key = open_with_nonce(
                &key,
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

        let classic = seal(&node_key, &grantee_public, None, &granter_secret, &ctx());
        assert_eq!(classic.len(), SHARE_ENVELOPE_BYTES);
        assert_eq!(
            share_open(classic.clone(), granter_public.clone(), grantee.clone(), ctx()).unwrap(),
            node_key
        );

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
        assert!(matches!(share_open(classic, random(32), grantee.clone(), ctx()), Err(CoreError::Sealed(_))));
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
        assert_eq!(crate::bytes::encode(&key), "7Ij24Tsiv58E1IDg2FJcCKx-L0jiEnQry8r6EEp0sI0");
    }
}
