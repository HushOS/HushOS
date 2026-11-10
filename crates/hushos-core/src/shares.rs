//! A share: one node's key sealed to one grantee, as `packages/crypto/shares.ts`
//! writes it. Suite 4 (4565 bytes, docs/identity-pq-design.md 3) is the only
//! one sealed or opened: a fresh X25519 key agreed with the grantee's identity
//! key beside an ML-KEM-768 encapsulation, HKDF over both secrets salted with
//! a digest of the KEM ciphertext and both X25519 public keys, and the
//! granter's hybrid signature (Ed25519 and ML-DSA-65) over the sealed bytes,
//! both halves checked against the granter's pinned keys before anything is
//! decapsulated. The suite number is in the key derivation, the associated
//! data and the signed statement, so an envelope cut down to an older suite's
//! length opens as nothing. Suite 3 (1256 bytes, the same with an Ed25519
//! signature alone) and suites 1 and 2 are refused.

use crate::bytes::{expect_len, random, KEY_BYTES, NONCE_BYTES, TAG_BYTES};
use crate::envelope::{context, open_with_nonce, seal_with_nonce};
use crate::error::{input, CoreError, CoreResult};
use crate::identity::{
    kem_decapsulate, kem_encapsulate, IdentityKeys, KEM_CIPHERTEXT_BYTES, KEM_PUBLIC_KEY_BYTES,
    KEM_SEED_BYTES,
};
use crate::pq::{ML_DSA_PUBLIC_KEY_BYTES, ML_DSA_SEED_BYTES};
use crate::signatures::{
    digest, sign_hybrid, verify_hybrid, HybridPublicKey, HYBRID_SIGNATURE_BYTES, MAX_SAFE_INTEGER,
};
use hkdf::Hkdf;
use serde_json::json;
use sha2::Digest as _;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

const SUITE: u32 = 4;
const SIGNED_PART_BYTES: usize = 32 + KEM_CIPHERTEXT_BYTES + NONCE_BYTES + KEY_BYTES + TAG_BYTES;
const SIGNED_SHARE_ENVELOPE_BYTES: usize = SIGNED_PART_BYTES + HYBRID_SIGNATURE_BYTES; // 4565
const SIGNED_SHARE_KEY_INFO: &[u8] = b"hushos/drive/share-key/v4";

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

/// `["hushos/drive/sig/share",4,workspaceId,nodeId,keyEpoch,granteeUserId,granterUserId,sha256(eph || kemCt || nonce || body)]`:
/// what the granter's hybrid signature covers. `sealed` is the envelope
/// without its signature: everything the signature follows.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn share_statement(ctx: ShareContext, sealed: Vec<u8>) -> CoreResult<Vec<u8>> {
    share_message(&ctx, &sealed)
}

