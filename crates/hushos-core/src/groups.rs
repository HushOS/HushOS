//! The group core's cryptography (docs/groups-design.md 2), as
//! `packages/crypto/groups.ts` makes it: the group key and its signatures,
//! the group fingerprint, the roster and key succession statements, and the
//! two seals of milestone 1 (the group key to its holders, an area's workspace
//! key to a member; guardian seals come later). Every statement is version 1
//! and hybrid from its first byte, in the canonical encoding of `canonical.rs`,
//! and the shared group fixtures pin the bytes to the web's. What a reader
//! accepts as a chain of rosters, and what it shows for a record, is
//! `group_trust.rs`.

use crate::bytes::{decode, encode, SecretBytes};
use crate::canonical::{
    ascending, bytes_of, digest_of, encode_statement, integer, number, parse_statement, require_canonical,
    text, uuid,
};
use crate::contacts::digest_hex;
use crate::error::{input, CoreError, CoreResult};
use crate::group_trust::AcceptedRosters;
use crate::identity::{IdentityKeys, PinnedKeys, ServedKeys, SuccessionLink, KEM_PUBLIC_KEY_BYTES};
use crate::ids::{check_id, IdKind};
use crate::pq::{
    ml_dsa_public_key, ml_dsa_sign, ml_dsa_verify, ML_DSA_PUBLIC_KEY_BYTES, ML_DSA_SIGNATURE_BYTES,
};
use crate::shares::{open_hybrid, seal_hybrid, SealKind};
use crate::signatures::{
    digest, sign, sign_hybrid, signing_public_key, verify, verify_hybrid, HybridPublicKey, SIGNATURE_BYTES,
};
use crate::succession_path::{succession_path, SuccessionPath, VerifiedLinks};
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use zeroize::Zeroizing;

/* 32 bytes of Ed25519 seed, then 32 of ML-DSA-65 key generation seed (ξ). */
pub(crate) const GROUP_SEED_BYTES: usize = 64;
/*
 * The FIPS 204 context of the group key's ML-DSA half. A person's identity
 * signs under `hushos/identity/v1`, so neither key's signature can stand in
 * for the other's.
 */
pub(crate) const GROUP_SIGNATURE_CONTEXT: &[u8] = b"hushos/group/v1";

/// The group key's public halves, base64url as statements and the server carry them.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct GroupPublicKey {
    pub ed25519_public_key: String,
    pub ml_dsa_public_key: String,
}

/// A group signature, as the API carries it (`{ ed25519, mlDsa }`): valid only if both verify.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct GroupSignature {
    /// 64 bytes.
    pub ed25519: Vec<u8>,
    /// 3309 bytes, under the context `hushos/group/v1`.
    pub ml_dsa: Vec<u8>,
}

/// A roster or succession as the server stores it: its statement, the group
/// signature, and the signer's hybrid identity signature (3373 bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SignedGroupStatement {
    pub statement: Vec<u8>,
    pub signature: GroupSignature,
    pub signer_signature: Vec<u8>,
}

fn group_seed(seed: &[u8]) -> CoreResult<()> {
    if seed.len() != GROUP_SEED_BYTES {
        return Err(input("Invalid group key."));
    }
    Ok(())
}

/// A fresh group key seed: made once, on the creating device, and then only ever sealed.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn group_seed_create() -> SecretBytes {
    SecretBytes::new(crate::bytes::random(GROUP_SEED_BYTES))
}

/// The group key a 64-byte seed expands to: Ed25519 from its first half,
/// ML-DSA-65 from its second.
///
/// ```
/// use hushos_core::*;
/// let seed = group_seed_create();
/// let key = group_public_key(seed.to_vec())?;
/// let message = b"statement".to_vec();
/// let signature = group_sign(seed.to_vec(), message.clone())?;
/// assert!(group_verify(key.clone(), message.clone(), signature.clone()));
/// // Both halves, always: the ML-DSA half alone is not a group signature.
/// let half = GroupSignature { ed25519: vec![0; 64], ..signature };
/// assert!(!group_verify(key, message, half));
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn group_public_key(seed: Vec<u8>) -> CoreResult<GroupPublicKey> {
    let seed = Zeroizing::new(seed);
    group_seed(&seed)?;
    Ok(GroupPublicKey {
        ed25519_public_key: encode(&signing_public_key(seed[..32].to_vec())?),
        ml_dsa_public_key: encode(&ml_dsa_public_key(&seed[32..])?),
    })
}

/// Signs `message` with the group key: Ed25519 and ML-DSA-65 (hedged, context
/// `hushos/group/v1`) over the same bytes.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn group_sign(seed: Vec<u8>, message: Vec<u8>) -> CoreResult<GroupSignature> {
    let seed = Zeroizing::new(seed);
    group_seed(&seed)?;
    Ok(GroupSignature {
        ed25519: sign(&seed[..32], &message)?,
        ml_dsa: ml_dsa_sign(&seed[32..], &message, GROUP_SIGNATURE_CONTEXT)?,
    })
}

/// Whether both halves of `signature` hold under the group key `key`. A
/// classical adversary must forge the ML-DSA half too, a quantum one the
/// Ed25519 half; anything malformed is simply not valid.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn group_verify(key: GroupPublicKey, message: Vec<u8>, signature: GroupSignature) -> bool {
    verify_group(&key, &message, &signature)
}

/// `SHA-256(ed25519PublicKey (32) || mlDsaPublicKey (1952))`, base64url: what
/// a group pin keeps of the group key at its key version, so a device joining
/// at the pin is never handed another key there.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn group_key_digest(key: GroupPublicKey) -> CoreResult<String> {
    group_key_digest_of(&key)
}

pub(crate) fn group_key_digest_of(key: &GroupPublicKey) -> CoreResult<String> {
    let mut bytes = decode("group key", bytes_of(&key.ed25519_public_key, 32, "group key")?, None)?;
    bytes.extend(decode(
        "group key",
        bytes_of(&key.ml_dsa_public_key, ML_DSA_PUBLIC_KEY_BYTES, "group key")?,
        None,
    )?);
    Ok(digest(&bytes))
}

pub(crate) fn verify_group(key: &GroupPublicKey, message: &[u8], signature: &GroupSignature) -> bool {
    if signature.ed25519.len() != SIGNATURE_BYTES || signature.ml_dsa.len() != ML_DSA_SIGNATURE_BYTES {
        return false;
    }
    let (Ok(ed25519), Ok(ml_dsa)) = (
        decode("group key", &key.ed25519_public_key, Some(32)),
        decode("group key", &key.ml_dsa_public_key, Some(ML_DSA_PUBLIC_KEY_BYTES)),
    ) else {
        return false;
    };
    verify(&ed25519, message, &signature.ed25519)
        && ml_dsa_verify(&ml_dsa, message, &signature.ml_dsa, GROUP_SIGNATURE_CONTEXT)
}

/// What a newcomer and the admitting admin compare (2.3):
/// `SHA-256("hushos/group/fingerprint/v1" || groupId (36 ASCII bytes) || ed25519PublicKey (32) || mlDsaPublicKey (1952))`,
/// the first 20 bytes as ten groups of four hex digits, read aloud as twelve
/// words exactly as a person's fingerprint is. Always the version 1 key's.
///
/// ```
/// use hushos_core::*;
/// let key = GroupPublicKey { ed25519_public_key: base64url_encode(vec![1; 32]), ml_dsa_public_key: base64url_encode(vec![2; 1952]) };
/// // The same vector the web's tests carry, computed by a third implementation.
/// assert_eq!(group_fingerprint("0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".into(), key)?, "a9f4 8ca9 8691 f94f dcd9 ecad f0a7 4d03 b0eb 1231");
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn group_fingerprint(group_id: String, key: GroupPublicKey) -> CoreResult<String> {
    uuid(&group_id, "group id")?;
    let ed25519 = decode("group key", bytes_of(&key.ed25519_public_key, 32, "group key")?, None)?;
    let ml_dsa =
        decode("group key", bytes_of(&key.ml_dsa_public_key, ML_DSA_PUBLIC_KEY_BYTES, "group key")?, None)?;
    let hash = Sha256::new()
        .chain_update(b"hushos/group/fingerprint/v1")
        .chain_update(group_id.as_bytes())
        .chain_update(&ed25519)
        .chain_update(&ml_dsa)
        .finalize();
    let hex: String = hash[..20].iter().map(|b| format!("{b:02x}")).collect();
    Ok(hex.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).expect("hex")).collect::<Vec<_>>().join(" "))
}

/* The roster (2.4) */

/// What a group is: a family, or (from the company release) an organisation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum GroupKind {
    Family,
    Org,
}

impl GroupKind {
    fn as_str(self) -> &'static str {
        match self {
            GroupKind::Family => "family",
            GroupKind::Org => "org",
        }
    }

    fn parse(value: &str) -> CoreResult<Self> {
        match value {
            "family" => Ok(GroupKind::Family),
            "org" => Ok(GroupKind::Org),
            _ => Err(input("Invalid group kind.")),
        }
    }
}

/// A role on the roster. A family's are `Billing`, `Guardian` and `Members`;
/// companies add `DataAdmin` and `Recovery`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum GroupRole {
    Billing,
    DataAdmin,
    Guardian,
    Members,
    Recovery,
}

impl GroupRole {
    fn as_str(self) -> &'static str {
        match self {
            GroupRole::Billing => "billing",
            GroupRole::DataAdmin => "data_admin",
            GroupRole::Guardian => "guardian",
            GroupRole::Members => "members",
            GroupRole::Recovery => "recovery",
        }
    }

    fn parse(value: &str, kind: GroupKind) -> CoreResult<Self> {
        let role = match value {
            "billing" => GroupRole::Billing,
            "data_admin" => GroupRole::DataAdmin,
            "guardian" => GroupRole::Guardian,
            "members" => GroupRole::Members,
            "recovery" => GroupRole::Recovery,
            _ => return Err(input("Invalid roster role.")),
        };
        role.allowed_in(kind)
    }

    fn allowed_in(self, kind: GroupKind) -> CoreResult<Self> {
        if kind == GroupKind::Family && matches!(self, GroupRole::DataAdmin | GroupRole::Recovery) {
            return Err(input("Invalid roster role."));
        }
        Ok(self)
    }
}

/// Whether a member is still in the group. Former members' entries stay, marked `Left`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum MemberStatus {
    Active,
    Left,
}

impl MemberStatus {
    fn as_str(self) -> &'static str {
        match self {
            MemberStatus::Active => "active",
            MemberStatus::Left => "left",
        }
    }
}

/// One roster entry: the member's identity as the signer checked it (X25519
/// and Ed25519 in full, the ML-DSA and ML-KEM keys by their SHA-256,
/// base64url), their status and roles, and the roster version the entry last
/// changed at.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RosterMember {
    pub user_id: String,
    pub key_version: u64,
    pub encryption_public_key: String,
    pub signing_public_key: String,
    pub ml_dsa_public_key_digest: String,
    pub kem_public_key_digest: String,
    pub status: MemberStatus,
    /// Sorted, without repeats.
    pub roles: Vec<GroupRole>,
    pub since_version: u64,
}

impl RosterMember {
    /// Active, and holding `role` when one is named.
    pub(crate) fn active_with(&self, role: Option<GroupRole>) -> bool {
        self.status == MemberStatus::Active && role.is_none_or(|role| self.roles.contains(&role))
    }
}

/// A group's signed member list.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct Roster {
    pub group_id: String,
    pub kind: GroupKind,
    pub roster_version: u64,
    /// SHA-256 of the previous roster's statement, base64url; empty for version 1.
    pub previous_roster_digest: String,
    pub group_key_version: u64,
    pub signer_user_id: String,
    /// Sorted by user id.
    pub members: Vec<RosterMember>,
    /// The areas created or rotated by this roster, one row each, sorted by
    /// workspace id, at most `MAX_ROSTER_AREA_ROWS`: each new key's version and
    /// commitment ([`area_key_commitment`]). A new area starts at 1 and a
    /// rotation is one above the area's latest version on the chain; the
    /// accepted chain folds every row into [`AcceptedRosters::area_keys`]. A
    /// grant opens only to a key the chain listed, so a new area or a rotation
    /// needs a roster, signed by a `Members` holder; in a family, a roster that
    /// removes a member rotates every area.
    #[cfg_attr(feature = "uniffi", uniffi(default = []))]
    pub areas: Vec<RosterArea>,
}

/// One area key a roster lists.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RosterArea {
    pub workspace_id: String,
    pub workspace_key_version: u64,
    /// [`area_key_commitment`] of the area key at that version, base64url.
    pub commitment: String,
}

const AREA_COMMIT_INFO: &[u8] = b"hushos/group/area-key/v2";

/// The commitment a roster lists for an area key (design 2.6): HKDF-SHA-256 of
/// the key, salt 32 zero bytes, info `"hushos/group/area-key/v2"`, 32 bytes,
/// base64url. It depends on the key alone, so a repeat anywhere on the chain is
/// a key used before (acceptance refuses it, one HKDF per key and a set
/// lookup); the area and version it belongs to are where the roster lists it,
/// and a grant opens only to the key whose commitment is listed at its area
/// and version. It reveals nothing of the key but whether two keys are equal.
/// Not exported to the apps: a client never builds a row by hand
/// (`roster_next` computes them); public only for the cross-twin fixtures.
#[doc(hidden)]
pub fn area_key_commitment(workspace_key: &[u8]) -> CoreResult<String> {
    crate::bytes::expect_len("workspace key", workspace_key, 32)?;
    let mut out = [0u8; 32];
    hkdf::Hkdf::<Sha256>::new(Some(&[0u8; 32]), workspace_key)
        .expand(AREA_COMMIT_INFO, &mut out)
        .map_err(|_| input("HKDF failed"))?;
    Ok(encode(&out))
}

/// The most area rows one roster may carry (design 2.4); the web holds rosters
/// to the same. As many as a family may have areas, so the roster that removes
/// someone from a family, rotating every area, always fits (about 110 KB).
pub(crate) const MAX_ROSTER_AREA_ROWS: usize = 1024;
/// The most areas a family's chain may list (`check_areas`): a removal rotates
/// them all, so a family past this could never remove anyone. Areas are never
/// retired yet; a tombstone row that stops a deleted area counting must come
/// before area deletion ships.
pub(crate) const MAX_FAMILY_AREAS: usize = 1024;

fn area_parts(areas: &[RosterArea]) -> CoreResult<Value> {
    if areas.len() > MAX_ROSTER_AREA_ROWS {
        return Err(input("Invalid roster areas."));
    }
    let rows = areas
        .iter()
        .map(|area| {
            Ok(json!([
                uuid(&area.workspace_id, "workspace id")?,
                integer(area.workspace_key_version, "workspace key version")?,
                digest_of(&area.commitment, "area key commitment")?,
            ]))
        })
        .collect::<CoreResult<Vec<_>>>()?;
    // One row per area, sorted by workspace id.
    ascending(&areas.iter().map(|area| area.workspace_id.as_str()).collect::<Vec<_>>(), "roster areas")?;
    Ok(Value::Array(rows))
}

impl Roster {
    pub(crate) fn entry(&self, user_id: &str) -> Option<&RosterMember> {
        self.members.iter().find(|member| member.user_id == user_id)
    }
}

const ROSTER_DOMAIN: &str = "hushos/group/roster";

fn member_parts(member: &RosterMember, kind: GroupKind, roster_version: u64) -> CoreResult<Value> {
    let roles = member
        .roles
        .iter()
        .map(|role| role.allowed_in(kind).map(|r| r.as_str()))
        .collect::<CoreResult<Vec<_>>>()?;
    ascending(&roles, "roster roles")?;
    let since = integer(member.since_version, "roster entry version")?;
    if since > roster_version {
        return Err(input("Invalid roster entry version."));
    }
    Ok(json!([
        uuid(&member.user_id, "user id")?,
        integer(member.key_version, "key version")?,
        bytes_of(&member.encryption_public_key, 32, "identity key")?,
        bytes_of(&member.signing_public_key, 32, "identity key")?,
        digest_of(&member.ml_dsa_public_key_digest, "key digest")?,
        digest_of(&member.kem_public_key_digest, "key digest")?,
        member.status.as_str(),
        roles,
        since,
    ]))
}

/// Whether `statement` keeps the group statement grammar (design 2.1): what
/// the shared fixtures check both twins agree on, byte for byte. Not exported
/// to the apps.
#[doc(hidden)]
pub fn group_statement_is_canonical(statement: Vec<u8>) -> bool {
    parse_statement(&statement, "statement").is_ok()
}

/// The most entries a roster may have (design 2.4); the web holds rosters to the same.
pub(crate) const MAX_ROSTER_MEMBERS: usize = 10_000;

