//! A report hands an operator the key to what was reported, as
//! `packages/crypto/reports.ts` seals it: the node key and a digest of the
//! report's context, sealed to each operator's identity with no account of the
//! reporter's involved. Suite 1 (112 bytes) is a libsodium sealed box to the
//! operator's X25519 key; suite 2 (1224 bytes) adds an ML-KEM-768
//! encapsulation, the body key being HKDF over both secrets. Only suite 2 is
//! sealed. A version 2 operator's KEM key is used only once their keys
//! statement holds; a version 1 operator's is used as the server serves it.

use crate::bytes::{decode, expect_len, random, KEY_BYTES, NONCE_BYTES};
use crate::envelope::{context, seal_with_nonce};
use crate::error::{input, CoreError, CoreResult};
use crate::identity::{
    identity_verify_keys, kem_encapsulate, PublicIdentity, KEM_CIPHERTEXT_BYTES, KEM_PUBLIC_KEY_BYTES,
};
#[cfg(test)]
use blake2::digest::consts::U24;
use blake2::digest::consts::U32;
use blake2::{Blake2b, Digest as _};
#[cfg(test)]
use crypto_secretbox::aead::{AeadInPlace as _, KeyInit as _};
#[cfg(test)]
use crypto_secretbox::XSalsa20Poly1305;
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

/// An operator as `GET /api/drive/reports/operators` lists them. A version 2
/// identity carries its ML-DSA key, ML-KEM key and keys signature; a version 1
/// identity carries none of them that count.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct OperatorKeys {
    pub user_id: String,
    pub key_version: u64,
    pub encryption_public_key: String,
    pub signing_public_key: String,
    pub ml_dsa_public_key: Option<String>,
    pub kem_public_key: Option<String>,
    pub keys_signature: Option<String>,
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

/* A hybrid envelope's associated data: the report's context and the ephemeral key it carries. */
fn hybrid_report_data(ctx: &ReportContext, ephemeral_public: &[u8]) -> Vec<u8> {
    let mut data = report_context(ctx, 2);
    data.extend_from_slice(ephemeral_public);
    data
}