fn share_message(ctx: &ShareContext, sealed: &[u8]) -> CoreResult<Vec<u8>> {
    // 1 to 2^53 - 1, as the web counts epochs: above it the web refuses the statement, so a share
    // signed for such an epoch here would open on no web client (found by the differential fuzzer).
    if !(1..=MAX_SAFE_INTEGER).contains(&ctx.key_epoch) {
        return Err(input("Invalid key epoch."));
    }
    let id = |value: &str| {
        if value.is_empty() {
            return Err(input("Invalid share context."));
        }
        Ok(json!(value.to_lowercase()))
    };
    Ok(context(&[
        json!("hushos/drive/sig/share"),
        json!(SUITE),
        id(&ctx.workspace_id)?,
        id(&ctx.node_id)?,
        json!(ctx.key_epoch),
        id(&ctx.grantee_user_id)?,
        id(&ctx.granter_user_id)?,
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

/* HKDF(salt = SHA-256(kemCt || eph || recipientPublic), ikm = dh || kemSs, info of the envelope's kind) */
fn hybrid_seal_key(
    dh: &[u8],
    kem_secret: &[u8],
    kem_ciphertext: &[u8],
    ephemeral_public: &[u8],
    recipient_public: &[u8],
    info: &[u8],
) -> CoreResult<Zeroizing<[u8; KEY_BYTES]>> {
    let salt = Sha256::new()
        .chain_update(kem_ciphertext)
        .chain_update(ephemeral_public)
        .chain_update(recipient_public)
        .finalize();
    let mut material = Zeroizing::new(Vec::with_capacity(dh.len() + kem_secret.len()));
    material.extend_from_slice(dh);
    material.extend_from_slice(kem_secret);
    let mut key = Zeroizing::new([0u8; KEY_BYTES]);
    Hkdf::<Sha256>::new(Some(&salt), &material)
        .expand(info, key.as_mut())
        .map_err(|_| input("HKDF failed"))?;
    Ok(key)
}

/*
 * The suite 4 construction with the payload, HKDF `info`, associated data and
 * signed statement of the caller's choosing: what a share and the group seals
 * (docs/groups-design.md 2.3, 2.6, 2.9) are made with, as `sealHybrid` in
 * packages/crypto/shares.ts. The envelope is the ephemeral X25519 public key,
 * the KEM ciphertext, the nonce, the body and the sealer's hybrid signature
 * over `statement(everything before it)`. Each kind has its own `info` and
 * associated data, so an envelope of one kind opens as nothing as another.
 */
pub(crate) struct SealKind<'a> {
    pub(crate) info: &'a [u8],
    pub(crate) associated_data: Vec<u8>,
    pub(crate) statement: &'a dyn Fn(&[u8]) -> CoreResult<Vec<u8>>,
    /* What the envelope is called, and what a reader is told when it is malformed or its signature does not hold. */
    pub(crate) noun: &'a str,
    pub(crate) invalid: &'a str,
    pub(crate) unsigned: &'a str,
}

/* An envelope's length for a payload of `payload_len` bytes. */
pub(crate) const fn hybrid_seal_bytes(payload_len: usize) -> usize {
    32 + KEM_CIPHERTEXT_BYTES + NONCE_BYTES + payload_len + TAG_BYTES + HYBRID_SIGNATURE_BYTES
}

/*
 * Seals `payload` to the recipient's X25519 and ML-KEM keys under `kind`,
 * signed with the sealer's hybrid signature (its signing and ML-DSA seeds). The
 * recipient's keys must be ones the sealer checked.
 */
pub(crate) fn seal_hybrid(
    payload: &[u8],
    recipient_public_key: &[u8],
    recipient_kem_public_key: &[u8],
    sealer: &IdentityKeys,
    kind: &SealKind,
) -> CoreResult<Vec<u8>> {
    if sealer.ml_dsa_seed.len() != ML_DSA_SEED_BYTES {
        return Err(input("Your keys need upgrading first. Unlock again and retry."));
    }
    expect_len("identity public key", recipient_public_key, 32)
        .map_err(|_| input("Invalid identity key."))?;
    // Hybrid only: a key sealed to X25519 alone is a harvest-now, decrypt-later target.
    if recipient_kem_public_key.is_empty() {
        return Err(input("This person has no post-quantum key yet, so nothing was shared."));
    }
    expect_len("kem public key", recipient_kem_public_key, KEM_PUBLIC_KEY_BYTES)
        .map_err(|_| input("Invalid identity key."))?;
    let ephemeral = Zeroizing::new(random(32));
    let ephemeral_public =
        PublicKey::from(&StaticSecret::from(<[u8; 32]>::try_from(ephemeral.as_slice()).expect("32 bytes")))
            .to_bytes();
    let dh = agree(&ephemeral, recipient_public_key)?;
    let (ciphertext, secret) = kem_encapsulate(recipient_kem_public_key)?;
    let key = hybrid_seal_key(
        dh.as_slice(),
        secret.as_slice(),
        &ciphertext,
        &ephemeral_public,
        recipient_public_key,
        kind.info,
    )?;
    let nonce = random(NONCE_BYTES);
    let mut out = Vec::with_capacity(hybrid_seal_bytes(payload.len()));
    out.extend_from_slice(&ephemeral_public);
    out.extend_from_slice(&ciphertext);
    out.extend_from_slice(&nonce);
    out.extend(seal_with_nonce(key.as_slice(), &nonce, payload, &kind.associated_data)?);
    let signature = sign_hybrid(&sealer.signing_seed, &sealer.ml_dsa_seed, &(kind.statement)(&out)?)?;
    out.extend_from_slice(&signature);
    debug_assert_eq!(out.len(), hybrid_seal_bytes(payload.len()));
    Ok(out)
}

/*
 * Opens an envelope sealed to this identity under `kind`: the payload, of
 * exactly `payload_len` bytes, only once both halves of its signature verify
 * under `sealer`, keys the reader already trusts; nothing is decapsulated before.
 */
pub(crate) fn open_hybrid(
    envelope: &[u8],
    payload_len: usize,
    sealers: &[HybridPublicKey],
    recipient: &IdentityKeys,
    kind: &SealKind,
) -> CoreResult<Vec<u8>> {
    if envelope.len() != hybrid_seal_bytes(payload_len) {
        return Err(input(kind.invalid));
    }
    let (sealed, signature) = envelope.split_at(envelope.len() - HYBRID_SIGNATURE_BYTES);
    let statement = (kind.statement)(sealed)?;
    // Any one of the sealer's keys the caller trusts will do (a member's earlier keys, 2.4).
    let holds = sealers.iter().any(|sealer| {
        sealer.signing_public_key.len() == 32
            && sealer.ml_dsa_public_key.len() == ML_DSA_PUBLIC_KEY_BYTES
            && verify_hybrid(sealer, &statement, signature)
    });
    if !holds {
        return Err(CoreError::Sealed(kind.unsigned.into()));
    }
    if recipient.kem_seed.len() != KEM_SEED_BYTES {
        return Err(input(format!(
            "This {} was sealed to a key this account does not hold yet. Unlock again and retry.",
            kind.noun
        )));
    }
    let ephemeral_public = &sealed[..32];
    let ciphertext = &sealed[32..32 + KEM_CIPHERTEXT_BYTES];
    let nonce = &sealed[32 + KEM_CIPHERTEXT_BYTES..32 + KEM_CIPHERTEXT_BYTES + NONCE_BYTES];
    let body = &sealed[32 + KEM_CIPHERTEXT_BYTES + NONCE_BYTES..];
    let dh = agree(&recipient.encryption_private_key, ephemeral_public)?;
    let secret = kem_decapsulate(&recipient.kem_seed, ciphertext)?;
    let recipient_public =
        crate::bytes::decode("identity public key", &recipient.encryption_public_key, Some(32))?;
    let key = hybrid_seal_key(
        dh.as_slice(),
        secret.as_slice(),
        ciphertext,
        ephemeral_public,
        &recipient_public,
        kind.info,
    )?;
    let payload = open_with_nonce(key.as_slice(), nonce, body, &kind.associated_data)?;
    if payload.len() != payload_len {
        return Err(CoreError::Sealed(kind.invalid.into()));
    }
    Ok(payload)
}

fn share_kind<'a>(ctx: &ShareContext, statement: &'a dyn Fn(&[u8]) -> CoreResult<Vec<u8>>) -> SealKind<'a> {
    SealKind {
        info: SIGNED_SHARE_KEY_INFO,
        associated_data: share_context(ctx, SUITE),
        statement,
        noun: "share",
        invalid: "Invalid share envelope.",
        unsigned: "This share is not signed by the person who shared it.",
    }
}

/// Seals a node key to a grantee in suite 4, signed with the granter's hybrid
/// signature (its signing and ML-DSA seeds; nothing else of the granter's is
/// secret here). A granter whose identity is still version 1 is refused:
/// upgrade it first. Both of the grantee's keys must be the pinned ones:
/// sealing to an unchecked key is sealing to a stranger.
///
/// ```
/// use hushos_core::*;
/// let (root_a, root_b) = (random_bytes(32)?, random_bytes(32)?);
/// let granter = identity_open("a".into(), root_a.clone(), identity_create("a".into(), root_a, 1)?)?;
/// let grantee = identity_open("b".into(), root_b.clone(), identity_create("b".into(), root_b, 1)?)?;
/// let ctx = ShareContext { workspace_id: "w".into(), node_id: "n".into(), key_epoch: 1, grantee_user_id: "b".into(), granter_user_id: "a".into() };
/// let node_key = random_bytes(32)?;
/// let envelope = share_seal(ctx.clone(), node_key.clone(), granter.clone(),
///     base64url_decode(grantee.encryption_public_key.clone())?, base64url_decode(grantee.kem_public_key.clone().unwrap())?)?;
/// assert_eq!(envelope.len(), 4565);
/// // The granter's current keys, as the grantee's version 3 pin vouches for them.
/// let pinned = HybridPublicKey {
///     signing_public_key: base64url_decode(granter.signing_public_key.clone())?,
///     ml_dsa_public_key: base64url_decode(granter.ml_dsa_public_key.clone().unwrap())?,
/// };
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
    let statement = |sealed: &[u8]| share_message(&ctx, sealed);
    seal_hybrid(
        &node_key,
        &grantee_public_key,
        &grantee_kem_public_key,
        &granter,
        &share_kind(&ctx, &statement),
    )
}

