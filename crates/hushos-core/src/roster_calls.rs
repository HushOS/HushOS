//! The roster calls a family manager sends from a phone (groups 1d, Core 5a:
//! docs/groups-mobile-plan.md), the twin of the worker's `groupStage` for the
//! admission and role changes, `groupOpenSeal`, `groupJoinCode`
//! (`packages/crypto/src/session-groups.ts`), and of the outbox's reading and
//! answer table (`packages/crypto/src/outbox.ts`, which
//! `apps/web/src/lib/groups/outbox.ts` drives).
//!
//! - A call is built on the family's committed chain only (the one
//!   [`AreaLedger::accept_served`] committed from what the server served),
//!   signed once with the group key's seed this device opened
//!   ([`AreaLedger::open_group_key`]) and the account's open identity, and
//!   accepted as a **staged chain**: acceptance itself, continuing the
//!   committed chain's cache with the call's own roster (and succession), so
//!   only a roster every device holding the chain would take is ever sent.
//!   The staged chain seals and grants for that call, and nothing else: it is
//!   never committed, never cached, never a mark, never handed to the app.
//! - Every key the call needs is the ledger's: the seed, the areas' keys at
//!   their write version and their id seeds (as [`AreaLedger::open_area`]
//!   holds them), the identity's private halves (opened from the envelope
//!   under the account root [`AreaLedger::open_account`] holds). No key
//!   crosses the FFI.
//! - The result is a [`StagedCall`]: the JSON body to send, and the outbox
//!   entry sealed under the device store key, which the app keeps **before**
//!   the first send and sends again, byte for byte, until a definite answer
//!   (F7: [`outbox_step`]). [`AreaLedger::outbox_open`] reads it back after a
//!   lock or a relaunch.
//!
//! Not here (Core 5b): removal, a folder's key replacement, a folder's
//! deletion, the previous-root repair, and the staged chain they keep per
//! call to judge their rotations.

use crate::area_ledger::{AreaLedger, CallState, HeldArea, NOT_THIS_ACCOUNT, NO_ACCOUNT, NO_CHAIN};
use crate::bytes::{decode, encode, random};
use crate::canonical::uuid;
use crate::consent::{served_keys_of, NOT_OWN_IDENTITY};
use crate::contacts::same_key_digest;
use crate::device_record::{open_bytes, seal_bytes, OPEN_IDENTITY, RECORD_UNREADABLE};
use crate::error::{input, CoreError, CoreResult};
use crate::group_trust::{
    accept_rosters, roster_entry_new, roster_next, AcceptedRosters, OwnIdentities, RosterChain,
};
use crate::groups::{
    area_grant_seal, group_key_open, group_key_seal, group_public_key, group_succession_sign, parse_roster,
    roster_digest, roster_sign, AreaGrantContext, GroupKeySealContext, GroupKeySuccession, GroupRole,
    RosterMember, SignedGroupStatement, SignerHistory,
};
use crate::identity::{identity_open, IdentityEnvelope, IdentityKeys, PublicIdentity, ServedKeys};
use crate::join::{admitted_at, code_at};
use crate::ledger_settings::ContactPin;
use crate::signatures::digest as sha256_base64url;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Arc;
use zeroize::Zeroizing;

/* The worker's words for RosterCall::OpenFoldersFirst (unreachable here: stage answers it first). */
const NOT_OPENED: &str = "Open every family folder first.";
/// A role change that would leave nobody active holding `billing`.
pub const ORGANIZER_FIRST: &str = "Make someone else the organizer first.";
/// Someone without `members` asked for a roster call: nothing is signed.
pub const NOT_MANAGER: &str = "Only someone who manages the family can change its members.";
/// An admission for someone this account holds no contact pin of (their words never checked).
pub const NOT_CHECKED: &str = "Check their words first.";
/// An admission naming a role: everyone is let in as a plain member, since the roles an
/// invitation carries are the server's word; a role is a role change afterwards, by a manager
/// who chose it (docs/optional-verification.md 3.2, 3.6). The worker's `groupStage` twin.
pub const ADMIT_AS_MEMBER: &str = "Let them in first. Roles are given afterwards.";
/// A role change that changes nothing (a grant to a holder, a take from a non-holder).
pub const UNCHANGED: &str = "That doesn’t change their roles.";
/// Taking `members` from oneself: the succession must be signed by someone who keeps it.
pub const SELF_TAKE: &str = "Ask another manager to take this role from you.";
const ALREADY_IN: &str = "This person is in the family already.";
const NOT_THE_PINNED_KEYS: &str = "These are not the keys whose words were checked.";
const NOT_IN: &str = "This person is not in the family now.";
const KEYS_MISSING: &str = "HushOS couldn’t load everyone’s keys. Try again.";
const ONE_AT_A_TIME: &str = "Give one person the role at a time.";
const NOT_FOLLOWING: &str = "This change does not follow the family’s member list.";
const KEY_NOT_TAKEN: &str = "The family’s new key would not be taken.";
const SUCCESSION_WITH_IT: &str = "The family’s key must be replaced in the same change.";
const STALE_ENTRY: &str =
    "Your entry on the family’s member list is not your current keys. Fold in your new keys first.";
const NOT_ACTIVE: &str = "Areas are granted only to active members.";
/// An outbox entry that opened but is not one (the web's `isEntry` refuses it, and deletes it).
const NOT_AN_ENTRY: &str = "This saved change can’t be read on this device.";
/// `outbox_open` for another account than the one unlocked: an app's mistake, never a deletion.
const OTHER_ACCOUNT: &str = "This saved change belongs to another account.";
/* The roster format this core writes, as the worker's ROSTER_FORMAT (docs/groups-design.md 2.10). */
const ROSTER_FORMAT: u8 = 2;
const OUTBOX: &str = "outbox";
/* Route 22's cap on grants in one call (MAX_GRANTS_PER_CALL in @hushos/groups/protocol). */
const MAX_GRANTS_PER_CALL: usize = 256;

/* Types ------------------------------------------------------------------- */

/// A group key seal as route 8 serves it to this account.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ServedKeySeal {
    pub group_key_version: u64,
    pub holder_key_version: u64,
    pub sealer_user_id: String,
    pub roster_version: u64,
    pub roster_digest: String,
    pub envelope: Vec<u8>,
}

/// Where a roster call goes (the web's `ChainRoute`): route 1 (`Create`), 7
/// (`Rosters`), 17 (`Admit`), 18 (`Member`), 19 (`Remove`), 21 (`Areas`), 24
/// (`Rotation`) and 30 (`Delete`). This core builds `Admit` and `Member`;
/// every route reads back from an outbox entry.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ChainRoute {
    Create,
    Rosters,
    Admit { user_id: String },
    Member { user_id: String },
    Remove { user_id: String },
    Areas,
    Rotation { workspace_id: String },
    Delete { workspace_id: String },
}

/// A signed roster call: `body`, the JSON to send to `route`, and `entry`,
/// the outbox entry sealed under the device store key. Keep `entry` (by
/// `outbox_id`) before the first send; send `body` again, unchanged, after
/// any answer [`outbox_step`] calls `Resend`; drop the entry on a definite one.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct StagedCall {
    pub outbox_id: String,
    pub route: ChainRoute,
    pub body: String,
    pub entry: String,
}

/// What a roster call builder answers: the signed call, or what this device
/// must do first (then build it again). Refusals the person reads (someone
/// already in, keys not checked, the last organizer) are errors.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum RosterCall {
    /// Keep `call.entry`, then send `call.body`.
    Staged { call: StagedCall },
    /// No member list is committed for the family here, or another was
    /// committed while this was signed: sync the family, then build it again.
    SyncFirst,
    /// The family's group key is not open here: fetch route 8, open it with
    /// [`AreaLedger::open_group_key`], then build it again.
    OpenKeyFirst,
    /// A live family folder is not open here (an admission grants each one's
    /// key): open them with [`AreaLedger::open_area`], then build it again.
    OpenFoldersFirst,
}

/// Granting or taking away `members` ([`AreaLedger::roles_body`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum MembersRole {
    /// The current group key is sealed to them in the same call.
    Grant,
    /// The group key is replaced in the same call (a succession), and the new
    /// one sealed to every holder who remains.
    Take,
}

