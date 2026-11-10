//! The company key (docs/companies-design.md 2.2), as
//! `packages/crypto/custody.ts` makes it: the key pair a company holds, the
//! recovery kit, and every seal around them, each the share suite 4
//! construction (`shares.rs`) under its own HKDF `info`, with its statement
//! without the final digest as associated data. Also the request to use the
//! kit, and a folder's notice keys (3.7). The shared company fixtures pin the
//! bytes to the web's. What a roster says of the company key and the kit, and
//! who may change it, is `group_trust.rs` (`check_roster_org`).
//!
//! Who made a seal is judged by the chain's own record of the roster the seal
//! names: who signed the roster that introduced a key, and who held
//! `DataAdmin` there. A seal its sealer signed that does not open, or opens to
//! something other than what the chain commits to, is the sealer's doing and
//! is reported with their id ([`SealCheck`]), never thrown away silently.

use crate::bytes::{decode, encode, random, SecretBytes, NONCE_BYTES, TAG_BYTES};
use crate::canonical::{
    digest_of, encode_statement, integer, number, parse_statement, require_canonical, text, uuid,
};
use crate::envelope::{open_with_nonce, seal_with_nonce};
use crate::error::{input, CoreError, CoreResult};
use crate::group_trust::{
    check_time, AcceptedRosters, CustodyKeyAt, CustodyPublicKey, KitKeysAt, KitPublicKeys, OrgChain,
};
use crate::groups::{
    area_key_commitment, group_public_key, listed_area, member_recipient, same_group, sealed_at_latest,
    sealed_on_chain, sealer_holds, signers_through, with_digest, GroupKind, GroupRole, SignerHistory,
    GROUP_SEED_BYTES, NOT_LISTED, NOT_LISTED_KEY,
};
use crate::identity::{kem_public_key_from_seed, IdentityKeys, KEM_PUBLIC_KEY_BYTES};
use crate::pq::{ml_dsa_public_key, ML_DSA_PUBLIC_KEY_BYTES};
use crate::shares::{
    hybrid_sealed_bytes, open_hybrid, open_hybrid_with, require_sealed_by, seal_hybrid, seal_with_coins,
    sealed_with_coins, SealKind, SEAL_COINS_BYTES,
};
use crate::signatures::{
    digest, sign_hybrid, signing_public_key_of, verify_hybrid, HybridPublicKey, HYBRID_SIGNATURE_BYTES,
};
use hkdf::Hkdf;
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};
use std::sync::Arc;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

/* 32 bytes of X25519 secret, then 64 of ML-KEM-768 key generation seed. It encrypts only. */
pub(crate) const CUSTODY_SEED_BYTES: usize = 96;
/* The recovery kit's secret, shown as 24 words and saved as a file. */
pub(crate) const KIT_SECRET_BYTES: usize = 32;
/* X25519 (32), ML-KEM-768 (64), Ed25519 (32) and ML-DSA-65 (32) seeds, in that order. */
pub(crate) const KIT_SEED_BYTES: usize = 160;
/* A folder's notice seed: 32 bytes of X25519 secret, then 64 of ML-KEM-768 seed. */
pub(crate) const NOTICE_SEED_BYTES: usize = 96;
/* The previous notice seed, wrapped: a 24-byte nonce, the seed and a 16-byte tag. */
pub(crate) const PREVIOUS_NOTICE_SEED_BYTES: usize = NONCE_BYTES + NOTICE_SEED_BYTES + TAG_BYTES; // 136

const NOT_A_COMPANY: &str = "This is not a company.";
const NOT_PUBLISHED: &str = "This company key is not one the company has published.";
const NOT_THE_KEY: &str = "This is not the company’s published key.";
const NOT_THE_KIT: &str = "This is not the company’s recovery kit.";
const NOT_LATEST: &str = "A seal is made to the company’s latest key.";

/// A fresh company key seed (96 bytes): made once, on the device that makes
/// or replaces the key, and then only ever sealed.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn custody_seed_create() -> SecretBytes {
    SecretBytes::new(random(CUSTODY_SEED_BYTES))
}

/// A fresh recovery kit secret (32 bytes).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn kit_secret_create() -> SecretBytes {
    SecretBytes::new(random(KIT_SECRET_BYTES))
}

/* The X25519 public key of the 32-byte secret given (the secret is the scalar, as every identity's). */
fn encryption_public_key(secret: &[u8]) -> CoreResult<[u8; 32]> {
    let secret = Zeroizing::new(<[u8; 32]>::try_from(secret).map_err(|_| input("Invalid company key."))?);
    Ok(PublicKey::from(&StaticSecret::from(*secret)).to_bytes())
}

/* The two public keys a 96-byte seed expands to: a company key's, or a folder's notice keys'. */
fn sealing_public_key(seed: &[u8], what: &str) -> CoreResult<CustodyPublicKey> {
    if seed.len() != CUSTODY_SEED_BYTES {
        return Err(input(format!("Invalid {what}.")));
    }
    Ok(CustodyPublicKey {
        encryption_public_key: encode(&encryption_public_key(&seed[..32])?),
        kem_public_key: encode(&kem_public_key_from_seed(&seed[32..])?),
    })
}

/// The company key's public halves, from its 96-byte seed: X25519 from the
/// first 32 bytes, ML-KEM-768 from the other 64.
///
/// ```
/// use hushos_core::*;
/// let key = custody_public_key(vec![9; 96])?;
/// assert_eq!(base64url_decode(key.encryption_public_key.clone())?.len(), 32);
/// assert_eq!(base64url_decode(key.kem_public_key.clone())?.len(), 1184);
/// assert_eq!(custody_public_key(vec![9; 96])?, key);
/// assert!(custody_public_key(vec![9; 95]).is_err());
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn custody_public_key(seed: Vec<u8>) -> CoreResult<CustodyPublicKey> {
    let seed = Zeroizing::new(seed);
    sealing_public_key(&seed, "company key")
}

fn hkdf(ikm: &[u8], info: &[u8], length: usize) -> CoreResult<Zeroizing<Vec<u8>>> {
    let mut out = Zeroizing::new(vec![0u8; length]);
    Hkdf::<Sha256>::new(Some(&[0u8; 32]), ikm)
        .expand(info, out.as_mut())
        .map_err(|_| input("HKDF failed"))?;
    Ok(out)
}

/*
 * The recovery kit's seeds (companies-design 2.2):
 *
 *   kitSeed (160) = HKDF-SHA-256(ikm = kitSecret, salt = 32 zero bytes,
 *                   info = "hushos/group/recovery-kit/v1" || groupId, 160)
 *                 = X25519 (32) || ML-KEM-768 (64) || Ed25519 (32) || ML-DSA-65 (32)
 *
 * Bound to the company by its id (36 ASCII bytes): the same secret under
 * another company is another kit.
 */
pub(crate) fn kit_seed(kit_secret: &[u8], group_id: &str) -> CoreResult<Zeroizing<Vec<u8>>> {
    if kit_secret.len() != KIT_SECRET_BYTES {
        return Err(input("Invalid recovery kit."));
    }
    let mut info = b"hushos/group/recovery-kit/v1".to_vec();
    info.extend_from_slice(uuid(group_id, "group id")?.as_bytes());
    hkdf(kit_secret, &info, KIT_SEED_BYTES)
}

/// The recovery kit's four public keys, from its 32-byte secret and the
/// company's id (companies-design 2.2). The first two open kit seals; the
/// last two sign one thing only, a recovery roster.
///
/// ```
/// use hushos_core::*;
/// let group_id = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".to_string();
/// let kit = kit_public_keys(vec![3; 32], group_id.clone())?;
/// assert_eq!(kit_public_keys(vec![3; 32], group_id)?, kit);
/// // The same secret under another company is another kit.
/// let other = kit_public_keys(vec![3; 32], "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b".into())?;
/// assert_ne!(other.signing_public_key, kit.signing_public_key);
/// assert!(kit_public_keys(vec![3; 31], "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b".into()).is_err());
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn kit_public_keys(kit_secret: Vec<u8>, group_id: String) -> CoreResult<KitPublicKeys> {
    let kit_secret = Zeroizing::new(kit_secret);
    let seed = kit_seed(&kit_secret, &group_id)?;
    let sealing = sealing_public_key(&seed[..96], "recovery kit")?;
    Ok(KitPublicKeys {
        encryption_public_key: sealing.encryption_public_key,
        kem_public_key: sealing.kem_public_key,
        signing_public_key: encode(&signing_public_key_of(&seed[96..128])?),
        ml_dsa_public_key: encode(&ml_dsa_public_key(&seed[128..])?),
    })
}

