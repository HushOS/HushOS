//! ML-DSA-65 (FIPS 204, the pure form, not HashML-DSA), the lattice half of a
//! person's hybrid signature, as `packages/crypto/pq.ts` makes it with
//! `@noble/post-quantum`. A key pair is expanded from the 32-byte key
//! generation seed ξ, which the identity keeps wrapped under the account root
//! beside the Ed25519 seed. Signing is hedged (FIPS 204 Algorithm 2 with fresh
//! randomness), so two signatures over one message differ and both verify.
//!
//! The `ml-dsa` crate is pinned at exactly 0.1.1; the FIPS 204 ACVP vectors in
//! `fixtures/ml-dsa-65-acvp.json` are checked below and by the web's
//! `ml-dsa-acvp.test.ts`, and must pass again before it moves.

use crate::bytes::expect_len;
use crate::error::{input, CoreResult};
use ml_dsa::{
    EncodedSignature, EncodedVerifyingKey, ExpandedSigningKey, MlDsa65, Seed, Signature, VerifyingKey,
};
use zeroize::Zeroize as _;

pub(crate) const ML_DSA_SEED_BYTES: usize = 32;
pub(crate) const ML_DSA_PUBLIC_KEY_BYTES: usize = 1952;
pub(crate) const ML_DSA_SIGNATURE_BYTES: usize = 3309;

fn signing_key(seed: &[u8]) -> CoreResult<ExpandedSigningKey<MlDsa65>> {
    expect_len("ML-DSA seed", seed, ML_DSA_SEED_BYTES).map_err(|_| input("Invalid key seed."))?;
    let mut xi = Seed::try_from(seed).map_err(|_| input("Invalid key seed."))?;
    let key = ExpandedSigningKey::<MlDsa65>::from_seed(&xi);
    xi.as_mut_slice().zeroize();
    Ok(key)
}

/* ML-DSA.KeyGen_internal(ξ): the encoded public key. */
pub(crate) fn ml_dsa_public_key(seed: &[u8]) -> CoreResult<Vec<u8>> {
    Ok(signing_key(seed)?.verifying_key().encode().to_vec())
}

/*
 * ML-DSA.Sign (FIPS 204 Algorithm 2), pure: Sign_internal over
 * M' = 0 || |ctx| || ctx || M with the 32 bytes of `rnd`. Production passes
 * fresh randomness; only the ACVP vectors pass fixed bytes.
 */
fn sign_with(
    key: &ExpandedSigningKey<MlDsa65>,
    message: &[u8],
    context: &[u8],
    rnd: &[u8; 32],
) -> CoreResult<Vec<u8>> {
    let length = u8::try_from(context.len()).map_err(|_| input("Invalid signature context."))?;
    let mut rnd = ml_dsa::B32::from(*rnd);
    let signature = key.sign_internal(&[&[0, length], context, message], &rnd);
    rnd.as_mut_slice().zeroize();
    Ok(signature.encode().to_vec())
}

/* A hedged ML-DSA-65 signature by the key `seed` expands to, under `context`. */
pub(crate) fn ml_dsa_sign(seed: &[u8], message: &[u8], context: &[u8]) -> CoreResult<Vec<u8>> {
    let key = signing_key(seed)?;
    let mut rnd: [u8; 32] = crate::bytes::random(32).try_into().expect("32 bytes");
    let signature = sign_with(&key, message, context, &rnd);
    rnd.zeroize();
    signature
}