/// One of the organizer handover's two calls ([`AreaLedger::handover_body`]),
/// as the web hands over: first `billing` to another active member, then,
/// once that landed and the family was synced, the caller lets go of it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum Handover {
    To { user_id: String },
    StepDown,
}

/// The join code an admin reads out to someone they let in
/// ([`AreaLedger::member_join_code`]).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum MemberJoinCode {
    /// Their entry on the roster that let them in names exactly the keys of
    /// the admin's contact pin of them: read these twelve words out.
    Code { roster_version: u64, code: Vec<String> },
    /// They were let in at `roster_version` with other keys than the admin's
    /// pin of them holds (someone else let them in, or their account changed):
    /// no code is given; check their words again.
    OtherKeys { roster_version: u64 },
    /// The committed chain has no active entry for them at its head: sync
    /// once more (the admission may have landed since), then say not yet.
    NotAdmitted,
    /// No member list is committed for the family here: sync it, then ask again.
    SyncFirst,
    /// The settings this account opened hold no contact pin of them (their
    /// words never checked here): no code; check their words first.
    NotPinned,
}

/// Why an outbox entry is kept but not sent ([`OutboxCall::Hold`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum OutboxHold {
    /// An earlier web version's admission held back until its join code was
    /// typed: never sent; drop it, and let the person in again.
    AwaitingCheck,
    /// An admission sealed to other keys than the admin's pin of the person
    /// holds now (or with no pin given): never sent; the admin drops it
    /// knowingly, then lets them in again over their checked keys.
    OtherKeys,
    /// A creation the server stored whose first acceptance has not written
    /// the record and the pin yet (the web's `committed`; creations are not
    /// this core's yet).
    Committed,
}

/// An outbox entry read back ([`AreaLedger::outbox_open`]).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum OutboxCall {
    /// Send `body` to `route`: the very bytes the call was signed as.
    Send { outbox_id: String, route: ChainRoute, body: String },
    /// Kept, never sent (no body: nothing to send).
    Hold { outbox_id: String, route: ChainRoute, reason: OutboxHold },
    /// The family's committed chain already holds the call's roster: it
    /// landed (this device's earlier send, or a resend another answered).
    /// Drop the entry; nothing is sent.
    Landed { outbox_id: String, route: ChainRoute },
    /// The committed chain moved off the roster the call was built on without
    /// it: it can never land. Drop the entry, and build it again over the new
    /// head only if it still applies.
    Superseded { outbox_id: String, route: ChainRoute },
}

/// A grant owed on the committed chain, as route 3's `due.grants` or a 409
/// `grants-due`'s `missing` names it, with the grantee's ML-KEM key as route
/// 6 serves it (checked against their entry when sealed).
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct OwedGrant {
    pub workspace_id: String,
    pub user_id: String,
    pub kem_public_key: String,
}

/// Route 22's body for one family folder: post `body` to
/// `/groups/:id/areas/:workspace_id/grants`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct GrantsRequest {
    pub workspace_id: String,
    pub body: String,
}

/// What [`AreaLedger::grants_body`] answers.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum GrantsCall {
    /// Post each request in order, then send the kept call that met
    /// `grants-due` again, byte for byte.
    Grants { requests: Vec<GrantsRequest> },
    /// No member list is committed for the family here, or another was
    /// committed while these were sealed: sync, then ask again.
    SyncFirst,
    /// A folder named is not open here: open it, then ask again.
    OpenFoldersFirst,
}

/// What one answer to a roster call means for its outbox entry (F7; the
/// worker's outbox table in `packages/crypto/src/outbox.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum OutboxStep {
    /// 2xx, a replay of a stored call included: drop the entry, then sync.
    Landed,
    /// No definite answer (no answer, a 5xx, a 4xx without a code, any 4xx
    /// `signed-out` or `rate-limited`): keep the entry, send the same bytes
    /// again. A 4xx with any other code is a refusal, whatever its status.
    Resend,
    /// 409 `grants-due`: send the grants route 22 asks for, then the same bytes.
    SendGrants,
    /// 409 `rotating`, `epoch-stale`, `root-moved`, `document-stale`: rebuild
    /// the call's rotations with the same roster (Core 5b), then send again.
    Rebuild,
    /// 409 `stale`: another roster won at that version. Drop it, sync, and
    /// build it again over the winner only if it still applies.
    Stale,
    /// 409 `members-changed` or `left-due`: drop it, never resend; sync and
    /// build again (after marking the departed left, for `left-due`).
    MembershipMoved,
    /// Any other refusal with a code: final for these bytes. Drop it, and say
    /// the server's sentence; sync after `forbidden`.
    Refused,
    /// 404 `not-member`: the only answer that wipes the family from this device.
    Wiped,
}

/* The answer table --------------------------------------------------------- */

/// What an answer to a roster call means (F7, docs/groups-server.md 6):
/// `status` is the HTTP status (0 when no answer came back), `code` the
/// refusal's code when the server gave one. Only a definite answer moves an
/// entry on; everything else is [`OutboxStep::Resend`] of the same bytes.
///
/// ```
/// use hushos_core::{outbox_step, OutboxStep};
/// assert_eq!(outbox_step(201, None), OutboxStep::Landed);
/// assert_eq!(outbox_step(0, None), OutboxStep::Resend);
/// assert_eq!(outbox_step(503, Some("unavailable".into())), OutboxStep::Resend);
/// assert_eq!(outbox_step(429, Some("rate-limited".into())), OutboxStep::Resend);
/// assert_eq!(outbox_step(409, Some("stale".into())), OutboxStep::Stale);
/// assert_eq!(outbox_step(409, Some("grants-due".into())), OutboxStep::SendGrants);
/// assert_eq!(outbox_step(404, Some("not-member".into())), OutboxStep::Wiped);
/// // A 404 that is not `not-member` never wipes anything: final for these bytes.
/// assert_eq!(outbox_step(404, Some("not-found".into())), OutboxStep::Refused);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn outbox_step(status: u16, code: Option<String>) -> OutboxStep {
    if (200..300).contains(&status) {
        return OutboxStep::Landed;
    }
    let code = code.as_deref();
    if status == 404 && code == Some("not-member") {
        return OutboxStep::Wiped;
    }
    // A refusal: a 4xx with a code, but not the session's or the rate limiter's.
    let refusal = (400..500).contains(&status) && !matches!(code, None | Some("signed-out" | "rate-limited"));
    if !refusal {
        return OutboxStep::Resend;
    }
    match code.unwrap_or_default() {
        "grants-due" => OutboxStep::SendGrants,
        "rotating" | "epoch-stale" | "root-moved" | "document-stale" => OutboxStep::Rebuild,
        "stale" => OutboxStep::Stale,
        "members-changed" | "left-due" => OutboxStep::MembershipMoved,
        _ => OutboxStep::Refused,
    }
}

/* The outbox entry --------------------------------------------------------- */

fn route_json(route: &ChainRoute) -> Value {
    match route {
        ChainRoute::Create => json!({ "kind": "create" }),
        ChainRoute::Rosters => json!({ "kind": "rosters" }),
        ChainRoute::Admit { user_id } => json!({ "kind": "admit", "userId": user_id }),
        ChainRoute::Member { user_id } => json!({ "kind": "member", "userId": user_id }),
        ChainRoute::Remove { user_id } => json!({ "kind": "remove", "userId": user_id }),
        ChainRoute::Areas => json!({ "kind": "areas" }),
        ChainRoute::Rotation { workspace_id } => json!({ "kind": "rotation", "workspaceId": workspace_id }),
        ChainRoute::Delete { workspace_id } => json!({ "kind": "delete", "workspaceId": workspace_id }),
    }
}

/* A route as an entry holds it; none for anything else (the entry is then no entry). */
fn route_of(value: &Value) -> Option<ChainRoute> {
    let id = |key: &str| -> Option<String> {
        let text = value.get(key)?.as_str()?;
        uuid(text, key).ok().map(str::to_string)
    };
    Some(match value.get("kind")?.as_str()? {
        "create" => ChainRoute::Create,
        "rosters" => ChainRoute::Rosters,
        "admit" => ChainRoute::Admit { user_id: id("userId")? },
        "member" => ChainRoute::Member { user_id: id("userId")? },
        "remove" => ChainRoute::Remove { user_id: id("userId")? },
        "areas" => ChainRoute::Areas,
        "rotation" => ChainRoute::Rotation { workspace_id: id("workspaceId")? },
        "delete" => ChainRoute::Delete { workspace_id: id("workspaceId")? },
        _ => return None,
    })
}