/// What the creator and the kit show of a company key (companies-design 2.2):
/// the first 160 bits of
/// `SHA-256("hushos/group/custody/fingerprint/v1" || groupId (36 ASCII bytes) || u64be(custodyKeyVersion) || custodyEncryptionPublicKey (32) || custodyKemPublicKey (1184))`
/// as ten groups of four hex digits, read as twelve words like a person's.
///
/// ```
/// use hushos_core::*;
/// let group_id = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".to_string();
/// let key = custody_public_key(vec![9; 96])?;
/// let words = custody_fingerprint(group_id.clone(), 1, key.clone())?;
/// assert_eq!(words.split(' ').count(), 10);
/// assert_ne!(custody_fingerprint(group_id, 2, key)?, words);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn custody_fingerprint(
    group_id: String,
    custody_key_version: u64,
    key: CustodyPublicKey,
) -> CoreResult<String> {
    uuid(&group_id, "group id")?;
    integer(custody_key_version, "company key version")?;
    let bad = |_| input("Invalid company key.");
    let encryption = decode("company key", &key.encryption_public_key, Some(32)).map_err(bad)?;
    let kem = decode("company key", &key.kem_public_key, Some(KEM_PUBLIC_KEY_BYTES)).map_err(bad)?;
    let hash = Sha256::new()
        .chain_update(b"hushos/group/custody/fingerprint/v1")
        .chain_update(group_id.as_bytes())
        .chain_update(custody_key_version.to_be_bytes())
        .chain_update(&encryption)
        .chain_update(&kem)
        .finalize();
    let hex: String = hash[..20].iter().map(|b| format!("{b:02x}")).collect();
    Ok(hex.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).expect("hex")).collect::<Vec<_>>().join(" "))
}

/* Whether two byte strings are equal, in time that depends only on their length (the web's sameBytes). */
fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |difference, (x, y)| difference | (x ^ y)) == 0
}

/* What the chain says of its company */

/// What a check of a seal says:
///
/// - `Opened`, with what it held: its sealer signed it under keys their entry
///   still names;
/// - `Unattributed`, with what it held: it holds what the chain commits to,
///   and was signed under the keys its sealer's entry named at the roster it
///   names, which the entry has since left (a new identity folded in, or keys
///   written over). It still opens: a `previousEnvelope` or a folder's seal is
///   never remade for its sealer's sake. It says nothing of who holds that
///   entry now;
/// - `Bad`: its signature holds under those keys and yet it does not open, or
///   holds something other than what the chain commits to. It names the
///   sealer, under their own signature, unless their keys have since been
///   replaced (then nobody the list names now is answerable for it: `None`).
///
/// A seal nobody entitled signed is refused instead: it says nothing of anyone.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum SealCheck {
    Opened { value: SecretBytes },
    Unattributed { value: SecretBytes },
    Bad { sealer_user_id: Option<String> },
}

/// What a data admin's check of a kit seal says ([`kit_seal_check`]): the kit
/// will open to the company key (`Holds`; `Unattributed` when its sealer's
/// keys have since been replaced), or it will not (`Bad`, naming the sealer
/// unless their keys have since been replaced).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum KitSealCheck {
    Holds,
    Unattributed,
    Bad { sealer_user_id: Option<String> },
}

fn company_of<'a>(chain: &'a Arc<AcceptedRosters>, group_id: &str) -> CoreResult<&'a OrgChain> {
    same_group(chain, group_id)?;
    chain.org.as_ref().filter(|_| chain.kind == GroupKind::Org).ok_or_else(|| input(NOT_A_COMPANY))
}

fn at_version<'a, T>(history: &'a [T], version: u64, what: &str, missing: &str) -> CoreResult<&'a T> {
    integer(version, what)?;
    usize::try_from(version - 1).ok().and_then(|index| history.get(index)).ok_or_else(|| input(missing))
}

/* The company key at `version`, as the roster that introduced it named it. */
fn custody_at(org: &OrgChain, version: u64) -> CoreResult<&CustodyKeyAt> {
    at_version(&org.custody_keys, version, "company key version", NOT_PUBLISHED)
}

fn kit_at(org: &OrgChain, version: u64) -> CoreResult<&KitKeysAt> {
    at_version(&org.kit_keys, version, "recovery kit version", NOT_THE_KIT)
}

/* The version of a key in force at the roster `roster_version`: the latest one a roster up to it introduced. */
fn version_at(introduced: impl Iterator<Item = u64>, roster_version: u64) -> u64 {
    introduced.filter(|at| *at <= roster_version).count() as u64
}

/* Whether `user_id` held `DataAdmin` on the roster at `roster_version`. */
fn was_data_admin(org: &OrgChain, user_id: &str, roster_version: u64) -> bool {
    org.data_admins.get(user_id).is_some_and(|spans| {
        spans
            .iter()
            .any(|span| span.from <= roster_version && span.until.is_none_or(|until| roster_version < until))
    })
}

/* What a seal to a company key or a kit is sealed to: its X25519 key, and the served ML-KEM key only if the chain names it. */
fn listed_recipient(
    encryption_public_key: &str,
    kem_public_key_digest: &str,
    kem_public_key: &[u8],
) -> CoreResult<Vec<u8>> {
    if kem_public_key.len() != KEM_PUBLIC_KEY_BYTES || digest(kem_public_key) != kem_public_key_digest {
        return Err(input(NOT_LISTED));
    }
    decode("encryptionPublicKey", encryption_public_key, Some(32))
}

/* Whether a seed's public keys are the ones the chain names at a version. */
fn seed_is(seed: &[u8], at: &CustodyKeyAt) -> bool {
    sealing_public_key(seed, "company key").is_ok_and(|derived| {
        derived.encryption_public_key == at.encryption_public_key
            && decode("kemPublicKey", &derived.kem_public_key, None)
                .is_ok_and(|kem| digest(&kem) == at.kem_public_key_digest)
    })
}

/* The opener's company seed at `version`, refused unless it is the chain's. */
fn custody_secrets<'a>(org: &OrgChain, version: u64, seed: &'a [u8]) -> CoreResult<&'a [u8]> {
    if !seed_is(seed, custody_at(org, version)?) {
        return Err(input(NOT_THE_KEY));
    }
    Ok(seed)
}

type Statement<'a> = &'a dyn Fn(&[u8]) -> CoreResult<Vec<u8>>;

/* The seal kind of a statement: `parts` is the statement without its final digest, and the associated data. */
fn kind_of<'a>(parts: &[Value], info: &'a [u8], statement: Statement<'a>) -> CoreResult<SealKind<'a>> {
    Ok(SealKind {
        info,
        associated_data: encode_statement(parts)?,
        statement,
        noun: "company seal",
        invalid: "Invalid company seal.",
        unsigned: "This was not sealed by someone the company’s member list entitles.",
    })
}

/*
 * The keys a seal that names a roster is checked under: the ones its sealer's
 * entry named at that roster (the chain's own record, OrgChain::signer_keys),
 * whatever the entry names now, and whether it still names them. Family seals
 * are remade when their sealer's keys change; a `previousEnvelope` and a
 * folder's seal to the company key are not, so they are never judged by the
 * sealer's latest keys or by a succession path that may not exist (an Owner
 * who started over, a `left` entry written over). A served ML-DSA key the
 * entry did not name there is refused, as is a sealer not yet on the list.
 */
fn signer_at(
    org: &OrgChain,
    sealer_user_id: &str,
    roster_version: u64,
    served_ml_dsa_public_key: &[u8],
) -> CoreResult<(HybridPublicKey, bool)> {
    let spans = org.signer_keys.get(sealer_user_id).map(Vec::as_slice).unwrap_or_default();
    let named = spans
        .iter()
        .enumerate()
        .rfind(|(_, span)| span.from <= roster_version)
        .filter(|(_, span)| {
            served_ml_dsa_public_key.len() == ML_DSA_PUBLIC_KEY_BYTES
                && digest(served_ml_dsa_public_key) == span.ml_dsa_public_key_digest
        })
        .ok_or_else(|| input(NOT_LISTED))?;
    Ok((
        HybridPublicKey {
            signing_public_key: decode("signingPublicKey", &named.1.signing_public_key, Some(32))?,
            ml_dsa_public_key: served_ml_dsa_public_key.to_vec(),
        },
        named.0 == spans.len() - 1,
    ))
}

/*
 * Opens a seal to a company key and judges what it holds: refused unless the
 * keys its sealer's entry named at the roster it names signed it; then `Bad`
 * when it does not open under the seed or `holds` says the payload is not
 * what the chain commits to; else what it held, attributed to its sealer only
 * while their entry still names those keys.
 */