/// Opens a share sealed to this identity: the node key inside. Only suite 4
/// opens, and only once both halves of its signature verify under `granter`,
/// the granter's **current** Ed25519 and ML-DSA keys as a version 3 pin
/// vouches for them (followed through a verified succession); nothing is
/// decapsulated before. A key the granter has since replaced opens nothing:
/// such a share waits for the granter to seal it again. After the grantee's
/// own succession, try each of the account's identities ([`IdentityKeys`] of
/// the history) until one opens it; the signature fails alike for all.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn share_open(
    envelope: Vec<u8>,
    granter: HybridPublicKey,
    grantee: IdentityKeys,
    ctx: ShareContext,
) -> CoreResult<Vec<u8>> {
    if envelope.len() != SIGNED_SHARE_ENVELOPE_BYTES {
        return Err(input("Invalid share envelope."));
    }
    if granter.signing_public_key.len() != 32 || granter.ml_dsa_public_key.len() != ML_DSA_PUBLIC_KEY_BYTES {
        return Err(input("This share needs the key of the person who shared it."));
    }
    let statement = |sealed: &[u8]| share_message(&ctx, sealed);
    open_hybrid(&envelope, KEY_BYTES, std::slice::from_ref(&granter), &grantee, &share_kind(&ctx, &statement))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::{decode, random};
    use crate::identity::{identity_create, identity_open, identity_succeed};
    use crate::signatures::sign;

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

    /* What a share opens against: the granter's current signing keys, as pinned. */
    fn pinned(keys: &IdentityKeys) -> HybridPublicKey {
        HybridPublicKey {
            signing_public_key: decode("k", &keys.signing_public_key, Some(32)).unwrap(),
            ml_dsa_public_key: decode("k", keys.ml_dsa_public_key.as_ref().unwrap(), None).unwrap(),
        }
    }

    fn not_signed(result: CoreResult<Vec<u8>>) -> bool {
        matches!(result, Err(CoreError::Sealed(message)) if message.contains("not signed"))
    }

    /* Fuzzing (differential): the web refuses an epoch past 2^53 - 1, so this twin must too. */
    #[test]
    fn the_key_epoch_stops_where_the_web_s_safe_integers_do() {
        let at = |key_epoch| share_statement(ShareContext { key_epoch, ..ctx() }, vec![1; 8]);
        assert!(at(1).is_ok());
        assert!(at(MAX_SAFE_INTEGER).is_ok());
        assert!(at(0).is_err());
        assert!(at(MAX_SAFE_INTEGER + 1).is_err());
        assert!(at(u64::MAX).is_err());
        let (owner, guest) = (person("granter"), person("grantee"));
        let beyond = ShareContext { key_epoch: MAX_SAFE_INTEGER + 1, ..ctx() };
        assert!(share_seal(beyond, random(32), owner, public(&guest), kem(&guest)).is_err());
    }

    #[test]
    fn suite_4_opens_for_the_grantee_from_the_granter_who_signed_it() {
        let (owner, guest) = (person("granter"), person("grantee"));
        let node_key = random(32);
        let envelope =
            share_seal(ctx(), node_key.clone(), owner.clone(), public(&guest), kem(&guest)).unwrap();
        assert_eq!(envelope.len(), 4565);
        assert_eq!(share_open(envelope.clone(), pinned(&owner), guest.clone(), ctx()).unwrap(), node_key);
        let again = share_seal(ctx(), node_key, owner, public(&guest), kem(&guest)).unwrap();
        assert_ne!(again[..32], envelope[..32], "every share has its own ephemeral key");
    }

    #[test]
    fn suite_4_needs_both_halves_of_the_granter_s_signature_each_way_round() {
        let (owner, guest, intruder) = (person("granter"), person("grantee"), person("intruder"));
        let envelope = share_seal(ctx(), random(32), owner.clone(), public(&guest), kem(&guest)).unwrap();
        // A broken Ed25519 half beside a valid ML-DSA one, and the reverse.
        for at in [SIGNED_PART_BYTES + 5, SIGNED_PART_BYTES + 64 + 100] {
            let mut broken = envelope.clone();
            broken[at] ^= 1;
            assert!(not_signed(share_open(broken, pinned(&owner), guest.clone(), ctx())), "byte {at}");
        }
        // Either of the pinned keys swapped for someone else's.
        let ed_only =
            HybridPublicKey { ml_dsa_public_key: pinned(&intruder).ml_dsa_public_key, ..pinned(&owner) };
        let lattice_only =
            HybridPublicKey { signing_public_key: pinned(&intruder).signing_public_key, ..pinned(&owner) };
        for granter in [ed_only, lattice_only] {
            assert!(not_signed(share_open(envelope.clone(), granter, guest.clone(), ctx())));
        }
        // An intruder's two halves, or the real Ed25519 half beside an intruder's ML-DSA half
        // (what a quantum forger of Ed25519 alone could make): not the pinned granter's.
        let planted = share_seal(ctx(), random(32), intruder.clone(), public(&guest), kem(&guest)).unwrap();
        assert!(not_signed(share_open(planted.clone(), pinned(&owner), guest.clone(), ctx())));
        let statement = share_message(&ctx(), &planted[..SIGNED_PART_BYTES]).unwrap();
        let mut forged = planted[..SIGNED_PART_BYTES].to_vec();
        forged.extend(sign_hybrid(&owner.signing_seed, &intruder.ml_dsa_seed, &statement).unwrap());
        assert!(not_signed(share_open(forged, pinned(&owner), guest, ctx())));
    }

    #[test]
    fn suite_4_is_refused_before_decapsulating_unless_the_pinned_granter_signed_it() {
        let (owner, guest) = (person("granter"), person("grantee"));
        let envelope = share_seal(ctx(), random(32), owner.clone(), public(&guest), kem(&guest)).unwrap();
        // Without a KEM key the grantee still hears the signature is wrong: it is checked first.
        let no_kem = IdentityKeys { kem_seed: Vec::new().into(), ..guest.clone() };
        assert!(not_signed(share_open(envelope.clone(), pinned(&person("x")), no_kem.clone(), ctx())));
        assert!(matches!(
            share_open(envelope.clone(), pinned(&owner), no_kem, ctx()),
            Err(CoreError::Input(_))
        ));
        for at in
            [0, 32 + 5, 32 + KEM_CIPHERTEXT_BYTES + 3, SIGNED_PART_BYTES - 1, SIGNED_SHARE_ENVELOPE_BYTES - 1]
        {
            let mut tampered = envelope.clone();
            tampered[at] ^= 1;
            assert!(not_signed(share_open(tampered, pinned(&owner), guest.clone(), ctx())), "byte {at}");
        }
        for change in [
            ShareContext { key_epoch: 4, ..ctx() },
            ShareContext { node_id: "n2".into(), ..ctx() },
            ShareContext { grantee_user_id: "other".into(), ..ctx() },
            ShareContext { granter_user_id: "other".into(), ..ctx() },
        ] {
            assert!(not_signed(share_open(envelope.clone(), pinned(&owner), guest.clone(), change)));
        }
        let missing = HybridPublicKey { signing_public_key: vec![], ml_dsa_public_key: vec![] };
        assert!(matches!(
            share_open(envelope.clone(), missing, guest.clone(), ctx()),
            Err(CoreError::Input(_))
        ));
        let ed_alone = HybridPublicKey { ml_dsa_public_key: vec![], ..pinned(&owner) };
        assert!(matches!(share_open(envelope, ed_alone, guest, ctx()), Err(CoreError::Input(_))));
    }

    #[test]
    fn suite_4_needs_both_of_the_grantee_s_halves_and_the_granter_s_keys_open_nothing() {
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
    fn a_granter_still_on_version_1_or_a_grantee_without_a_kem_key_seals_nothing() {
        let (owner, guest) = (person("granter"), person("grantee"));
        let legacy = IdentityKeys {
            identity_version: 1,
            ml_dsa_seed: Vec::new().into(),
            ml_dsa_public_key: None,
            ..owner
        };
        assert!(matches!(
            share_seal(ctx(), random(32), legacy.clone(), public(&guest), kem(&guest)),
            Err(CoreError::Input(message)) if message.contains("upgrading")
        ));
        assert!(matches!(
            share_seal(ctx(), random(32), person("granter"), public(&guest), vec![]),
            Err(CoreError::Input(message)) if message.contains("post-quantum")
        ));
    }

    #[test]
    fn a_share_signed_with_keys_the_granter_replaced_does_not_open_against_the_current_ones() {
        let guest = person("grantee");
        let root = random(32);
        let first = identity_create("granter".into(), root.clone(), 1).unwrap();
        let earlier = identity_open("granter".into(), root.clone(), first.clone()).unwrap();
        let next = identity_succeed("granter".into(), root.clone(), first).unwrap();
        let current = identity_open("granter".into(), root, next.identity).unwrap();
        let node_key = random(32);
        let envelope = share_seal(ctx(), node_key.clone(), earlier, public(&guest), kem(&guest)).unwrap();
        assert!(not_signed(share_open(envelope, pinned(&current), guest.clone(), ctx())));
        let resealed =
            share_seal(ctx(), node_key.clone(), current.clone(), public(&guest), kem(&guest)).unwrap();
        assert_eq!(share_open(resealed, pinned(&current), guest, ctx()).unwrap(), node_key);
    }

    /* Suite 3 as clients sealed it before this release: the same layout with an Ed25519 signature alone. */
    fn suite_3(granter: &IdentityKeys, grantee: &IdentityKeys, node_key: &[u8]) -> Vec<u8> {
        let ephemeral: [u8; 32] = random(32).try_into().unwrap();
        let ephemeral_public = PublicKey::from(&StaticSecret::from(ephemeral)).to_bytes();
        let dh = agree(&ephemeral, &public(grantee)).unwrap();
        let (ciphertext, secret) = kem_encapsulate(&kem(grantee)).unwrap();
        let salt = Sha256::new()
            .chain_update(&ciphertext)
            .chain_update(ephemeral_public)
            .chain_update(public(grantee))
            .finalize();
        let mut key = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&salt), &[dh.as_slice(), secret.as_slice()].concat())
            .expand(b"hushos/drive/share-key/v3", &mut key)
            .unwrap();
        let nonce = random(NONCE_BYTES);
        let mut out = [ephemeral_public.as_slice(), &ciphertext, &nonce].concat();
        out.extend(seal_with_nonce(&key, &nonce, node_key, &share_context(&ctx(), 3)).unwrap());
        let c = ctx();
        let statement = context(&[
            json!("hushos/drive/sig/share"),
            json!(3),
            json!(c.workspace_id.to_lowercase()),
            json!(c.node_id.to_lowercase()),
            json!(c.key_epoch),
            json!(c.grantee_user_id.to_lowercase()),
            json!(c.granter_user_id.to_lowercase()),
            json!(digest(&out)),
        ]);
        out.extend(sign(&granter.signing_seed, &statement).unwrap());
        out
    }

    #[test]
    fn suite_3_is_refused_even_when_genuine_and_suite_4_cut_to_its_length_opens_nothing() {
        let (owner, guest) = (person("granter"), person("grantee"));
        let node_key = random(32);
        let three = suite_3(&owner, &guest, &node_key);
        assert_eq!(three.len(), 1256);
        assert!(matches!(
            share_open(three, pinned(&owner), guest.clone(), ctx()),
            Err(CoreError::Input(message)) if message.contains("Invalid share envelope")
        ));
        // Stripped of its ML-DSA half: suite 3's length, and nothing opens.
        let four = share_seal(ctx(), node_key.clone(), owner.clone(), public(&guest), kem(&guest)).unwrap();
        let cut = four[..1256].to_vec();
        assert!(share_open(cut.clone(), pinned(&owner), guest.clone(), ctx()).is_err());
        // Nor does the cut envelope pass for suite 3 under suite 3's own rules: the suite is in
        // the key derivation and the associated data, so its body opens under neither.
        let sealed = &cut[..SIGNED_PART_BYTES];
        let dh = agree(&guest.encryption_private_key, &sealed[..32]).unwrap();
        let secret = kem_decapsulate(&guest.kem_seed, &sealed[32..32 + KEM_CIPHERTEXT_BYTES]).unwrap();
        let salt = Sha256::new()
            .chain_update(&sealed[32..32 + KEM_CIPHERTEXT_BYTES])
            .chain_update(&sealed[..32])
            .chain_update(public(&guest))
            .finalize();
        let mut key = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&salt), &[dh.as_slice(), secret.as_slice()].concat())
            .expand(b"hushos/drive/share-key/v3", &mut key)
            .unwrap();
        let nonce = &sealed[32 + KEM_CIPHERTEXT_BYTES..32 + KEM_CIPHERTEXT_BYTES + NONCE_BYTES];
        let body = &sealed[32 + KEM_CIPHERTEXT_BYTES + NONCE_BYTES..];
        assert!(open_with_nonce(&key, nonce, body, &share_context(&ctx(), 3)).is_err());
        // And the real suite 4 still opens: the cut was the only defect.
        assert_eq!(share_open(four, pinned(&owner), guest, ctx()).unwrap(), node_key);
    }

    #[test]
    fn suites_1_and_2_are_refused_even_when_genuine() {
        let guest = person("grantee");
        let granter_secret: [u8; 32] = random(32).try_into().unwrap();
        let granter = pinned(&person("granter"));
        // Built as clients once made them: the static pair key (libsodium crypto_box_beforenm).
        let shared = StaticSecret::from(granter_secret)
            .diffie_hellman(&PublicKey::from(<[u8; 32]>::try_from(public(&guest)).unwrap()));
        let pair =
            salsa20::hsalsa::<salsa20::cipher::consts::U10>(shared.as_bytes().into(), &[0u8; 16].into());
        let nonce = random(NONCE_BYTES);
        let mut one = nonce.clone();
        one.extend(seal_with_nonce(pair.as_slice(), &nonce, &random(32), &share_context(&ctx(), 1)).unwrap());
        let (ciphertext, _) = kem_encapsulate(&kem(&guest)).unwrap();
        let mut two = nonce.clone();
        two.extend_from_slice(&ciphertext);
        two.extend(seal_with_nonce(pair.as_slice(), &nonce, &random(32), &share_context(&ctx(), 2)).unwrap());
        assert_eq!((one.len(), two.len()), (72, 1160));
        for envelope in [one, two] {
            assert!(matches!(
                share_open(envelope, granter.clone(), guest.clone(), ctx()),
                Err(CoreError::Input(message)) if message.contains("Invalid share envelope")
            ));
        }
    }

    #[test]
    fn the_statement_is_the_web_s_array_at_suite_4() {
        let sealed = b"sealed";
        assert_eq!(
            String::from_utf8(share_statement(ctx(), sealed.to_vec()).unwrap()).unwrap(),
            format!(r#"["hushos/drive/sig/share",4,"ws","n1",3,"grantee","granter","{}"]"#, digest(sealed))
        );
        assert!(share_statement(ShareContext { key_epoch: 0, ..ctx() }, sealed.to_vec()).is_err());
    }
}