/// `["hushos/group/roster",1,groupId,kind,rosterVersion,previousRosterDigest,groupKeyVersion,signerUserId,members,areas]`
/// with `members = [[userId,keyVersion,encryptionPublicKey,signingPublicKey,mlDsaPublicKeyDigest,kemPublicKeyDigest,status,roles,sinceVersion],...]`
/// and `areas = [[workspaceId,workspaceKeyVersion,commitment],...]`, the areas
/// this roster creates or rotates, one row each, sorted by workspace id.
/// Refuses anything outside the canonical encoding: unsorted or repeated
/// members or roles, a company role in a family, an entry newer than the
/// roster, a previous digest on version 1 or none after it.
/// At most `MAX_ROSTER_MEMBERS` entries.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn roster_statement(roster: Roster) -> CoreResult<Vec<u8>> {
    roster_bytes(&roster)
}

pub(crate) fn roster_bytes(roster: &Roster) -> CoreResult<Vec<u8>> {
    let version = integer(roster.roster_version, "roster version")?;
    // Version 1 has no previous roster: its digest is the empty string, and only then.
    let previous = if version == 1 {
        if !roster.previous_roster_digest.is_empty() {
            return Err(input("Invalid roster digest."));
        }
        ""
    } else {
        digest_of(&roster.previous_roster_digest, "roster digest")?
    };
    if roster.members.is_empty() || roster.members.len() > MAX_ROSTER_MEMBERS {
        return Err(input("Invalid roster members."));
    }
    let members = roster
        .members
        .iter()
        .map(|m| member_parts(m, roster.kind, version))
        .collect::<CoreResult<Vec<_>>>()?;
    ascending(&roster.members.iter().map(|m| m.user_id.as_str()).collect::<Vec<_>>(), "roster members")?;
    encode_statement(&[
        json!(ROSTER_DOMAIN),
        json!(1),
        json!(uuid(&roster.group_id, "group id")?),
        json!(roster.kind.as_str()),
        json!(version),
        json!(previous),
        json!(integer(roster.group_key_version, "group key version")?),
        json!(uuid(&roster.signer_user_id, "user id")?),
        Value::Array(members),
        area_parts(&roster.areas)?,
    ])
}

/// The roster a statement's bytes hold, refused unless the bytes are its
/// canonical encoding (no other spacing, escape or number form).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn roster_parse(statement: Vec<u8>) -> CoreResult<Roster> {
    parse_roster(&statement)
}

pub(crate) fn parse_roster(statement: &[u8]) -> CoreResult<Roster> {
    let parts = parse_statement(statement, "roster")?;
    if parts.len() != 10 || parts[0] != json!(ROSTER_DOMAIN) || parts[1] != json!(1) {
        return Err(input("Invalid roster."));
    }
    let areas = parts[9]
        .as_array()
        .ok_or_else(|| input("Invalid roster areas."))?
        .iter()
        .map(|row| {
            let fields =
                row.as_array().filter(|f| f.len() == 3).ok_or_else(|| input("Invalid roster area."))?;
            Ok(RosterArea {
                workspace_id: text(&fields[0], "workspace id")?.into(),
                workspace_key_version: number(&fields[1], "workspace key version")?,
                commitment: text(&fields[2], "area key commitment")?.into(),
            })
        })
        .collect::<CoreResult<Vec<_>>>()?;
    let kind = GroupKind::parse(text(&parts[3], "group kind")?)?;
    let entries = parts[8]
        .as_array()
        .filter(|entries| entries.len() <= MAX_ROSTER_MEMBERS)
        .ok_or_else(|| input("Invalid roster members."))?;
    let members = entries
        .iter()
        .map(|entry| {
            let fields =
                entry.as_array().filter(|f| f.len() == 9).ok_or_else(|| input("Invalid roster entry."))?;
            let status = match text(&fields[6], "member status")? {
                "active" => MemberStatus::Active,
                "left" => MemberStatus::Left,
                _ => return Err(input("Invalid member status.")),
            };
            let roles = fields[7]
                .as_array()
                .ok_or_else(|| input("Invalid roster roles."))?
                .iter()
                .map(|role| GroupRole::parse(text(role, "roster role")?, kind))
                .collect::<CoreResult<Vec<_>>>()?;
            Ok(RosterMember {
                user_id: text(&fields[0], "user id")?.into(),
                key_version: number(&fields[1], "key version")?,
                encryption_public_key: text(&fields[2], "identity key")?.into(),
                signing_public_key: text(&fields[3], "identity key")?.into(),
                ml_dsa_public_key_digest: text(&fields[4], "key digest")?.into(),
                kem_public_key_digest: text(&fields[5], "key digest")?.into(),
                status,
                roles,
                since_version: number(&fields[8], "roster entry version")?,
            })
        })
        .collect::<CoreResult<Vec<_>>>()?;
    let roster = Roster {
        group_id: text(&parts[2], "group id")?.into(),
        kind,
        roster_version: number(&parts[4], "roster version")?,
        previous_roster_digest: text(&parts[5], "roster digest")?.into(),
        group_key_version: number(&parts[6], "group key version")?,
        signer_user_id: text(&parts[7], "user id")?.into(),
        members,
        areas,
    };
    require_canonical(statement, &roster_bytes(&roster)?, "roster")?;
    Ok(roster)
}

/// SHA-256 of a roster's statement, base64url: the next roster's previous
/// digest, and what a pin keeps.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn roster_digest(statement: Vec<u8>) -> String {
    digest(&statement)
}

/// Signs a roster with the group key at its `group_key_version` (the 64-byte
/// seed) and with the signer's own hybrid identity signature over the same
/// bytes, so every roster says who made it. Fold changed entries in first.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn roster_sign(
    roster: Roster,
    group_seed: Vec<u8>,
    signer: IdentityKeys,
) -> CoreResult<SignedGroupStatement> {
    let statement = roster_bytes(&roster)?;
    sign_group_statement(statement, group_seed, &signer)
}

fn sign_group_statement(
    statement: Vec<u8>,
    group_seed: Vec<u8>,
    signer: &IdentityKeys,
) -> CoreResult<SignedGroupStatement> {
    if signer.ml_dsa_seed.len() != crate::pq::ML_DSA_SEED_BYTES {
        return Err(input("Your keys need upgrading first. Unlock again and retry."));
    }
    Ok(SignedGroupStatement {
        signature: group_sign(group_seed, statement.clone())?,
        signer_signature: sign_hybrid(&signer.signing_seed, &signer.ml_dsa_seed, &statement)?,
        statement,
    })
}

/// The keys a member's hybrid signature is checked under through the roster
/// (2.4): the Ed25519 key from their entry, and the ML-DSA key the server
/// served only if its SHA-256 is the entry's `ml_dsa_public_key_digest`. A
/// served key the entry does not name is refused, never trusted on its own.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn roster_member_signer(
    chain: Arc<AcceptedRosters>,
    user_id: String,
    served_ml_dsa_public_key: Vec<u8>,
) -> CoreResult<HybridPublicKey> {
    member_signer(&chain.roster, &user_id, &served_ml_dsa_public_key)
}

const NOT_LISTED: &str = "This person’s keys are not the ones on the group’s member list.";

fn member_signer(roster: &Roster, user_id: &str, served_ml_dsa: &[u8]) -> CoreResult<HybridPublicKey> {
    let entry =
        roster.entry(user_id).ok_or_else(|| input("This person is not on the group’s member list."))?;
    if served_ml_dsa.len() != ML_DSA_PUBLIC_KEY_BYTES
        || digest(served_ml_dsa) != entry.ml_dsa_public_key_digest
    {
        return Err(input(NOT_LISTED));
    }
    Ok(HybridPublicKey {
        signing_public_key: decode("signingPublicKey", &entry.signing_public_key, Some(32))?,
        ml_dsa_public_key: served_ml_dsa.to_vec(),
    })
}

/// A member's served identity and every succession link they signed, as the
/// server serves them: what lets a seal or grant they made before their
/// identity was folded in still open.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SignerHistory {
    pub served: ServedKeys,
    pub links: Vec<SuccessionLink>,
}

/*
 * Every key a seal's or grant's signer may have signed it with, checked
 * through the accepted chain: the keys their entry names now (the served
 * ML-DSA key only if the entry names it), and, with their history, the keys on
 * their own verified succession path (succession_path.rs; every link before
 * the entry's keys carrying the successor's consent) from the first set of
 * keys their entries named on the chain (the one a words check admitted) up
 * to and including the keys their entry names now, so a seal made before a
 * fold-in, or under the entry's keys after the member moved on, still opens.
 * Keys after the entry's (an identity no roster has folded in yet) never
 * count: a member seals only with the keys their entry names. Keys a holder
 * wrote into an entry later never start a path, and an identity fork of the
 * signer lends nothing.
 */
fn signers_through(
    chain: &AcceptedRosters,
    user_id: &str,
    served_ml_dsa: Option<&[u8]>,
    history: Option<&SignerHistory>,
) -> CoreResult<Vec<HybridPublicKey>> {
    let entry =
        chain.roster.entry(user_id).ok_or_else(|| input("This person is not on the group’s member list."))?;
    let mut signers = vec![];
    if let Some(served_ml_dsa) = served_ml_dsa
        .filter(|key| key.len() == ML_DSA_PUBLIC_KEY_BYTES && digest(key) == entry.ml_dsa_public_key_digest)
    {
        signers.push(HybridPublicKey {
            signing_public_key: decode("signingPublicKey", &entry.signing_public_key, Some(32))?,
            ml_dsa_public_key: served_ml_dsa.to_vec(),
        });
    }
    if let Some(history) = history {
        let own = signers.len();
        let (encryption, signing, ml_dsa_digest) =
            match chain.key_history.get(user_id).and_then(|sets| sets.first()) {
                Some(first) => {
                    (&first.encryption_public_key, &first.signing_public_key, &first.ml_dsa_public_key_digest)
                }
                None => {
                    (&entry.encryption_public_key, &entry.signing_public_key, &entry.ml_dsa_public_key_digest)
                }
            };
        let is_entry = |encryption: &str, signing: &str, ml_dsa: &str| {
            encryption == entry.encryption_public_key
                && signing == entry.signing_public_key
                && decode("mlDsaPublicKey", ml_dsa, Some(ML_DSA_PUBLIC_KEY_BYTES))
                    .is_ok_and(|key| digest(&key) == entry.ml_dsa_public_key_digest)
        };
        let mut reached = false;
        if let (Ok(hash), Ok(entry_hash)) =
            (digest_hex(ml_dsa_digest.clone()), digest_hex(entry.ml_dsa_public_key_digest.clone()))
        {
            let from = PinnedKeys {
                key_version: None,
                encryption_public_key: encryption.clone(),
                signing_public_key: signing.clone(),
                ml_dsa_public_key_hash: hash,
            };
            // Up to the entry's keys, only links the successor consented to: keys planted as the
            // member's first entry never bridge to the real identity.
            let until = PinnedKeys {
                key_version: None,
                encryption_public_key: entry.encryption_public_key.clone(),
                signing_public_key: entry.signing_public_key.clone(),
                ml_dsa_public_key_hash: entry_hash,
            };
            if let SuccessionPath::Path(path) = succession_path(
                user_id,
                &from,
                &history.served,
                &history.links,
                &VerifiedLinks::new(),
                Some(&until),
                &[],
            ) {
                for link in &path {
                    if let (Ok(signing_public_key), Ok(ml_dsa_public_key)) = (
                        decode("signingPublicKey", &link.old_signing_public_key, Some(32)),
                        decode("mlDsaPublicKey", &link.old_ml_dsa_public_key, Some(ML_DSA_PUBLIC_KEY_BYTES)),
                    ) {
                        signers.push(HybridPublicKey { signing_public_key, ml_dsa_public_key });
                    }
                    // Up to the entry's own keys, never past them.
                    reached = is_entry(
                        &link.old_encryption_public_key,
                        &link.old_signing_public_key,
                        &link.old_ml_dsa_public_key,
                    );
                    if reached {
                        break;
                    }
                }
                reached = reached
                    || is_entry(
                        &history.served.encryption_public_key,
                        &history.served.signing_public_key,
                        &history.served.ml_dsa_public_key,
                    );
            }
        }
        // A path that never reaches the entry's keys vouches for none of its keys.
        if !reached {
            signers.truncate(own);
        }
    }
    if signers.is_empty() {
        return Err(input(NOT_LISTED));
    }
    Ok(signers)
}

/*
 * Refuses to seal with keys other than the ones the sealer's entry names
 * (Ed25519, and ML-DSA by digest, both from the seeds): a member seals only
 * once their current identity is folded into the roster, so every seal opens
 * under the entry.
 */
fn sealer_holds(chain: &AcceptedRosters, user_id: &str, sealer: &IdentityKeys) -> CoreResult<()> {
    let refused = || input("These are not the sealer’s keys on the group’s member list.");
    let entry = chain.roster.entry(user_id).ok_or_else(refused)?;
    let ed25519 = signing_public_key(sealer.signing_seed.to_vec()).map_err(|_| refused())?;
    let ml_dsa = ml_dsa_public_key(&sealer.ml_dsa_seed).map_err(|_| refused())?;
    if entry.signing_public_key != encode(&ed25519) || entry.ml_dsa_public_key_digest != digest(&ml_dsa) {
        return Err(refused());
    }
    Ok(())
}

/// Whether `signature` is the member's hybrid signature over `message`,
/// checked through the roster ([`roster_member_signer`]).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn roster_member_verify(
    chain: Arc<AcceptedRosters>,
    user_id: String,
    served_ml_dsa_public_key: Vec<u8>,
    message: Vec<u8>,
    signature: Vec<u8>,
) -> bool {
    member_signer(&chain.roster, &user_id, &served_ml_dsa_public_key)
        .is_ok_and(|keys| verify_hybrid(&keys, &message, &signature))
}

/* What a seal is sealed to: the entry's X25519 key, and the served ML-KEM key only if the entry names it. */
fn member_recipient(entry: &RosterMember, kem_public_key: &[u8]) -> CoreResult<Vec<u8>> {
    if kem_public_key.len() != KEM_PUBLIC_KEY_BYTES || digest(kem_public_key) != entry.kem_public_key_digest {
        return Err(input(NOT_LISTED));
    }
    decode("encryptionPublicKey", &entry.encryption_public_key, Some(32))
}

/* Key succession (2.5) */

/// A group key succession: the old key vouching for the new one, tied to the
/// last roster under the old key.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct GroupKeySuccession {
    pub group_id: String,
    pub old_version: u64,
    pub new_version: u64,
    pub old_ed25519_public_key: String,
    pub old_ml_dsa_public_key: String,
    pub new_ed25519_public_key: String,
    pub new_ml_dsa_public_key: String,
    pub last_roster_version: u64,
    pub last_roster_digest: String,
    pub signer_user_id: String,
}

impl GroupKeySuccession {
    pub(crate) fn old_key(&self) -> GroupPublicKey {
        GroupPublicKey {
            ed25519_public_key: self.old_ed25519_public_key.clone(),
            ml_dsa_public_key: self.old_ml_dsa_public_key.clone(),
        }
    }

    pub(crate) fn new_key(&self) -> GroupPublicKey {
        GroupPublicKey {
            ed25519_public_key: self.new_ed25519_public_key.clone(),
            ml_dsa_public_key: self.new_ml_dsa_public_key.clone(),
        }
    }
}

const SUCCESSION_DOMAIN: &str = "hushos/group/key-succession";

/// `["hushos/group/key-succession",1,groupId,oldVersion,newVersion,oldEd25519PublicKey,oldMlDsaPublicKey,newEd25519PublicKey,newMlDsaPublicKey,lastRosterVersion,lastRosterDigest,signerUserId]`;
/// `new_version` is always `old_version + 1`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn group_succession_statement(succession: GroupKeySuccession) -> CoreResult<Vec<u8>> {
    succession_bytes(&succession)
}

pub(crate) fn succession_bytes(succession: &GroupKeySuccession) -> CoreResult<Vec<u8>> {
    let old_version = integer(succession.old_version, "group key version")?;
    if integer(succession.new_version, "group key version")? != old_version + 1 {
        return Err(input("Invalid group key version."));
    }
    encode_statement(&[
        json!(SUCCESSION_DOMAIN),
        json!(1),
        json!(uuid(&succession.group_id, "group id")?),
        json!(old_version),
        json!(succession.new_version),
        json!(bytes_of(&succession.old_ed25519_public_key, 32, "group key")?),
        json!(bytes_of(&succession.old_ml_dsa_public_key, ML_DSA_PUBLIC_KEY_BYTES, "group key")?),
        json!(bytes_of(&succession.new_ed25519_public_key, 32, "group key")?),
        json!(bytes_of(&succession.new_ml_dsa_public_key, ML_DSA_PUBLIC_KEY_BYTES, "group key")?),
        json!(integer(succession.last_roster_version, "roster version")?),
        json!(digest_of(&succession.last_roster_digest, "roster digest")?),
        json!(uuid(&succession.signer_user_id, "user id")?),
    ])
}