#[allow(clippy::too_many_arguments)]
fn open_checked(
    envelope: &[u8],
    payload_len: usize,
    sealer_user_id: &str,
    roster_version: u64,
    kind: &SealKind,
    org: &OrgChain,
    sealer_ml_dsa_public_key: &[u8],
    custody_seed: &[u8],
    holds: impl Fn(&[u8]) -> bool,
) -> CoreResult<SealCheck> {
    let (signer, current) = signer_at(org, sealer_user_id, roster_version, sealer_ml_dsa_public_key)?;
    let signers = [signer];
    require_sealed_by(envelope, payload_len, &signers, kind)?;
    let opened =
        open_hybrid_with(envelope, payload_len, &signers, &custody_seed[..32], &custody_seed[32..], kind);
    Ok(match opened.map(SecretBytes::new) {
        Ok(value) if holds(&value) => {
            if current {
                SealCheck::Opened { value }
            } else {
                SealCheck::Unattributed { value }
            }
        }
        _ => SealCheck::Bad { sealer_user_id: current.then(|| sealer_user_id.to_string()) },
    })
}

/* Folder keys sealed to the company key (2.2) */

const CUSTODY_SEAL_INFO: &[u8] = b"hushos/group/custody-seal/v1";

/// What a custody seal names: the folder and its key version, the company key
/// it is sealed to, its sealer, and the roster the sealer had accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct CustodySealContext {
    pub group_id: String,
    pub workspace_id: String,
    pub workspace_key_version: u64,
    pub custody_key_version: u64,
    pub sealer_user_id: String,
    pub roster_version: u64,
    pub roster_digest: String,
}

fn custody_seal_parts(ctx: &CustodySealContext) -> CoreResult<Vec<Value>> {
    Ok(vec![
        json!("hushos/group/custody-seal"),
        json!(1),
        json!(uuid(&ctx.group_id, "group id")?),
        json!(uuid(&ctx.workspace_id, "workspace id")?),
        json!(integer(ctx.workspace_key_version, "workspace key version")?),
        json!(integer(ctx.custody_key_version, "company key version")?),
        json!(uuid(&ctx.sealer_user_id, "user id")?),
        json!(integer(ctx.roster_version, "roster version")?),
        json!(digest_of(&ctx.roster_digest, "roster digest")?),
    ])
}

/// `["hushos/group/custody-seal",1,groupId,workspaceId,workspaceKeyVersion,custodyKeyVersion,sealerUserId,rosterVersion,rosterDigest,sha256(sealed)]`;
/// the associated data is the same without the digest.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn custody_seal_statement(ctx: CustodySealContext, sealed: Vec<u8>) -> CoreResult<Vec<u8>> {
    with_digest(custody_seal_parts(&ctx)?, &sealed)
}

/*
 * Who may have sealed an area key at the roster a custody seal names: the
 * signer of the roster that listed that key version, on that roster (the
 * seal rides on it); or, for a re-seal after the company key was replaced,
 * anyone who held `DataAdmin` on the roster named.
 */
fn custody_sealer(org: &OrgChain, ctx: &CustodySealContext) -> bool {
    let listed_at = usize::try_from(ctx.workspace_key_version.wrapping_sub(1))
        .ok()
        .and_then(|index| org.area_rosters.get(&ctx.workspace_id)?.get(index));
    // Never before the roster that listed the key.
    let Some(listed_at) = listed_at.filter(|at| at.roster_version <= ctx.roster_version) else {
        return false;
    };
    (listed_at.roster_version == ctx.roster_version && listed_at.signer_user_id == ctx.sealer_user_id)
        || was_data_admin(org, &ctx.sealer_user_id, ctx.roster_version)
}

/// Seals an area's key to the company key: only a key the accepted chain
/// lists for that company, at the version it lists (so no personal
/// workspace's key can enter, 2.6), never for a retired area, to the latest
/// company key and no other, by the signer of the roster that listed the key
/// or by a data admin re-sealing after a replacement, at their latest
/// accepted roster.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn custody_seal(
    workspace_key: Vec<u8>,
    ctx: CustodySealContext,
    chain: Arc<AcceptedRosters>,
    custody_kem_public_key: Vec<u8>,
    sealer: IdentityKeys,
) -> CoreResult<Vec<u8>> {
    let workspace_key = Zeroizing::new(workspace_key);
    if workspace_key.len() != 32 {
        return Err(input("Invalid workspace key."));
    }
    let parts = custody_seal_parts(&ctx)?;
    let org = company_of(&chain, &ctx.group_id)?;
    sealed_at_latest(&chain, ctx.roster_version, &ctx.roster_digest)?;
    if ctx.custody_key_version != org.custody_keys.len() as u64 {
        return Err(input(NOT_LATEST));
    }
    if chain.retired_areas.contains(&ctx.workspace_id) {
        return Err(input("This folder was deleted: it cannot be used again."));
    }
    if listed_area(&chain, &ctx.workspace_id, ctx.workspace_key_version)
        != Some(area_key_commitment(&workspace_key)?.as_str())
    {
        return Err(input(NOT_LISTED_KEY));
    }
    if !custody_sealer(org, &ctx)
        || !chain.roster.entry(&ctx.sealer_user_id).is_some_and(|entry| entry.active_with(None))
    {
        return Err(input("A folder’s key is sealed to the company by whoever made it, or by a data admin."));
    }
    sealer_holds(&chain, &ctx.sealer_user_id, &sealer)?;
    let key = custody_at(org, ctx.custody_key_version)?;
    let recipient =
        listed_recipient(&key.encryption_public_key, &key.kem_public_key_digest, &custody_kem_public_key)?;
    let statement = |sealed: &[u8]| custody_seal_statement(ctx.clone(), sealed.to_vec());
    seal_hybrid(
        &workspace_key,
        &recipient,
        &custody_kem_public_key,
        &sealer,
        &kind_of(&parts, CUSTODY_SEAL_INFO, &statement)?,
    )
}

/// A data admin's check of a custody seal (2.2, "Checking a seal"), and the
/// way the admin browser reaches a folder's key: refused unless it names this
/// company, a roster on the chain, the company key in force at that roster,
/// an area key version the chain listed by then, and a sealer entitled there
/// whose signature holds; `custody_seed` must be the chain's company key at
/// the version named. Then the folder's key, or `Bad` with the sealer when
/// the seal does not open or opens to a key other than the one the roster
/// commits to.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn custody_seal_open(
    envelope: Vec<u8>,
    ctx: CustodySealContext,
    chain: Arc<AcceptedRosters>,
    sealer_ml_dsa_public_key: Vec<u8>,
    custody_seed: Vec<u8>,
) -> CoreResult<SealCheck> {
    let custody_seed = Zeroizing::new(custody_seed);
    let parts = custody_seal_parts(&ctx)?;
    let org = company_of(&chain, &ctx.group_id)?;
    sealed_on_chain(&chain, ctx.roster_version, &ctx.roster_digest)?;
    if ctx.custody_key_version
        != version_at(org.custody_keys.iter().map(|at| at.roster_version), ctx.roster_version)
    {
        return Err(input(NOT_PUBLISHED));
    }
    let listed = listed_area(&chain, &ctx.workspace_id, ctx.workspace_key_version)
        .ok_or_else(|| input("This area key version is not on the group’s member list."))?;
    if !custody_sealer(org, &ctx) {
        return Err(input("This folder key was not sealed by whoever made it, or by a data admin."));
    }
    let seed = custody_secrets(org, ctx.custody_key_version, &custody_seed)?;
    let statement = |sealed: &[u8]| custody_seal_statement(ctx.clone(), sealed.to_vec());
    open_checked(
        &envelope,
        32,
        &ctx.sealer_user_id,
        ctx.roster_version,
        &kind_of(&parts, CUSTODY_SEAL_INFO, &statement)?,
        org,
        &sealer_ml_dsa_public_key,
        seed,
        |key| area_key_commitment(key).is_ok_and(|commitment| commitment == listed),
    )
}

/* The seed, sealed to data admins (2.2) */

const CUSTODY_KEY_SEAL_INFO: &[u8] = b"hushos/group/custody-key-seal/v1";

/// What a data admin's seal of the company seed names.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct CustodyKeySealContext {
    pub group_id: String,
    pub custody_key_version: u64,
    pub holder_user_id: String,
    pub holder_key_version: u64,
    pub sealer_user_id: String,
    pub roster_version: u64,
    pub roster_digest: String,
}

fn custody_key_seal_parts(ctx: &CustodyKeySealContext) -> CoreResult<Vec<Value>> {
    Ok(vec![
        json!("hushos/group/custody-key-seal"),
        json!(1),
        json!(uuid(&ctx.group_id, "group id")?),
        json!(integer(ctx.custody_key_version, "company key version")?),
        json!(uuid(&ctx.holder_user_id, "user id")?),
        json!(integer(ctx.holder_key_version, "key version")?),
        json!(uuid(&ctx.sealer_user_id, "user id")?),
        json!(integer(ctx.roster_version, "roster version")?),
        json!(digest_of(&ctx.roster_digest, "roster digest")?),
    ])
}