/*
 * An outbox entry's JSON as this core writes it: the web's `OutboxEntry`
 * version 1 (`stagedEnvelope` empty: nothing a Core 5a resend needs is
 * secret; `state` ready; `joinCode` none), with the body as the exact text
 * sent, and the head the call was built on and its own roster by digest.
 */
fn entry_json(
    outbox_id: &str,
    group_id: &str,
    route: &ChainRoute,
    body: &str,
    admits: Option<(&str, &str)>,
    digests: (&str, &str),
) -> Value {
    let mut entry = json!({
        "v": 1,
        "id": outbox_id,
        "groupId": group_id,
        "route": route_json(route),
        "body": body,
        "previousRosterDigest": digests.0,
        "rosterDigest": digests.1,
        "stagedEnvelope": "",
        "state": "ready",
        "attempts": 0,
        "joinCode": null,
    });
    if let Some((user_id, keys)) = admits {
        entry["admits"] = json!({ "userId": user_id, "keys": keys });
    }
    entry
}

/*
 * The keys a kept admission was staged over, as its `admits` names them
 * (packages/crypto's admittedKeys): `keys`, their key commitment, when the
 * entry carries it; else an older entry's `fingerprint`, which is the key
 * commitment exactly when the pin it came from held them. `keys` present but
 * not a string is none, never a fall back to `fingerprint`.
 */
fn admitted_keys(admits: &serde_json::Map<String, Value>) -> Option<&str> {
    match admits.get("keys") {
        Some(keys) => keys.as_str(),
        None => admits.get("fingerprint")?.as_str(),
    }
}

/* A contact pin's key commitment ([`crate::key_commitment`]), from the fields the ledger reads. */
fn pin_commitment(pin: &crate::ledger_settings::ContactPin) -> Option<String> {
    crate::key_commitment(crate::PinKeys {
        key_version: None,
        encryption_public_key: pin.encryption_public_key.clone()?,
        signing_public_key: pin.signing_public_key.clone()?,
        ml_dsa_public_key_hash: pin.ml_dsa_public_key_hash.clone(),
        kem_public_key_hash: pin.kem_public_key_hash.clone(),
        fingerprint: String::new(),
    })
}

/* What the reader is given beside the entry: its id, the admin's pin of an admission's person, the committed head. */
struct Reading<'a> {
    id: Option<&'a str>,
    pin: &'a dyn Fn(&str) -> Option<(String, String)>,
    /* The committed chain's roster digests, version 1 first; none without one. */
    head: Option<&'a [String]>,
}

/// An outbox entry's JSON as the reader takes it, for the shared fixtures and
/// the fuzz targets: what [`AreaLedger::outbox_open`] answers for `value`
/// (opened from the device store) in `group_id`, kept under `id` (none: any),
/// with the admin's pin of an admission's person (`pin`: their user id and
/// its key commitment) and the committed chain's roster digests (`head`). `None`:
/// not an entry (deleted, and counted as lost).
#[cfg(feature = "fixtures")]
#[doc(hidden)]
pub fn outbox_entry_read(
    value: &Value,
    group_id: &str,
    id: Option<&str>,
    pin: Option<(&str, &str)>,
    head: Option<&[String]>,
) -> Option<OutboxCall> {
    let pin = pin.map(|(user, print)| (user.to_string(), print.to_string()));
    let lookup = move |_: &str| pin.clone();
    entry_read(value, group_id, &Reading { id, pin: &lookup, head })
}

/// An outbox entry as [`AreaLedger::outbox_open`] seals its JSON, for the
/// shared fixtures: any value, in any family, under `account_key`.
#[cfg(feature = "fixtures")]
#[doc(hidden)]
pub fn outbox_entry_seal(
    account_key: &[u8],
    user_id: &str,
    group_id: &str,
    value: &Value,
) -> CoreResult<String> {
    crate::device_record::device_store_seal_value(account_key, user_id, group_id, OUTBOX, value)
}

/* A body as an entry holds it: this core's exact text (a JSON object), or the web's object. */
fn body_text(value: &Value) -> Option<String> {
    match value {
        Value::Object(_) => Some(value.to_string()),
        Value::String(text) => {
            serde_json::from_str::<Value>(text).ok().filter(Value::is_object).map(|_| text.clone())
        }
        _ => None,
    }
}

fn entry_read(value: &Value, group_id: &str, reading: &Reading<'_>) -> Option<OutboxCall> {
    // The web's isEntry, field by field in its order: version, id, family, staged envelope, state,
    // body; then the route this core needs to send it.
    let entry = value.as_object()?;
    // `1`, `1.0` and `1e0` alike, as JavaScript's `=== 1` reads them.
    if entry.get("v").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let outbox_id = entry.get("id")?.as_str().filter(|id| !id.is_empty())?;
    // The kept id compared without ASCII case, as user ids are.
    if reading.id.is_some_and(|id| !id.eq_ignore_ascii_case(outbox_id)) {
        return None;
    }
    if entry.get("groupId")?.as_str()? != group_id {
        return None;
    }
    entry.get("stagedEnvelope")?.as_str()?;
    let state = entry.get("state")?.as_str()?;
    if !["awaiting-check", "ready", "committed"].contains(&state) {
        return None;
    }
    let body = body_text(entry.get("body")?)?;
    let route = route_of(entry.get("route")?)?;
    let outbox_id = outbox_id.to_string();
    let hold = |reason| Some(OutboxCall::Hold { outbox_id: outbox_id.clone(), route: route.clone(), reason });
    if state == "awaiting-check" {
        return hold(OutboxHold::AwaitingCheck);
    }
    // Answered here when the committed chain says so: it landed, or it can never.
    let digest = |key: &str| entry.get(key).and_then(Value::as_str).filter(|d| !d.is_empty());
    if let (Some(head), Some(previous), Some(own)) =
        (reading.head, digest("previousRosterDigest"), digest("rosterDigest"))
    {
        if head.iter().any(|at| at == own) {
            return Some(OutboxCall::Landed { outbox_id, route });
        }
        // Superseded only when the chain passed through the head it was built on and moved on: a
        // head that never held it (another history, a cut) says nothing, and the bytes go.
        if head.iter().any(|at| at == previous) && head.last().map(String::as_str) != Some(previous) {
            return Some(OutboxCall::Superseded { outbox_id, route });
        }
    }
    // An admission goes only to the keys the admin's pin of the person holds now, told by their
    // key commitment: every first-seen pin's fingerprint is "".
    if let ChainRoute::Admit { user_id } = &route {
        let admits = entry.get("admits").and_then(Value::as_object);
        let kept = admits.and_then(|at| Some((at.get("userId")?.as_str()?, admitted_keys(at)?)));
        let pin = (reading.pin)(user_id);
        let same = matches!((kept, pin.as_ref()), (Some((kept_user, kept_keys)), Some((user, keys)))
            if kept_user == user_id && user == user_id && !keys.is_empty() && kept_keys == keys);
        if !same {
            return hold(OutboxHold::OtherKeys);
        }
    }
    if state == "committed" {
        return hold(OutboxHold::Committed);
    }
    Some(OutboxCall::Send { outbox_id, route, body })
}

/* Wires ------------------------------------------------------------------- */

fn statement_wire(signed: &SignedGroupStatement) -> Value {
    json!({
        "statement": encode(&signed.statement),
        "signature": { "ed25519": encode(&signed.signature.ed25519), "mlDsa": encode(&signed.signature.ml_dsa) },
        "signerSignature": encode(&signed.signer_signature),
    })
}

/* What a call is built from: the account, its identity opened, and the family as the ledger holds it. */
struct Caller {
    me: OwnIdentities,
    keys: IdentityKeys,
    served: ServedKeys,
    state: CallState,
    chain: Arc<AcceptedRosters>,
    seed: Option<Zeroizing<Vec<u8>>>,
}