/// The succession a statement's bytes hold, refused unless the bytes are its canonical encoding.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn group_succession_parse(statement: Vec<u8>) -> CoreResult<GroupKeySuccession> {
    parse_succession(&statement)
}

pub(crate) fn parse_succession(statement: &[u8]) -> CoreResult<GroupKeySuccession> {
    let parts = parse_statement(statement, "group key succession")?;
    if parts.len() != 12 || parts[0] != json!(SUCCESSION_DOMAIN) || parts[1] != json!(1) {
        return Err(input("Invalid group key succession."));
    }
    let succession = GroupKeySuccession {
        group_id: text(&parts[2], "group id")?.into(),
        old_version: number(&parts[3], "group key version")?,
        new_version: number(&parts[4], "group key version")?,
        old_ed25519_public_key: text(&parts[5], "group key")?.into(),
        old_ml_dsa_public_key: text(&parts[6], "group key")?.into(),
        new_ed25519_public_key: text(&parts[7], "group key")?.into(),
        new_ml_dsa_public_key: text(&parts[8], "group key")?.into(),
        last_roster_version: number(&parts[9], "roster version")?,
        last_roster_digest: text(&parts[10], "roster digest")?.into(),
        signer_user_id: text(&parts[11], "user id")?.into(),
    };
    require_canonical(statement, &succession_bytes(&succession)?, "group key succession")?;
    Ok(succession)
}

/// Signs a succession with the old group key (its seed, which must derive the
/// statement's old key) and the signer's hybrid identity signature.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn group_succession_sign(
    succession: GroupKeySuccession,
    old_seed: Vec<u8>,
    signer: IdentityKeys,
) -> CoreResult<SignedGroupStatement> {
    let statement = succession_bytes(&succession)?;
    if group_public_key(old_seed.clone())? != succession.old_key() {
        return Err(input("This is not the group key being replaced."));
    }
    sign_group_statement(statement, old_seed, &signer)
}

/* Seals (2.3, 2.6; guardian seals, 2.9, are not in milestone 1) */

/*
 * Each seal is the share suite 4 construction under its own HKDF `info`, with
 * associated data equal to its statement without the final digest, so a seal
 * of one kind, version or context opens as nothing as another.
 */
const KEY_SEAL_INFO: &[u8] = b"hushos/group/key-seal/v1";
const AREA_GRANT_INFO: &[u8] = b"hushos/group/area-grant/v1";

#[cfg(test)]
const GROUP_KEY_SEAL_BYTES: usize = crate::shares::hybrid_seal_bytes(GROUP_SEED_BYTES); // 4597
#[cfg(test)]
const AREA_GRANT_BYTES: usize = crate::shares::hybrid_seal_bytes(32); // 4565

/// What a key seal binds: the group, the key version, the holder and the
/// identity it is sealed to, who sealed it, and the sealer's latest accepted
/// roster when they sealed (`roster_version`, `roster_digest`): an opener takes
/// the seal only if that roster is on its own accepted chain, so a seal made
/// on a branch never opens on the real chain.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct GroupKeySealContext {
    pub group_id: String,
    pub group_key_version: u64,
    pub holder_user_id: String,
    pub holder_key_version: u64,
    pub sealer_user_id: String,
    pub roster_version: u64,
    pub roster_digest: String,
}

/// What an area grant binds, the granter's latest accepted roster included
/// (as for a key seal).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct AreaGrantContext {
    pub group_id: String,
    pub workspace_id: String,
    pub workspace_key_version: u64,
    pub grantee_user_id: String,
    pub grantee_key_version: u64,
    pub granter_user_id: String,
    pub roster_version: u64,
    pub roster_digest: String,
}

fn key_seal_parts(ctx: &GroupKeySealContext) -> CoreResult<Vec<Value>> {
    Ok(vec![
        json!("hushos/group/key-seal"),
        json!(1),
        json!(uuid(&ctx.group_id, "group id")?),
        json!(integer(ctx.group_key_version, "group key version")?),
        json!(uuid(&ctx.holder_user_id, "user id")?),
        json!(integer(ctx.holder_key_version, "key version")?),
        json!(uuid(&ctx.sealer_user_id, "user id")?),
        json!(integer(ctx.roster_version, "roster version")?),
        json!(digest_of(&ctx.roster_digest, "roster digest")?),
    ])
}

fn area_grant_parts(ctx: &AreaGrantContext) -> CoreResult<Vec<Value>> {
    Ok(vec![
        json!("hushos/group/area-grant"),
        json!(1),
        json!(uuid(&ctx.group_id, "group id")?),
        json!(uuid(&ctx.workspace_id, "workspace id")?),
        json!(integer(ctx.workspace_key_version, "workspace key version")?),
        json!(uuid(&ctx.grantee_user_id, "user id")?),
        json!(integer(ctx.grantee_key_version, "key version")?),
        json!(uuid(&ctx.granter_user_id, "user id")?),
        json!(integer(ctx.roster_version, "roster version")?),
        json!(digest_of(&ctx.roster_digest, "roster digest")?),
    ])
}

fn with_digest(mut parts: Vec<Value>, sealed: &[u8]) -> CoreResult<Vec<u8>> {
    parts.push(json!(digest(sealed)));
    encode_statement(&parts)
}

/// `["hushos/group/key-seal",1,groupId,groupKeyVersion,holderUserId,holderKeyVersion,sealerUserId,rosterVersion,rosterDigest,sha256(sealed)]`;
/// the associated data is the same without the digest.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn group_key_seal_statement(ctx: GroupKeySealContext, sealed: Vec<u8>) -> CoreResult<Vec<u8>> {
    with_digest(key_seal_parts(&ctx)?, &sealed)
}

/// `["hushos/group/area-grant",1,groupId,workspaceId,workspaceKeyVersion,granteeUserId,granteeKeyVersion,granterUserId,rosterVersion,rosterDigest,sha256(sealed)]`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn area_grant_statement(ctx: AreaGrantContext, sealed: Vec<u8>) -> CoreResult<Vec<u8>> {
    with_digest(area_grant_parts(&ctx)?, &sealed)
}

/* Each seal's associated data: its statement without the final digest. */
pub(crate) fn key_seal_context(ctx: &GroupKeySealContext) -> CoreResult<Vec<u8>> {
    encode_statement(&key_seal_parts(ctx)?)
}
pub(crate) fn area_grant_context(ctx: &AreaGrantContext) -> CoreResult<Vec<u8>> {
    encode_statement(&area_grant_parts(ctx)?)
}

fn same_group(chain: &Arc<AcceptedRosters>, group_id: &str) -> CoreResult<()> {
    if uuid(group_id, "group id")? != chain.group_id || chain.roster.group_id != chain.group_id {
        return Err(input("This is for another group."));
    }
    Ok(())
}

/* A seal is made at the sealer's latest accepted roster, named in its context. */
fn sealed_at_latest(chain: &AcceptedRosters, roster_version: u64, roster_digest: &str) -> CoreResult<()> {
    if roster_version != chain.roster.roster_version || roster_digest != chain.roster_digest {
        return Err(input("A seal names the latest member list this device accepted."));
    }
    Ok(())
}

/* An opener takes a seal only if the roster it was made at is on its own accepted chain. */
fn sealed_on_chain(chain: &AcceptedRosters, roster_version: u64, roster_digest: &str) -> CoreResult<()> {
    integer(roster_version, "roster version")?;
    let index = usize::try_from(roster_version - 1).unwrap_or(usize::MAX);
    if chain.roster_digests.get(index).map(String::as_str) != Some(roster_digest) {
        return Err(input("This was sealed on a member list this device does not have."));
    }
    Ok(())
}

/*
 * An area is a workspace whose id was derived under the group (the
 * `Workspace` id kind, scoped to the group id): a grant naming a group for a
 * workspace that is not its own opens nothing, so no member, with the
 * server's help, can bring someone's personal or another group's workspace
 * under this group's roster. Only areas that pass may enter the pin's areas.
 */
fn area_of(group_id: &str, workspace_id: &str, area_id_seed: &str) -> CoreResult<()> {
    check_id(IdKind::Workspace, group_id.into(), area_id_seed.into(), workspace_id.into())
        .map_err(|_| input("This area does not belong to the group."))
}

/// Seals the group key's seed to a holder: only to an entry of the accepted
/// roster that is active with `Members`, at the key version the context
/// names, under the ML-KEM key the entry names by digest.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn group_key_seal(
    seed: Vec<u8>,
    ctx: GroupKeySealContext,
    chain: Arc<AcceptedRosters>,
    holder_kem_public_key: Vec<u8>,
    sealer: IdentityKeys,
) -> CoreResult<Vec<u8>> {
    let seed = Zeroizing::new(seed);
    group_seed(&seed)?;
    same_group(&chain, &ctx.group_id)?;
    sealed_at_latest(&chain, ctx.roster_version, &ctx.roster_digest)?;
    // Only a holder seals the group key (the creator, version 1's, while active): a seal from
    // anyone else would never open.
    let sealing = chain.roster.entry(&ctx.sealer_user_id);
    let creator = ctx.group_key_version == 1
        && sealing.is_some_and(|e| e.active_with(None))
        && chain.creator_user_id == ctx.sealer_user_id;
    if !sealing.is_some_and(|e| e.active_with(Some(GroupRole::Members))) && !creator {
        return Err(input("The group key is sealed only by a member who holds it."));
    }
    sealer_holds(&chain, &ctx.sealer_user_id, &sealer)?;
    let holder = chain
        .roster
        .entry(&ctx.holder_user_id)
        .filter(|e| e.active_with(Some(GroupRole::Members)) && e.key_version == ctx.holder_key_version)
        .ok_or_else(|| input("The group key is sealed only to members who hold it."))?;
    let recipient = member_recipient(holder, &holder_kem_public_key)?;
    let statement = |sealed: &[u8]| group_key_seal_statement(ctx.clone(), sealed.to_vec());
    seal_hybrid(&seed, &recipient, &holder_kem_public_key, &sealer, &key_seal_kind(&ctx, &statement)?)
}

fn key_seal_kind<'a>(
    ctx: &GroupKeySealContext,
    statement: &'a dyn Fn(&[u8]) -> CoreResult<Vec<u8>>,
) -> CoreResult<SealKind<'a>> {
    Ok(SealKind {
        info: KEY_SEAL_INFO,
        associated_data: key_seal_context(ctx)?,
        statement,
        noun: "group key",
        invalid: "Invalid group key seal.",
        unsigned: "This group key was not sealed by a member who holds it.",
    })
}

fn area_grant_kind<'a>(
    ctx: &AreaGrantContext,
    statement: &'a dyn Fn(&[u8]) -> CoreResult<Vec<u8>>,
) -> CoreResult<SealKind<'a>> {
    Ok(SealKind {
        info: AREA_GRANT_INFO,
        associated_data: area_grant_context(ctx)?,
        statement,
        noun: "grant",
        invalid: "Invalid area grant.",
        unsigned: "This grant is not signed by the member who made it.",
    })
}

/// Opens a key seal: the 64-byte group seed. Refused unless the sealer is
/// active with `Members` on the accepted roster (or is the group's creator,
/// the signer of roster version 1, for key version 1), its signature holds
/// under their keys through the roster, and the seed derives exactly the
/// group key the verified key chain has at `group_key_version`. A holder
/// handed a substitute seed would sign rosters nobody accepts.
#[cfg_attr(feature = "uniffi", uniffi::export)]
#[allow(clippy::too_many_arguments)]
pub fn group_key_open(
    envelope: Vec<u8>,
    ctx: GroupKeySealContext,
    chain: Arc<AcceptedRosters>,
    sealer_ml_dsa_public_key: Vec<u8>,
    sealer_history: Option<SignerHistory>,
    reader: String,
    reader_key_version: u64,
    holder: IdentityKeys,
) -> CoreResult<SecretBytes> {
    same_group(&chain, &ctx.group_id)?;
    sealed_on_chain(&chain, ctx.roster_version, &ctx.roster_digest)?;
    if ctx.holder_user_id != reader || ctx.holder_key_version != reader_key_version {
        return Err(input("This group key was not sealed to this account’s keys."));
    }
    let group_key = usize::try_from(ctx.group_key_version)
        .ok()
        .and_then(|version| chain.group_keys.get(version.wrapping_sub(1)))
        .ok_or_else(|| input("This group key is not one the group has published."))?;
    let sealer = chain.roster.entry(&ctx.sealer_user_id);
    // The creator seals version 1 before anyone else holds it, and may open only while active.
    let creator = ctx.group_key_version == 1
        && sealer.is_some_and(|e| e.active_with(None))
        && chain.creator_user_id == ctx.sealer_user_id;
    if !sealer.is_some_and(|e| e.active_with(Some(GroupRole::Members))) && !creator {
        return Err(input("This group key was not sealed by a member who holds it."));
    }
    let signers = signers_through(
        &chain,
        &ctx.sealer_user_id,
        Some(&sealer_ml_dsa_public_key),
        sealer_history.as_ref(),
    )?;
    let statement = |sealed: &[u8]| group_key_seal_statement(ctx.clone(), sealed.to_vec());
    let seed = SecretBytes::new(open_hybrid(
        &envelope,
        GROUP_SEED_BYTES,
        &signers,
        &holder,
        &key_seal_kind(&ctx, &statement)?,
    )?);
    if group_public_key(seed.to_vec())? != *group_key {
        return Err(CoreError::Sealed("This group key is not the group’s published key.".into()));
    }
    Ok(seed)
}

/// Seals an area's workspace key to a member: only for an area derived under
/// the group (`area_id_seed`), and only to an active entry of the accepted
/// roster at the key version the context names.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn area_grant_seal(
    workspace_key: Vec<u8>,
    ctx: AreaGrantContext,
    chain: Arc<AcceptedRosters>,
    area_id_seed: String,
    grantee_kem_public_key: Vec<u8>,
    granter: IdentityKeys,
) -> CoreResult<Vec<u8>> {
    crate::bytes::expect_len("workspace key", &workspace_key, 32)?;
    same_group(&chain, &ctx.group_id)?;
    sealed_at_latest(&chain, ctx.roster_version, &ctx.roster_digest)?;
    if !chain.roster.entry(&ctx.granter_user_id).is_some_and(|e| e.active_with(None)) {
        return Err(input("Areas are granted only by active members."));
    }
    sealer_holds(&chain, &ctx.granter_user_id, &granter)?;
    area_of(&ctx.group_id, &ctx.workspace_id, &area_id_seed)?;
    // Only a key the chain lists for that area and version: a new area or a rotation is a roster
    // first.
    let commitment = area_key_commitment(&workspace_key)?;
    if listed_area(&chain, &ctx.workspace_id, ctx.workspace_key_version) != Some(commitment.as_str()) {
        return Err(input(NOT_LISTED_KEY));
    }
    let grantee = chain
        .roster
        .entry(&ctx.grantee_user_id)
        .filter(|e| e.active_with(None) && e.key_version == ctx.grantee_key_version)
        .ok_or_else(|| input("Areas are granted only to active members."))?;
    let recipient = member_recipient(grantee, &grantee_kem_public_key)?;
    let statement = |sealed: &[u8]| area_grant_statement(ctx.clone(), sealed.to_vec());
    seal_hybrid(
        &workspace_key,
        &recipient,
        &grantee_kem_public_key,
        &granter,
        &area_grant_kind(&ctx, &statement)?,
    )
}