/// `["hushos/group/custody-key-seal",1,groupId,custodyKeyVersion,holderUserId,holderKeyVersion,sealerUserId,rosterVersion,rosterDigest,sha256(sealed)]`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn custody_key_seal_statement(ctx: CustodyKeySealContext, sealed: Vec<u8>) -> CoreResult<Vec<u8>> {
    with_digest(custody_key_seal_parts(&ctx)?, &sealed)
}

/* An active data admin on the latest roster, or the creator for version 1 while active: who seals and whose seal opens. */
fn seals_custody_key(chain: &AcceptedRosters, user_id: &str, custody_key_version: u64) -> bool {
    let entry = chain.roster.entry(user_id);
    entry.is_some_and(|entry| entry.active_with(Some(GroupRole::DataAdmin)))
        || (custody_key_version == 1
            && entry.is_some_and(|entry| entry.active_with(None))
            && chain.creator_user_id == user_id)
}

/// Seals the company key's seed to a data admin: the latest company key
/// only, and only the seed whose public keys the chain names; by an active
/// data admin (the creator, for version 1), to an entry active with
/// `DataAdmin` at the exact key version it names, under the ML-KEM key it
/// names by digest.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn custody_key_seal(
    seed: Vec<u8>,
    ctx: CustodyKeySealContext,
    chain: Arc<AcceptedRosters>,
    holder_kem_public_key: Vec<u8>,
    sealer: IdentityKeys,
) -> CoreResult<Vec<u8>> {
    let seed = Zeroizing::new(seed);
    if seed.len() != CUSTODY_SEED_BYTES {
        return Err(input("Invalid company key."));
    }
    let parts = custody_key_seal_parts(&ctx)?;
    let org = company_of(&chain, &ctx.group_id)?;
    sealed_at_latest(&chain, ctx.roster_version, &ctx.roster_digest)?;
    if ctx.custody_key_version != org.custody_keys.len() as u64 {
        return Err(input(NOT_LATEST));
    }
    if !seed_is(&seed, custody_at(org, ctx.custody_key_version)?) {
        return Err(input(NOT_THE_KEY));
    }
    if !seals_custody_key(&chain, &ctx.sealer_user_id, ctx.custody_key_version) {
        return Err(input("The company key is sealed only by a data admin."));
    }
    sealer_holds(&chain, &ctx.sealer_user_id, &sealer)?;
    let holder = chain
        .roster
        .entry(&ctx.holder_user_id)
        .filter(|e| e.active_with(Some(GroupRole::DataAdmin)) && e.key_version == ctx.holder_key_version)
        .ok_or_else(|| input("The company key is sealed only to data admins."))?;
    let recipient = member_recipient(holder, &holder_kem_public_key)?;
    let statement = |sealed: &[u8]| custody_key_seal_statement(ctx.clone(), sealed.to_vec());
    seal_hybrid(
        &seed,
        &recipient,
        &holder_kem_public_key,
        &sealer,
        &kind_of(&parts, CUSTODY_KEY_SEAL_INFO, &statement)?,
    )
}

/// Opens a data admin's seal: the 96-byte company seed. Refused unless it is
/// for this account at this key version, names a roster on the chain and a
/// company key version the chain published, its sealer is an active data
/// admin on the accepted roster (or the creator, for version 1) whose
/// signature holds under their keys through it, and the seed derives exactly
/// the company key the chain names at that version.
#[cfg_attr(feature = "uniffi", uniffi::export)]
#[allow(clippy::too_many_arguments)]
pub fn custody_key_open(
    envelope: Vec<u8>,
    ctx: CustodyKeySealContext,
    chain: Arc<AcceptedRosters>,
    sealer_ml_dsa_public_key: Vec<u8>,
    sealer_history: Option<SignerHistory>,
    reader: String,
    reader_key_version: u64,
    holder: IdentityKeys,
) -> CoreResult<SecretBytes> {
    let parts = custody_key_seal_parts(&ctx)?;
    let org = company_of(&chain, &ctx.group_id)?;
    sealed_on_chain(&chain, ctx.roster_version, &ctx.roster_digest)?;
    if ctx.holder_user_id != reader || ctx.holder_key_version != reader_key_version {
        return Err(input("This company key was not sealed to this account’s keys."));
    }
    let at = custody_at(org, ctx.custody_key_version)?;
    if !seals_custody_key(&chain, &ctx.sealer_user_id, ctx.custody_key_version) {
        return Err(input("This company key was not sealed by a data admin."));
    }
    let signers = signers_through(
        &chain,
        &ctx.sealer_user_id,
        Some(&sealer_ml_dsa_public_key),
        sealer_history.as_ref(),
    )?;
    let statement = |sealed: &[u8]| custody_key_seal_statement(ctx.clone(), sealed.to_vec());
    let seed = SecretBytes::new(open_hybrid(
        &envelope,
        CUSTODY_SEED_BYTES,
        &signers,
        &holder,
        &kind_of(&parts, CUSTODY_KEY_SEAL_INFO, &statement)?,
    )?);
    if !seed_is(&seed, at) {
        return Err(CoreError::Sealed(NOT_THE_KEY.into()));
    }
    Ok(seed)
}

/* The seed, sealed to the kit, and the seal's proof (2.2) */

const KIT_SEAL_INFO: &[u8] = b"hushos/group/kit-seal/v1";
const KIT_SEAL_PROOF_INFO: &[u8] = b"hushos/group/kit-seal-proof/v1";

/// What a kit seal and its proof name.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct KitSealContext {
    pub group_id: String,
    pub custody_key_version: u64,
    pub kit_version: u64,
    pub sealer_user_id: String,
    pub roster_version: u64,
    pub roster_digest: String,
}

fn kit_seal_parts(ctx: &KitSealContext, domain: &str) -> CoreResult<Vec<Value>> {
    Ok(vec![
        json!(domain),
        json!(1),
        json!(uuid(&ctx.group_id, "group id")?),
        json!(integer(ctx.custody_key_version, "company key version")?),
        json!(integer(ctx.kit_version, "recovery kit version")?),
        json!(uuid(&ctx.sealer_user_id, "user id")?),
        json!(integer(ctx.roster_version, "roster version")?),
        json!(digest_of(&ctx.roster_digest, "roster digest")?),
    ])
}

fn kit_seal_proof_parts(ctx: &KitSealContext, kit_seal: &[u8]) -> CoreResult<Vec<Value>> {
    let mut parts = kit_seal_parts(ctx, "hushos/group/kit-seal-proof")?;
    parts.push(json!(digest(kit_seal)));
    Ok(parts)
}

/// `["hushos/group/kit-seal",1,groupId,custodyKeyVersion,kitVersion,sealerUserId,rosterVersion,rosterDigest,sha256(sealed)]`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn kit_seal_statement(ctx: KitSealContext, sealed: Vec<u8>) -> CoreResult<Vec<u8>> {
    with_digest(kit_seal_parts(&ctx, "hushos/group/kit-seal")?, &sealed)
}

/// `["hushos/group/kit-seal-proof",1,groupId,custodyKeyVersion,kitVersion,sealerUserId,rosterVersion,rosterDigest,sha256(kitSeal),sha256(sealed)]`:
/// `kit_seal` is the whole kit seal, its signature included.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn kit_seal_proof_statement(
    ctx: KitSealContext,
    kit_seal: Vec<u8>,
    sealed: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    with_digest(kit_seal_proof_parts(&ctx, &kit_seal)?, &sealed)
}

const NOT_KIT_SEALER: &str =
    "The company key is sealed to the recovery kit by the owner who made the key, on the member list that introduced it.";

/*
 * A kit seal is made on the roster that introduced its company key, by that
 * roster's signer (an Owner: rules 8 and 12), to the kit in force there. A
 * new kit always comes with a new company key (rule 7), so there is no other
 * moment one is made.
 */
fn kit_sealer(org: &OrgChain, ctx: &KitSealContext) -> CoreResult<bool> {
    let key = custody_at(org, ctx.custody_key_version)?;
    kit_at(org, ctx.kit_version)?;
    Ok(key.roster_version == ctx.roster_version
        && key.signer_user_id == ctx.sealer_user_id
        && version_at(org.kit_keys.iter().map(|at| at.roster_version), key.roster_version) == ctx.kit_version)
}

/// A kit seal and its proof, as [`kit_seal`] makes them together.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct KitSeal {
    /// The company seed sealed to the kit's public keys: 4629 bytes.
    pub kit_seal: Vec<u8>,
    /// What lets a data admin check that seal: 4621 bytes.
    pub proof: Vec<u8>,
}

