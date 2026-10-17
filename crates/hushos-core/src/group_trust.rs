//! What a member's device accepts as a group's history, and what it shows for
//! the records in a group's areas (docs/groups-design.md 2.4, 2.5, 2.7, 2.8),
//! as `packages/crypto/group-trust.ts` decides it:
//!
//! - [`accept_rosters`] verifies the whole roster chain from version 1 (or
//!   extends the device's own cache of it), each roster under the group key
//!   current at that point and signed by a `Members` holder of the roster
//!   before it, and reports a fork (only on admissible evidence) rather than
//!   ever picking a side;
//! - [`roster_check_next`] is every acceptance rule for the roster after an
//!   accepted chain: [`roster_next`] runs it before a holder signs (and
//!   [`roster_first`] the rules of roster version 1 before a creator signs),
//!   and the server must run it before storing one;
//! - [`group_writer_trust`] and the `group_*_integrity` functions give the
//!   scoped verdicts: a roster vouches only inside its own group's areas;
//! - [`roster_entry_new`], [`roster_entry_fold_in`] and [`trust_as_group_does`]
//!   move keys between personal pins and roster entries only after the checks
//!   that let them; [`roster_entry_own`] makes a creator's own entry.

use crate::bytes::{decode, encode};
use crate::canonical::{bytes_of, digest_of, integer, uuid};
use crate::contacts::{
    digest_base64url, digest_hex, identity_fingerprint, key_digest, pin_verified, same_key_digest,
};
use crate::error::{input, CoreError, CoreResult};
use crate::groups::{
    group_key_digest_of, parse_roster, parse_succession, roster_bytes, verify_group, GroupKeySuccession,
    GroupKind, GroupPublicKey, GroupRole, MemberStatus, Roster, RosterMember, SignedGroupStatement,
};
use crate::identity::{
    identity_verify_keys, PinnedKeys, PublicIdentity, ServedKeys, SuccessionLink, KEM_PUBLIC_KEY_BYTES,
};
use crate::pq::ML_DSA_PUBLIC_KEY_BYTES;
use crate::signatures::{
    digest, metadata_integrity, verify_hybrid, version_integrity, HybridPublicKey, Integrity,
    MetadataStatement, Rekeyed, RekeyedMetadata, RekeyedVersion, TrustedKeys, VersionStatement,
};
use crate::succession_path::{succession_path, SuccessionPath, VerifiedLinks};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

/// What the settings document keeps per group (2.7): the version 1 group key
/// whose words were checked (the ML-DSA key by its SHA-256, base64url), when,
/// and the marks a server must never take back: the latest roster this
/// person's devices accepted (version and digest), the group key at that
/// point (version and [`group_key_digest`]), and per area (workspace id) the
/// highest workspace key version opened. Every device verifies the roster
/// chain from version 1; the pin is never a starting point, only a mark the
/// served chain must reach (else a rollback) and pass through (else a fork).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct GroupPin {
    pub first_ed25519_public_key: String,
    pub first_ml_dsa_public_key_digest: String,
    pub checked_at: String,
    pub key_version: u64,
    pub group_key_digest: String,
    pub roster_version: u64,
    pub roster_digest: String,
    pub areas: HashMap<String, u64>,
}

/*
 * A check time as pins carry it: the 24 ASCII characters of an ISO 8601 UTC
 * time to the millisecond (the web's `toISOString`), so every client orders
 * check times alike, byte by byte.
 */
pub(crate) fn check_time(value: &str) -> CoreResult<()> {
    let b = value.as_bytes();
    let digits = |range: std::ops::Range<usize>| b[range].iter().all(u8::is_ascii_digit);
    let number = |range: std::ops::Range<usize>| -> u32 {
        b[range].iter().fold(0, |n, d| n * 10 + u32::from(d - b'0'))
    };
    let shaped = b.len() == 24
        && digits(0..4)
        && b[4] == b'-'
        && digits(5..7)
        && b[7] == b'-'
        && digits(8..10)
        && b[10] == b'T'
        && digits(11..13)
        && b[13] == b':'
        && digits(14..16)
        && b[16] == b':'
        && digits(17..19)
        && b[19] == b'.'
        && digits(20..23)
        && b[23] == b'Z';
    if !shaped
        || !(1..=12).contains(&number(5..7))
        || !(1..=31).contains(&number(8..10))
        || number(11..13) > 23
        || number(14..16) > 59
        || number(17..19) > 59
    {
        return Err(input("Invalid group pin."));
    }
    Ok(())
}

/// A group pin as the settings document holds it, or refused (the web's
/// `checkGroupPin`): canonical base64url keys and digests, versions from 1 to
/// 2^53 - 1, lowercase area ids, a canonical check time. A pin that does not
/// pass is not a pin.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn group_pin_check(group_id: String, pin: GroupPin) -> CoreResult<GroupPin> {
    uuid(&group_id, "group id")?;
    check_time(&pin.checked_at)?;
    bytes_of(&pin.first_ed25519_public_key, 32, "group key")?;
    digest_of(&pin.first_ml_dsa_public_key_digest, "key digest")?;
    integer(pin.key_version, "group key version")?;
    digest_of(&pin.group_key_digest, "key digest")?;
    integer(pin.roster_version, "roster version")?;
    digest_of(&pin.roster_digest, "roster digest")?;
    for (workspace_id, version) in &pin.areas {
        uuid(workspace_id, "workspace id")?;
        integer(*version, "workspace key version")?;
    }
    Ok(pin)
}

/// One verified group key succession as the cache keeps it: the roster it is
/// tied to, the digest of its statement, and who signed it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct CachedSuccession {
    pub last_roster_version: u64,
    pub digest: String,
    pub signer_user_id: String,
}

/// A member's keys as an entry names them: what a succession chain starts from.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct KeySet {
    pub encryption_public_key: String,
    pub signing_public_key: String,
    pub ml_dsa_public_key_digest: String,
}

fn key_set_of(entry: &RosterMember) -> KeySet {
    KeySet {
        encryption_public_key: entry.encryption_public_key.clone(),
        signing_public_key: entry.signing_public_key.clone(),
        ml_dsa_public_key_digest: entry.ml_dsa_public_key_digest.clone(),
    }
}

/// What a device keeps of a chain it verified, so the next sync continues
/// from it instead of from version 1 (the web's `GroupChainCache`). Its own
/// record (local, never synced): the served chain must extend it, and every
/// digest in it is one of the person's marks. Bound to its group and to the
/// roster it is through: the last of `roster_digests` (one per version,
/// version 1 first) is the digest of `statement` (base64url), whose version
/// is their count.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct GroupChainCache {
    pub group_id: String,
    pub roster_digests: Vec<String>,
    pub statement: String,
    pub dropped_holder: bool,
    /// Every group key, version 1 first, and every succession from key 1 on.
    pub group_keys: Vec<GroupPublicKey>,
    pub successions: Vec<CachedSuccession>,
    pub creator_user_id: String,
    /// Every key set each member's entries named, oldest first.
    pub key_history: HashMap<String, Vec<KeySet>>,
    /// Every commitment each area's rows named, version 1 first.
    pub area_keys: HashMap<String, Vec<String>>,
    pub own_entry_wrong_at: Vec<u64>,
}

/// A roster the server served off the accepted chain: its version and the
/// signer it names (unverified). A note, never a warning.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct DeadBranch {
    pub version: u64,
    pub signer_user_id: String,
}

/// A roster chain verified from version 1, with the group keys behind it.
/// Only [`accept_rosters`] makes one: across UniFFI it is an object with no
/// constructor, so Swift and Kotlin can read it but not write one out (the
/// web's frozen, registered chain).
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct AcceptedRosters {
    pub(crate) group_id: String,
    pub(crate) kind: GroupKind,
    pub(crate) roster: Roster,
    pub(crate) statement: Vec<u8>,
    pub(crate) roster_digest: String,
    pub(crate) roster_digests: Vec<String>,
    pub(crate) dropped_holder: bool,
    pub(crate) group_key_version: u64,
    pub(crate) group_key: GroupPublicKey,
    pub(crate) group_key_digest: String,
    pub(crate) group_keys: Vec<GroupPublicKey>,
    pub(crate) creator_user_id: String,
    pub(crate) succession_due: bool,
    pub(crate) key_history: HashMap<String, Vec<KeySet>>,
    pub(crate) area_keys: HashMap<String, Vec<String>>,
    pub(crate) own_entry_wrong_at: Vec<u64>,
    pub(crate) own_entry_behind_at: Vec<u64>,
    pub(crate) dead_branches: Vec<DeadBranch>,
    pub(crate) cache: GroupChainCache,
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl AcceptedRosters {
    pub fn group_id(&self) -> String {
        self.group_id.clone()
    }
    pub fn kind(&self) -> GroupKind {
        self.kind
    }
    pub fn roster(&self) -> Roster {
        self.roster.clone()
    }
    pub fn statement(&self) -> Vec<u8> {
        self.statement.clone()
    }
    pub fn roster_digest(&self) -> String {
        self.roster_digest.clone()
    }
    /// Every roster's digest, version 1 first: what a pin's mark is checked against.
    pub fn roster_digests(&self) -> Vec<String> {
        self.roster_digests.clone()
    }
    /// The latest roster took a `Members` holder away: it is the last under its key.
    pub fn dropped_holder(&self) -> bool {
        self.dropped_holder
    }
    /// The group key now: the highest version the verified successions reach.
    pub fn group_key_version(&self) -> u64 {
        self.group_key_version
    }
    pub fn group_key(&self) -> GroupPublicKey {
        self.group_key.clone()
    }
    pub fn group_key_digest(&self) -> String {
        self.group_key_digest.clone()
    }
    /// Every group key, version 1 first, each succession checked in full.
    pub fn group_keys(&self) -> Vec<GroupPublicKey> {
        self.group_keys.clone()
    }
    /// The signer of roster version 1.
    pub fn creator_user_id(&self) -> String {
        self.creator_user_id.clone()
    }
    /// The latest roster dropped a `Members` holder, and no succession has followed yet.
    pub fn succession_due(&self) -> bool {
        self.succession_due
    }
    /// Every key set each member's entries named, oldest first. Never trusted
    /// for being here: a reader counts an earlier one as retired only along
    /// the member's own succession chain.
    pub fn key_history(&self) -> HashMap<String, Vec<KeySet>> {
        self.key_history.clone()
    }
    /// Every area key commitment the chain's rosters listed, by area, version
    /// 1 first: the latest roster lists only each area's current key, and a
    /// grant of an earlier version (a key a reader needs for older files) is
    /// checked against the commitment the roster that introduced it listed.
    pub fn area_keys(&self) -> HashMap<String, Vec<String>> {
        self.area_keys.clone()
    }
    /// The roster versions whose entry for the reader named none of its own
    /// identities: a hard warning, even when a later roster put it right.
    pub fn own_entry_wrong_at(&self) -> Vec<u64> {
        self.own_entry_wrong_at.clone()
    }
    /// The roster versions, among those this acceptance added, at which the
    /// reader's entry changed to one of their own identities older than their
    /// newest: a soft note (a holder folded in a replaced identity, or the
    /// reader rotated just after a fold-in). Not kept in the cache: it is
    /// reported by the acceptance that adds the roster.
    pub fn own_entry_behind_at(&self) -> Vec<u64> {
        self.own_entry_behind_at.clone()
    }
    /// Rosters served off the chain (dead branches): a note, never a warning.
    pub fn dead_branches(&self) -> Vec<DeadBranch> {
        self.dead_branches.clone()
    }
    /// What to keep locally and pass back next time.
    pub fn cache(&self) -> GroupChainCache {
        self.cache.clone()
    }
}

/// Where a mark came from: a pin, this device's cache, or the chain served.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum MarkSource {
    Pin,
    Cache,
    /// The newcomer's join mark (`accept_rosters_joining`).
    Join,
    Served,
}

/// What a newcomer's join code comparison fixes about the roster that admitted
/// them (2.4, milestone 1c): its version and a twelve-word code
/// ([`join_code`], 132 bits) over its digest, the group key it is under and
/// that key's version. Acceptance holds it as one of the person's marks: the
/// verified chain must pass through a roster at that version whose code is
/// these words, or it is the hard warning; a chain short of it is a rollback,
/// refused. At 132 bits nothing a holder can vary can be ground to match. It
/// covers an admission after the branch point under a key the removed holder
/// lacks; no roster both removes a holder and admits anyone.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct JoinMark {
    pub roster_version: u64,
    pub code: Vec<String>,
}

fn check_join_mark(mark: &JoinMark) -> CoreResult<()> {
    if mark.code.len() != 12
        || !mark
            .code
            .iter()
            .all(|word| (3..=8).contains(&word.len()) && word.bytes().all(|c| c.is_ascii_lowercase()))
    {
        return Err(input("Invalid join mark."));
    }
    integer(mark.roster_version, "join mark")?;
    Ok(())
}

/// The join code an admitting admin's client shows over the roster it signed
/// (2.4, 3.2): the first 160 bits of SHA-256("hushos/group/join-code/v1" ||
/// rosterDigest || groupKeyDigest || groupKeyVersion as 8 bytes big-endian),
/// read as the fingerprint words are (the top 132 bits, twelve 11-bit words
/// of the BIP-39 English list). rosterDigest is the 32 bytes its base64url
/// names; groupKeyDigest is `group_key_digest` of the key the roster is under
/// (SHA-256 of its Ed25519 key followed by its whole ML-DSA key), never a
/// pin's first-keys digest. The web's `joinCode` gives the same words.
const JOIN_CODE_DOMAIN: &str = "hushos/group/join-code/v1";

#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn join_code(
    roster_digest: String,
    group_key: GroupPublicKey,
    group_key_version: u64,
) -> CoreResult<Vec<String>> {
    use sha2::Digest as _;
    let mut input = JOIN_CODE_DOMAIN.as_bytes().to_vec();
    input.extend(decode("rosterDigest", digest_of(&roster_digest, "roster digest")?, Some(32))?);
    input.extend(decode("groupKeyDigest", &group_key_digest_of(&group_key)?, Some(32))?);
    input.extend(integer(group_key_version, "group key version")?.to_be_bytes());
    let hash = sha2::Sha256::digest(&input);
    let list = crate::recovery::wordlist();
    let bit = |index: usize| (hash[index / 8] >> (7 - index % 8)) & 1;
    Ok((0..12)
        .map(|word| {
            let value = (0..11).fold(0usize, |value, offset| (value << 1) | bit(word * 11 + offset) as usize);
            list[value].to_string()
        })
        .collect())
}

/// One side of a conflict between marks: a digest, who holds it, and the
/// signer of its statement when known.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct MarkSide {
    pub digest: String,
    pub from: Vec<MarkSource>,
    pub signer_user_id: Option<String>,
}

/// What two of the person's marks disagree on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ForkOf {
    Roster,
    GroupKey,
}

/// What [`accept_rosters`] found: the accepted chain, or a fork: the
/// person's own marks (pins, cache) disagree with each other or with the
/// chain served, a roster (or group key) at `version` with two digests. The
/// hard warning; every side is named, sorted by digest, none the culprit.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum RosterChain {
    Accepted { chain: Arc<AcceptedRosters> },
    Fork { of: ForkOf, version: u64, sides: Vec<MarkSide> },
}

/// The reader's own account for [`accept_rosters`]: its user id and every
/// identity it has had (re-derived from its own seeds), so each roster's entry
/// for it is checked.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct OwnIdentities {
    pub user_id: String,
    pub identities: Vec<ServedKeys>,
}

/* Where acceptance stops: a fork is a result, anything else a refusal. */
enum Stop {
    Fork(ForkOf, u64, Vec<MarkSide>),
    Refused(CoreError),
}

impl From<CoreError> for Stop {
    fn from(error: CoreError) -> Self {
        Stop::Refused(error)
    }
}

#[derive(Clone)]
struct Held {
    roster: Roster,
    statement: Vec<u8>,
    digest: String,
    dropped_holder: bool,
}

#[derive(Clone)]
struct Verified {
    last_roster_version: u64,
    digest: String,
    signer_user_id: String,
}

/* A served statement and every distinct copy of its signatures. */
#[derive(Clone)]
struct Served<T> {
    value: T,
    statement: Vec<u8>,
    digest: String,
    copies: Vec<SignedGroupStatement>,
}

/* Whether `next` takes away a `Members` holder of `previous`: marked left, or the role removed. */
fn drops_holder(previous: &Roster, next: &Roster) -> bool {
    previous.members.iter().any(|entry| {
        entry.active_with(Some(GroupRole::Members))
            && !next.entry(&entry.user_id).is_some_and(|e| e.active_with(Some(GroupRole::Members)))
    })
}

const NOT_ROTATED: &str = "A roster that removes a family member rotates every area.";
const ADMITS_ON_REMOVAL: &str = "No one is admitted on the roster that removes a key holder.";
const TOO_MANY_AREAS: &str = "A family has at most 1,024 areas.";
const REUSED_KEY: &str = "This area key was used before: a rotation needs a new one.";

/*
 * The area rows and what a removal asks (2.4, 2.6), as the web's checkAreas.
 * Each row a roster carries is a new area at version 1, or a rotation one
 * above the area's latest version on the chain (`area_keys`), so every
 * version of every area is listed exactly once, and its commitment (of the key
 * alone) is one the chain never listed before, in any area. In a family a roster that
 * marks anyone `left` rotates every area in the same statement. And no roster
 * both removes a `Members` holder and admits anyone.
 */
fn check_areas(
    area_keys: &HashMap<String, Vec<String>>,
    commitments: &HashSet<String>,
    previous: Option<&Roster>,
    next: &Roster,
) -> CoreResult<()> {
    for row in &next.areas {
        let versions = area_keys.get(&row.workspace_id).map_or(0, Vec::len) as u64;
        if row.workspace_key_version != versions + 1 {
            return Err(input("This member list does not follow from the one before."));
        }
    }
    // A commitment depends on the key alone: one listed before, in any area, or twice in this
    // roster, is a key used before, and a rotation to it rotates nothing.
    let mut fresh = HashSet::new();
    if next.areas.iter().any(|row| commitments.contains(&row.commitment) || !fresh.insert(&row.commitment)) {
        return Err(input(REUSED_KEY));
    }
    // A family's removal rotates every area in one roster, so the areas stay within one roster.
    let created = next.areas.iter().filter(|row| !area_keys.contains_key(&row.workspace_id)).count();
    if next.kind == GroupKind::Family && area_keys.len() + created > crate::groups::MAX_FAMILY_AREAS {
        return Err(input(TOO_MANY_AREAS));
    }
    let Some(previous) = previous else {
        return Ok(());
    };
    let leaving = next.members.iter().any(|entry| {
        entry.status == MemberStatus::Left
            && previous.entry(&entry.user_id).is_some_and(|before| before.status == MemberStatus::Active)
    });
    if next.kind == GroupKind::Family
        && leaving
        && area_keys.keys().any(|id| !next.areas.iter().any(|row| &row.workspace_id == id))
    {
        return Err(input(NOT_ROTATED));
    }
    let admits = next.members.iter().any(|entry| {
        entry.status == MemberStatus::Active
            && !previous.entry(&entry.user_id).is_some_and(|before| before.status == MemberStatus::Active)
    });
    if admits && drops_holder(previous, next) {
        return Err(input(ADMITS_ON_REMOVAL));
    }
    Ok(())
}

/* Folds a held roster's area rows into the chain's area keys (check_areas saw to their versions). */
fn fold_areas(
    area_keys: &mut HashMap<String, Vec<String>>,
    commitments: &mut HashSet<String>,
    roster: &Roster,
) {
    for row in &roster.areas {
        area_keys.entry(row.workspace_id.clone()).or_default().push(row.commitment.clone());
        commitments.insert(row.commitment.clone());
    }
}

fn same_keys(a: &RosterMember, b: &RosterMember) -> bool {
    a.key_version == b.key_version
        && a.encryption_public_key == b.encryption_public_key
        && a.signing_public_key == b.signing_public_key
        && a.ml_dsa_public_key_digest == b.ml_dsa_public_key_digest
        && a.kem_public_key_digest == b.kem_public_key_digest
}

fn same_entry(a: &RosterMember, b: &RosterMember) -> bool {
    same_keys(a, b) && a.status == b.status && a.roles == b.roles
}

/*
 * The entry rules (2.4): entries never disappear (former members stay,
 * marked left), and each entry's since-version is the version it last
 * changed at. A roster's keys for a member are a holder's claim, nothing
 * more: what each reader trusts follows from the member's own succession
 * chain and the words checks (2.8), and the server checks every changed entry
 * against the member's identities before storing (4).
 */
fn check_entries(previous: &Roster, next: &Roster) -> CoreResult<()> {
    let refused = || input("This member list does not follow from the one before.");
    if previous.members.iter().any(|entry| next.entry(&entry.user_id).is_none()) {
        return Err(refused());
    }
    for entry in &next.members {
        let since = match previous.entry(&entry.user_id) {
            Some(before) if same_entry(before, entry) => before.since_version,
            _ => next.roster_version,
        };
        if entry.since_version != since {
            return Err(refused());
        }
    }
    Ok(())
}

/*
 * Whether `signed` carries `signer_user_id`'s hybrid identity signature under
 * their entry on `authority`: the Ed25519 key it names, and the served ML-DSA
 * key whose SHA-256 is its digest (`ml_dsa_keys` is keyed by that digest, so
 * a signer whose identity changed along the chain is checked under the right
 * key at each point). A roster is checked against the signer's entry on the
 * roster before it, so a member who replaced their identity and signs the
 * roster that folds it in signs with their previous keys (an account keeps
 * every earlier identity's private keys).
 */
fn signed_by_member(
    authority: &Roster,
    signer_user_id: &str,
    signed: &SignedGroupStatement,
    ml_dsa_keys: &HashMap<String, String>,
) -> bool {
    let Some(entry) = authority.entry(signer_user_id) else {
        return false;
    };
    ml_dsa_keys
        .get(&entry.ml_dsa_public_key_digest)
        .and_then(|served| decode("mlDsaPublicKey", served, Some(ML_DSA_PUBLIC_KEY_BYTES)).ok())
        .filter(|served| digest(served) == entry.ml_dsa_public_key_digest)
        .zip(decode("signingPublicKey", &entry.signing_public_key, Some(32)).ok())
        .is_some_and(|(ml_dsa_public_key, signing_public_key)| {
            verify_hybrid(
                &HybridPublicKey { signing_public_key, ml_dsa_public_key },
                &signed.statement,
                &signed.signer_signature,
            )
        })
}

/*
 * A version's index into the chain's lists, checked: a version that does not
 * fit (zero, or beyond usize on a 32-bit target) is usize::MAX, which no list
 * reaches, never a truncated index that lands on another version.
 */
fn version_index(version: u64) -> usize {
    version.checked_sub(1).and_then(|index| usize::try_from(index).ok()).unwrap_or(usize::MAX)
}

fn ml_dsa_digest(public_key: &str) -> Option<String> {
    decode("mlDsaPublicKey", public_key, Some(ML_DSA_PUBLIC_KEY_BYTES)).ok().map(|key| digest(&key))
}

/* Whether the served identity is exactly the one an entry names: X25519, Ed25519, both digests, key version. */
fn served_is_entry(served: &ServedKeys, entry: &RosterMember) -> bool {
    served.key_version == entry.key_version && served_keys_are_entry(served, entry)
}

/*
 * Whether the served identity's four keys are the ones an entry names, its key
 * version aside: for a served identity whose keys statement was not checked,
 * whose version is then only the server's word.
 */
fn served_keys_are_entry(served: &ServedKeys, entry: &RosterMember) -> bool {
    served.encryption_public_key == entry.encryption_public_key
        && served.signing_public_key == entry.signing_public_key
        && ml_dsa_digest(&served.ml_dsa_public_key).as_deref()
            == Some(entry.ml_dsa_public_key_digest.as_str())
        && decode("kemPublicKey", &served.kem_public_key, Some(KEM_PUBLIC_KEY_BYTES))
            .is_ok_and(|kem| digest(&kem) == entry.kem_public_key_digest)
}

const NOT_FOLLOWING: &str = "This roster does not follow the last one.";
const REPLACED_KEY: &str = "This roster was signed by a group key that has been replaced.";
const OLDER: &str = "This is an older member list than this device has seen.";
const HOLDER_LEFT: &str = "A member who held the group key left, so the key must be replaced first.";
const NOT_HOLDER: &str = "This was not signed by a member who holds the group key.";
const SIGNER_LEFT: &str =
    "A member list is signed by a member who stays on it: another holder signs a departure.";
const NO_HOLDER: &str = "A member list keeps an active member who holds the group key.";
const NOT_MEMBER: &str = "This is not signed by the member it names.";
const NOT_GROUP_SIGNED: &str = "This roster is not signed by the group key.";
const NO_SUCCESSION: &str = "A group key succession is missing.";
const NOT_NEW_KEY: &str = "This group key succession does not replace the key with a new one.";
const NOT_CHECKED: &str = "These are not the group keys this person checked.";
const NOT_BY_OLD_KEY: &str = "This group key succession is not signed by the key it replaces.";
const NOT_TIED: &str = "This group key succession is not tied to a roster on the member list.";
const OUT_OF_ORDER: &str = "This group key succession is out of order.";
const NOT_EXTENDING: &str =
    "This member list does not continue the one this device holds: fetch it again from version 1.";

/* The cache as given, checked: every part canonical and consistent, the last roster parsed. */
struct Cached {
    roster_digests: Vec<String>,
    statement: Vec<u8>,
    roster: Roster,
    cache: GroupChainCache,
}

fn check_cache(group_id: &str, cache: GroupChainCache) -> CoreResult<Cached> {
    let bad = || input("Invalid member list cache.");
    let checked = || -> CoreResult<Cached> {
        if cache.group_id != group_id || cache.roster_digests.is_empty() {
            return Err(bad());
        }
        for at in &cache.roster_digests {
            digest_of(at, "roster digest")?;
        }
        let statement = decode("statement", &cache.statement, None)?;
        let roster = parse_roster(&statement)?;
        let through = cache.roster_digests.len() as u64;
        if roster.group_id != group_id
            || roster.roster_version != through
            || cache.roster_digests.last() != Some(&digest(&statement))
        {
            return Err(bad());
        }
        // Also refuses an empty list: the last roster's key version is at least 1.
        if roster.group_key_version > cache.group_keys.len() as u64 {
            return Err(bad());
        }
        for key in &cache.group_keys {
            bytes_of(&key.ed25519_public_key, 32, "group key")?;
            bytes_of(&key.ml_dsa_public_key, ML_DSA_PUBLIC_KEY_BYTES, "group key")?;
        }
        if cache.successions.len() != cache.group_keys.len() - 1 {
            return Err(bad());
        }
        for (index, at) in cache.successions.iter().enumerate() {
            integer(at.last_roster_version, "roster version")?;
            digest_of(&at.digest, "statement digest")?;
            uuid(&at.signer_user_id, "user id")?;
            if at.last_roster_version > through
                || (index > 0 && at.last_roster_version < cache.successions[index - 1].last_roster_version)
            {
                return Err(bad());
            }
        }
        uuid(&cache.creator_user_id, "user id")?;
        for (user_id, sets) in &cache.key_history {
            uuid(user_id, "user id")?;
            for (index, set) in sets.iter().enumerate() {
                bytes_of(&set.encryption_public_key, 32, "encryption key")?;
                bytes_of(&set.signing_public_key, 32, "signing key")?;
                digest_of(&set.ml_dsa_public_key_digest, "key digest")?;
                if sets[..index].contains(set) {
                    return Err(bad());
                }
            }
        }
        for (workspace_id, list) in &cache.area_keys {
            uuid(workspace_id, "workspace id")?;
            if list.is_empty() {
                return Err(bad());
            }
            for at in list {
                digest_of(at, "area key commitment")?;
            }
        }
        // The last roster's rows are each its area's latest key. Earlier commitments are this
        // device's own record, trusted as stored (a compromised device is out of scope). At the
        // first roster there is nothing earlier: its rows are every area there is.
        if roster.areas.iter().any(|area| {
            cache.area_keys.get(&area.workspace_id).is_none_or(|list| {
                list.len() as u64 != area.workspace_key_version || list.last() != Some(&area.commitment)
            })
        }) || (roster.roster_version == 1 && cache.area_keys.len() != roster.areas.len())
        {
            return Err(bad());
        }
        for (index, at) in cache.own_entry_wrong_at.iter().enumerate() {
            integer(*at, "roster version")?;
            if *at > through || (index > 0 && *at <= cache.own_entry_wrong_at[index - 1]) {
                return Err(bad());
            }
        }
        Ok(Cached { roster_digests: cache.roster_digests.clone(), statement, roster, cache: cache.clone() })
    };
    checked().map_err(|_| bad())
}

/*
 * What acceptance carries from roster to roster: the group keys so far with
 * the successions that reached them, the chain's rosters held so far, the
 * served successions by the key they replace, and the person's group key
 * marks. A chain's cache rebuilds it, so the next roster or succession is
 * judged by the very same rules (roster_check_next,
 * group_succession_check_next).
 */
struct State<'a> {
    group_id: &'a str,
    ml_dsa_keys: &'a HashMap<String, String>,
    keys: Vec<GroupPublicKey>,
    verified: BTreeMap<u64, Verified>,
    held: Vec<Held>,
    candidates: BTreeMap<u64, Vec<Served<GroupKeySuccession>>>,
    key_marks: BTreeMap<u64, MarkSide>,
    /* Why the successions from a key were not taken, for group_succession_check_next. */
    refused: BTreeMap<u64, CoreError>,
    /*
     * Valid successions from a key that the person's group key mark there does not name: each
     * as a side of the warning, with the key it would bring.
     */
    waiting: BTreeMap<u64, Vec<(MarkSide, GroupPublicKey)>>,
    /*
     * Each candidate succession's signatures, checked once: its old key and the roster it is tied
     * to (so its signer's entry) are fixed by its statement, whenever it is looked at. `Ok` when
     * one copy holds both, else why not.
     */
    signatures: std::cell::RefCell<HashMap<String, Result<(), &'static str>>>,
    /* Every area key commitment the held rosters listed, version 1 first (fold_areas). */
    area_keys: HashMap<String, Vec<String>>,
    /* Every area key commitment on the chain so far, of any area: a repeat is a key used before. */
    commitments: HashSet<String>,
}