/* The change a call makes to the roster (one per call, moved straight in: its size does not matter). */
#[allow(clippy::large_enum_variant)]
enum Change {
    Admit { user_id: String, served: PublicIdentity, roles: Vec<GroupRole> },
    Roles { user_id: String, roles: fn(&[GroupRole]) -> Vec<GroupRole> },
}

fn with_role(roles: &[GroupRole], role: GroupRole, on: bool) -> Vec<GroupRole> {
    let mut out: Vec<GroupRole> = roles.iter().copied().filter(|at| *at != role).collect();
    if on {
        out.push(role);
    }
    out.sort();
    out
}

/* Whether an entry names exactly these keys: X25519, Ed25519 and the ML-DSA key by digest (the worker's entryNames). */
fn entry_names(entry: Option<&RosterMember>, keys: &ServedKeys) -> bool {
    let Some(entry) = entry else { return false };
    let digest = decode("mlDsaPublicKey", &keys.ml_dsa_public_key, None).map(|key| sha256_base64url(&key));
    entry.encryption_public_key == keys.encryption_public_key
        && entry.signing_public_key == keys.signing_public_key
        && digest.is_ok_and(|digest| digest == entry.ml_dsa_public_key_digest)
}

/* Whether an entry names exactly the keys a contact pin holds, the lattice keys by digest (the worker's entryIsPin). */
fn entry_is_pin(entry: Option<&RosterMember>, pin: &ContactPin) -> bool {
    entry.is_some_and(|entry| {
        pin.encryption_public_key.as_ref() == Some(&entry.encryption_public_key)
            && pin.signing_public_key.as_ref() == Some(&entry.signing_public_key)
            && same_key_digest(pin.ml_dsa_public_key_hash.clone(), entry.ml_dsa_public_key_digest.clone())
            && same_key_digest(pin.kem_public_key_hash.clone(), entry.kem_public_key_digest.clone())
    })
}

/* Every identity's ML-DSA key by its SHA-256, as acceptance takes signers' keys. */
fn ml_dsa_keys_of(identities: &[ServedKeys]) -> HashMap<String, String> {
    identities
        .iter()
        .filter_map(|keys| {
            let key = decode("mlDsaPublicKey", &keys.ml_dsa_public_key, None).ok()?;
            Some((sha256_base64url(&key), keys.ml_dsa_public_key.clone()))
        })
        .collect()
}