/// Opens an area grant: the workspace key. Refused unless it names this group
/// (the accepted chain's), an area derived under it (`area_id_seed`, 2.6), a
/// key version the accepted chain lists for that area (any listed version, no
/// high-water floor), the reader's
/// own account and key version (`reader`, `reader_key_version`), and a
/// granter who is active on the roster and whose signature holds
/// under their keys through it; and the key it opens to must be the one the
/// roster's commitment names, so an honest member kept behind cannot hand on a
/// key the real chain never listed.
#[cfg_attr(feature = "uniffi", uniffi::export)]
#[allow(clippy::too_many_arguments)]
pub fn area_grant_open(
    envelope: Vec<u8>,
    ctx: AreaGrantContext,
    chain: Arc<AcceptedRosters>,
    area_id_seed: String,
    granter_ml_dsa_public_key: Vec<u8>,
    granter_history: Option<SignerHistory>,
    reader: String,
    reader_key_version: u64,
    grantee: IdentityKeys,
) -> CoreResult<Vec<u8>> {
    same_group(&chain, &ctx.group_id)?;
    sealed_on_chain(&chain, ctx.roster_version, &ctx.roster_digest)?;
    area_of(&ctx.group_id, &ctx.workspace_id, &area_id_seed)?;
    if ctx.grantee_user_id != reader || ctx.grantee_key_version != reader_key_version {
        return Err(input("This grant is not for this account’s keys."));
    }
    if !chain.roster.entry(&ctx.granter_user_id).is_some_and(|e| e.active_with(None)) {
        return Err(input("This grant is not from an active member of the group."));
    }
    let signers = signers_through(
        &chain,
        &ctx.granter_user_id,
        Some(&granter_ml_dsa_public_key),
        granter_history.as_ref(),
    )?;
    let listed = listed_area(&chain, &ctx.workspace_id, ctx.workspace_key_version)
        .ok_or_else(|| input("This area key version is not on the group’s member list."))?
        .to_string();
    let statement = |sealed: &[u8]| area_grant_statement(ctx.clone(), sealed.to_vec());
    let workspace_key =
        Zeroizing::new(open_hybrid(&envelope, 32, &signers, &grantee, &area_grant_kind(&ctx, &statement)?)?);
    // The key itself, not only its sealer: a granter cannot deliver another key under a listed version.
    if area_key_commitment(&workspace_key)? != listed {
        return Err(input(NOT_LISTED_KEY));
    }
    Ok(workspace_key.to_vec())
}

const NOT_LISTED_KEY: &str = "This area key is not the one the group’s member list names.";

/*
 * The commitment the chain listed for an area at a key version: the current
 * key, or an earlier one a reader needs for older files. Never a version no
 * roster on the chain listed.
 */
fn listed_area<'a>(
    chain: &'a AcceptedRosters,
    workspace_id: &str,
    workspace_key_version: u64,
) -> Option<&'a str> {
    let index = usize::try_from(workspace_key_version.checked_sub(1)?).ok()?;
    chain.area_keys.get(workspace_id)?.get(index).map(String::as_str)
}

/// The key version a member writes an area under: the latest the accepted
/// chain lists for it, or none when it lists none (not an area of the
/// group's). A client holding no grant for that version writes nothing to the
/// area until it has one: the server's word that the area is at an older
/// version is no protection against the server (design 2.6).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn area_write_version(chain: Arc<AcceptedRosters>, workspace_id: String) -> Option<u64> {
    chain.area_keys.get(&workspace_id).map(|list| list.len() as u64)
}

/// The row a roster carries for an area's next key: version one above the
/// chain's latest (1 for a new area), and the key's commitment. Refused for a
/// key that is one of the area's earlier keys (by their commitments): a
/// rotation that hands out a key already held rotates nothing.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn next_area_key(
    chain: Arc<AcceptedRosters>,
    workspace_id: String,
    workspace_key: Vec<u8>,
) -> CoreResult<RosterArea> {
    let mut rows = area_rows(&chain, vec![AreaKey { workspace_id, workspace_key }])?;
    Ok(rows.remove(0))
}

/// An area's new key, for `roster_next` to turn into its row.
#[derive(Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct AreaKey {
    pub workspace_id: String,
    pub workspace_key: Vec<u8>,
}

impl std::fmt::Debug for AreaKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AreaKey").field("workspace_id", &self.workspace_id).finish_non_exhaustive()
    }
}

const EARLIER_KEY: &str = "This is one of the group’s earlier keys: a rotation needs a new one.";

/// The rows a roster carries for new area keys (2.4, 2.6): each at its area's
/// next version (1 for a new area), with the key's commitment, sorted by
/// workspace id. Refused when an area appears twice, or a key's commitment
/// repeats: two of the new keys alike, or any key the group had before, in
/// any area at any version (the commitment depends on the key alone, so this
/// is one HKDF per new key and a set lookup). Acceptance refuses the same
/// (`check_areas`); this only says so before a holder signs. Keys are wiped
/// as they are used, and only their commitments are kept.
pub(crate) fn area_rows(chain: &AcceptedRosters, keys: Vec<AreaKey>) -> CoreResult<Vec<RosterArea>> {
    rows_after(&chain.area_keys, keys)
}

/*
 * The same rows after the commitments `listed` already holds (a chain's
 * `area_keys`; nothing for roster version 1): `area_rows` and `roster_first`
 * are its only callers, as the web's rowsAfter.
 */
pub(crate) fn rows_after(
    listed: &HashMap<String, Vec<String>>,
    keys: Vec<AreaKey>,
) -> CoreResult<Vec<RosterArea>> {
    let mut areas = HashSet::new();
    for key in &keys {
        uuid(&key.workspace_id, "workspace id")?;
        if !areas.insert(key.workspace_id.clone()) {
            return Err(input("Invalid roster areas."));
        }
    }
    let before: HashSet<&String> = listed.values().flatten().collect();
    let mut fresh = HashSet::new();
    let mut rows = vec![];
    for key in keys {
        let workspace_key = Zeroizing::new(key.workspace_key);
        let commitment = area_key_commitment(&workspace_key)?;
        if before.contains(&commitment) || !fresh.insert(commitment.clone()) {
            return Err(input(EARLIER_KEY));
        }
        let version = listed.get(&key.workspace_id).map_or(0, Vec::len) as u64 + 1;
        rows.push(RosterArea { workspace_id: key.workspace_id, workspace_key_version: version, commitment });
    }
    rows.sort_by(|a, b| a.workspace_id.cmp(&b.workspace_id));
    Ok(rows)
}