impl<'a> State<'a> {
    fn of(group_id: &'a str, ml_dsa_keys: &'a HashMap<String, String>, cached: Option<&Cached>) -> State<'a> {
        let mut verified = BTreeMap::new();
        let mut keys = vec![];
        let mut held = vec![];
        if let Some(cached) = cached {
            for (index, at) in cached.cache.successions.iter().enumerate() {
                verified.insert(
                    index as u64 + 1,
                    Verified {
                        last_roster_version: at.last_roster_version,
                        digest: at.digest.clone(),
                        signer_user_id: at.signer_user_id.clone(),
                    },
                );
            }
            keys = cached.cache.group_keys.clone();
            held.push(Held {
                roster: cached.roster.clone(),
                statement: cached.statement.clone(),
                digest: cached.roster_digests.last().expect("checked").clone(),
                dropped_holder: cached.cache.dropped_holder,
            });
        }
        State {
            group_id,
            ml_dsa_keys,
            keys,
            verified,
            held,
            candidates: BTreeMap::new(),
            key_marks: BTreeMap::new(),
            refused: BTreeMap::new(),
            waiting: BTreeMap::new(),
            signatures: std::cell::RefCell::new(HashMap::new()),
            area_keys: cached.map(|cached| cached.cache.area_keys.clone()).unwrap_or_default(),
            commitments: cached
                .map(|cached| cached.cache.area_keys.values().flatten().cloned().collect())
                .unwrap_or_default(),
        }
    }

    /*
     * The succession from key `old_version` if it holds: it names the chain's
     * key there, one copy is signed by that key and by its signer, active with
     * Members on the roster it is tied to (held, by digest), and it is tied no
     * earlier than the succession into it. Otherwise why not. Acceptance takes
     * a succession as soon as the roster it is tied to is held, before any
     * later roster, so one tied before the last roster under the old key is
     * never taken in time: that later roster is refused as under a replaced key.
     */
    fn admissible_succession(
        &self,
        served: &Served<GroupKeySuccession>,
        old_version: u64,
    ) -> CoreResult<GroupKeySuccession> {
        let succession = &served.value;
        let old = &self.keys[version_index(old_version)];
        if succession.group_id != self.group_id || succession.old_key() != *old {
            return Err(input(NOT_BY_OLD_KEY));
        }
        // A new key must be new: not the old one, nor any the group had before.
        if self.keys.contains(&succession.new_key()) {
            return Err(input(NOT_NEW_KEY));
        }
        let last = self
            .held
            .iter()
            .find(|at| at.roster.roster_version == succession.last_roster_version)
            .filter(|at| at.digest == succession.last_roster_digest)
            .ok_or_else(|| input(NOT_TIED))?;
        if self
            .verified
            .get(&(old_version - 1))
            .is_some_and(|into| succession.last_roster_version < into.last_roster_version)
        {
            return Err(input(OUT_OF_ORDER));
        }
        if !last
            .roster
            .entry(&succession.signer_user_id)
            .is_some_and(|e| e.active_with(Some(GroupRole::Members)))
        {
            return Err(input(NOT_HOLDER));
        }
        let known = self.signatures.borrow().get(&served.digest).copied();
        let verdict = known.unwrap_or_else(|| {
            let mut verdict = Err(NOT_BY_OLD_KEY);
            for copy in &served.copies {
                if !verify_group(old, &served.statement, &copy.signature) {
                    continue;
                }
                verdict = Err(NOT_MEMBER);
                if signed_by_member(&last.roster, &succession.signer_user_id, copy, self.ml_dsa_keys) {
                    verdict = Ok(());
                    break;
                }
            }
            self.signatures.borrow_mut().insert(served.digest.clone(), verdict);
            verdict
        });
        verdict.map(|()| succession.clone()).map_err(input)
    }

    /*
     * The succession from the current key, or none yet: of the served ones
     * that hold now, the one a group key mark names, or the only one. Ones
     * that do not hold are ignored (why is kept). Two that hold with no mark to
     * choose are the server's to resolve: refused. Ones a mark does not name
     * wait (roster_rules).
     */
    fn next_succession(&mut self) -> Result<Option<(String, GroupKeySuccession)>, Stop> {
        let old_version = self.current();
        let served = self.candidates.get(&old_version).cloned().unwrap_or_default();
        let mut valid: Vec<(String, GroupKeySuccession, String)> = vec![];
        let mut reason: Option<CoreError> = None;
        for at in &served {
            match self.admissible_succession(at, old_version) {
                Err(error) => {
                    reason.get_or_insert(error);
                }
                Ok(succession) => {
                    let key_digest = group_key_digest_of(&succession.new_key())?;
                    valid.push((at.digest.clone(), succession, key_digest));
                }
            }
        }
        let mark = self.key_marks.get(&(old_version + 1)).cloned();
        let chosen = match &mark {
            Some(mark) => {
                let chosen = valid.iter().find(|(_, _, key_digest)| *key_digest == mark.digest).cloned();
                // Valid successions the mark does not name wait: the one it names may be tied to a
                // roster not reached yet. They are the warning only if a roster needing the next
                // key holds under one of them (a holder-signed history the person's mark
                // contradicts).
                if chosen.is_none() && !valid.is_empty() {
                    let rivals = valid
                        .iter()
                        .map(|(_, s, key_digest)| {
                            let side = MarkSide {
                                digest: key_digest.clone(),
                                from: vec![MarkSource::Served],
                                signer_user_id: Some(s.signer_user_id.clone()),
                            };
                            (side, s.new_key())
                        })
                        .collect();
                    self.waiting.insert(old_version, rivals);
                }
                chosen
            }
            None if valid.len() > 1 => {
                return Err(input("The server served more than one group key succession from one key.").into())
            }
            None => valid.first().cloned(),
        };
        match chosen {
            Some((statement_digest, succession, _)) => Ok(Some((statement_digest, succession))),
            None => {
                self.refused.insert(old_version, reason.unwrap_or_else(|| input(NO_SUCCESSION)));
                Ok(None)
            }
        }
    }

    /* Takes the succession from the current key, as next_succession chose it. */
    fn establish_next(&mut self) -> Result<bool, Stop> {
        let Some((statement_digest, succession)) = self.next_succession()? else {
            return Ok(false);
        };
        self.verified.insert(
            self.current(),
            Verified {
                last_roster_version: succession.last_roster_version,
                digest: statement_digest,
                signer_user_id: succession.signer_user_id.clone(),
            },
        );
        self.keys.push(succession.new_key());
        Ok(true)
    }

    fn establish_all(&mut self) -> Result<(), Stop> {
        while self.establish_next()? {}
        Ok(())
    }

    fn current(&self) -> u64 {
        self.keys.len() as u64
    }

    /*
     * Every rule a roster must keep at the position after `previous` (2.4,
     * 2.5): the group's kind; the group key current at its version (the
     * succession into it held, none out of it before this roster); a signer
     * active with Members on the roster before it (version 1: on itself); one
     * copy carrying both a group signature by that key and the signer's
     * identity signature (skipped for an unsigned roster, as roster_next
     * builds); the succession a dropped holder made due; and the entry rules.
     */
    fn roster_rules(
        &self,
        roster: &Roster,
        statement: &[u8],
        copies: Option<&[SignedGroupStatement]>,
        previous: Option<&Held>,
    ) -> Result<(), Stop> {
        if previous.is_some_and(|previous| roster.kind != previous.roster.kind) {
            return Err(input(NOT_FOLLOWING).into());
        }
        // Successions are taken as soon as the roster they are tied to is held, so a key not
        // reached by now has none that holds.
        if self.current() < roster.group_key_version {
            // Rivals waiting for a mark they do not meet: the warning only if this roster holds
            // under one of them, signed by a holder; a roster the real (withheld) key signed is
            // refused.
            let rivals = self.waiting.get(&self.current());
            let mark = self.key_marks.get(&(self.current() + 1));
            let authority = previous.map(|at| &at.roster).unwrap_or(roster);
            if let (Some(rivals), Some(mark), Some(copies)) = (rivals, mark, copies) {
                if roster.group_key_version == self.current() + 1 {
                    for (_, key) in rivals {
                        for copy in copies {
                            if verify_group(key, statement, &copy.signature)
                                && authority
                                    .entry(&roster.signer_user_id)
                                    .is_some_and(|e| e.active_with(Some(GroupRole::Members)))
                                // A rival roster that breaks the departure rules is refused, not a
                                // warning.
                                && roster
                                    .entry(&roster.signer_user_id)
                                    .is_some_and(|e| e.status == MemberStatus::Active)
                                && roster.members.iter().any(|entry| entry.active_with(Some(GroupRole::Members)))
                                && signed_by_member(authority, &roster.signer_user_id, copy, self.ml_dsa_keys)
                            {
                                let mut all = vec![mark.clone()];
                                all.extend(rivals.iter().map(|(side, _)| side.clone()));
                                return Err(Stop::Fork(ForkOf::GroupKey, self.current() + 1, sides(all)));
                            }
                        }
                    }
                }
            }
            return Err(self
                .refused
                .get(&self.current())
                .cloned()
                .unwrap_or_else(|| input(NO_SUCCESSION))
                .into());
        }
        // Never before the succession into its key: that succession is tied to a roster already held.
        if self
            .verified
            .get(&roster.group_key_version)
            .is_some_and(|out| roster.roster_version > out.last_roster_version)
        {
            return Err(input(REPLACED_KEY).into());
        }
        let authority = previous.map(|at| &at.roster).unwrap_or(roster);
        if !authority.entry(&roster.signer_user_id).is_some_and(|e| e.active_with(Some(GroupRole::Members))) {
            return Err(input(NOT_HOLDER).into());
        }
        // The signer stays active on what they sign (a holder's departure is another holder's to
        // sign, with its rotations), and the group keeps someone who can sign the next one.
        if !roster.entry(&roster.signer_user_id).is_some_and(|e| e.status == MemberStatus::Active) {
            return Err(input(SIGNER_LEFT).into());
        }
        if !roster.members.iter().any(|entry| entry.active_with(Some(GroupRole::Members))) {
            return Err(input(NO_HOLDER).into());
        }
        if let Some(copies) = copies {
            let key = &self.keys[version_index(roster.group_key_version)];
            let mut group_signed = false;
            let mut signed = false;
            for copy in copies {
                if !verify_group(key, statement, &copy.signature) {
                    continue;
                }
                group_signed = true;
                if signed_by_member(authority, &roster.signer_user_id, copy, self.ml_dsa_keys) {
                    signed = true;
                    break;
                }
            }
            if !group_signed {
                return Err(input(NOT_GROUP_SIGNED).into());
            }
            if !signed {
                return Err(input(NOT_MEMBER).into());
            }
        }
        if let Some(previous) = previous.filter(|at| at.dropped_holder) {
            // The roster that took a holder away was the last under that key. (A roster still
            // under that key is then one after its succession, refused above.)
            let out = self.verified.get(&previous.roster.group_key_version);
            if out.map(|s| s.last_roster_version) != Some(previous.roster.roster_version) {
                return Err(input(HOLDER_LEFT).into());
            }
        }
        if let Some(previous) = previous {
            check_entries(&previous.roster, roster)?;
        }
        check_areas(&self.area_keys, &self.commitments, previous.map(|previous| &previous.roster), roster)?;
        Ok(())
    }
}

/* The sides of a conflict, merged by digest and sorted by it. */
fn sides(all: Vec<MarkSide>) -> Vec<MarkSide> {
    let mut merged: BTreeMap<String, MarkSide> = BTreeMap::new();
    for side in all {
        match merged.get_mut(&side.digest) {
            None => {
                merged.insert(side.digest.clone(), side);
            }
            Some(held) => {
                for from in side.from {
                    if !held.from.contains(&from) {
                        held.from.push(from);
                    }
                }
                held.from.sort();
                if held.signer_user_id.is_none() {
                    held.signer_user_id = side.signer_user_id;
                }
            }
        }
    }
    merged.into_values().collect()
}

fn conflict(of: ForkOf, version: u64, all: Vec<MarkSide>) -> Result<(), Stop> {
    let merged = sides(all);
    if merged.len() > 1 {
        return Err(Stop::Fork(of, version, merged));
    }
    Ok(())
}

/* Served statements by digest, every distinct copy of their signatures kept. */
fn by_digest<T>(
    signed: &[SignedGroupStatement],
    parse: impl Fn(&[u8]) -> CoreResult<T>,
) -> CoreResult<BTreeMap<String, Served<T>>> {
    let mut out: BTreeMap<String, Served<T>> = BTreeMap::new();
    for copy in signed {
        let value = parse(&copy.statement)?;
        let key = digest(&copy.statement);
        let held = out.entry(key.clone()).or_insert(Served {
            value,
            statement: copy.statement.clone(),
            digest: key,
            copies: vec![],
        });
        if !held.copies.contains(copy) {
            held.copies.push(copy.clone());
        }
    }
    Ok(out)
}

/// Accepts a group's roster chain (2.4, 2.5, 2.7; the web's `acceptRosters`):
///
/// - `first_keys` are the version 1 group keys as served. They must be the
///   ones every pin and the cache name; with neither, `first_keys_checked`
///   must say the person just compared the words over them, or nothing is
///   accepted;
/// - `pins` are every group pin this person holds and `cache` this device's
///   record of what it verified ([`AcceptedRosters::cache`]): the person's
///   marks;
/// - `rosters` are every roster from version 1, or with a cache every one
///   after it; `successions` every group key succession;
/// - `ml_dsa_keys` maps the SHA-256 (base64url) of every ML-DSA key a signer's
///   entry names to that key;
/// - `me`, the reader's own account, so each roster's entry for it is checked.
///
/// The chain is the one ending at the latest roster served, linked by digest
/// back to version 1 (or to the cache); anything else served is a dead
/// branch. The person's marks must agree with each other and with that chain,
/// or this is a fork; a chain short of a mark is a rollback, refused. Then
/// each roster must hold under the group key current at its version, be
/// signed by a member active with `Members` on the roster before it, keep the
/// entry rules, and follow the succession a dropped holder makes due. Each
/// succession is taken as soon as the roster it is tied to is held.
#[cfg_attr(feature = "uniffi", uniffi::export)]
#[allow(clippy::too_many_arguments)]
pub fn accept_rosters(
    group_id: String,
    first_keys: GroupPublicKey,
    first_keys_checked: bool,
    pins: Vec<GroupPin>,
    rosters: Vec<SignedGroupStatement>,
    successions: Vec<SignedGroupStatement>,
    ml_dsa_keys: HashMap<String, String>,
    me: OwnIdentities,
    cache: Option<GroupChainCache>,
) -> CoreResult<RosterChain> {
    accept_rosters_joining(
        group_id,
        first_keys,
        first_keys_checked,
        pins,
        rosters,
        successions,
        ml_dsa_keys,
        me,
        cache,
        None,
    )
}

/// `accept_rosters` with the newcomer's join mark ([`JoinMark`]): the join code
/// they compared with the admitting admin's screen, held as one of their marks.
#[cfg_attr(feature = "uniffi", uniffi::export)]
#[allow(clippy::too_many_arguments)]
pub fn accept_rosters_joining(
    group_id: String,
    first_keys: GroupPublicKey,
    first_keys_checked: bool,
    pins: Vec<GroupPin>,
    rosters: Vec<SignedGroupStatement>,
    successions: Vec<SignedGroupStatement>,
    ml_dsa_keys: HashMap<String, String>,
    me: OwnIdentities,
    cache: Option<GroupChainCache>,
    join_mark: Option<JoinMark>,
) -> CoreResult<RosterChain> {
    match accept(
        &group_id,
        first_keys,
        first_keys_checked,
        pins,
        &rosters,
        &successions,
        &ml_dsa_keys,
        Some(&me),
        cache,
        join_mark.as_ref(),
    ) {
        Ok((chain, _)) => Ok(RosterChain::Accepted { chain: Arc::new(chain) }),
        Err(Stop::Fork(of, version, sides)) => Ok(RosterChain::Fork { of, version, sides }),
        Err(Stop::Refused(error)) => Err(error),
    }
}

/* SHA-256 of the version 1 Ed25519 key and the ML-DSA key's digest: how a pin's first keys compare. */
fn first_keys_mark(ed25519_public_key: &str, ml_dsa_public_key_digest: Option<&str>) -> String {
    let ed = decode("ed25519PublicKey", ed25519_public_key, Some(32));
    let ml = decode("mlDsaPublicKeyDigest", ml_dsa_public_key_digest.unwrap_or(""), Some(32));
    match (ed, ml) {
        (Ok(ed), Ok(ml)) => digest(&[ed, ml].concat()),
        _ => String::new(),
    }
}

/*
 * Acceptance, in four steps, each needing no more from the server than the
 * one before: (1) the person's own marks against each other, and the served
 * version 1 keys against the marks'; (2) the chain, linked from the latest
 * roster served down to version 1 or to the cache; (3) the chain verified in
 * one pass, rosters and successions, anything that fails refused; (4) the
 * marks against the verified chain. A side of a conflict names a signer only
 * when its statement was verified (in step 3, or by this device before, for
 * the cache). `me` is `None` when a chain is extended for a check, with no
 * reader to check.
 */
#[allow(clippy::too_many_arguments)]
fn accept(
    group_id: &str,
    first_keys: GroupPublicKey,
    first_keys_checked: bool,
    pins: Vec<GroupPin>,
    rosters: &[SignedGroupStatement],
    successions: &[SignedGroupStatement],
    ml_dsa_keys: &HashMap<String, String>,
    me: Option<&OwnIdentities>,
    cache: Option<GroupChainCache>,
    join_mark: Option<&JoinMark>,
) -> Result<(AcceptedRosters, BTreeMap<u64, CoreError>), Stop> {
    uuid(group_id, "group id")?;
    let pins =
        pins.into_iter().map(|pin| group_pin_check(group_id.into(), pin)).collect::<CoreResult<Vec<_>>>()?;
    let cached = cache.map(|cache| check_cache(group_id, cache)).transpose()?;
    if let Some(mark) = join_mark {
        check_join_mark(mark)?;
    }

    // (1) The person's marks: the pins' and the cache's rosters, group keys and version 1 keys.
    let mut roster_marks: BTreeMap<u64, Vec<MarkSide>> = BTreeMap::new();
    let mut key_mark_sides: BTreeMap<u64, Vec<MarkSide>> = BTreeMap::new();
    let mut first_marks: Vec<MarkSide> = vec![];
    let side = |digest: &str, from: MarkSource, signer: Option<String>| MarkSide {
        digest: digest.to_string(),
        from: vec![from],
        signer_user_id: signer,
    };
    for pin in &pins {
        roster_marks.entry(pin.roster_version).or_default().push(side(
            &pin.roster_digest,
            MarkSource::Pin,
            None,
        ));
        key_mark_sides.entry(pin.key_version).or_default().push(side(
            &pin.group_key_digest,
            MarkSource::Pin,
            None,
        ));
        first_marks.push(side(
            &first_keys_mark(&pin.first_ed25519_public_key, Some(&pin.first_ml_dsa_public_key_digest)),
            MarkSource::Pin,
            None,
        ));
    }
    if let Some(cached) = &cached {
        // This device verified the cache's statements: its last roster's signer, its
        // successions' and the creator are known.
        let last = cached.roster_digests.len();
        for (index, at) in cached.roster_digests.iter().enumerate() {
            let signer = (index + 1 == last).then(|| cached.roster.signer_user_id.clone());
            roster_marks.entry(index as u64 + 1).or_default().push(side(at, MarkSource::Cache, signer));
        }
        for (index, key) in cached.cache.group_keys.iter().enumerate() {
            let signer = index.checked_sub(1).map(|i| cached.cache.successions[i].signer_user_id.clone());
            key_mark_sides.entry(index as u64 + 1).or_default().push(side(
                &group_key_digest_of(key)?,
                MarkSource::Cache,
                signer,
            ));
        }
        let first = &cached.cache.group_keys[0];
        first_marks.push(side(
            &first_keys_mark(&first.ed25519_public_key, ml_dsa_digest(&first.ml_dsa_public_key).as_deref()),
            MarkSource::Cache,
            Some(cached.cache.creator_user_id.clone()),
        ));
    }
    // Marks that disagree with each other need nothing from the server: version 1 keys first,
    // then rosters, then group keys, by version.
    conflict(ForkOf::GroupKey, 1, first_marks.clone())?;
    for (version, all) in &roster_marks {
        conflict(ForkOf::Roster, *version, all.clone())?;
    }
    for (version, all) in &key_mark_sides {
        conflict(ForkOf::GroupKey, *version, all.clone())?;
    }
    // Only now is anything served looked at: junk the server adds can refuse, never hide the
    // warning the person's own marks raise.
    let rosters = by_digest(rosters, parse_roster)?;
    if rosters.values().any(|at| at.value.group_id != group_id) {
        return Err(input("This roster is for another group.").into());
    }
    let successions = by_digest(successions, parse_succession)?;
    // The served version 1 keys must be the ones the marks agree on, or, with no mark at all, the
    // ones the person just checked the words over.
    match first_marks.first() {
        Some(mark) => {
            let served = first_keys_mark(
                &first_keys.ed25519_public_key,
                ml_dsa_digest(&first_keys.ml_dsa_public_key).as_deref(),
            );
            if served != mark.digest {
                return Err(input(NOT_CHECKED).into());
            }
        }
        None if !first_keys_checked => {
            return Err(input("These group keys have not been checked: compare the join code first.").into())
        }
        None => {}
    }

    // (2) The chain: from the latest roster served, linked by digest down to the cache or to 1.
    let cached_version = cached.as_ref().map(|c| c.roster_digests.len() as u64).unwrap_or(0);
    let extending = cached.is_some() && rosters.values().all(|at| at.value.roster_version > cached_version);
    let head = rosters
        .values()
        .map(|at| at.value.roster_version)
        .chain([if extending { cached_version } else { 0 }])
        .max()
        .unwrap_or(0);
    if head == 0 {
        return Err(input("This group has no member list yet.").into());
    }
    let bottom = if extending { cached_version } else { 0 };
    let mut path: BTreeMap<u64, Served<Roster>> = BTreeMap::new();
    if head > bottom {
        let tops: Vec<&Served<Roster>> =
            rosters.values().filter(|at| at.value.roster_version == head).collect();
        if tops.len() > 1 {
            return Err(input("The server served more than one latest member list.").into());
        }
        let mut at = tops.first().copied();
        for version in (bottom + 1..=head).rev() {
            let Some(here) = at.filter(|here| here.value.roster_version == version) else {
                return Err(input(NOT_FOLLOWING).into());
            };
            path.insert(version, here.clone());
            at = if version > 1 { rosters.get(&here.value.previous_roster_digest) } else { None };
        }
        // Rosters after the cache that do not continue it: fetch the chain again from version 1,
        // where the cache is one more mark.
        if let (true, Some(cached)) = (extending, &cached) {
            if Some(&path[&(bottom + 1)].value.previous_roster_digest) != cached.roster_digests.last() {
                return Err(input(NOT_EXTENDING).into());
            }
        }
    }

    // (3) One pass along the chain: keys, signers and entries. A group key mark (they agree by
    // now) chooses among valid successions; each is taken as soon as the roster it is tied to is
    // held, so the rosters after it are judged under the new key.
    let mut state = State::of(group_id, ml_dsa_keys, if extending { cached.as_ref() } else { None });
    if !extending {
        state.keys.push(first_keys.clone());
    }
    for (version, all) in &key_mark_sides {
        state.key_marks.insert(*version, sides(all.clone()).remove(0));
    }
    for at in successions.values() {
        state.candidates.entry(at.value.old_version).or_default().push(at.clone());
    }
    state.establish_all()?;
    for version in bottom + 1..=head {
        let at = &path[&version];
        let previous = state.held.last().cloned();
        state.roster_rules(&at.value, &at.statement, Some(&at.copies), previous.as_ref())?;
        fold_areas(&mut state.area_keys, &mut state.commitments, &at.value);
        state.held.push(Held {
            roster: at.value.clone(),
            statement: at.statement.clone(),
            digest: at.digest.clone(),
            dropped_holder: previous.as_ref().is_some_and(|p| drops_holder(&p.roster, &at.value)),
        });
        state.establish_all()?;
    }

    // (4) The marks against the verified chain. A signer is named only for a statement verified
    // here, or by this device before (the cache's).
    let verified_signers: HashMap<String, String> =
        state.held.iter().map(|at| (at.digest.clone(), at.roster.signer_user_id.clone())).collect();
    let signed = |all: &[MarkSide]| -> Vec<MarkSide> {
        all.iter()
            .map(|s| MarkSide {
                signer_user_id: s.signer_user_id.clone().or_else(|| verified_signers.get(&s.digest).cloned()),
                ..s.clone()
            })
            .collect()
    };
    let creator_user_id = match (&cached, extending) {
        (Some(cached), true) => cached.cache.creator_user_id.clone(),
        _ => state.held[0].roster.signer_user_id.clone(),
    };
    // Roster marks the chain does not pass through: a fork; beyond it: a rollback.
    let chain_digest = |version: u64| -> String {
        if version <= bottom {
            cached.as_ref().expect("extending").roster_digests[version_index(version)].clone()
        } else {
            path[&version].digest.clone()
        }
    };
    for (version, all) in roster_marks.range(..=head) {
        let mut sides = all.clone();
        sides.push(side(&chain_digest(*version), MarkSource::Served, None));
        conflict(ForkOf::Roster, *version, signed(&sides))?;
    }
    if roster_marks.keys().any(|version| *version > head) {
        return Err(input(OLDER).into());
    }
    // The join mark: the roster that admitted the newcomer, by its twelve-word code.
    if let Some(mark) = join_mark {
        if mark.roster_version > head {
            return Err(input(OLDER).into());
        }
        let digest = chain_digest(mark.roster_version);
        // The group key that roster is under: one above every succession tied to an earlier roster.
        let key_version =
            1 + state.verified.values().filter(|out| out.last_roster_version < mark.roster_version).count()
                as u64;
        let code = join_code(digest.clone(), state.keys[version_index(key_version)].clone(), key_version)?;
        if code != mark.code {
            return Err(Stop::Fork(
                ForkOf::Roster,
                mark.roster_version,
                sides(vec![
                    MarkSide {
                        digest: mark.code.join(" "),
                        from: vec![MarkSource::Join],
                        signer_user_id: None,
                    },
                    MarkSide {
                        digest: digest.clone(),
                        from: vec![MarkSource::Served],
                        signer_user_id: verified_signers.get(&digest).cloned(),
                    },
                ]),
            ));
        }
    }
    // Group key marks: each the chain's; beyond it, a rollback (or a succession withheld).
    for (version, mark) in state.key_marks.clone() {
        if version > state.current() {
            continue;
        }
        let ours = group_key_digest_of(&state.keys[version_index(version)])?;
        let signer = state.verified.get(&(version - 1)).map(|v| v.signer_user_id.clone());
        conflict(ForkOf::GroupKey, version, vec![mark, side(&ours, MarkSource::Served, signer)])?;
    }
    if key_mark_sides.keys().any(|version| *version > state.current()) {
        return Err(input(OLDER).into());
    }

    // The keys each member's entries named and the reader's own entries, on the rosters this
    // acceptance added (the cache's last roster is already in its history). The reader's entry
    // must name one of their identities, and never one older than the roster before named.
    let (mut key_history, mut own_entry_wrong_at) = match (&cached, extending) {
        (Some(cached), true) => (cached.cache.key_history.clone(), cached.cache.own_entry_wrong_at.clone()),
        _ => (HashMap::new(), vec![]),
    };
    // Whether the roster lists the reader, and the key version of their identity it names.
    let mine_at = |roster: &Roster| -> (bool, Option<u64>) {
        let Some(entry) = me.and_then(|me| roster.entry(&me.user_id)) else {
            return (false, None);
        };
        let ours =
            me.into_iter().flat_map(|me| &me.identities).find(|identity| served_is_entry(identity, entry));
        (true, ours.map(|identity| identity.key_version))
    };
    let mut last_own = match (&cached, extending) {
        (Some(cached), true) => mine_at(&cached.roster).1,
        _ => None,
    };
    let newest_own = me.into_iter().flat_map(|me| &me.identities).map(|i| i.key_version).max().unwrap_or(0);
    let mut own_entry_behind_at = vec![];
    let fresh = if extending { &state.held[1..] } else { &state.held[..] };
    // Every area key the rosters listed, each area's versions in order (check_areas, fold_areas).
    let area_keys = state.area_keys.clone();
    for at in fresh {
        for entry in &at.roster.members {
            let seen: &mut Vec<KeySet> = key_history.entry(entry.user_id.clone()).or_default();
            let set = key_set_of(entry);
            if !seen.contains(&set) {
                seen.push(set);
            }
        }
        let (listed, key_version) = mine_at(&at.roster);
        if !listed {
            continue;
        }
        if key_version.is_none() || last_own.zip(key_version).is_some_and(|(last, now)| now < last) {
            own_entry_wrong_at.push(at.roster.roster_version);
        } else if key_version.is_some_and(|now| now < newest_own)
            && me
                .and_then(|me| at.roster.entry(&me.user_id))
                .is_some_and(|entry| entry.since_version == at.roster.roster_version)
        {
            own_entry_behind_at.push(at.roster.roster_version);
        }
        if key_version.is_some() {
            last_own = key_version;
        }
    }
    let latest = state.held.last().expect("a roster").clone();
    let mut roster_digests: Vec<String> =
        if extending { cached.as_ref().expect("extending").roster_digests.clone() } else { vec![] };
    roster_digests.extend(path.values().map(|at| at.digest.clone()));
    let mut dead: Vec<(u64, String, String)> = rosters
        .values()
        .filter(|at| !roster_digests.contains(&at.digest))
        .map(|at| (at.value.roster_version, at.digest.clone(), at.value.signer_user_id.clone()))
        .collect();
    dead.sort();
    let dead_branches =
        dead.into_iter().map(|(version, _, signer_user_id)| DeadBranch { version, signer_user_id }).collect();
    let successions_kept: Vec<CachedSuccession> = state
        .verified
        .values()
        .map(|at| CachedSuccession {
            last_roster_version: at.last_roster_version,
            digest: at.digest.clone(),
            signer_user_id: at.signer_user_id.clone(),
        })
        .collect();
    let group_key = state.keys.last().expect("version 1").clone();
    let cache = GroupChainCache {
        group_id: group_id.into(),
        roster_digests: roster_digests.clone(),
        statement: encode(&latest.statement),
        dropped_holder: latest.dropped_holder,
        group_keys: state.keys.clone(),
        successions: successions_kept,
        creator_user_id: creator_user_id.clone(),
        key_history: key_history.clone(),
        area_keys: area_keys.clone(),
        own_entry_wrong_at: own_entry_wrong_at.clone(),
    };
    let chain = AcceptedRosters {
        group_id: group_id.into(),
        kind: latest.roster.kind,
        roster: latest.roster.clone(),
        statement: latest.statement.clone(),
        roster_digest: latest.digest.clone(),
        roster_digests,
        dropped_holder: latest.dropped_holder,
        group_key_version: state.current(),
        group_key_digest: group_key_digest_of(&group_key)?,
        group_key,
        group_keys: state.keys.clone(),
        creator_user_id,
        succession_due: latest.dropped_holder
            && state.verified.get(&latest.roster.group_key_version).map(|s| s.last_roster_version)
                != Some(latest.roster.roster_version),
        key_history,
        area_keys,
        own_entry_wrong_at,
        own_entry_behind_at,
        dead_branches,
        cache,
    };
    Ok((chain, state.refused))
}

/* Acceptance continuing from `chain`'s cache with `rosters` and `successions` after it. */
fn extend(
    chain: &AcceptedRosters,
    rosters: &[SignedGroupStatement],
    successions: &[SignedGroupStatement],
    ml_dsa_keys: &HashMap<String, String>,
) -> CoreResult<(AcceptedRosters, BTreeMap<u64, CoreError>)> {
    match accept(
        &chain.group_id,
        chain.group_keys[0].clone(),
        true,
        vec![],
        rosters,
        successions,
        ml_dsa_keys,
        None,
        Some(chain.cache.clone()),
        None,
    ) {
        Ok(result) => Ok(result),
        Err(Stop::Fork(..)) => Err(input(NOT_FOLLOWING)),
        Err(Stop::Refused(error)) => Err(error),
    }
}