/// Seals the company key's seed to the recovery kit's public keys, and makes
/// the seal's proof: the three values the seal drew (the ephemeral X25519
/// secret, the ML-KEM encapsulation randomness, the nonce), sealed to the
/// company key itself, so every data admin can run the seal again and see
/// that the kit will open to the real seed ([`kit_seal_check`]). The kit need
/// not be present. Only the seed the chain names, at the latest company key
/// and kit, by the signer of the roster that introduced that key.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn kit_seal(
    seed: Vec<u8>,
    ctx: KitSealContext,
    chain: Arc<AcceptedRosters>,
    kit_kem_public_key: Vec<u8>,
    custody_kem_public_key: Vec<u8>,
    sealer: IdentityKeys,
) -> CoreResult<KitSeal> {
    let seed = Zeroizing::new(seed);
    if seed.len() != CUSTODY_SEED_BYTES {
        return Err(input("Invalid company key."));
    }
    let parts = kit_seal_parts(&ctx, "hushos/group/kit-seal")?;
    let org = company_of(&chain, &ctx.group_id)?;
    sealed_at_latest(&chain, ctx.roster_version, &ctx.roster_digest)?;
    if ctx.custody_key_version != org.custody_keys.len() as u64
        || ctx.kit_version != org.kit_keys.len() as u64
    {
        return Err(input(NOT_LATEST));
    }
    let key = custody_at(org, ctx.custody_key_version)?;
    if !seed_is(&seed, key) {
        return Err(input(NOT_THE_KEY));
    }
    if !kit_sealer(org, &ctx)? {
        return Err(input(NOT_KIT_SEALER));
    }
    sealer_holds(&chain, &ctx.sealer_user_id, &sealer)?;
    let kit = kit_at(org, ctx.kit_version)?;
    let to_kit =
        listed_recipient(&kit.encryption_public_key, &kit.kem_public_key_digest, &kit_kem_public_key)?;
    let to_company =
        listed_recipient(&key.encryption_public_key, &key.kem_public_key_digest, &custody_kem_public_key)?;
    let coins = Zeroizing::new(random(SEAL_COINS_BYTES));
    let statement = |sealed: &[u8]| kit_seal_statement(ctx.clone(), sealed.to_vec());
    let kit_seal = seal_with_coins(
        &seed,
        &to_kit,
        &kit_kem_public_key,
        &sealer,
        &kind_of(&parts, KIT_SEAL_INFO, &statement)?,
        &coins,
    )?;
    let proof_statement =
        |sealed: &[u8]| kit_seal_proof_statement(ctx.clone(), kit_seal.clone(), sealed.to_vec());
    let proof = seal_hybrid(
        &coins,
        &to_company,
        &custody_kem_public_key,
        &sealer,
        &kind_of(&kit_seal_proof_parts(&ctx, &kit_seal)?, KIT_SEAL_PROOF_INFO, &proof_statement)?,
    )?;
    Ok(KitSeal { kit_seal, proof })
}

/* What a kit seal's context must say on any chain that holds it. */
fn kit_seal_on_chain<'a>(chain: &'a Arc<AcceptedRosters>, ctx: &KitSealContext) -> CoreResult<&'a OrgChain> {
    let org = company_of(chain, &ctx.group_id)?;
    sealed_on_chain(chain, ctx.roster_version, &ctx.roster_digest)?;
    if !kit_sealer(org, ctx)? {
        return Err(input(NOT_KIT_SEALER));
    }
    Ok(org)
}

/// A data admin's check that the kit will open to the company key (2.2,
/// "Proving a kit seal"): nobody can open a kit seal without the kit, so the
/// device opens the proof with the company seed it holds, runs the kit seal
/// again with the three values inside and that seed as the plaintext, and
/// compares everything before the signature (1,256 bytes) with the stored
/// seal. Refused unless both the seal and its proof are signed by the Owner
/// the chain entitles and `custody_seed` is the chain's key at the version
/// named. Then whether it holds ([`KitSealCheck`]): `Bad` when the proof does
/// not open or the seal is not the one those values make. The fix is a new
/// kit.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn kit_seal_check(
    kit_seal: Vec<u8>,
    proof: Vec<u8>,
    ctx: KitSealContext,
    chain: Arc<AcceptedRosters>,
    kit_kem_public_key: Vec<u8>,
    sealer_ml_dsa_public_key: Vec<u8>,
    custody_seed: Vec<u8>,
) -> CoreResult<KitSealCheck> {
    let custody_seed = Zeroizing::new(custody_seed);
    let parts = kit_seal_parts(&ctx, "hushos/group/kit-seal")?;
    let org = kit_seal_on_chain(&chain, &ctx)?;
    let statement = |sealed: &[u8]| kit_seal_statement(ctx.clone(), sealed.to_vec());
    let kind = kind_of(&parts, KIT_SEAL_INFO, &statement)?;
    let (signer, current) =
        signer_at(org, &ctx.sealer_user_id, ctx.roster_version, &sealer_ml_dsa_public_key)?;
    require_sealed_by(&kit_seal, CUSTODY_SEED_BYTES, &[signer], &kind)?;
    let kit = kit_at(org, ctx.kit_version)?;
    let to_kit =
        listed_recipient(&kit.encryption_public_key, &kit.kem_public_key_digest, &kit_kem_public_key)?;
    let seed = custody_secrets(org, ctx.custody_key_version, &custody_seed)?;
    let proof_statement =
        |sealed: &[u8]| kit_seal_proof_statement(ctx.clone(), kit_seal.clone(), sealed.to_vec());
    let coins = open_checked(
        &proof,
        SEAL_COINS_BYTES,
        &ctx.sealer_user_id,
        ctx.roster_version,
        &kind_of(&kit_seal_proof_parts(&ctx, &kit_seal)?, KIT_SEAL_PROOF_INFO, &proof_statement)?,
        org,
        &sealer_ml_dsa_public_key,
        seed,
        |_| true,
    )?;
    // (The proof was signed under the same keys as the seal: `current` is one answer for both.)
    let bad = KitSealCheck::Bad { sealer_user_id: current.then(|| ctx.sealer_user_id.clone()) };
    let coins = match coins {
        SealCheck::Opened { value } | SealCheck::Unattributed { value } => value,
        SealCheck::Bad { .. } => return Ok(bad),
    };
    let again = Zeroizing::new(sealed_with_coins(seed, &to_kit, &kit_kem_public_key, &kind, &coins)?);
    let sealed = &kit_seal[..hybrid_sealed_bytes(CUSTODY_SEED_BYTES)];
    Ok(if !same_bytes(&again, sealed) {
        bad
    } else if current {
        KitSealCheck::Holds
    } else {
        KitSealCheck::Unattributed
    })
}

/// Opens the kit seal with the recovery kit: the company seed. Refused unless
/// the kit's secret derives exactly the kit the chain names at the version
/// the seal names (another company's kit, or one a later roster replaced,
/// opens nothing), the seal is the entitled Owner's, and the seed derives the
/// company key the chain names at its version.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn kit_seal_open(
    kit_seal: Vec<u8>,
    ctx: KitSealContext,
    chain: Arc<AcceptedRosters>,
    sealer_ml_dsa_public_key: Vec<u8>,
    kit_secret: Vec<u8>,
) -> CoreResult<SecretBytes> {
    let kit_secret = Zeroizing::new(kit_secret);
    let parts = kit_seal_parts(&ctx, "hushos/group/kit-seal")?;
    let org = kit_seal_on_chain(&chain, &ctx)?;
    let seeds = kit_seed(&kit_secret, &ctx.group_id)?;
    let listed = kit_at(org, ctx.kit_version)?;
    let derived = sealing_public_key(&seeds[..96], "recovery kit")?;
    if derived.encryption_public_key != listed.encryption_public_key
        || digest(&decode("kemPublicKey", &derived.kem_public_key, None)?) != listed.kem_public_key_digest
    {
        return Err(input(NOT_THE_KIT));
    }
    let (signer, _) = signer_at(org, &ctx.sealer_user_id, ctx.roster_version, &sealer_ml_dsa_public_key)?;
    let signers = [signer];
    let statement = |sealed: &[u8]| kit_seal_statement(ctx.clone(), sealed.to_vec());
    let seed = SecretBytes::new(open_hybrid_with(
        &kit_seal,
        CUSTODY_SEED_BYTES,
        &signers,
        &seeds[..32],
        &seeds[32..96],
        &kind_of(&parts, KIT_SEAL_INFO, &statement)?,
    )?);
    if !seed_is(&seed, custody_at(org, ctx.custody_key_version)?) {
        return Err(CoreError::Sealed(NOT_THE_KEY.into()));
    }
    Ok(seed)
}

/* The group key's escrow (2.2) */

const KEY_ESCROW_INFO: &[u8] = b"hushos/group/key-escrow/v1";