fn new_outbox_id() -> String {
    let mut bytes = random(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

impl AreaLedger {
    /*
     * The caller of a roster call, in the worker's order: the account `me`
     * names (`NO_ACCOUNT`), then the family's committed chain (`SyncFirst`,
     * the worker's NO_CHAIN), `members` on it (`NOT_MANAGER`, before any
     * key is asked for), the current key's seed when `seed` is asked
     * (`OpenKeyFirst`, the worker's NO_SEED), then the identity, which must
     * open under this account and be the one it unlocked with (`OPEN_IDENTITY`).
     */
    fn caller(
        &self,
        me: OwnIdentities,
        identity: IdentityEnvelope,
        group_id: &str,
        manager: bool,
    ) -> CoreResult<Result<Caller, RosterCall>> {
        let account = self.served_account().ok_or_else(|| input(NO_ACCOUNT))?;
        let root = self.account_root().ok_or_else(|| input(NO_ACCOUNT))?;
        if !me.user_id.eq_ignore_ascii_case(&account.user_id) {
            return Err(input(NO_ACCOUNT));
        }
        let state = self.call_state(group_id);
        if state.generation != account.generation {
            return Err(input(NOT_THIS_ACCOUNT));
        }
        let Some(chain) = state.chain.clone() else { return Ok(Err(RosterCall::SyncFirst)) };
        let mine = chain.roster.entry(&account.user_id);
        if manager && !mine.is_some_and(|e| e.active_with(Some(GroupRole::Members))) {
            return Err(input(NOT_MANAGER));
        }
        let seed = state.seed.clone();
        if manager && seed.is_none() {
            return Ok(Err(RosterCall::OpenKeyFirst));
        }
        let own_key = encode(&account.signing_public_key);
        let served = served_keys_of(&identity).filter(|keys| keys.signing_public_key == own_key);
        let Some(served) = served else { return Err(input(OPEN_IDENTITY)) };
        if !me.identities.iter().any(|keys| keys.signing_public_key == own_key) {
            return Err(input(OPEN_IDENTITY));
        }
        let keys = identity_open(account.user_id.clone(), root.to_vec(), identity)
            .map_err(|_| input(OPEN_IDENTITY))?;
        Ok(Ok(Caller { me, keys, served, state, chain, seed }))
    }

    /*
     * One roster call, as the worker's groupStage builds it: the roster from
     * the committed chain with the change; the signer's entry; every live
     * folder open for an admission; signed; the succession when it takes
     * `members` from someone; the staged chain; the seals and grants it makes
     * due; then, under the lock, still the session and the chain it was built
     * on, and the outbox entry sealed.
     */
    fn stage(
        &self,
        caller: Caller,
        group_id: &str,
        expected_revision: u64,
        change: Change,
        kems: HashMap<String, String>,
    ) -> CoreResult<RosterCall> {
        let Caller { me, keys, served, state, chain, seed } = caller;
        let seed = seed.ok_or_else(|| input(NOT_MANAGER))?;
        let me_id = me.user_id.to_lowercase();
        let mut kems = kems;
        let next = chain.roster.roster_version + 1;
        let mut members = chain.roster.members.clone();
        let put = |members: &mut Vec<RosterMember>, entry: RosterMember| {
            members.retain(|at| at.user_id != entry.user_id);
            members.push(entry);
        };
        let (route, admits) = match change {
            Change::Admit { user_id, served: newcomer, roles } => {
                if chain.roster.entry(&user_id).is_some_and(|e| e.active_with(None)) {
                    return Err(input(ALREADY_IN));
                }
                // Only the account's own contact pin of them, from settings the ledger opened: the
                // keys their words check confirmed (a group's word, or a pin short of a key part,
                // admits no one, as the worker's newRosterEntry refuses it).
                let found = self.contact_pin(&user_id).ok_or_else(|| input(NOT_CHECKED))?;
                // Never with a role, whatever the invitation says ([`ADMIT_AS_MEMBER`]).
                if !roles.is_empty() {
                    return Err(input(ADMIT_AS_MEMBER));
                }
                let pin = found.checked().ok_or_else(|| input(NOT_THE_PINNED_KEYS))?;
                // roster_entry_new builds from a first-seen pin too (design 3.3), but letting
                // someone in over one waits for the manager rule beside it (3.6, the web's PR 4):
                // until then an admission still takes a words check alone, as the worker's stage.
                if !crate::contacts::pin_verified(
                    pin.encryption_public_key.clone(),
                    pin.signing_public_key.clone(),
                    Some(pin.ml_dsa_public_key_hash.clone()),
                    Some(pin.kem_public_key_hash.clone()),
                    pin.fingerprint.clone(),
                ) {
                    return Err(input(NOT_THE_PINNED_KEYS));
                }
                // The newcomer's ML-KEM key is the one their entry is made from.
                kems.insert(user_id.clone(), newcomer.kem_public_key.clone());
                let entry = roster_entry_new(pin.clone(), newcomer, roles, next)?;
                // A pin whose userId is the person's in another case names someone else (the worker's check).
                if entry.user_id != user_id {
                    return Err(input(NOT_THE_PINNED_KEYS));
                }
                let user_id = entry.user_id.clone();
                put(&mut members, entry);
                // Kept by the keys it is built from, never by the pin's fingerprint.
                let keys = pin_commitment(&found).ok_or_else(|| input(NOT_THE_PINNED_KEYS))?;
                (ChainRoute::Admit { user_id }, Some(keys))
            }
            Change::Roles { user_id, roles } => {
                let before = chain
                    .roster
                    .entry(&user_id)
                    .filter(|e| e.active_with(None))
                    .ok_or_else(|| input(NOT_IN))?
                    .clone();
                let after = RosterMember { roles: roles(&before.roles), ..before.clone() };
                if after.roles == before.roles {
                    return Err(input(UNCHANGED));
                }
                // The succession must be signed by someone who keeps `members`: never oneself.
                if user_id == me_id
                    && before.roles.contains(&GroupRole::Members)
                    && !after.roles.contains(&GroupRole::Members)
                {
                    return Err(input(SELF_TAKE));
                }
                // Someone active keeps `billing`: the server refuses a family without an organizer.
                let others_bill =
                    members.iter().any(|e| e.user_id != user_id && e.active_with(Some(GroupRole::Billing)));
                if before.roles.contains(&GroupRole::Billing)
                    && !after.roles.contains(&GroupRole::Billing)
                    && !others_bill
                {
                    return Err(input(ORGANIZER_FIRST));
                }
                put(&mut members, after);
                (ChainRoute::Member { user_id }, None)
            }
        };
        let roster =
            roster_next(Arc::clone(&chain), members, me_id.clone(), None, None, Some(ROSTER_FORMAT))?;
        // Every one of these calls is signed with the open identity, which the entry before must name.
        if !entry_names(chain.roster.entry(&me_id), &served) {
            return Err(input(STALE_ENTRY));
        }
        // An admission grants every live folder's key: each must be open here, before anything is signed.
        if matches!(route, ChainRoute::Admit { .. }) && state.areas.iter().any(|(_, held)| held.is_none()) {
            return Ok(RosterCall::OpenFoldersFirst);
        }
        let signed = roster_sign(roster.clone(), seed.to_vec(), keys.clone())?;
        // A roster that takes a holder away is the last under its key: the succession rides with it.
        let drops = chain.roster.members.iter().any(|entry| {
            entry.active_with(Some(GroupRole::Members))
                && !roster
                    .entry(&entry.user_id)
                    .is_some_and(|after| after.active_with(Some(GroupRole::Members)))
        });
        let mut successor: Option<Zeroizing<Vec<u8>>> = None;
        let mut succession: Option<SignedGroupStatement> = None;
        if drops {
            let fresh = Zeroizing::new(random(64));
            let old = group_public_key(seed.to_vec())?;
            let new = group_public_key(fresh.to_vec())?;
            succession = Some(group_succession_sign(
                GroupKeySuccession {
                    group_id: chain.group_id.clone(),
                    old_version: chain.group_key_version,
                    new_version: chain.group_key_version + 1,
                    old_ed25519_public_key: old.ed25519_public_key,
                    old_ml_dsa_public_key: old.ml_dsa_public_key,
                    new_ed25519_public_key: new.ed25519_public_key,
                    new_ml_dsa_public_key: new.ml_dsa_public_key,
                    last_roster_version: next,
                    last_roster_digest: roster_digest(signed.statement.clone()),
                    signer_user_id: me_id.clone(),
                },
                seed.to_vec(),
                keys.clone(),
            )?);
            successor = Some(fresh);
        }
        let staged = stage_chain(&chain, &signed, succession.as_ref(), &me)?;
        let body = parts(Parts {
            chain: &chain,
            staged: &staged,
            route: &route,
            areas: &state.areas,
            me: &me_id,
            served: &served,
            keys: &keys,
            seed: &seed,
            successor: successor.as_ref(),
            kems: &kems,
        })?;
        let mut call = Map::new();
        call.insert("expectedRevision".into(), json!(expected_revision));
        call.insert("roster".into(), statement_wire(&signed));
        if let Some(succession) = &succession {
            call.insert("succession".into(), statement_wire(succession));
        }
        for (key, value) in body {
            call.insert(key, value);
        }
        let body = Value::Object(call).to_string();
        // Tests only: a lock, another account, or a commit while the call was signed.
        #[cfg(test)]
        AFTER_SIGNING.with(|hook| {
            if let Some(hook) = hook.borrow().as_ref() {
                hook(self)
            }
        });
        // Under the lock: the session and the committed chain this was built on, or nothing is kept.
        let Some((user_id, store_key)) =
            self.call_still_holds(group_id, state.generation, &chain.roster_digest)?
        else {
            return Ok(RosterCall::SyncFirst);
        };
        let outbox_id = new_outbox_id();
        let digests = (chain.roster_digest.as_str(), staged.roster_digest.as_str());
        let admits = match (&route, &admits) {
            (ChainRoute::Admit { user_id }, Some(keys)) => Some((user_id.as_str(), keys.as_str())),
            _ => None,
        };
        let entry = entry_json(&outbox_id, &chain.group_id, &route, &body, admits, digests);
        let plaintext = Zeroizing::new(entry.to_string().into_bytes());
        let entry = seal_bytes(&store_key, &user_id, &chain.group_id, OUTBOX, &plaintext)?;
        Ok(RosterCall::Staged { call: StagedCall { outbox_id, route, body, entry } })
    }
}

/*
 * The staged chain of a call: its roster (and succession) accepted on top of
 * the committed chain's cache, never as a mark, and only if every device
 * holding the committed chain would take it (the worker's stageChain).
 */
fn stage_chain(
    chain: &Arc<AcceptedRosters>,
    signed: &SignedGroupStatement,
    succession: Option<&SignedGroupStatement>,
    me: &OwnIdentities,
) -> CoreResult<Arc<AcceptedRosters>> {
    let accepted = accept_rosters(
        chain.group_id.clone(),
        chain.group_keys[0].clone(),
        None,
        vec![],
        vec![signed.clone()],
        succession.into_iter().cloned().collect(),
        ml_dsa_keys_of(&me.identities),
        me.clone(),
        Some(chain.cache.clone()),
    )?;
    let RosterChain::Accepted { chain: staged } = accepted else {
        return Err(input(NOT_FOLLOWING));
    };
    if staged.roster.roster_version != chain.roster.roster_version + 1 {
        return Err(input(NOT_FOLLOWING));
    }
    if succession.is_some() && staged.group_key_version != chain.group_key_version + 1 {
        return Err(input(KEY_NOT_TAKEN));
    }
    if staged.succession_due {
        return Err(input(SUCCESSION_WITH_IT));
    }
    Ok(staged)
}

struct Parts<'a> {
    chain: &'a AcceptedRosters,
    staged: &'a Arc<AcceptedRosters>,
    route: &'a ChainRoute,
    areas: &'a [(String, Option<HeldArea>)],
    me: &'a str,
    served: &'a ServedKeys,
    keys: &'a IdentityKeys,
    seed: &'a Zeroizing<Vec<u8>>,
    successor: Option<&'a Zeroizing<Vec<u8>>>,
    kems: &'a HashMap<String, String>,
}

/*
 * The seals and grants a call carries, made against its staged chain (the
 * worker's partsOf): a succession's new seed to every holder on the new
 * roster, else the current seed to the one member it newly gives `members`;
 * an admission's grants of every live area's current key.
 */
fn parts(p: Parts<'_>) -> CoreResult<Vec<(String, Value)>> {
    let after = &p.staged.roster;
    let at = (p.staged.roster.roster_version, p.staged.roster_digest.clone());
    let kem_for = |user_id: &str| -> CoreResult<Vec<u8>> {
        let value = if user_id == p.me { Some(&p.served.kem_public_key) } else { p.kems.get(user_id) };
        let value = value.ok_or_else(|| input(KEYS_MISSING))?;
        decode("kemPublicKey", value, None)
    };
    let seal_to = |seed: &[u8], holder: &RosterMember| -> CoreResult<Value> {
        let ctx = GroupKeySealContext {
            group_id: p.staged.group_id.clone(),
            group_key_version: p.staged.group_key_version,
            holder_user_id: holder.user_id.clone(),
            holder_key_version: holder.key_version,
            sealer_user_id: p.me.to_string(),
            roster_version: at.0,
            roster_digest: at.1.clone(),
        };
        let envelope = group_key_seal(
            seed.to_vec(),
            ctx,
            Arc::clone(p.staged),
            kem_for(&holder.user_id)?,
            p.keys.clone(),
        )?;
        Ok(json!({
            "groupKeyVersion": p.staged.group_key_version,
            "holderUserId": holder.user_id,
            "holderKeyVersion": holder.key_version,
            "rosterVersion": at.0,
            "rosterDigest": at.1,
            "envelope": encode(&envelope),
        }))
    };
    let mut out = vec![];
    if let Some(successor) = p.successor {
        let mut seals = vec![];
        for holder in after.members.iter().filter(|e| e.active_with(Some(GroupRole::Members))) {
            seals.push(seal_to(successor, holder)?);
        }
        out.push(("seals".to_string(), Value::Array(seals)));
    } else {
        let promoted: Vec<&RosterMember> = after
            .members
            .iter()
            .filter(|e| {
                e.active_with(Some(GroupRole::Members))
                    && !p
                        .chain
                        .roster
                        .entry(&e.user_id)
                        .is_some_and(|b| b.active_with(Some(GroupRole::Members)))
            })
            .collect();
        if promoted.len() > 1 {
            return Err(input(ONE_AT_A_TIME));
        }
        if let Some(holder) = promoted.first() {
            out.push(("keySeal".to_string(), seal_to(p.seed, holder)?));
        }
    }
    if let ChainRoute::Admit { user_id } = p.route {
        let grantee = after.entry(user_id).ok_or_else(|| input(NOT_FOLLOWING))?;
        let mut grants = vec![];
        for (workspace_id, held) in p.areas {
            let (version, key, id_seed) = held.as_ref().ok_or_else(|| input(NOT_OPENED))?;
            let ctx = AreaGrantContext {
                group_id: p.staged.group_id.clone(),
                workspace_id: workspace_id.clone(),
                workspace_key_version: *version,
                grantee_user_id: grantee.user_id.clone(),
                grantee_key_version: grantee.key_version,
                granter_user_id: p.me.to_string(),
                roster_version: at.0,
                roster_digest: at.1.clone(),
            };
            let envelope = area_grant_seal(
                key.to_vec(),
                ctx,
                Arc::clone(p.staged),
                id_seed.clone(),
                kem_for(&grantee.user_id)?,
                p.keys.clone(),
            )?;
            grants.push(json!({
                "workspaceId": workspace_id,
                "workspaceKeyVersion": version,
                "granteeUserId": grantee.user_id,
                "granteeKeyVersion": grantee.key_version,
                "rosterVersion": at.0,
                "rosterDigest": at.1,
                "envelope": encode(&envelope),
            }));
        }
        if !grants.is_empty() {
            out.push(("grants".to_string(), Value::Array(grants)));
        }
    }
    Ok(out)
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl AreaLedger {
    /// Opens the family's group key seal to this account (route 8) and keeps
    /// the seed here, the worker's `groupOpenSeal`: only against the committed
    /// chain (`NO_CHAIN`: sync first), sealed to `holder`'s key version (the
    /// identity of this account it was sealed to, opened under the account
    /// root), by a holder whose signature holds through the roster
    /// (`sealer_history` as for [`crate::group_key_open`]), and of the key the
    /// chain has at that version. The seed is kept only while it is the
    /// committed chain's current key (re-checked under the lock, with the
    /// session), a commit to a later key drops it, and it never leaves the
    /// ledger. Returns the key version the seal was of.
    ///
    /// ```
    /// use hushos_core::*;
    /// let ledger = AreaLedger::new();
    /// let me = OwnIdentities { user_id: "00000001-abcd-4abc-8abc-abcdefabcdef".into(), identities: vec![] };
    /// let user = me.user_id.clone();
    /// let root = vec![7u8; 32];
    /// let holder = identity_create(user.clone(), root.clone(), 1)?;
    /// let seal = ServedKeySeal {
    ///     group_key_version: 1, holder_key_version: 1, sealer_user_id: user.clone(),
    ///     roster_version: 1, roster_digest: "AA".into(), envelope: vec![0; 10],
    /// };
    /// let group = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".to_string();
    /// // Locked: nothing opens.
    /// assert!(ledger.open_group_key(me.clone(), group.clone(), seal.clone(), vec![], None, holder.clone()).is_err());
    /// ledger.open_account(user, base64url_decode(holder.signing_public_key.clone())?, root)?;
    /// // Unlocked, but no member list committed for the family: still nothing.
    /// let refused = ledger.open_group_key(me, group, seal, vec![], None, holder).unwrap_err();
    /// assert_eq!(refused.to_string(), "Check the family’s member list first.");
    /// # Ok::<(), hushos_core::CoreError>(())
    /// ```
    pub fn open_group_key(
        &self,
        me: OwnIdentities,
        group_id: String,
        seal: ServedKeySeal,
        sealer_ml_dsa_public_key: Vec<u8>,
        sealer_history: Option<SignerHistory>,
        holder: IdentityEnvelope,
    ) -> CoreResult<u64> {
        let account = self.served_account().ok_or_else(|| input(NO_ACCOUNT))?;
        let root = self.account_root().ok_or_else(|| input(NO_ACCOUNT))?;
        if !me.user_id.eq_ignore_ascii_case(&account.user_id) {
            return Err(input(NO_ACCOUNT));
        }
        let state = self.call_state(&group_id);
        if state.generation != account.generation {
            return Err(input(NOT_THIS_ACCOUNT));
        }
        let chain = state.chain.ok_or_else(|| input(NO_CHAIN))?;
        let reader_key_version = holder.key_version;
        let keys = identity_open(account.user_id.clone(), root.to_vec(), holder)
            .map_err(|_| input(NOT_OWN_IDENTITY))?;
        let version = seal.group_key_version;
        let seed = group_key_open(
            seal.envelope,
            GroupKeySealContext {
                group_id: chain.group_id.clone(),
                group_key_version: version,
                holder_user_id: account.user_id.clone(),
                holder_key_version: seal.holder_key_version,
                sealer_user_id: seal.sealer_user_id,
                roster_version: seal.roster_version,
                roster_digest: seal.roster_digest,
            },
            Arc::clone(&chain),
            sealer_ml_dsa_public_key,
            sealer_history,
            account.user_id,
            reader_key_version,
            keys,
        )?;
        // Tests only: a lock or another account while the seal was opened.
        #[cfg(test)]
        AFTER_OPENING.with(|hook| {
            if let Some(hook) = hook.borrow().as_ref() {
                hook(self)
            }
        });
        self.hold_seed(&chain.group_id, version, Zeroizing::new(seed.to_vec()), state.generation)?;
        Ok(version)
    }

    /// "Let them in" (route 17), the worker's `groupStage` admission:
    /// `user_id`'s entry made only from the keys their words check confirmed
    /// (the contact pin of them in the settings this account last opened,
    /// [`AreaLedger::use_settings_envelope`], and `served`, their served identity:
    /// [`crate::roster_entry_new`]) as a plain member: `roles` must be empty
    /// ([`ADMIT_AS_MEMBER`] otherwise, after the contact pin is found), since
    /// an invitation's roles are only the server's word. The roster signed
    /// over the committed chain, and the newcomer granted every live family
    /// folder's current key. `me` is the account the ledger opened with its
    /// identities, `identity` its open identity's envelope; `kems` every
    /// member's ML-KEM key as route 6 served it (each checked against its
    /// entry when sealed); `expected_revision` the head's revision from route
    /// 3. In the worker's order: the account (error), the chain
    /// ([`RosterCall::SyncFirst`]), `members` ([`NOT_MANAGER`]), the seed
    /// ([`RosterCall::OpenKeyFirst`]), the identity (error), someone already
    /// in, no contact pin ([`NOT_CHECKED`]), a role ([`ADMIT_AS_MEMBER`]), keys not the pinned ones (errors
    /// the person reads), then every live folder open
    /// ([`RosterCall::OpenFoldersFirst`], before anything is signed; a deleted
    /// folder is granted nothing).
    ///
    /// ```
    /// use hushos_core::*;
    /// use std::collections::HashMap;
    /// let ledger = AreaLedger::new();
    /// let user = "00000001-abcd-4abc-8abc-abcdefabcdef".to_string();
    /// let root = vec![7u8; 32];
    /// let identity = identity_create(user.clone(), root.clone(), 1)?;
    /// let me = OwnIdentities { user_id: user.clone(), identities: vec![] };
    /// let newcomer = public_identity(identity_create("00000002-abcd-4abc-8abc-abcdefabcdef".into(), vec![8u8; 32], 1)?)?;
    /// ledger.open_account(user, base64url_decode(identity.signing_public_key.clone())?, root)?;
    /// let group = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".to_string();
    /// // No member list committed here: nothing is signed, and nothing is kept to send.
    /// let first = ledger.admit_body(me, identity, group, 5, "00000002-abcd-4abc-8abc-abcdefabcdef".into(), newcomer, vec![], HashMap::new())?;
    /// assert_eq!(first, RosterCall::SyncFirst);
    /// # Ok::<(), hushos_core::CoreError>(())
    /// ```
    #[allow(clippy::too_many_arguments)]
    pub fn admit_body(
        &self,
        me: OwnIdentities,
        identity: IdentityEnvelope,
        group_id: String,
        expected_revision: u64,
        user_id: String,
        served: PublicIdentity,
        roles: Vec<GroupRole>,
        kems: HashMap<String, String>,
    ) -> CoreResult<RosterCall> {
        let user_id = user_id.to_lowercase();
        uuid(&user_id, "user id")?;
        let caller = match self.caller(me, identity, &group_id, true)? {
            Ok(caller) => caller,
            Err(first) => return Ok(first),
        };
        self.stage(caller, &group_id, expected_revision, Change::Admit { user_id, served, roles }, kems)
    }

    /// Granting or taking away `members` (route 18), the worker's `groupStage`
    /// role change: [`MembersRole::Grant`] seals the current group key to them
    /// in the call; [`MembersRole::Take`] replaces the group key in the call
    /// (the succession, signed with the old key) and seals the new one to
    /// every holder who remains. Refused as [`AreaLedger::admit_body`] up to
    /// the identity, then: someone not in the family now, a change that
    /// changes nothing ([`UNCHANGED`]), taking it from oneself ([`SELF_TAKE`]:
    /// another holder must sign the succession). The last holder is never let
    /// go of (acceptance's rules).
    ///
    /// ```
    /// use hushos_core::*;
    /// use std::collections::HashMap;
    /// let ledger = AreaLedger::new();
    /// let me = OwnIdentities { user_id: "00000001-abcd-4abc-8abc-abcdefabcdef".into(), identities: vec![] };
    /// let identity = identity_create(me.user_id.clone(), vec![7u8; 32], 1)?;
    /// // Locked: refused before anything is read.
    /// let refused = ledger
    ///     .roles_body(me, identity, "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".into(), 5,
    ///         "00000002-abcd-4abc-8abc-abcdefabcdef".into(), MembersRole::Take, HashMap::new())
    ///     .unwrap_err();
    /// assert_eq!(refused.to_string(), "Unlock your account first.");
    /// # Ok::<(), hushos_core::CoreError>(())
    /// ```
    #[allow(clippy::too_many_arguments)]
    pub fn roles_body(
        &self,
        me: OwnIdentities,
        identity: IdentityEnvelope,
        group_id: String,
        expected_revision: u64,
        user_id: String,
        change: MembersRole,
        kems: HashMap<String, String>,
    ) -> CoreResult<RosterCall> {
        let user_id = user_id.to_lowercase();
        uuid(&user_id, "user id")?;
        let caller = match self.caller(me, identity, &group_id, true)? {
            Ok(caller) => caller,
            Err(first) => return Ok(first),
        };
        let roles: fn(&[GroupRole]) -> Vec<GroupRole> = match change {
            MembersRole::Grant => |roles| with_role(roles, GroupRole::Members, true),
            MembersRole::Take => |roles| with_role(roles, GroupRole::Members, false),
        };
        self.stage(caller, &group_id, expected_revision, Change::Roles { user_id, roles }, kems)
    }

    /// The organizer handover (route 18, twice), as the web hands over:
    /// [`Handover::To`] gives another active member `billing`; once that has
    /// landed and the family was synced, [`Handover::StepDown`] takes it from
    /// the caller, refused with [`ORGANIZER_FIRST`] while nobody else active
    /// holds it (the server refuses a family without one too). Giving it to
    /// someone who holds it, or stepping down without it, is [`UNCHANGED`].
    /// Milestone 1 has no child accounts, so any active member may take it.
    /// Otherwise as [`AreaLedger::roles_body`].
    ///
    /// ```
    /// use hushos_core::*;
    /// use std::collections::HashMap;
    /// let ledger = AreaLedger::new();
    /// let me = OwnIdentities { user_id: "00000001-abcd-4abc-8abc-abcdefabcdef".into(), identities: vec![] };
    /// let identity = identity_create(me.user_id.clone(), vec![7u8; 32], 1)?;
    /// let refused = ledger
    ///     .handover_body(me, identity, "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".into(), 5, Handover::StepDown, HashMap::new())
    ///     .unwrap_err();
    /// assert_eq!(refused.to_string(), "Unlock your account first.");
    /// # Ok::<(), hushos_core::CoreError>(())
    /// ```
    pub fn handover_body(
        &self,
        me: OwnIdentities,
        identity: IdentityEnvelope,
        group_id: String,
        expected_revision: u64,
        step: Handover,
        kems: HashMap<String, String>,
    ) -> CoreResult<RosterCall> {
        let user_id = match &step {
            Handover::To { user_id } => user_id.to_lowercase(),
            Handover::StepDown => me.user_id.to_lowercase(),
        };
        uuid(&user_id, "user id")?;
        let caller = match self.caller(me, identity, &group_id, true)? {
            Ok(caller) => caller,
            Err(first) => return Ok(first),
        };
        let roles: fn(&[GroupRole]) -> Vec<GroupRole> = match step {
            Handover::To { .. } => |roles| with_role(roles, GroupRole::Billing, true),
            Handover::StepDown => |roles| with_role(roles, GroupRole::Billing, false),
        };
        self.stage(caller, &group_id, expected_revision, Change::Roles { user_id, roles }, kems)
    }

    /// Grants owed on the committed chain (route 22), the worker's
    /// `groupGrants`: each folder's current key to an active member, for a
    /// call that met `grants-due` (its `missing`) or route 3's `due.grants`.
    /// From any active member (the server refuses grants to oneself on route
    /// 22, so `missing` never names `me`). Refused unless every grantee is
    /// active on the chain (an error); [`GrantsCall::OpenFoldersFirst`] for a
    /// folder not open here; [`GrantsCall::SyncFirst`] without a committed
    /// chain or when another was committed while they were sealed. Requests
    /// are per folder, at most 256 grants each.
    ///
    /// ```
    /// use hushos_core::*;
    /// let ledger = AreaLedger::new();
    /// let user = "00000001-abcd-4abc-8abc-abcdefabcdef".to_string();
    /// let identity = identity_create(user.clone(), vec![7u8; 32], 1)?;
    /// ledger.open_account(user.clone(), base64url_decode(identity.signing_public_key.clone())?, vec![7u8; 32])?;
    /// let me = OwnIdentities { user_id: user, identities: vec![] };
    /// let owed = ledger.grants_body(me, identity, "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".into(), vec![])?;
    /// assert_eq!(owed, GrantsCall::SyncFirst);
    /// # Ok::<(), hushos_core::CoreError>(())
    /// ```
    pub fn grants_body(
        &self,
        me: OwnIdentities,
        identity: IdentityEnvelope,
        group_id: String,
        missing: Vec<OwedGrant>,
    ) -> CoreResult<GrantsCall> {
        let caller = match self.caller(me, identity, &group_id, false)? {
            Ok(caller) => caller,
            Err(_) => return Ok(GrantsCall::SyncFirst),
        };
        let Caller { keys, state, chain, me, .. } = caller;
        let me_id = me.user_id.to_lowercase();
        let mut by_area: Vec<(String, Vec<Value>)> = vec![];
        // Folder and person ids as the ledger keeps them (lowercase), each owed grant once.
        let mut seen = std::collections::HashSet::new();
        let missing: Vec<OwedGrant> = missing
            .into_iter()
            .map(|owed| OwedGrant {
                workspace_id: owed.workspace_id.to_ascii_lowercase(),
                user_id: owed.user_id.to_ascii_lowercase(),
                ..owed
            })
            .filter(|owed| seen.insert((owed.workspace_id.clone(), owed.user_id.clone())))
            .collect();
        for owed in &missing {
            let grantee = chain
                .roster
                .entry(&owed.user_id.to_lowercase())
                .filter(|e| e.active_with(None))
                .ok_or_else(|| input(NOT_ACTIVE))?
                .clone();
            let held = state
                .areas
                .iter()
                .find(|(at, _)| *at == owed.workspace_id)
                .and_then(|(_, held)| held.as_ref());
            let Some((version, key, id_seed)) = held else { return Ok(GrantsCall::OpenFoldersFirst) };
            let ctx = AreaGrantContext {
                group_id: chain.group_id.clone(),
                workspace_id: owed.workspace_id.clone(),
                workspace_key_version: *version,
                grantee_user_id: grantee.user_id.clone(),
                grantee_key_version: grantee.key_version,
                granter_user_id: me_id.clone(),
                roster_version: chain.roster.roster_version,
                roster_digest: chain.roster_digest.clone(),
            };
            let envelope = area_grant_seal(
                key.to_vec(),
                ctx,
                Arc::clone(&chain),
                id_seed.clone(),
                decode("kemPublicKey", &owed.kem_public_key, None)?,
                keys.clone(),
            )?;
            let grant = json!({
                "workspaceId": owed.workspace_id,
                "workspaceKeyVersion": version,
                "granteeUserId": grantee.user_id,
                "granteeKeyVersion": grantee.key_version,
                "rosterVersion": chain.roster.roster_version,
                "rosterDigest": chain.roster_digest,
                "envelope": encode(&envelope),
            });
            match by_area.iter_mut().find(|(at, _)| *at == owed.workspace_id) {
                Some((_, list)) => list.push(grant),
                None => by_area.push((owed.workspace_id.clone(), vec![grant])),
            }
        }
        if self.call_still_holds(&group_id, state.generation, &chain.roster_digest)?.is_none() {
            return Ok(GrantsCall::SyncFirst);
        }
        let requests = by_area
            .into_iter()
            .flat_map(|(workspace_id, list)| {
                list.chunks(MAX_GRANTS_PER_CALL)
                    .map(|chunk| GrantsRequest {
                        workspace_id: workspace_id.clone(),
                        body: json!({ "grants": chunk }).to_string(),
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        Ok(GrantsCall::Grants { requests })
    }

    /// The join code an admin reads to someone they let in, the worker's
    /// `groupJoinCode`: over the committed chain ([`MemberJoinCode::SyncFirst`]
    /// without one), the roster at which `user_id`'s entry last became active,
    /// from `rosters` (route 5 from version 1; only those whose digest is the
    /// committed chain's at their version are read, and one missing from the
    /// run is refused). The code is given only when their entry there names
    /// exactly the keys of this account's contact pin of them, from the
    /// settings it last opened ([`MemberJoinCode::NotPinned`] without one,
    /// [`MemberJoinCode::OtherKeys`] for other keys).
    ///
    /// ```
    /// use hushos_core::*;
    /// let ledger = AreaLedger::new();
    /// let code = ledger.member_join_code(
    ///     "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".into(), "00000002-abcd-4abc-8abc-abcdefabcdef".into(), vec![])?;
    /// assert_eq!(code, MemberJoinCode::SyncFirst);
    /// # Ok::<(), hushos_core::CoreError>(())
    /// ```
    pub fn member_join_code(
        &self,
        group_id: String,
        user_id: String,
        rosters: Vec<SignedGroupStatement>,
    ) -> CoreResult<MemberJoinCode> {
        let user_id = user_id.to_lowercase();
        let Some(chain) = self.call_state(&group_id).chain else { return Ok(MemberJoinCode::SyncFirst) };
        let Some(version) = admitted_at(&chain.roster_digests, &rosters, &user_id)? else {
            return Ok(MemberJoinCode::NotAdmitted);
        };
        let Some(pin) = self.contact_pin(&user_id).filter(|pin| pin.user_id.eq_ignore_ascii_case(&user_id))
        else {
            return Ok(MemberJoinCode::NotPinned);
        };
        let digest = &chain.roster_digests[(version - 1) as usize];
        let entry = rosters
            .iter()
            .find(|signed| roster_digest(signed.statement.clone()) == *digest)
            .and_then(|signed| parse_roster(&signed.statement).ok())
            .and_then(|roster| roster.entry(&user_id).cloned());
        if !entry_is_pin(entry.as_ref(), &pin) {
            return Ok(MemberJoinCode::OtherKeys { roster_version: version });
        }
        Ok(MemberJoinCode::Code { roster_version: version, code: code_at(&chain, version)? })
    }

    /// An outbox entry read back after a lock or a relaunch, the worker's
    /// outbox reading (`readOutboxEntry`): `entry`, kept under `outbox_id` for
    /// `group_id` by `user_id`, opened under the device store key, then
    /// answered against the committed chain: [`OutboxCall::Landed`] when it
    /// holds the call's roster, [`OutboxCall::Superseded`] when it moved off
    /// the head the call was built on, [`OutboxCall::Hold`] when it is never
    /// sent (an admission is sent only while this account's contact pin of the
    /// person, from the settings it last opened, holds the keys the entry was
    /// built from, by key commitment; an app asks again before every attempt,
    /// after each wait and fix, since the pin can move between them), and only otherwise [`OutboxCall::Send`] with the very
    /// bytes the call was signed as. `CoreError::Sealed`: the entry did not
    /// open (another account root, after a master-key rotation; another
    /// family) or is not an entry, or not the one kept under `outbox_id`:
    /// delete it and tell the person a change was lost. Any other error
    /// (locked, `user_id` not the account unlocked) keeps it.
    ///
    /// ```
    /// use hushos_core::*;
    /// let ledger = AreaLedger::new();
    /// let user = "00000001-abcd-4abc-8abc-abcdefabcdef".to_string();
    /// let identity = identity_create(user.clone(), vec![7u8; 32], 1)?;
    /// ledger.open_account(user.clone(), base64url_decode(identity.signing_public_key.clone())?, vec![7u8; 32])?;
    /// let group = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".to_string();
    /// let id = "11111111-1111-4111-8111-111111111111".to_string();
    /// // Bytes that are no entry of this account's: unreadable, so the app deletes them.
    /// let lost = ledger.outbox_open(group.clone(), id.clone(), user, "AAAA".into());
    /// assert!(matches!(lost, Err(CoreError::Sealed(_))));
    /// // Asked for another account: an input error, and nothing is deleted.
    /// let other = ledger.outbox_open(group, id, "00000002-abcd-4abc-8abc-abcdefabcdef".into(), "AAAA".into());
    /// assert!(matches!(other, Err(CoreError::Input(_))));
    /// # Ok::<(), hushos_core::CoreError>(())
    /// ```
    pub fn outbox_open(
        &self,
        group_id: String,
        outbox_id: String,
        user_id: String,
        entry: String,
    ) -> CoreResult<OutboxCall> {
        let account = self.served_account().ok_or_else(|| input(NO_ACCOUNT))?;
        if !user_id.eq_ignore_ascii_case(&account.user_id) {
            return Err(input(OTHER_ACCOUNT));
        }
        let plaintext = open_bytes(&account.store_key, &account.user_id, &group_id, OUTBOX, &entry)?;
        let value: Value =
            serde_json::from_slice(&plaintext).map_err(|_| CoreError::Sealed(RECORD_UNREADABLE.into()))?;
        let head = self.call_state(&group_id).chain.map(|chain| chain.roster_digests.clone());
        let lookup = |user: &str| {
            let pin = self.contact_pin(user)?;
            Some((pin.user_id.to_lowercase(), pin_commitment(&pin)?))
        };
        let reading = Reading { id: Some(&outbox_id), pin: &lookup, head: head.as_deref() };
        entry_read(&value, &group_id, &reading).ok_or_else(|| CoreError::Sealed(NOT_AN_ENTRY.into()))
    }
}

#[cfg(test)]
type LedgerHook = Option<Box<dyn Fn(&AreaLedger)>>;
#[cfg(test)]
thread_local! {
    static AFTER_SIGNING: std::cell::RefCell<LedgerHook> = const { std::cell::RefCell::new(None) };
    static AFTER_OPENING: std::cell::RefCell<LedgerHook> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
mod tests;