/// Whether `roster` is the roster every device holding `chain` will accept as
/// the next one (the web's `checkNextRoster`): acceptance itself, continuing
/// from the chain's cache with this one roster. With `identities` (every
/// identity each member has had, as the server holds them), every entry new
/// or changed in it must also be one of its member's identities, keys
/// statement holding: a holder cannot write keys the member never had. The
/// server must run this before it stores a roster (4); the server's own
/// acceptance (and the chain it stores next) is the web's, TypeScript only:
/// no app is the server, so nothing here returns a chain that skipped the
/// reader's marks.
// (Not `signed`: that is a C keyword, and the Swift bindings go through a C header.)
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn roster_check_next(
    chain: Arc<AcceptedRosters>,
    roster: SignedGroupStatement,
    ml_dsa_keys: HashMap<String, String>,
    identities: Option<HashMap<String, Vec<PublicIdentity>>>,
) -> CoreResult<()> {
    let (next, _) = extend(&chain, &[roster], &[], &ml_dsa_keys)?;
    let Some(identities) = identities else {
        return Ok(());
    };
    for entry in &next.roster.members {
        if chain.roster.entry(&entry.user_id).is_some_and(|before| same_keys(before, entry)) {
            continue;
        }
        let known = identities.get(&entry.user_id).into_iter().flatten().any(|identity| {
            served_is_entry(&served_keys(identity), entry)
                && identity_verify_keys(entry.user_id.clone(), identity.clone())
        });
        if !known {
            return Err(input("This entry names keys its member never had."));
        }
    }
    Ok(())
}

/// Whether `succession` is a group key succession every device holding
/// `chain` will take (the web's `checkNextSuccession`): acceptance itself,
/// continuing from the chain's cache with this one succession, which must
/// then replace the chain's current key. Clients run this before signing one,
/// and the server must run it before storing one (4).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn group_succession_check_next(
    chain: Arc<AcceptedRosters>,
    succession: SignedGroupStatement,
    ml_dsa_keys: HashMap<String, String>,
) -> CoreResult<()> {
    let (next, refused) = extend(&chain, &[], &[succession], &ml_dsa_keys)?;
    if next.group_key_version != chain.group_key_version + 1 {
        return Err(refused.get(&chain.group_key_version).cloned().unwrap_or_else(|| input(NO_SUCCESSION)));
    }
    Ok(())
}

/// The group pin to write after an accepted chain: the chain's latest roster
/// and group key, the areas' highest marks across every pin held, and the
/// earliest words check (`checked_at` when there is no pin yet, a newcomer).
/// Every pin given must already be on the chain ([`accept_rosters`] with
/// them).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn pin_after(
    pins: Vec<GroupPin>,
    chain: Arc<AcceptedRosters>,
    checked_at: String,
) -> CoreResult<GroupPin> {
    check_time(&checked_at)?;
    let mut areas: HashMap<String, u64> = HashMap::new();
    let mut earliest: Option<String> = None;
    for pin in pins {
        let pin = group_pin_check(chain.group_id.clone(), pin)?;
        if chain.roster_digests.get(version_index(pin.roster_version)) != Some(&pin.roster_digest) {
            return Err(input("This pin is not on the accepted member list."));
        }
        for (workspace_id, version) in pin.areas {
            let mark = areas.entry(workspace_id).or_insert(0);
            *mark = (*mark).max(version);
        }
        if earliest.as_ref().is_none_or(|at| pin.checked_at < *at) {
            earliest = Some(pin.checked_at);
        }
    }
    let first = &chain.group_keys[0];
    Ok(GroupPin {
        first_ed25519_public_key: first.ed25519_public_key.clone(),
        first_ml_dsa_public_key_digest: ml_dsa_digest(&first.ml_dsa_public_key)
            .ok_or_else(|| input("Invalid group key."))?,
        checked_at: earliest.unwrap_or(checked_at),
        key_version: chain.group_key_version,
        group_key_digest: chain.group_key_digest.clone(),
        roster_version: chain.roster.roster_version,
        roster_digest: chain.roster_digest.clone(),
        areas,
    })
}

/// Who a succession leaves out (2.5): the `Members` holders active on the
/// roster it is tied to that are not among `sealed_to`, the holders the new
/// seed was sealed to. Anyone listed was dropped without being removed: a
/// warning.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn group_dropped_holders(roster: Roster, sealed_to: Vec<String>) -> Vec<String> {
    roster
        .members
        .iter()
        .filter(|entry| entry.active_with(Some(GroupRole::Members)) && !sealed_to.contains(&entry.user_id))
        .map(|entry| entry.user_id.clone())
        .collect()
}

/* Folding in changes (2.4) */

fn served_keys(identity: &PublicIdentity) -> ServedKeys {
    ServedKeys {
        key_version: identity.key_version,
        encryption_public_key: identity.encryption_public_key.clone(),
        signing_public_key: identity.signing_public_key.clone(),
        ml_dsa_public_key: identity.ml_dsa_public_key.clone(),
        kem_public_key: identity.kem_public_key.clone(),
    }
}

/*
 * Where a succession chain starts from a set of keys an entry named. No key
 * version: an entry's key version is a holder's claim, so it sets no floor
 * for the member's own chain.
 */
fn pinned_of(set: &KeySet) -> CoreResult<PinnedKeys> {
    Ok(PinnedKeys {
        key_version: None,
        encryption_public_key: set.encryption_public_key.clone(),
        signing_public_key: set.signing_public_key.clone(),
        ml_dsa_public_key_hash: digest_hex(set.ml_dsa_public_key_digest.clone())?,
    })
}

/// The key parts of a version 3 personal pin, as comparing words (or "Trust
/// as Acme does") writes them: X25519 and Ed25519 (base64url), the SHA-256 of
/// the ML-DSA and ML-KEM keys (lowercase hex, as a pin keeps them) and the
/// version 3 fingerprint. The app adds the email, name and time.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct VerifiedPin {
    pub user_id: String,
    pub key_version: u64,
    pub encryption_public_key: String,
    pub signing_public_key: String,
    pub ml_dsa_public_key_hash: String,
    pub kem_public_key_hash: String,
    pub fingerprint: String,
    /// The group the pin was trusted through ("Trust as Acme does"), none for a
    /// words check: kept on the pin as `trustedVia`. Group verdicts ask the
    /// successor's consent of links from such a pin, and no member is admitted
    /// from one. Required: a pin's origin is never left out by default.
    pub trusted_via: Option<String>,
}

/// A new member's entry, only from the keys their words check confirmed: a
/// version 3 pin of them that verifies, and a served identity whose four keys
/// are the pinned ones (the lattice keys by digest) and whose keys statement
/// holds. Anything else and nobody is added.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn roster_entry_new(
    pin: VerifiedPin,
    served: PublicIdentity,
    roles: Vec<GroupRole>,
    roster_version: u64,
) -> CoreResult<RosterMember> {
    // A pin trusted through a group is that group's word, not a words check of the newcomer.
    let checked = pin.trusted_via.is_none()
        && pin_verified(
            pin.encryption_public_key.clone(),
            pin.signing_public_key.clone(),
            Some(pin.ml_dsa_public_key_hash.clone()),
            Some(pin.kem_public_key_hash.clone()),
            pin.fingerprint.clone(),
        )
        && identity_verify_keys(pin.user_id.clone(), served.clone())
        && served.encryption_public_key == pin.encryption_public_key
        && served.signing_public_key == pin.signing_public_key
        && decode("mlDsaPublicKey", &served.ml_dsa_public_key, Some(ML_DSA_PUBLIC_KEY_BYTES))
            .is_ok_and(|key| key_digest(key) == pin.ml_dsa_public_key_hash)
        && decode("kemPublicKey", &served.kem_public_key, Some(KEM_PUBLIC_KEY_BYTES))
            .is_ok_and(|key| key_digest(key) == pin.kem_public_key_hash);
    let digests = digest_base64url(pin.ml_dsa_public_key_hash.clone())
        .ok()
        .zip(digest_base64url(pin.kem_public_key_hash.clone()).ok());
    let (Some((ml_dsa, kem)), true) = (digests, checked) else {
        return Err(input("These are not the keys whose words were checked."));
    };
    let mut roles = roles;
    roles.sort();
    Ok(RosterMember {
        user_id: pin.user_id,
        key_version: served.key_version,
        encryption_public_key: served.encryption_public_key,
        signing_public_key: served.signing_public_key,
        ml_dsa_public_key_digest: ml_dsa,
        kem_public_key_digest: kem,
        status: MemberStatus::Active,
        roles,
        since_version: roster_version,
    })
}

/// The creator's own entry on roster version 1 (`since_version` 1), and for
/// nothing else: no one pins themselves, so [`roster_entry_new`] does not
/// apply, and every later change to one's own entry is a fold-in
/// ([`roster_entry_fold_in`]). `identity` is the account's own current
/// identity as its device opened it (the public parts of the envelope it
/// opened with its own account key). Its keys statement must hold under
/// `user_id`, so the entry names a version 2 identity whose four keys belong
/// together, the lattice keys by digest; anything else and no entry is made.
/// It does not prove the identity is the caller's current one (an earlier
/// identity's statement holds too). Roster version 1's signer signature,
/// which acceptance checks under the keys this entry names, proves the entry
/// and the signer are the same identity; that the identity is the account's
/// newest is the creating client's check (design 3.1: the staged acceptance
/// with freshly fetched own identities reports no wrong or behind own entry).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn roster_entry_own(
    user_id: String,
    identity: PublicIdentity,
    roles: Vec<GroupRole>,
) -> CoreResult<RosterMember> {
    if !identity_verify_keys(user_id.clone(), identity.clone()) {
        return Err(input("These are not this account’s keys."));
    }
    let ml_dsa = ml_dsa_digest(&identity.ml_dsa_public_key).ok_or_else(|| input("Invalid identity key."))?;
    let kem = digest(&decode("kemPublicKey", &identity.kem_public_key, Some(KEM_PUBLIC_KEY_BYTES))?);
    let mut roles = roles;
    roles.sort();
    Ok(RosterMember {
        user_id,
        key_version: identity.key_version,
        encryption_public_key: identity.encryption_public_key,
        signing_public_key: identity.signing_public_key,
        ml_dsa_public_key_digest: ml_dsa,
        kem_public_key_digest: kem,
        status: MemberStatus::Active,
        roles,
        since_version: 1,
    })
}

/// An entry after folding in: possibly changed, and whether the member needs a check.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct FoldedEntry {
    pub entry: RosterMember,
    pub changed: bool,
    pub needs_check: bool,
}

/// An existing entry, folded in before the next roster is signed: unchanged
/// when the served identity is the entry's; moved to the served identity only
/// when its keys statement holds and the member's version 2 succession chain
/// leads from the entry's keys (ML-DSA digest included; not its key version,
/// a holder's claim) to it, however many links that takes; otherwise unchanged, and the member needs a check. The
/// server's word alone never changes an entry.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn roster_entry_fold_in(
    entry: RosterMember,
    served: PublicIdentity,
    links: Vec<SuccessionLink>,
    roster_version: u64,
) -> CoreResult<FoldedEntry> {
    let unchanged = |entry: RosterMember, needs_check| FoldedEntry { entry, changed: false, needs_check };
    let keys = served_keys(&served);
    if served_is_entry(&keys, &entry) {
        return Ok(unchanged(entry, false));
    }
    // The group walk from the entry's keys, on each link's version 2 signature: the entry is a
    // holder's claim already, and a planter could consent to his own successor anyway.
    if !identity_verify_keys(entry.user_id.clone(), served.clone())
        || !matches!(
            succession_path(
                &entry.user_id,
                &pinned_of(&key_set_of(&entry))?,
                &keys,
                &links,
                &VerifiedLinks::new(),
                None,
                &[]
            ),
            SuccessionPath::Path(_)
        )
    {
        return Ok(unchanged(entry, true));
    }
    let ml_dsa = ml_dsa_digest(&served.ml_dsa_public_key).ok_or_else(|| input("Invalid identity key."))?;
    let kem = digest(&decode("kemPublicKey", &served.kem_public_key, Some(KEM_PUBLIC_KEY_BYTES))?);
    Ok(FoldedEntry {
        entry: RosterMember {
            key_version: served.key_version,
            encryption_public_key: served.encryption_public_key,
            signing_public_key: served.signing_public_key,
            ml_dsa_public_key_digest: ml_dsa,
            kem_public_key_digest: kem,
            since_version: roster_version,
            ..entry
        },
        changed: true,
        needs_check: false,
    })
}

/// A group's first roster, for its creator to sign (2.4, 3.1): version 1, no
/// previous digest, under group key 1, the creator as its only entry and its
/// signer (roles sorted, `since_version` 1), and a row at version 1 for each
/// of `area_keys` (computed here, as [`roster_next`] does: a client never
/// hands in a row of its own making). Refused unless it keeps every rule
/// acceptance holds roster version 1 to, signatures aside: the creator active
/// with `Members`, only the kind's roles, no area named twice, no key used
/// twice, at most 1,024 family areas. So a creator never signs a first roster
/// that no device, the server included, would take.
///
/// ```
/// use hushos_core::*;
/// let user_id = "00000001-abcd-4abc-8abc-abcdefabcdef".to_string();
/// let envelope = identity_create(user_id.clone(), vec![7; 32], 1)?;
/// let creator = roster_entry_own(user_id, public_identity(envelope)?, vec![GroupRole::Members])?;
/// let area = AreaKey { workspace_id: "80558a81-8dfc-8914-8447-0417b55e2ec5".into(), workspace_key: vec![77; 32] };
/// let group_id = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".to_string();
/// let roster = roster_first(group_id.clone(), GroupKind::Family, creator.clone(), Some(vec![area]))?;
/// assert_eq!((roster.roster_version, roster.areas[0].workspace_key_version), (1, 1));
/// // A creator who cannot sign the next roster makes no group.
/// let no_holder = RosterMember { roles: vec![GroupRole::Billing], ..creator };
/// assert!(roster_first(group_id, GroupKind::Family, no_holder, None).is_err());
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn roster_first(
    group_id: String,
    kind: GroupKind,
    creator: RosterMember,
    area_keys: Option<Vec<crate::groups::AreaKey>>,
) -> CoreResult<Roster> {
    let areas = crate::groups::rows_after(&HashMap::new(), area_keys.unwrap_or_default())?;
    let mut roles = creator.roles;
    roles.sort();
    let roster = Roster {
        group_id,
        kind,
        roster_version: 1,
        previous_roster_digest: String::new(),
        group_key_version: 1,
        signer_user_id: creator.user_id.clone(),
        members: vec![RosterMember { roles, since_version: 1, ..creator }],
        areas,
    };
    let statement = roster_bytes(&roster)?;
    // The very rules acceptance applies to version 1, signatures aside. Unsigned, the group key
    // is never read: the one placeholder says only that the roster is under key 1.
    let empty = HashMap::new();
    let mut state = State::of(&roster.group_id, &empty, None);
    state.keys.push(GroupPublicKey { ed25519_public_key: String::new(), ml_dsa_public_key: String::new() });
    match state.roster_rules(&roster, &statement, None, None) {
        Ok(()) => Ok(roster),
        Err(Stop::Refused(error)) => Err(error),
        Err(Stop::Fork(..)) => Err(input(NOT_FOLLOWING)),
    }
}

/// The roster after `chain`'s latest, for `signer_user_id` to sign: the next
/// version, chained to its digest, under the current group key, members
/// sorted by id with their roles sorted, and each entry's `since_version` set
/// here (the previous one when nothing in the entry changed, this version
/// when anything did). Refused unless every device holding the chain would
/// accept it: a holder never signs a roster the group cannot take.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn roster_next(
    chain: Arc<AcceptedRosters>,
    members: Vec<RosterMember>,
    signer_user_id: String,
    area_keys: Option<Vec<crate::groups::AreaKey>>,
) -> CoreResult<Roster> {
    let version = chain.roster.roster_version + 1;
    let mut members: Vec<RosterMember> = members
        .into_iter()
        .map(|mut member| {
            member.roles.sort();
            member.since_version = match chain.roster.entry(&member.user_id) {
                Some(before) if same_entry(before, &member) => before.since_version,
                _ => version,
            };
            member
        })
        .collect();
    members.sort_by(|a, b| a.user_id.cmp(&b.user_id));
    // The new keys of the areas this roster creates or rotates (areas_to_rotate says which a
    // removal needs): the rows are computed here, and refused when a key is any of the group's
    // earlier ones, so a client cannot hand in a row of its own making.
    let areas = crate::groups::area_rows(&chain, area_keys.unwrap_or_default())?;
    let roster = Roster {
        group_id: chain.group_id.clone(),
        kind: chain.kind,
        roster_version: version,
        previous_roster_digest: chain.roster_digest.clone(),
        group_key_version: chain.group_key_version,
        signer_user_id,
        members,
        areas,
    };
    let statement = roster_bytes(&roster)?;
    // The very rules acceptance applies, from the chain's cache, signatures aside.
    let cached = check_cache(&chain.group_id, chain.cache.clone())?;
    let empty = HashMap::new();
    let state = State::of(&chain.group_id, &empty, Some(&cached));
    match state.roster_rules(&roster, &statement, None, state.held.last()) {
        Ok(()) => Ok(roster),
        Err(Stop::Refused(error)) => Err(error),
        Err(Stop::Fork(..)) => Err(input(NOT_FOLLOWING)),
    }
}

/// Whether a member's own entry names their own keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum OwnEntry {
    Ok,
    Absent,
    /// A hard warning: the roster names keys this account does not hold.
    Wrong,
}

/// Whether the reader's own entry names their own keys (`me`: the public keys
/// they re-derived from their own seeds). [`accept_rosters`] checks every
/// roster this way.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn roster_own_entry(roster: Roster, user_id: String, me: ServedKeys) -> OwnEntry {
    match roster.entry(&user_id) {
        None => OwnEntry::Absent,
        Some(entry) if served_is_entry(&me, entry) => OwnEntry::Ok,
        Some(_) => OwnEntry::Wrong,
    }
}

/// "Trust as Acme does" (2.8): a version 3 personal pin from the member's
/// active entry on the accepted roster and the served identity that matches
/// it (all four keys, the lattice ones by digest, and its keys statement), as
/// an explicit act by the reader.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn trust_as_group_does(
    chain: Arc<AcceptedRosters>,
    user_id: String,
    served: PublicIdentity,
) -> CoreResult<VerifiedPin> {
    let refused = || input("These are not the keys on the group’s member list.");
    let entry = chain.roster.entry(&user_id).ok_or_else(refused)?.clone();
    if !entry.active_with(None)
        || !served_is_entry(&served_keys(&served), &entry)
        || !identity_verify_keys(entry.user_id.clone(), served)
    {
        return Err(refused());
    }
    let fingerprint = identity_fingerprint(
        decode("encryptionPublicKey", &entry.encryption_public_key, Some(32))?,
        decode("signingPublicKey", &entry.signing_public_key, Some(32))?,
        decode("key digest", &entry.ml_dsa_public_key_digest, Some(32))?,
        decode("key digest", &entry.kem_public_key_digest, Some(32))?,
    )?;
    Ok(VerifiedPin {
        ml_dsa_public_key_hash: digest_hex(entry.ml_dsa_public_key_digest.clone())?,
        kem_public_key_hash: digest_hex(entry.kem_public_key_digest.clone())?,
        user_id: entry.user_id,
        key_version: entry.key_version,
        encryption_public_key: entry.encryption_public_key,
        signing_public_key: entry.signing_public_key,
        fingerprint,
        trusted_via: Some(chain.group_id.clone()),
    })
}

/* Scoped verdicts (2.8) */

/// What the reader knows of a group's roster: accepted, forked, or not loaded
/// or not verified.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum GroupReading {
    Accepted { chain: Arc<AcceptedRosters> },
    Fork,
    Unavailable,
}

/// Whose key a writer's signature in a group's area is checked under.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum GroupWriterTrust {
    /// The roster does not speak here (another workspace, a writer not on it,
    /// or a fork): use the personal verdicts, as without groups.
    Outside,
    /// The roster, or what a disagreeing pin needs checking against, did not
    /// load or verify: fails closed.
    Unchecked,
    /// The roster's key for them; `via` the group when no personal pin agreed
    /// with it already; `followed` the identity the reader's pin should now
    /// follow. When the writer has replaced their identity and no roster has
    /// folded it in yet, their served identity is current instead, if their
    /// succession chain leads to it from the entry's keys. Earlier keys are
    /// retired only along the member's own verified succession chain to their
    /// served identity. `links_loaded` is false when the writer's served
    /// identity or links did not load: a signature their known keys do not
    /// hold is then unchecked, not bad.
    Roster { signer: TrustedKeys, via: Option<String>, followed: Option<ServedKeys>, links_loaded: bool },
    /// The reader's personal pin differs and no chain joins them.
    KeyConflict,
    /// Their entry is `Left`.
    FormerMember { signer: TrustedKeys, links_loaded: bool },
}

/*
 * The keys a verified succession chain retired on the way from `from` to the
 * served identity: `from`'s and each verified link's new key but the last.
 * Only the links the verifier returned count, never whatever else was served
 * beside them.
 */
fn retired_along(from: &PinnedKeys, chain: &[SuccessionLink]) -> Vec<Vec<u8>> {
    let mut retired =
        vec![decode("signingPublicKey", &from.signing_public_key, Some(32)).unwrap_or_default()];
    for link in chain.iter().take(chain.len().saturating_sub(1)) {
        retired.push(decode("signingPublicKey", &link.new_signing_public_key, Some(32)).unwrap_or_default());
    }
    retired
}

/* The links of `chain` up to and including the one leading to `keys`; none when none does. */
fn up_to(chain: &[SuccessionLink], keys: &PinnedKeys) -> Option<Vec<SuccessionLink>> {
    chain
        .iter()
        .position(|link| {
            link.new_encryption_public_key == keys.encryption_public_key
                && link.new_signing_public_key == keys.signing_public_key
                && ml_dsa_digest(&link.new_ml_dsa_public_key)
                    .is_some_and(|at| same_key_digest(Some(keys.ml_dsa_public_key_hash.clone()), at))
        })
        .map(|index| chain[..=index].to_vec())
}

/*
 * The keys before `pinned` on a verified chain from `from`: when the reader's
 * pin is at one of the member's later identities on that chain, the keys the
 * member had before it are their earlier keys too. Nothing when the chain
 * does not pass through the pinned keys.
 */
fn retired_before(from: &PinnedKeys, chain: &[SuccessionLink], pinned: &PinnedKeys) -> Vec<Vec<u8>> {
    for (index, link) in chain.iter().enumerate() {
        if link.new_encryption_public_key == pinned.encryption_public_key
            && link.new_signing_public_key == pinned.signing_public_key
            && ml_dsa_digest(&link.new_ml_dsa_public_key)
                .is_some_and(|at| same_key_digest(Some(pinned.ml_dsa_public_key_hash.clone()), at))
        {
            return retired_along(from, &chain[..=index]);
        }
    }
    vec![]
}

/// A verification cache for the group walk to share across calls (a
/// session's): links verified once are remembered by the SHA-256 of member,
/// proof and link, at most 4,096 of them (least recently used dropped first),
/// so each record read does not verify the same links again. It is locked
/// only to look up or store a result, never while a link is verified, so
/// concurrent reads do not wait on each other's verifications.
#[derive(Debug, Default)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct SuccessionCache {
    verified: VerifiedLinks,
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl SuccessionCache {
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn new() -> Arc<SuccessionCache> {
        Arc::new(SuccessionCache::default())
    }
}

/// A reader's pin of a writer, as group verdicts take it: its keys and its
/// origin together, so a caller cannot pass the keys and drop the origin.
/// `trusted_via` is the group the pin was trusted through ("Trust as Acme
/// does", the pin's `trustedVia`), none for a pin from the reader's own words
/// check; an empty one is no origin at all, and the verdict is unchecked.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct WriterPin {
    pub key_version: Option<u64>,
    pub encryption_public_key: String,
    pub signing_public_key: String,
    pub ml_dsa_public_key_hash: String,
    pub trusted_via: Option<String>,
}

impl WriterPin {
    /// A pin of `keys` with its origin (none for a words check).
    pub fn of(keys: PinnedKeys, trusted_via: Option<String>) -> WriterPin {
        WriterPin {
            key_version: keys.key_version,
            encryption_public_key: keys.encryption_public_key,
            signing_public_key: keys.signing_public_key,
            ml_dsa_public_key_hash: keys.ml_dsa_public_key_hash,
            trusted_via,
        }
    }
}

/// Whose key a writer's signature in `workspace_id` is checked under (2.8).
/// `areas` are the group pin's areas, the workspaces a verified grant tied to
/// this group; `pinned` the reader's verified version 3 pin of the writer;
/// `served` and `links` their identity as served and all their succession
/// links, `None` when they did not load. A reader with a personal pin retires
/// keys along the chain from that pin and, before it, along the member's
/// verified chain up to the pinned keys; one relying on the roster, along the
/// member's verified chain from their entry's and their first keys. Two
/// verified successions leaving one of the member's keys (an identity fork)
/// leave the signature unchecked. A pin trusted through a group
/// (`WriterPin::trusted_via`) is that group's word: links from it need the
/// successor's consent up to the entry's keys, wherever its keys sit in the
/// member's history, and a verdict it agrees with names that group. More links than anyone has, on the lag or pin walk, read as links
/// that did not load. `cache`, when given, is shared across calls.
#[cfg_attr(feature = "uniffi", uniffi::export)]
#[allow(clippy::too_many_arguments)]
pub fn group_writer_trust(
    group_id: String,
    areas: HashMap<String, u64>,
    reading: GroupReading,
    workspace_id: String,
    writer_user_id: String,
    pinned: Option<WriterPin>,
    served: Option<ServedKeys>,
    links: Option<Vec<SuccessionLink>>,
    cache: Option<Arc<SuccessionCache>>,
) -> GroupWriterTrust {
    if pinned.as_ref().is_some_and(|pin| pin.trusted_via.as_deref() == Some("")) {
        return GroupWriterTrust::Unchecked;
    }
    let pinned_via = pinned.as_ref().and_then(|pin| pin.trusted_via.clone());
    let pinned = pinned.map(|pin| PinnedKeys {
        key_version: pin.key_version,
        encryption_public_key: pin.encryption_public_key,
        signing_public_key: pin.signing_public_key,
        ml_dsa_public_key_hash: pin.ml_dsa_public_key_hash,
    });
    let (mut served, mut links) = (served, links);
    if !areas.contains_key(&workspace_id) {
        return GroupWriterTrust::Outside;
    }
    let chain = match reading {
        GroupReading::Unavailable => return GroupWriterTrust::Unchecked,
        GroupReading::Fork => return GroupWriterTrust::Outside,
        GroupReading::Accepted { chain } => chain,
    };
    if chain.group_id != group_id {
        return GroupWriterTrust::Unchecked;
    }
    let Some(entry) = chain.roster.entry(&writer_user_id) else {
        return GroupWriterTrust::Outside;
    };
    let own = key_set_of(entry);
    let (Ok(entry_key), Ok(own_pinned)) =
        (decode("signingPublicKey", &entry.signing_public_key, Some(32)), pinned_of(&own))
    else {
        return GroupWriterTrust::Unchecked;
    };
    let local = VerifiedLinks::new();
    let verified: &VerifiedLinks = cache.as_ref().map_or(&local, |cache| &cache.verified);
    let history: Vec<PinnedKeys> = chain
        .key_history
        .get(&entry.user_id)
        .into_iter()
        .flatten()
        .filter_map(|set| pinned_of(set).ok())
        .collect();
    let mut forked = false;
    let mut overflow = false;
    let mut path = |from: &PinnedKeys, from_first_keys: bool, consent: bool| match (&served, &links) {
        (Some(served), Some(links)) => {
            // Only links the successor consented to, up to the entry's keys: from the first keys,
            // and from a pin trusted through a group (`consent`).
            let until = consent.then_some(&own_pinned);
            match succession_path(&writer_user_id, from, served, links, verified, until, &history) {
                SuccessionPath::Path(chain) => Some(chain),
                // An identity fork, or a served identity a verified link has already left (rolled
                // back): nothing tells which identity is the member's now. On the walk from the
                // first keys it only voids that walk: whoever holds the first keys (a holder who
                // planted them) could otherwise turn every verdict of the member unchecked.
                SuccessionPath::Fork | SuccessionPath::Stale => {
                    if !from_first_keys {
                        forked = true;
                    }
                    None
                }
                // More links than anyone has is no verdict on the member (their keys are public,
                // so anyone can serve them): the links are read as not loaded.
                SuccessionPath::TooMany => {
                    if !from_first_keys {
                        overflow = true;
                    }
                    None
                }
                SuccessionPath::None => None,
            }
        }
        _ => None,
    };
    let first = chain
        .key_history
        .get(&entry.user_id)
        .and_then(|sets| sets.first())
        .filter(|first| **first != own)
        .and_then(|first| pinned_of(first).ok());
    let mut from_first = first.as_ref().and_then(|first| path(first, true, true));
    // The first keys' chain counts only up to the entry's keys: past them it is no evidence that
    // the first keys were the member's (a planter consents to his own successor).
    let mut to_entry = from_first.as_ref().and_then(|chain| up_to(chain, &own_pinned));
    // A succession no roster has folded in yet: from the entry's keys to the served identity.
    // (A chain from the entry's keys never ends at the entry itself, so this is a change.)
    let mut lag = path(&own_pinned, false, false);
    // A pin trusted through a group is the group's word, not the reader's: links from it need the
    // successor's consent up to the entry's keys, as from the first keys.
    let mut from_pin = pinned.as_ref().and_then(|pinned| path(pinned, false, pinned_via.is_some()));
    // Two successions the member signed from one key, or a served identity the member has already
    // replaced: nothing tells which identity is theirs now.
    if forked {
        return GroupWriterTrust::Unchecked;
    }
    // Too many links on the lag or pin walk: as if the links had not loaded. The entry's key stays
    // current, nothing is retired, and a signature under an unknown key reads unchecked.
    if overflow {
        (served, links) = (None, None);
        (from_first, to_entry, lag, from_pin) = (None, None, None, None);
    }
    let links_loaded = served.is_some() && links.is_some();
    let lagging = lag.is_some();
    let mut retired: Vec<Vec<u8>> = vec![];
    match &pinned {
        // A reader with a personal pin retires keys along the chain from that pin, and, before
        // it, along the member's chain from their entry or first keys up to the pinned keys.
        Some(pinned) => {
            if let Some(chain) = &from_pin {
                retired.extend(retired_along(pinned, chain));
            }
            if let Some(chain) = &lag {
                retired.extend(retired_before(&own_pinned, chain, pinned));
            }
            if let (Some(from), Some(to_entry), Some(whole)) = (&first, &to_entry, &from_first) {
                let before_pin = retired_before(from, to_entry, pinned);
                if !before_pin.is_empty() {
                    retired.extend(before_pin);
                } else if !retired_before(from, whole, pinned).is_empty() {
                    // A pin past the entry's keys: every first-chain key before the entry is before it.
                    retired.extend(retired_along(from, to_entry));
                }
            }
        }
        None => {
            if let Some(chain) = &lag {
                retired.extend(retired_along(&own_pinned, chain));
            }
            // Earlier keys count only along a verified chain from the member's first set of keys
            // on the chain, the one a words check admitted, to their entry's: never from a set a
            // holder wrote in later, and never past the entry.
            if let (Some(from), Some(chain)) = (&first, &to_entry) {
                retired.extend(retired_along(from, chain));
            }
        }
    }
    let current = match &served {
        Some(served) if lagging => {
            decode("signingPublicKey", &served.signing_public_key, Some(32)).unwrap_or_default()
        }
        _ => entry_key,
    };
    let signer = TrustedKeys { current, retired };
    // A former member still holds their keys, and a signature has no trustworthy date. Marked
    // before any personal pin is consulted: inside the group's areas, leaving is what matters.
    if entry.status == MemberStatus::Left {
        return GroupWriterTrust::FormerMember { signer, links_loaded };
    }
    let Some(pinned) = pinned else {
        return GroupWriterTrust::Roster {
            signer,
            via: Some(chain.group_id.clone()),
            followed: None,
            links_loaded,
        };
    };
    let agrees = |encryption: &str, signing: &str, ml_dsa_digest: &str| {
        pinned.encryption_public_key == encryption
            && pinned.signing_public_key == signing
            && same_key_digest(Some(pinned.ml_dsa_public_key_hash.clone()), ml_dsa_digest.to_string())
    };
    // The pin agrees with the entry (then follows a succession no roster has folded in yet), or
    // with that succession's identity already.
    // A pin trusted through a group is that group's word, not the reader's own check.
    if agrees(&entry.encryption_public_key, &entry.signing_public_key, &entry.ml_dsa_public_key_digest) {
        return GroupWriterTrust::Roster {
            signer,
            via: pinned_via,
            followed: if lagging { served } else { None },
            links_loaded,
        };
    }
    if let Some(served) = served.as_ref().filter(|_| lagging) {
        if ml_dsa_digest(&served.ml_dsa_public_key)
            .is_some_and(|at| agrees(&served.encryption_public_key, &served.signing_public_key, &at))
        {
            return GroupWriterTrust::Roster { signer, via: pinned_via, followed: None, links_loaded };
        }
    }
    // Without what the pin needs checking against, nothing is known to disagree.
    let (Some(served), Some(_)) = (served, links) else {
        return GroupWriterTrust::Unchecked;
    };
    // A legitimate succession, not a conflict: the keys it replaced, from the pinned one on, only
    // ever vouch as retired.
    // (Keys only: the served version is unsigned here, so it never decides a conflict.)
    if (served_keys_are_entry(&served, entry) || lagging) && from_pin.is_some() {
        return GroupWriterTrust::Roster {
            signer,
            via: Some(chain.group_id.clone()),
            followed: Some(served),
            links_loaded,
        };
    }
    GroupWriterTrust::KeyConflict
}