/// What the group key's escrow names.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct KeyEscrowContext {
    pub group_id: String,
    pub group_key_version: u64,
    pub custody_key_version: u64,
    pub sealer_user_id: String,
    pub roster_version: u64,
    pub roster_digest: String,
}

fn key_escrow_parts(ctx: &KeyEscrowContext) -> CoreResult<Vec<Value>> {
    Ok(vec![
        json!("hushos/group/key-escrow"),
        json!(1),
        json!(uuid(&ctx.group_id, "group id")?),
        json!(integer(ctx.group_key_version, "group key version")?),
        json!(integer(ctx.custody_key_version, "company key version")?),
        json!(uuid(&ctx.sealer_user_id, "user id")?),
        json!(integer(ctx.roster_version, "roster version")?),
        json!(digest_of(&ctx.roster_digest, "roster digest")?),
    ])
}

/// `["hushos/group/key-escrow",1,groupId,groupKeyVersion,custodyKeyVersion,sealerUserId,rosterVersion,rosterDigest,sha256(sealed)]`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn key_escrow_statement(ctx: KeyEscrowContext, sealed: Vec<u8>) -> CoreResult<Vec<u8>> {
    with_digest(key_escrow_parts(&ctx)?, &sealed)
}

const NOT_ESCROW_SEALER: &str = "The group key is sealed to the company key by the owner who made either.";

/*
 * Who makes an escrow (2.2): the signer of the call that made the group key
 * or the company key it joins. The creator for the first of each; the signer
 * of the succession into that group key; the signer of the roster that
 * introduced that company key. Each is an Owner (rule 12), and must have held
 * `data_admin` on the roster the escrow names: the chain guards the keys of
 * an entry only while it holds a role, so "who made the key" alone would let
 * keys written later into an entry its Owner left sign an escrow in that
 * Owner's name.
 */
fn escrow_sealer(chain: &AcceptedRosters, org: &OrgChain, ctx: &KeyEscrowContext) -> CoreResult<bool> {
    let key = custody_at(org, ctx.custody_key_version)?;
    integer(ctx.group_key_version, "group key version")?;
    let index = usize::try_from(ctx.group_key_version - 1).unwrap_or(usize::MAX);
    if chain.group_keys.get(index).is_none() {
        return Err(input("This group key is not one the group has published."));
    }
    let into = index.checked_sub(1).and_then(|at| chain.cache.successions.get(at));
    let made = (ctx.group_key_version == 1
        && ctx.custody_key_version == 1
        && ctx.sealer_user_id == chain.creator_user_id)
        || into.is_some_and(|into| into.signer_user_id == ctx.sealer_user_id)
        || (ctx.custody_key_version > 1 && key.signer_user_id == ctx.sealer_user_id);
    Ok(made && was_data_admin(org, &ctx.sealer_user_id, ctx.roster_version))
}

fn group_seed_is(seed: &[u8], chain: &AcceptedRosters, group_key_version: u64) -> bool {
    usize::try_from(group_key_version.wrapping_sub(1))
        .ok()
        .and_then(|index| chain.group_keys.get(index))
        .is_some_and(|key| group_public_key(seed.to_vec()).is_ok_and(|derived| derived == *key))
}

/// Seals the group key's seed to the company key, so the kit restores
/// management as well as files: the current group key (the seed must be the
/// chain's) to the latest company key, by the signer of the call that made
/// either.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn key_escrow_seal(
    group_seed: Vec<u8>,
    ctx: KeyEscrowContext,
    chain: Arc<AcceptedRosters>,
    custody_kem_public_key: Vec<u8>,
    sealer: IdentityKeys,
) -> CoreResult<Vec<u8>> {
    let group_seed = Zeroizing::new(group_seed);
    if group_seed.len() != GROUP_SEED_BYTES {
        return Err(input("Invalid group key."));
    }
    let parts = key_escrow_parts(&ctx)?;
    let org = company_of(&chain, &ctx.group_id)?;
    sealed_at_latest(&chain, ctx.roster_version, &ctx.roster_digest)?;
    if ctx.custody_key_version != org.custody_keys.len() as u64
        || ctx.group_key_version != chain.group_key_version
    {
        return Err(input(NOT_LATEST));
    }
    if !escrow_sealer(&chain, org, &ctx)?
        || !chain.roster.entry(&ctx.sealer_user_id).is_some_and(|entry| entry.active_with(None))
    {
        return Err(input(NOT_ESCROW_SEALER));
    }
    if !group_seed_is(&group_seed, &chain, ctx.group_key_version) {
        return Err(input("This group key is not the group’s published key."));
    }
    sealer_holds(&chain, &ctx.sealer_user_id, &sealer)?;
    let key = custody_at(org, ctx.custody_key_version)?;
    let recipient =
        listed_recipient(&key.encryption_public_key, &key.kem_public_key_digest, &custody_kem_public_key)?;
    let statement = |sealed: &[u8]| key_escrow_statement(ctx.clone(), sealed.to_vec());
    seal_hybrid(
        &group_seed,
        &recipient,
        &custody_kem_public_key,
        &sealer,
        &kind_of(&parts, KEY_ESCROW_INFO, &statement)?,
    )
}

/// Opens the escrow with the company key: the group seed. Refused unless it
/// names this company, a roster on the chain, versions the chain published
/// and a sealer who made one of them and held `DataAdmin` on the roster
/// named, signed under the keys their entry named there; `custody_seed` must
/// be the chain's company key at the version named. Then the seed, or
/// `Bad` with the sealer when it does not open or its public keys are not the
/// chain's group key at that version.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn key_escrow_open(
    envelope: Vec<u8>,
    ctx: KeyEscrowContext,
    chain: Arc<AcceptedRosters>,
    sealer_ml_dsa_public_key: Vec<u8>,
    custody_seed: Vec<u8>,
) -> CoreResult<SealCheck> {
    let custody_seed = Zeroizing::new(custody_seed);
    let parts = key_escrow_parts(&ctx)?;
    let org = company_of(&chain, &ctx.group_id)?;
    sealed_on_chain(&chain, ctx.roster_version, &ctx.roster_digest)?;
    if !escrow_sealer(&chain, org, &ctx)? {
        return Err(input(NOT_ESCROW_SEALER));
    }
    let seed = custody_secrets(org, ctx.custody_key_version, &custody_seed)?;
    let statement = |sealed: &[u8]| key_escrow_statement(ctx.clone(), sealed.to_vec());
    open_checked(
        &envelope,
        GROUP_SEED_BYTES,
        &ctx.sealer_user_id,
        ctx.roster_version,
        &kind_of(&parts, KEY_ESCROW_INFO, &statement)?,
        org,
        &sealer_ml_dsa_public_key,
        seed,
        |group_seed| group_seed_is(group_seed, &chain, ctx.group_key_version),
    )
}

/* previousEnvelope: the old seed, sealed to the new company key (2.2) */

const CUSTODY_PREVIOUS_INFO: &[u8] = b"hushos/group/custody-previous/v1";

/// What `previousEnvelope` names: the new company key version and the one it
/// replaces (always the version before).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct CustodyPreviousContext {
    pub group_id: String,
    pub custody_key_version: u64,
    pub previous_version: u64,
    pub sealer_user_id: String,
    pub roster_version: u64,
    pub roster_digest: String,
}

fn custody_previous_parts(ctx: &CustodyPreviousContext) -> CoreResult<Vec<Value>> {
    let version = integer(ctx.custody_key_version, "company key version")?;
    // Always the version before: each replacement wraps the one it replaces.
    if integer(ctx.previous_version, "company key version")? != version - 1 {
        return Err(input("Invalid company key version."));
    }
    Ok(vec![
        json!("hushos/group/custody-previous"),
        json!(1),
        json!(uuid(&ctx.group_id, "group id")?),
        json!(version),
        json!(ctx.previous_version),
        json!(uuid(&ctx.sealer_user_id, "user id")?),
        json!(integer(ctx.roster_version, "roster version")?),
        json!(digest_of(&ctx.roster_digest, "roster digest")?),
    ])
}

/// `["hushos/group/custody-previous",1,groupId,custodyKeyVersion,previousVersion,sealerUserId,rosterVersion,rosterDigest,sha256(sealed)]`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn custody_previous_statement(ctx: CustodyPreviousContext, sealed: Vec<u8>) -> CoreResult<Vec<u8>> {
    with_digest(custody_previous_parts(&ctx)?, &sealed)
}

const NOT_PREVIOUS_SEALER: &str =
    "The earlier company key is sealed to the new one by the owner who replaced it.";

/* previousEnvelope is made on the roster that introduced the new company key, by its signer. */
fn previous_sealer(org: &OrgChain, ctx: &CustodyPreviousContext) -> CoreResult<bool> {
    let key = custody_at(org, ctx.custody_key_version)?;
    Ok(key.roster_version == ctx.roster_version && key.signer_user_id == ctx.sealer_user_id)
}