/// Seals the node key to one operator for a report: 1224 bytes, hybrid. A
/// version 2 operator's KEM key is used only once their keys statement holds,
/// and refused otherwise. A version 1 operator (no ML-DSA key or keys
/// signature) is sealed to the KEM key the server serves, unchecked: operator
/// keys come from the server and nobody pins them, so no binding could protect
/// against the server. An operator with no KEM key at all is refused, since a
/// classical seal is a harvest-now, decrypt-later target.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn report_seal_key(ctx: ReportContext, node_key: Vec<u8>, operator: OperatorKeys) -> CoreResult<Vec<u8>> {
    expect_len("node key", &node_key, KEY_BYTES)?;
    let operator_public = decode("operator encryptionPublicKey", &operator.encryption_public_key, Some(32))
        .map_err(|_| input("Invalid operator key."))?;
    // A version 2 identity (ML-DSA key, KEM key and keys signature all served) is used only once
    // its keys statement holds. Anything else is a version 1 identity, whose KEM key is used as
    // served: operator keys come from the server and nobody pins them, so the Ed25519 binding it
    // once carried never protected against the server either.
    if let (Some(ml_dsa), Some(kem), Some(signature)) =
        (&operator.ml_dsa_public_key, &operator.kem_public_key, &operator.keys_signature)
    {
        let identity = PublicIdentity {
            key_version: operator.key_version,
            encryption_public_key: operator.encryption_public_key.clone(),
            signing_public_key: operator.signing_public_key.clone(),
            ml_dsa_public_key: ml_dsa.clone(),
            kem_public_key: kem.clone(),
            keys_signature: signature.clone(),
        };
        if !identity_verify_keys(operator.user_id.clone(), identity) {
            return Err(CoreError::Sealed("An operator's key does not match their identity.".into()));
        }
    }
    let kem = match &operator.kem_public_key {
        Some(kem) => Some(
            decode("operator kemPublicKey", kem, Some(KEM_PUBLIC_KEY_BYTES))
                .map_err(|_| input("Invalid operator key."))?,
        ),
        None => None,
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

    use crate::envelope::open_with_nonce;
    use crate::identity::kem_decapsulate;
    use crypto_secretbox::aead::generic_array::GenericArray;

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

    /* An operator as the server lists them, version 2 or (stripped) version 1, with their private halves. */
    pub(crate) fn operator(version_2: bool) -> (OperatorKeys, Vec<u8>, Vec<u8>, Vec<u8>) {
        operator_with(version_2, true)
    }

    fn operator_with(version_2: bool, with_kem: bool) -> (OperatorKeys, Vec<u8>, Vec<u8>, Vec<u8>) {
        let root = random(32);
        let envelope = crate::identity::identity_create("Op".into(), root.clone(), 1).unwrap();
        let keys = crate::identity::identity_open("op".into(), root, envelope.clone()).unwrap();
        let operator = OperatorKeys {
            user_id: "Op".into(),
            key_version: 1,
            encryption_public_key: envelope.encryption_public_key.clone(),
            signing_public_key: envelope.signing_public_key.clone(),
            ml_dsa_public_key: version_2.then(|| envelope.ml_dsa.clone().unwrap().public_key),
            kem_public_key: with_kem.then(|| envelope.kem.clone().unwrap().public_key),
            keys_signature: version_2.then(|| envelope.keys_signature.clone().unwrap()),
        };
        let public = decode("k", &envelope.encryption_public_key, Some(32)).unwrap();
        (operator, keys.encryption_private_key.to_vec(), public, keys.kem_seed.to_vec())
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
        let (classical, ..) = operator_with(false, false);
        assert!(matches!(report_seal_key(ctx(), node_key, classical), Err(CoreError::Input(_))));
    }

    #[test]
    fn a_kem_key_the_keys_statement_does_not_vouch_for_is_refused_rather_than_downgraded() {
        let (good, ..) = operator(true);
        let (other, ..) = operator(true);
        assert!(report_seal_key(ctx(), random(32), good.clone()).is_ok());
        // Another operator's KEM key, ML-DSA key or keys signature served beside these keys.
        for swapped in [
            OperatorKeys { kem_public_key: other.kem_public_key.clone(), ..good.clone() },
            OperatorKeys { ml_dsa_public_key: other.ml_dsa_public_key.clone(), ..good.clone() },
            OperatorKeys { keys_signature: other.keys_signature.clone(), ..good.clone() },
            OperatorKeys { key_version: 2, ..good.clone() },
            OperatorKeys { user_id: "someone-else".into(), ..good.clone() },
        ] {
            assert!(matches!(report_seal_key(ctx(), random(32), swapped), Err(CoreError::Sealed(_))));
        }
    }

    #[test]
    fn a_version_1_operator_is_sealed_to_the_served_kem_key_and_only_no_kem_key_is_refused() {
        let node_key = random(32);
        // Version 1 (no ML-DSA key, no keys statement): a hybrid envelope to the served KEM key.
        let (legacy, secret, public, kem_seed) = operator(false);
        assert!(legacy.ml_dsa_public_key.is_none() && legacy.keys_signature.is_none());
        let sealed = report_seal_key(ctx(), node_key.clone(), legacy.clone()).unwrap();
        assert_eq!(sealed.len(), HYBRID_BYTES);
        assert_eq!(open(&sealed, &public, &secret, Some(&kem_seed), &ctx()).unwrap(), node_key);
        // It needs both halves: the X25519 key alone, or another KEM seed, opens nothing.
        let (_, _, _, other_seed) = operator(false);
        assert!(open(&sealed, &public, &secret, Some(&other_seed), &ctx()).is_err());
        // Partly version 2 (an ML-DSA key but no keys statement) is read as version 1, as the web reads it.
        let partial = OperatorKeys { keys_signature: None, ..operator(true).0 };
        assert_eq!(report_seal_key(ctx(), node_key.clone(), partial).unwrap().len(), HYBRID_BYTES);
        // Version 2 with a broken keys statement: refused, never downgraded to the served key.
        let (good, ..) = operator(true);
        let mut signature = crate::bytes::decode("s", good.keys_signature.as_ref().unwrap(), None).unwrap();
        signature[64 + 11] ^= 1;
        let broken = OperatorKeys { keys_signature: Some(crate::bytes::encode(&signature)), ..good };
        assert!(matches!(report_seal_key(ctx(), node_key.clone(), broken), Err(CoreError::Sealed(_))));
        // No KEM key at all, version 1 or 2: refused.
        for (version_2, with_kem) in [(false, false), (true, false)] {
            let (none, ..) = operator_with(version_2, with_kem);
            assert!(matches!(
                report_seal_key(ctx(), node_key.clone(), none),
                Err(CoreError::Input(message)) if message.contains("no post-quantum key")
            ));
        }
        // A served KEM key of the wrong length is refused, not sealed to.
        let short = OperatorKeys { kem_public_key: Some(crate::bytes::encode(&[1; 32])), ..legacy };
        assert!(matches!(report_seal_key(ctx(), node_key, short), Err(CoreError::Input(_))));
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