/// A record's verdict inside a group's areas: the personal ones, a key
/// conflict (worse than Unverified), or a former member's (drawn as Unverified).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum GroupVerdict {
    Verified,
    SavedFromLink,
    Resealed,
    RetiredKey,
    UnknownSigner,
    BadSignature,
    Unsigned,
    Unchecked,
    KeyConflict,
    FormerMember,
}

impl From<Integrity> for GroupVerdict {
    fn from(integrity: Integrity) -> Self {
        match integrity {
            Integrity::Verified => GroupVerdict::Verified,
            Integrity::SavedFromLink => GroupVerdict::SavedFromLink,
            Integrity::Resealed => GroupVerdict::Resealed,
            Integrity::RetiredKey => GroupVerdict::RetiredKey,
            Integrity::UnknownSigner => GroupVerdict::UnknownSigner,
            Integrity::BadSignature => GroupVerdict::BadSignature,
            Integrity::Unsigned => GroupVerdict::Unsigned,
            Integrity::Unchecked => GroupVerdict::Unchecked,
        }
    }
}

/// What a reader shows for one record in a group's area, and the group it is
/// verified through when the roster vouched.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct GroupIntegrity {
    pub verdict: GroupVerdict,
    pub via: Option<String>,
}

fn group_integrity(
    trust: GroupWriterTrust,
    personal: Option<TrustedKeys>,
    signed: bool,
    check: impl Fn(Option<TrustedKeys>) -> Integrity,
) -> GroupIntegrity {
    // Without the writer's served identity and links, a key their chain retired may be missing.
    let unknown = |integrity: Integrity, links_loaded: bool| {
        if integrity == Integrity::BadSignature && !links_loaded {
            Integrity::Unchecked
        } else {
            integrity
        }
    };
    let (verdict, via) = match trust {
        GroupWriterTrust::Outside => (check(personal).into(), None),
        GroupWriterTrust::Unchecked => (GroupVerdict::Unchecked, None),
        GroupWriterTrust::KeyConflict => {
            (if signed { GroupVerdict::KeyConflict } else { GroupVerdict::Unsigned }, None)
        }
        GroupWriterTrust::FormerMember { signer, links_loaded } => {
            match unknown(check(Some(signer)), links_loaded) {
                Integrity::Verified
                | Integrity::SavedFromLink
                | Integrity::Resealed
                | Integrity::RetiredKey => (GroupVerdict::FormerMember, None),
                other => (other.into(), None),
            }
        }
        GroupWriterTrust::Roster { signer, via, links_loaded, .. } => {
            let integrity = unknown(check(Some(signer)), links_loaded);
            let vouched = matches!(integrity, Integrity::Verified | Integrity::SavedFromLink);
            (integrity.into(), via.filter(|_| vouched))
        }
    };
    GroupIntegrity { verdict, via }
}

/// What a reader shows for a node's metadata in light of `trust`
/// ([`group_writer_trust`]): outside the roster's reach the personal verdict
/// under `personal`; under a roster key the usual verdicts, `Verified`
/// carrying `via` when the roster vouched; a former member's valid signature
/// is `FormerMember`; a key conflict is worse than Unverified; and an
/// unchecked roster never reads as clean.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn group_metadata_integrity(
    trust: GroupWriterTrust,
    personal: Option<TrustedKeys>,
    statement: MetadataStatement,
    metadata_envelope: Vec<u8>,
    signature: Option<Vec<u8>>,
) -> GroupIntegrity {
    let signed = signature.is_some();
    group_integrity(trust, personal, signed, |trusted| {
        metadata_integrity(trusted, statement.clone(), metadata_envelope.clone(), signature.clone())
    })
}

/// What a reader shows for a version in a group's area; see [`group_metadata_integrity`].
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn group_version_integrity(
    trust: GroupWriterTrust,
    personal: Option<TrustedKeys>,
    statement: VersionStatement,
    content_key_envelope: Vec<u8>,
    signature: Option<Vec<u8>>,
) -> GroupIntegrity {
    let signed = signature.is_some();
    group_integrity(trust, personal, signed, |trusted| {
        version_integrity(trusted, statement.clone(), content_key_envelope.clone(), signature.clone())
    })
}

/// What a reader shows for a re-keyed record in a group's area: the origin's
/// verdict in light of the origin signer's `trust` (so a removed member's file
/// reads `FormerMember`, named after them, never as the re-keyer's), the
/// re-keyer's in light of theirs (Info only), and whether the binding failed.
/// On a mismatch `origin` is `BadSignature`, shown as the re-keyer's.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct GroupRekeyedVerdict {
    pub origin: GroupIntegrity,
    pub rekeyer: GroupIntegrity,
    pub mismatch: bool,
}

/// Whose keys a re-keyed record's two signatures are checked under in a
/// group's area: [`group_writer_trust`] for the origin's signer and for the
/// re-keyer, and the personal keys the reader trusts for each (used outside
/// the roster's reach).
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct GroupRekeyedTrust {
    pub origin: GroupWriterTrust,
    pub origin_personal: Option<TrustedKeys>,
    pub rekeyer: GroupWriterTrust,
    pub rekeyer_personal: Option<TrustedKeys>,
}

fn group_rekeyed(rekeyed: Option<Rekeyed>, trust: GroupRekeyedTrust) -> GroupRekeyedVerdict {
    let Some(rekeyed) = rekeyed else {
        let unchecked = GroupIntegrity { verdict: GroupVerdict::Unchecked, via: None };
        return GroupRekeyedVerdict { origin: unchecked.clone(), rekeyer: unchecked, mismatch: false };
    };
    let rekeyer = group_integrity(
        trust.rekeyer,
        trust.rekeyer_personal,
        rekeyed.rekey_signature.is_some(),
        |trusted| rekeyed.rekeyer(trusted.as_ref()),
    );
    // As breaks_binding: missing, or bad under keys the reader trusts (a roster's included).
    let broken = matches!(rekeyer.verdict, GroupVerdict::BadSignature | GroupVerdict::Unsigned);
    if !rekeyed.bound || broken {
        let bad = GroupIntegrity { verdict: GroupVerdict::BadSignature, via: None };
        return GroupRekeyedVerdict { origin: bad, rekeyer, mismatch: true };
    }
    let origin =
        group_integrity(trust.origin, trust.origin_personal, rekeyed.origin_signature.is_some(), |trusted| {
            rekeyed.origin(trusted.as_ref())
        });
    GroupRekeyedVerdict { origin, rekeyer, mismatch: false }
}

/// What a reader shows for re-keyed metadata in a group's area
/// ([`GroupRekeyedVerdict`]); `node_key` is the node's key at
/// `record.key_epoch`, `None` when the reader does not hold it (`Unchecked`).
/// A roster that did not load is `GroupWriterTrust::Unchecked` in `trust`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn group_metadata_rekeyed_integrity(
    node_key: Option<Vec<u8>>,
    trust: GroupRekeyedTrust,
    record: RekeyedMetadata,
) -> GroupRekeyedVerdict {
    group_rekeyed(node_key.map(|key| Rekeyed::of_metadata(&key, &record)), trust)
}

/// What a reader shows for a re-keyed version in a group's area; see
/// [`group_metadata_rekeyed_integrity`].
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn group_version_rekeyed_integrity(
    node_key: Option<Vec<u8>>,
    trust: GroupRekeyedTrust,
    record: RekeyedVersion,
) -> GroupRekeyedVerdict {
    group_rekeyed(node_key.map(|key| Rekeyed::of_version(&key, &record)), trust)
}

#[cfg(test)]
mod tests {
    //! Every device verifies the roster chain the server serves from version 1,
    //! warns only when the person's own marks disagree with each other or with
    //! that chain, ignores what else was served beside it, and lets the roster
    //! vouch for writers only inside the group's own areas: the web's
    //! group-trust.test.ts, case for case.
    use super::*;
    use crate::bytes::{encode, random};
    use crate::groups::tests::{
        accepted_of, group_seed_at, ml_dsa_keys, reader, History, Person, AREA, AREA_KEY, AREA_SEED, GROUP,
        OTHER_AREA, OTHER_GROUP,
    };
    use crate::groups::{
        group_key_open, group_key_seal, group_public_key, group_sign, roster_member_signer, roster_sign,
        succession_bytes, GroupKeySealContext, GroupSignature,
    };
    use crate::identity::IdentityKeys;
    use crate::signatures::{metadata_sign, sign_hybrid, NodeKind};

    struct Family {
        organizer: Person,
        adult: Person,
        holder: Person,
        child: Person,
        outsider: Person,
        h: History,
        keys: HashMap<String, String>,
    }

    fn owner(organizer: &Person) -> RosterMember {
        organizer.active(&[GroupRole::Billing, GroupRole::Guardian, GroupRole::Members])
    }

    /*
     * The organizer creates the family (1), admits a second holder (2), the holder leaves
     * (3), so the key is replaced (1 -> 2, tied to 3), and the organizer signs on (4).
     */
    fn family() -> Family {
        let (organizer, adult, holder, child, outsider) =
            (Person::new(1), Person::new(2), Person::new(3), Person::new(4), Person::new(5));
        let mut h = History::new();
        let o = owner(&organizer);
        let a = adult.active(&[]);
        let gone = holder.entry(&[GroupRole::Members], 3, MemberStatus::Left);
        h.roster(&organizer, vec![o.clone(), a.clone()], None);
        h.roster(
            &organizer,
            vec![o.clone(), a.clone(), holder.entry(&[GroupRole::Members], 2, MemberStatus::Active)],
            None,
        );
        h.roster(&organizer, vec![o.clone(), a.clone(), gone.clone()], None);
        h.succession(&organizer);
        h.roster(&organizer, vec![o, a, gone], None);
        let keys = ml_dsa_keys(&[&organizer, &adult, &holder, &child, &outsider]);
        Family { organizer, adult, holder, child, outsider, h, keys }
    }

    struct Over {
        checked: bool,
        pins: Vec<GroupPin>,
        rosters: Option<Vec<SignedGroupStatement>>,
        successions: Option<Vec<SignedGroupStatement>>,
        keys: Option<HashMap<String, String>>,
        me: Option<OwnIdentities>,
        cache: Option<GroupChainCache>,
        first: Option<GroupPublicKey>,
    }

    impl Default for Over {
        fn default() -> Self {
            Over {
                checked: true,
                pins: vec![],
                rosters: None,
                successions: None,
                keys: None,
                me: None,
                cache: None,
                first: None,
            }
        }
    }

    /* accept_rosters for `h`, from version 1 by a newcomer outside the group who just checked words. */
    fn accept(h: &History, keys: &HashMap<String, String>, over: Over) -> CoreResult<RosterChain> {
        accept_rosters(
            GROUP.into(),
            over.first.unwrap_or_else(|| h.key(1)),
            over.checked,
            over.pins,
            over.rosters.unwrap_or_else(|| h.rosters.clone()),
            over.successions.unwrap_or_else(|| h.successions.clone()),
            over.keys.unwrap_or_else(|| keys.clone()),
            over.me.unwrap_or_else(reader),
            over.cache,
        )
    }

    fn newcomer(f: &Family, over: Over) -> CoreResult<RosterChain> {
        accept(&f.h, &f.keys, over)
    }

    fn accepted(chain: CoreResult<RosterChain>) -> Arc<AcceptedRosters> {
        match chain {
            Ok(RosterChain::Accepted { chain }) => chain,
            other => panic!("expected an accepted chain, got {other:?}"),
        }
    }

    fn refused(chain: CoreResult<RosterChain>, message: &str) {
        match chain {
            Err(error) => assert!(error.to_string().contains(message), "{error} does not say {message}"),
            other => panic!("expected a refusal ({message}), got {other:?}"),
        }
    }

    fn side(digest: &str, from: &[MarkSource], signer: Option<&Person>) -> MarkSide {
        MarkSide {
            digest: digest.into(),
            from: from.to_vec(),
            signer_user_id: signer.map(|p| p.user_id.clone()),
        }
    }

    /* A fork of `of` at `version` whose sides are exactly these. */
    fn fork_of(chain: CoreResult<RosterChain>, of: ForkOf, version: u64, mut sides: Vec<MarkSide>) {
        sides.sort_by(|a, b| a.digest.cmp(&b.digest));
        assert_eq!(chain.unwrap(), RosterChain::Fork { of, version, sides });
    }

    /* The chain of `h` up to roster `version`, with the successions tied before it. */
    fn accepted_to(h: &History, version: u64, keys: &HashMap<String, String>) -> Arc<AcceptedRosters> {
        let successions = h
            .successions
            .iter()
            .filter(|s| parse_succession(&s.statement).unwrap().last_roster_version < version)
            .cloned()
            .collect();
        accepted(accept(
            h,
            keys,
            Over {
                rosters: Some(h.rosters[..version as usize].to_vec()),
                successions: Some(successions),
                ..Over::default()
            },
        ))
    }

    const CHECKED: &str = "2026-10-15T00:00:00.000Z";

    fn pin_of(h: &History, version: u64, keys: &HashMap<String, String>) -> GroupPin {
        pin_after(vec![], accepted_to(h, version, keys), CHECKED.into()).unwrap()
    }

    fn sorted(mut members: Vec<RosterMember>) -> Vec<RosterMember> {
        members.sort_by(|a, b| a.user_id.cmp(&b.user_id));
        members
    }

    /* A roster at `version` with `change` applied, signed properly by the group key and `signer`. */
    fn resigned(
        h: &History,
        version: u64,
        signer: &Person,
        change: impl Fn(&mut Roster),
    ) -> SignedGroupStatement {
        let mut roster = h.statements[(version - 1) as usize].clone();
        change(&mut roster);
        roster.members = sorted(roster.members);
        roster_sign(
            roster.clone(),
            h.seeds[(roster.group_key_version - 1) as usize].clone(),
            signer.keys.clone(),
        )
        .unwrap()
    }

    /* A statement signed by group key seed `seed` and by `by` (or an all-zero signer signature). */
    fn signed_by(statement: Vec<u8>, seed: &[u8], by: Option<&Person>) -> SignedGroupStatement {
        SignedGroupStatement {
            signature: group_sign(seed.to_vec(), statement.clone()).unwrap(),
            signer_signature: match by {
                Some(by) => sign_hybrid(&by.keys.signing_seed, &by.keys.ml_dsa_seed, &statement).unwrap(),
                None => vec![0; 3373],
            },
            statement,
        }
    }

    fn roster_bytes_of(roster: Roster) -> Vec<u8> {
        crate::groups::roster_statement(roster).unwrap()
    }

    /* The family's succession with `change` applied, signed by key 1 and `signer` as given. */
    fn rewritten(
        f: &Family,
        signer: Option<&Person>,
        change: impl Fn(&mut GroupKeySuccession),
    ) -> SignedGroupStatement {
        let mut succession = parse_succession(&f.h.successions[0].statement).unwrap();
        change(&mut succession);
        signed_by(succession_bytes(&succession).unwrap(), &f.h.seeds[0], signer)
    }

    fn junk() -> String {
        encode(&[7u8; 32])
    }

    fn other_key() -> GroupPublicKey {
        group_public_key(random(64)).unwrap()
    }

    /* Accepting the chain the server serves */

    #[test]
    fn a_newcomer_accepts_the_chain_from_version_1_once_the_words_are_checked() {
        let f = family();
        let chain = accepted(newcomer(&f, Over::default()));
        assert_eq!(chain.roster.roster_version, 4);
        assert_eq!(chain.group_key_version, 2);
        assert_eq!(chain.group_key, f.h.key(2));
        assert_eq!(chain.creator_user_id, f.organizer.user_id);
        assert!(!chain.succession_due);
        assert!(chain.dead_branches.is_empty());
        assert_eq!(
            chain.roster_digests,
            f.h.rosters.iter().map(|r| digest(&r.statement)).collect::<Vec<_>>()
        );
        refused(newcomer(&f, Over { checked: false, ..Over::default() }), "have not been checked");
    }

    #[test]
    fn rosters_served_beside_the_chain_are_dead_branches_never_a_warning() {
        let f = family();
        let back = resigned(&f.h, 2, &f.holder, |r| {
            r.signer_user_id = f.holder.user_id.clone();
            r.members = vec![
                owner(&f.organizer),
                f.adult.active(&[]),
                f.holder.entry(&[GroupRole::Members], 2, MemberStatus::Active),
                f.outsider.entry(&[], 2, MemberStatus::Active),
            ];
        });
        let orphan = resigned(&f.h, 3, &f.organizer, |r| {
            r.members = vec![
                owner(&f.organizer),
                f.adult.entry(&[GroupRole::Billing], 3, MemberStatus::Active),
                f.holder.entry(&[GroupRole::Members], 3, MemberStatus::Left),
            ];
        });
        let pin4 = pin_of(&f.h, 4, &f.keys);
        let full = accepted(newcomer(&f, Over::default()));
        let mut rosters = f.h.rosters.clone();
        rosters.extend([back, orphan]);
        for (pins, cache) in
            [(vec![], None), (vec![pin4.clone()], None), (vec![pin4], Some(full.cache.clone()))]
        {
            let chain = accepted(newcomer(
                &f,
                Over { pins, cache, rosters: Some(rosters.clone()), ..Over::default() },
            ));
            assert_eq!(chain.roster_digest, full.roster_digest);
            assert_eq!(
                chain.dead_branches,
                vec![
                    DeadBranch { version: 2, signer_user_id: f.holder.user_id.clone() },
                    DeadBranch { version: 3, signer_user_id: f.organizer.user_id.clone() },
                ]
            );
        }
    }

    #[test]
    fn the_chain_is_the_latest_roster_linked_back_to_version_1() {
        let f = family();
        let other4 = resigned(&f.h, 4, &f.organizer, |r| {
            r.members = vec![
                owner(&f.organizer),
                f.adult.entry(&[GroupRole::Billing], 4, MemberStatus::Active),
                f.holder.entry(&[GroupRole::Members], 3, MemberStatus::Left),
            ];
        });
        let mut behind = f.h.rosters.clone();
        behind.push(other4.clone());
        let mut ahead = vec![other4];
        ahead.extend(f.h.rosters.clone());
        for rosters in [behind, ahead] {
            refused(
                newcomer(&f, Over { rosters: Some(rosters), ..Over::default() }),
                "more than one latest member list",
            );
        }
        let elsewhere = resigned(&f.h, 4, &f.organizer, |r| r.previous_roster_digest = junk());
        let mut rosters = f.h.rosters[..3].to_vec();
        rosters.push(elsewhere);
        refused(
            newcomer(&f, Over { rosters: Some(rosters), ..Over::default() }),
            "does not follow the last one",
        );
        let mut skipped = f.h.rosters.clone();
        skipped.remove(1);
        refused(
            newcomer(&f, Over { rosters: Some(skipped), ..Over::default() }),
            "does not follow the last one",
        );
        refused(
            newcomer(&f, Over { rosters: Some(f.h.rosters[1..].to_vec()), ..Over::default() }),
            "does not follow the last one",
        );
        // A holder's second roster 3 chained to the real 3, and a 4 on it: four links, but not 1 to 4.
        let again3 =
            resigned(&f.h, 3, &f.organizer, |r| r.previous_roster_digest = digest(&f.h.rosters[2].statement));
        let on = resigned(&f.h, 4, &f.organizer, |r| r.previous_roster_digest = digest(&again3.statement));
        let mut rosters = f.h.rosters[..3].to_vec();
        rosters.extend([again3, on]);
        refused(
            newcomer(&f, Over { rosters: Some(rosters), ..Over::default() }),
            "does not follow the last one",
        );
        // A roster a holder signed for another group, chained into this one.
        let foreign = resigned(&f.h, 2, &f.organizer, |r| r.group_id = OTHER_GROUP.into());
        let after =
            resigned(&f.h, 3, &f.organizer, |r| r.previous_roster_digest = digest(&foreign.statement));
        refused(
            newcomer(
                &f,
                Over { rosters: Some(vec![f.h.rosters[0].clone(), foreign, after]), ..Over::default() },
            ),
            "for another group",
        );
        // p4: an unsigned chain naming anyone as its signer, against a pin: refused, no warning.
        let mut fabricated = vec![];
        let mut previous = String::new();
        for version in 1..=4u64 {
            let statement = roster_bytes_of(Roster {
                roster_version: version,
                previous_roster_digest: previous.clone(),
                signer_user_id: f.child.user_id.clone(),
                members: vec![f.child.active(&[GroupRole::Members])],
                ..f.h.statements[0].clone()
            });
            previous = digest(&statement);
            fabricated.push(SignedGroupStatement {
                statement,
                signature: GroupSignature { ed25519: vec![0; 64], ml_dsa: vec![0; 3309] },
                signer_signature: vec![0; 3373],
            });
        }
        refused(
            newcomer(
                &f,
                Over {
                    pins: vec![pin_of(&f.h, 2, &f.keys)],
                    checked: false,
                    rosters: Some(fabricated),
                    ..Over::default()
                },
            ),
            "not signed by the group key",
        );
    }

    #[test]
    fn a_roster_or_succession_on_the_chain_with_one_valid_half_is_refused() {
        let f = family();
        for half in 0..2 {
            let mut rosters = f.h.rosters.clone();
            if half == 0 {
                rosters[1].signature.ml_dsa[99] ^= 1;
            } else {
                rosters[1].signature.ed25519[3] ^= 1;
            }
            refused(
                newcomer(&f, Over { rosters: Some(rosters), ..Over::default() }),
                "not signed by the group key",
            );
            let mut succession = f.h.successions[0].clone();
            if half == 0 {
                succession.signature.ml_dsa[99] ^= 1;
            } else {
                succession.signature.ed25519[3] ^= 1;
            }
            refused(
                newcomer(&f, Over { successions: Some(vec![succession]), ..Over::default() }),
                "not signed by the key it replaces",
            );
        }
        let forged = roster_sign(f.h.statements[1].clone(), random(64), f.organizer.keys.clone()).unwrap();
        let mut rosters = f.h.rosters.clone();
        rosters[1] = forged;
        refused(
            newcomer(&f, Over { rosters: Some(rosters), ..Over::default() }),
            "not signed by the group key",
        );
    }

    #[test]
    fn one_statement_served_with_other_signatures_either_copy_that_verifies_will_do() {
        let f = family();
        let full = accepted(newcomer(&f, Over::default()));
        let again =
            roster_sign(f.h.statements[1].clone(), f.h.seeds[0].clone(), f.organizer.keys.clone()).unwrap();
        let mut rosters = f.h.rosters.clone();
        rosters.push(again.clone());
        assert_eq!(
            accepted(newcomer(&f, Over { rosters: Some(rosters), ..Over::default() })).roster_digest,
            full.roster_digest
        );
        let mut broken = again;
        broken.signature.ml_dsa[9] ^= 1;
        let mut rosters = f.h.rosters.clone();
        rosters.push(broken.clone());
        accepted(newcomer(&f, Over { rosters: Some(rosters), ..Over::default() }));
        let mut rosters = vec![broken.clone()];
        rosters.extend(f.h.rosters.clone());
        accepted(newcomer(&f, Over { rosters: Some(rosters), ..Over::default() }));
        let mut rosters = f.h.rosters.clone();
        rosters[1] = broken;
        refused(
            newcomer(&f, Over { rosters: Some(rosters), ..Over::default() }),
            "not signed by the group key",
        );
        let mut successions = f.h.successions.clone();
        successions.push(signed_by(f.h.successions[0].statement.clone(), &f.h.seeds[0], Some(&f.organizer)));
        assert_eq!(
            accepted(newcomer(&f, Over { successions: Some(successions), ..Over::default() }))
                .group_key_version,
            2
        );
    }

    #[test]
    fn a_signer_who_held_no_members_role_on_the_roster_before_is_refused() {
        let f = family();
        let promoted = resigned(&f.h, 2, &f.adult, |r| {
            r.signer_user_id = f.adult.user_id.clone();
            r.members = vec![
                owner(&f.organizer),
                f.adult.entry(&[GroupRole::Members], 2, MemberStatus::Active),
                f.holder.entry(&[GroupRole::Members], 2, MemberStatus::Active),
            ];
        });
        refused(
            newcomer(&f, Over { rosters: Some(vec![f.h.rosters[0].clone(), promoted]), ..Over::default() }),
            "not signed by a member who holds the group key",
        );
        let ghost = resigned(&f.h, 4, &f.holder, |r| r.signer_user_id = f.holder.user_id.clone());
        let mut rosters = f.h.rosters[..3].to_vec();
        rosters.push(ghost);
        refused(
            newcomer(&f, Over { rosters: Some(rosters), ..Over::default() }),
            "not signed by a member who holds the group key",
        );
    }

    #[test]
    fn a_missing_or_wrong_signer_identity_signature_or_an_unnamed_ml_dsa_key_is_refused() {
        let f = family();
        let by_outsider =
            roster_sign(f.h.statements[1].clone(), f.h.seeds[0].clone(), f.outsider.keys.clone()).unwrap();
        for signer_signature in
            [vec![], f.h.rosters[1].signer_signature[..64].to_vec(), by_outsider.signer_signature.clone()]
        {
            let mut rosters = f.h.rosters.clone();
            rosters[1].signer_signature = signer_signature;
            refused(
                newcomer(&f, Over { rosters: Some(rosters), ..Over::default() }),
                "not signed by the member it names",
            );
        }
        refused(
            newcomer(&f, Over { keys: Some(ml_dsa_keys(&[&f.adult])), ..Over::default() }),
            "not signed by the member it names",
        );
        let forge = |signed: &SignedGroupStatement| SignedGroupStatement {
            signer_signature: sign_hybrid(
                &f.organizer.keys.signing_seed,
                &f.outsider.keys.ml_dsa_seed,
                &signed.statement,
            )
            .unwrap(),
            ..signed.clone()
        };
        let mut forged_keys = f.keys.clone();
        forged_keys.insert(digest(&f.organizer.ml_dsa()), f.outsider.keys.ml_dsa_public_key.clone().unwrap());
        refused(
            newcomer(
                &f,
                Over {
                    rosters: Some(f.h.rosters.iter().map(forge).collect()),
                    successions: Some(f.h.successions.iter().map(forge).collect()),
                    keys: Some(forged_keys),
                    ..Over::default()
                },
            ),
            "not signed by the member it names",
        );
    }

    /* The person's marks */

    #[test]
    fn a_pin_is_a_mark_the_chain_must_reach_and_pass_through() {
        let f = family();
        let pin2 = pin_of(&f.h, 2, &f.keys);
        let pin4 = pin_of(&f.h, 4, &f.keys);
        assert_eq!(
            accepted(newcomer(&f, Over { pins: vec![pin2.clone(), pin4.clone()], ..Over::default() }))
                .roster
                .roster_version,
            4
        );
        // Other first keys served, each half, against the pin's: refused before anything else is
        // looked at, whatever the server signed under them (r6 p1: a server-made group key and a
        // roster 1 naming a made-up creator are a refusal, never the warning).
        let real = f.h.key(1);
        let seed7 = group_seed_at(7);
        let key7 = group_public_key(seed7.clone()).unwrap();
        let elsewhere_keyed: Vec<SignedGroupStatement> = f.h.statements[..2]
            .iter()
            .map(|roster| roster_sign(roster.clone(), seed7.clone(), f.organizer.keys.clone()).unwrap())
            .collect();
        for first in [
            GroupPublicKey { ed25519_public_key: key7.ed25519_public_key.clone(), ..real.clone() },
            GroupPublicKey { ml_dsa_public_key: key7.ml_dsa_public_key.clone(), ..real.clone() },
            key7.clone(),
        ] {
            for rosters in [f.h.rosters.clone(), elsewhere_keyed.clone()] {
                refused(
                    newcomer(
                        &f,
                        Over {
                            pins: vec![pin2.clone()],
                            first: Some(first.clone()),
                            rosters: Some(rosters),
                            successions: Some(vec![]),
                            ..Over::default()
                        },
                    ),
                    "not the group keys this person checked",
                );
            }
        }
        // Two of the person's own pins naming other version 1 keys: the warning, marks only.
        let first_mark = |key: &GroupPublicKey| {
            let ml_dsa = decode("k", &key.ml_dsa_public_key, None).unwrap();
            digest(&[decode("k", &key.ed25519_public_key, None).unwrap(), sha256(&ml_dsa)].concat())
        };
        let other_first = GroupPin {
            first_ed25519_public_key: key7.ed25519_public_key.clone(),
            first_ml_dsa_public_key_digest: digest(&decode("k", &key7.ml_dsa_public_key, None).unwrap()),
            ..pin2.clone()
        };
        fork_of(
            newcomer(&f, Over { pins: vec![pin2.clone(), other_first], ..Over::default() }),
            ForkOf::GroupKey,
            1,
            vec![
                side(&first_mark(&real), &[MarkSource::Pin], None),
                side(&first_mark(&key7), &[MarkSource::Pin], None),
            ],
        );
        refused(
            newcomer(
                &f,
                Over {
                    pins: vec![pin4.clone()],
                    rosters: Some(f.h.rosters[..3].to_vec()),
                    ..Over::default()
                },
            ),
            "older member list",
        );
        let other_roster = resigned(&f.h, 2, &f.organizer, |r| {
            r.members =
                vec![owner(&f.organizer), f.adult.active(&[]), f.outsider.entry(&[], 2, MemberStatus::Active)]
        });
        let other_digest = digest(&other_roster.statement);
        let elsewhere = GroupPin { roster_digest: other_digest.clone(), ..pin2.clone() };
        fork_of(
            newcomer(&f, Over { pins: vec![elsewhere.clone()], ..Over::default() }),
            ForkOf::Roster,
            2,
            vec![
                side(&other_digest, &[MarkSource::Pin], None),
                side(&pin2.roster_digest, &[MarkSource::Served], Some(&f.organizer)),
            ],
        );
        // Two of the person's own pins at one version: the warning, decided before anything served
        // is looked at, so neither side names a signer; and even when what is served is junk.
        let mut rosters = f.h.rosters.clone();
        rosters.push(other_roster);
        let junk_head = SignedGroupStatement {
            signature: GroupSignature { ed25519: vec![0; 64], ml_dsa: vec![0; 3309] },
            signer_signature: vec![0; 3373],
            ..resigned(&f.h, 4, &f.organizer, |r| r.previous_roster_digest = junk())
        };
        for pins in [vec![pin2.clone(), elsewhere.clone()], vec![elsewhere.clone(), pin2.clone()]] {
            for served in [rosters.clone(), vec![junk_head.clone()], vec![]] {
                fork_of(
                    newcomer(&f, Over { pins: pins.clone(), rosters: Some(served), ..Over::default() }),
                    ForkOf::Roster,
                    2,
                    vec![
                        side(&other_digest, &[MarkSource::Pin], None),
                        side(&pin2.roster_digest, &[MarkSource::Pin], None),
                    ],
                );
            }
        }
        refused(
            newcomer(&f, Over { pins: vec![GroupPin { key_version: 0, ..pin4 }], ..Over::default() }),
            "Invalid group key version.",
        );
    }