/// The areas the next roster must rotate for it to hold: in a family every
/// member opens every area, so a roster that marks anyone `left` rotates them
/// all (in companies, until rosters say who opens what, the removal route
/// rotates the areas the removed member held). Pass a new key for each to
/// `roster_next`, which computes the rows.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn areas_to_rotate(chain: Arc<AcceptedRosters>, members: Vec<RosterMember>) -> Vec<String> {
    if chain.kind != GroupKind::Family {
        return vec![];
    }
    let leaving = members.iter().any(|entry| {
        entry.status == MemberStatus::Left
            && chain.roster.entry(&entry.user_id).is_some_and(|before| before.status == MemberStatus::Active)
    });
    if !leaving {
        return vec![];
    }
    let mut areas: Vec<String> = chain.area_keys.keys().cloned().collect();
    areas.sort();
    areas
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::bytes::random;
    use crate::identity::{identity_create, identity_open};

    pub(crate) const GROUP: &str = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
    pub(crate) const OTHER_GROUP: &str = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
    /* The family's area, derived under GROUP from AREA_SEED; another group's, under OTHER_GROUP. */
    pub(crate) const AREA: &str = "80558a81-8dfc-8914-8447-0417b55e2ec5";
    pub(crate) const AREA_SEED: &str = "pMrxFz5ki7HY_iVLcpi_5Q";
    pub(crate) const OTHER_AREA: &str = "8479e412-cae8-8d7c-8357-63caa0c518a9";
    pub(crate) const OTHER_AREA_SEED: &str = "q9H4HkVskrngBi1TeqHH7g";

    /* A person with a fresh version 2 identity, and the parts a roster and a seal take of it. */
    #[derive(Clone)]
    pub(crate) struct Person {
        pub(crate) user_id: String,
        pub(crate) keys: IdentityKeys,
        pub(crate) root: Vec<u8>,
        pub(crate) envelope: crate::identity::IdentityEnvelope,
    }

    impl Person {
        pub(crate) fn new(n: u32) -> Person {
            Person::at(n, 1)
        }

        /* Person `n` with a fresh identity at `key_version`, with no link from any earlier one. */
        pub(crate) fn at(n: u32, key_version: u64) -> Person {
            let user_id = format!("{n:08x}-abcd-4abc-8abc-abcdefabcdef");
            let root = random(32);
            let envelope = identity_create(user_id.clone(), root.clone(), key_version).unwrap();
            let keys = identity_open(user_id.clone(), root.clone(), envelope.clone()).unwrap();
            Person { user_id, keys, root, envelope }
        }

        /* Their identity as the server serves it, with its keys statement's signature. */
        pub(crate) fn served(&self) -> crate::identity::PublicIdentity {
            crate::identity::public_identity(self.envelope.clone()).unwrap()
        }

        /* Their next identity, and the version 2 succession link the current one signs. */
        pub(crate) fn succeed(&self) -> (Person, crate::identity::SuccessionLink) {
            let next = crate::identity::identity_succeed(
                self.user_id.clone(),
                self.root.clone(),
                self.envelope.clone(),
            )
            .unwrap();
            let (old, new) =
                (self.served(), crate::identity::public_identity(next.identity.clone()).unwrap());
            let link = crate::identity::SuccessionLink {
                old_key_version: old.key_version,
                new_key_version: new.key_version,
                old_encryption_public_key: old.encryption_public_key,
                old_signing_public_key: old.signing_public_key,
                old_ml_dsa_public_key: old.ml_dsa_public_key,
                new_encryption_public_key: new.encryption_public_key,
                new_signing_public_key: new.signing_public_key,
                new_ml_dsa_public_key: new.ml_dsa_public_key,
                new_kem_public_key: new.kem_public_key,
                signature: next.signature,
                consent: Some(next.consent),
            };
            let keys = identity_open(self.user_id.clone(), self.root.clone(), next.identity.clone()).unwrap();
            (
                Person {
                    user_id: self.user_id.clone(),
                    keys,
                    root: self.root.clone(),
                    envelope: next.identity,
                },
                link,
            )
        }

        /* What a version 3 pin of them keeps, as verifySuccessionChain starts from it. */
        pub(crate) fn pinned(&self) -> crate::identity::PinnedKeys {
            crate::identity::PinnedKeys {
                key_version: Some(self.keys.key_version),
                encryption_public_key: self.keys.encryption_public_key.clone(),
                signing_public_key: self.keys.signing_public_key.clone(),
                ml_dsa_public_key_hash: crate::contacts::key_digest(self.ml_dsa()),
            }
        }

        pub(crate) fn served_keys(&self) -> crate::identity::ServedKeys {
            let served = self.served();
            crate::identity::ServedKeys {
                key_version: served.key_version,
                encryption_public_key: served.encryption_public_key,
                signing_public_key: served.signing_public_key,
                ml_dsa_public_key: served.ml_dsa_public_key,
                kem_public_key: served.kem_public_key,
            }
        }

        pub(crate) fn ml_dsa(&self) -> Vec<u8> {
            decode("k", self.keys.ml_dsa_public_key.as_ref().unwrap(), None).unwrap()
        }

        pub(crate) fn kem(&self) -> Vec<u8> {
            decode("k", self.keys.kem_public_key.as_ref().unwrap(), None).unwrap()
        }

        pub(crate) fn entry(&self, roles: &[GroupRole], since: u64, status: MemberStatus) -> RosterMember {
            let mut roles = roles.to_vec();
            roles.sort();
            RosterMember {
                user_id: self.user_id.clone(),
                key_version: self.keys.key_version,
                encryption_public_key: self.keys.encryption_public_key.clone(),
                signing_public_key: self.keys.signing_public_key.clone(),
                ml_dsa_public_key_digest: digest(&self.ml_dsa()),
                kem_public_key_digest: digest(&self.kem()),
                status,
                roles,
                since_version: since,
            }
        }

        pub(crate) fn active(&self, roles: &[GroupRole]) -> RosterMember {
            self.entry(roles, 1, MemberStatus::Active)
        }
    }

    pub(crate) fn family_roster(members: Vec<RosterMember>, signer: &Person) -> Roster {
        let mut members = members;
        members.sort_by(|a, b| a.user_id.cmp(&b.user_id));
        Roster {
            group_id: GROUP.into(),
            kind: GroupKind::Family,
            roster_version: 1,
            previous_roster_digest: String::new(),
            group_key_version: 1,
            signer_user_id: signer.user_id.clone(),
            members,
            areas: vec![],
        }
    }

    /* The area key every lib-test history's rosters list unless told otherwise: AREA at version 1. */
    pub(crate) const AREA_KEY: [u8; 32] = [77; 32];
    pub(crate) fn standard_areas() -> Vec<RosterArea> {
        vec![RosterArea {
            workspace_id: AREA.into(),
            workspace_key_version: 1,
            commitment: area_key_commitment(&AREA_KEY).unwrap(),
        }]
    }

    /* The key an area has at `version` in these tests: AREA's first is AREA_KEY. */
    pub(crate) fn area_key_at(workspace_id: &str, version: u64) -> Vec<u8> {
        let base = if workspace_id == AREA { 77 + version - 1 } else { 100 + version };
        vec![base as u8; 32]
    }

    fn cast() -> (Person, Person, Person, Person) {
        (Person::new(1), Person::new(2), Person::new(3), Person::new(4))
    }

    #[test]
    fn a_roster_is_the_web_s_canonical_array_and_re_encodes_or_is_refused() {
        let (organizer, adult, ..) = cast();
        let owner = organizer.active(&[GroupRole::Members, GroupRole::Billing, GroupRole::Guardian]);
        let roster = family_roster(vec![owner.clone(), adult.active(&[])], &organizer);
        let statement = String::from_utf8(roster_bytes(&roster).unwrap()).unwrap();
        assert!(statement.starts_with(&format!(
            r#"["hushos/group/roster",1,"{GROUP}","family",1,"",1,"{}",[["#,
            organizer.user_id
        )));
        assert!(statement.contains(&format!(
            r#"["{}",1,"{}","{}","{}","{}","active",["billing","guardian","members"],1]"#,
            owner.user_id,
            owner.encryption_public_key,
            owner.signing_public_key,
            owner.ml_dsa_public_key_digest,
            owner.kem_public_key_digest
        )));
        assert_eq!(parse_roster(statement.as_bytes()).unwrap(), roster);
        for variant in [
            statement.replacen(r#""hushos/group/roster",1,"#, r#""hushos/group/roster", 1,"#, 1),
            statement.replacen(r#""family",1,"#, r#""family",1.0,"#, 1),
            statement.replacen(r#""family",1,"#, r#""family",9007199254740992,"#, 1),
            statement.replacen(r#""hushos/group/roster""#, r#""\u0068ushos/group/roster""#, 1),
            statement.replacen(GROUP, &GROUP.to_uppercase(), 1),
            format!("{statement}\n"),
        ] {
            assert!(parse_roster(variant.as_bytes()).is_err(), "{}", &variant[..90]);
        }
    }

    #[test]
    fn lists_ascend_without_repeats_a_family_has_no_company_roles_and_version_1_has_no_previous_digest() {
        let (organizer, adult, child, _) = cast();
        let base =
            family_roster(vec![organizer.active(&[GroupRole::Members]), adult.active(&[])], &organizer);
        let mut unsorted = base.clone();
        unsorted.members.reverse();
        let mut repeated = base.clone();
        repeated.members[1] = repeated.members[0].clone();
        let mut roles_unsorted = base.clone();
        roles_unsorted.members[0].roles = vec![GroupRole::Members, GroupRole::Billing];
        let mut roles_repeated = base.clone();
        roles_repeated.members[0].roles = vec![GroupRole::Members, GroupRole::Members];
        let mut company_role = base.clone();
        company_role.members[0].roles = vec![GroupRole::DataAdmin];
        let mut digest_on_one = base.clone();
        digest_on_one.previous_roster_digest = encode(&[7; 32]);
        let mut none_on_two = base.clone();
        none_on_two.roster_version = 2;
        let mut ahead = base.clone();
        ahead.members[0].since_version = 2;
        let mut hex = base.clone();
        hex.members[0].ml_dsa_public_key_digest = "07".repeat(32);
        let mut huge = base.clone();
        huge.group_key_version = 1 << 53;
        let mut upper = base.clone();
        upper.signer_user_id = organizer.user_id.to_uppercase();
        for (what, roster) in [
            ("unsorted", unsorted),
            ("repeated", repeated),
            ("roles unsorted", roles_unsorted),
            ("roles repeated", roles_repeated),
            ("company role", company_role),
            ("digest on 1", digest_on_one),
            ("none on 2", none_on_two),
            ("entry ahead", ahead),
            ("hex digest", hex),
            ("2^53", huge),
            ("uppercase id", upper),
        ] {
            assert!(roster_bytes(&roster).is_err(), "{what}");
        }
        let mut org = base.clone();
        org.kind = GroupKind::Org;
        org.members[0].roles = vec![GroupRole::DataAdmin, GroupRole::Members, GroupRole::Recovery];
        assert!(roster_bytes(&org).is_ok());
        let _ = child;
    }

    #[test]
    fn a_succession_names_the_next_version_only() {
        let (organizer, ..) = cast();
        let succession = GroupKeySuccession {
            group_id: GROUP.into(),
            old_version: 1,
            new_version: 2,
            old_ed25519_public_key: encode(&[1; 32]),
            old_ml_dsa_public_key: encode(&[2; 1952]),
            new_ed25519_public_key: encode(&[3; 32]),
            new_ml_dsa_public_key: encode(&[4; 1952]),
            last_roster_version: 3,
            last_roster_digest: encode(&[5; 32]),
            signer_user_id: organizer.user_id.clone(),
        };
        let statement = succession_bytes(&succession).unwrap();
        assert_eq!(parse_succession(&statement).unwrap(), succession);
        assert!(succession_bytes(&GroupKeySuccession { new_version: 3, ..succession.clone() }).is_err());
        let top =
            GroupKeySuccession { old_version: (1 << 53) - 1, new_version: 1 << 53, ..succession.clone() };
        assert!(succession_bytes(&top).is_err());
    }

    #[test]
    fn group_signatures_need_both_halves_under_the_group_context() {
        let seed = random(64);
        let key = group_public_key(seed.clone()).unwrap();
        let message = b"statement".to_vec();
        let signature = group_sign(seed.clone(), message.clone()).unwrap();
        assert!(verify_group(&key, &message, &signature));
        let mut broken = signature.clone();
        broken.ml_dsa[100] ^= 1;
        assert!(!verify_group(&key, &message, &broken), "valid Ed25519, broken ML-DSA");
        let mut broken = signature.clone();
        broken.ed25519[5] ^= 1;
        assert!(!verify_group(&key, &message, &broken), "broken Ed25519, valid ML-DSA");
        let identity_context = GroupSignature {
            ml_dsa: ml_dsa_sign(&seed[32..], &message, b"hushos/identity/v1").unwrap(),
            ..signature.clone()
        };
        assert!(!verify_group(&key, &message, &identity_context));
        // The group signature read as a person's hybrid signature by the same keys.
        let keys = HybridPublicKey {
            signing_public_key: decode("k", &key.ed25519_public_key, None).unwrap(),
            ml_dsa_public_key: decode("k", &key.ml_dsa_public_key, None).unwrap(),
        };
        assert!(!verify_hybrid(
            &keys,
            &message,
            &[signature.ed25519.clone(), signature.ml_dsa.clone()].concat()
        ));
        assert!(!verify_group(&group_public_key(random(64)).unwrap(), &message, &signature));
    }

    #[test]
    fn the_fingerprint_changes_with_either_key_and_the_group() {
        let key =
            GroupPublicKey { ed25519_public_key: encode(&[1; 32]), ml_dsa_public_key: encode(&[2; 1952]) };
        let prints: std::collections::HashSet<_> = [
            group_fingerprint(GROUP.into(), key.clone()).unwrap(),
            group_fingerprint(
                GROUP.into(),
                GroupPublicKey { ed25519_public_key: encode(&[3; 32]), ..key.clone() },
            )
            .unwrap(),
            group_fingerprint(
                GROUP.into(),
                GroupPublicKey { ml_dsa_public_key: encode(&[4; 1952]), ..key.clone() },
            )
            .unwrap(),
            group_fingerprint(OTHER_GROUP.into(), key.clone()).unwrap(),
        ]
        .into();
        assert_eq!(prints.len(), 4);
        assert!(group_fingerprint(GROUP.to_uppercase(), key).is_err());
    }

    /* A group's history being written, as a holder's client signs it. */
    pub(crate) struct History {
        pub(crate) rosters: Vec<SignedGroupStatement>,
        pub(crate) statements: Vec<Roster>,
        pub(crate) successions: Vec<SignedGroupStatement>,
        pub(crate) seeds: Vec<Vec<u8>>,
        pub(crate) kind: GroupKind,
    }

    impl History {
        pub(crate) fn new() -> History {
            History::of(GroupKind::Family)
        }

        pub(crate) fn of(kind: GroupKind) -> History {
            History {
                rosters: vec![],
                statements: vec![],
                successions: vec![],
                seeds: vec![group_seed_at(1)],
                kind,
            }
        }

        pub(crate) fn key(&self, version: u64) -> GroupPublicKey {
            group_public_key(self.seeds[(version - 1) as usize].clone()).unwrap()
        }

        /* Signs the next roster with `members` (each entry's since-version as roster_next sets it). */
        pub(crate) fn roster(
            &mut self,
            signer: &Person,
            members: Vec<RosterMember>,
            key_version: Option<u64>,
        ) {
            self.roster_with(signer, members, key_version, None);
        }

        /*
         * The same, with the area rows `areas` (only the areas this roster creates or rotates).
         * When none are given: standard_areas() on the first roster, a rotation of every area on a
         * family roster that marks someone left (as the removal must), and none otherwise.
         */
        pub(crate) fn roster_with(
            &mut self,
            signer: &Person,
            members: Vec<RosterMember>,
            key_version: Option<u64>,
            areas: Option<Vec<RosterArea>>,
        ) {
            let key_version = key_version.unwrap_or(self.seeds.len() as u64);
            let areas = areas.unwrap_or_else(|| match self.statements.last() {
                None => standard_areas(),
                Some(previous) => {
                    let leaving = members.iter().any(|member| {
                        member.status == MemberStatus::Left
                            && previous
                                .entry(&member.user_id)
                                .is_some_and(|before| before.status == MemberStatus::Active)
                    });
                    if self.kind != GroupKind::Family || !leaving {
                        return vec![];
                    }
                    let mut versions = std::collections::BTreeMap::<String, u64>::new();
                    for roster in &self.statements {
                        for row in &roster.areas {
                            versions.insert(row.workspace_id.clone(), row.workspace_key_version);
                        }
                    }
                    versions
                        .into_iter()
                        .map(|(workspace_id, at)| RosterArea {
                            commitment: area_key_commitment(&area_key_at(&workspace_id, at + 1)).unwrap(),
                            workspace_id,
                            workspace_key_version: at + 1,
                        })
                        .collect()
                }
            });
            // Built without roster_next's checks, so a test can write the histories a server, a
            // removed holder or a broken client might serve.
            let roster = match (self.statements.last(), self.rosters.last()) {
                (Some(previous), Some(signed)) => {
                    let version = previous.roster_version + 1;
                    let mut members: Vec<RosterMember> = members
                        .into_iter()
                        .map(|mut member| {
                            member.roles.sort();
                            member.since_version = match previous.entry(&member.user_id) {
                                Some(before)
                                    if before.key_version == member.key_version
                                        && before.encryption_public_key == member.encryption_public_key
                                        && before.signing_public_key == member.signing_public_key
                                        && before.ml_dsa_public_key_digest
                                            == member.ml_dsa_public_key_digest
                                        && before.kem_public_key_digest == member.kem_public_key_digest
                                        && before.status == member.status
                                        && before.roles == member.roles =>
                                {
                                    before.since_version
                                }
                                _ => version,
                            };
                            member
                        })
                        .collect();
                    members.sort_by(|a, b| a.user_id.cmp(&b.user_id));
                    Roster {
                        group_id: GROUP.into(),
                        kind: self.kind,
                        roster_version: version,
                        previous_roster_digest: digest(&signed.statement),
                        group_key_version: key_version,
                        signer_user_id: signer.user_id.clone(),
                        members,
                        areas: areas.clone(),
                    }
                }
                _ => {
                    let mut members: Vec<RosterMember> =
                        members.into_iter().map(|m| RosterMember { since_version: 1, ..m }).collect();
                    members.sort_by(|a, b| a.user_id.cmp(&b.user_id));
                    Roster {
                        group_id: GROUP.into(),
                        kind: self.kind,
                        roster_version: 1,
                        previous_roster_digest: String::new(),
                        group_key_version: key_version,
                        signer_user_id: signer.user_id.clone(),
                        members,
                        areas: areas.clone(),
                    }
                }
            };
            let signed = roster_sign(
                roster.clone(),
                self.seeds[(key_version - 1) as usize].clone(),
                signer.keys.clone(),
            )
            .unwrap();
            self.rosters.push(signed);
            self.statements.push(roster);
        }

        /* Replaces the latest group key, tied to the latest roster. */
        pub(crate) fn succession(&mut self, signer: &Person) {
            let from = self.seeds.len() as u64;
            let next = group_seed_at(from + 1);
            let (old, new) = (self.key(from), group_public_key(next.clone()).unwrap());
            let succession = GroupKeySuccession {
                group_id: GROUP.into(),
                old_version: from,
                new_version: from + 1,
                old_ed25519_public_key: old.ed25519_public_key,
                old_ml_dsa_public_key: old.ml_dsa_public_key,
                new_ed25519_public_key: new.ed25519_public_key,
                new_ml_dsa_public_key: new.ml_dsa_public_key,
                last_roster_version: self.rosters.len() as u64,
                last_roster_digest: digest(&self.rosters.last().unwrap().statement),
                signer_user_id: signer.user_id.clone(),
            };
            self.successions.push(
                group_succession_sign(succession, self.seeds.last().unwrap().clone(), signer.keys.clone())
                    .unwrap(),
            );
            self.seeds.push(next);
        }
    }

    /* A reader outside the group, with no entry of its own to check: what most tests accept as. */
    pub(crate) fn reader() -> crate::group_trust::OwnIdentities {
        crate::group_trust::OwnIdentities {
            user_id: "ffffffff-ffff-4fff-8fff-ffffffffffff".into(),
            identities: vec![],
        }
    }

    /* The served ML-DSA keys of everyone named, by their SHA-256, as accept_rosters takes them. */
    pub(crate) fn ml_dsa_keys(people: &[&Person]) -> std::collections::HashMap<String, String> {
        people.iter().map(|p| (digest(&p.ml_dsa()), p.keys.ml_dsa_public_key.clone().unwrap())).collect()
    }

    /* The accepted chain of `h`, as a newcomer accepts it. */
    pub(crate) fn accepted_of(h: &History, people: &[&Person]) -> Arc<AcceptedRosters> {
        match crate::group_trust::accept_rosters(
            GROUP.into(),
            h.key(1),
            true,
            vec![],
            h.rosters.clone(),
            h.successions.clone(),
            ml_dsa_keys(people),
            reader(),
            None,
        ) {
            Ok(crate::group_trust::RosterChain::Accepted { chain }) => chain,
            other => panic!("expected an accepted chain, got {other:?}"),
        }
    }

    /* Rosters `lists`, each signed by `signer` under the latest key, with a succession by `by` after `after`. */
    fn chain_of(
        signer: &Person,
        lists: Vec<Vec<RosterMember>>,
        succession: Option<(usize, &Person)>,
        kind: GroupKind,
        people: &[&Person],
    ) -> Arc<AcceptedRosters> {
        let mut h = History::of(kind);
        for (index, members) in lists.into_iter().enumerate() {
            h.roster(signer, members, None);
            if let Some((after, by)) = succession {
                if index + 1 == after {
                    h.succession(by);
                }
            }
        }
        accepted_of(&h, people)
    }

    fn owner(person: &Person) -> RosterMember {
        person.active(&[GroupRole::Billing, GroupRole::Guardian, GroupRole::Members])
    }

    #[test]
    fn the_group_key_opens_for_its_holder_from_an_active_members_holder_to_the_published_key() {
        let (organizer, adult, child, outsider) = cast();
        let people = [&organizer, &adult, &child, &outsider];
        let holders = || vec![owner(&organizer), adult.active(&[GroupRole::Members]), child.active(&[])];
        let family = |lists, succession| chain_of(&organizer, lists, succession, GroupKind::Family, &people);
        let chain = family(vec![holders()], None);
        let seed = group_seed_at(1);
        let ctx = GroupKeySealContext {
            group_id: GROUP.into(),
            group_key_version: 1,
            holder_user_id: adult.user_id.clone(),
            holder_key_version: 1,
            sealer_user_id: organizer.user_id.clone(),
            roster_version: chain.roster.roster_version,
            roster_digest: chain.roster_digest.clone(),
        };
        let seal = |ctx: &GroupKeySealContext,
                    seed: Vec<u8>,
                    chain: &Arc<AcceptedRosters>,
                    kem: Vec<u8>,
                    sealer: &Person| {
            group_key_seal(seed, ctx.clone(), chain.clone(), kem, sealer.keys.clone())
        };
        let open = |envelope: &[u8],
                    ctx: &GroupKeySealContext,
                    chain: &Arc<AcceptedRosters>,
                    ml_dsa: Vec<u8>,
                    holder: &Person| {
            group_key_open(
                envelope.to_vec(),
                ctx.clone(),
                chain.clone(),
                ml_dsa,
                None,
                holder.user_id.clone(),
                holder.keys.key_version,
                holder.keys.clone(),
            )
        };
        let envelope = seal(&ctx, seed.clone(), &chain, adult.kem(), &organizer).unwrap();
        assert_eq!(envelope.len(), GROUP_KEY_SEAL_BYTES);
        assert_eq!(open(&envelope, &ctx, &chain, organizer.ml_dsa(), &adult).unwrap(), seed);
        // A seed that does not derive the published key.
        let substitute = seal(&ctx, random(64), &chain, adult.kem(), &organizer).unwrap();
        let refused = open(&substitute, &ctx, &chain, organizer.ml_dsa(), &adult);
        assert!(matches!(refused, Err(CoreError::Sealed(m)) if m.contains("published key")));
        // A key version the verified chain does not reach.
        let v2 = GroupKeySealContext { group_key_version: 2, ..ctx.clone() };
        let beyond = seal(&v2, seed.clone(), &chain, adult.kem(), &organizer).unwrap();
        assert!(open(&beyond, &v2, &chain, organizer.ml_dsa(), &adult)
            .unwrap_err()
            .to_string()
            .contains("not one the group"));
        // A sealer who is no longer a members holder (and did not create the group).
        let by_adult = GroupKeySealContext {
            holder_user_id: organizer.user_id.clone(),
            sealer_user_id: adult.user_id.clone(),
            ..ctx.clone()
        };
        let adult_seal = seal(&by_adult, seed.clone(), &chain, organizer.kem(), &adult).unwrap();
        assert_eq!(open(&adult_seal, &by_adult, &chain, adult.ml_dsa(), &organizer).unwrap(), seed);
        let demoted =
            family(vec![holders(), vec![owner(&organizer), adult.active(&[]), child.active(&[])]], None);
        assert!(open(&adult_seal, &by_adult, &demoted, adult.ml_dsa(), &organizer).is_err());
        // The creator's version 1 seal opens only while they are active: once they have left,
        // their seals open nothing, version 1's included.
        let gone = organizer.entry(
            &[GroupRole::Billing, GroupRole::Guardian, GroupRole::Members],
            1,
            MemberStatus::Left,
        );
        // r11: the organizer's departure is the adult's to sign, a holder who stays.
        let mut leaving = History::new();
        leaving.roster(&organizer, holders(), None);
        leaving.roster(&adult, vec![gone, adult.active(&[GroupRole::Members]), child.active(&[])], None);
        leaving.succession(&adult);
        let left = accepted_of(&leaving, &[&organizer, &adult, &child, &outsider]);
        assert_eq!(left.creator_user_id, organizer.user_id);
        assert!(open(&envelope, &ctx, &left, organizer.ml_dsa(), &adult)
            .unwrap_err()
            .to_string()
            .contains("not sealed by a member"));
        let later_seal = seal(&v2, group_seed_at(2), &chain, adult.kem(), &organizer).unwrap();
        assert!(open(&later_seal, &v2, &left, organizer.ml_dsa(), &adult)
            .unwrap_err()
            .to_string()
            .contains("not sealed by a member"));
        // The sealer's ML-DSA key served as someone else's.
        assert!(open(&envelope, &ctx, &chain, outsider.ml_dsa(), &adult).is_err());
        // Never sealed to a non-holder, nor to a KEM key the entry does not name.
        let plain = family(vec![vec![owner(&organizer), adult.active(&[]), child.active(&[])]], None);
        let at_plain = GroupKeySealContext { roster_digest: plain.roster_digest.clone(), ..ctx.clone() };
        assert!(seal(&at_plain, seed.clone(), &plain, adult.kem(), &organizer)
            .unwrap_err()
            .to_string()
            .contains("only to members who hold it"));
        assert!(seal(&ctx, seed, &chain, outsider.kem(), &organizer).is_err());
    }

    /* The group key seed at `version` in every test history: fixed, so a test can seal under it. */
    pub(crate) fn group_seed_at(version: u64) -> Vec<u8> {
        (0..64u64).map(|i| (i * 31 + version * 7 + ((i * version) >> 3)) as u8).collect()
    }

    #[test]
    fn an_area_grant_opens_only_from_an_active_granter_of_this_group() {
        let (organizer, adult, child, _) = cast();
        let people = [&organizer, &adult, &child];
        let members = || vec![owner(&organizer), adult.active(&[]), child.active(&[])];
        let chain = chain_of(&organizer, vec![members()], None, GroupKind::Family, &people);
        let workspace_key = AREA_KEY.to_vec();
        let ctx = AreaGrantContext {
            group_id: GROUP.into(),
            workspace_id: AREA.into(),
            workspace_key_version: 1,
            grantee_user_id: adult.user_id.clone(),
            grantee_key_version: 1,
            granter_user_id: organizer.user_id.clone(),
            roster_version: chain.roster.roster_version,
            roster_digest: chain.roster_digest.clone(),
        };
        let envelope = area_grant_seal(
            workspace_key.clone(),
            ctx.clone(),
            chain.clone(),
            AREA_SEED.into(),
            adult.kem(),
            organizer.keys.clone(),
        )
        .unwrap();
        assert_eq!(envelope.len(), AREA_GRANT_BYTES);
        let open =
            |chain: &Arc<AcceptedRosters>, ctx: &AreaGrantContext, seed: &str, reader: &str, version: u64| {
                area_grant_open(
                    envelope.clone(),
                    ctx.clone(),
                    chain.clone(),
                    seed.into(),
                    organizer.ml_dsa(),
                    None,
                    reader.into(),
                    version,
                    adult.keys.clone(),
                )
            };
        assert_eq!(open(&chain, &ctx, AREA_SEED, &adult.user_id, 1).unwrap(), workspace_key);
        let gone = organizer.entry(
            &[GroupRole::Billing, GroupRole::Guardian, GroupRole::Members],
            1,
            MemberStatus::Left,
        );
        // r11: the organizer leaves on a roster another holder signs, and a holder remains.
        let mut leaving = History::new();
        leaving.roster(&organizer, members(), None);
        leaving.roster(
            &organizer,
            vec![owner(&organizer), adult.active(&[GroupRole::Members]), child.active(&[])],
            None,
        );
        leaving.roster(&adult, vec![gone, adult.active(&[GroupRole::Members]), child.active(&[])], None);
        let left = accepted_of(&leaving, &people);
        assert!(open(&left, &ctx, AREA_SEED, &adult.user_id, 1).is_err(), "a left granter");
        let elsewhere = AreaGrantContext { group_id: OTHER_GROUP.into(), ..ctx.clone() };
        assert_eq!(
            open(&chain, &elsewhere, AREA_SEED, &adult.user_id, 1).unwrap_err().to_string(),
            "This is for another group."
        );
        // A version the roster does not list (r9): refused before anything is opened.
        let other_version = AreaGrantContext { workspace_key_version: 4, ..ctx.clone() };
        assert_eq!(
            open(&chain, &other_version, AREA_SEED, &adult.user_id, 1).unwrap_err().to_string(),
            "This area key version is not on the group’s member list."
        );
        assert!(open(&chain, &ctx, AREA_SEED, &child.user_id, 1).is_err(), "another reader");
        assert!(open(&chain, &ctx, AREA_SEED, &adult.user_id, 2).is_err(), "another key version");
        // A workspace not derived under the group: another group's area, or this one's id with another seed.
        let foreign = AreaGrantContext { workspace_id: OTHER_AREA.into(), ..ctx.clone() };
        let refused = open(&chain, &foreign, OTHER_AREA_SEED, &adult.user_id, 1).unwrap_err();
        assert_eq!(refused.to_string(), "This area does not belong to the group.");
        let refused = open(&chain, &ctx, OTHER_AREA_SEED, &adult.user_id, 1).unwrap_err();
        assert_eq!(refused.to_string(), "This area does not belong to the group.");
        let sealed = area_grant_seal(
            random(32),
            foreign,
            chain,
            OTHER_AREA_SEED.into(),
            adult.kem(),
            organizer.keys.clone(),
        );
        assert_eq!(sealed.unwrap_err().to_string(), "This area does not belong to the group.");
    }

    #[test]
    fn r10_decision_4_after_the_area_rotates_its_earlier_grants_still_open_in_either_order() {
        let (organizer, adult, child, _) = cast();
        let people = [&organizer, &adult, &child];
        let members = || vec![owner(&organizer), adult.active(&[]), child.active(&[])];
        let first = chain_of(&organizer, vec![members()], None, GroupKind::Family, &people);
        let ctx = AreaGrantContext {
            group_id: GROUP.into(),
            workspace_id: AREA.into(),
            workspace_key_version: 1,
            grantee_user_id: adult.user_id.clone(),
            grantee_key_version: 1,
            granter_user_id: organizer.user_id.clone(),
            roster_version: first.roster.roster_version,
            roster_digest: first.roster_digest.clone(),
        };
        let seal = |key: Vec<u8>, ctx: &AreaGrantContext, chain: &Arc<AcceptedRosters>| {
            area_grant_seal(
                key,
                ctx.clone(),
                chain.clone(),
                AREA_SEED.into(),
                adult.kem(),
                organizer.keys.clone(),
            )
            .unwrap()
        };
        let earlier = seal(AREA_KEY.to_vec(), &ctx, &first);
        // The child leaves: the family's removal rotates AREA to version 2 on the same roster.
        let rotated = chain_of(
            &organizer,
            vec![
                members(),
                vec![owner(&organizer), adult.active(&[]), child.entry(&[], 1, MemberStatus::Left)],
            ],
            None,
            GroupKind::Family,
            &people,
        );
        assert_eq!(area_write_version(rotated.clone(), AREA.into()), Some(2));
        let later = AreaGrantContext {
            workspace_key_version: 2,
            roster_version: rotated.roster.roster_version,
            roster_digest: rotated.roster_digest.clone(),
            ..ctx.clone()
        };
        let sealed = seal(area_key_at(AREA, 2), &later, &rotated);
        let open = |envelope: Vec<u8>, ctx: &AreaGrantContext| {
            area_grant_open(
                envelope,
                ctx.clone(),
                rotated.clone(),
                AREA_SEED.into(),
                organizer.ml_dsa(),
                None,
                adult.user_id.clone(),
                1,
                adult.keys.clone(),
            )
            .unwrap()
        };
        assert_eq!(open(sealed, &later), area_key_at(AREA, 2));
        // No high-water mark: the version 1 grant opens after the version 2 one has.
        assert_eq!(open(earlier, &ctx), AREA_KEY.to_vec());
    }

    #[test]
    fn a_seal_under_another_kind_s_info_or_context_opens_as_nothing() {
        let (organizer, adult, ..) = cast();
        let chain = chain_of(
            &organizer,
            vec![vec![owner(&organizer), adult.active(&[])]],
            None,
            GroupKind::Family,
            &[&organizer, &adult],
        );
        let ctx = AreaGrantContext {
            group_id: GROUP.into(),
            workspace_id: AREA.into(),
            workspace_key_version: 1,
            grantee_user_id: adult.user_id.clone(),
            grantee_key_version: 1,
            granter_user_id: organizer.user_id.clone(),
            roster_version: chain.roster.roster_version,
            roster_digest: chain.roster_digest.clone(),
        };
        let statement = |sealed: &[u8]| area_grant_statement(ctx.clone(), sealed.to_vec());
        let recipient = decode("k", &adult.keys.encryption_public_key, Some(32)).unwrap();
        let sealed_with = |key: &[u8], info: &[u8], associated_data: Vec<u8>| {
            let kind = SealKind {
                info,
                associated_data,
                statement: &statement,
                noun: "grant",
                invalid: "x",
                unsigned: "x",
            };
            seal_hybrid(key, &recipient, &adult.kem(), &organizer.keys, &kind).unwrap()
        };
        let open = |envelope: Vec<u8>| {
            area_grant_open(
                envelope,
                ctx.clone(),
                chain.clone(),
                AREA_SEED.into(),
                organizer.ml_dsa(),
                None,
                adult.user_id.clone(),
                1,
                adult.keys.clone(),
            )
        };
        let sealed_as = |info: &[u8], associated_data: Vec<u8>| sealed_with(&AREA_KEY, info, associated_data);
        let context = area_grant_context(&ctx).unwrap();
        assert!(matches!(open(sealed_as(KEY_SEAL_INFO, context.clone())), Err(CoreError::Sealed(_))));
        let other =
            area_grant_context(&AreaGrantContext { workspace_key_version: 9, ..ctx.clone() }).unwrap();
        assert!(matches!(open(sealed_as(AREA_GRANT_INFO, other)), Err(CoreError::Sealed(_))));
        assert_eq!(open(sealed_as(AREA_GRANT_INFO, context.clone())).unwrap(), AREA_KEY.to_vec());
        // r9: the same, delivering another key under the listed version: the commitment refuses it
        // (only a granter who skipped area_grant_seal's own check can make one).
        assert_eq!(
            open(sealed_with(&[9; 32], AREA_GRANT_INFO, context)).unwrap_err().to_string(),
            "This area key is not the one the group’s member list names."
        );
    }

    #[test]
    fn a_seal_from_before_the_sealer_s_identity_was_folded_in_still_opens_through_their_chain_a_planted_key_never(
    ) {
        let (organizer, adult, _, outsider) = cast();
        let (adult2, link) = adult.succeed();
        let own = owner(&organizer);
        let mut h = History::new();
        h.roster(&organizer, vec![own.clone(), adult.active(&[GroupRole::Members])], None);
        let before = accepted_of(&h, &[&organizer, &adult]);
        // A holder writes the outsider's keys as the adult's for one roster, then the adult's next
        // identity is folded in.
        h.roster(
            &organizer,
            vec![
                own.clone(),
                RosterMember { user_id: adult.user_id.clone(), ..outsider.active(&[GroupRole::Members]) },
            ],
            None,
        );
        let planted = accepted_of(&h, &[&organizer, &adult, &outsider]);
        h.roster(&organizer, vec![own, adult2.active(&[GroupRole::Members])], None);
        let after = accepted_of(&h, &[&organizer, &adult, &outsider, &adult2]);
        let seed = group_seed_at(1);
        let ctx = GroupKeySealContext {
            group_id: GROUP.into(),
            group_key_version: 1,
            holder_user_id: organizer.user_id.clone(),
            holder_key_version: 1,
            sealer_user_id: adult.user_id.clone(),
            roster_version: before.roster.roster_version,
            roster_digest: before.roster_digest.clone(),
        };
        let at_planted = GroupKeySealContext {
            roster_version: planted.roster.roster_version,
            roster_digest: planted.roster_digest.clone(),
            ..ctx.clone()
        };
        let by_adult =
            group_key_seal(seed.clone(), ctx.clone(), before.clone(), organizer.kem(), adult.keys.clone())
                .unwrap();
        let by_planted =
            group_key_seal(seed.clone(), at_planted.clone(), planted, organizer.kem(), outsider.keys.clone())
                .unwrap();
        let history = SignerHistory { served: adult2.served_keys(), links: vec![link.clone()] };
        let open = |envelope: &[u8], history: Option<SignerHistory>| {
            group_key_open(
                envelope.to_vec(),
                if envelope == by_planted.as_slice() { at_planted.clone() } else { ctx.clone() },
                after.clone(),
                adult2.ml_dsa(),
                history,
                organizer.user_id.clone(),
                organizer.keys.key_version,
                organizer.keys.clone(),
            )
        };
        assert_eq!(open(&by_adult, Some(history.clone())).unwrap().to_vec(), seed);
        assert!(open(&by_adult, None)
            .unwrap_err()
            .to_string()
            .contains("not sealed by a member who holds it"));
        assert!(open(&by_planted, Some(history.clone()))
            .unwrap_err()
            .to_string()
            .contains("not sealed by a member who holds it"));
        // A link served in front naming the adult's old X25519 and Ed25519 keys with the outsider's
        // ML-DSA key is not on the verified chain, and lends the outsider nothing.
        let fake = SuccessionLink {
            old_ml_dsa_public_key: outsider.served().ml_dsa_public_key,
            signature: encode(&[0u8; 3373]),
            ..link.clone()
        };
        let faked = SignerHistory { links: vec![fake, link.clone()], ..history.clone() };
        assert!(open(&by_planted, Some(faked)).is_err());
        // Nor does an unsigned link from the planted keys themselves: only links on a verified chain count.
        let from_planted = SuccessionLink {
            old_encryption_public_key: outsider.served().encryption_public_key,
            old_signing_public_key: outsider.served().signing_public_key,
            old_ml_dsa_public_key: outsider.served().ml_dsa_public_key,
            signature: encode(&[0u8; 3373]),
            ..link.clone()
        };
        let planted_link = SignerHistory { links: vec![from_planted, link], ..history.clone() };
        assert!(open(&by_planted, Some(planted_link)).is_err());
        // The same for an area grant.
        let workspace_key = AREA_KEY.to_vec();
        let grant_ctx = AreaGrantContext {
            group_id: GROUP.into(),
            workspace_id: AREA.into(),
            workspace_key_version: 1,
            grantee_user_id: organizer.user_id.clone(),
            grantee_key_version: 1,
            granter_user_id: adult.user_id.clone(),
            roster_version: before.roster.roster_version,
            roster_digest: before.roster_digest.clone(),
        };
        let grant = area_grant_seal(
            workspace_key.clone(),
            grant_ctx.clone(),
            before,
            AREA_SEED.into(),
            organizer.kem(),
            adult.keys.clone(),
        )
        .unwrap();
        let open_grant = |history: Option<SignerHistory>| {
            area_grant_open(
                grant.clone(),
                grant_ctx.clone(),
                after.clone(),
                AREA_SEED.into(),
                adult2.ml_dsa(),
                history,
                organizer.user_id.clone(),
                1,
                organizer.keys.clone(),
            )
        };
        assert_eq!(open_grant(Some(history)).unwrap(), workspace_key);
        assert!(open_grant(None).is_err());
    }

    #[test]
    fn r6_a_planted_key_never_grants_as_the_member_a_replaced_identity_seals_only_once_folded_in() {
        let (o, g, planted) = (Person::new(1), Person::new(2), Person::new(9));
        let child = Person::at(4, 2);
        let own = owner(&o);
        let mut h = History::new();
        h.roster(&o, vec![own.clone(), g.active(&[GroupRole::Guardian]), child.active(&[])], None);
        h.roster(
            &o,
            vec![
                own.clone(),
                g.active(&[GroupRole::Guardian]),
                RosterMember { user_id: child.user_id.clone(), ..planted.active(&[]) },
            ],
            None,
        );
        let while_planted = accepted_of(&h, &[&o, &g, &child, &planted]);
        h.roster(
            &o,
            vec![own.clone(), g.active(&[GroupRole::Guardian]), child.entry(&[], 3, MemberStatus::Active)],
            None,
        );
        let chain = accepted_of(&h, &[&o, &g, &child, &planted]);
        // The planter's link from the planted keys to the child's: it verifies, but the planted set
        // is not where the child's chain starts.
        let mut planted_link = SuccessionLink {
            old_key_version: 1,
            new_key_version: 2,
            old_encryption_public_key: planted.served().encryption_public_key,
            old_signing_public_key: planted.served().signing_public_key,
            old_ml_dsa_public_key: planted.served().ml_dsa_public_key,
            new_encryption_public_key: child.served().encryption_public_key,
            new_signing_public_key: child.served().signing_public_key,
            new_ml_dsa_public_key: child.served().ml_dsa_public_key,
            new_kem_public_key: child.served().kem_public_key,
            signature: String::new(),
            consent: None,
        };
        let statement =
            crate::signatures::succession_statement(child.user_id.clone(), planted_link.clone()).unwrap();
        planted_link.signature =
            encode(&sign_hybrid(&planted.keys.signing_seed, &planted.keys.ml_dsa_seed, &statement).unwrap());
        let grant_ctx = AreaGrantContext {
            group_id: GROUP.into(),
            workspace_id: AREA.into(),
            workspace_key_version: 1,
            grantee_user_id: g.user_id.clone(),
            grantee_key_version: 1,
            granter_user_id: child.user_id.clone(),
            roster_version: while_planted.roster.roster_version,
            roster_digest: while_planted.roster_digest.clone(),
        };
        let history = SignerHistory { served: child.served_keys(), links: vec![planted_link] };
        let by_planted = area_grant_seal(
            AREA_KEY.to_vec(),
            grant_ctx.clone(),
            while_planted,
            AREA_SEED.into(),
            g.kem(),
            planted.keys.clone(),
        )
        .unwrap();
        assert!(area_grant_open(
            by_planted,
            grant_ctx.clone(),
            chain.clone(),
            AREA_SEED.into(),
            child.ml_dsa(),
            Some(history),
            g.user_id.clone(),
            1,
            g.keys.clone()
        )
        .unwrap_err()
        .to_string()
        .contains("not signed by the member who made it"));
        // Once the child's own entry is back, the planted keys grant nothing.
        assert!(area_grant_seal(
            AREA_KEY.to_vec(),
            AreaGrantContext {
                roster_version: chain.roster.roster_version,
                roster_digest: chain.roster_digest.clone(),
                ..grant_ctx
            },
            chain,
            AREA_SEED.into(),
            g.kem(),
            planted.keys.clone()
        )
        .unwrap_err()
        .to_string()
        .contains("not the sealer’s keys"));
        // The organizer replaced their identity: until a roster folds it in, the new keys seal
        // nothing, and a seal made under them elsewhere does not open here, history or not.
        let (o2, link) = o.succeed();
        let mut m = History::new();
        m.roster(&o, vec![own, g.active(&[GroupRole::Members])], None);
        let members = accepted_of(&m, &[&o, &g]);
        let key_ctx = GroupKeySealContext {
            group_id: GROUP.into(),
            group_key_version: 1,
            holder_user_id: g.user_id.clone(),
            holder_key_version: 1,
            sealer_user_id: o.user_id.clone(),
            roster_version: members.roster.roster_version,
            roster_digest: members.roster_digest.clone(),
        };
        let o_history = SignerHistory { served: o2.served_keys(), links: vec![link.clone()] };
        let seed = group_seed_at(1);
        assert!(group_key_seal(seed.clone(), key_ctx.clone(), members.clone(), g.kem(), o2.keys.clone())
            .unwrap_err()
            .to_string()
            .contains("not the sealer’s keys"));
        m.roster(&o, vec![owner(&o2), g.active(&[GroupRole::Members])], None);
        let folded = accepted_of(&m, &[&o, &o2, &g]);
        let key_ctx = GroupKeySealContext {
            roster_version: folded.roster.roster_version,
            roster_digest: folded.roster_digest.clone(),
            ..key_ctx
        };
        let by_new =
            group_key_seal(seed.clone(), key_ctx.clone(), folded.clone(), g.kem(), o2.keys.clone()).unwrap();
        let open =
            |chain: &Arc<AcceptedRosters>, history: Option<SignerHistory>, reader: &str, version: u64| {
                group_key_open(
                    by_new.clone(),
                    key_ctx.clone(),
                    chain.clone(),
                    o2.ml_dsa(),
                    history,
                    reader.to_string(),
                    version,
                    g.keys.clone(),
                )
            };
        assert_eq!(open(&folded, None, &g.user_id, 1).unwrap().to_vec(), seed);
        // Not on a chain short of the roster that folded the new keys in (r8: seals name it).
        assert!(open(&members, Some(o_history.clone()), &g.user_id, 1)
            .unwrap_err()
            .to_string()
            .contains("sealed on a member list this device does not have"));
        // Junk appended to the history changes nothing.
        let junk = SuccessionLink { signature: encode(&[0u8; 3373]), ..link.clone() };
        let junked = SignerHistory { links: vec![link, junk], ..o_history };
        assert_eq!(open(&folded, Some(junked), &g.user_id, 1).unwrap().to_vec(), seed);
        // A key seal opens only for the holder it names, at their key version.
        assert!(open(&folded, None, &o.user_id, 1)
            .unwrap_err()
            .to_string()
            .contains("not sealed to this account"));
        assert!(open(&folded, None, &g.user_id, 2)
            .unwrap_err()
            .to_string()
            .contains("not sealed to this account"));
    }

    #[test]
    fn r7_only_an_active_holder_seals_under_both_keys_its_entry_names_a_forked_identity_lends_no_history() {
        let (o, a, g, outsider) = (Person::new(1), Person::new(2), Person::new(3), Person::new(5));
        let own = owner(&o);
        let mut h = History::new();
        h.roster(&o, vec![own.clone(), a.active(&[GroupRole::Members]), g.active(&[])], None);
        let chain = accepted_of(&h, &[&o, &a, &g]);
        h.roster(
            &o,
            vec![own.clone(), a.entry(&[GroupRole::Members], 2, MemberStatus::Left), g.active(&[])],
            None,
        );
        let left = accepted_of(&h, &[&o, &a, &g]);
        // Each seal names the sealer's latest accepted roster, `at`.
        let key_ctx = |sealer: &Person, at: &AcceptedRosters| GroupKeySealContext {
            group_id: GROUP.into(),
            group_key_version: 1,
            holder_user_id: o.user_id.clone(),
            holder_key_version: 1,
            sealer_user_id: sealer.user_id.clone(),
            roster_version: at.roster.roster_version,
            roster_digest: at.roster_digest.clone(),
        };
        let seed = group_seed_at(1);
        let seal = |chain: &Arc<AcceptedRosters>, sealer: &Person, keys: IdentityKeys| {
            group_key_seal(seed.clone(), key_ctx(sealer, chain), chain.clone(), o.kem(), keys)
        };
        let refuses = |result: CoreResult<Vec<u8>>, why: &str| {
            assert!(result.unwrap_err().to_string().contains(why), "{why}");
        };
        // Not a holder (g has no Members), or a holder who has left: no key seal.
        refuses(seal(&chain, &g, g.keys.clone()), "sealed only by a member who holds it");
        refuses(seal(&left, &a, a.keys.clone()), "sealed only by a member who holds it");
        // The entry's Ed25519 key with another ML-DSA key: not the sealer's keys.
        let half_other = IdentityKeys { ml_dsa_seed: outsider.keys.ml_dsa_seed.clone(), ..a.keys.clone() };
        refuses(seal(&chain, &a, half_other), "not the sealer’s keys");
        // A grant from someone who has left: refused before anything is sealed.
        let grant_ctx = AreaGrantContext {
            group_id: GROUP.into(),
            workspace_id: AREA.into(),
            workspace_key_version: 1,
            grantee_user_id: g.user_id.clone(),
            grantee_key_version: 1,
            granter_user_id: a.user_id.clone(),
            roster_version: left.roster.roster_version,
            roster_digest: left.roster_digest.clone(),
        };
        refuses(
            area_grant_seal(vec![77; 32], grant_ctx, left, AREA_SEED.into(), g.kem(), a.keys.clone()),
            "granted only by active members",
        );
        // A seal from before a's identity changed opens with their history, unless a second
        // successor they signed from the same key makes it a fork: then no history counts.
        let by_a = seal(&chain, &a, a.keys.clone()).unwrap();
        let (a2, link) = a.succeed();
        let (_, second) = a.succeed();
        let mut g2 = History::new();
        g2.roster(&o, vec![own.clone(), a.active(&[GroupRole::Members]), g.active(&[])], None);
        g2.roster(&o, vec![own.clone(), a2.active(&[GroupRole::Members]), g.active(&[])], None);
        let folded = accepted_of(&g2, &[&o, &a, &a2, &g]);
        let open_on = |envelope: &[u8],
                       at: GroupKeySealContext,
                       on: Arc<AcceptedRosters>,
                       served: &Person,
                       links: Vec<SuccessionLink>| {
            group_key_open(
                envelope.to_vec(),
                at,
                on,
                served.ml_dsa(),
                Some(SignerHistory { served: served.served_keys(), links }),
                o.user_id.clone(),
                1,
                o.keys.clone(),
            )
        };
        let at_chain = key_ctx(&a, &chain);
        assert_eq!(
            open_on(&by_a, at_chain.clone(), folded.clone(), &a2, vec![link.clone()]).unwrap().to_vec(),
            seed
        );
        for links in [vec![link.clone(), second.clone()], vec![second.clone(), link.clone()]] {
            assert!(open_on(&by_a, at_chain.clone(), folded.clone(), &a2, links)
                .unwrap_err()
                .to_string()
                .contains("not sealed by a member who holds it"));
        }
        // a2 replaced in turn (not folded in). A seal under a2's keys, the entry's, still opens with
        // a3 served; a3 seals nothing until a roster folds it in.
        let (a3, link23) = a2.succeed();
        let by_a2 = seal(&folded, &a, a2.keys.clone()).unwrap();
        let at_folded = key_ctx(&a, &folded);
        assert_eq!(
            open_on(&by_a2, at_folded, folded.clone(), &a3, vec![link.clone(), link23.clone()])
                .unwrap()
                .to_vec(),
            seed
        );
        refuses(seal(&folded, &a, a3.keys.clone()), "not the sealer’s keys");
        // a3 folded in at 3 and sealing there; 4 puts a2 back. a3's seal opens neither on a chain
        // short of roster 3 nor on the one whose entry is a2 again: keys past the entry's never
        // count, a3 served or a4 beyond it.
        g2.roster(&o, vec![own.clone(), a3.active(&[GroupRole::Members]), g.active(&[])], None);
        let with_a3 = accepted_of(&g2, &[&o, &a, &a2, &a3, &g]);
        let at_a3 = key_ctx(&a, &with_a3);
        let by_a3 = seal(&with_a3, &a, a3.keys.clone()).unwrap();
        assert!(open_on(&by_a3, at_a3.clone(), folded.clone(), &a3, vec![link.clone(), link23.clone()])
            .unwrap_err()
            .to_string()
            .contains("sealed on a member list this device does not have"));
        g2.roster(&o, vec![own, a2.active(&[GroupRole::Members]), g.active(&[])], None);
        let rolled_back = accepted_of(&g2, &[&o, &a, &a2, &a3, &g]);
        assert!(open_on(&by_a3, at_a3.clone(), rolled_back.clone(), &a3, vec![link.clone(), link23.clone()])
            .unwrap_err()
            .to_string()
            .contains("not sealed by a member who holds it"));
        let (a4, link34) = a3.succeed();
        assert!(open_on(&by_a3, at_a3, rolled_back, &a4, vec![link.clone(), link23, link34])
            .unwrap_err()
            .to_string()
            .contains("not sealed by a member who holds it"));
        // While a holder's planted keys are a's entry, a's real chain (a to a2) never reaches the
        // entry, so it vouches for none of a's keys: a's own earlier seal does not open.
        let mut p = History::new();
        p.roster(&o, vec![owner(&o), a.active(&[GroupRole::Members]), g.active(&[])], None);
        p.roster(
            &o,
            vec![
                owner(&o),
                RosterMember { user_id: a.user_id.clone(), ..outsider.active(&[GroupRole::Members]) },
                g.active(&[]),
            ],
            None,
        );
        assert!(open_on(&by_a, at_chain, accepted_of(&p, &[&o, &a, &outsider, &g]), &a2, vec![link])
            .unwrap_err()
            .to_string()
            .contains("not the ones on the group’s member list"));
    }

    #[test]
    fn a_member_signature_through_the_roster_needs_the_ml_dsa_key_the_entry_names() {
        let (organizer, _, _, outsider) = cast();
        let chain =
            chain_of(&organizer, vec![vec![owner(&organizer)]], None, GroupKind::Family, &[&organizer]);
        let message = b"roster".to_vec();
        // The organizer's Ed25519 half beside the outsider's ML-DSA half, with the
        // outsider's ML-DSA key served as the organizer's.
        let forged = sign_hybrid(&organizer.keys.signing_seed, &outsider.keys.ml_dsa_seed, &message).unwrap();
        assert!(!roster_member_verify(
            chain.clone(),
            organizer.user_id.clone(),
            outsider.ml_dsa(),
            message.clone(),
            forged
        ));
        assert!(roster_member_signer(chain.clone(), organizer.user_id.clone(), outsider.ml_dsa()).is_err());
        let genuine =
            sign_hybrid(&organizer.keys.signing_seed, &organizer.keys.ml_dsa_seed, &message).unwrap();
        assert!(roster_member_verify(chain, organizer.user_id.clone(), organizer.ml_dsa(), message, genuine));
    }

    /* Round 8 */

    #[test]
    fn r8_opus_6_the_sealer_s_ed25519_key_comes_from_its_seed() {
        let (o, a, outsider) = (Person::new(1), Person::new(2), Person::new(5));
        let mut h = History::new();
        h.roster(&o, vec![owner(&o), a.active(&[GroupRole::Members])], None);
        let chain = accepted_of(&h, &[&o, &a]);
        let ctx = GroupKeySealContext {
            group_id: GROUP.into(),
            group_key_version: 1,
            holder_user_id: o.user_id.clone(),
            holder_key_version: 1,
            sealer_user_id: a.user_id.clone(),
            roster_version: chain.roster.roster_version,
            roster_digest: chain.roster_digest.clone(),
        };
        let seal =
            |keys: IdentityKeys| group_key_seal(group_seed_at(1), ctx.clone(), chain.clone(), o.kem(), keys);
        // The outsider's seed under a's public key on its face: refused, as the seed decides.
        let mixed = IdentityKeys { signing_seed: outsider.keys.signing_seed.clone(), ..a.keys.clone() };
        assert!(seal(mixed).unwrap_err().to_string().contains("not the sealer’s keys"));
        // a's seed with another public key on its face: the seed decides, so it seals.
        let face =
            IdentityKeys { signing_public_key: outsider.keys.signing_public_key.clone(), ..a.keys.clone() };
        assert_eq!(seal(face).unwrap().len(), GROUP_KEY_SEAL_BYTES);
    }

    #[test]
    fn r8_fable_f2_seals_name_the_sealer_s_latest_roster_and_another_group_s_context_is_refused_as_such() {
        let (o, a) = (Person::new(1), Person::new(2));
        let mut h = History::new();
        h.roster(&o, vec![owner(&o), a.active(&[GroupRole::Members])], None);
        let one = accepted_of(&h, &[&o, &a]);
        h.roster(&o, vec![owner(&o), a.active(&[GroupRole::Members, GroupRole::Billing])], None);
        let two = accepted_of(&h, &[&o, &a]);
        let ctx = |at: &AcceptedRosters, group_id: &str| GroupKeySealContext {
            group_id: group_id.into(),
            group_key_version: 1,
            holder_user_id: a.user_id.clone(),
            holder_key_version: 1,
            sealer_user_id: o.user_id.clone(),
            roster_version: at.roster.roster_version,
            roster_digest: at.roster_digest.clone(),
        };
        let seal = |at: &AcceptedRosters, on: &Arc<AcceptedRosters>, group_id: &str| {
            group_key_seal(group_seed_at(1), ctx(at, group_id), on.clone(), a.kem(), o.keys.clone())
        };
        let refuses = |result: CoreResult<Vec<u8>>, why: &str| {
            assert!(result.unwrap_err().to_string().contains(why), "{why}");
        };
        refuses(seal(&one, &two, GROUP), "names the latest member list");
        refuses(seal(&two, &two, OTHER_GROUP), "This is for another group.");
        let at_one = seal(&one, &one, GROUP).unwrap();
        let open = |envelope: &[u8], at: GroupKeySealContext, on: &Arc<AcceptedRosters>| {
            group_key_open(
                envelope.to_vec(),
                at,
                on.clone(),
                o.ml_dsa(),
                None,
                a.user_id.clone(),
                1,
                a.keys.clone(),
            )
            .map(|seed| seed.to_vec())
        };
        assert_eq!(open(&at_one, ctx(&one, GROUP), &two).unwrap(), group_seed_at(1));
        assert!(open(&at_one, ctx(&one, OTHER_GROUP), &two)
            .unwrap_err()
            .to_string()
            .contains("This is for another group."));
        let at_two = seal(&two, &two, GROUP).unwrap();
        assert!(open(&at_two, ctx(&two, GROUP), &one)
            .unwrap_err()
            .to_string()
            .contains("sealed on a member list this device does not have"));
        let wrong_digest =
            GroupKeySealContext { roster_digest: two.roster_digest.clone(), ..ctx(&one, GROUP) };
        assert!(open(&at_one, wrong_digest, &two)
            .unwrap_err()
            .to_string()
            .contains("sealed on a member list this device does not have"));
        let grant = AreaGrantContext {
            group_id: OTHER_GROUP.into(),
            workspace_id: AREA.into(),
            workspace_key_version: 1,
            grantee_user_id: a.user_id.clone(),
            grantee_key_version: 1,
            granter_user_id: o.user_id.clone(),
            roster_version: two.roster.roster_version,
            roster_digest: two.roster_digest.clone(),
        };
        refuses(
            area_grant_seal(vec![1; 32], grant, two.clone(), AREA_SEED.into(), a.kem(), o.keys.clone()),
            "This is for another group.",
        );
    }

    #[test]
    fn r8_codex_3_a_roster_has_at_most_max_roster_members_entries() {
        let o = Person::new(1);
        let entry = owner(&o);
        let members: Vec<RosterMember> = (0..=MAX_ROSTER_MEMBERS)
            .map(|i| RosterMember {
                user_id: format!("{i:08x}-abcd-4abc-8abc-abcdefabcdef"),
                ..entry.clone()
            })
            .collect();
        let roster = Roster {
            group_id: GROUP.into(),
            kind: GroupKind::Org,
            roster_version: 1,
            previous_roster_digest: String::new(),
            group_key_version: 1,
            signer_user_id: members[0].user_id.clone(),
            members: members[..MAX_ROSTER_MEMBERS].to_vec(),
            areas: vec![],
        };
        let bytes = roster_statement(roster.clone()).unwrap();
        assert_eq!(roster_parse(bytes.clone()).unwrap().members.len(), MAX_ROSTER_MEMBERS);
        assert!(roster_statement(Roster { members: members.clone(), ..roster }).is_err());
        let mut over: Vec<Value> = serde_json::from_slice(&bytes).unwrap();
        let mut last = over[8].as_array().unwrap().last().unwrap().clone();
        last[0] = json!(members[MAX_ROSTER_MEMBERS].user_id);
        over[8].as_array_mut().unwrap().push(last);
        let over = Value::Array(over).to_string().into_bytes();
        assert!(roster_parse(over).unwrap_err().to_string().contains("Invalid roster members."));
    }

    const SECOND_AREA: &str = "a0558a81-8dfc-4914-8447-0417b55e2ec5";

    #[test]
    fn r12_an_area_key_commitment_is_hkdf_of_the_key_alone_under_the_v2_info() {
        // Known answer, computed apart from either twin: HKDF-SHA-256(32 bytes of 7, salt 32 zero
        // bytes, info "hushos/group/area-key/v2"), base64url.
        assert_eq!(area_key_commitment(&[7u8; 32]).unwrap(), "QeVVJkoRU9t43GAdo9MEOT7DgN0pnhyEEctuo9nXDnY");
        assert_ne!(area_key_commitment(&[78; 32]).unwrap(), area_key_commitment(&AREA_KEY).unwrap());
        assert!(area_key_commitment(&[77; 31]).is_err());
        assert!(area_key_commitment(&[77; 33]).is_err());
    }

    #[test]
    fn r9_opus_1_a_roster_lists_each_area_once_at_its_current_key_sorted_by_workspace_id() {
        let o = Person::new(1);
        let roster = family_roster(vec![owner(&o)], &o);
        let standard = standard_areas();
        let second = RosterArea {
            workspace_id: SECOND_AREA.into(),
            workspace_key_version: 4,
            commitment: area_key_commitment(&[79; 32]).unwrap(),
        };
        let listed = Roster { areas: vec![standard[0].clone(), second.clone()], ..roster.clone() };
        let statement = String::from_utf8(roster_statement(listed.clone()).unwrap()).unwrap();
        assert!(statement.ends_with(&format!(
            ",[[\"{AREA}\",1,\"{}\"],[\"{SECOND_AREA}\",4,\"{}\"]]]",
            standard[0].commitment, second.commitment
        )));
        assert_eq!(roster_parse(statement.clone().into_bytes()).unwrap(), listed);
        assert!(String::from_utf8(roster_statement(roster.clone()).unwrap()).unwrap().ends_with(",[]]"));
        for areas in [
            vec![standard[0].clone(), standard[0].clone()],
            vec![second.clone(), standard[0].clone()],
            vec![standard[0].clone(), RosterArea { workspace_id: AREA.into(), ..second.clone() }],
            vec![RosterArea { commitment: "AA".into(), ..standard[0].clone() }],
            vec![RosterArea { workspace_id: AREA.to_uppercase(), ..standard[0].clone() }],
            vec![RosterArea { workspace_key_version: 0, ..standard[0].clone() }],
        ] {
            assert!(roster_statement(Roster { areas, ..roster.clone() }).is_err());
        }
        let many: Vec<RosterArea> = (0..=MAX_ROSTER_AREA_ROWS)
            .map(|i| RosterArea {
                workspace_id: format!("{i:08x}-abcd-4abc-8abc-abcdefabcdef"),
                ..standard[0].clone()
            })
            .collect();
        assert_eq!(
            roster_statement(Roster { areas: many.clone(), ..roster.clone() }).unwrap_err().to_string(),
            "Invalid roster areas."
        );
        assert!(roster_statement(Roster { areas: many[1..].to_vec(), ..roster }).is_ok());
        let mut nine: Vec<Value> = serde_json::from_str(&statement).unwrap();
        nine.pop();
        assert!(roster_parse(Value::Array(nine).to_string().into_bytes()).is_err());
    }

    #[test]
    fn r9_opus_1_an_honest_member_kept_behind_cannot_pass_on_a_key_the_real_chain_does_not_list() {
        let (o, g, h_, b) = (Person::new(1), Person::new(2), Person::new(3), Person::new(4));
        let people = [&o, &g, &h_, &b];
        let own = owner(&o);
        let mut real = History::new();
        real.roster(
            &o,
            vec![own.clone(), g.active(&[]), h_.active(&[GroupRole::Members]), b.active(&[])],
            None,
        );
        let behind = accepted_of(&real, &people);
        let gone = h_.entry(&[GroupRole::Members], 2, MemberStatus::Left);
        // On the real chain H is removed, AREA rotated to version 2 on the same roster (the rules
        // ask it), and the key replaced.
        real.roster(&o, vec![own.clone(), g.active(&[]), gone.clone(), b.active(&[])], None);
        real.succession(&o);
        let rotated = area_key_at(AREA, 2);
        let latest = accepted_of(&real, &people);
        assert_eq!(area_write_version(latest.clone(), AREA.into()), Some(2));
        assert_eq!(area_write_version(behind.clone(), AREA.into()), Some(1));
        assert_eq!(area_write_version(latest.clone(), SECOND_AREA.into()), None);
        let ctx = AreaGrantContext {
            group_id: GROUP.into(),
            workspace_id: AREA.into(),
            workspace_key_version: 2,
            grantee_user_id: b.user_id.clone(),
            grantee_key_version: 1,
            granter_user_id: g.user_id.clone(),
            roster_version: behind.roster.roster_version,
            roster_digest: behind.roster_digest.clone(),
        };
        // G rotating on its own view: version 2 is not on G's latest roster, so nothing is sealed.
        assert_eq!(
            area_grant_seal(
                vec![90; 32],
                ctx.clone(),
                behind.clone(),
                AREA_SEED.into(),
                b.kem(),
                g.keys.clone()
            )
            .unwrap_err()
            .to_string(),
            NOT_LISTED_KEY
        );
        // A granter who skips that check: B's latest roster lists version 2 with the real key's commitment.
        let statement = |sealed: &[u8]| area_grant_statement(ctx.clone(), sealed.to_vec());
        let recipient = decode("k", &b.keys.encryption_public_key, Some(32)).unwrap();
        let sealed = |key: &[u8]| {
            let kind = SealKind {
                info: AREA_GRANT_INFO,
                associated_data: area_grant_context(&ctx).unwrap(),
                statement: &statement,
                noun: "grant",
                invalid: "x",
                unsigned: "x",
            };
            seal_hybrid(key, &recipient, &b.kem(), &g.keys, &kind).unwrap()
        };
        let open = |envelope: Vec<u8>, chain: &Arc<AcceptedRosters>| {
            area_grant_open(
                envelope,
                ctx.clone(),
                chain.clone(),
                AREA_SEED.into(),
                g.ml_dsa(),
                None,
                b.user_id.clone(),
                1,
                b.keys.clone(),
            )
        };
        assert_eq!(open(sealed(&[90; 32]), &latest).unwrap_err().to_string(), NOT_LISTED_KEY);
        assert_eq!(
            open(sealed(&[90; 32]), &behind).unwrap_err().to_string(),
            "This area key version is not on the group’s member list."
        );
        assert_eq!(open(sealed(&rotated), &latest).unwrap(), rotated);
        // Version 1's key, which readers need for older files, still opens on the real chain (its
        // commitment is the one roster 1 listed); another key under version 1 does not.
        let v1 = AreaGrantContext { workspace_key_version: 1, ..ctx.clone() };
        let statement_v1 = |sealed: &[u8]| area_grant_statement(v1.clone(), sealed.to_vec());
        let open_v1 = |key: &[u8]| {
            let kind = SealKind {
                info: AREA_GRANT_INFO,
                associated_data: area_grant_context(&v1).unwrap(),
                statement: &statement_v1,
                noun: "grant",
                invalid: "x",
                unsigned: "x",
            };
            area_grant_open(
                seal_hybrid(key, &recipient, &b.kem(), &g.keys, &kind).unwrap(),
                v1.clone(),
                latest.clone(),
                AREA_SEED.into(),
                g.ml_dsa(),
                None,
                b.user_id.clone(),
                1,
                b.keys.clone(),
            )
        };
        assert_eq!(open_v1(&AREA_KEY).unwrap(), AREA_KEY.to_vec());
        assert_eq!(open_v1(&[90; 32]).unwrap_err().to_string(), NOT_LISTED_KEY);
    }

    #[test]
    fn r10_r11_roster_next_turns_new_area_keys_into_rows_a_removal_rotates_every_area_no_admission_on_a_holder_removal(
    ) {
        let (o, a, h_, c) = (Person::new(1), Person::new(2), Person::new(3), Person::new(4));
        let own = owner(&o);
        let mut h = History::new();
        h.roster(&o, vec![own.clone(), a.active(&[]), h_.active(&[GroupRole::Members])], None);
        let chain = accepted_of(&h, &[&o, &a, &h_]);
        let members = vec![own.clone(), a.active(&[]), h_.active(&[GroupRole::Members])];
        let next = |members: Vec<RosterMember>, keys: Option<Vec<AreaKey>>| {
            crate::group_trust::roster_next(chain.clone(), members, o.user_id.clone(), keys)
        };
        let key = |workspace_id: &str, byte: u8| AreaKey {
            workspace_id: workspace_id.into(),
            workspace_key: vec![byte; 32],
        };
        let refused = |result: CoreResult<Roster>, what: &str| {
            let error = result.unwrap_err().to_string();
            assert!(error.contains(what), "{error}");
        };
        assert_eq!(next(members.clone(), None).unwrap().areas, vec![]);
        let (rotation, created) = (key(AREA, 78), key(SECOND_AREA, 79));
        let row = next_area_key(chain.clone(), AREA.into(), vec![78; 32]).unwrap();
        let fresh = next_area_key(chain.clone(), SECOND_AREA.into(), vec![79; 32]).unwrap();
        assert_eq!((row.workspace_key_version, fresh.workspace_key_version), (2, 1));
        assert_eq!(
            next(members.clone(), Some(vec![created.clone(), rotation.clone()])).unwrap().areas,
            vec![row.clone(), fresh]
        );
        // r11 (Opus 6): no key the group had before, in this area or another, passes for new; nor
        // one key for two areas, nor one area twice.
        let earlier = AREA_KEY[0];
        refused(next(members.clone(), Some(vec![key(AREA, earlier)])), "earlier keys");
        refused(next(members.clone(), Some(vec![key(SECOND_AREA, earlier)])), "earlier keys");
        assert!(next_area_key(chain.clone(), SECOND_AREA.into(), AREA_KEY.to_vec())
            .unwrap_err()
            .to_string()
            .contains("earlier keys"));
        refused(next(members.clone(), Some(vec![rotation.clone(), key(SECOND_AREA, 78)])), "earlier keys");
        refused(
            next(members.clone(), Some(vec![rotation.clone(), rotation.clone()])),
            "Invalid roster areas",
        );
        // A family removal: every area rotates on the same roster, and only then.
        let removing =
            vec![own.clone(), a.entry(&[], 1, MemberStatus::Left), h_.active(&[GroupRole::Members])];
        assert_eq!(areas_to_rotate(chain.clone(), removing.clone()), vec![AREA.to_string()]);
        assert!(areas_to_rotate(chain.clone(), members.clone()).is_empty());
        refused(next(removing.clone(), None), "rotates every area");
        assert_eq!(next(removing, Some(vec![rotation.clone()])).unwrap().areas, vec![row]);
        // A holder's removal and an admission on one roster: refused, however the areas rotate.
        let swap =
            vec![own, a.active(&[]), h_.entry(&[GroupRole::Members], 1, MemberStatus::Left), c.active(&[])];
        refused(next(swap, Some(vec![rotation])), "No one is admitted");
    }

    #[test]
    fn r11_a_family_at_1024_areas_can_still_remove_someone_and_makes_no_1025th() {
        let (o, a, h_) = (Person::new(1), Person::new(2), Person::new(3));
        let own = owner(&o);
        let id = |i: usize| format!("{i:08x}-abcd-4abc-8abc-abcdefabcdef");
        let key = |i: usize, version: u8| {
            let mut key = vec![0u8; 32];
            key[..4].copy_from_slice(&(i as u32).to_be_bytes());
            key[4] = version;
            key
        };
        let rows: Vec<RosterArea> = (0..MAX_FAMILY_AREAS)
            .map(|i| RosterArea {
                workspace_id: id(i),
                workspace_key_version: 1,
                commitment: area_key_commitment(&key(i, 1)).unwrap(),
            })
            .collect();
        let members = vec![own.clone(), a.active(&[]), h_.active(&[GroupRole::Members])];
        let mut h = History::new();
        h.roster_with(&o, members.clone(), Some(1), Some(rows.clone()));
        let chain = accepted_of(&h, &[&o, &a, &h_]);
        assert_eq!(chain.area_keys.len(), MAX_FAMILY_AREAS);
        // No 1,025th area, as roster_next builds it or as a hand-built roster carries it.
        let extra = AreaKey { workspace_id: SECOND_AREA.into(), workspace_key: vec![79; 32] };
        let error = crate::group_trust::roster_next(
            chain.clone(),
            members.clone(),
            o.user_id.clone(),
            Some(vec![extra]),
        )
        .unwrap_err();
        assert!(error.to_string().contains("at most 1,024 areas"), "{error}");
        let mut over = History::new();
        over.roster_with(&o, members.clone(), Some(1), Some(rows));
        let row = next_area_key(chain.clone(), SECOND_AREA.into(), vec![79; 32]).unwrap();
        over.roster_with(&o, members, Some(1), Some(vec![row]));
        let refused = crate::group_trust::accept_rosters(
            GROUP.into(),
            over.key(1),
            true,
            vec![],
            over.rosters.clone(),
            vec![],
            ml_dsa_keys(&[&o, &a, &h_]),
            reader(),
            None,
        );
        assert!(refused.unwrap_err().to_string().contains("at most 1,024 areas"));
        // The removal rotates all 1,024 in one roster, as roster_next builds it, and it holds.
        let removing = vec![own, a.entry(&[], 1, MemberStatus::Left), h_.active(&[GroupRole::Members])];
        let keys = areas_to_rotate(chain.clone(), removing.clone())
            .into_iter()
            .map(|workspace_id| {
                let i = usize::from_str_radix(&workspace_id[..8], 16).unwrap();
                AreaKey { workspace_id, workspace_key: key(i, 2) }
            })
            .collect();
        let removal =
            crate::group_trust::roster_next(chain, removing.clone(), o.user_id.clone(), Some(keys)).unwrap();
        assert_eq!(removal.areas.len(), MAX_FAMILY_AREAS);
        assert!(roster_statement(removal.clone()).unwrap().len() < 120_000);
        h.roster_with(&o, removing, Some(1), Some(removal.areas));
        assert_eq!(accepted_of(&h, &[&o, &a, &h_]).roster.roster_version, 2);
    }

    #[test]
    fn r9_opus_3_in_a_seal_s_history_links_after_the_entry_s_keys_need_only_their_version_2_signature() {
        let (o, a, g) = (Person::new(1), Person::new(2), Person::new(3));
        let own = owner(&o);
        let (a2, link) = a.succeed();
        let (a3, second) = a2.succeed();
        let one_sided = SuccessionLink { consent: None, ..second };
        let mut h = History::new();
        h.roster(&o, vec![own.clone(), a.active(&[GroupRole::Members]), g.active(&[])], None);
        let before = accepted_of(&h, &[&o, &a, &g]);
        let ctx = AreaGrantContext {
            group_id: GROUP.into(),
            workspace_id: AREA.into(),
            workspace_key_version: 1,
            grantee_user_id: g.user_id.clone(),
            grantee_key_version: 1,
            granter_user_id: a.user_id.clone(),
            roster_version: before.roster.roster_version,
            roster_digest: before.roster_digest.clone(),
        };
        let grant = area_grant_seal(
            AREA_KEY.to_vec(),
            ctx.clone(),
            before,
            AREA_SEED.into(),
            g.kem(),
            a.keys.clone(),
        )
        .unwrap();
        h.roster(&o, vec![own, a2.active(&[GroupRole::Members]), g.active(&[])], None);
        let after = accepted_of(&h, &[&o, &a, &a2, &g]);
        let open = |links: Vec<SuccessionLink>| {
            area_grant_open(
                grant.clone(),
                ctx.clone(),
                after.clone(),
                AREA_SEED.into(),
                a2.ml_dsa(),
                Some(SignerHistory { served: a3.served_keys(), links }),
                g.user_id.clone(),
                1,
                g.keys.clone(),
            )
        };
        assert_eq!(open(vec![link.clone(), one_sided.clone()]).unwrap(), AREA_KEY.to_vec());
        // Before the entry, consent is still asked.
        assert!(open(vec![SuccessionLink { consent: None, ..link }, one_sided]).is_err());
    }
}