/* Whether `signature` is `public_key`'s over `message` under `context`. Anything malformed is simply not valid. */
pub(crate) fn ml_dsa_verify(public_key: &[u8], message: &[u8], signature: &[u8], context: &[u8]) -> bool {
    if public_key.len() != ML_DSA_PUBLIC_KEY_BYTES || signature.len() != ML_DSA_SIGNATURE_BYTES {
        return false;
    }
    let (Ok(key), Ok(encoded)) = (
        EncodedVerifyingKey::<MlDsa65>::try_from(public_key),
        EncodedSignature::<MlDsa65>::try_from(signature),
    ) else {
        return false;
    };
    // sigDecode refuses a malformed hint or an out-of-range z before anything is computed.
    let Some(signature) = Signature::<MlDsa65>::decode(&encoded) else {
        return false;
    };
    VerifyingKey::<MlDsa65>::decode(&key).verify_with_context(message, context, &signature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::random;
    use serde_json::Value;

    const CONTEXT: &[u8] = b"hushos/identity/v1";

    fn hex(value: &Value, key: &str) -> Vec<u8> {
        let text = value[key].as_str().unwrap_or_else(|| panic!("{key} is a string"));
        assert!(text.len().is_multiple_of(2), "{key} has whole bytes");
        (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
    }

    fn acvp() -> Value {
        serde_json::from_str(include_str!("../fixtures/ml-dsa-65-acvp.json"))
            .expect("the ACVP fixture is JSON")
    }

    #[test]
    fn acvp_key_generation_from_xi_gives_the_published_keys() {
        let cases = acvp()["keyGen"].as_array().unwrap().clone();
        assert_eq!(cases.len(), 5);
        for case in cases {
            let seed = hex(&case, "seed");
            assert_eq!(ml_dsa_public_key(&seed).unwrap(), hex(&case, "pk"), "tcId {}", case["tcId"]);
            #[allow(deprecated)]
            let expanded = signing_key(&seed).unwrap().to_expanded();
            assert_eq!(expanded.to_vec(), hex(&case, "sk"), "tcId {}", case["tcId"]);
        }
    }

    #[test]
    fn acvp_signing_with_a_context_gives_the_published_signatures() {
        let cases = acvp()["sigGen"].as_array().unwrap().clone();
        assert_eq!(cases.len(), 7);
        for case in cases {
            let sk = hex(&case, "sk");
            #[allow(deprecated)]
            let key = ExpandedSigningKey::<MlDsa65>::from_expanded(&sk.as_slice().try_into().unwrap());
            let rnd: [u8; 32] = if case["deterministic"].as_bool().unwrap() {
                [0; 32]
            } else {
                hex(&case, "rnd").try_into().unwrap()
            };
            let (message, context) = (hex(&case, "message"), hex(&case, "context"));
            let signature = sign_with(&key, &message, &context, &rnd).unwrap();
            assert_eq!(signature, hex(&case, "signature"), "tcId {}", case["tcId"]);
            assert!(
                ml_dsa_verify(&hex(&case, "pk"), &message, &signature, &context),
                "tcId {}",
                case["tcId"]
            );
        }
    }

    #[test]
    fn acvp_verification_accepts_the_valid_and_refuses_each_modification_including_malformed_hints() {
        let cases = acvp()["sigVer"].as_array().unwrap().clone();
        let reasons: Vec<&str> = cases.iter().map(|case| case["reason"].as_str().unwrap()).collect();
        assert!(reasons.iter().filter(|r| r.contains("hint")).count() >= 3, "malformed hints are covered");
        assert!(cases.iter().any(|case| case["testPassed"] == true));
        for case in &cases {
            assert_eq!(
                ml_dsa_verify(
                    &hex(case, "pk"),
                    &hex(case, "message"),
                    &hex(case, "signature"),
                    &hex(case, "context")
                ),
                case["testPassed"].as_bool().unwrap(),
                "tcId {}: {}",
                case["tcId"],
                case["reason"]
            );
        }
    }

    #[test]
    fn hedged_signing_frames_the_context_as_fips_204_does_and_differs_each_time() {
        let seed = random(32);
        let public = ml_dsa_public_key(&seed).unwrap();
        assert_eq!(public.len(), ML_DSA_PUBLIC_KEY_BYTES);
        let one = ml_dsa_sign(&seed, b"statement", CONTEXT).unwrap();
        let two = ml_dsa_sign(&seed, b"statement", CONTEXT).unwrap();
        assert_eq!(one.len(), ML_DSA_SIGNATURE_BYTES);
        assert_ne!(one, two, "fresh randomness each time");
        assert!(ml_dsa_verify(&public, b"statement", &one, CONTEXT));
        assert!(ml_dsa_verify(&public, b"statement", &two, CONTEXT));
        // The framing with zero randomness is the crate's own deterministic ML-DSA.Sign.
        let key = signing_key(&seed).unwrap();
        assert_eq!(
            sign_with(&key, b"statement", CONTEXT, &[0; 32]).unwrap(),
            key.sign_deterministic(b"statement", CONTEXT).unwrap().encode().to_vec()
        );
    }

    #[test]
    fn a_signature_under_another_context_key_or_message_does_not_verify() {
        let seed = random(32);
        let public = ml_dsa_public_key(&seed).unwrap();
        let signature = ml_dsa_sign(&seed, b"statement", CONTEXT).unwrap();
        // The group key's context, and no context at all: neither stands in for the identity's.
        assert!(!ml_dsa_verify(&public, b"statement", &signature, b"hushos/group/v1"));
        assert!(!ml_dsa_verify(&public, b"statement", &signature, b""));
        let grouped = ml_dsa_sign(&seed, b"statement", b"hushos/group/v1").unwrap();
        assert!(!ml_dsa_verify(&public, b"statement", &grouped, CONTEXT));
        assert!(!ml_dsa_verify(&ml_dsa_public_key(&random(32)).unwrap(), b"statement", &signature, CONTEXT));
        assert!(!ml_dsa_verify(&public, b"statemenu", &signature, CONTEXT));
        assert!(!ml_dsa_verify(&public, b"statement", &signature[1..], CONTEXT));
        assert!(!ml_dsa_verify(&public[1..], b"statement", &signature, CONTEXT));
        assert!(ml_dsa_sign(&seed[1..], b"statement", CONTEXT).is_err());
        assert!(ml_dsa_sign(&seed, b"statement", &[0; 256]).is_err(), "a context is at most 255 bytes");
    }
}