    #[test]
    fn two_pins_disagreeing_on_a_group_key_choose_no_succession_the_warning_names_just_the_two_pins() {
        let f = family();
        let pin4 = pin_of(&f.h, 4, &f.keys);
        for seed in [7u64, 8, 9] {
            let rival = group_key_digest_of(&group_public_key(group_seed_at(seed)).unwrap()).unwrap();
            fork_of(
                newcomer(
                    &f,
                    Over {
                        pins: vec![
                            pin4.clone(),
                            GroupPin { group_key_digest: rival.clone(), ..pin4.clone() },
                        ],
                        ..Over::default()
                    },
                ),
                ForkOf::GroupKey,
                2,
                vec![
                    side(&rival, &[MarkSource::Pin], None),
                    side(&pin4.group_key_digest, &[MarkSource::Pin], None),
                ],
            );
        }
    }

    #[test]
    fn group_key_marks_another_key_or_two_pins_disagreeing_f6_are_the_warning() {
        let f = family();
        let pin4 = pin_of(&f.h, 4, &f.keys);
        let rival_digest = group_key_digest_of(&other_key()).unwrap();
        let wrong = GroupPin { group_key_digest: rival_digest.clone(), ..pin4.clone() };
        fork_of(
            newcomer(&f, Over { pins: vec![wrong.clone()], ..Over::default() }),
            ForkOf::GroupKey,
            2,
            vec![
                side(&rival_digest, &[MarkSource::Pin], None),
                side(&pin4.group_key_digest, &[MarkSource::Served], Some(&f.organizer)),
            ],
        );
        fork_of(
            newcomer(&f, Over { pins: vec![pin4.clone(), wrong], ..Over::default() }),
            ForkOf::GroupKey,
            2,
            vec![
                side(&rival_digest, &[MarkSource::Pin], None),
                side(&pin4.group_key_digest, &[MarkSource::Pin], None),
            ],
        );
        refused(
            newcomer(&f, Over { pins: vec![GroupPin { key_version: 3, ..pin4 }], ..Over::default() }),
            "older member list",
        );
    }

    #[test]
    fn the_pin_written_after_acceptance_is_the_chain_s_with_every_pin_s_area_marks() {
        let f = family();
        let chain = accepted(newcomer(&f, Over::default()));
        let settings = GroupPin {
            areas: HashMap::from([(AREA.to_string(), 3)]),
            checked_at: "2026-10-16T00:00:00.000Z".into(),
            ..pin_of(&f.h, 2, &f.keys)
        };
        let device = GroupPin {
            areas: HashMap::from([(AREA.to_string(), 1), (OTHER_AREA.to_string(), 2)]),
            ..pin_of(&f.h, 3, &f.keys)
        };
        let pin = pin_after(vec![settings.clone(), device], chain.clone(), "2026-10-17T00:00:00.000Z".into())
            .unwrap();
        assert_eq!((pin.roster_version, pin.key_version), (4, 2));
        assert_eq!(pin.roster_digest, chain.roster_digest);
        assert_eq!(pin.group_key_digest, chain.group_key_digest);
        assert_eq!(pin.areas, HashMap::from([(AREA.to_string(), 3), (OTHER_AREA.to_string(), 2)]));
        assert_eq!(pin.checked_at, CHECKED);
        let now = "2026-10-17T09:30:00.000Z";
        assert_eq!(pin_after(vec![], chain.clone(), now.into()).unwrap().checked_at, now);
        let off = GroupPin { roster_digest: encode(&[4u8; 32]), ..settings.clone() };
        assert!(pin_after(vec![off], chain.clone(), now.into())
            .unwrap_err()
            .to_string()
            .contains("not on the accepted member list"));
        // r8 (Codex 4): a check time outside the canonical ISO form is refused, given or held.
        for bad in ["now", "2026-10-17 09:30:00", "2026-13-01T00:00:00.000Z", "\u{10000}"] {
            assert!(pin_after(vec![], chain.clone(), bad.into())
                .unwrap_err()
                .to_string()
                .contains("Invalid group pin"));
        }
        let odd = GroupPin { checked_at: "\u{E000}".into(), ..settings };
        assert!(pin_after(vec![odd], chain, now.into())
            .unwrap_err()
            .to_string()
            .contains("Invalid group pin"));
        // r8 (Codex 2): a version's index is checked, never truncated onto another version.
        assert_eq!(version_index(0), usize::MAX);
        assert_eq!(version_index(1), 0);
        assert_eq!(version_index(u64::MAX), usize::try_from(u64::MAX - 1).unwrap_or(usize::MAX));
    }

    #[test]
    fn a_pin_outside_the_canonical_encoding_is_no_pin() {
        let f = family();
        let pin = pin_of(&f.h, 4, &f.keys);
        assert_eq!(group_pin_check(GROUP.into(), pin.clone()).unwrap(), pin);
        let hex = crate::contacts::digest_hex(pin.roster_digest.clone()).unwrap();
        let broken = vec![
            GroupPin { first_ml_dsa_public_key_digest: hex.clone(), ..pin.clone() },
            GroupPin { group_key_digest: hex.clone(), ..pin.clone() },
            GroupPin { roster_digest: String::new(), ..pin.clone() },
            GroupPin { roster_digest: hex, ..pin.clone() },
            GroupPin { key_version: 0, ..pin.clone() },
            GroupPin { roster_version: 1 << 53, ..pin.clone() },
            GroupPin { checked_at: String::new(), ..pin.clone() },
            GroupPin { areas: HashMap::from([(AREA.to_uppercase(), 1)]), ..pin.clone() },
            GroupPin { areas: HashMap::from([(AREA.to_string(), 0)]), ..pin.clone() },
            GroupPin {
                first_ed25519_public_key: format!("{}=", pin.first_ed25519_public_key),
                ..pin.clone()
            },
        ];
        for value in broken {
            assert!(group_pin_check(GROUP.into(), value).is_err());
        }
        assert!(group_pin_check(GROUP.to_uppercase(), pin).is_err());
    }

    /* The entry rules */

    #[test]
    fn an_entry_never_disappears_and_a_changed_entry_carries_the_version_it_changed_at() {
        let f = family();
        let dropped = resigned(&f.h, 2, &f.organizer, |r| {
            r.members =
                vec![owner(&f.organizer), f.holder.entry(&[GroupRole::Members], 2, MemberStatus::Active)]
        });
        refused(
            newcomer(&f, Over { rosters: Some(vec![f.h.rosters[0].clone(), dropped]), ..Over::default() }),
            "does not follow from the one before",
        );
        let stale = resigned(&f.h, 2, &f.organizer, |r| {
            r.members = vec![
                owner(&f.organizer),
                f.adult.entry(&[GroupRole::Members], 1, MemberStatus::Active),
                f.holder.entry(&[GroupRole::Members], 2, MemberStatus::Active),
            ]
        });
        refused(
            newcomer(&f, Over { rosters: Some(vec![f.h.rosters[0].clone(), stale]), ..Over::default() }),
            "does not follow from the one before",
        );
    }

    fn verified_pin(who: &Person) -> VerifiedPin {
        let served = who.served();
        VerifiedPin {
            user_id: who.user_id.clone(),
            key_version: served.key_version,
            encryption_public_key: served.encryption_public_key.clone(),
            signing_public_key: served.signing_public_key.clone(),
            ml_dsa_public_key_hash: key_digest(who.ml_dsa()),
            kem_public_key_hash: key_digest(who.kem()),
            fingerprint: identity_fingerprint(
                decode("x", &served.encryption_public_key, Some(32)).unwrap(),
                decode("e", &served.signing_public_key, Some(32)).unwrap(),
                sha256(&who.ml_dsa()),
                sha256(&who.kem()),
            )
            .unwrap(),
            trusted_via: None,
        }
    }

    fn sha256(bytes: &[u8]) -> Vec<u8> {
        use sha2::Digest as _;
        sha2::Sha256::digest(bytes).to_vec()
    }

    #[test]
    fn key_versions_are_a_holder_s_claim_probes_1_1b_1c_f2_go_through_and_the_member_stays_followable() {
        let (organizer, adult, holder, outsider) =
            (Person::new(1), Person::new(2), Person::new(3), Person::new(5));
        let (adult2, link) = adult.succeed();
        let (adult3, _) = Person::at(2, 2).succeed();
        let keys = ml_dsa_keys(&[&organizer]);
        let chain_of = |lists: Vec<Vec<RosterMember>>| {
            let mut h = History::new();
            for members in lists {
                let mut all = vec![owner(&organizer)];
                all.extend(members);
                h.roster(&organizer, all, None);
            }
            accepted(accept(&h, &keys, Over::default()))
        };
        assert_eq!(
            chain_of(vec![vec![adult.active(&[])], vec![adult3.active(&[])]]).roster.roster_version,
            2
        );
        let wrong = RosterMember { user_id: adult.user_id.clone(), key_version: 2, ..outsider.active(&[]) };
        assert_eq!(
            chain_of(vec![vec![adult.active(&[])], vec![wrong.clone()], vec![adult.active(&[])]])
                .roster
                .roster_version,
            3
        );
        assert_eq!(
            chain_of(vec![vec![adult.active(&[])], vec![wrong], vec![adult2.active(&[])]])
                .roster
                .roster_version,
            3
        );
        let inflated = chain_of(vec![
            vec![adult.active(&[])],
            vec![RosterMember { key_version: 1000, ..adult.active(&[]) }],
        ]);
        let entry = inflated.roster.entry(&adult.user_id).unwrap().clone();
        assert!(roster_entry_fold_in(entry, adult2.served(), vec![link.clone()], 3).unwrap().changed);
        assert_eq!(
            verdict_by(
                &inflated,
                &adult,
                &adult2.keys.signing_seed,
                AREA,
                None,
                Some(adult2.served_keys()),
                Some(vec![link])
            ),
            is(GroupVerdict::Verified, Some(GROUP))
        );
        let mut h = History::new();
        h.roster(
            &organizer,
            vec![
                owner(&organizer),
                RosterMember { key_version: 1000, ..adult.active(&[]) },
                holder.active(&[GroupRole::Members]),
            ],
            None,
        );
        let chain = accepted_of(&h, &[&organizer]);
        let entry = roster_entry_new(verified_pin(&adult2), adult2.served(), vec![], 2).unwrap();
        let roster = roster_next(
            chain,
            vec![owner(&organizer), entry, holder.active(&[GroupRole::Members])],
            organizer.user_id.clone(),
            None,
        )
        .unwrap();
        h.rosters.push(roster_sign(roster, h.seeds[0].clone(), organizer.keys.clone()).unwrap());
        assert_eq!(
            accepted(accept(&h, &keys, Over::default())).roster.entry(&adult.user_id).unwrap().key_version,
            2
        );
    }

    /* The next roster and succession */

    #[test]
    fn a_roster_roster_next_builds_is_always_one_accept_rosters_takes() {
        let mut f = family();
        let mut chain = accepted(newcomer(&f, Over::default()));
        let (adult2, link) = f.adult.succeed();
        let gone = f.holder.entry(&[GroupRole::Members], 3, MemberStatus::Left);
        type Step<'a> = Box<dyn Fn(&AcceptedRosters) -> Vec<RosterMember> + 'a>;
        let steps: Vec<Step> = vec![
            Box::new(|_| vec![owner(&f.organizer), f.adult.active(&[]), gone.clone(), f.child.active(&[])]),
            Box::new(|c| {
                let folded = roster_entry_fold_in(
                    c.roster.entry(&f.adult.user_id).unwrap().clone(),
                    adult2.served(),
                    vec![link.clone()],
                    6,
                )
                .unwrap();
                vec![owner(&f.organizer), folded.entry, gone.clone(), f.child.active(&[GroupRole::Members])]
            }),
            Box::new(|c| {
                c.roster
                    .members
                    .iter()
                    .map(|m| {
                        if m.user_id == f.child.user_id {
                            RosterMember { roles: vec![], ..m.clone() }
                        } else {
                            m.clone()
                        }
                    })
                    .collect()
            }),
        ];
        let mut rosters = f.h.rosters.clone();
        for step in &steps {
            let roster = roster_next(chain.clone(), step(&chain), f.organizer.user_id.clone(), None).unwrap();
            let signed = roster_sign(
                roster.clone(),
                f.h.seeds[(chain.group_key_version - 1) as usize].clone(),
                f.organizer.keys.clone(),
            )
            .unwrap();
            roster_check_next(chain.clone(), signed.clone(), f.keys.clone(), None).unwrap();
            rosters.push(signed);
            chain = accepted(newcomer(&f, Over { rosters: Some(rosters.clone()), ..Over::default() }));
            assert_eq!(chain.roster, roster);
        }
        drop(steps);
        assert!(chain.succession_due);
        assert!(roster_next(chain.clone(), chain.roster.members.clone(), f.organizer.user_id.clone(), None)
            .unwrap_err()
            .to_string()
            .contains("must be replaced first"));
        f.h.rosters = rosters;
        let organizer = f.organizer.clone();
        f.h.succession(&organizer);
        group_succession_check_next(chain.clone(), f.h.successions.last().unwrap().clone(), f.keys.clone())
            .unwrap();
        let chain = accepted(newcomer(&f, Over::default()));
        let roster =
            roster_next(chain.clone(), chain.roster.members.clone(), f.organizer.user_id.clone(), None)
                .unwrap();
        assert_eq!(roster.group_key_version, 3);
        f.h.rosters.push(roster_sign(roster, f.h.seeds[2].clone(), f.organizer.keys.clone()).unwrap());
        assert_eq!(accepted(newcomer(&f, Over::default())).roster.roster_version, 8);
    }

    #[test]
    fn roster_next_refuses_what_no_device_would_accept() {
        let f = family();
        let chain = accepted(newcomer(&f, Over::default()));
        assert!(roster_next(
            chain.clone(),
            vec![owner(&f.organizer), f.adult.active(&[])],
            f.organizer.user_id.clone(),
            None
        )
        .unwrap_err()
        .to_string()
        .contains("does not follow from the one before"));
        assert!(roster_next(chain.clone(), chain.roster.members.clone(), f.adult.user_id.clone(), None)
            .unwrap_err()
            .to_string()
            .contains("not signed by a member who holds the group key"));
    }

    #[test]
    fn roster_check_next_is_acceptance_itself_and_with_identities_refuses_keys_a_member_never_had() {
        let f = family();
        let chain = accepted(newcomer(&f, Over::default()));
        let mut base = chain.roster.clone();
        base.roster_version = 5;
        base.previous_roster_digest = chain.roster_digest.clone();
        base.members = base
            .members
            .iter()
            .map(|m| {
                if m.user_id == f.adult.user_id {
                    RosterMember { roles: vec![GroupRole::Billing], since_version: 5, ..m.clone() }
                } else {
                    m.clone()
                }
            })
            .collect();
        let sign =
            |roster: Roster, seed: Vec<u8>, by: &Person| roster_sign(roster, seed, by.keys.clone()).unwrap();
        let k2 = f.h.seeds[1].clone();
        let with = |change: &dyn Fn(&mut Roster)| {
            let mut roster = base.clone();
            change(&mut roster);
            roster
        };
        let candidates: Vec<(&str, SignedGroupStatement)> = vec![
            ("honest", sign(base.clone(), k2.clone(), &f.organizer)),
            (
                "skips a version",
                sign(
                    with(&|r| {
                        r.roster_version = 6;
                        for m in r.members.iter_mut().filter(|m| m.since_version == 5) {
                            m.since_version = 6;
                        }
                    }),
                    k2.clone(),
                    &f.organizer,
                ),
            ),
            (
                "another parent",
                sign(with(&|r| r.previous_roster_digest = encode(&[1u8; 32])), k2.clone(), &f.organizer),
            ),
            (
                "under the replaced key",
                sign(with(&|r| r.group_key_version = 1), f.h.seeds[0].clone(), &f.organizer),
            ),
            (
                "names the replaced key, signed by the current one",
                sign(with(&|r| r.group_key_version = 1), k2.clone(), &f.organizer),
            ),
            ("names an unpublished key", sign(with(&|r| r.group_key_version = 3), k2.clone(), &f.organizer)),
            ("another kind", sign(with(&|r| r.kind = GroupKind::Org), k2.clone(), &f.organizer)),
            (
                "by a former holder",
                sign(with(&|r| r.signer_user_id = f.holder.user_id.clone()), k2.clone(), &f.holder),
            ),
            ("by an unsigned signer", signed_by(roster_bytes_of(base.clone()), &k2, None)),
            ("by another key", sign(base.clone(), random(64), &f.organizer)),
            (
                "drops an entry",
                sign(
                    with(&|r| {
                        r.members.remove(0);
                    }),
                    k2.clone(),
                    &f.organizer,
                ),
            ),
        ];
        for (what, signed) in &candidates {
            let by_check = roster_check_next(chain.clone(), signed.clone(), f.keys.clone(), None).is_ok();
            let mut rosters = f.h.rosters.clone();
            rosters.push(signed.clone());
            let by_chain = matches!(
                newcomer(&f, Over { rosters: Some(rosters), ..Over::default() }),
                Ok(RosterChain::Accepted { .. })
            );
            assert_eq!(by_check, by_chain, "{what}");
            assert_eq!(by_check, *what == "honest", "{what}");
        }
        let identities: HashMap<String, Vec<PublicIdentity>> =
            [&f.organizer, &f.adult, &f.holder, &f.child, &f.outsider]
                .iter()
                .map(|p| (p.user_id.clone(), vec![p.served()]))
                .collect();
        let planted = sign(
            with(&|r| {
                for m in r.members.iter_mut().filter(|m| m.user_id == f.adult.user_id) {
                    *m = RosterMember {
                        user_id: f.adult.user_id.clone(),
                        ..f.outsider.entry(&[GroupRole::Billing], 5, MemberStatus::Active)
                    };
                }
            }),
            k2.clone(),
            &f.organizer,
        );
        roster_check_next(chain.clone(), planted.clone(), f.keys.clone(), None).unwrap();
        assert!(roster_check_next(chain.clone(), planted.clone(), f.keys.clone(), Some(identities.clone()))
            .unwrap_err()
            .to_string()
            .contains("never had"));
        // The outsider's own identity listed under the adult's id: its keys statement names the outsider.
        let mut posing = identities.clone();
        posing.insert(f.adult.user_id.clone(), vec![f.outsider.served()]);
        assert!(roster_check_next(chain.clone(), planted, f.keys.clone(), Some(posing))
            .unwrap_err()
            .to_string()
            .contains("never had"));
        let inflated = sign(
            with(&|r| {
                for m in r.members.iter_mut().filter(|m| m.user_id == f.adult.user_id) {
                    m.key_version = 1000;
                }
            }),
            k2.clone(),
            &f.organizer,
        );
        assert!(roster_check_next(chain.clone(), inflated, f.keys.clone(), Some(identities.clone()))
            .unwrap_err()
            .to_string()
            .contains("never had"));
        roster_check_next(chain.clone(), candidates[0].1.clone(), f.keys.clone(), Some(identities)).unwrap();
        // Entries whose keys did not change need no identity: only the changed ones are looked up.
        roster_check_next(chain, candidates[0].1.clone(), f.keys.clone(), Some(HashMap::new())).unwrap();
    }

    #[test]
    fn f4_group_succession_check_next_refuses_a_succession_tied_before_the_latest_roster() {
        let (organizer, adult, holder) = (Person::new(1), Person::new(2), Person::new(3));
        let mut h = History::new();
        h.roster(
            &organizer,
            vec![owner(&organizer), adult.active(&[]), holder.active(&[GroupRole::Members])],
            None,
        );
        h.roster(
            &organizer,
            vec![
                owner(&organizer),
                adult.active(&[]),
                holder.entry(&[GroupRole::Members], 2, MemberStatus::Left),
            ],
            None,
        );
        let keys = ml_dsa_keys(&[&organizer, &holder]);
        let chain = accepted(accept(&h, &keys, Over::default()));
        let succession = |tie: u64, signer: &Person| {
            let (old, next) = (h.key(1), group_public_key(group_seed_at(2)).unwrap());
            let statement = succession_bytes(&GroupKeySuccession {
                group_id: GROUP.into(),
                old_version: 1,
                new_version: 2,
                old_ed25519_public_key: old.ed25519_public_key,
                old_ml_dsa_public_key: old.ml_dsa_public_key,
                new_ed25519_public_key: next.ed25519_public_key,
                new_ml_dsa_public_key: next.ml_dsa_public_key,
                last_roster_version: tie,
                last_roster_digest: digest(&h.rosters[(tie - 1) as usize].statement),
                signer_user_id: signer.user_id.clone(),
            })
            .unwrap();
            signed_by(statement, &h.seeds[0], Some(signer))
        };
        let check = |s: SignedGroupStatement| group_succession_check_next(chain.clone(), s, keys.clone());
        assert!(check(succession(1, &organizer)).unwrap_err().to_string().contains("not tied to a roster"));
        assert!(check(succession(2, &holder))
            .unwrap_err()
            .to_string()
            .contains("not signed by a member who holds"));
        check(succession(2, &organizer)).unwrap();
        refused(
            accept(&h, &keys, Over { successions: Some(vec![succession(1, &organizer)]), ..Over::default() }),
            "has been replaced",
        );
    }

    /* Group key succession */

    #[test]
    fn two_successions_from_one_key_that_both_hold_are_refused_unless_a_group_key_mark_chooses() {
        let f = family();
        let rival_key = other_key();
        let rival = rewritten(&f, Some(&f.organizer), |s| {
            s.new_ed25519_public_key = rival_key.ed25519_public_key.clone();
            s.new_ml_dsa_public_key = rival_key.ml_dsa_public_key.clone();
        });
        for successions in
            [vec![f.h.successions[0].clone(), rival.clone()], vec![rival.clone(), f.h.successions[0].clone()]]
        {
            refused(
                newcomer(&f, Over { successions: Some(successions), ..Over::default() }),
                "more than one group key succession",
            );
        }
        let pin = pin_of(&f.h, 4, &f.keys);
        let chain = accepted(newcomer(
            &f,
            Over {
                pins: vec![pin],
                successions: Some(vec![rival.clone(), f.h.successions[0].clone()]),
                ..Over::default()
            },
        ));
        assert_eq!(chain.group_key, f.h.key(2));
        // And the other way: a mark from a device that took the rival chooses the rival.
        let three = Some(f.h.rosters[..3].to_vec());
        let theirs = accepted(newcomer(
            &f,
            Over { rosters: three.clone(), successions: Some(vec![rival.clone()]), ..Over::default() },
        ));
        let pin = pin_after(vec![], theirs, CHECKED.into()).unwrap();
        let chain = accepted(newcomer(
            &f,
            Over {
                pins: vec![pin],
                rosters: three,
                successions: Some(vec![f.h.successions[0].clone(), rival]),
                ..Over::default()
            },
        ));
        assert_eq!(chain.group_key, rival_key);
    }

    #[test]
    fn p3_a_rival_succession_tied_early_waits_for_the_marked_one_the_warning_only_if_a_holder_signed_roster_holds_under_it(
    ) {
        let (organizer, holder) = (Person::new(1), Person::new(3));
        let mut h = History::new();
        h.roster(&organizer, vec![owner(&organizer), holder.active(&[GroupRole::Members])], None);
        h.roster(
            &organizer,
            vec![owner(&organizer), holder.entry(&[GroupRole::Members], 1, MemberStatus::Left)],
            None,
        );
        h.succession(&organizer);
        h.roster(
            &organizer,
            vec![owner(&organizer), holder.entry(&[GroupRole::Members], 1, MemberStatus::Left)],
            None,
        );
        let keys = ml_dsa_keys(&[&organizer, &holder]);
        let pin = pin_of(&h, 3, &keys);
        let rival_key = group_public_key(group_seed_at(7)).unwrap();
        let early = GroupKeySuccession {
            new_ed25519_public_key: rival_key.ed25519_public_key.clone(),
            new_ml_dsa_public_key: rival_key.ml_dsa_public_key.clone(),
            last_roster_version: 1,
            last_roster_digest: digest(&h.rosters[0].statement),
            signer_user_id: holder.user_id.clone(),
            ..parse_succession(&h.successions[0].statement).unwrap()
        };
        let early = signed_by(succession_bytes(&early).unwrap(), &h.seeds[0], Some(&holder));
        let mut both = h.successions.clone();
        both.push(early.clone());
        let marked = |pins: Vec<GroupPin>,
                      rosters: Vec<SignedGroupStatement>,
                      successions: Vec<SignedGroupStatement>| {
            accept(
                &h,
                &keys,
                Over {
                    pins,
                    checked: false,
                    rosters: Some(rosters),
                    successions: Some(successions),
                    ..Over::default()
                },
            )
        };
        assert_eq!(
            accepted(marked(vec![pin.clone()], h.rosters.clone(), both.clone())).roster.roster_version,
            3
        );
        let sides_of = |mark: &GroupPin| {
            vec![
                side(&mark.group_key_digest, &[MarkSource::Pin], None),
                side(&group_key_digest_of(&rival_key).unwrap(), &[MarkSource::Served], Some(&holder)),
            ]
        };
        // Without the real succession (withheld), the mark (here a pin from a device at 2 that took
        // it) is never met: a rollback, refused, never the warning.
        let at_two =
            accepted(accept(&h, &keys, Over { rosters: Some(h.rosters[..2].to_vec()), ..Over::default() }));
        let at_two = pin_after(vec![], at_two, CHECKED.into()).unwrap();
        refused(marked(vec![at_two], h.rosters[..2].to_vec(), vec![early.clone()]), "older member list");
        // A roster under the real key 2 while only the rival is served: the succession is missing.
        refused(marked(vec![pin.clone()], h.rosters.clone(), vec![early.clone()]), "succession is missing");
        // A roster a holder signed under the rival key: a real other history the person's mark
        // contradicts, the warning.
        let under_rival =
            roster_sign(h.statements[2].clone(), group_seed_at(7), organizer.keys.clone()).unwrap();
        let mut rivalled = h.rosters[..2].to_vec();
        rivalled.push(under_rival);
        fork_of(
            marked(vec![pin.clone()], rivalled, vec![early.clone()]),
            ForkOf::GroupKey,
            2,
            sides_of(&pin),
        );
        // Under the rival key, but signed by the removed holder (no longer a holder at roster 2):
        // nothing a holder signed, so a refusal, never the warning.
        let by_removed = roster_sign(
            Roster { signer_user_id: holder.user_id.clone(), ..h.statements[2].clone() },
            group_seed_at(7),
            holder.keys.clone(),
        )
        .unwrap();
        let mut removed = h.rosters[..2].to_vec();
        removed.push(by_removed);
        refused(marked(vec![pin.clone()], removed, vec![early]), "succession is missing");
        // A newcomer, with no mark to choose: the rival is taken at 1 and roster 2 is under a replaced key.
        refused(accept(&h, &keys, Over { successions: Some(both), ..Over::default() }), "has been replaced");
    }

    #[test]
    fn a_succession_that_does_not_hold_is_ignored_and_one_tied_too_early_stalls() {
        let f = family();
        let other = other_key();
        let keyed = |s: &mut GroupKeySuccession| {
            s.new_ed25519_public_key = other.ed25519_public_key.clone();
            s.new_ml_dsa_public_key = other.ml_dsa_public_key.clone();
        };
        let cases: Vec<(SignedGroupStatement, &str)> = vec![
            (rewritten(&f, None, keyed), "not signed by the member it names"),
            (
                rewritten(&f, Some(&f.holder), |s| {
                    keyed(s);
                    s.signer_user_id = f.holder.user_id.clone();
                }),
                "not signed by a member who holds",
            ),
            (
                rewritten(&f, Some(&f.organizer), |s| {
                    keyed(s);
                    s.last_roster_digest = digest(&f.h.rosters[1].statement);
                }),
                "not tied to a roster",
            ),
            (
                rewritten(&f, Some(&f.organizer), |s| {
                    s.old_ed25519_public_key = other.ed25519_public_key.clone();
                    s.old_ml_dsa_public_key = other.ml_dsa_public_key.clone();
                }),
                "not signed by the key it replaces",
            ),
            // Signed by this group's key and holder, but for another group.
            (
                rewritten(&f, Some(&f.organizer), |s| {
                    keyed(s);
                    s.group_id = OTHER_GROUP.into();
                }),
                "not signed by the key it replaces",
            ),
            // A "new" key that is the old one.
            (
                rewritten(&f, Some(&f.organizer), |s| {
                    s.new_ed25519_public_key = f.h.key(1).ed25519_public_key;
                    s.new_ml_dsa_public_key = f.h.key(1).ml_dsa_public_key;
                }),
                "does not replace the key with a new one",
            ),
        ];
        for (rival, why) in cases {
            let both = vec![f.h.successions[0].clone(), rival.clone()];
            assert_eq!(
                accepted(newcomer(&f, Over { successions: Some(both), ..Over::default() })).group_key_version,
                2
            );
            refused(newcomer(&f, Over { successions: Some(vec![rival]), ..Over::default() }), why);
        }
        refused(newcomer(&f, Over { successions: Some(vec![]), ..Over::default() }), "succession is missing");
        let early = rewritten(&f, Some(&f.organizer), |s| {
            keyed(s);
            s.last_roster_version = 2;
            s.last_roster_digest = digest(&f.h.rosters[1].statement);
        });
        for successions in [vec![f.h.successions[0].clone(), early.clone()], vec![early.clone()]] {
            refused(
                newcomer(&f, Over { successions: Some(successions), ..Over::default() }),
                "has been replaced",
            );
        }
    }

    #[test]
    fn p4_a_former_holder_of_an_old_key_gets_nothing_from_a_roster_or_succession_under_it() {
        let (organizer, adult, holder, outsider) =
            (Person::new(1), Person::new(2), Person::new(3), Person::new(5));
        let gone = holder.entry(&[GroupRole::Members], 2, MemberStatus::Left);
        let mut h = History::new();
        h.roster(&organizer, vec![owner(&organizer), holder.active(&[GroupRole::Members])], None);
        h.roster(&organizer, vec![owner(&organizer), gone.clone()], None);
        h.succession(&organizer);
        for i in 0..4 {
            let roles: &[GroupRole] = if i % 2 == 1 { &[GroupRole::Billing] } else { &[] };
            h.roster(&organizer, vec![owner(&organizer), gone.clone(), adult.active(roles)], Some(2));
        }
        let mut far = parse_succession(&h.successions[0].statement).unwrap();
        far.last_roster_version = 100;
        far.signer_user_id = holder.user_id.clone();
        let far = signed_by(succession_bytes(&far).unwrap(), &h.seeds[0], None);
        let keys = ml_dsa_keys(&[&organizer, &outsider]);
        let mut successions = h.successions.clone();
        successions.push(far);
        assert_eq!(
            accepted(accept(&h, &keys, Over { successions: Some(successions), ..Over::default() }))
                .group_key_version,
            2
        );
        let mut rival = h.statements[5].clone();
        rival.group_key_version = 1;
        rival.signer_user_id = holder.user_id.clone();
        rival.members = sorted(vec![
            owner(&organizer),
            RosterMember {
                user_id: holder.user_id.clone(),
                ..outsider.entry(&[GroupRole::Members], 6, MemberStatus::Active)
            },
        ]);
        let rival = signed_by(roster_bytes_of(rival), &h.seeds[0], Some(&outsider));
        let mut rosters = h.rosters.clone();
        rosters.push(rival.clone());
        refused(
            accept(&h, &keys, Over { rosters: Some(rosters), ..Over::default() }),
            "more than one latest",
        );
        h.roster(&organizer, vec![owner(&organizer), gone, adult.active(&[])], Some(2));
        let mut rosters = h.rosters.clone();
        rosters.push(rival);
        assert_eq!(
            accepted(accept(&h, &keys, Over { rosters: Some(rosters), ..Over::default() })).dead_branches,
            vec![DeadBranch { version: 6, signer_user_id: holder.user_id.clone() }]
        );
    }

