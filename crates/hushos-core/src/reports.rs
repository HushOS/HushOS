//! A report hands an operator the key to what was reported, as
//! `packages/crypto/reports.ts` seals it: the node key and a digest of the
//! report's context, sealed to each operator's identity with no account of the
//! reporter's involved. Suite 1 (112 bytes) is a libsodium sealed box to the
//! operator's X25519 key; suite 2 (1224 bytes) adds an ML-KEM-768
//! encapsulation, the body key being HKDF over both secrets. An operator's KEM
//! key is used only when its Ed25519 binding to the identity checks out.

use crate::bytes::{decode, expect_len, random, KEY_BYTES, NONCE_BYTES};
use crate::envelope::{context, seal_with_nonce};
use crate::error::{input, CoreError, CoreResult};
use crate::identity::{kem_encapsulate, KEM_CIPHERTEXT_BYTES, KEM_PUBLIC_KEY_BYTES};
#[cfg(test)]
use blake2::digest::consts::U24;
use blake2::digest::consts::U32;
use blake2::{Blake2b, Digest as _};
#[cfg(test)]
use crypto_secretbox::aead::{AeadInPlace as _, KeyInit as _};
#[cfg(test)]
use crypto_secretbox::XSalsa20Poly1305;
use ed25519_dalek::{Signature, VerifyingKey};
use hkdf::Hkdf;
use salsa20::cipher::consts::U10;
use salsa20::hsalsa;
use serde_json::json;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize as _, Zeroizing};

const REPORT_KEY_INFO: &[u8] = b"hushos/drive/report-key/v2";
/* Suite 1, a libsodium sealed box: still opened by the web's operator page, no longer made. */
#[cfg(test)]
const SEALED_BOX_BYTES: usize = 32 + 16 + KEY_BYTES + 32; // 112
const HYBRID_BYTES: usize = 32 + KEM_CIPHERTEXT_BYTES + NONCE_BYTES + KEY_BYTES + 32 + 16; // 1224

/* libsodium's crypto_box_beforenm: X25519, then HSalsa20 with a zero nonce. */
fn pair_key(their_public: &[u8], my_private: &[u8]) -> CoreResult<Zeroizing<[u8; KEY_BYTES]>> {
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

/// What binds a sealed report key to one report and one operator.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ReportContext {
    pub workspace_id: String,
    pub node_id: String,
    pub key_epoch: u64,
    pub report_id: String,
    pub operator_user_id: String,
}

/// An operator's KEM key with the signature its identity made over it.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct OperatorKem {
    pub public_key: String,
    pub signature: String,
}

/// An operator as `GET /api/drive/reports/operators` lists them.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct OperatorKeys {
    pub user_id: String,
    pub encryption_public_key: String,
    pub signing_public_key: String,
    pub kem: Option<OperatorKem>,
}

fn report_context(ctx: &ReportContext, suite: u32) -> Vec<u8> {
    context(&[
        json!("hushos/drive/report"),
        json!(suite),
        json!(ctx.workspace_id.to_lowercase()),
        json!(ctx.node_id.to_lowercase()),
        json!(ctx.key_epoch),
        json!(ctx.report_id.to_lowercase()),
        json!(ctx.operator_user_id.to_lowercase()),
    ])
}

fn digest(bytes: &[u8]) -> [u8; 32] {
    Blake2b::<U32>::digest(bytes).into()
}

/// Whether a KEM key belongs to the identity whose X25519 and Ed25519 keys
/// these are: the binding `["hushos/identity/kem",1,userId,x25519,kem]`
/// carries a signature by the identity's signing key.
///
/// ```
/// use hushos_core::kem_binding_verify;
/// assert!(!kem_binding_verify("u".into(), "x".into(), "s".into(), "k".into(), "sig".into()));
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn kem_binding_verify(
    user_id: String,
    encryption_public_key: String,
    signing_public_key: String,
    kem_public_key: String,
    signature: String,
) -> bool {
    let check = || -> CoreResult<bool> {
        decode("kem publicKey", &kem_public_key, Some(KEM_PUBLIC_KEY_BYTES))?;
        let key: [u8; 32] =
            decode("signingPublicKey", &signing_public_key, Some(32))?.try_into().expect("32 bytes");
        let key = VerifyingKey::from_bytes(&key).map_err(|_| input("signing key"))?;
        let signature: [u8; 64] = decode("signature", &signature, Some(64))?.try_into().expect("64 bytes");
        let message = context(&[
            json!("hushos/identity/kem"),
            json!(1),
            json!(user_id.to_lowercase()),
            json!(encryption_public_key),
            json!(kem_public_key),
        ]);
        Ok(key.verify_strict(&message, &Signature::from_bytes(&signature)).is_ok())
    };
    check().unwrap_or(false)
}