/// Seals the previous company seed to the new company key, on the roster
/// that replaces it, so later data admins still open earlier seals: only the
/// seed the chain names at the version before, to the latest key, by that
/// roster's signer.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn custody_previous_seal(
    previous_seed: Vec<u8>,
    ctx: CustodyPreviousContext,
    chain: Arc<AcceptedRosters>,
    custody_kem_public_key: Vec<u8>,
    sealer: IdentityKeys,
) -> CoreResult<Vec<u8>> {
    let previous_seed = Zeroizing::new(previous_seed);
    if previous_seed.len() != CUSTODY_SEED_BYTES {
        return Err(input("Invalid company key."));
    }
    let parts = custody_previous_parts(&ctx)?;
    let org = company_of(&chain, &ctx.group_id)?;
    sealed_at_latest(&chain, ctx.roster_version, &ctx.roster_digest)?;
    if ctx.custody_key_version != org.custody_keys.len() as u64 {
        return Err(input(NOT_LATEST));
    }
    if !previous_sealer(org, &ctx)? {
        return Err(input(NOT_PREVIOUS_SEALER));
    }
    if !seed_is(&previous_seed, custody_at(org, ctx.previous_version)?) {
        return Err(input(NOT_THE_KEY));
    }
    sealer_holds(&chain, &ctx.sealer_user_id, &sealer)?;
    let key = custody_at(org, ctx.custody_key_version)?;
    let recipient =
        listed_recipient(&key.encryption_public_key, &key.kem_public_key_digest, &custody_kem_public_key)?;
    let statement = |sealed: &[u8]| custody_previous_statement(ctx.clone(), sealed.to_vec());
    seal_hybrid(
        &previous_seed,
        &recipient,
        &custody_kem_public_key,
        &sealer,
        &kind_of(&parts, CUSTODY_PREVIOUS_INFO, &statement)?,
    )
}

/// Opens `previousEnvelope` with the company key it is sealed to: the seed of
/// the version before, so a data admin walks back from the key they hold.
/// Refused unless it is the replacing Owner's, on the roster that introduced
/// the key; then the seed, or `Bad` with the sealer when it does not open or
/// its public keys are not the chain's company key at the previous version.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn custody_previous_open(
    envelope: Vec<u8>,
    ctx: CustodyPreviousContext,
    chain: Arc<AcceptedRosters>,
    sealer_ml_dsa_public_key: Vec<u8>,
    custody_seed: Vec<u8>,
) -> CoreResult<SealCheck> {
    let custody_seed = Zeroizing::new(custody_seed);
    let parts = custody_previous_parts(&ctx)?;
    let org = company_of(&chain, &ctx.group_id)?;
    sealed_on_chain(&chain, ctx.roster_version, &ctx.roster_digest)?;
    if !previous_sealer(org, &ctx)? {
        return Err(input(NOT_PREVIOUS_SEALER));
    }
    let before = custody_at(org, ctx.previous_version)?;
    let seed = custody_secrets(org, ctx.custody_key_version, &custody_seed)?;
    let statement = |sealed: &[u8]| custody_previous_statement(ctx.clone(), sealed.to_vec());
    open_checked(
        &envelope,
        CUSTODY_SEED_BYTES,
        &ctx.sealer_user_id,
        ctx.roster_version,
        &kind_of(&parts, CUSTODY_PREVIOUS_INFO, &statement)?,
        org,
        &sealer_ml_dsa_public_key,
        seed,
        |previous| seed_is(previous, before),
    )
}

/* Using the kit: the request (2.2) */

/// A request to use the recovery kit.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RecoveryRequest {
    pub group_id: String,
    pub requester_user_id: String,
    pub requester_key_version: u64,
    pub kit_version: u64,
    pub custody_key_version: u64,
    pub roster_version: u64,
    pub roster_digest: String,
    /// A 24-character UTC time, as a pin's `checked_at`.
    pub requested_at: String,
}

const RECOVERY_REQUEST_DOMAIN: &str = "hushos/group/recovery-request";

/// `["hushos/group/recovery-request",1,groupId,requesterUserId,requesterKeyVersion,kitVersion,custodyKeyVersion,rosterVersion,rosterDigest,requestedAt]`
///
/// ```
/// use hushos_core::*;
/// let request = RecoveryRequest {
///     group_id: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".into(),
///     requester_user_id: "00000005-abcd-4abc-8abc-abcdefabcdef".into(),
///     requester_key_version: 1,
///     kit_version: 1,
///     custody_key_version: 1,
///     roster_version: 2,
///     roster_digest: roster_digest(b"a roster".to_vec()),
///     requested_at: "2026-11-03T09:00:00.000Z".into(),
/// };
/// let statement = recovery_request_statement(request.clone())?;
/// assert_eq!(recovery_request_parse(statement)?, request);
/// // A time out of form is no request.
/// assert!(recovery_request_statement(RecoveryRequest { requested_at: "3 November".into(), ..request }).is_err());
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn recovery_request_statement(request: RecoveryRequest) -> CoreResult<Vec<u8>> {
    recovery_request_bytes(&request)
}

fn recovery_request_bytes(request: &RecoveryRequest) -> CoreResult<Vec<u8>> {
    check_time(&request.requested_at).map_err(|_| input("Invalid recovery request."))?;
    encode_statement(&[
        json!(RECOVERY_REQUEST_DOMAIN),
        json!(1),
        json!(uuid(&request.group_id, "group id")?),
        json!(uuid(&request.requester_user_id, "user id")?),
        json!(integer(request.requester_key_version, "key version")?),
        json!(integer(request.kit_version, "recovery kit version")?),
        json!(integer(request.custody_key_version, "company key version")?),
        json!(integer(request.roster_version, "roster version")?),
        json!(digest_of(&request.roster_digest, "roster digest")?),
        json!(request.requested_at),
    ])
}

/// The request a statement's bytes hold, refused unless the bytes are its
/// canonical encoding.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn recovery_request_parse(statement: Vec<u8>) -> CoreResult<RecoveryRequest> {
    let parts = parse_statement(&statement, "recovery request")?;
    if parts.len() != 10 || parts[0] != json!(RECOVERY_REQUEST_DOMAIN) || parts[1] != json!(1) {
        return Err(input("Invalid recovery request."));
    }
    let request = RecoveryRequest {
        group_id: text(&parts[2], "group id")?.into(),
        requester_user_id: text(&parts[3], "user id")?.into(),
        requester_key_version: number(&parts[4], "key version")?,
        kit_version: number(&parts[5], "recovery kit version")?,
        custody_key_version: number(&parts[6], "company key version")?,
        roster_version: number(&parts[7], "roster version")?,
        roster_digest: text(&parts[8], "roster digest")?.into(),
        requested_at: text(&parts[9], "recovery request")?.into(),
    };
    require_canonical(&statement, &recovery_request_bytes(&request)?, "recovery request")?;
    Ok(request)
}

const NOT_A_HOLDER: &str = "Only someone who can use the recovery kit asks to use it.";

/* What a request must say on a chain: an active `Recovery` holder's own keys, and the kit and company key now. */
fn request_holds(chain: &AcceptedRosters, org: &OrgChain, request: &RecoveryRequest) -> bool {
    chain.roster.entry(&request.requester_user_id).is_some_and(|entry| {
        entry.active_with(Some(GroupRole::Recovery)) && entry.key_version == request.requester_key_version
    }) && request.kit_version == org.kit_keys.len() as u64
        && request.custody_key_version == org.custody_keys.len() as u64
}

/// A signed request to use the kit: its statement and the requester's hybrid
/// identity signature (3373 bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SignedRecoveryRequest {
    pub statement: Vec<u8>,
    pub signature: Vec<u8>,
}

/// Signs a request to use the recovery kit with the requester's hybrid
/// identity signature: only for an active `Recovery` holder, at the keys
/// their entry names, for the kit and company key the chain has now, naming
/// their latest accepted roster.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn recovery_request_sign(
    request: RecoveryRequest,
    chain: Arc<AcceptedRosters>,
    signer: IdentityKeys,
) -> CoreResult<SignedRecoveryRequest> {
    let statement = recovery_request_bytes(&request)?;
    let org = company_of(&chain, &request.group_id)?;
    sealed_at_latest(&chain, request.roster_version, &request.roster_digest)?;
    if !request_holds(&chain, org, &request) {
        return Err(input(NOT_A_HOLDER));
    }
    sealer_holds(&chain, &request.requester_user_id, &signer)?;
    let signature = sign_hybrid(&signer.signing_seed, &signer.ml_dsa_seed, &statement)?;
    Ok(SignedRecoveryRequest { statement, signature })
}