    #[test]
    fn a_roster_signed_by_a_key_after_its_succession_is_refused() {
        let f = family();
        let mut late = f.h.statements[3].clone();
        late.roster_version = 5;
        late.previous_roster_digest = digest(&f.h.rosters[3].statement);
        late.group_key_version = 1;
        let mut rosters = f.h.rosters.clone();
        rosters.push(roster_sign(late, f.h.seeds[0].clone(), f.organizer.keys.clone()).unwrap());
        refused(newcomer(&f, Over { rosters: Some(rosters), ..Over::default() }), "has been replaced");
        let mut h = History::new();
        let o = owner(&f.organizer);
        h.roster(&f.organizer, vec![o.clone()], None);
        h.roster(&f.organizer, vec![o.clone(), f.adult.entry(&[], 2, MemberStatus::Active)], None);
        h.succession(&f.organizer);
        h.roster(
            &f.organizer,
            vec![o, f.adult.entry(&[], 2, MemberStatus::Active), f.child.entry(&[], 3, MemberStatus::Active)],
            Some(1),
        );
        refused(accept(&h, &f.keys, Over::default()), "has been replaced");
    }

    #[test]
    fn a_roster_after_a_members_holder_s_removal_without_a_succession_is_refused() {
        let f = family();
        let o = owner(&f.organizer);
        let gone = f.holder.entry(&[GroupRole::Members], 2, MemberStatus::Left);
        let mut h = History::new();
        h.roster(
            &f.organizer,
            vec![o.clone(), f.adult.active(&[]), f.holder.active(&[GroupRole::Members])],
            None,
        );
        h.roster(&f.organizer, vec![o.clone(), f.adult.active(&[]), gone.clone()], None);
        assert!(accepted(accept(&h, &f.keys, Over::default())).succession_due);
        h.roster(
            &f.organizer,
            vec![o.clone(), f.adult.entry(&[GroupRole::Members], 3, MemberStatus::Active), gone],
            None,
        );
        refused(accept(&h, &f.keys, Over::default()), "must be replaced first");
        let mut g = History::new();
        g.roster(&f.organizer, vec![o.clone(), f.holder.active(&[GroupRole::Members])], None);
        g.roster(&f.organizer, vec![o.clone(), f.holder.entry(&[], 2, MemberStatus::Active)], None);
        g.roster(
            &f.organizer,
            vec![
                o,
                f.holder.entry(&[], 2, MemberStatus::Active),
                f.adult.entry(&[], 3, MemberStatus::Active),
            ],
            None,
        );
        refused(accept(&g, &f.keys, Over::default()), "must be replaced first");
    }

    #[test]
    fn successions_are_tied_in_order() {
        let (organizer, adult) = (Person::new(1), Person::new(2));
        let keys = ml_dsa_keys(&[&organizer]);
        let mut h = History::new();
        h.roster(&organizer, vec![owner(&organizer), adult.active(&[])], None);
        h.roster(&organizer, vec![owner(&organizer), adult.active(&[GroupRole::Billing])], None);
        h.succession(&organizer);
        let (two, three) = (h.key(2), group_public_key(group_seed_at(3)).unwrap());
        let early = GroupKeySuccession {
            group_id: GROUP.into(),
            old_version: 2,
            new_version: 3,
            old_ed25519_public_key: two.ed25519_public_key,
            old_ml_dsa_public_key: two.ml_dsa_public_key,
            new_ed25519_public_key: three.ed25519_public_key,
            new_ml_dsa_public_key: three.ml_dsa_public_key,
            last_roster_version: 1,
            last_roster_digest: digest(&h.rosters[0].statement),
            signer_user_id: organizer.user_id.clone(),
        };
        let early = signed_by(succession_bytes(&early).unwrap(), &h.seeds[1], Some(&organizer));
        let mut successions = h.successions.clone();
        successions.push(early.clone());
        assert_eq!(
            accepted(accept(&h, &keys, Over { successions: Some(successions), ..Over::default() }))
                .group_key_version,
            2
        );
        h.succession(&organizer);
        h.roster(&organizer, vec![owner(&organizer), adult.active(&[])], Some(3));
        refused(
            accept(
                &h,
                &keys,
                Over { successions: Some(vec![h.successions[0].clone(), early]), ..Over::default() },
            ),
            "out of order",
        );
        let chain =
            accepted(accept(&h, &keys, Over { rosters: Some(h.rosters[..2].to_vec()), ..Over::default() }));
        let pin = pin_after(vec![], chain, CHECKED.into()).unwrap();
        refused(
            accept(
                &h,
                &keys,
                Over {
                    pins: vec![pin],
                    rosters: Some(h.rosters[..2].to_vec()),
                    successions: Some(vec![]),
                    ..Over::default()
                },
            ),
            "older member list",
        );
    }

    /* The device's cache */

    #[test]
    fn continuing_from_the_cache_gives_the_chain_verifying_from_version_1_gives() {
        let f = family();
        let three = accepted_to(&f.h, 3, &f.keys);
        let fast = accepted(newcomer(
            &f,
            Over {
                cache: Some(three.cache.clone()),
                rosters: Some(vec![f.h.rosters[3].clone()]),
                checked: false,
                ..Over::default()
            },
        ));
        let full = accepted(newcomer(&f, Over::default()));
        assert_eq!(fast, full);
        let again = accepted(newcomer(
            &f,
            Over { cache: Some(full.cache.clone()), rosters: Some(vec![]), ..Over::default() },
        ));
        assert_eq!(again.cache, full.cache);
    }

    #[test]
    fn the_cache_is_the_person_s_mark_a_chain_off_it_is_the_warning_a_succession_off_it_is_ignored() {
        let f = family();
        let two = accepted_to(&f.h, 2, &f.keys);
        let four = accepted(newcomer(&f, Over::default()));
        let rival_key = other_key();
        let rival = rewritten(&f, Some(&f.organizer), |s| {
            s.new_ed25519_public_key = rival_key.ed25519_public_key.clone();
            s.new_ml_dsa_public_key = rival_key.ml_dsa_public_key.clone();
        });
        let kept = accepted(newcomer(
            &f,
            Over {
                cache: Some(four.cache.clone()),
                rosters: Some(vec![]),
                successions: Some(vec![rival.clone()]),
                ..Over::default()
            },
        ));
        assert_eq!(kept.group_key, f.h.key(2));
        let other = resigned(&f.h, 2, &f.organizer, |r| {
            r.members =
                vec![owner(&f.organizer), f.adult.active(&[]), f.outsider.entry(&[], 2, MemberStatus::Active)]
        });
        let other_digest = digest(&other.statement);
        let elsewhere = GroupPin { roster_digest: other_digest.clone(), ..pin_of(&f.h, 2, &f.keys) };
        fork_of(
            newcomer(
                &f,
                Over {
                    cache: Some(two.cache.clone()),
                    rosters: Some(f.h.rosters[2..].to_vec()),
                    pins: vec![elsewhere],
                    ..Over::default()
                },
            ),
            ForkOf::Roster,
            2,
            vec![
                side(&other_digest, &[MarkSource::Pin], None),
                side(&two.roster_digest, &[MarkSource::Cache], Some(&f.organizer)),
            ],
        );
        let mut g = History::new();
        g.roster(&f.organizer, vec![owner(&f.organizer), f.adult.active(&[])], None);
        g.roster(
            &f.organizer,
            vec![owner(&f.organizer), f.adult.active(&[]), f.outsider.entry(&[], 2, MemberStatus::Active)],
            None,
        );
        let theirs = accepted_to(&g, 2, &f.keys);
        fork_of(
            newcomer(&f, Over { cache: Some(theirs.cache.clone()), ..Over::default() }),
            ForkOf::Roster,
            2,
            vec![
                side(&theirs.roster_digest, &[MarkSource::Cache], Some(&f.organizer)),
                side(&two.roster_digest, &[MarkSource::Served], Some(&f.organizer)),
            ],
        );
        // Rosters after it that do not link to its last roster, signed or not (p7): no warning,
        // fetch the chain again from version 1, where the cache is a mark.
        let branch = resigned(&f.h, 3, &f.organizer, |r| r.previous_roster_digest = junk());
        let unsigned = SignedGroupStatement {
            signature: GroupSignature { ed25519: vec![0; 64], ml_dsa: vec![0; 3309] },
            signer_signature: vec![0; 3373],
            ..branch.clone()
        };
        for rosters in [vec![branch], vec![unsigned]] {
            refused(
                newcomer(
                    &f,
                    Over { cache: Some(two.cache.clone()), rosters: Some(rosters), ..Over::default() },
                ),
                "fetch it again from version 1",
            );
        }
        let saw_rival = accepted(newcomer(
            &f,
            Over {
                rosters: Some(f.h.rosters[..3].to_vec()),
                successions: Some(vec![rival]),
                ..Over::default()
            },
        ));
        fork_of(
            newcomer(&f, Over { cache: Some(saw_rival.cache.clone()), ..Over::default() }),
            ForkOf::GroupKey,
            2,
            vec![
                side(&group_key_digest_of(&rival_key).unwrap(), &[MarkSource::Cache], Some(&f.organizer)),
                side(&four.group_key_digest, &[MarkSource::Served], Some(&f.organizer)),
            ],
        );
        refused(
            newcomer(
                &f,
                Over {
                    cache: Some(two.cache.clone()),
                    rosters: Some(f.h.rosters[1..].to_vec()),
                    ..Over::default()
                },
            ),
            "does not follow the last one",
        );
    }

    #[test]
    fn a_chain_taking_back_a_group_key_the_cache_verified_is_a_rollback() {
        let f = family();
        let three =
            accepted(newcomer(&f, Over { rosters: Some(f.h.rosters[..3].to_vec()), ..Over::default() }));
        assert_eq!(three.group_key_version, 2);
        refused(
            newcomer(
                &f,
                Over {
                    cache: Some(three.cache.clone()),
                    rosters: Some(f.h.rosters[..3].to_vec()),
                    successions: Some(vec![]),
                    ..Over::default()
                },
            ),
            "older member list",
        );
    }

    #[test]
    fn probes_3a_3c_a_cache_outside_its_form_of_another_group_or_not_through_its_roster_is_refused() {
        let f = family();
        let cache = accepted_to(&f.h, 2, &f.keys).cache.clone();
        let rest = f.h.rosters[2..].to_vec();
        let set = KeySet {
            encryption_public_key: f.adult.keys.encryption_public_key.clone(),
            signing_public_key: f.adult.keys.signing_public_key.clone(),
            ml_dsa_public_key_digest: digest(&f.adult.ml_dsa()),
        };
        let with = |change: &dyn Fn(&mut GroupChainCache)| {
            let mut c = cache.clone();
            change(&mut c);
            c
        };
        let broken = vec![
            with(&|c| {
                c.key_history.insert(
                    f.adult.user_id.clone(),
                    vec![KeySet { signing_public_key: "nope".into(), ..set.clone() }],
                );
            }),
            with(&|c| {
                c.key_history.insert(f.adult.user_id.to_uppercase(), vec![]);
            }),
            with(&|c| {
                c.key_history.insert(f.adult.user_id.clone(), vec![set.clone(), set.clone()]);
            }),
            with(&|c| c.group_id = OTHER_GROUP.into()),
            with(&|c| c.roster_digests = vec![c.roster_digests[0].clone(), c.roster_digests[0].clone()]),
            with(&|c| c.roster_digests = vec![c.roster_digests[0].clone()]),
            with(&|c| c.roster_digests = vec![c.roster_digests[1].clone()]),
            with(&|c| c.statement = encode(&f.h.rosters[0].statement)),
            with(&|c| c.group_keys = vec![]),
            with(&|c| {
                c.successions = vec![CachedSuccession {
                    last_roster_version: 1,
                    digest: c.roster_digests[0].clone(),
                    signer_user_id: f.organizer.user_id.clone(),
                }]
            }),
            with(&|c| c.own_entry_wrong_at = vec![3]),
            with(&|c| c.creator_user_id = "someone".into()),
        ];
        for value in broken {
            refused(
                newcomer(&f, Over { cache: Some(value), rosters: Some(rest.clone()), ..Over::default() }),
                "Invalid member list cache.",
            );
        }
        refused(
            newcomer(
                &f,
                Over { cache: Some(cache), rosters: Some(rest), first: Some(other_key()), ..Over::default() },
            ),
            "not the group keys this person checked",
        );
        // A cache through 4, given nothing to extend it with: it alone must hold together.
        let four = accepted(newcomer(&f, Over::default())).cache.clone();
        let foreign = resigned(&f.h, 4, &f.organizer, |r| r.group_id = OTHER_GROUP.into());
        let mut far = four.clone();
        far.successions[0].last_roster_version = 99;
        let mut digests = four.roster_digests.clone();
        digests[3] = digest(&foreign.statement);
        for value in [
            GroupChainCache {
                group_keys: four.group_keys[..1].to_vec(),
                successions: vec![],
                ..four.clone()
            },
            far,
            GroupChainCache {
                statement: encode(&foreign.statement),
                roster_digests: digests,
                ..four.clone()
            },
        ] {
            refused(
                newcomer(&f, Over { cache: Some(value), rosters: Some(vec![]), ..Over::default() }),
                "Invalid member list cache.",
            );
        }
    }

    /* Folding in changes */

    /* The person's served identity with `change`, its keys statement signed again by `signer`. */
    fn re_signed(
        who: &Person,
        signer: &IdentityKeys,
        change: impl Fn(&mut PublicIdentity),
    ) -> PublicIdentity {
        let mut served = who.served();
        change(&mut served);
        let statement = crate::signatures::keys_statement(
            who.user_id.clone(),
            served.key_version,
            served.encryption_public_key.clone(),
            served.signing_public_key.clone(),
            served.ml_dsa_public_key.clone(),
            served.kem_public_key.clone(),
        )
        .unwrap();
        served.keys_signature =
            encode(&sign_hybrid(&signer.signing_seed, &signer.ml_dsa_seed, &statement).unwrap());
        served
    }

    #[test]
    fn a_new_member_s_entry_comes_only_from_the_keys_their_words_check_confirmed() {
        let (adult, outsider) = (Person::new(2), Person::new(5));
        let pin = verified_pin(&adult);
        assert_eq!(
            roster_entry_new(pin.clone(), adult.served(), vec![GroupRole::Members, GroupRole::Billing], 4)
                .unwrap(),
            adult.entry(&[GroupRole::Billing, GroupRole::Members], 4, MemberStatus::Active)
        );
        let mut swapped = adult.served();
        swapped.kem_public_key = outsider.served().kem_public_key;
        assert!(roster_entry_new(pin.clone(), swapped, vec![], 4).is_err());
        let re_signed =
            re_signed(&adult, &adult.keys, |served| served.kem_public_key = outsider.served().kem_public_key);
        assert!(identity_verify_keys(adult.user_id.clone(), re_signed.clone()));
        assert!(roster_entry_new(pin.clone(), re_signed, vec![], 4).is_err());
        // The words-checked keys, with a keys statement the adult never signed.
        let unsigned = PublicIdentity { keys_signature: outsider.served().keys_signature, ..adult.served() };
        assert!(roster_entry_new(pin.clone(), unsigned, vec![], 4).is_err());
        let wrong_words =
            VerifiedPin { fingerprint: "0000 0000 0000 0000 0000 0000 0000 0000 0000 0000".into(), ..pin };
        assert!(roster_entry_new(wrong_words, adult.served(), vec![], 4).is_err());
    }

    #[test]
    fn an_identity_change_is_followed_only_through_its_chain_from_the_entry_s_keys_at_any_key_version() {
        let (adult, outsider) = (Person::new(2), Person::new(5));
        let (adult2, first) = adult.succeed();
        let (adult3, second) = adult2.succeed();
        let entry = adult.entry(&[], 2, MemberStatus::Active);
        assert_eq!(
            roster_entry_fold_in(entry.clone(), adult2.served(), vec![first.clone()], 5).unwrap(),
            FoldedEntry {
                entry: adult2.entry(&[], 5, MemberStatus::Active),
                changed: true,
                needs_check: false
            }
        );
        assert_eq!(
            roster_entry_fold_in(entry.clone(), adult3.served(), vec![first.clone(), second], 5).unwrap(),
            FoldedEntry {
                entry: adult3.entry(&[], 5, MemberStatus::Active),
                changed: true,
                needs_check: false
            }
        );
        assert!(
            roster_entry_fold_in(
                RosterMember { key_version: 1000, ..entry.clone() },
                adult2.served(),
                vec![first.clone()],
                5
            )
            .unwrap()
            .changed
        );
        let mut stranger = outsider.served();
        stranger.key_version = 2;
        let forged = SuccessionLink {
            signature: encode(&vec![0u8; decode("s", &first.signature, None).unwrap().len()]),
            consent: Some(encode(&vec![0u8; crate::identity::SUCCESSION_CONSENT_BYTES])),
            ..first.clone()
        };
        // r9 (Opus 3): fold-in walks from the entry's keys, where consent buys nothing: the version 2
        // link alone folds the identity in, as it did before round 8.
        let one_sided = SuccessionLink { consent: None, ..first.clone() };
        assert!(roster_entry_fold_in(entry.clone(), adult2.served(), vec![one_sided], 5).unwrap().changed);
        let misstated = re_signed(&adult2, &outsider.keys, |_| {});
        for (served, links) in [
            (adult2.served(), vec![]),
            (stranger, vec![first.clone()]),
            (adult2.served(), vec![forged]),
            (misstated, vec![first]),
        ] {
            assert_eq!(
                roster_entry_fold_in(entry.clone(), served, links, 5).unwrap(),
                FoldedEntry { entry: entry.clone(), changed: false, needs_check: true }
            );
        }
        assert_eq!(
            roster_entry_fold_in(entry.clone(), adult.served(), vec![], 5).unwrap(),
            FoldedEntry { entry, changed: false, needs_check: false }
        );
    }

    #[test]
    fn the_next_roster_is_chained_sorted_and_sets_since_itself_and_a_member_checks_their_own_entry() {
        let f = family();
        let chain = accepted(newcomer(&f, Over::default()));
        let roster = roster_next(
            chain,
            vec![
                RosterMember {
                    since_version: 4,
                    ..f.holder.entry(&[GroupRole::Members], 3, MemberStatus::Left)
                },
                RosterMember {
                    since_version: 1,
                    ..f.adult.active(&[GroupRole::Members, GroupRole::Billing])
                },
                RosterMember { since_version: 99, ..owner(&f.organizer) },
            ],
            f.organizer.user_id.clone(),
            None,
        )
        .unwrap();
        assert_eq!((roster.roster_version, roster.group_key_version), (5, 2));
        assert_eq!(
            roster.members.iter().map(|m| (m.user_id.clone(), m.since_version)).collect::<Vec<_>>(),
            vec![
                (f.organizer.user_id.clone(), 1),
                (f.adult.user_id.clone(), 5),
                (f.holder.user_id.clone(), 3)
            ]
        );
        assert_eq!(roster.members[1].roles, vec![GroupRole::Billing, GroupRole::Members]);
        assert_eq!(
            roster_own_entry(roster.clone(), f.adult.user_id.clone(), f.adult.served_keys()),
            OwnEntry::Ok
        );
        assert_eq!(
            roster_own_entry(roster.clone(), f.outsider.user_id.clone(), f.outsider.served_keys()),
            OwnEntry::Absent
        );
        assert_eq!(
            roster_own_entry(roster, f.adult.user_id.clone(), f.outsider.served_keys()),
            OwnEntry::Wrong
        );
        assert_eq!(
            group_dropped_holders(f.h.statements[1].clone(), vec![f.organizer.user_id.clone()]),
            vec![f.holder.user_id.clone()]
        );
        assert!(group_dropped_holders(
            f.h.statements[1].clone(),
            vec![f.organizer.user_id.clone(), f.holder.user_id.clone()]
        )
        .is_empty());
        assert!(
            group_dropped_holders(f.h.statements[2].clone(), vec![f.organizer.user_id.clone()]).is_empty()
        );
    }

    #[test]
    fn trust_as_the_group_does_writes_a_version_3_pin_with_the_roster_s_digests() {
        let f = family();
        let chain = accepted(newcomer(&f, Over::default()));
        let (adult, outsider) = (&f.adult, &f.outsider);
        let pin = trust_as_group_does(chain.clone(), adult.user_id.clone(), adult.served()).unwrap();
        assert_eq!(pin, VerifiedPin { trusted_via: Some(GROUP.into()), ..verified_pin(adult) });
        // r11 (Opus 2): a pin the group vouched for admits no one; the same keys after a words
        // check do.
        assert!(roster_entry_new(pin.clone(), adult.served(), vec![], 9).is_err());
        assert!(roster_entry_new(VerifiedPin { trusted_via: None, ..pin }, adult.served(), vec![], 9).is_ok());
        let mut swapped = adult.served();
        swapped.ml_dsa_public_key = outsider.served().ml_dsa_public_key;
        assert!(trust_as_group_does(chain.clone(), adult.user_id.clone(), swapped).is_err());
        let forger = IdentityKeys { ml_dsa_seed: outsider.keys.ml_dsa_seed.clone(), ..adult.keys.clone() };
        let forged = re_signed(adult, &forger, |served| {
            served.ml_dsa_public_key = outsider.served().ml_dsa_public_key
        });
        assert!(identity_verify_keys(adult.user_id.clone(), forged.clone()));
        assert!(trust_as_group_does(chain.clone(), adult.user_id.clone(), forged).is_err());
        // The entry's very keys, with a keys statement the adult never signed.
        let unsigned = PublicIdentity { keys_signature: outsider.served().keys_signature, ..adult.served() };
        assert!(trust_as_group_does(chain.clone(), adult.user_id.clone(), unsigned).is_err());
        assert!(trust_as_group_does(chain, f.holder.user_id.clone(), f.holder.served()).is_err());
    }

    /* Scoped verdicts */

    /* The verdict for a metadata record by `writer`, signed with `signing_seed`, in `workspace`. */
    fn verdict_by(
        chain: &Arc<AcceptedRosters>,
        writer: &Person,
        signing_seed: &[u8],
        workspace: &str,
        pinned: Option<PinnedKeys>,
        served: Option<ServedKeys>,
        links: Option<Vec<SuccessionLink>>,
    ) -> GroupIntegrity {
        let statement = MetadataStatement {
            workspace_id: workspace.into(),
            node_id: "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e".into(),
            kind: NodeKind::File,
            metadata_version: 1,
        };
        let envelope = vec![5u8; 96];
        let signature = metadata_sign(signing_seed.to_vec(), statement.clone(), envelope.clone()).unwrap();
        let trust = group_writer_trust(
            GROUP.into(),
            HashMap::from([(AREA.to_string(), 1)]),
            GroupReading::Accepted { chain: chain.clone() },
            workspace.into(),
            writer.user_id.clone(),
            pinned.map(|keys| WriterPin::of(keys, None)),
            served,
            links,
            None,
        );
        group_metadata_integrity(trust, None, statement, envelope, Some(signature))
    }

    /* `writer`'s record signed by `signer`, the writer's served identity and links (none) loaded. */
    fn verdict(chain: &Arc<AcceptedRosters>, writer: &Person, signer: &Person) -> GroupIntegrity {
        verdict_by(
            chain,
            writer,
            &signer.keys.signing_seed,
            AREA,
            None,
            Some(writer.served_keys()),
            Some(vec![]),
        )
    }

    fn is(verdict: GroupVerdict, via: Option<&str>) -> GroupIntegrity {
        GroupIntegrity { verdict, via: via.map(Into::into) }
    }

    #[test]
    fn roster_trust_verifies_inside_the_group_s_areas_and_nowhere_else() {
        let f = family();
        let chain = accepted(newcomer(&f, Over::default()));
        assert_eq!(verdict(&chain, &f.adult, &f.adult), is(GroupVerdict::Verified, Some(GROUP)));
        assert_eq!(
            verdict_by(&chain, &f.adult, &f.adult.keys.signing_seed, OTHER_AREA, None, None, None),
            is(GroupVerdict::UnknownSigner, None)
        );
        assert_eq!(verdict(&chain, &f.adult, &f.outsider), is(GroupVerdict::BadSignature, None));
        assert_eq!(verdict(&chain, &f.outsider, &f.outsider), is(GroupVerdict::UnknownSigner, None));
    }

    #[test]
    fn probes_4_4b_7_a_forged_or_bit_flipped_record_reads_bad_and_unchecked_when_the_chain_did_not_load() {
        let f = family();
        let chain = accepted(newcomer(&f, Over { pins: vec![pin_of(&f.h, 4, &f.keys)], ..Over::default() }));
        let statement = MetadataStatement {
            workspace_id: AREA.into(),
            node_id: "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e".into(),
            kind: NodeKind::File,
            metadata_version: 1,
        };
        let envelope = vec![5u8; 96];
        let mut flipped =
            metadata_sign(f.adult.keys.signing_seed.to_vec(), statement.clone(), envelope.clone()).unwrap();
        flipped[0] ^= 1;
        let forged =
            metadata_sign(f.outsider.keys.signing_seed.to_vec(), statement.clone(), envelope.clone())
                .unwrap();
        let read = |signature: Vec<u8>, served: Option<ServedKeys>, links: Option<Vec<SuccessionLink>>| {
            let trust = group_writer_trust(
                GROUP.into(),
                HashMap::from([(AREA.to_string(), 1)]),
                GroupReading::Accepted { chain: chain.clone() },
                AREA.into(),
                f.adult.user_id.clone(),
                None,
                served,
                links,
                None,
            );
            group_metadata_integrity(trust, None, statement.clone(), envelope.clone(), Some(signature))
        };
        for signature in [flipped, forged] {
            assert_eq!(
                read(signature.clone(), Some(f.adult.served_keys()), Some(vec![])),
                is(GroupVerdict::BadSignature, None)
            );
            assert_eq!(read(signature.clone(), None, Some(vec![])), is(GroupVerdict::Unchecked, None));
            assert_eq!(read(signature, Some(f.adult.served_keys()), None), is(GroupVerdict::Unchecked, None));
        }
        assert_eq!(
            verdict_by(&chain, &f.adult, &f.adult.keys.signing_seed, AREA, None, None, None),
            is(GroupVerdict::Verified, Some(GROUP))
        );
    }

    #[test]
    fn a_legitimate_identity_succession_is_followed_not_reported_as_a_key_conflict() {
        let f = family();
        let (next, link) = f.adult.succeed();
        let chain = accepted(newcomer(&f, Over::default()));
        let roster5 = roster_next(
            chain,
            vec![
                owner(&f.organizer),
                next.entry(&[], 5, MemberStatus::Active),
                f.holder.entry(&[GroupRole::Members], 3, MemberStatus::Left),
            ],
            f.organizer.user_id.clone(),
            None,
        )
        .unwrap();
        let mut rosters = f.h.rosters.clone();
        rosters.push(roster_sign(roster5, f.h.seeds[1].clone(), f.organizer.keys.clone()).unwrap());
        let chain = accepted(newcomer(&f, Over { rosters: Some(rosters), ..Over::default() }));
        let pinned = Some(f.adult.pinned());
        let (served, links) = (Some(next.served_keys()), Some(vec![link]));
        assert_eq!(
            verdict_by(
                &chain,
                &next,
                &next.keys.signing_seed,
                AREA,
                pinned.clone(),
                served.clone(),
                links.clone()
            ),
            is(GroupVerdict::Verified, Some(GROUP))
        );
        assert_eq!(
            verdict_by(
                &chain,
                &next,
                &f.adult.keys.signing_seed,
                AREA,
                pinned.clone(),
                served.clone(),
                links
            ),
            is(GroupVerdict::RetiredKey, None)
        );
        assert_eq!(
            verdict_by(&chain, &next, &next.keys.signing_seed, AREA, pinned, served, Some(vec![])),
            is(GroupVerdict::KeyConflict, None)
        );
    }

    #[test]
    fn probes_2a_2b_a_writer_whose_succession_no_roster_has_folded_in_yet_reads_as_themselves() {
        let f = family();
        let chain = accepted(newcomer(&f, Over::default()));
        let (adult2, link) = f.adult.succeed();
        let lag = (Some(adult2.served_keys()), Some(vec![link.clone()]));
        let new_key = adult2.keys.signing_seed.clone();
        assert_eq!(
            verdict_by(&chain, &f.adult, &new_key, AREA, None, lag.0.clone(), lag.1.clone()),
            is(GroupVerdict::Verified, Some(GROUP))
        );
        assert_eq!(
            verdict_by(
                &chain,
                &f.adult,
                &f.adult.keys.signing_seed,
                AREA,
                None,
                lag.0.clone(),
                lag.1.clone()
            ),
            is(GroupVerdict::RetiredKey, None)
        );
        assert_eq!(
            verdict_by(&chain, &f.adult, &new_key, AREA, Some(adult2.pinned()), lag.0.clone(), lag.1.clone()),
            is(GroupVerdict::Verified, None)
        );
        assert_eq!(
            verdict_by(
                &chain,
                &f.adult,
                &new_key,
                AREA,
                Some(f.adult.pinned()),
                lag.0.clone(),
                lag.1.clone()
            ),
            is(GroupVerdict::Verified, None)
        );
        let trust = group_writer_trust(
            GROUP.into(),
            HashMap::from([(AREA.to_string(), 1)]),
            GroupReading::Accepted { chain: chain.clone() },
            AREA.into(),
            f.adult.user_id.clone(),
            Some(f.adult.pinned()).map(|keys| WriterPin::of(keys, None)),
            lag.0.clone(),
            lag.1.clone(),
            None,
        );
        assert!(
            matches!(trust, GroupWriterTrust::Roster { followed: Some(ref s), .. } if s.signing_public_key == adult2.keys.signing_public_key)
        );
        assert_eq!(
            verdict_by(&chain, &f.adult, &new_key, AREA, None, Some(f.adult.served_keys()), Some(vec![])),
            is(GroupVerdict::BadSignature, None)
        );
        assert_eq!(
            verdict_by(&chain, &f.adult, &new_key, AREA, None, None, None),
            is(GroupVerdict::Unchecked, None)
        );
        let forged = SuccessionLink {
            signature: encode(&vec![0u8; decode("s", &link.signature, None).unwrap().len()]),
            consent: Some(encode(&vec![0u8; crate::identity::SUCCESSION_CONSENT_BYTES])),
            ..link.clone()
        };
        assert_eq!(
            verdict_by(&chain, &f.adult, &new_key, AREA, None, lag.0.clone(), Some(vec![forged])),
            is(GroupVerdict::BadSignature, None)
        );
        // r9 (Opus 3): the version 2 link alone holds on the roster-lag walk, which starts at the
        // entry's keys, never at keys a holder planted.
        let one_sided = SuccessionLink { consent: None, ..link.clone() };
        assert_eq!(
            verdict_by(&chain, &f.adult, &new_key, AREA, None, lag.0.clone(), Some(vec![one_sided])),
            is(GroupVerdict::Verified, Some(GROUP))
        );
        let (adult3, second) = adult2.succeed();
        assert_eq!(
            verdict_by(
                &chain,
                &f.adult,
                &new_key,
                AREA,
                None,
                Some(adult3.served_keys()),
                Some(vec![link.clone()])
            ),
            is(GroupVerdict::BadSignature, None)
        );
        let two = (Some(adult3.served_keys()), Some(vec![link, second]));
        assert_eq!(
            verdict_by(&chain, &f.adult, &adult3.keys.signing_seed, AREA, None, two.0.clone(), two.1.clone()),
            is(GroupVerdict::Verified, Some(GROUP))
        );
        assert_eq!(
            verdict_by(&chain, &f.adult, &new_key, AREA, None, two.0, two.1),
            is(GroupVerdict::RetiredKey, None)
        );
    }