/* A hybrid envelope's associated data: the report's context and the ephemeral key it carries. */
fn hybrid_report_data(ctx: &ReportContext, ephemeral_public: &[u8]) -> Vec<u8> {
    let mut data = report_context(ctx, 2);
    data.extend_from_slice(ephemeral_public);
    data
}

/// Seals the node key to one operator for a report: 1224 bytes, hybrid. Refuses
/// an operator without a KEM key, since a classical seal is a harvest-now,
/// decrypt-later target, and a KEM key whose binding does not verify, so a
/// swapped key on the wire cannot redirect the report.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn report_seal_key(ctx: ReportContext, node_key: Vec<u8>, operator: OperatorKeys) -> CoreResult<Vec<u8>> {
    expect_len("node key", &node_key, KEY_BYTES)?;
    let operator_public = decode("operator encryptionPublicKey", &operator.encryption_public_key, Some(32))
        .map_err(|_| input("Invalid operator key."))?;
    let kem = match operator.kem {
        None => None,
        Some(kem) => {
            if !kem_binding_verify(
                operator.user_id.clone(),
                operator.encryption_public_key.clone(),
                operator.signing_public_key.clone(),
                kem.public_key.clone(),
                kem.signature.clone(),
            ) {
                return Err(CoreError::Sealed(
                    "An operator's post-quantum key does not match their identity.".into(),
                ));
            }
            Some(decode("operator kem publicKey", &kem.public_key, Some(KEM_PUBLIC_KEY_BYTES))?)
        }
    };
    // Hybrid only: a classical seal of a node key is a harvest-now, decrypt-later target.
    let Some(kem_public) = kem else {
        return Err(input(
            "An operator has no post-quantum key yet, so nothing was sealed. Ask them to sign in once.",
        ));
    };
    let mut plaintext = Zeroizing::new(Vec::with_capacity(KEY_BYTES + 32));
    plaintext.extend_from_slice(&node_key);
    plaintext.extend_from_slice(&digest(&report_context(&ctx, 2)));
    let ephemeral = Zeroizing::new(<[u8; 32]>::try_from(random(32)).expect("32 bytes"));
    let ephemeral_public = PublicKey::from(&StaticSecret::from(*ephemeral));
    let pair = pair_key(&operator_public, ephemeral.as_slice())?;
    let (ciphertext, shared) = kem_encapsulate(&kem_public).map_err(|_| input("Invalid operator key."))?;
    let mut material = Zeroizing::new(Vec::with_capacity(64));
    material.extend_from_slice(pair.as_slice());
    material.extend_from_slice(shared.as_slice());
    let mut body_key = Zeroizing::new([0u8; KEY_BYTES]);
    Hkdf::<Sha256>::new(Some(&ciphertext), &material)
        .expand(REPORT_KEY_INFO, body_key.as_mut())
        .map_err(|_| input("HKDF failed"))?;
    let nonce = random(NONCE_BYTES);
    let body = seal_with_nonce(
        body_key.as_slice(),
        &nonce,
        &plaintext,
        &hybrid_report_data(&ctx, ephemeral_public.as_bytes()),
    )?;
    let mut out = Vec::with_capacity(HYBRID_BYTES);
    out.extend_from_slice(ephemeral_public.as_bytes());
    out.extend_from_slice(&ciphertext);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&body);
    debug_assert_eq!(out.len(), HYBRID_BYTES);
    Ok(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::bytes::encode;
    use crate::envelope::open_with_nonce;
    use crate::identity::{kem_decapsulate, kem_public_key_from_seed, KEM_SEED_BYTES};
    use crypto_secretbox::aead::generic_array::GenericArray;
    use ed25519_dalek::{Signer as _, SigningKey};

    /* The operator's side, as the web's `openReportKey` does it: what proves a seal is right. */
    pub(crate) fn open(
        envelope: &[u8],
        public: &[u8],
        secret: &[u8],
        kem_seed: Option<&[u8]>,
        ctx: &ReportContext,
    ) -> CoreResult<Vec<u8>> {
        let (plaintext, suite) = if envelope.len() == SEALED_BOX_BYTES {
            let ephemeral_public = &envelope[..32];
            let key = pair_key(ephemeral_public, secret)?;
            let mut nonce_input = ephemeral_public.to_vec();
            nonce_input.extend_from_slice(public);
            let nonce: [u8; 24] = Blake2b::<U24>::digest(&nonce_input).into();
            let mut body = envelope[48..].to_vec();
            XSalsa20Poly1305::new((&*key).into())
                .decrypt_in_place_detached(
                    (&nonce).into(),
                    b"",
                    &mut body,
                    GenericArray::from_slice(&envelope[32..48]),
                )
                .map_err(|_| CoreError::Sealed("not for this operator".into()))?;
            (body, 1)
        } else {
            let ciphertext = &envelope[32..32 + KEM_CIPHERTEXT_BYTES];
            let nonce = &envelope[32 + KEM_CIPHERTEXT_BYTES..32 + KEM_CIPHERTEXT_BYTES + NONCE_BYTES];
            let pair = pair_key(&envelope[..32], secret)?;
            let shared = kem_decapsulate(kem_seed.expect("a kem seed"), ciphertext)?;
            let mut material = pair.to_vec();
            material.extend_from_slice(shared.as_slice());
            let mut key = [0u8; KEY_BYTES];
            Hkdf::<Sha256>::new(Some(ciphertext), &material).expand(REPORT_KEY_INFO, &mut key).unwrap();
            (
                open_with_nonce(
                    &key,
                    nonce,
                    &envelope[32 + KEM_CIPHERTEXT_BYTES + NONCE_BYTES..],
                    &hybrid_report_data(ctx, &envelope[..32]),
                )?,
                2,
            )
        };
        if plaintext[KEY_BYTES..] != digest(&report_context(ctx, suite)) {
            return Err(CoreError::Sealed("a different report".into()));
        }
        Ok(plaintext[..KEY_BYTES].to_vec())
    }

    fn ctx() -> ReportContext {
        ReportContext {
            workspace_id: "WS".into(),
            node_id: "Node".into(),
            key_epoch: 2,
            report_id: "Report".into(),
            operator_user_id: "Op".into(),
        }
    }

    pub(crate) fn operator(with_kem: bool) -> (OperatorKeys, [u8; 32], Vec<u8>, Vec<u8>) {
        let secret: [u8; 32] = random(32).try_into().unwrap();
        let public = PublicKey::from(&StaticSecret::from(secret)).to_bytes().to_vec();
        let signing = SigningKey::from_bytes(&random(32).try_into().unwrap());
        let kem_seed = random(KEM_SEED_BYTES);
        let kem_public = encode(&kem_public_key_from_seed(&kem_seed).unwrap());
        let binding = context(&[
            json!("hushos/identity/kem"),
            json!(1),
            json!("op"),
            json!(encode(&public)),
            json!(kem_public),
        ]);
        let keys = OperatorKeys {
            user_id: "Op".into(),
            encryption_public_key: encode(&public),
            signing_public_key: encode(signing.verifying_key().as_bytes()),
            kem: with_kem.then(|| OperatorKem {
                public_key: kem_public,
                signature: encode(&signing.sign(&binding).to_bytes()),
            }),
        };
        (keys, secret, public, kem_seed)
    }

    #[test]
    fn the_context_names_the_suite_and_lowercases_ids() {
        assert_eq!(report_context(&ctx(), 2), br#"["hushos/drive/report",2,"ws","node",2,"report","op"]"#);
    }

    #[test]
    fn a_hybrid_seal_opens_for_the_operator_binds_the_report_and_refuses_classical() {
        let node_key = random(32);
        let (keys, secret, public, kem_seed) = operator(true);
        let sealed = report_seal_key(ctx(), node_key.clone(), keys).unwrap();
        assert_eq!(sealed.len(), HYBRID_BYTES);
        assert_eq!(open(&sealed, &public, &secret, Some(&kem_seed), &ctx()).unwrap(), node_key);
        let mut other = ctx();
        other.report_id = "Other".into();
        assert!(
            open(&sealed, &public, &secret, Some(&kem_seed), &other).is_err(),
            "the digest binds the report"
        );
        let stranger: [u8; 32] = random(32).try_into().unwrap();
        assert!(open(&sealed, &public, &stranger, Some(&kem_seed), &ctx()).is_err());
        // X25519 ignores the top bit, so this is the same DH; the associated data must still refuse it.
        let mut recoded = sealed.clone();
        recoded[31] ^= 0x80;
        assert!(open(&recoded, &public, &secret, Some(&kem_seed), &ctx()).is_err());
        // No KEM key: nothing is sealed rather than a classical envelope.
        let (classical, ..) = operator(false);
        assert!(matches!(report_seal_key(ctx(), node_key, classical), Err(CoreError::Input(_))));
    }

    #[test]
    fn a_kem_key_with_a_bad_binding_is_refused_rather_than_downgraded() {
        let (mut keys, ..) = operator(true);
        let (other, ..) = operator(true);
        keys.kem = other.kem;
        assert!(matches!(report_seal_key(ctx(), random(32), keys.clone()), Err(CoreError::Sealed(_))));
        assert!(!kem_binding_verify(
            keys.user_id.clone(),
            keys.encryption_public_key.clone(),
            keys.signing_public_key.clone(),
            keys.kem.as_ref().unwrap().public_key.clone(),
            keys.kem.as_ref().unwrap().signature.clone()
        ));
        let (good, ..) = operator(true);
        let kem = good.kem.clone().unwrap();
        assert!(kem_binding_verify(
            good.user_id,
            good.encryption_public_key,
            good.signing_public_key,
            kem.public_key,
            kem.signature
        ));
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