/// A request as every member's device and the server take it: the bytes
/// canonical, for this company, naming a roster on the chain, from an entry
/// that holds `Recovery` at the key version named, for the kit and company
/// key the chain has now, and signed under that entry's keys (the served
/// ML-DSA key only if the entry names it). Anything else is refused.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn recovery_request_verify(
    statement: Vec<u8>,
    signature: Vec<u8>,
    chain: Arc<AcceptedRosters>,
    requester_ml_dsa_public_key: Vec<u8>,
) -> CoreResult<RecoveryRequest> {
    let request = recovery_request_parse(statement.clone())?;
    let org = company_of(&chain, &request.group_id)?;
    sealed_on_chain(&chain, request.roster_version, &request.roster_digest)?;
    if !request_holds(&chain, org, &request) {
        return Err(input(NOT_A_HOLDER));
    }
    let entry = chain.roster.entry(&request.requester_user_id).ok_or_else(|| input(NOT_A_HOLDER))?;
    let unsigned = || input("This request is not signed by the member it names.");
    if signature.len() != HYBRID_SIGNATURE_BYTES
        || requester_ml_dsa_public_key.len() != ML_DSA_PUBLIC_KEY_BYTES
        || digest(&requester_ml_dsa_public_key) != entry.ml_dsa_public_key_digest
    {
        return Err(unsigned());
    }
    let keys = HybridPublicKey {
        signing_public_key: decode("signingPublicKey", &entry.signing_public_key, Some(32))?,
        ml_dsa_public_key: requester_ml_dsa_public_key,
    };
    if !verify_hybrid(&keys, &statement, &signature) {
        return Err(unsigned());
    }
    Ok(request)
}

/* A folder's notice keys (3.7) */

/// The seed of a folder's notice keys at a key version (companies-design 3.7):
/// `HKDF-SHA-256(ikm = areaKey, salt = 32 zero bytes, info = "hushos/group/browse-notice/v2" || groupId || workspaceId, 96)`,
/// an X25519 secret (32) then an ML-KEM-768 seed (64). Everyone who holds the
/// folder key derives the same pair, and nobody else does.
///
/// ```
/// use hushos_core::*;
/// let (group, area) = ("0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a", "80558a81-8dfc-8914-8447-0417b55e2ec5");
/// let seed = notice_seed(vec![5; 32], group.into(), area.into())?;
/// assert_eq!(seed.len(), 96);
/// assert_eq!(notice_seed(vec![5; 32], group.into(), area.into())?, seed.to_vec());
/// assert_ne!(notice_seed(vec![6; 32], group.into(), area.into())?, seed.to_vec());
/// let keys = notice_public_keys(seed.to_vec())?;
/// assert_eq!(base64url_decode(keys.kem_public_key)?.len(), 1184);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn notice_seed(area_key: Vec<u8>, group_id: String, workspace_id: String) -> CoreResult<SecretBytes> {
    let area_key = Zeroizing::new(area_key);
    if area_key.len() != 32 {
        return Err(input("Invalid workspace key."));
    }
    let mut info = b"hushos/group/browse-notice/v2".to_vec();
    info.extend_from_slice(uuid(&group_id, "group id")?.as_bytes());
    info.extend_from_slice(uuid(&workspace_id, "workspace id")?.as_bytes());
    Ok(SecretBytes::new(hkdf(&area_key, &info, NOTICE_SEED_BYTES)?.to_vec()))
}

/// A folder's two notice public keys from its notice seed: what whoever makes
/// a folder key sends with it, and every holder derives and compares.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn notice_public_keys(seed: Vec<u8>) -> CoreResult<CustodyPublicKey> {
    let seed = Zeroizing::new(seed);
    sealing_public_key(&seed, "notice seed")
}

/// What the wrapped previous notice seed is bound to: the folder, and the key
/// versions it leads from and to (`from_version` is the one before).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct PreviousNoticeSeedContext {
    pub group_id: String,
    pub workspace_id: String,
    pub to_version: u64,
    pub from_version: u64,
}

/* ["hushos/group/browse-notice-key",2,groupId,workspaceId,toVersion,fromVersion] */
fn previous_notice_context(ctx: &PreviousNoticeSeedContext) -> CoreResult<Vec<u8>> {
    let to = integer(ctx.to_version, "workspace key version")?;
    if integer(ctx.from_version, "workspace key version")? != to - 1 {
        return Err(input("Invalid workspace key version."));
    }
    encode_statement(&[
        json!("hushos/group/browse-notice-key"),
        json!(2),
        json!(uuid(&ctx.group_id, "group id")?),
        json!(uuid(&ctx.workspace_id, "workspace id")?),
        json!(to),
        json!(ctx.from_version),
    ])
}

/* HKDF-SHA-256(ikm = noticeSeed(toVersion), salt = 32 zero bytes, info = "hushos/group/browse-notice-key/v2", 32) */
fn previous_notice_key(seed: &[u8]) -> CoreResult<Zeroizing<Vec<u8>>> {
    if seed.len() != NOTICE_SEED_BYTES {
        return Err(input("Invalid notice seed."));
    }
    hkdf(seed, b"hushos/group/browse-notice-key/v2", 32)
}

/// `previousNoticeSeed` (3.7, "Through a key change"): the notice seed of the
/// version before, wrapped under a key derived from the new one, so someone
/// who holds only the current folder key reads earlier notices by walking
/// back. 136 bytes: a 24-byte nonce, then XChaCha20-Poly1305 of the seed with
/// `["hushos/group/browse-notice-key",2,groupId,workspaceId,toVersion,fromVersion]`
/// as associated data.
///
/// ```
/// use hushos_core::*;
/// let (group, area) = ("0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a", "80558a81-8dfc-8914-8447-0417b55e2ec5");
/// let before = notice_seed(vec![5; 32], group.into(), area.into())?;
/// let after = notice_seed(vec![6; 32], group.into(), area.into())?;
/// let ctx = PreviousNoticeSeedContext { group_id: group.into(), workspace_id: area.into(), to_version: 2, from_version: 1 };
/// let wrapped = previous_notice_seed_wrap(before.to_vec(), after.to_vec(), ctx.clone())?;
/// assert_eq!(wrapped.len(), 136);
/// assert_eq!(previous_notice_seed_open(wrapped.clone(), after.to_vec(), ctx.clone())?, before.to_vec());
/// // Under the old seed, or for another pair of versions, it opens as nothing.
/// assert!(previous_notice_seed_open(wrapped.clone(), before.to_vec(), ctx.clone()).is_err());
/// let other = PreviousNoticeSeedContext { to_version: 3, from_version: 2, ..ctx };
/// assert!(previous_notice_seed_open(wrapped, after.to_vec(), other).is_err());
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn previous_notice_seed_wrap(
    previous_seed: Vec<u8>,
    seed: Vec<u8>,
    ctx: PreviousNoticeSeedContext,
) -> CoreResult<Vec<u8>> {
    let (previous_seed, seed) = (Zeroizing::new(previous_seed), Zeroizing::new(seed));
    if previous_seed.len() != NOTICE_SEED_BYTES {
        return Err(input("Invalid notice seed."));
    }
    let context = previous_notice_context(&ctx)?;
    let key = previous_notice_key(&seed)?;
    let mut wrapped = random(NONCE_BYTES);
    let body = seal_with_nonce(&key, &wrapped, &previous_seed, &context)?;
    wrapped.extend(body);
    Ok(wrapped)
}

/// Opens `previousNoticeSeed` with the notice seed of the version it was
/// wrapped under: the notice seed of the version before.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn previous_notice_seed_open(
    wrapped: Vec<u8>,
    seed: Vec<u8>,
    ctx: PreviousNoticeSeedContext,
) -> CoreResult<SecretBytes> {
    let seed = Zeroizing::new(seed);
    let context = previous_notice_context(&ctx)?;
    if wrapped.len() != PREVIOUS_NOTICE_SEED_BYTES {
        return Err(input("Invalid notice seed."));
    }
    let key = previous_notice_key(&seed)?;
    let (nonce, body) = wrapped.split_at(NONCE_BYTES);
    Ok(SecretBytes::new(open_with_nonce(&key, nonce, body, &context)?))
}

#[cfg(test)]
const _: () = {
    use crate::shares::hybrid_seal_bytes;
    assert!(hybrid_seal_bytes(32) == 4565);
    assert!(hybrid_seal_bytes(CUSTODY_SEED_BYTES) == 4629);
    assert!(hybrid_seal_bytes(SEAL_COINS_BYTES) == 4621);
    assert!(hybrid_seal_bytes(GROUP_SEED_BYTES) == 4597);
    assert!(hybrid_sealed_bytes(CUSTODY_SEED_BYTES) == 1256);
    assert!(PREVIOUS_NOTICE_SEED_BYTES == 136);
};