    #[test]
    fn a_chain_from_the_pin_to_keys_the_roster_does_not_name_is_still_a_key_conflict() {
        let f = family();
        let chain = accepted(newcomer(&f, Over::default()));
        let (second, _) = f.adult.succeed();
        let (third, link) = second.succeed();
        assert_eq!(
            verdict_by(
                &chain,
                &f.adult,
                &f.adult.keys.signing_seed,
                AREA,
                Some(second.pinned()),
                Some(third.served_keys()),
                Some(vec![link])
            ),
            is(GroupVerdict::KeyConflict, None)
        );
    }

    #[test]
    fn a_disagreeing_pin_is_a_key_conflict_and_unchecked_when_what_it_needs_did_not_load() {
        let f = family();
        let chain = accepted(newcomer(&f, Over::default()));
        let seed = f.adult.keys.signing_seed.clone();
        let pinned = Some(f.outsider.pinned());
        let served = Some(f.adult.served_keys());
        assert_eq!(
            verdict_by(&chain, &f.adult, &seed, AREA, pinned.clone(), served.clone(), Some(vec![])),
            is(GroupVerdict::KeyConflict, None)
        );
        assert_eq!(
            verdict_by(&chain, &f.adult, &seed, AREA, pinned.clone(), None, Some(vec![])),
            is(GroupVerdict::Unchecked, None)
        );
        assert_eq!(
            verdict_by(&chain, &f.adult, &seed, AREA, pinned, served, None),
            is(GroupVerdict::Unchecked, None)
        );
        let half = PinnedKeys {
            ml_dsa_public_key_hash: f.outsider.pinned().ml_dsa_public_key_hash,
            ..f.adult.pinned()
        };
        assert_eq!(
            verdict_by(&chain, &f.adult, &seed, AREA, Some(half), None, None),
            is(GroupVerdict::Unchecked, None)
        );
    }

    #[test]
    fn r7_two_successions_the_member_signed_from_one_key_are_an_identity_fork_and_a_pin_at_the_newer_identity_retires_the_old_key(
    ) {
        let (organizer, member) = (Person::new(1), Person::new(4));
        let mut h = History::new();
        h.roster(&organizer, vec![owner(&organizer), member.active(&[])], None);
        let chain = accepted(accept(&h, &ml_dsa_keys(&[&organizer, &member]), Over::default()));
        let (member2, link) = member.succeed();
        let read = |seed: &[u8], pinned: Option<PinnedKeys>, links: Vec<SuccessionLink>| {
            verdict_by(&chain, &member, seed, AREA, pinned, Some(member2.served_keys()), Some(links))
        };
        let (old, new) = (&member.keys.signing_seed, &member2.keys.signing_seed);
        assert_eq!(read(old, None, vec![link.clone()]), is(GroupVerdict::RetiredKey, None));
        // Pinned at the newer identity: the old key is still theirs, earlier on the chain to it.
        assert_eq!(read(old, Some(member2.pinned()), vec![link.clone()]), is(GroupVerdict::RetiredKey, None));
        // A second successor the member signed from the same key (a race, or a retried upload).
        let (_, second) = member.succeed();
        for links in [vec![link.clone(), second.clone()], vec![second.clone(), link.clone()]] {
            for pinned in [None, Some(member.pinned())] {
                assert_eq!(read(new, pinned, links.clone()), is(GroupVerdict::Unchecked, None));
            }
        }
        // The same link served twice is no fork.
        assert_eq!(read(new, None, vec![link.clone(), link]), is(GroupVerdict::Verified, Some(GROUP)));
    }

    #[test]
    fn r7_the_group_walk_keeps_the_strict_verifier_s_version_and_served_key_rules_and_a_pin_older_than_the_first_keys_retires_from_itself(
    ) {
        let (organizer, outsider, member) = (Person::new(1), Person::new(5), Person::new(4));
        let (member2, link) = member.succeed();
        let (member3, link23) = member2.succeed();
        let mut h = History::new();
        h.roster(&organizer, vec![owner(&organizer), member.active(&[])], None);
        let chain = accepted(accept(&h, &ml_dsa_keys(&[&organizer, &member]), Over::default()));
        let read = |seed: &[u8], served: ServedKeys, links: Vec<SuccessionLink>| {
            verdict_by(&chain, &member, seed, AREA, None, Some(served), Some(links))
        };
        let bad = is(GroupVerdict::BadSignature, None);
        let (s2, s3) = (&member2.keys.signing_seed, &member3.keys.signing_seed);
        assert_eq!(
            read(s2, member2.served_keys(), vec![link.clone()]),
            is(GroupVerdict::Verified, Some(GROUP))
        );
        // The served identity with another ML-KEM key: no path, so the new key vouches for nothing.
        let other_kem =
            ServedKeys { kem_public_key: outsider.served_keys().kem_public_key, ..member2.served_keys() };
        assert_eq!(read(s2, other_kem, vec![link.clone()]), bad);
        // r8: the served version is not signed, so a lower one decides nothing.
        assert_eq!(
            read(s2, ServedKeys { key_version: 1, ..member2.served_keys() }, vec![link.clone()]),
            is(GroupVerdict::Verified, Some(GROUP))
        );
        // A link whose old version falls below the one before it: the path stops there.
        let mut falling = SuccessionLink { old_key_version: 1, ..link23.clone() };
        let statement = crate::succession_statement(member.user_id.clone(), falling.clone()).unwrap();
        falling.signature =
            encode(&sign_hybrid(&member2.keys.signing_seed, &member2.keys.ml_dsa_seed, &statement).unwrap());
        assert_eq!(
            read(s3, member3.served_keys(), vec![link.clone(), link23.clone()]),
            is(GroupVerdict::Verified, Some(GROUP))
        );
        assert_eq!(read(s3, member3.served_keys(), vec![link.clone(), falling]), bad);
        // A pin from before the member joined (their first keys on the chain are member2's): the
        // pinned key is theirs too, retired along the chain from the pin.
        let mut later = History::new();
        later.roster(&organizer, vec![owner(&organizer), member2.active(&[])], None);
        let joined = accepted(accept(&later, &ml_dsa_keys(&[&organizer, &member2]), Over::default()));
        assert_eq!(
            verdict_by(
                &joined,
                &member,
                &member.keys.signing_seed,
                AREA,
                Some(member.pinned()),
                Some(member3.served_keys()),
                Some(vec![link, link23])
            ),
            is(GroupVerdict::RetiredKey, None)
        );
    }

    #[test]
    fn p1_only_the_links_the_chain_verified_retire_keys_a_fake_link_in_front_retires_nothing() {
        let (organizer, adult, outsider) = (Person::new(1), Person::new(2), Person::new(5));
        let mut h = History::new();
        h.roster(&organizer, vec![owner(&organizer), adult.active(&[])], None);
        let chain = accepted(accept(&h, &ml_dsa_keys(&[&organizer]), Over::default()));
        let (adult2, link) = adult.succeed();
        // The adult's old X25519 and Ed25519 keys, another ML-DSA key, the outsider's signing key as
        // the "new" one, and no valid signature: the verifier skips it, so must the retiring.
        let fake = SuccessionLink {
            old_ml_dsa_public_key: outsider.served().ml_dsa_public_key,
            new_signing_public_key: outsider.served().signing_public_key,
            signature: encode(&[0u8; 3373]),
            ..link.clone()
        };
        for pinned in [None, Some(adult.pinned())] {
            for links in [vec![link.clone()], vec![fake.clone(), link.clone()]] {
                assert_eq!(
                    verdict_by(
                        &chain,
                        &adult,
                        &outsider.keys.signing_seed,
                        AREA,
                        pinned.clone(),
                        Some(adult2.served_keys()),
                        Some(links)
                    ),
                    is(GroupVerdict::BadSignature, None)
                );
            }
            // Junk in front of, or after, the real link changes nothing (r6 p5).
            let unsigned = SuccessionLink { signature: encode(&[0u8; 3373]), ..link.clone() };
            for links in [
                vec![fake.clone(), link.clone()],
                vec![link.clone(), fake.clone()],
                vec![link.clone(), unsigned],
            ] {
                assert_eq!(
                    verdict_by(
                        &chain,
                        &adult,
                        &adult.keys.signing_seed,
                        AREA,
                        pinned.clone(),
                        Some(adult2.served_keys()),
                        Some(links)
                    ),
                    is(GroupVerdict::RetiredKey, None)
                );
            }
        }
    }

    #[test]
    fn p2_a_planted_key_never_reads_retired_even_with_its_planter_s_link_chains_start_from_the_first_keys() {
        let organizer = Person::new(1);
        let adult = Person::at(2, 2);
        let insider = Person::new(3);
        let planted = Person::new(9);
        let (adult3, real) = adult.succeed();
        let own = owner(&organizer);
        let mut h = History::new();
        h.roster(
            &organizer,
            vec![own.clone(), adult.active(&[]), insider.active(&[GroupRole::Members])],
            None,
        );
        h.roster(
            &insider,
            vec![
                own.clone(),
                RosterMember { user_id: adult.user_id.clone(), ..planted.active(&[]) },
                insider.active(&[GroupRole::Members]),
            ],
            None,
        );
        h.roster(&organizer, vec![own, adult3.active(&[]), insider.active(&[GroupRole::Members])], None);
        let chain = accepted(accept(&h, &ml_dsa_keys(&[&organizer, &insider]), Over::default()));
        // The insider holds the planted keys, so can sign a "succession" from them to the adult's.
        let mut forged = SuccessionLink {
            old_key_version: 1,
            new_key_version: 2,
            old_encryption_public_key: planted.served().encryption_public_key,
            old_signing_public_key: planted.served().signing_public_key,
            old_ml_dsa_public_key: planted.served().ml_dsa_public_key,
            new_encryption_public_key: adult.served().encryption_public_key,
            new_signing_public_key: adult.served().signing_public_key,
            new_ml_dsa_public_key: adult.served().ml_dsa_public_key,
            new_kem_public_key: adult.served().kem_public_key,
            signature: String::new(),
            consent: None,
        };
        let statement =
            crate::signatures::succession_statement(adult.user_id.clone(), forged.clone()).unwrap();
        forged.signature =
            encode(&sign_hybrid(&planted.keys.signing_seed, &planted.keys.ml_dsa_seed, &statement).unwrap());
        let read = |pinned: Option<PinnedKeys>, links: Vec<SuccessionLink>, seed: &[u8]| {
            verdict_by(&chain, &adult3, seed, AREA, pinned, Some(adult3.served_keys()), Some(links))
        };
        let both = vec![forged, real.clone()];
        // Relying on the roster: chains start only from the adult's first keys, so the planted set
        // never starts one, link or no link.
        assert_eq!(
            read(None, both.clone(), &planted.keys.signing_seed),
            is(GroupVerdict::BadSignature, None)
        );
        assert_eq!(read(None, both.clone(), &adult.keys.signing_seed), is(GroupVerdict::RetiredKey, None));
        assert_eq!(read(None, vec![real], &planted.keys.signing_seed), is(GroupVerdict::BadSignature, None));
        // A personal pin retires only along the chain from itself: never the planted key.
        for pinned in [adult3.pinned(), adult.pinned()] {
            assert_eq!(
                read(Some(pinned), both.clone(), &planted.keys.signing_seed),
                is(GroupVerdict::BadSignature, None)
            );
        }
        // A pin at a newer identity: the earlier keys on the verified chain up to it are retired.
        assert_eq!(
            read(Some(adult3.pinned()), both.clone(), &adult.keys.signing_seed),
            is(GroupVerdict::RetiredKey, None)
        );
        assert_eq!(
            read(Some(adult.pinned()), both, &adult.keys.signing_seed),
            is(GroupVerdict::RetiredKey, None)
        );
    }

    #[test]
    fn a_removal_rotation_keeps_a_former_member_s_file_theirs_never_the_re_keyer_s() {
        let f = family();
        let chain = accepted(newcomer(&f, Over::default()));
        let trust_of = |who: &Person| {
            group_writer_trust(
                GROUP.into(),
                HashMap::from([(AREA.to_string(), 1)]),
                GroupReading::Accepted { chain: chain.clone() },
                AREA.into(),
                who.user_id.clone(),
                None,
                Some(who.served_keys()),
                Some(vec![]),
                None,
            )
        };
        let node = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
        let statement = MetadataStatement {
            workspace_id: AREA.into(),
            node_id: node.into(),
            kind: NodeKind::File,
            metadata_version: 1,
        };
        let ctx =
            crate::MetadataContext { workspace_id: AREA.into(), node_id: node.into(), metadata_version: 1 };
        let (old, fresh) = (vec![70u8; 32], vec![71u8; 32]);
        let origin = crate::metadata_seal(
            ctx.clone(),
            old.clone(),
            crate::NodeMetadata { name: "budget.ods".into(), mime: None, size: Some(9), modified: None },
        )
        .unwrap();
        // The holder wrote it before leaving; the organizer rotates the area after the removal.
        let written =
            metadata_sign(f.holder.keys.signing_seed.to_vec(), statement.clone(), origin.clone()).unwrap();
        let envelope = crate::metadata_rekey(ctx, old.clone(), fresh.clone(), origin.clone()).unwrap();
        let named = crate::RecordOrigin {
            envelope: origin.clone(),
            signer_id: f.holder.user_id.clone(),
            signature: written.clone(),
        };
        let record = RekeyedMetadata {
            statement: statement.clone(),
            key_epoch: 2,
            envelope: envelope.clone(),
            origin: crate::ServedOrigin {
                envelope: origin.clone(),
                signer_id: Some(f.holder.user_id.clone()),
                signature: Some(written),
                key_envelope: crate::origin_key_wrap(
                    crate::OriginKeyContext {
                        workspace_id: AREA.into(),
                        node_id: node.into(),
                        key_epoch: 2,
                        record: crate::OriginRecord::Metadata { metadata_version: 1 },
                        origin_envelope: origin.clone(),
                    },
                    fresh.clone(),
                    crate::origin_opening_key(origin, old).unwrap(),
                )
                .unwrap(),
            },
            rekey_signature: Some(
                crate::metadata_rekey_sign(
                    f.organizer.keys.signing_seed.to_vec(),
                    statement.clone(),
                    2,
                    envelope.clone(),
                    named,
                )
                .unwrap(),
            ),
        };
        let trust = GroupRekeyedTrust {
            origin: trust_of(&f.holder),
            origin_personal: None,
            rekeyer: trust_of(&f.organizer),
            rekeyer_personal: None,
        };
        assert_eq!(
            group_metadata_rekeyed_integrity(Some(fresh), trust.clone(), record.clone()),
            GroupRekeyedVerdict {
                origin: is(GroupVerdict::FormerMember, None),
                rekeyer: is(GroupVerdict::Verified, Some(GROUP)),
                mismatch: false,
            }
        );
        // The legacy form names only the organizer, who vouches for nothing: what readers saw before.
        let resealed = crate::metadata_resealed_sign(
            f.organizer.keys.signing_seed.to_vec(),
            statement.clone(),
            envelope.clone(),
        )
        .unwrap();
        assert_eq!(
            group_metadata_integrity(trust.rekeyer.clone(), None, statement, envelope, Some(resealed)),
            is(GroupVerdict::Resealed, None)
        );
        assert_eq!(
            group_metadata_rekeyed_integrity(None, trust, record).origin,
            is(GroupVerdict::Unchecked, None)
        );
    }

    #[test]
    fn a_former_member_is_marked_and_an_unloaded_roster_is_unchecked() {
        let f = family();
        let chain = accepted(newcomer(&f, Over::default()));
        assert_eq!(verdict(&chain, &f.holder, &f.holder), is(GroupVerdict::FormerMember, None));
        assert_eq!(
            verdict_by(
                &chain,
                &f.holder,
                &f.holder.keys.signing_seed,
                AREA,
                Some(f.holder.pinned()),
                None,
                None
            ),
            is(GroupVerdict::FormerMember, None)
        );
        let reading = |r: GroupReading| {
            group_writer_trust(
                GROUP.into(),
                HashMap::from([(AREA.to_string(), 1)]),
                r,
                AREA.into(),
                f.adult.user_id.clone(),
                None,
                None,
                None,
                None,
            )
        };
        assert!(matches!(reading(GroupReading::Unavailable), GroupWriterTrust::Unchecked));
        assert!(matches!(reading(GroupReading::Fork), GroupWriterTrust::Outside));
        // Another group's accepted chain says nothing about this one.
        let other = group_writer_trust(
            OTHER_GROUP.into(),
            HashMap::from([(AREA.to_string(), 1)]),
            GroupReading::Accepted { chain },
            AREA.into(),
            f.adult.user_id.clone(),
            None,
            None,
            None,
            None,
        );
        assert!(matches!(other, GroupWriterTrust::Unchecked));
    }

    #[test]
    fn p1_f3_an_earlier_key_reads_retired_only_along_the_member_s_own_chain_a_planted_key_never() {
        let (organizer, adult, outsider) = (Person::new(1), Person::new(2), Person::new(5));
        let (adult2, link) = adult.succeed();
        let keys = ml_dsa_keys(&[&organizer]);
        let mut h = History::new();
        h.roster(&organizer, vec![owner(&organizer), adult.active(&[])], None);
        h.roster(
            &organizer,
            vec![
                owner(&organizer),
                RosterMember { user_id: adult.user_id.clone(), key_version: 2, ..outsider.active(&[]) },
            ],
            None,
        );
        h.roster(&organizer, vec![owner(&organizer), adult2.active(&[])], None);
        let first = accepted_to(&h, 2, &keys);
        h.roster(&organizer, vec![owner(&organizer), adult2.active(&[GroupRole::Billing])], None);
        let chained = (Some(adult2.served_keys()), Some(vec![link]));
        for chain in [
            accepted(accept(&h, &keys, Over::default())),
            accepted(accept(
                &h,
                &keys,
                Over {
                    cache: Some(first.cache.clone()),
                    rosters: Some(h.rosters[2..].to_vec()),
                    ..Over::default()
                },
            )),
        ] {
            assert_eq!(
                chain.key_history[&adult.user_id]
                    .iter()
                    .map(|s| s.signing_public_key.clone())
                    .collect::<Vec<_>>(),
                vec![
                    adult.keys.signing_public_key.clone(),
                    outsider.keys.signing_public_key.clone(),
                    adult2.keys.signing_public_key.clone()
                ]
            );
            assert_eq!(
                verdict_by(
                    &chain,
                    &adult2,
                    &adult.keys.signing_seed,
                    AREA,
                    None,
                    chained.0.clone(),
                    chained.1.clone()
                ),
                is(GroupVerdict::RetiredKey, None)
            );
            assert_eq!(
                verdict_by(
                    &chain,
                    &adult2,
                    &outsider.keys.signing_seed,
                    AREA,
                    None,
                    chained.0.clone(),
                    chained.1.clone()
                ),
                is(GroupVerdict::BadSignature, None)
            );
            assert_eq!(
                verdict_by(
                    &chain,
                    &adult2,
                    &adult2.keys.signing_seed,
                    AREA,
                    None,
                    chained.0.clone(),
                    chained.1.clone()
                ),
                is(GroupVerdict::Verified, Some(GROUP))
            );
            assert_eq!(
                verdict_by(&chain, &adult2, &adult.keys.signing_seed, AREA, None, chained.0.clone(), None),
                is(GroupVerdict::Unchecked, None)
            );
        }
    }

    /* Chains across identity changes */

    #[test]
    fn a_members_holder_who_replaces_their_identity_keeps_signing_under_each_key_in_turn() {
        let (organizer, adult, holder) = (Person::new(1), Person::new(2), Person::new(3));
        let (organizer2, _) = organizer.succeed();
        let mut h = History::new();
        h.roster(&organizer, vec![owner(&organizer), holder.active(&[GroupRole::Members])], None);
        h.roster(
            &organizer,
            vec![owner(&organizer), holder.active(&[GroupRole::Members]), adult.active(&[])],
            None,
        );
        h.roster(
            &holder,
            vec![owner(&organizer2), holder.active(&[GroupRole::Members]), adult.active(&[])],
            None,
        );
        h.roster(
            &organizer2,
            vec![
                owner(&organizer2),
                holder.active(&[GroupRole::Members]),
                adult.active(&[GroupRole::Billing]),
            ],
            None,
        );
        assert_eq!(
            accepted(accept(&h, &ml_dsa_keys(&[&organizer, &organizer2, &holder]), Over::default()))
                .roster
                .roster_version,
            4
        );
        refused(
            accept(&h, &ml_dsa_keys(&[&organizer, &holder]), Over::default()),
            "not signed by the member it names",
        );
        refused(
            accept(&h, &ml_dsa_keys(&[&organizer2, &holder]), Over::default()),
            "not signed by the member it names",
        );
    }

    #[test]
    fn every_roster_whose_entry_for_the_reader_is_not_theirs_is_reported() {
        let (organizer, adult, outsider) = (Person::new(1), Person::new(2), Person::new(5));
        let (adult2, _) = adult.succeed();
        let mut h = History::new();
        h.roster(&organizer, vec![owner(&organizer), adult.active(&[])], None);
        h.roster(
            &organizer,
            vec![
                owner(&organizer),
                RosterMember { user_id: adult.user_id.clone(), key_version: 2, ..outsider.active(&[]) },
            ],
            None,
        );
        h.roster(&organizer, vec![owner(&organizer), adult2.active(&[])], None);
        let me = OwnIdentities {
            user_id: adult.user_id.clone(),
            identities: vec![adult.served_keys(), adult2.served_keys()],
        };
        let chain = accepted(accept(
            &h,
            &ml_dsa_keys(&[&organizer]),
            Over { me: Some(me.clone()), ..Over::default() },
        ));
        assert_eq!(chain.own_entry_wrong_at, vec![2]);
        // An entry moved back to an identity the reader has replaced: reported too, though it is theirs.
        h.roster(&organizer, vec![owner(&organizer), adult.active(&[])], None);
        h.roster(&organizer, vec![owner(&organizer), adult2.active(&[GroupRole::Billing])], None);
        let keys = ml_dsa_keys(&[&organizer]);
        assert_eq!(
            accepted(accept(&h, &keys, Over { me: Some(me.clone()), ..Over::default() })).own_entry_wrong_at,
            vec![2, 4]
        );
        let three = accepted_to(&h, 3, &keys);
        let cache = GroupChainCache { own_entry_wrong_at: vec![2], ..three.cache.clone() };
        assert_eq!(
            accepted(accept(
                &h,
                &keys,
                Over {
                    me: Some(me),
                    cache: Some(cache),
                    rosters: Some(h.rosters[3..].to_vec()),
                    ..Over::default()
                },
            ))
            .own_entry_wrong_at,
            vec![2, 4]
        );
    }

    /* What only accept_rosters makes */

    #[test]
    fn the_seals_and_signer_take_the_chain_accept_rosters_made() {
        // Across UniFFI the chain is an object without a constructor; in Rust its fields are the
        // crate's own. What the seal and signer functions get is the accepted chain.
        let f = family();
        let chain = accepted(newcomer(&f, Over::default()));
        let ctx = GroupKeySealContext {
            group_id: GROUP.into(),
            group_key_version: 1,
            holder_user_id: f.organizer.user_id.clone(),
            holder_key_version: 1,
            sealer_user_id: f.organizer.user_id.clone(),
            roster_version: chain.roster.roster_version,
            roster_digest: chain.roster_digest.clone(),
        };
        let envelope = group_key_seal(
            f.h.seeds[0].clone(),
            ctx.clone(),
            chain.clone(),
            f.organizer.kem(),
            f.organizer.keys.clone(),
        )
        .unwrap();
        assert_eq!(
            group_key_open(
                envelope,
                ctx,
                chain.clone(),
                f.organizer.ml_dsa(),
                None,
                f.organizer.user_id.clone(),
                f.organizer.keys.key_version,
                f.organizer.keys.clone()
            )
            .unwrap()
            .to_vec(),
            f.h.seeds[0]
        );
        assert!(roster_member_signer(chain, f.adult.user_id.clone(), f.adult.ml_dsa()).is_ok());
    }

    /* Round 8 */

    #[test]
    fn r8_opus_1_the_person_s_own_marks_disagreeing_are_the_warning_beside_malformed_or_foreign_served_statements(
    ) {
        let (organizer, adult) = (Person::new(1), Person::new(2));
        let mut h = History::new();
        h.roster(&organizer, vec![owner(&organizer), adult.active(&[])], None);
        h.roster(&organizer, vec![owner(&organizer), adult.active(&[GroupRole::Billing])], None);
        let keys = ml_dsa_keys(&[&organizer, &adult]);
        let pin2 = pin_of(&h, 2, &keys);
        let elsewhere = GroupPin { roster_digest: encode(&[9u8; 32]), ..pin2.clone() };
        let malformed = SignedGroupStatement { statement: b"[".to_vec(), ..h.rosters[0].clone() };
        let foreign = roster_sign(
            Roster { group_id: OTHER_GROUP.into(), ..h.statements[0].clone() },
            h.seeds[0].clone(),
            organizer.keys.clone(),
        )
        .unwrap();
        for extra in [malformed, foreign] {
            let mut rosters = h.rosters.clone();
            rosters.push(extra);
            let over = |pins: Vec<GroupPin>| Over { pins, rosters: Some(rosters.clone()), ..Over::default() };
            assert!(matches!(
                accept(&h, &keys, over(vec![pin2.clone(), elsewhere.clone()])),
                Ok(RosterChain::Fork { .. })
            ));
            // With the person's marks agreeing, the same junk is a plain refusal.
            assert!(accept(&h, &keys, over(vec![pin2.clone()])).is_err());
        }
    }

    #[test]
    fn r8_opus_5_a_succession_back_to_any_earlier_group_key_is_refused() {
        let (organizer, holder) = (Person::new(1), Person::new(3));
        let mut h = History::new();
        h.roster(&organizer, vec![owner(&organizer), holder.active(&[GroupRole::Members])], None);
        h.succession(&organizer);
        h.roster(&organizer, vec![owner(&organizer), holder.active(&[GroupRole::Members])], Some(2));
        let (first, second) = (h.key(1), h.key(2));
        let back = GroupKeySuccession {
            group_id: GROUP.into(),
            old_version: 2,
            new_version: 3,
            old_ed25519_public_key: second.ed25519_public_key,
            old_ml_dsa_public_key: second.ml_dsa_public_key,
            new_ed25519_public_key: first.ed25519_public_key,
            new_ml_dsa_public_key: first.ml_dsa_public_key,
            last_roster_version: 2,
            last_roster_digest: digest(&h.rosters[1].statement),
            signer_user_id: organizer.user_id.clone(),
        };
        let under_first = roster_sign(
            Roster {
                roster_version: 3,
                previous_roster_digest: digest(&h.rosters[1].statement),
                group_key_version: 3,
                ..h.statements[1].clone()
            },
            h.seeds[0].clone(),
            organizer.keys.clone(),
        )
        .unwrap();
        let mut rosters = h.rosters.clone();
        rosters.push(under_first);
        let mut successions = h.successions.clone();
        successions.push(signed_by(succession_bytes(&back).unwrap(), &h.seeds[1], Some(&organizer)));
        refused(
            accept(
                &h,
                &ml_dsa_keys(&[&organizer, &holder]),
                Over { rosters: Some(rosters), successions: Some(successions), ..Over::default() },
            ),
            "does not replace the key with a new one",
        );
    }

    #[test]
    fn r8_opus_3_a_rolled_back_served_identity_reads_unchecked_and_an_own_entry_moved_to_a_replaced_identity_is_noted(
    ) {
        let (organizer, adult) = (Person::new(1), Person::new(2));
        let (adult2, link) = adult.succeed();
        let (adult3, link23) = adult2.succeed();
        let mut h = History::new();
        h.roster(&organizer, vec![owner(&organizer), adult.active(&[])], None);
        let chain = accepted(accept(&h, &ml_dsa_keys(&[&organizer, &adult]), Over::default()));
        for by in [&adult2, &adult3] {
            assert_eq!(
                verdict_by(
                    &chain,
                    &adult,
                    &by.keys.signing_seed,
                    AREA,
                    None,
                    Some(adult2.served_keys()),
                    Some(vec![link.clone(), link23.clone()])
                ),
                is(GroupVerdict::Unchecked, None)
            );
        }
        let me = OwnIdentities {
            user_id: adult.user_id.clone(),
            identities: vec![adult.served_keys(), adult2.served_keys(), adult3.served_keys()],
        };
        let keys = ml_dsa_keys(&[&organizer, &adult, &adult2, &adult3]);
        let mut behind = History::new();
        behind.roster(&organizer, vec![owner(&organizer), adult3.active(&[])], None);
        behind.roster(&organizer, vec![owner(&organizer), adult2.active(&[])], None);
        let seen = accepted(accept(&behind, &keys, Over { me: Some(me.clone()), ..Over::default() }));
        assert_eq!(seen.own_entry_wrong_at, vec![2]);
        let mut forward = History::new();
        forward.roster(&organizer, vec![owner(&organizer), adult.active(&[])], None);
        forward.roster(&organizer, vec![owner(&organizer), adult2.active(&[])], None);
        let noted = accepted(accept(&forward, &keys, Over { me: Some(me.clone()), ..Over::default() }));
        assert!(noted.own_entry_wrong_at.is_empty());
        assert_eq!(noted.own_entry_behind_at(), vec![1, 2]);
        let two = OwnIdentities { identities: me.identities[..2].to_vec(), ..me };
        assert_eq!(
            accepted(accept(&forward, &keys, Over { me: Some(two), ..Over::default() })).own_entry_behind_at,
            vec![1]
        );
    }

    #[test]
    fn r8_opus_4_an_unsigned_served_key_version_never_turns_a_followed_succession_into_a_key_conflict() {
        let (organizer, adult) = (Person::new(1), Person::new(2));
        let (adult2, link) = adult.succeed();
        let mut h = History::new();
        h.roster(&organizer, vec![owner(&organizer), adult2.active(&[])], None);
        let chain = accepted(accept(&h, &ml_dsa_keys(&[&organizer, &adult2]), Over::default()));
        for key_version in [2, 3, 9] {
            assert_eq!(
                verdict_by(
                    &chain,
                    &adult,
                    &adult2.keys.signing_seed,
                    AREA,
                    Some(adult.pinned()),
                    Some(ServedKeys { key_version, ..adult2.served_keys() }),
                    Some(vec![link.clone()])
                ),
                is(GroupVerdict::Verified, Some(GROUP))
            );
        }
    }

    #[test]
    fn r10_fable_f3_the_join_mark_holds_the_chain_to_the_roster_that_admitted_the_newcomer_by_a_twelve_word_code(
    ) {
        let (organizer, adult, child) = (Person::new(1), Person::new(2), Person::new(4));
        let mut h = History::new();
        h.roster(&organizer, vec![owner(&organizer), adult.active(&[GroupRole::Members])], None);
        h.roster(
            &adult,
            vec![owner(&organizer), adult.active(&[GroupRole::Members]), child.active(&[])],
            None,
        );
        let keys = ml_dsa_keys(&[&organizer, &adult, &child]);
        let roster_digest = digest(&h.rosters[1].statement);
        let code = join_code(roster_digest.clone(), h.key(1), 1).unwrap();
        assert_eq!(code.len(), 12);
        let mark = JoinMark { roster_version: 2, code: code.clone() };
        let accept_with = |mark: JoinMark| {
            accept_rosters_joining(
                GROUP.into(),
                h.key(1),
                true,
                vec![],
                h.rosters.clone(),
                h.successions.clone(),
                keys.clone(),
                reader(),
                None,
                Some(mark),
            )
        };
        assert!(matches!(accept_with(mark.clone()), Ok(RosterChain::Accepted { .. })));
        // Another roster, another group key, another key version: each the warning, both sides named.
        let other_key = group_public_key(group_seed_at(7)).unwrap();
        for other in [
            join_code(digest(&h.rosters[0].statement), h.key(1), 1).unwrap(),
            join_code(roster_digest.clone(), other_key, 1).unwrap(),
            join_code(roster_digest.clone(), h.key(1), 2).unwrap(),
        ] {
            assert_ne!(other, code);
            match accept_with(JoinMark { code: other, ..mark.clone() }) {
                Ok(RosterChain::Fork { of: ForkOf::Roster, version: 2, sides }) => {
                    assert!(sides.iter().any(|s| s.from == vec![MarkSource::Join]));
                    assert!(sides.iter().any(|s| s.from == vec![MarkSource::Served]));
                }
                other => panic!("expected the warning, got {other:?}"),
            }
        }
        refused(accept_with(JoinMark { roster_version: 3, ..mark.clone() }), "older member list");
        let mut longer = code.clone();
        longer.push(code[0].clone());
        for bad in [code[..11].to_vec(), longer, code.iter().map(|w| w.to_uppercase()).collect()] {
            refused(accept_with(JoinMark { code: bad, ..mark.clone() }), "Invalid join mark");
        }
    }

    /* A link from `old`'s keys to `new`'s for `user_id`: the version 2 signature by `old`, and each consent half signed by its keys when asked, zeros when not. */
    fn link_from(
        old: &Person,
        new: &Person,
        user_id: &str,
        old_half: bool,
        new_half: bool,
    ) -> SuccessionLink {
        let (o, n) = (old.served(), new.served());
        let mut link = SuccessionLink {
            old_key_version: 1,
            new_key_version: 2,
            old_encryption_public_key: o.encryption_public_key,
            old_signing_public_key: o.signing_public_key,
            old_ml_dsa_public_key: o.ml_dsa_public_key,
            new_encryption_public_key: n.encryption_public_key,
            new_signing_public_key: n.signing_public_key,
            new_ml_dsa_public_key: n.ml_dsa_public_key,
            new_kem_public_key: n.kem_public_key,
            signature: String::new(),
            consent: None,
        };
        let v2 = crate::signatures::succession_statement(user_id.into(), link.clone()).unwrap();
        link.signature = encode(&sign_hybrid(&old.keys.signing_seed, &old.keys.ml_dsa_seed, &v2).unwrap());
        let half = |who: &Person, role, signs: bool| {
            if !signs {
                return vec![0u8; crate::identity::SUCCESSION_CONSENT_BYTES / 2];
            }
            let statement =
                crate::signatures::succession_consent_statement(user_id.into(), link.clone(), role).unwrap();
            sign_hybrid(&who.keys.signing_seed, &who.keys.ml_dsa_seed, &statement).unwrap()
        };
        let mut consent = half(old, crate::signatures::ConsentRole::Old, old_half);
        consent.extend(half(new, crate::signatures::ConsentRole::New, new_half));
        link.consent = Some(encode(&consent));
        link
    }

    /* Planted keys P as the adult's first entry, the adult's real keys R at 2, and two keys of the planter's own. */
    fn planted_first() -> (Arc<AcceptedRosters>, Person, Person, Person, Person, Person, Person) {
        let (organizer, adult, outsider) = (Person::new(1), Person::new(2), Person::new(5));
        let (planted, real, q, q2) = (Person::new(9), Person::at(2, 2), Person::new(10), Person::new(11));
        let own = organizer.entry(
            &[GroupRole::Billing, GroupRole::Guardian, GroupRole::Members],
            1,
            MemberStatus::Active,
        );
        let mut h = History::new();
        h.roster(
            &organizer,
            vec![own.clone(), RosterMember { user_id: adult.user_id.clone(), ..planted.active(&[]) }],
            None,
        );
        h.roster(
            &organizer,
            vec![own, RosterMember { user_id: adult.user_id.clone(), ..real.active(&[]) }],
            None,
        );
        let chain = accepted_of(&h, &[&organizer, &adult, &planted, &real]);
        (chain, adult, outsider, planted, real, q, q2)
    }

    #[test]
    fn r9_opus_2_a_planted_first_key_never_reads_retired_through_a_successor_its_planter_consented_to() {
        let (chain, adult, _, planted, real, q, _) = planted_first();
        let read = |served: ServedKeys, links: Vec<SuccessionLink>| {
            verdict_by(&chain, &adult, &planted.keys.signing_seed, AREA, None, Some(served), Some(links))
        };
        // P→Q, both halves the planter's, Q served: the first keys' chain never reaches the entry.
        let self_consented = link_from(&planted, &q, &adult.user_id, true, true);
        assert_eq!(read(q.served_keys(), vec![self_consented]), is(GroupVerdict::BadSignature, None));
        // The control: P→R with the adult's own consent reaches the entry, and P reads retired.
        let consented = link_from(&planted, &real, &adult.user_id, true, true);
        assert_eq!(read(real.served_keys(), vec![consented.clone()]), is(GroupVerdict::RetiredKey, None));
        // On the planter's half alone, or one-sided: no consent, no chain from the first keys.
        for link in [
            link_from(&planted, &real, &adult.user_id, true, false),
            SuccessionLink { consent: None, ..consented },
        ] {
            assert_eq!(read(real.served_keys(), vec![link]), is(GroupVerdict::BadSignature, None));
        }
    }

    #[test]
    fn r9_fable_c_two_links_leaving_the_first_keys_void_only_that_walk() {
        let (chain, adult, outsider, planted, real, q, q2) = planted_first();
        let links = vec![
            link_from(&planted, &q, &adult.user_id, true, true),
            link_from(&planted, &q2, &adult.user_id, true, true),
        ];
        let read = |signer: &Person, served: ServedKeys, links: Vec<SuccessionLink>| {
            verdict_by(&chain, &adult, &signer.keys.signing_seed, AREA, None, Some(served), Some(links))
        };
        assert_eq!(read(&real, real.served_keys(), links.clone()), is(GroupVerdict::Verified, Some(GROUP)));
        assert_eq!(read(&outsider, real.served_keys(), links), is(GroupVerdict::BadSignature, None));
        // The same fork at the entry's keys still makes the member unchecked.
        let (r2, to_r2) = real.succeed();
        let to_q2 = link_from(&real, &Person::at(12, 3), &adult.user_id, true, true);
        let to_q2 = SuccessionLink { old_key_version: 2, new_key_version: 3, ..to_q2 };
        let to_q2 = {
            let v2 = crate::signatures::succession_statement(adult.user_id.clone(), to_q2.clone()).unwrap();
            SuccessionLink {
                signature: encode(
                    &sign_hybrid(&real.keys.signing_seed, &real.keys.ml_dsa_seed, &v2).unwrap(),
                ),
                ..to_q2
            }
        };
        assert_eq!(read(&real, r2.served_keys(), vec![to_r2, to_q2]), is(GroupVerdict::Unchecked, None));
    }

    #[test]
    fn r9_opus_5_a_served_identity_that_is_the_walk_s_start_with_a_link_leaving_it_is_stale() {
        let adult = Person::new(2);
        let (adult2, link) = adult.succeed();
        let one_sided = SuccessionLink { consent: None, ..link };
        let walk = |served: ServedKeys, links: &[SuccessionLink]| {
            succession_path(&adult.user_id, &adult.pinned(), &served, links, &VerifiedLinks::new(), None, &[])
        };
        assert_eq!(walk(adult.served_keys(), std::slice::from_ref(&one_sided)), SuccessionPath::Stale);
        assert_eq!(walk(adult.served_keys(), &[]), SuccessionPath::None);
        assert_eq!(
            walk(adult2.served_keys(), std::slice::from_ref(&one_sided)),
            SuccessionPath::Path(vec![one_sided.clone()])
        );
    }

    #[test]
    fn r9_opus_3_consent_is_asked_only_before_the_entry_s_keys() {
        let adult = Person::new(2);
        let (adult2, link) = adult.succeed();
        let (adult3, second) = adult2.succeed();
        let strip = |l: &SuccessionLink| SuccessionLink { consent: None, ..l.clone() };
        let until = adult2.pinned();
        let walk = |links: Vec<SuccessionLink>, until: Option<&PinnedKeys>| {
            succession_path(
                &adult.user_id,
                &adult.pinned(),
                &adult3.served_keys(),
                &links,
                &VerifiedLinks::new(),
                until,
                &[],
            )
        };
        assert_eq!(walk(vec![strip(&link), strip(&second)], Some(&until)), SuccessionPath::None);
        assert_eq!(
            walk(vec![link.clone(), strip(&second)], Some(&until)),
            SuccessionPath::Path(vec![link.clone(), strip(&second)])
        );
        assert_eq!(
            walk(vec![strip(&link), strip(&second)], None),
            SuccessionPath::Path(vec![strip(&link), strip(&second)])
        );
        let junk = SuccessionLink { signature: encode(&[0u8; 3373]), ..link.clone() };
        assert_eq!(walk(vec![junk, strip(&second)], None), SuccessionPath::None);
    }

    #[test]
    fn r9_opus_8_more_than_64_links_are_checked_no_further_and_the_cache_tells_members_apart() {
        let (adult, outsider) = (Person::new(2), Person::new(5));
        let (adult2, link) = adult.succeed();
        let junk = SuccessionLink { signature: "AA".into(), ..link.clone() };
        let mut links = vec![link.clone()];
        links.extend(std::iter::repeat_n(junk.clone(), 63));
        let walk = |user_id: &str, links: &[SuccessionLink], verified: &VerifiedLinks| {
            succession_path(user_id, &adult.pinned(), &adult2.served_keys(), links, verified, None, &[])
        };
        assert_eq!(
            walk(&adult.user_id, &links, &VerifiedLinks::new()),
            SuccessionPath::Path(vec![link.clone()])
        );
        links.push(junk);
        assert_eq!(walk(&adult.user_id, &links, &VerifiedLinks::new()), SuccessionPath::TooMany);
        // One map across two members: the adult's link verified for the adult is nothing for another account.
        let verified = VerifiedLinks::new();
        assert!(matches!(
            walk(&adult.user_id, std::slice::from_ref(&link), &verified),
            SuccessionPath::Path(_)
        ));
        assert_eq!(walk(&outsider.user_id, std::slice::from_ref(&link), &verified), SuccessionPath::None);
    }

    #[test]
    fn r10_fable_6_only_links_from_the_member_s_own_key_sets_count_toward_the_cap() {
        let (adult, outsider) = (Person::new(2), Person::new(5));
        let (adult2, link) = adult.succeed();
        let (_, elsewhere) = outsider.succeed();
        // A hundred junk links from keys this member never held: never verified, never counted.
        let mut links: Vec<SuccessionLink> = (0..100u8)
            .map(|i| SuccessionLink { signature: encode(&[i; 3373]), ..elsewhere.clone() })
            .collect();
        links.push(link.clone());
        let walk = |links: &[SuccessionLink], member_keys: &[PinnedKeys]| {
            succession_path(
                &adult.user_id,
                &adult.pinned(),
                &adult2.served_keys(),
                links,
                &VerifiedLinks::new(),
                None,
                member_keys,
            )
        };
        assert_eq!(walk(&links, &[]), SuccessionPath::Path(vec![link.clone()]));
        // Once those keys are a key set the chain lists for the member, they count.
        assert_eq!(walk(&links, &[outsider.pinned()]), SuccessionPath::TooMany);
        let mut fewer = links[..63].to_vec();
        fewer.push(link.clone());
        assert_eq!(walk(&fewer, &[outsider.pinned()]), SuccessionPath::Path(vec![link]));
    }

    #[test]
    fn r10_fable_6_links_leaving_keys_the_walk_reaches_count_too() {
        let adult = Person::new(2);
        let (adult2, link) = adult.succeed();
        let (adult3, second) = adult2.succeed();
        let walk = |junk: u8| {
            let mut links = vec![link.clone(), second.clone()];
            links.extend(
                (1..=junk).map(|i| SuccessionLink { signature: encode(&[i; 3373]), ..second.clone() }),
            );
            succession_path(
                &adult.user_id,
                &adult.pinned(),
                &adult3.served_keys(),
                &links,
                &VerifiedLinks::new(),
                None,
                &[],
            )
        };
        // 1 from the start, then at adult2 the real link and 62 junk ones: 64 counted, walked.
        assert_eq!(walk(62), SuccessionPath::Path(vec![link.clone(), second.clone()]));
        // 64 junk ones leaving adult2's keys: 66 counted once the walk is there.
        assert_eq!(walk(64), SuccessionPath::TooMany);
    }

    #[test]
    fn r12_a_pin_carries_its_origin_a_group_trusted_pin_that_agrees_names_the_group_an_empty_origin_is_no_pin(
    ) {
        let f = family();
        let chain = accepted(newcomer(&f, Over::default()));
        let trust = |trusted_via: Option<String>| {
            group_writer_trust(
                GROUP.into(),
                HashMap::from([(AREA.to_string(), 1)]),
                GroupReading::Accepted { chain: chain.clone() },
                AREA.into(),
                f.adult.user_id.clone(),
                Some(WriterPin::of(f.adult.pinned(), trusted_via)),
                Some(f.adult.served_keys()),
                Some(vec![]),
                None,
            )
        };
        assert!(matches!(trust(None), GroupWriterTrust::Roster { via: None, .. }));
        assert!(
            matches!(trust(Some(GROUP.into())), GroupWriterTrust::Roster { via: Some(ref g), .. } if g == GROUP)
        );
        assert!(matches!(trust(Some(String::new())), GroupWriterTrust::Unchecked));
        // Admission refuses any origin, an empty one included.
        let pin = trust_as_group_does(chain.clone(), f.adult.user_id.clone(), f.adult.served()).unwrap();
        for trusted_via in [Some(GROUP.to_string()), Some(String::new())] {
            assert!(roster_entry_new(
                VerifiedPin { trusted_via, ..pin.clone() },
                f.adult.served(),
                vec![],
                9
            )
            .is_err());
        }
    }

    #[test]
    fn r11_opus_5_the_session_cache_keeps_at_most_4096_results_the_least_recently_used_dropped_first() {
        let adult = Person::new(2);
        let (adult2, link) = adult.succeed();
        let verified = VerifiedLinks::new();
        let dummy = |i: usize| {
            let mut key = [0xffu8; 32];
            key[..8].copy_from_slice(&(i as u64).to_be_bytes());
            key
        };
        for i in 0..crate::succession_path::MAX_VERIFIED_LINKS {
            verified.put(dummy(i), true);
        }
        assert_eq!(
            succession_path(
                &adult.user_id,
                &adult.pinned(),
                &adult2.served_keys(),
                std::slice::from_ref(&link),
                &verified,
                None,
                &[]
            ),
            SuccessionPath::Path(vec![link])
        );
        assert_eq!(verified.len(), crate::succession_path::MAX_VERIFIED_LINKS);
        assert!(!verified.contains(&dummy(0)));
        assert!(verified.contains(&dummy(crate::succession_path::MAX_VERIFIED_LINKS - 1)));
    }

    #[test]
    fn r11_too_many_links_on_a_pinned_reader_s_walk_read_as_links_that_did_not_load() {
        let f = family();
        let chain = accepted(newcomer(&f, Over::default()));
        let (adult2, link) = f.adult.succeed();
        let one_sided = SuccessionLink { consent: None, ..link.clone() };
        let mut links = vec![link];
        links.extend((0..64u64).map(|i| SuccessionLink {
            signature: encode(&[0; 3373]),
            new_key_version: i + 2,
            ..one_sided.clone()
        }));
        let trust = group_writer_trust(
            GROUP.into(),
            HashMap::from([(AREA.to_string(), 1)]),
            GroupReading::Accepted { chain },
            AREA.into(),
            f.adult.user_id.clone(),
            Some(f.adult.pinned()).map(|keys| WriterPin::of(keys, None)),
            Some(adult2.served_keys()),
            Some(links),
            None,
        );
        // The pin agrees with the entry: the roster's word, the entry's key current, nothing
        // followed or retired, and the links counted as not loaded.
        match trust {
            GroupWriterTrust::Roster { signer, via: None, followed: None, links_loaded: false } => {
                assert!(signer.retired.is_empty());
            }
            other => panic!("expected the roster's word with links not loaded, got {other:?}"),
        }
    }

    #[test]
    fn r10_fable_6_a_session_s_verification_cache_carries_across_verdicts_and_holds_only_what_it_verified() {
        let f = family();
        let chain = accepted(newcomer(&f, Over::default()));
        let (adult2, link) = f.adult.succeed();
        let cache = SuccessionCache::new();
        let statement = MetadataStatement {
            workspace_id: AREA.into(),
            node_id: "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e".into(),
            kind: NodeKind::File,
            metadata_version: 1,
        };
        let envelope = vec![5u8; 96];
        let signature =
            metadata_sign(adult2.keys.signing_seed.to_vec(), statement.clone(), envelope.clone()).unwrap();
        let verdict = |links: Vec<SuccessionLink>| {
            let trust = group_writer_trust(
                GROUP.into(),
                HashMap::from([(AREA.to_string(), 1)]),
                GroupReading::Accepted { chain: chain.clone() },
                AREA.into(),
                f.adult.user_id.clone(),
                None,
                Some(adult2.served_keys()),
                Some(links),
                Some(cache.clone()),
            );
            group_metadata_integrity(
                trust,
                None,
                statement.clone(),
                envelope.clone(),
                Some(signature.clone()),
            )
        };
        assert_eq!(verdict(vec![link.clone()]), is(GroupVerdict::Verified, Some(GROUP)));
        let size = cache.verified.len();
        assert!(size > 0);
        // The same verdict again verifies nothing new.
        assert_eq!(verdict(vec![link.clone()]), is(GroupVerdict::Verified, Some(GROUP)));
        assert_eq!(cache.verified.len(), size);
        // A forged copy of the link it holds is its own entry, and refused.
        let forged = SuccessionLink {
            signature: encode(&vec![0u8; decode("s", &link.signature, None).unwrap().len()]),
            consent: Some(encode(&[0u8; 2 * 3373])),
            ..link
        };
        assert_eq!(verdict(vec![forged]), is(GroupVerdict::BadSignature, None));
    }

    #[test]
    fn r9_opus_1_a_cache_whose_area_keys_do_not_match_its_last_roster_is_refused() {
        let (organizer, adult) = (Person::new(1), Person::new(2));
        let own = organizer.entry(
            &[GroupRole::Billing, GroupRole::Guardian, GroupRole::Members],
            1,
            MemberStatus::Active,
        );
        let mut h = History::new();
        h.roster(&organizer, vec![own, adult.active(&[])], None);
        let keys = ml_dsa_keys(&[&organizer, &adult]);
        let chain = accepted_of(&h, &[&organizer, &adult]);
        let accept = |cache: GroupChainCache| {
            accept_rosters(
                GROUP.into(),
                h.key(1),
                true,
                vec![],
                vec![],
                vec![],
                keys.clone(),
                reader(),
                Some(cache),
            )
        };
        assert!(matches!(accept(chain.cache.clone()), Ok(RosterChain::Accepted { .. })));
        let listed = chain.cache.area_keys[AREA][0].clone();
        let other = encode(&[3u8; 32]);
        for area_keys in [
            HashMap::new(),
            HashMap::from([(AREA.to_string(), vec![other.clone()])]),
            HashMap::from([(AREA.to_string(), vec![listed.clone(), other.clone()])]),
            HashMap::from([
                (AREA.to_string(), vec![listed.clone()]),
                (OTHER_AREA.to_string(), vec![other.clone()]),
            ]),
        ] {
            refused(
                accept(GroupChainCache { area_keys, ..chain.cache.clone() }),
                "Invalid member list cache",
            );
        }
    }

    #[test]
    fn r9_codex_2_links_whose_fields_join_alike_are_remembered_apart() {
        let adult = Person::new(2);
        let (adult2, link) = adult.succeed();
        // The first's signature "x|y", the second's KEM key ending "|x" with signature "y", both with the first's consent.
        let links = vec![
            SuccessionLink { signature: "x|y".into(), ..link.clone() },
            SuccessionLink {
                new_kem_public_key: format!("{}|x", link.new_kem_public_key),
                signature: "y".into(),
                ..link.clone()
            },
        ];
        let path = succession_path(
            &adult.user_id,
            &adult.pinned(),
            &adult2.served_keys(),
            &links,
            &VerifiedLinks::new(),
            Some(&adult2.pinned()),
            &[],
        );
        assert_eq!(path, SuccessionPath::Path(vec![links[0].clone()]));
    }

    /* Milestone 1c: creating a group */

    /* Another workspace id, sorting after AREA. */
    const SECOND_AREA: &str = "a0558a81-8dfc-4914-8447-0417b55e2ec5";

    /* The creator accepting their own group: they made the keys, so the first keys are checked. */
    fn creator_accepts(creator: &Person, rosters: Vec<SignedGroupStatement>) -> CoreResult<RosterChain> {
        accept_rosters(
            GROUP.into(),
            group_public_key(group_seed_at(1)).unwrap(),
            true,
            vec![],
            rosters,
            vec![],
            ml_dsa_keys(&[creator]),
            OwnIdentities { user_id: creator.user_id.clone(), identities: vec![creator.served_keys()] },
            None,
        )
    }

    fn area_key(workspace_id: &str, key: Vec<u8>) -> crate::groups::AreaKey {
        crate::groups::AreaKey { workspace_id: workspace_id.into(), workspace_key: key }
    }

    #[test]
    fn roster_first_builds_the_roster_1_the_creator_s_own_acceptance_takes_with_the_rows_of_its_keys() {
        let organizer = Person::new(1);
        let roles = vec![GroupRole::Members, GroupRole::Billing];
        let entry = roster_entry_own(organizer.user_id.clone(), organizer.served(), roles.clone()).unwrap();
        // The test person's entry is built from their keys by another path.
        assert_eq!(entry, organizer.active(&[GroupRole::Billing, GroupRole::Members]));
        let roster = roster_first(
            GROUP.into(),
            GroupKind::Family,
            RosterMember { roles, since_version: 7, ..entry },
            Some(vec![area_key(AREA, AREA_KEY.to_vec())]),
        )
        .unwrap();
        // Byte for byte what the test history writes for the same creator and area.
        let mut h = History::new();
        h.roster(&organizer, vec![organizer.active(&[GroupRole::Billing, GroupRole::Members])], None);
        assert_eq!(roster_bytes(&roster).unwrap(), h.rosters[0].statement);

        let signed = roster_sign(roster.clone(), group_seed_at(1), organizer.keys.clone()).unwrap();
        let chain = accepted(creator_accepts(&organizer, vec![signed]));
        assert_eq!(chain.roster, roster);
        assert_eq!(chain.creator_user_id, organizer.user_id);
        assert!(chain.own_entry_wrong_at.is_empty());
        assert_eq!(crate::groups::area_write_version(chain.clone(), AREA.into()), Some(1));
        // The row commits to the key given: a grant of it seals and opens through the chain, and no
        // other key seals under that version.
        let ctx = crate::groups::AreaGrantContext {
            group_id: GROUP.into(),
            workspace_id: AREA.into(),
            workspace_key_version: 1,
            grantee_user_id: organizer.user_id.clone(),
            grantee_key_version: 1,
            granter_user_id: organizer.user_id.clone(),
            roster_version: 1,
            roster_digest: chain.roster_digest.clone(),
        };
        let seal = |key: Vec<u8>| {
            crate::groups::area_grant_seal(
                key,
                ctx.clone(),
                chain.clone(),
                AREA_SEED.into(),
                organizer.kem(),
                organizer.keys.clone(),
            )
        };
        let opened = crate::groups::area_grant_open(
            seal(AREA_KEY.to_vec()).unwrap(),
            ctx.clone(),
            chain.clone(),
            AREA_SEED.into(),
            organizer.ml_dsa(),
            None,
            organizer.user_id.clone(),
            1,
            organizer.keys.clone(),
        )
        .unwrap();
        assert_eq!(opened, AREA_KEY.to_vec());
        assert!(seal(vec![78; 32]).unwrap_err().to_string().contains("not the one the group’s member list"));
    }

    #[test]
    fn roster_first_sorts_the_rows_takes_no_areas_and_builds_a_company_s_first_roster() {
        let organizer = Person::new(1);
        let members = organizer.active(&[GroupRole::Members]);
        let roster = roster_first(
            GROUP.into(),
            GroupKind::Family,
            members.clone(),
            Some(vec![area_key(SECOND_AREA, vec![101; 32]), area_key(AREA, AREA_KEY.to_vec())]),
        )
        .unwrap();
        let ids: Vec<_> =
            roster.areas.iter().map(|row| (row.workspace_id.as_str(), row.workspace_key_version)).collect();
        assert_eq!(ids, [(AREA, 1), (SECOND_AREA, 1)]);
        assert_eq!(roster.areas[0].commitment, crate::groups::area_key_commitment(&AREA_KEY).unwrap());
        assert!(roster_first(GROUP.into(), GroupKind::Family, members, None).unwrap().areas.is_empty());
        let org = roster_first(
            GROUP.into(),
            GroupKind::Org,
            organizer.active(&[GroupRole::DataAdmin, GroupRole::Members]),
            None,
        )
        .unwrap();
        let signed = roster_sign(org, group_seed_at(1), organizer.keys.clone()).unwrap();
        assert_eq!(accepted(creator_accepts(&organizer, vec![signed])).kind, GroupKind::Org);
    }

    #[test]
    fn roster_first_refuses_each_first_roster_acceptance_refuses_and_acceptance_refuses_it_signed_by_hand() {
        let organizer = Person::new(1);
        let row = |workspace_id: &str, key: u8| crate::groups::RosterArea {
            workspace_id: workspace_id.into(),
            workspace_key_version: 1,
            commitment: crate::groups::area_key_commitment(&[key; 32]).unwrap(),
        };
        // Each with its creator and area keys, what roster_first says, then what acceptance says of
        // the same roster.
        type Refusal = (&'static str, RosterMember, Vec<(&'static str, u8)>, &'static str, &'static str);
        let refusals: Vec<Refusal> = vec![
            (
                "not a holder",
                organizer.active(&[GroupRole::Billing]),
                vec![(AREA, 77)],
                "holds the group key",
                "holds the group key",
            ),
            (
                "left",
                organizer.entry(&[GroupRole::Members], 1, MemberStatus::Left),
                vec![],
                "holds the group key",
                "holds the group key",
            ),
            (
                "one key for two areas",
                organizer.active(&[GroupRole::Members]),
                vec![(AREA, 77), (SECOND_AREA, 77)],
                "earlier keys",
                "was used before",
            ),
        ];
        for (name, creator, keys, message, accepting) in refusals {
            let area_keys = keys.iter().map(|(id, key)| area_key(id, vec![*key; 32])).collect();
            let error =
                roster_first(GROUP.into(), GroupKind::Family, creator.clone(), Some(area_keys)).unwrap_err();
            assert!(error.to_string().contains(message), "{name}: {error}");
            // The same roster, signed as a client that skipped the checks would sign it.
            let mut h = History::new();
            h.roster_with(
                &organizer,
                vec![creator],
                None,
                Some(keys.iter().map(|(id, key)| row(id, *key)).collect()),
            );
            match creator_accepts(&organizer, h.rosters.clone()) {
                Err(error) => assert!(error.to_string().contains(accepting), "{name}: {error}"),
                other => panic!("{name}: acceptance took it: {other:?}"),
            }
        }
        // What the statement itself cannot carry: an area named twice, a company role in a family,
        // a key of the wrong length, a group id outside the canonical form.
        let members = organizer.active(&[GroupRole::Members]);
        let twice = vec![area_key(AREA, AREA_KEY.to_vec()), area_key(AREA, vec![78; 32])];
        assert!(roster_first(GROUP.into(), GroupKind::Family, members.clone(), Some(twice)).is_err());
        let company = organizer.active(&[GroupRole::DataAdmin, GroupRole::Members]);
        assert!(roster_first(GROUP.into(), GroupKind::Family, company, None).is_err());
        let short = vec![area_key(AREA, vec![77; 31])];
        assert!(roster_first(GROUP.into(), GroupKind::Family, members.clone(), Some(short)).is_err());
        assert!(roster_first(GROUP.to_uppercase(), GroupKind::Family, members, None).is_err());
    }

    #[test]
    fn roster_entry_own_takes_only_an_identity_whose_keys_statement_holds_for_this_account() {
        let (organizer, adult) = (Person::new(1), Person::new(2));
        let roles = vec![GroupRole::Members, GroupRole::Billing];
        assert_eq!(
            roster_entry_own(organizer.user_id.clone(), organizer.served(), roles.clone()).unwrap(),
            organizer.entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active)
        );
        let (adult2, _) = adult.succeed();
        assert_eq!(
            roster_entry_own(adult2.user_id.clone(), adult2.served(), roles.clone()).unwrap(),
            adult2.entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active)
        );
        let refusals = [
            // The organizer's identity claimed for another account.
            (adult.user_id.clone(), organizer.served()),
            // Another KEM key the keys statement never named.
            (
                organizer.user_id.clone(),
                PublicIdentity { kem_public_key: adult.served().kem_public_key, ..organizer.served() },
            ),
            // Another identity's keys statement.
            (
                organizer.user_id.clone(),
                PublicIdentity { keys_signature: adult.served().keys_signature, ..organizer.served() },
            ),
            // A key version the keys statement never named.
            (organizer.user_id.clone(), PublicIdentity { key_version: 2, ..organizer.served() }),
        ];
        for (user_id, identity) in refusals {
            let error = roster_entry_own(user_id, identity, roles.clone()).unwrap_err();
            assert_eq!(error.to_string(), "These are not this account’s keys.");
        }
        // An earlier identity's keys statement holds too; the creator signs with their current
        // keys, so a first roster naming the earlier ones is one no device takes.
        let earlier = roster_entry_own(adult.user_id.clone(), adult.served(), roles).unwrap();
        let roster = roster_first(GROUP.into(), GroupKind::Family, earlier, None).unwrap();
        let signed = roster_sign(roster, group_seed_at(1), adult2.keys.clone()).unwrap();
        let chain = accept_rosters(
            GROUP.into(),
            group_public_key(group_seed_at(1)).unwrap(),
            true,
            vec![],
            vec![signed],
            vec![],
            ml_dsa_keys(&[&adult, &adult2]),
            OwnIdentities { user_id: adult2.user_id.clone(), identities: vec![adult2.served_keys()] },
            None,
        );
        refused(chain, "not signed by the member it names");
    }
}
