//! Who opens which company folder (docs/companies-design.md 2.3), as
//! `packages/crypto/src/area-lists.ts` has it: the signed list of an area,
//! base lists and additions, the heads every roster commits to, the four
//! states a device can be in against the furthest committed head (level,
//! behind, ahead, forked), settling a fork and its signed dismissal, and the
//! resolver ([`area_access`]). The shared company fixtures hold both twins to
//! the same verdict at every step, the record a device keeps included.
//!
//! A list is a long-lived signed statement: it is judged at the roster it
//! names, under the keys its signer's entry named there
//! ([`OrgChain::signer_keys`]), with the standing its signer had there
//! (`active`, `data_admins`), never by what the latest roster says of them.
//! What a signer could still sign after their standing ended is bounded by
//! the heads the roster that ended it committed ([`AFTER_LEAVING`]).
//!
//! Families have no lists: every member of a family opens every area, and
//! nothing here applies to one.

use crate::bytes::{decode, encode, random};
use crate::canonical::{
    ascending, bytes_of, digest_of, encode_statement, integer, number, parse_statement, require_canonical,
    text, uuid,
};
use crate::error::{input, CoreError, CoreResult};
use crate::group_trust::{AcceptedRosters, DataAdminSpan, OrgChain, SignerKeysAt};
use crate::groups::{
    same_group, sealed_at_latest, sealer_holds, AreaKind, GroupKind, GroupRole, RosterMember, RETIRED,
};
use crate::identity::IdentityKeys;
use crate::pq::ML_DSA_PUBLIC_KEY_BYTES;
use crate::signatures::{digest, sign_hybrid, verify_hybrid, HybridPublicKey, HYBRID_SIGNATURE_BYTES};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/* The statement (2.3) */

/// What a list gives someone on it. Byte order is the order a statement sorts
/// them in nowhere: people are sorted by id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ListRole {
    Editor,
    Manager,
    Viewer,
}

impl ListRole {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ListRole::Editor => "editor",
            ListRole::Manager => "manager",
            ListRole::Viewer => "viewer",
        }
    }

    fn parse(value: &str) -> CoreResult<Self> {
        match value {
            "editor" => Ok(ListRole::Editor),
            "manager" => Ok(ListRole::Manager),
            "viewer" => Ok(ListRole::Viewer),
            _ => Err(input("Invalid list role.")),
        }
    }
}

/* viewer < editor < manager, and nothing below them all. */
fn rank(role: Option<ListRole>) -> u8 {
    match role {
        None => 0,
        Some(ListRole::Viewer) => 1,
        Some(ListRole::Editor) => 2,
        Some(ListRole::Manager) => 3,
    }
}

/* `everyone` as a statement carries it: "", "editor" or "viewer". */
fn everyone_str(everyone: Option<ListRole>) -> CoreResult<&'static str> {
    match everyone {
        None => Ok(""),
        Some(ListRole::Manager) => Err(input("Invalid list role.")),
        Some(role) => Ok(role.as_str()),
    }
}

/// The most people one list names (2.3).
pub const MAX_LIST_PEOPLE: u64 = 10_000;
/* A list's nonce: 16 random bytes, new in every statement. */
const LIST_NONCE_BYTES: usize = 16;

/// One person on a list, and as what.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ListPerson {
    pub user_id: String,
    pub role: ListRole,
}

/// An area's list statement (2.3). `previous_list_digest` is empty for a base
/// list; `roster_version` 0 with an empty `roster_digest` only for a base list
/// roster 1 commits; `everyone` is `None`, `Editor` or `Viewer`; `people` is
/// sorted by user id, nobody twice.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct AreaList {
    pub group_id: String,
    pub workspace_id: String,
    pub list_version: u64,
    pub previous_list_digest: String,
    pub workspace_key_version: u64,
    pub signer_user_id: String,
    pub signer_key_version: u64,
    pub roster_version: u64,
    pub roster_digest: String,
    pub nonce: String,
    #[cfg_attr(feature = "uniffi", uniffi(default = None))]
    pub everyone: Option<ListRole>,
    #[cfg_attr(feature = "uniffi", uniffi(default = []))]
    pub people: Vec<ListPerson>,
}

const AREA_LIST_DOMAIN: &str = "hushos/group/area-list";

/// The bytes of an area list statement:
/// `["hushos/group/area-list",1,groupId,workspaceId,listVersion,previousListDigest,workspaceKeyVersion,signerUserId,signerKeyVersion,rosterVersion,rosterDigest,nonce,everyone,people]`.
///
/// ```
/// use hushos_core::*;
/// let digest = roster_digest(b"the roster before".to_vec());
/// let list = AreaList {
///     group_id: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".into(),
///     workspace_id: "80558a81-8dfc-8914-8447-0417b55e2ec5".into(),
///     list_version: 1,
///     previous_list_digest: String::new(),
///     workspace_key_version: 1,
///     signer_user_id: "00000001-abcd-4abc-8abc-abcdefabcdef".into(),
///     signer_key_version: 1,
///     roster_version: 3,
///     roster_digest: digest,
///     nonce: base64url_encode(vec![7; 16]),
///     everyone: None,
///     people: vec![ListPerson { user_id: "00000001-abcd-4abc-8abc-abcdefabcdef".into(), role: ListRole::Manager }],
/// };
/// let statement = area_list_statement(list.clone())?;
/// assert_eq!(area_list_parse(statement.clone())?, list);
/// // Another nonce is another digest: a digest says nothing of a small folder's people.
/// let again = area_list_statement(AreaList { nonce: base64url_encode(vec![8; 16]), ..list.clone() })?;
/// assert_ne!(roster_digest(again), roster_digest(statement));
/// // An addition names a roster: 0 and no digest are a base list's alone.
/// let unanchored = AreaList { roster_version: 0, roster_digest: String::new(), ..list.clone() };
/// assert!(area_list_statement(unanchored.clone()).is_ok());
/// assert!(area_list_statement(AreaList { previous_list_digest: roster_digest(vec![1]), ..unanchored }).is_err());
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn area_list_statement(list: AreaList) -> CoreResult<Vec<u8>> {
    area_list_bytes(&list)
}

fn area_list_bytes(list: &AreaList) -> CoreResult<Vec<u8>> {
    if list.people.len() as u64 > MAX_LIST_PEOPLE {
        return Err(input("Invalid list people."));
    }
    let people = list
        .people
        .iter()
        .map(|person| Ok(json!([uuid(&person.user_id, "user id")?, person.role.as_str()])))
        .collect::<CoreResult<Vec<_>>>()?;
    ascending(&list.people.iter().map(|person| person.user_id.as_str()).collect::<Vec<_>>(), "list people")?;
    let base = list.previous_list_digest.is_empty();
    // Roster 0 and no digest go together, and only on a base list: the one roster 1 commits.
    let unanchored = list.roster_version == 0 && list.roster_digest.is_empty();
    if unanchored && !base {
        return Err(input("Invalid area list."));
    }
    encode_statement(&[
        json!(AREA_LIST_DOMAIN),
        json!(1),
        json!(uuid(&list.group_id, "group id")?),
        json!(uuid(&list.workspace_id, "workspace id")?),
        json!(integer(list.list_version, "list version")?),
        json!(if base { "" } else { digest_of(&list.previous_list_digest, "list digest")? }),
        json!(integer(list.workspace_key_version, "workspace key version")?),
        json!(uuid(&list.signer_user_id, "user id")?),
        json!(integer(list.signer_key_version, "key version")?),
        json!(if unanchored { 0 } else { integer(list.roster_version, "roster version")? }),
        json!(if unanchored { "" } else { digest_of(&list.roster_digest, "roster digest")? }),
        json!(bytes_of(&list.nonce, LIST_NONCE_BYTES, "list nonce")?),
        json!(everyone_str(list.everyone)?),
        json!(people),
    ])
}

/// The list a statement's bytes hold, refused unless the bytes are its
/// canonical encoding.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn area_list_parse(statement: Vec<u8>) -> CoreResult<AreaList> {
    parse_list(&statement)
}

/* An integer field that may be 0 (the statement grammar bounds it), or refused. */
fn count(value: &Value, what: &str) -> CoreResult<u64> {
    value.as_u64().ok_or_else(|| input(format!("Invalid {what}.")))
}

fn parse_list(statement: &[u8]) -> CoreResult<AreaList> {
    let parts = parse_statement(statement, "area list")?;
    if parts.len() != 14 || parts[0] != json!(AREA_LIST_DOMAIN) || parts[1] != json!(1) {
        return Err(input("Invalid area list."));
    }
    let people = parts[13]
        .as_array()
        .ok_or_else(|| input("Invalid area list."))?
        .iter()
        .map(|person| match person.as_array().map(Vec::as_slice) {
            Some([user_id, role]) => Ok(ListPerson {
                user_id: text(user_id, "user id")?.into(),
                role: ListRole::parse(text(role, "list role")?)?,
            }),
            _ => Err(input("Invalid list people.")),
        })
        .collect::<CoreResult<Vec<_>>>()?;
    let list = AreaList {
        group_id: text(&parts[2], "group id")?.into(),
        workspace_id: text(&parts[3], "workspace id")?.into(),
        list_version: number(&parts[4], "list version")?,
        previous_list_digest: text(&parts[5], "list digest")?.into(),
        workspace_key_version: number(&parts[6], "workspace key version")?,
        signer_user_id: text(&parts[7], "user id")?.into(),
        signer_key_version: number(&parts[8], "key version")?,
        // 0 only with no digest, on a base list: the re-encoding below holds it to that.
        roster_version: count(&parts[9], "roster version")?,
        roster_digest: text(&parts[10], "roster digest")?.into(),
        nonce: text(&parts[11], "list nonce")?.into(),
        everyone: match text(&parts[12], "list role")? {
            "" => None,
            role => Some(ListRole::parse(role)?),
        },
        people,
    };
    require_canonical(statement, &area_list_bytes(&list)?, "area list")?;
    Ok(list)
}

/// A list as the server stores and serves it: the statement and its signer's
/// hybrid identity signature (3373 bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SignedAreaList {
    pub statement: Vec<u8>,
    pub signature: Vec<u8>,
}

/* Heads (2.3) */

/// One area's head as a roster's signer verified it: its list and its share
/// log (an empty log is index 0 at [`share_log_start`]).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct HeadRow {
    pub workspace_id: String,
    pub workspace_key_version: u64,
    pub list_version: u64,
    pub list_digest: String,
    pub share_log_index: u64,
    pub share_log_digest: String,
}

fn head_row_parts(row: &HeadRow) -> CoreResult<Value> {
    if row.share_log_index > crate::signatures::MAX_SAFE_INTEGER {
        return Err(input("Invalid share log index."));
    }
    Ok(json!([
        uuid(&row.workspace_id, "workspace id")?,
        integer(row.workspace_key_version, "workspace key version")?,
        integer(row.list_version, "list version")?,
        digest_of(&row.list_digest, "list digest")?,
        row.share_log_index,
        digest_of(&row.share_log_digest, "share log digest")?,
    ]))
}

/// `SHA-256(["hushos/group/heads",1,groupId,rows])`, base64url: what a
/// roster's `heads` field carries. `rows` is every live area after that
/// roster, sorted by workspace id, none twice.
///
/// ```
/// use hushos_core::*;
/// let group = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".to_string();
/// let area = "80558a81-8dfc-8914-8447-0417b55e2ec5".to_string();
/// let row = HeadRow {
///     workspace_id: area.clone(),
///     workspace_key_version: 1,
///     list_version: 1,
///     list_digest: roster_digest(b"the base list".to_vec()),
///     share_log_index: 0,
///     share_log_digest: share_log_start(group.clone(), area)?,
/// };
/// let digest = heads_digest(group.clone(), vec![row.clone()])?;
/// assert_ne!(heads_digest(group.clone(), vec![HeadRow { list_version: 2, ..row.clone() }])?, digest);
/// // One row per area: a folder twice is no set of heads.
/// assert!(heads_digest(group, vec![row.clone(), row]).is_err());
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn heads_digest(group_id: String, rows: Vec<HeadRow>) -> CoreResult<String> {
    digest_of_rows(&group_id, &rows)
}

fn digest_of_rows(group_id: &str, rows: &[HeadRow]) -> CoreResult<String> {
    let parts = rows.iter().map(head_row_parts).collect::<CoreResult<Vec<_>>>()?;
    ascending(&rows.iter().map(|row| row.workspace_id.as_str()).collect::<Vec<_>>(), "heads")?;
    Ok(digest(&encode_statement(&[
        json!("hushos/group/heads"),
        json!(1),
        json!(uuid(group_id, "group id")?),
        json!(parts),
    ])?))
}

/// An empty share log's digest (2.4):
/// `SHA-256("hushos/group/share-log/v1" || groupId (36 ASCII bytes) || workspaceId (36))`,
/// base64url. What a heads row carries at index 0.
///
/// ```
/// use hushos_core::*;
/// let (group, area) = ("0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a", "80558a81-8dfc-8914-8447-0417b55e2ec5");
/// let start = share_log_start(group.into(), area.into())?;
/// assert_eq!(start, roster_digest(format!("hushos/group/share-log/v1{group}{area}").into_bytes()));
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn share_log_start(group_id: String, workspace_id: String) -> CoreResult<String> {
    log_start(&group_id, &workspace_id)
}

fn log_start(group_id: &str, workspace_id: &str) -> CoreResult<String> {
    let mut bytes = b"hushos/group/share-log/v1".to_vec();
    bytes.extend_from_slice(uuid(group_id, "group id")?.as_bytes());
    bytes.extend_from_slice(uuid(workspace_id, "workspace id")?.as_bytes());
    Ok(digest(&bytes))
}

/// A row as one roster committed it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct CommittedHead {
    pub roster_version: u64,
    pub workspace_key_version: u64,
    pub list_version: u64,
    pub list_digest: String,
    pub share_log_index: u64,
    pub share_log_digest: String,
}

impl CommittedHead {
    fn row(&self, workspace_id: &str) -> HeadRow {
        HeadRow {
            workspace_id: workspace_id.into(),
            workspace_key_version: self.workspace_key_version,
            list_version: self.list_version,
            list_digest: self.list_digest.clone(),
            share_log_index: self.share_log_index,
            share_log_digest: self.share_log_digest.clone(),
        }
    }
}

/// What a device keeps of the heads its chain's rosters committed (its own
/// record, local, never synced): through which roster, and for every area
/// each row a roster committed that differed from the one before, oldest
/// first. The furthest head of an area is the highest list version, and the
/// highest log position, any of them names ([`committed_head`]).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct HeadsRecord {
    pub group_id: String,
    pub roster_version: u64,
    pub roster_digest: String,
    pub areas: HashMap<String, Vec<CommittedHead>>,
}

/// The rows the server served with one roster: those that differ from the
/// roster before, or all of them.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ServedHeads {
    pub roster_version: u64,
    #[cfg_attr(feature = "uniffi", uniffi(default = []))]
    pub rows: Vec<HeadRow>,
}

/// A row that fell below one an earlier roster committed for the same area:
/// it moves nothing, and is what a device reports (route C33, `ahead`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct LoweredHead {
    pub roster_version: u64,
    pub workspace_id: String,
    pub list: bool,
    pub share_log: bool,
}

/// What [`heads_read`] returns: the record to keep, and the rows that fell back.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct HeadsRead {
    pub record: HeadsRecord,
    pub lowered: Vec<LoweredHead>,
}

/// The refusal of rows that are not what a roster's `headsDigest` commits to.
pub const HEADS_MISMATCH: &str = "These are not the folder records this member list commits to.";
const BAD_HEADS: &str = "Invalid heads record.";
const NOT_A_COMPANY: &str = "This is not a company.";
const NOT_AN_AREA: &str = "This folder is not one of the company’s.";

fn company_of(chain: &AcceptedRosters) -> CoreResult<&OrgChain> {
    chain.org.as_ref().filter(|_| chain.kind == GroupKind::Org).ok_or_else(|| input(NOT_A_COMPANY))
}

/* The span of `spans` that covers roster `at`, if any. */
fn span_at(spans: Option<&Vec<DataAdminSpan>>, at: u64) -> Option<&DataAdminSpan> {
    spans?.iter().find(|span| span.from <= at && span.until.is_none_or(|until| at < until))
}

/* An area's key version at roster `at`: how many of its keys the chain had listed by then. */
fn key_version_at(org: &OrgChain, workspace_id: &str, at: u64) -> u64 {
    org.area_rosters
        .get(workspace_id)
        .map_or(0, |rows| rows.iter().filter(|row| row.roster_version <= at).count()) as u64
}

/* The live areas after roster `at`, sorted: listed by then and not yet retired. */
fn live_areas_at(org: &OrgChain, at: u64) -> Vec<&String> {
    let mut live: Vec<&String> = org
        .area_rosters
        .keys()
        .filter(|id| {
            key_version_at(org, id, at) > 0
                && org.area_retired_at.get(*id).is_none_or(|retired| *retired > at)
        })
        .collect();
    live.sort();
    live
}

/* The full set of rows after roster `at`, from a record's deltas. */
fn rows_at(org: &OrgChain, areas: &HashMap<String, Vec<CommittedHead>>, at: u64) -> CoreResult<Vec<HeadRow>> {
    live_areas_at(org, at)
        .into_iter()
        .map(|workspace_id| {
            areas
                .get(workspace_id)
                .and_then(|rows| rows.iter().rfind(|row| row.roster_version <= at))
                .map(|row| row.row(workspace_id))
                .ok_or_else(|| input(BAD_HEADS))
        })
        .collect()
}

/* A record as stored, checked field by field and against the chain it is through. */
fn check_heads_record(chain: &AcceptedRosters, org: &OrgChain, record: &HeadsRecord) -> CoreResult<()> {
    let bad = || input(BAD_HEADS);
    let check = || -> CoreResult<()> {
        let through = integer(record.roster_version, "roster version")?;
        let on_chain = usize::try_from(through - 1).ok().and_then(|index| chain.roster_digests.get(index));
        if record.group_id != chain.group_id || on_chain != Some(&record.roster_digest) {
            return Err(bad());
        }
        for (workspace_id, rows) in &record.areas {
            if !org.area_rosters.contains_key(workspace_id) || rows.is_empty() {
                return Err(bad());
            }
            let mut floor = 0;
            for row in rows {
                let at = integer(row.roster_version, "roster version")?;
                if at <= floor || at > through {
                    return Err(bad());
                }
                floor = at;
                head_row_parts(&row.row(workspace_id))?;
            }
        }
        // The rows it holds for the roster it is through are the ones that roster commits to.
        let committed = digest_of_rows(&chain.group_id, &rows_at(org, &record.areas, through)?)?;
        if org.heads_digests.get((through - 1) as usize) != Some(&committed) {
            return Err(bad());
        }
        Ok(())
    };
    check().map_err(|_| bad())
}

/// Reads the rows served with each roster after the record (2.3, "Heads").
/// Each roster's full set is rebuilt from the one before: the areas it
/// retired drop out, the served rows replace or add. A set is taken only when
/// it is exactly the live areas after that roster, each at the key version
/// the chain gives it there (an empty log at its start digest), and hashes to
/// that roster's `headsDigest` on the chain; anything else is refused
/// ([`HEADS_MISMATCH`]) and nothing is taken. Rosters are read in order and
/// reading stops at the first one not served: the record says how far it got.
///
/// A record handed back is checked against the chain first: one edited, or of
/// another company, is refused. `lowered` lists the rows that fell below one
/// an earlier roster committed for the same area: they move nothing.
///
/// ```no_run
/// use hushos_core::*;
/// # fn read(chain: std::sync::Arc<AcceptedRosters>, kept: Option<HeadsRecord>, served: Vec<ServedHeads>) -> CoreResult<()> {
/// let read = heads_read(chain.clone(), kept, served)?;
/// // Keep `read.record`; report `read.lowered` (route C33, `ahead`).
/// assert!(read.record.roster_version <= chain.roster().roster_version);
/// assert!(read.lowered.iter().all(|row| row.roster_version <= read.record.roster_version));
/// # Ok(()) }
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn heads_read(
    chain: Arc<AcceptedRosters>,
    record: Option<HeadsRecord>,
    served: Vec<ServedHeads>,
) -> CoreResult<HeadsRead> {
    let org = company_of(&chain)?;
    let mismatch = || input(HEADS_MISMATCH);
    let (mut through, mut areas) = match record {
        Some(record) => {
            check_heads_record(&chain, org, &record)?;
            (record.roster_version, record.areas)
        }
        None => (0, HashMap::new()),
    };
    let mut lowered = Vec::new();
    for at in through + 1..=chain.roster_digests.len() as u64 {
        let mut given = served.iter().filter(|entry| entry.roster_version == at);
        let Some(entry) = given.next() else {
            break;
        };
        if given.next().is_some() {
            return Err(mismatch());
        }
        let live = live_areas_at(org, at);
        let mut seen = HashSet::new();
        for row in &entry.rows {
            head_row_parts(row)?;
            if !seen.insert(&row.workspace_id) || !live.contains(&&row.workspace_id) {
                return Err(mismatch());
            }
            if row.workspace_key_version != key_version_at(org, &row.workspace_id, at)
                || (row.share_log_index == 0
                    && row.share_log_digest != log_start(&chain.group_id, &row.workspace_id)?)
            {
                return Err(mismatch());
            }
            let history = areas.entry(row.workspace_id.clone()).or_default();
            let next = CommittedHead {
                roster_version: at,
                workspace_key_version: row.workspace_key_version,
                list_version: row.list_version,
                list_digest: row.list_digest.clone(),
                share_log_index: row.share_log_index,
                share_log_digest: row.share_log_digest.clone(),
            };
            if history.last().is_some_and(|before| before.row(&row.workspace_id) == *row) {
                continue;
            }
            let list = history.iter().any(|before| before.list_version > next.list_version);
            let share_log = history.iter().any(|before| before.share_log_index > next.share_log_index);
            if list || share_log {
                lowered.push(LoweredHead {
                    roster_version: at,
                    workspace_id: row.workspace_id.clone(),
                    list,
                    share_log,
                });
            }
            history.push(next);
        }
        // An area the rows never named has no set to stand in.
        areas.retain(|_, rows| !rows.is_empty());
        let rows = rows_at(org, &areas, at).map_err(|_| mismatch())?;
        if org.heads_digests.get((at - 1) as usize) != Some(&digest_of_rows(&chain.group_id, &rows)?) {
            return Err(mismatch());
        }
        through = at;
    }
    if through == 0 {
        return Err(mismatch());
    }
    Ok(HeadsRead {
        record: HeadsRecord {
            group_id: chain.group_id.clone(),
            roster_version: through,
            roster_digest: chain.roster_digests[(through - 1) as usize].clone(),
            areas,
        },
        lowered,
    })
}

/// The furthest head a record's rosters committed for an area (2.3, "A
/// committed head never moves back"): the highest list version and the
/// highest log position, each with the first roster that committed it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct FurthestHead {
    pub list_roster_version: u64,
    pub workspace_key_version: u64,
    pub list_version: u64,
    pub list_digest: String,
    pub share_log_roster_version: u64,
    pub share_log_index: u64,
    pub share_log_digest: String,
}

/// The furthest head the record's rosters committed for an area; `None` for
/// an area no roster in the record names.
///
/// ```
/// use hushos_core::*;
/// let digest = |text: &str| roster_digest(text.as_bytes().to_vec());
/// let row = |roster_version, list_version, share_log_index| CommittedHead {
///     roster_version,
///     workspace_key_version: 1,
///     list_version,
///     list_digest: digest(&format!("list {list_version}")),
///     share_log_index,
///     share_log_digest: digest(&format!("log {share_log_index}")),
/// };
/// let area = "80558a81-8dfc-8914-8447-0417b55e2ec5".to_string();
/// let record = HeadsRecord {
///     group_id: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".into(),
///     roster_version: 5,
///     roster_digest: digest("roster 5"),
///     // Roster 5 signed from a stale read: a lower list, a longer log.
///     areas: [(area.clone(), vec![row(3, 1, 0), row(4, 3, 1), row(5, 2, 2)])].into(),
/// };
/// let head = committed_head(record.clone(), area).unwrap();
/// assert_eq!((head.list_version, head.list_roster_version), (3, 4));
/// assert_eq!((head.share_log_index, head.share_log_roster_version), (2, 5));
/// assert!(committed_head(record, "a0558a81-8dfc-4914-8447-0417b55e2ec5".into()).is_none());
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn committed_head(record: HeadsRecord, workspace_id: String) -> Option<FurthestHead> {
    furthest_of(record.areas.get(&workspace_id)?)
}

fn furthest_of(rows: &[CommittedHead]) -> Option<FurthestHead> {
    // A folder's list is judged at its current key (a new base list starts a new record), so the
    // furthest list is the furthest at the latest key the rows name; the share log runs through
    // the life of the area.
    let key_version = rows.last()?.workspace_key_version;
    let mut list: Option<&CommittedHead> = None;
    let mut log: Option<&CommittedHead> = None;
    for row in rows {
        if row.workspace_key_version == key_version
            && list.is_none_or(|at| row.list_version > at.list_version)
        {
            list = Some(row);
        }
        if log.is_none_or(|at| row.share_log_index > at.share_log_index) {
            log = Some(row);
        }
    }
    let (list, log) = (list?, log?);
    Some(FurthestHead {
        list_roster_version: list.roster_version,
        workspace_key_version: list.workspace_key_version,
        list_version: list.list_version,
        list_digest: list.list_digest.clone(),
        share_log_roster_version: log.roster_version,
        share_log_index: log.share_log_index,
        share_log_digest: log.share_log_digest.clone(),
    })
}

/* The four states (2.3, "Reading a new committed head") */

/// Where a device's verified record stands against the furthest committed
/// head, for a list or a share log alike (2.3, 2.4): level (the head is where
/// the record ends), behind (it is past the record, and the device has not
/// caught up yet), ahead (it is a point on the record, before its end), or
/// forked (anything else).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum HeadState {
    Level,
    Behind,
    Ahead,
    Forked,
}

/// The state of a record against a committed head. `digests` is the digest at
/// every position the device verified, from position `first` on; `reaches`
/// says whether what the server served extends the record to a head past it:
/// `Some(false)` when it answered and nothing reaches, `None` when it has not
/// answered (a request that fails is tried again and is not an answer).
///
/// ```
/// use hushos_core::*;
/// let record: Vec<String> = ["c", "d", "e"].map(String::from).into();
/// let state = |position, digest: &str, reaches| head_state(3, record.clone(), position, digest.into(), reaches);
/// assert_eq!(state(5, "e", None), HeadState::Level);
/// assert_eq!(state(4, "d", None), HeadState::Ahead);
/// assert_eq!(state(4, "x", None), HeadState::Forked);
/// assert_eq!(state(6, "f", None), HeadState::Behind);
/// // Answered, and nothing reaches the head: a device never stays behind.
/// assert_eq!(state(6, "f", Some(false)), HeadState::Forked);
/// assert_eq!(state(2, "b", None), HeadState::Forked);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn head_state(
    first: u64,
    digests: Vec<String>,
    position: u64,
    digest: String,
    reaches: Option<bool>,
) -> HeadState {
    state_of(first, &digests, position, &digest, reaches)
}

fn state_of(first: u64, digests: &[String], position: u64, digest: &str, reaches: Option<bool>) -> HeadState {
    let end = first + digests.len() as u64;
    if position >= end {
        return if reaches == Some(false) { HeadState::Forked } else { HeadState::Behind };
    }
    if position < first || digests[(position - first) as usize] != digest {
        return HeadState::Forked;
    }
    if position == end - 1 {
        HeadState::Level
    } else {
        HeadState::Ahead
    }
}

/* Verifying a list (2.3) */

/// The refusal of a list its signer signed after their standing ended, past
/// the heads the roster that ended it committed.
pub const AFTER_LEAVING: &str =
    "This was signed by someone who had lost the right to, past what the member list that ended it records.";
/// The refusal of a write in an area whose list is behind a committed head.
pub const HEAD_BEHIND: &str =
    "This folder’s record is behind the company’s: nothing is written here until this device has caught up.";
/// The refusal of a write in an area whose list is forked from a committed head.
pub const HEAD_FORKED: &str =
    "This folder’s record does not match the company’s: nothing is written here until that is settled.";
const NOT_THE_BASE: &str = "This is not the list the member list names for this folder key.";
const NOT_FOLLOWING_LIST: &str = "This list does not follow from the one before it.";
const NOT_ON_CHAIN: &str = "This list names a member list this device does not have.";
const NOT_ENTITLED: &str = "This list is not signed by a manager of the folder or an admin.";
const NOT_LIST_SIGNED: &str = "This list is not signed by the member it names.";
const NARROWS: &str =
    "A list after the first only adds people or raises a role: taking access away needs a key change.";
const NOT_ACTIVE: &str = "A list names only active members of the company.";
const EMPLOYEE_LIST: &str = "An employee’s folder is listed for its assignee alone.";
const LIST_STALE: &str =
    "This list was built on one the company’s record does not have: add the person again.";
const KEYS_REPLACED: &str = "This was signed with keys its signer has since replaced, past what the member list that replaced them records: it has to be signed again.";
const LIST_RIVAL: &str = "Another list stands at this version of the folder’s record.";
const NOTHING_ADDED: &str = "This adds nobody and raises no role on the folder’s list.";
const ENTRY_FROM_BEFORE: &str = "This person’s place on the list is from before they left: they are back on the folder at a higher role, or at its next key change.";
const HEADS_INCOMPLETE: &str = "This device has not read every folder’s record at its latest member list.";
const HEADS_NOT_BELOW: &str = "A member list’s heads never fall below what an earlier one committed.";
const BAD_RECORD: &str = "Invalid list record.";
const NOT_READ: &str = "This is not a list this device read at its latest member list.";

/// A list this device verified, as its record keeps it: when the heads were
/// read through `held_at` it first held it, and at `reported_at` it first
/// found it past the committed head and posted it again.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct StoredAreaList {
    pub statement: Vec<u8>,
    pub signature: Vec<u8>,
    pub held_at: u64,
    #[cfg_attr(feature = "uniffi", uniffi(default = None))]
    pub reported_at: Option<u64>,
}

/// A fork this device saw (2.3, "The note, and who clears it"): the head a
/// roster committed and the one this device held, the roster whose head
/// showed it, and whether the device has taken the committed record since.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ForkNote {
    pub kind: ForkKind,
    pub committed_position: u64,
    pub committed_digest: String,
    pub reported_position: u64,
    pub reported_digest: String,
    pub roster_version: u64,
    #[cfg_attr(feature = "uniffi", uniffi(default = false))]
    pub settled: bool,
}

fn same_note(a: &ForkNote, b: &ForkNote) -> bool {
    a.committed_position == b.committed_position
        && a.committed_digest == b.committed_digest
        && a.reported_position == b.reported_position
        && a.reported_digest == b.reported_digest
}

/// What a device keeps of one area's list (2.3, "What a device keeps"), in
/// its device record (local, never synced): the furthest committed head it
/// verified, with that list, and every list it has verified past it, its own
/// included. `digests` is every list it verified at this key version, the
/// base list first; `since` says from which roster each entry of the
/// committed list counts for its person (2.3, "After someone comes back").
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct AreaListRecord {
    pub group_id: String,
    pub workspace_id: String,
    pub workspace_key_version: u64,
    pub base_list_version: u64,
    pub digests: Vec<String>,
    pub committed_roster_version: u64,
    pub committed_list_version: u64,
    pub lists: Vec<StoredAreaList>,
    pub since: HashMap<String, u64>,
    #[cfg_attr(feature = "uniffi", uniffi(default = 0))]
    pub judged_through: u64,
    #[cfg_attr(feature = "uniffi", uniffi(default = []))]
    pub forks: Vec<ForkNote>,
}

/* A list as served or stored, parsed. */
#[derive(Clone)]
struct Parsed {
    list: AreaList,
    statement: Vec<u8>,
    signature: Vec<u8>,
    digest: String,
}

/* One verified point on a list's record. */
#[derive(Clone)]
struct Step {
    at: Parsed,
    since: HashMap<String, u64>,
}

struct Ctx<'a> {
    chain: &'a AcceptedRosters,
    org: &'a OrgChain,
    workspace_id: String,
    kind: AreaKind,
    key_version: u64,
    /* The roster that listed this key version, and so committed its base list. */
    committed_at: u64,
    committed_by: String,
    base_digest: String,
    /* The rows the chain's rosters committed for this area, oldest first; None while the heads are not read through the head. */
    rows: Option<Vec<CommittedHead>>,
    ml_dsa_keys: &'a HashMap<String, String>,
}

/* The keys a list's signer's entry named at the roster the list names (roster 1's for a list that names none). */
fn keys_at<'a>(org: &'a OrgChain, user_id: &str, roster_version: u64) -> Option<&'a SignerKeysAt> {
    org.signer_keys.get(user_id)?.iter().rfind(|span| span.from <= roster_version.max(1))
}

/*
 * The first roster after `roster_version` on which the signer's entry names
 * other signing keys than it did there; None while it never has.
 */
fn keys_replaced_at(org: &OrgChain, user_id: &str, roster_version: u64) -> Option<u64> {
    let spans = org.signer_keys.get(user_id)?;
    let at = spans.iter().rposition(|span| span.from <= roster_version.max(1))?;
    let named = &spans[at];
    spans[at + 1..]
        .iter()
        .find(|span| {
            span.signing_public_key != named.signing_public_key
                || span.ml_dsa_public_key_digest != named.ml_dsa_public_key_digest
        })
        .map(|span| span.from)
}

fn signed_at(ctx: &Ctx, list: &AreaList, statement: &[u8], signature: &[u8]) -> bool {
    let Some(named) = keys_at(ctx.org, &list.signer_user_id, list.roster_version) else {
        return false;
    };
    if named.key_version != list.signer_key_version || signature.len() != HYBRID_SIGNATURE_BYTES {
        return false;
    }
    let Some(ml_dsa_public_key) = ctx
        .ml_dsa_keys
        .get(&named.ml_dsa_public_key_digest)
        .and_then(|key| decode("mlDsaPublicKey", key, Some(ML_DSA_PUBLIC_KEY_BYTES)).ok())
        .filter(|key| digest(key) == named.ml_dsa_public_key_digest)
    else {
        return false;
    };
    decode("signingPublicKey", &named.signing_public_key, Some(32)).is_ok_and(|signing_public_key| {
        verify_hybrid(&HybridPublicKey { signing_public_key, ml_dsa_public_key }, statement, signature)
    })
}

/* What a served or stored list is, parsed: None when its bytes are no list of this area. */
fn parsed(ctx: &Ctx, statement: &[u8], signature: &[u8]) -> Option<Parsed> {
    let list = parse_list(statement).ok()?;
    if signature.len() != HYBRID_SIGNATURE_BYTES
        || list.group_id != ctx.chain.group_id
        || list.workspace_id != ctx.workspace_id
    {
        return None;
    }
    Some(Parsed {
        list,
        statement: statement.to_vec(),
        signature: signature.to_vec(),
        digest: digest(statement),
    })
}

fn active_at<'a>(org: &'a OrgChain, user_id: &str, at: u64) -> Option<&'a DataAdminSpan> {
    span_at(org.active.get(user_id), at)
}

/*
 * A base list (2.3): its digest is the roster row's; its signer is that
 * roster's signer; it names the roster before that one (0 and "" under roster
 * 1); it follows nothing; everyone it names is active on the roster that
 * commits it; and an employee area's is its assignee alone, as manager.
 */
fn check_base(ctx: &Ctx, at: &Parsed, verify: bool) -> CoreResult<Step> {
    let list = &at.list;
    let before = ctx.committed_at - 1;
    let named = if before == 0 { "" } else { ctx.chain.roster_digests[(before - 1) as usize].as_str() };
    if at.digest != ctx.base_digest
        || !list.previous_list_digest.is_empty()
        || list.workspace_key_version != ctx.key_version
        || list.signer_user_id != ctx.committed_by
        || list.roster_version != before
        || list.roster_digest != named
        // An area's first list is list 1, and the version counts up through every folder key:
        // the base list of key version n is list n at the least.
        || (if ctx.key_version == 1 { list.list_version != 1 } else { list.list_version < ctx.key_version })
    {
        return Err(input(NOT_THE_BASE));
    }
    if ctx.kind == AreaKind::Employee
        && (list.everyone.is_some() || list.people.len() != 1 || list.people[0].role != ListRole::Manager)
    {
        return Err(input(EMPLOYEE_LIST));
    }
    if list.people.iter().any(|person| active_at(ctx.org, &person.user_id, ctx.committed_at).is_none()) {
        return Err(input(NOT_ACTIVE));
    }
    if verify && !signed_at(ctx, list, &at.statement, &at.signature) {
        return Err(input(NOT_LIST_SIGNED));
    }
    // A base list's entries count from the roster that commits it.
    let since = list.people.iter().map(|person| (person.user_id.clone(), ctx.committed_at)).collect();
    Ok(Step { at: at.clone(), since })
}

/* The furthest list version the rosters up to `through` committed for this area at this key version; 0 for none. */
fn committed_through(ctx: &Ctx, through: u64) -> u64 {
    ctx.rows
        .iter()
        .flatten()
        .filter(|row| row.roster_version <= through && row.workspace_key_version == ctx.key_version)
        .map(|row| row.list_version)
        .max()
        .unwrap_or(0)
}

fn role_of(list: &AreaList, user_id: &str) -> Option<ListRole> {
    list.people.iter().find(|person| person.user_id == user_id).map(|person| person.role)
}

/*
 * An addition (2.3): it follows the list before it by version and digest;
 * names a roster on the reader's chain; is signed, under the keys their entry
 * named there, by someone active on that roster who was a manager on the list
 * before it (by an entry that counted for them then) or held `members`; only
 * adds people, raises a role or raises `everyone`; and everyone it adds or
 * raises is active on the roster it names. An employee area takes none. And
 * where its signer's standing ended on a later roster of the chain, it is
 * within the heads committed up to that roster, or refused (AFTER_LEAVING).
 */
fn check_addition(ctx: &Ctx, prev: &Step, at: &Parsed, verify: bool) -> CoreResult<Step> {
    let (list, org) = (&at.list, ctx.org);
    if list.list_version != prev.at.list.list_version + 1
        || list.previous_list_digest != prev.at.digest
        || list.workspace_key_version != ctx.key_version
    {
        return Err(input(NOT_FOLLOWING_LIST));
    }
    if ctx.kind == AreaKind::Employee {
        return Err(input(EMPLOYEE_LIST));
    }
    let named = list.roster_version;
    let on_chain =
        named >= 1 && ctx.chain.roster_digests.get((named - 1) as usize) == Some(&list.roster_digest);
    if !on_chain {
        return Err(input(NOT_ON_CHAIN));
    }
    // Who signed it, as the roster it names knew them.
    let active = active_at(org, &list.signer_user_id, named).ok_or_else(|| input(NOT_ENTITLED))?;
    // Whoever held `members` at a roster: rule 3 gives `members` and `data_admin` together.
    let holder = span_at(org.data_admins.get(&list.signer_user_id), named);
    let manager = role_of(&prev.at.list, &list.signer_user_id) == Some(ListRole::Manager)
        && prev.since.get(&list.signer_user_id).copied().unwrap_or(0) >= active.from;
    if !manager && holder.is_none() {
        return Err(input(NOT_ENTITLED));
    }
    // Only more: nobody dropped, no role lowered, `everyone` not lowered.
    if rank(list.everyone) < rank(prev.at.list.everyone)
        || prev
            .at
            .list
            .people
            .iter()
            .any(|person| rank(role_of(list, &person.user_id)) < rank(Some(person.role)))
    {
        return Err(input(NARROWS));
    }
    // Everyone it adds or raises is active on the roster it names, and counts from it.
    let mut since = HashMap::new();
    for person in &list.people {
        if role_of(&prev.at.list, &person.user_id) == Some(person.role) {
            since.insert(person.user_id.clone(), prev.since.get(&person.user_id).copied().unwrap_or(0));
            continue;
        }
        if active_at(org, &person.user_id, named).is_none() {
            return Err(input(NOT_ACTIVE));
        }
        since.insert(person.user_id.clone(), named);
    }
    if verify && !signed_at(ctx, list, &at.statement, &at.signature) {
        return Err(input(NOT_LIST_SIGNED));
    }
    // After leaving: the roster that ended the standing it was signed with bounds it. A manager's
    // ends when they are marked left; someone who signed as an admin alone, when `members` goes.
    // And a key change is treated like leaving: the roster that moved the signer's entry to
    // other signing keys bounds what the earlier keys signed, or whoever holds a manager's old
    // keys could add anyone under any earlier roster's name. The earlier of the two decides.
    let left = if manager { active.until } else { holder.and_then(|span| span.until).or(active.until) };
    let rekeyed = keys_replaced_at(org, &list.signer_user_id, named);
    let (ended, why) = match (left, rekeyed) {
        (Some(left), Some(rekeyed)) if rekeyed < left => (Some(rekeyed), KEYS_REPLACED),
        (Some(left), _) => (Some(left), AFTER_LEAVING),
        (None, rekeyed) => (rekeyed, KEYS_REPLACED),
    };
    if ended.is_some_and(|ended| committed_through(ctx, ended) < list.list_version) {
        return Err(input(why));
    }
    Ok(Step { at: at.clone(), since })
}

/// A list not taken, or dropped from the record, with the rule that refused it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ListRefusal {
    pub list_version: u64,
    pub list_digest: String,
    pub reason: String,
}

/// Someone on a list, with the roster their entry counts from.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ListedPerson {
    pub user_id: String,
    pub role: ListRole,
    pub since: u64,
}

/// What to tell the server of a list (route C33): this device is ahead of a
/// roster's head, or forked from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum HeadReport {
    Ahead,
    Fork,
}

/// A list read against the chain, as plain values ([`AreaLists::view`]).
///
/// - `workspace_key_version` is the chain's for the area, and
///   `roster_version` the roster this was read at;
/// - `list_version` is 0, with no people, when the device has verified no
///   list at that key version;
/// - `record` is what to keep and pass back next time;
/// - `repost` is what the device holds past the committed head: posted again
///   when it is ahead or forked;
/// - `missing` says a roster after the one the device posted again at still
///   lacks a list it holds ("An admin needs to look.");
/// - `refused` lists what was not taken or was dropped, and `lost` the people
///   a dropped or passed-over list had added ("Add them again.");
/// - `fork` is the fork this reading found: the one the device is in and has
///   not settled; or, settled as it is noted, a committed head it passed over
///   because nothing reaches it and a later roster's head is on its record;
/// - `head` is the committed head this was judged against (the furthest any
///   roster committed at this folder key, or the latest roster's where
///   nothing reaches the furthest; `None` while the heads are not read), and
///   `furthest_list_version` the highest list version any roster committed
///   for the area at any folder key: a later base list is numbered past it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct AreaListsView {
    pub group_id: String,
    pub workspace_id: String,
    pub area_kind: AreaKind,
    pub workspace_key_version: u64,
    pub roster_version: u64,
    pub roster_digest: String,
    pub state: HeadState,
    pub list_version: u64,
    pub list_digest: String,
    pub everyone: Option<ListRole>,
    pub people: Vec<ListedPerson>,
    pub record: Option<AreaListRecord>,
    pub repost: Vec<SignedAreaList>,
    pub report: Option<HeadReport>,
    pub missing: bool,
    pub refused: Vec<ListRefusal>,
    pub lost: Vec<ListPerson>,
    pub fork: Option<ForkNote>,
    pub head: Option<ListHead>,
    pub furthest_list_version: u64,
}

/// A committed head of a folder's list: the roster that committed it, and the
/// list's version and digest.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ListHead {
    pub roster_version: u64,
    pub list_version: u64,
    pub list_digest: String,
}

/// An area's list as this device read it at its latest roster: what
/// [`area_lists_read`] and [`area_fork_settle`] return, and what the resolver,
/// the grant opener and the writer verdicts take. It has no constructor: a
/// list written out by hand entitles nobody.
#[derive(Debug)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct AreaLists {
    pub(crate) view: AreaListsView,
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl AreaLists {
    /// Everything this reading says, as plain values.
    pub fn view(&self) -> AreaListsView {
        self.view.clone()
    }

    /// Where the device stands against the furthest committed head.
    pub fn state(&self) -> HeadState {
        self.view.state
    }

    /// What to keep and pass back next time; `None` when nothing was verified.
    pub fn record(&self) -> Option<AreaListRecord> {
        self.view.record.clone()
    }
}

/* Only a list read at this chain's latest roster. */
fn require_read<'a>(chain: &AcceptedRosters, lists: &'a AreaLists) -> CoreResult<&'a AreaListsView> {
    let view = &lists.view;
    if view.group_id != chain.group_id
        || view.roster_version != chain.roster.roster_version
        || view.roster_digest != chain.roster_digest
    {
        return Err(input(NOT_READ));
    }
    Ok(view)
}

fn context_of<'a>(
    chain: &'a AcceptedRosters,
    heads: Option<&HeadsRecord>,
    workspace_id: &str,
    ml_dsa_keys: &'a HashMap<String, String>,
) -> CoreResult<Ctx<'a>> {
    let org = company_of(chain)?;
    let workspace_id = uuid(workspace_id, "workspace id")?.to_string();
    let kind = *org.area_kinds.get(&workspace_id).ok_or_else(|| input(NOT_AN_AREA))?;
    if chain.retired_areas.contains(&workspace_id) {
        return Err(input(RETIRED));
    }
    let key_version = chain.area_keys.get(&workspace_id).map_or(0, Vec::len) as u64;
    let index = (key_version as usize).checked_sub(1).ok_or_else(|| input(NOT_AN_AREA))?;
    let listed = org.area_rosters.get(&workspace_id).and_then(|rows| rows.get(index));
    let base = org.area_lists.get(&workspace_id).and_then(|lists| lists.get(index));
    let (Some(listed), Some(base)) = (listed, base) else {
        return Err(input(NOT_AN_AREA));
    };
    let mut rows = None;
    if let Some(heads) = heads {
        check_heads_record(chain, org, heads)?;
        if heads.roster_version == chain.roster.roster_version {
            rows = Some(heads.areas.get(&workspace_id).cloned().unwrap_or_default());
        }
    }
    Ok(Ctx {
        chain,
        org,
        workspace_id,
        kind,
        key_version,
        committed_at: listed.roster_version,
        committed_by: listed.signer_user_id.clone(),
        base_digest: base.clone(),
        rows,
        ml_dsa_keys,
    })
}

/* A record as stored, checked against the chain. */
struct Kept {
    key_version: u64,
    base: u64,
    digests: Vec<String>,
    committed_roster_version: u64,
    committed_list_version: u64,
    first: Step,
    later: Vec<Parsed>,
    stored: Vec<StoredAreaList>,
    judged_through: u64,
    forks: Vec<ForkNote>,
}

impl Kept {
    fn end(&self) -> &Parsed {
        self.later.last().unwrap_or(&self.first.at)
    }
}

fn record_steps(ctx: &Ctx, record: &AreaListRecord) -> CoreResult<Kept> {
    let bad = || input(BAD_RECORD);
    let check = || -> CoreResult<Kept> {
        let key_version = integer(record.workspace_key_version, "workspace key version")?;
        let base = integer(record.base_list_version, "list version")?;
        if record.group_id != ctx.chain.group_id
            || record.workspace_id != ctx.workspace_id
            || key_version > ctx.key_version
            || record.lists.is_empty()
        {
            return Err(bad());
        }
        for at in &record.digests {
            digest_of(at, "list digest")?;
        }
        // The base it stands on is the one the chain names for that key version.
        let named =
            ctx.org.area_lists.get(&ctx.workspace_id).and_then(|lists| lists.get((key_version - 1) as usize));
        if record.digests.first() != named {
            return Err(bad());
        }
        let committed_roster_version = integer(record.committed_roster_version, "roster version")?;
        let committed_list_version = integer(record.committed_list_version, "list version")?;
        let end = base + record.digests.len() as u64 - 1;
        if committed_roster_version > ctx.chain.roster_digests.len() as u64
            || committed_list_version < base
            || committed_list_version + record.lists.len() as u64 - 1 != end
        {
            return Err(bad());
        }
        let mut steps: Vec<Parsed> = Vec::new();
        for (index, stored) in record.lists.iter().enumerate() {
            let at = parsed(ctx, &stored.statement, &stored.signature).ok_or_else(bad)?;
            let version = committed_list_version + index as u64;
            if at.list.list_version != version
                || at.list.workspace_key_version != key_version
                || at.digest != record.digests[(version - base) as usize]
                || (index > 0 && at.list.previous_list_digest != steps[index - 1].digest)
            {
                return Err(bad());
            }
            integer(stored.held_at, "roster version")?;
            if let Some(reported) = stored.reported_at {
                integer(reported, "roster version")?;
            }
            steps.push(at);
        }
        let mut since = HashMap::new();
        for person in &steps[0].list.people {
            let from = record.since.get(&person.user_id).ok_or_else(bad)?;
            since.insert(person.user_id.clone(), integer(*from, "roster version")?);
        }
        if record.since.len() != since.len() {
            return Err(bad());
        }
        for note in &record.forks {
            if note.kind != ForkKind::List {
                return Err(bad());
            }
            integer(note.committed_position, "list version")?;
            digest_of(&note.committed_digest, "list digest")?;
            integer(note.reported_position, "list version")?;
            digest_of(&note.reported_digest, "list digest")?;
            integer(note.roster_version, "roster version")?;
        }
        if record.judged_through > crate::signatures::MAX_SAFE_INTEGER {
            return Err(bad());
        }
        let first = Step { at: steps.remove(0), since };
        Ok(Kept {
            key_version,
            base,
            digests: record.digests.clone(),
            committed_roster_version,
            committed_list_version,
            first,
            later: steps,
            stored: record.lists.clone(),
            judged_through: record.judged_through,
            forks: record.forks.clone(),
        })
    };
    check().map_err(|_| bad())
}

/* The people a list holds beyond another: new, or at a higher role. */
fn beyond(list: &AreaList, than: &AreaList) -> Vec<ListPerson> {
    list.people
        .iter()
        .filter(|person| rank(Some(person.role)) > rank(role_of(than, &person.user_id)))
        .cloned()
        .collect()
}

fn refusal(at: &Parsed, reason: &str) -> ListRefusal {
    ListRefusal { list_version: at.list.list_version, list_digest: at.digest.clone(), reason: reason.into() }
}

fn reason_of(error: &CoreError) -> String {
    error.to_string()
}

/*
 * The first of a list's served copies that `check` takes. A server may serve
 * one list twice, or once with its signature damaged: no copy stands in the
 * way of another. When none is taken, the first copy's refusal is recorded.
 */
fn first_taken(
    copies: &[&Parsed],
    check: &dyn Fn(&Parsed) -> CoreResult<Step>,
    refused: &mut Vec<ListRefusal>,
) -> Option<Step> {
    let mut why: Option<String> = None;
    for at in copies {
        match check(at) {
            Ok(step) => return Some(step),
            Err(error) => {
                why.get_or_insert_with(|| reason_of(&error));
            }
        }
    }
    refused.push(refusal(copies[0], &why.unwrap_or_default()));
    None
}

/*
 * Takes, in turn, the served list that follows the last step; stops where
 * none does. Where two lists that both verify stand at one version, the one
 * a roster committed at that version is taken (the first roster's to name
 * the version, as heads_of reads the rows); where no roster committed either,
 * the one with the lower digest, whatever order they were served in. The
 * other is refused as a rival (LIST_RIVAL): the server does not choose, a
 * rival a signer made later does not displace what the chain committed, and
 * the device reports it as a fork.
 */
fn extend(ctx: &Ctx, steps: &mut Vec<Step>, served: &[Parsed], refused: &mut Vec<ListRefusal>) {
    loop {
        let end = steps.last().expect("a record has a first step").clone();
        let next_version = end.at.list.list_version + 1;
        // Each list's copies, in the order first served.
        let mut groups: Vec<Vec<&Parsed>> = Vec::new();
        for at in served.iter().filter(|at| {
            at.list.workspace_key_version == ctx.key_version && at.list.list_version == next_version
        }) {
            match groups.iter_mut().find(|group| group[0].digest == at.digest) {
                Some(group) => group.push(at),
                None => groups.push(vec![at]),
            }
        }
        let mut valid: Vec<Step> = Vec::new();
        for group in &groups {
            // A served list at the next version that does not follow this record is never taken.
            if group[0].list.previous_list_digest != end.at.digest {
                refused.push(refusal(group[0], NOT_FOLLOWING_LIST));
                continue;
            }
            if let Some(step) = first_taken(group, &|at| check_addition(ctx, &end, at, true), refused) {
                valid.push(step);
            }
        }
        if valid.is_empty() {
            return;
        }
        valid.sort_by(|x, y| x.at.digest.cmp(&y.at.digest));
        let committed = ctx.rows.iter().flatten().find_map(|row| {
            (row.workspace_key_version == ctx.key_version && row.list_version == next_version)
                .then(|| valid.iter().position(|at| at.at.digest == row.list_digest))
                .flatten()
        });
        let taken = valid.remove(committed.unwrap_or(0));
        for rival in &valid {
            refused.push(refusal(&rival.at, LIST_RIVAL));
        }
        steps.push(taken);
    }
}

/* The base list among what was served, and every addition that follows it in turn. */
fn from_base(ctx: &Ctx, served: &[Parsed], refused: &mut Vec<ListRefusal>) -> Option<Vec<Step>> {
    let copies: Vec<&Parsed> = served.iter().filter(|at| at.digest == ctx.base_digest).collect();
    if copies.is_empty() {
        return None;
    }
    let first = first_taken(&copies, &|at| check_base(ctx, at, true), refused)?;
    let mut steps = vec![first];
    extend(ctx, &mut steps, served, refused);
    Some(steps)
}

/*
 * The heads to judge this area's list by, at this key version: the furthest
 * any roster committed, and after it the latest roster's when that is
 * another. A device goes by the furthest. Only where nothing served reaches a
 * furthest head that lies past the end of its record does it judge by the
 * latest roster's, noting the head it passed over (2.3, "A committed head
 * nothing reaches"); a furthest head at a version the record holds, with
 * another digest, is a fork whatever a later roster says.
 */
fn heads_of(ctx: &Ctx) -> CoreResult<Vec<CommittedHead>> {
    let mut head: Option<&CommittedHead> = None;
    let mut latest: Option<&CommittedHead> = None;
    for row in ctx.rows.iter().flatten().filter(|row| row.workspace_key_version == ctx.key_version) {
        if head.is_none_or(|at| row.list_version > at.list_version) {
            head = Some(row);
        }
        latest = Some(row);
    }
    let (Some(head), Some(latest)) = (head, latest) else {
        return Err(input(HEADS_MISMATCH));
    };
    Ok(if latest == head { vec![head.clone()] } else { vec![head.clone(), latest.clone()] })
}

/* The head a run of steps reaches, with its place, and the furthest head when that was passed over. */
struct Reached {
    head: CommittedHead,
    anchor: usize,
    passed_over: Option<CommittedHead>,
}

/*
 * The head `steps` reach: the furthest, or, where the furthest lies past
 * their end, the latest roster's. None when they reach neither.
 */
fn reached(steps: &[Step], heads: &[CommittedHead]) -> Option<Reached> {
    let place = |head: &CommittedHead| {
        steps.iter().position(|step| {
            step.at.list.list_version == head.list_version && step.at.digest == head.list_digest
        })
    };
    if let Some(anchor) = place(&heads[0]) {
        return Some(Reached { head: heads[0].clone(), anchor, passed_over: None });
    }
    let end = steps.last().map_or(0, |step| step.at.list.list_version);
    let later = heads.get(1).filter(|_| heads[0].list_version > end)?;
    place(later).map(|anchor| Reached { head: later.clone(), anchor, passed_over: Some(heads[0].clone()) })
}

/*
 * The notes a record carries once the device is no longer forked: every one
 * settled, none dropped (only its person clears a note); and a head it passed
 * over noted, and handed back to be reported, the first time.
 */
fn notes_after(
    forks: &[ForkNote],
    passed_over: Option<&CommittedHead>,
    end: &Step,
) -> (Vec<ForkNote>, Option<ForkNote>) {
    let mut notes: Vec<ForkNote> =
        forks.iter().cloned().map(|note| ForkNote { settled: true, ..note }).collect();
    let Some(passed_over) = passed_over else {
        return (notes, None);
    };
    let at = notes.iter().position(|note| {
        note.committed_position == passed_over.list_version
            && note.committed_digest == passed_over.list_digest
    });
    if let Some(at) = at {
        let found = (!forks[at].settled).then(|| notes[at].clone());
        return (notes, found);
    }
    let note = ForkNote {
        kind: ForkKind::List,
        committed_position: passed_over.list_version,
        committed_digest: passed_over.list_digest.clone(),
        reported_position: end.at.list.list_version,
        reported_digest: end.at.digest.clone(),
        roster_version: passed_over.roster_version,
        settled: true,
    };
    notes.push(note.clone());
    (notes, Some(note))
}

fn signed_of(at: &Parsed) -> SignedAreaList {
    SignedAreaList { statement: at.statement.clone(), signature: at.signature.clone() }
}

#[derive(Default)]
struct More {
    repost: Vec<SignedAreaList>,
    report: Option<HeadReport>,
    missing: bool,
    refused: Vec<ListRefusal>,
    lost: Vec<ListPerson>,
    fork: Option<ForkNote>,
}

fn result(
    ctx: &Ctx,
    state: HeadState,
    steps: Option<&[Step]>,
    record: Option<AreaListRecord>,
    head: Option<&CommittedHead>,
    more: More,
) -> Arc<AreaLists> {
    let end = steps.and_then(<[Step]>::last);
    // A fork found, or two lists at one version: reported as a fork, before anything else.
    let report = if more.fork.is_some() || more.refused.iter().any(|at| at.reason == LIST_RIVAL) {
        Some(HeadReport::Fork)
    } else {
        more.report
    };
    Arc::new(AreaLists {
        view: AreaListsView {
            group_id: ctx.chain.group_id.clone(),
            workspace_id: ctx.workspace_id.clone(),
            area_kind: ctx.kind,
            workspace_key_version: ctx.key_version,
            roster_version: ctx.chain.roster.roster_version,
            roster_digest: ctx.chain.roster_digest.clone(),
            state,
            list_version: end.map_or(0, |step| step.at.list.list_version),
            list_digest: end.map_or(String::new(), |step| step.at.digest.clone()),
            everyone: end.and_then(|step| step.at.list.everyone),
            people: end.map_or(Vec::new(), |step| {
                step.at
                    .list
                    .people
                    .iter()
                    .map(|person| ListedPerson {
                        user_id: person.user_id.clone(),
                        role: person.role,
                        since: step.since.get(&person.user_id).copied().unwrap_or(0),
                    })
                    .collect()
            }),
            record,
            repost: more.repost,
            report,
            missing: more.missing,
            refused: more.refused,
            lost: more.lost,
            fork: more.fork,
            head: head.map(|head| ListHead {
                roster_version: head.roster_version,
                list_version: head.list_version,
                list_digest: head.list_digest.clone(),
            }),
            // The highest list version any roster committed for the area, at any folder key.
            furthest_list_version: ctx.rows.iter().flatten().map(|row| row.list_version).max().unwrap_or(0),
        },
    })
}

/* The record for a verified run of steps whose committed head is the step at `anchor`. */
#[allow(clippy::too_many_arguments)]
fn record_of(
    ctx: &Ctx,
    steps: &[Step],
    base: u64,
    digests: Vec<String>,
    anchor: usize,
    committed_at: u64,
    held: &mut dyn FnMut(&Step) -> (u64, Option<u64>),
    judged_through: u64,
    forks: Vec<ForkNote>,
) -> AreaListRecord {
    AreaListRecord {
        group_id: ctx.chain.group_id.clone(),
        workspace_id: ctx.workspace_id.clone(),
        workspace_key_version: ctx.key_version,
        base_list_version: base,
        digests,
        committed_roster_version: committed_at,
        committed_list_version: steps[anchor].at.list.list_version,
        lists: steps[anchor..]
            .iter()
            .map(|step| {
                let (held_at, reported_at) = held(step);
                StoredAreaList {
                    statement: step.at.statement.clone(),
                    signature: step.at.signature.clone(),
                    held_at,
                    reported_at,
                }
            })
            .collect(),
        since: steps[anchor].since.clone(),
        judged_through,
        forks,
    }
}

/* When this device first held each stored list, and when it first posted it again. */
fn held_of(kept: Option<&Kept>) -> HashMap<String, (u64, Option<u64>)> {
    kept.map_or(HashMap::new(), |kept| {
        std::iter::once(&kept.first.at)
            .chain(&kept.later)
            .zip(&kept.stored)
            .map(|(at, stored)| (at.digest.clone(), (stored.held_at, stored.reported_at)))
            .collect()
    })
}

/* The served lists of this area at its current key version, parsed, in the order served. */
fn served_of(ctx: &Ctx, served: Option<&Vec<SignedAreaList>>) -> Vec<Parsed> {
    served
        .into_iter()
        .flatten()
        .filter_map(|signed| parsed(ctx, &signed.statement, &signed.signature))
        .filter(|at| at.list.workspace_key_version == ctx.key_version)
        .collect()
}

fn covered(newest: &AreaList, person: &ListPerson) -> bool {
    rank(role_of(newest, &person.user_id)) >= rank(Some(person.role))
        || rank(newest.everyone) >= rank(Some(person.role))
}

/// Reads an area's list against the chain (2.3): the device's own record,
/// judged again by the chain as it is now, extended by what the server
/// served, and set against the furthest head a roster committed.
///
/// - `heads` is the heads record ([`heads_read`]); `None`, or one not read
///   through the chain's latest roster, reads as behind.
/// - `served` is what the server served of this area's lists, in any order;
///   `None` when it has not answered. With no answer and a committed head past
///   the record, the device is behind, and writes nothing there
///   ([`HEAD_BEHIND`]).
/// - Served lists that extend the record are verified and kept; one that does
///   not follow it is never taken.
/// - A committed head on the record, before its end, leaves the device ahead:
///   it keeps its record and posts the rest again.
/// - A committed head that is not on the record, with nothing served that
///   extends the record to it, is a fork: the record is kept with a note, and
///   [`area_fork_settle`] takes the committed record once the device has
///   warned and posted what it holds.
/// - A new folder key replaces the list: the base list the roster row commits
///   to is verified from what was served, and what the device held past its
///   last committed head and the rotator had not seen is `lost`.
///
/// `ml_dsa_keys` is the served ML-DSA public keys, base64url, by their
/// SHA-256, as `accept_rosters` takes them.
///
/// ```no_run
/// use hushos_core::*;
/// # fn read(chain: std::sync::Arc<AcceptedRosters>, heads: HeadsRecord, kept: Option<AreaListRecord>,
/// #     served: Vec<SignedAreaList>, keys: std::collections::HashMap<String, String>, area: String, me: String) -> CoreResult<()> {
/// let lists = area_lists_read(chain.clone(), Some(heads), area, kept, Some(served), keys)?;
/// let view = lists.view();
/// // Keep `view.record`; post `view.repost` again when ahead or forked.
/// if view.state == HeadState::Level || view.state == HeadState::Ahead {
///     area_writable(chain.clone(), lists.clone())?;
/// }
/// let access = area_access(chain, lists, me, false, None, None)?;
/// assert!(area_allows(access, AreaAction::Read) || access_is_none(&view));
/// # fn access_is_none(_: &AreaListsView) -> bool { true }
/// # Ok(()) }
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn area_lists_read(
    chain: Arc<AcceptedRosters>,
    heads: Option<HeadsRecord>,
    workspace_id: String,
    record: Option<AreaListRecord>,
    served: Option<Vec<SignedAreaList>>,
    ml_dsa_keys: HashMap<String, String>,
) -> CoreResult<Arc<AreaLists>> {
    let ctx = context_of(&chain, heads.as_ref(), &workspace_id, &ml_dsa_keys)?;
    let kept = record.as_ref().map(|record| record_steps(&ctx, record)).transpose()?;
    let mut refused: Vec<ListRefusal> = Vec::new();
    let mut lost: Vec<ListPerson> = Vec::new();
    // The record at this key version, judged again by the chain as it is now: an addition whose
    // signer has since lost the standing, or the keys, it was signed with, past the heads that
    // ended them, goes, with every list built on it.
    let mut steps: Option<Vec<Step>> = None;
    if let Some(kept) = kept.as_ref().filter(|kept| kept.key_version == ctx.key_version) {
        let mut run = vec![kept.first.clone()];
        for (index, at) in kept.later.iter().enumerate() {
            let prev = run.last().expect("the first step is there");
            if ctx.rows.is_none() {
                // Heads not read yet: the record as it stands, unjudged.
                let since = at
                    .list
                    .people
                    .iter()
                    .map(|person| {
                        let same = role_of(&prev.at.list, &person.user_id) == Some(person.role);
                        let from = if same {
                            prev.since.get(&person.user_id).copied().unwrap_or(0)
                        } else {
                            at.list.roster_version
                        };
                        (person.user_id.clone(), from)
                    })
                    .collect();
                run.push(Step { at: at.clone(), since });
                continue;
            }
            match check_addition(&ctx, prev, at, false) {
                Ok(step) => run.push(step),
                Err(error) => {
                    refused.push(refusal(at, &reason_of(&error)));
                    lost.extend(beyond(&kept.end().list, &prev.at.list));
                    for dropped in &kept.later[index + 1..] {
                        refused.push(refusal(dropped, NOT_FOLLOWING_LIST));
                    }
                    break;
                }
            }
        }
        steps = Some(run);
    }
    // Without the heads read through the latest roster nothing is judged: behind, the record kept.
    if ctx.rows.is_none() {
        return Ok(result(&ctx, HeadState::Behind, steps.as_deref(), record, None, More::default()));
    }
    let heads = heads_of(&ctx)?;
    let mut head = heads[0].clone();
    let through = chain.roster.roster_version;
    let parsed_served = served_of(&ctx, served.as_ref());
    let held = held_of(kept.as_ref());
    // The record kept as it was, with the note; nothing is adopted until the fork is settled.
    let forked = |head: &CommittedHead,
                  reported: Option<&Parsed>,
                  record: Option<AreaListRecord>,
                  now: Option<&[Step]>,
                  refused: Vec<ListRefusal>,
                  lost: Vec<ListPerson>| {
        let note = reported.map(|reported| ForkNote {
            kind: ForkKind::List,
            committed_position: head.list_version,
            committed_digest: head.list_digest.clone(),
            reported_position: reported.list.list_version,
            reported_digest: reported.digest.clone(),
            roster_version: head.roster_version,
            settled: false,
        });
        let noted = record.map(|mut record| {
            if let Some(note) = &note {
                record.forks.retain(|at| !same_note(at, note));
                record.forks.push(note.clone());
            }
            record
        });
        let repost = noted.as_ref().map_or(Vec::new(), |record| {
            record
                .lists
                .iter()
                .skip(1)
                .map(|stored| SignedAreaList {
                    statement: stored.statement.clone(),
                    signature: stored.signature.clone(),
                })
                .collect()
        });
        result(
            &ctx,
            HeadState::Forked,
            now,
            noted,
            Some(head),
            More { repost, refused, lost, fork: note, ..More::default() },
        )
    };

    // A new folder key (or a first read): the list is the base list the roster row commits to.
    let Some(mut steps) = steps else {
        if served.is_none() {
            return Ok(result(&ctx, HeadState::Behind, None, record, Some(&head), More::default()));
        }
        let old_end = kept.as_ref().map(Kept::end);
        let fresh = from_base(&ctx, &parsed_served, &mut refused);
        // Nothing served reaches the committed head: forked, whatever the device held before.
        let Some((fresh, at)) = fresh.and_then(|fresh| reached(&fresh, &heads).map(|at| (fresh, at))) else {
            return Ok(forked(&head, old_end, record, None, refused, lost));
        };
        head = at.head.clone();
        let anchor = at.anchor;
        let base = fresh[0].at.list.list_version;
        if kept.as_ref().is_some_and(|kept| base <= kept.committed_list_version) {
            // The new base list stands at or below a head an earlier roster committed: not on
            // this device's record. Settled like any fork.
            return Ok(forked(&head, old_end, record, None, refused, lost));
        }
        let newest = fresh.last().expect("the base is there");
        let mut report = None;
        if let Some(kept) = kept.as_ref().filter(|kept| !kept.later.is_empty()) {
            // The key change replaced every list this device held past its committed head,
            // whatever the new base list is numbered: they are stale, and whoever they added
            // that the new list does not cover is no longer on the folder ("add them again").
            lost.extend(
                beyond(&kept.end().list, &kept.first.at.list)
                    .into_iter()
                    .filter(|person| !covered(&newest.at.list, person)),
            );
            for held in &kept.later {
                refused.push(refusal(held, LIST_STALE));
            }
            // Numbered at or below what this device held, the rotator had seen less of it.
            if base <= kept.end().list.list_version {
                report = Some(HeadReport::Ahead);
            }
        }
        let forks = kept.as_ref().map_or(&[][..], |kept| kept.forks.as_slice());
        let (notes, found) = notes_after(forks, at.passed_over.as_ref(), newest);
        let record = record_of(
            &ctx,
            &fresh,
            base,
            fresh.iter().map(|step| step.at.digest.clone()).collect(),
            anchor,
            head.roster_version,
            &mut |_| (through, None),
            through,
            notes,
        );
        let state = if anchor == fresh.len() - 1 { HeadState::Level } else { HeadState::Ahead };
        let repost = fresh[anchor + 1..].iter().map(|step| signed_of(&step.at)).collect();
        return Ok(result(
            &ctx,
            state,
            Some(&fresh),
            Some(record),
            Some(&head),
            More { repost, report, refused, lost, fork: found, ..More::default() },
        ));
    };

    // The same folder key: extend the record by what was served, then judge the committed head.
    let kept = kept.expect("steps come from a record");
    let base = kept.base;
    let first = steps[0].at.list.list_version;
    let mut digests: Vec<String> = kept.digests[..(first - base) as usize + steps.len()].to_vec();
    // A served list at a version this device holds, with another digest, is never taken.
    let mut others: HashSet<&str> = HashSet::new();
    for at in &parsed_served {
        let on_record = at.list.list_version.checked_sub(base).and_then(|index| digests.get(index as usize));
        if on_record.is_some_and(|on_record| *on_record != at.digest) && others.insert(at.digest.as_str()) {
            refused.push(refusal(at, NOT_FOLLOWING_LIST));
        }
    }
    let before = steps.len();
    extend(&ctx, &mut steps, &parsed_served, &mut refused);
    digests.extend(steps[before..].iter().map(|step| step.at.digest.clone()));
    let end = steps.last().expect("a record has a first step").clone();
    let reaches = served.as_ref().map(|_| false);
    let judge = |at: &CommittedHead| state_of(base, &digests, at.list_version, &at.list_digest, reaches);
    let mut state = judge(&head);
    // Nothing served reaches a furthest head past the end of this record: the latest roster's,
    // where the record reaches that, and the head passed over is noted and reported. A furthest
    // head at a version the record holds, with another digest, stays a fork.
    let mut passed_over: Option<CommittedHead> = None;
    if state == HeadState::Forked && head.list_version > end.at.list.list_version {
        if let Some(latest) =
            heads.get(1).filter(|at| matches!(judge(at), HeadState::Level | HeadState::Ahead))
        {
            passed_over = Some(head.clone());
            head = latest.clone();
            state = judge(&head);
        }
    }
    let mut stored = |step: &Step| held.get(&step.at.digest).copied().unwrap_or((through, None));
    if state == HeadState::Behind || state == HeadState::Forked {
        let record = record_of(
            &ctx,
            &steps,
            base,
            digests.clone(),
            0,
            kept.committed_roster_version,
            &mut stored,
            kept.judged_through,
            kept.forks.clone(),
        );
        if state == HeadState::Behind {
            return Ok(result(
                &ctx,
                HeadState::Behind,
                Some(&steps),
                Some(record),
                Some(&head),
                More { refused, lost, ..More::default() },
            ));
        }
        return Ok(forked(&head, Some(&end.at), Some(record), Some(&steps), refused, lost));
    }
    // The committed head is on the record: it becomes the head this device keeps, if further.
    let anchor = head.list_version.saturating_sub(first) as usize;
    let committed_at = if anchor > 0 { head.roster_version } else { kept.committed_roster_version };
    let (mut notes, found) = notes_after(&kept.forks, passed_over.as_ref(), &end);
    // A later roster whose row fell back: on the record it moves nothing and is reported; off it,
    // two rosters committed to different records, which is a fork.
    let mut report = None;
    let mut fork = found;
    for row in ctx.rows.iter().flatten() {
        if row.workspace_key_version != ctx.key_version
            || row.roster_version <= kept.judged_through.max(head.roster_version)
            || row.list_version > head.list_version
            || (row.list_version == head.list_version && row.list_digest == head.list_digest)
        {
            continue;
        }
        let on_record = row.list_version.checked_sub(base).and_then(|index| digests.get(index as usize));
        if on_record == Some(&row.list_digest) {
            report = report.or(Some(HeadReport::Ahead));
        } else {
            let note = ForkNote {
                kind: ForkKind::List,
                committed_position: row.list_version,
                committed_digest: row.list_digest.clone(),
                reported_position: end.at.list.list_version,
                reported_digest: end.at.digest.clone(),
                roster_version: row.roster_version,
                // Nothing to adopt: this device is on the furthest committed record already.
                settled: true,
            };
            if !notes.iter().any(|at| same_note(at, &note)) {
                notes.push(note.clone());
                fork = fork.or(Some(note));
            }
        }
    }
    // What it holds past the committed head: posted again at the first roster that lacks it, and
    // missing when a roster after that one still does.
    let mut missing = false;
    let mut marked = |step: &Step| {
        let (held_at, reported_at) = stored(step);
        if step.at.list.list_version <= head.list_version {
            return (held_at, reported_at);
        }
        match reported_at {
            None if through > held_at => {
                report = report.or(Some(HeadReport::Ahead));
                (held_at, Some(through))
            }
            Some(reported) if through > reported => {
                missing = true;
                (held_at, reported_at)
            }
            _ => (held_at, reported_at),
        }
    };
    let record = record_of(&ctx, &steps, base, digests, anchor, committed_at, &mut marked, through, notes);
    let repost = steps[anchor + 1..].iter().map(|step| signed_of(&step.at)).collect();
    Ok(result(
        &ctx,
        state,
        Some(&steps),
        Some(record),
        Some(&head),
        More { repost, report, missing, refused, lost, fork },
    ))
}

/// Settles a fork (2.3, "Settling a fork"), once the device has warned and
/// posted what it holds: the committed record becomes its base for chaining.
/// The lists are verified from the base list the chain commits to, along what
/// the server served, to the committed head; a list this device held that
/// still follows that record is kept, and one built on a list that is gone is
/// refused (`list-stale`), its people `lost` ("add the person again"). The
/// note stays, settled, until its person clears it ([`fork_note_clear`]).
/// Refused ([`HEAD_FORKED`]) when the record has no fork to settle, or nothing
/// served reaches the committed head.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn area_fork_settle(
    chain: Arc<AcceptedRosters>,
    heads: Option<HeadsRecord>,
    workspace_id: String,
    record: Option<AreaListRecord>,
    served: Option<Vec<SignedAreaList>>,
    ml_dsa_keys: HashMap<String, String>,
) -> CoreResult<Arc<AreaLists>> {
    let ctx = context_of(&chain, heads.as_ref(), &workspace_id, &ml_dsa_keys)?;
    let kept = record.as_ref().map(|record| record_steps(&ctx, record)).transpose()?;
    let forked = || input(HEAD_FORKED);
    let Some(kept) = kept
        .filter(|kept| ctx.rows.is_some() && served.is_some() && kept.forks.iter().any(|note| !note.settled))
    else {
        return Err(forked());
    };
    let mut refused = Vec::new();
    let parsed_served = served_of(&ctx, served.as_ref());
    let mut steps = from_base(&ctx, &parsed_served, &mut refused).ok_or_else(forked)?;
    let at = reached(&steps, &heads_of(&ctx)?).ok_or_else(forked)?;
    let through = chain.roster.roster_version;
    // What this device held and the committed record lacks: kept where it still follows.
    let committed: HashSet<String> = steps.iter().map(|step| step.at.digest.clone()).collect();
    let mut mine = HashSet::new();
    for held in &kept.later {
        if committed.contains(&held.digest) {
            continue;
        }
        let end = steps.last().expect("the base is there");
        let follows = kept.key_version == ctx.key_version && held.list.previous_list_digest == end.at.digest;
        match if follows { check_addition(&ctx, end, held, false) } else { Err(input(LIST_STALE)) } {
            Ok(step) => {
                mine.insert(held.digest.clone());
                steps.push(step);
            }
            Err(error) => {
                let reason = reason_of(&error);
                refused.push(refusal(held, if reason == NOT_FOLLOWING_LIST { LIST_STALE } else { &reason }));
            }
        }
    }
    // Whoever the lists this device held past its committed head had added, and is not there now.
    let newest = steps.last().expect("the base is there");
    let lost: Vec<ListPerson> = beyond(&kept.end().list, &kept.first.at.list)
        .into_iter()
        .filter(|person| !covered(&newest.at.list, person))
        .collect();
    let held = held_of(Some(&kept));
    let (notes, _) = notes_after(&kept.forks, at.passed_over.as_ref(), newest);
    let record = record_of(
        &ctx,
        &steps,
        steps[0].at.list.list_version,
        steps.iter().map(|step| step.at.digest.clone()).collect(),
        at.anchor,
        at.head.roster_version,
        &mut |step| {
            if mine.contains(&step.at.digest) {
                held.get(&step.at.digest).copied().unwrap_or((through, None))
            } else {
                (through, None)
            }
        },
        through,
        notes,
    );
    let state = if at.anchor == steps.len() - 1 { HeadState::Level } else { HeadState::Ahead };
    let repost = steps[at.anchor + 1..].iter().map(|step| signed_of(&step.at)).collect();
    Ok(result(
        &ctx,
        state,
        Some(&steps),
        Some(record),
        Some(&at.head),
        More { repost, refused, lost, ..More::default() },
    ))
}

/// The person clears their own note, on their own device, after reading it
/// (2.3): only once the fork is settled. Nobody else can.
///
/// ```
/// use hushos_core::*;
/// let digest = |text: &str| roster_digest(text.as_bytes().to_vec());
/// let note = |settled| ForkNote {
///     kind: ForkKind::List,
///     committed_position: 2,
///     committed_digest: digest("the list the roster committed"),
///     reported_position: 2,
///     reported_digest: digest("the list this device held"),
///     roster_version: 4,
///     settled,
/// };
/// let record = |forks: Vec<ForkNote>| AreaListRecord {
///     group_id: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".into(),
///     workspace_id: "80558a81-8dfc-8914-8447-0417b55e2ec5".into(),
///     workspace_key_version: 1,
///     base_list_version: 1,
///     digests: vec![digest("the base list")],
///     committed_roster_version: 1,
///     committed_list_version: 1,
///     lists: vec![],
///     since: Default::default(),
///     judged_through: 4,
///     forks,
/// };
/// // A fork still unsettled is the device's state, not a note to wave away.
/// assert_eq!(fork_note_clear(record(vec![note(false)]), note(false)).forks.len(), 1);
/// // Settled, its person clears it; another fork's note stays.
/// let other = ForkNote { reported_digest: digest("another list"), ..note(true) };
/// let cleared = fork_note_clear(record(vec![note(true), other.clone()]), note(true));
/// assert_eq!(cleared.forks, vec![other]);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn fork_note_clear(record: AreaListRecord, note: ForkNote) -> AreaListRecord {
    let mut record = record;
    record.forks.retain(|at| !(at.settled && same_note(at, &note)));
    record
}

/// Refuses a write in an area whose list is behind or forked (2.3):
/// [`HEAD_BEHIND`], [`HEAD_FORKED`].
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn area_writable(chain: Arc<AcceptedRosters>, lists: Arc<AreaLists>) -> CoreResult<()> {
    match require_read(&chain, &lists)?.state {
        HeadState::Behind => Err(input(HEAD_BEHIND)),
        HeadState::Forked => Err(input(HEAD_FORKED)),
        HeadState::Level | HeadState::Ahead => Ok(()),
    }
}

/* Signing lists (2.3, 3.4) */

fn sorted_people(people: &[ListPerson]) -> Vec<ListPerson> {
    let mut people = people.to_vec();
    people.sort_by(|x, y| x.user_id.cmp(&y.user_id));
    people
}

/// What the base list of an area's next key version says ([`area_list_base_sign`]).
/// `area_kind` is a new area's kind; a key change keeps the folder's.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct BaseAreaList {
    pub group_id: String,
    pub workspace_id: String,
    pub area_kind: AreaKind,
    #[cfg_attr(feature = "uniffi", uniffi(default = None))]
    pub everyone: Option<ListRole>,
    pub people: Vec<ListPerson>,
    pub signer_user_id: String,
    pub signer_key_version: u64,
    /// The entries of the roster that will commit it, when it changes who is
    /// active; the chain's latest when empty.
    #[cfg_attr(feature = "uniffi", uniffi(default = []))]
    pub members: Vec<RosterMember>,
}

/// A list this device signed, with the digest the roster row or the next
/// list names.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SignedListWithDigest {
    pub statement: Vec<u8>,
    pub signature: Vec<u8>,
    pub digest: String,
}

/// Signs the base list of an area's next key version (2.3), before the roster
/// whose row commits it: by the member who will sign that roster, naming
/// their latest accepted roster (the one before it), with a fresh nonce.
/// `chain` is `None` only for the areas of roster 1, before the company
/// exists.
///
/// For a new area the list is list 1 and `lists` is `None`. For a key change
/// `lists` is the folder's list as this device read it at its latest roster:
/// nothing is signed while it is behind ([`HEAD_BEHIND`]) or forked from a
/// head it holds another list for ([`HEAD_FORKED`]: settle first). Forked only
/// because nothing served reaches the committed head, a key change is the way
/// out, and is signed. The list is numbered one past the furthest of what
/// this device verified and what any roster committed for the area, so a
/// committed head never moves back. Everyone named must be active on the
/// roster that will commit it, and an employee area's list is its assignee
/// alone, as manager. The digest goes on the roster row
/// (`AreaKey::list_digest`) and the list to [`heads_to_commit`].
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn area_list_base_sign(
    base: BaseAreaList,
    chain: Option<Arc<AcceptedRosters>>,
    lists: Option<Arc<AreaLists>>,
    signer: IdentityKeys,
) -> CoreResult<SignedListWithDigest> {
    let people = sorted_people(&base.people);
    let (mut key_version, mut list_version, mut kind) = (1, 1, base.area_kind);
    if let Some(chain) = &chain {
        same_group(chain, &base.group_id)?;
        company_of(chain)?;
        let entitled = chain.roster.entry(&base.signer_user_id).is_some_and(|entry| {
            entry.active_with(Some(GroupRole::Members)) && entry.key_version == base.signer_key_version
        });
        if !entitled {
            return Err(input(NOT_ENTITLED));
        }
        sealer_holds(chain, &base.signer_user_id, &signer)?;
        let listed = chain.area_keys.get(&base.workspace_id).map_or(0, Vec::len) as u64;
        if listed > 0 {
            if chain.retired_areas.contains(&base.workspace_id) {
                return Err(input(RETIRED));
            }
            let lists = lists.as_ref().ok_or_else(|| input(HEAD_BEHIND))?;
            let view = require_read(chain, lists)?;
            if view.workspace_id != base.workspace_id {
                return Err(input(NOT_THE_BASE));
            }
            let past = view.head.as_ref().is_some_and(|head| head.list_version > view.list_version);
            match view.state {
                HeadState::Behind => return Err(input(HEAD_BEHIND)),
                HeadState::Forked if !past => return Err(input(HEAD_FORKED)),
                _ => {}
            }
            key_version = listed + 1;
            list_version = view.list_version.max(view.furthest_list_version) + 1;
            kind = view.area_kind;
        } else if lists.is_some() {
            return Err(input(NOT_THE_BASE));
        }
    } else if lists.is_some() {
        return Err(input(NOT_THE_BASE));
    }
    if kind == AreaKind::Employee
        && (base.everyone.is_some() || people.len() != 1 || people[0].role != ListRole::Manager)
    {
        return Err(input(EMPLOYEE_LIST));
    }
    let members: &[RosterMember] = match (&chain, base.members.is_empty()) {
        (_, false) => &base.members,
        (Some(chain), true) => &chain.roster.members,
        (None, true) => return Err(input(NOT_ACTIVE)),
    };
    let active =
        |user_id: &str| members.iter().any(|entry| entry.user_id == user_id && entry.active_with(None));
    if people.iter().any(|person| !active(&person.user_id)) {
        return Err(input(NOT_ACTIVE));
    }
    let statement = area_list_bytes(&AreaList {
        group_id: base.group_id,
        workspace_id: base.workspace_id,
        list_version,
        previous_list_digest: String::new(),
        workspace_key_version: key_version,
        signer_user_id: base.signer_user_id,
        signer_key_version: base.signer_key_version,
        roster_version: chain.as_ref().map_or(0, |chain| chain.roster.roster_version),
        roster_digest: chain.as_ref().map_or(String::new(), |chain| chain.roster_digest.clone()),
        nonce: encode(&random(LIST_NONCE_BYTES)),
        everyone: base.everyone,
        people,
    })?;
    let signature = sign_hybrid(&signer.signing_seed, &signer.ml_dsa_seed, &statement)?;
    Ok(SignedListWithDigest { digest: digest(&statement), statement, signature })
}

/// Signs an addition (2.3, 3.4): the list after the latest one this device
/// verified, with `add` put in (new people, or a higher role for someone on
/// it) and `everyone` raised when given. Signed only at the signer's latest
/// accepted roster, with the keys their entry names there, on a list that is
/// level or ahead ([`HEAD_BEHIND`], [`HEAD_FORKED`] otherwise), and only when
/// it would verify: what verification refuses is never signed. One that would
/// change nothing is refused too, and, where `add` names someone whose place
/// on the list is from before they left and came back, with a sentence that
/// says so: the same role adds nothing a device counts.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn area_list_addition_sign(
    chain: Arc<AcceptedRosters>,
    heads: HeadsRecord,
    lists: Arc<AreaLists>,
    add: Vec<ListPerson>,
    everyone: Option<ListRole>,
    signer_user_id: String,
    signer: IdentityKeys,
) -> CoreResult<SignedListWithDigest> {
    area_writable(chain.clone(), lists.clone())?;
    let view = require_read(&chain, &lists)?;
    let Some(record) = view.record.as_ref().filter(|_| view.list_version > 0) else {
        return Err(input(HEAD_BEHIND));
    };
    let none = HashMap::new();
    let ctx = context_of(&chain, Some(&heads), &view.workspace_id, &none)?;
    let entry = chain
        .roster
        .entry(&signer_user_id)
        .filter(|entry| entry.active_with(None))
        .ok_or_else(|| input(NOT_ENTITLED))?;
    sealer_holds(&chain, &signer_user_id, &signer)?;
    let mut people: Vec<ListPerson> = view
        .people
        .iter()
        .map(|person| ListPerson { user_id: person.user_id.clone(), role: person.role })
        .collect();
    let everyone = everyone.or(view.everyone);
    let mut changed = rank(everyone) > rank(view.everyone);
    let mut stale = false;
    for person in &add {
        match people.iter_mut().find(|at| at.user_id == person.user_id) {
            Some(at) if rank(Some(person.role)) < rank(Some(at.role)) => return Err(input(NARROWS)),
            Some(at) if rank(Some(person.role)) > rank(Some(at.role)) => {
                changed = true;
                at.role = person.role;
            }
            Some(_) => {
                // On the list at that role already. Where the entry is from before they last
                // came back it counts for nothing, and signing it again changes nothing.
                let admitted = ctx
                    .org
                    .active
                    .get(&person.user_id)
                    .and_then(|spans| spans.last())
                    .map_or(0, |span| span.from);
                let since =
                    view.people.iter().find(|at| at.user_id == person.user_id).map_or(0, |at| at.since);
                stale |= since < admitted;
            }
            None => {
                changed = true;
                people.push(person.clone());
            }
        }
    }
    if !changed {
        return Err(input(if stale { ENTRY_FROM_BEFORE } else { NOTHING_ADDED }));
    }
    let kept = record_steps(&ctx, record)?;
    let list = AreaList {
        group_id: view.group_id.clone(),
        workspace_id: view.workspace_id.clone(),
        list_version: view.list_version + 1,
        previous_list_digest: view.list_digest.clone(),
        workspace_key_version: view.workspace_key_version,
        signer_user_id,
        signer_key_version: entry.key_version,
        roster_version: chain.roster.roster_version,
        roster_digest: chain.roster_digest.clone(),
        nonce: encode(&random(LIST_NONCE_BYTES)),
        everyone,
        people: sorted_people(&people),
    };
    let statement = area_list_bytes(&list)?;
    let at = Parsed { list, digest: digest(&statement), statement, signature: Vec::new() };
    // Acceptance's own rules, signature aside, on the list as this device verified it.
    let end = Step {
        at: kept.end().clone(),
        since: view.people.iter().map(|person| (person.user_id.clone(), person.since)).collect(),
    };
    check_addition(&ctx, &end, &at, false)?;
    let signature = sign_hybrid(&signer.signing_seed, &signer.ml_dsa_seed, &at.statement)?;
    Ok(SignedListWithDigest { statement: at.statement, signature, digest: at.digest })
}

/* The heads a roster commits to (2.3, "Heads") */

/// The heads a roster's signer commits to, as [`heads_to_commit`] builds them
/// from the folders the device read, and as `company_roster_first` and
/// `company_roster_next` take them. It has no constructor: a digest of a
/// caller's own making signs no roster.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct CommittedHeads {
    pub(crate) group_id: String,
    /* The roster they were built on (0 before roster 1); None for heads no device verified. */
    pub(crate) roster_version: Option<u64>,
    pub(crate) rows: Vec<HeadRow>,
    pub(crate) heads_digest: String,
    /* The areas the roster creates or rotates (id, key version, base list digest) and those it retires. */
    pub(crate) changed: Vec<(String, u64, String)>,
    pub(crate) retired: Vec<String>,
    /* Whether these are the heads of the roster before, restated (`heads_carried`): a recovery roster's. */
    pub(crate) carried: bool,
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl CommittedHeads {
    /// Every live area's row after the roster, sorted by workspace id: what
    /// the roster call uploads (those that differ from the roster before).
    pub fn rows(&self) -> Vec<HeadRow> {
        self.rows.clone()
    }

    /// The digest the roster's `heads` field carries.
    pub fn heads_digest(&self) -> String {
        self.heads_digest.clone()
    }
}

/// Heads no device verified, by their digest alone: for the tests and fuzzers
/// that build rosters over histories whose folders have no lists. Not exported
/// to the apps: a roster signed over them commits to nothing anyone read.
#[doc(hidden)]
pub fn heads_unverified(heads_digest: String) -> Arc<CommittedHeads> {
    Arc::new(CommittedHeads {
        group_id: String::new(),
        roster_version: None,
        rows: Vec::new(),
        heads_digest,
        changed: Vec::new(),
        retired: Vec::new(),
        carried: false,
    })
}

/// The heads a recovery roster carries (2.1, rule 11: the `heads` of the
/// roster before): the latest roster's own, restated, and nothing this device
/// read since. `company_roster_next` takes them for a recovery roster and for
/// no other, and a recovery roster takes no others: the kit promotes its
/// holder and commits nothing, so it needs no folder read, and an addition
/// made since the last roster does not stand in its way.
///
/// The digest is the chain's. The rows are the heads record's at that roster
/// (checked against the digest; [`HEAD_BEHIND`] for a record that stops short
/// of it), or none where the device holds no record: a recovery roster
/// uploads none.
///
/// ```no_run
/// use hushos_core::*;
/// # fn recover(chain: std::sync::Arc<AcceptedRosters>, heads: Option<HeadsRecord>, members: Vec<RosterMember>, me: String) -> CoreResult<()> {
/// let carried = heads_carried(chain.clone(), chain.group_id(), heads)?;
/// let org = NextOrgRoster { custody_key: None, kit: None, rules: None, auto_utc_day: None, heads: carried, checked: vec![] };
/// // `members` is the roster's, with the kit holder's own entry given all four roles.
/// let roster = company_roster_next(chain, members, me, None, None, org)?;
/// # let _ = roster;
/// # Ok(()) }
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn heads_carried(
    chain: Arc<AcceptedRosters>,
    group_id: String,
    heads: Option<HeadsRecord>,
) -> CoreResult<Arc<CommittedHeads>> {
    uuid(&group_id, "group id")?;
    same_group(&chain, &group_id)?;
    let org = company_of(&chain)?;
    let rows = match &heads {
        Some(record) => {
            check_heads_record(&chain, org, record)?;
            if record.roster_version != chain.roster.roster_version {
                return Err(input(HEAD_BEHIND));
            }
            rows_at(org, &record.areas, record.roster_version)?
        }
        None => Vec::new(),
    };
    let heads_digest = chain
        .roster
        .org
        .as_ref()
        .map(|org| org.heads.heads_digest.clone())
        .ok_or_else(|| input(NOT_A_COMPANY))?;
    Ok(Arc::new(CommittedHeads {
        group_id,
        roster_version: Some(chain.roster.roster_version),
        rows,
        heads_digest,
        changed: Vec::new(),
        retired: Vec::new(),
        carried: true,
    }))
}

/// A share log's head as this device verified it (2.4): its length and digest.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ShareLogHead {
    pub index: u64,
    pub digest: String,
}

/// The heads rows a roster's signer commits (2.3: "A signer's device commits
/// the heads it verified, never ones the server merely reported"), and their
/// digest, as `company_roster_first` and `company_roster_next` take them and
/// from nowhere else.
///
/// `lists` is every live area's list as this device read it at its latest
/// roster, but for the areas the roster creates or rotates, whose base lists
/// are `changed`, and those it retires (`retire`). Nothing is built while any
/// of them is unread, behind ([`HEAD_BEHIND`]) or forked ([`HEAD_FORKED`]),
/// and no row is ever below the furthest head an earlier roster committed for
/// its area: a device from which the server withheld a list cannot sign a
/// roster that buries it.
///
/// Where nothing this device holds or was served reaches a head a roster
/// committed past the end of its record, the furthest committed row is
/// carried on as it stands, from the device's heads record: never the
/// server's word, never lower. The folder stays forked on this device, and
/// its way out is its key change, whose base list is numbered past that head;
/// a roster rotates at most 8 folders (2.1, rule 6), and a company with more
/// such folders than that still signs its rosters, a removal among them. A
/// true fork, a committed head at a version the record holds with another
/// digest, is refused still.
///
/// The share log's half of a row is the furthest a roster committed, carried
/// on, or `share_logs` where the device verified further (never below the
/// committed position). `chain` and `heads` are `None` only for roster 1.
///
/// ```no_run
/// use hushos_core::*;
/// # fn build(chain: std::sync::Arc<AcceptedRosters>, heads: HeadsRecord, lists: Vec<std::sync::Arc<AreaLists>>) -> CoreResult<()> {
/// let committed = heads_to_commit(Some(chain.clone()), chain.group_id(), Some(heads), lists, vec![], vec![], Default::default())?;
/// // `committed` goes into `NextOrgRoster::heads`; its rows are uploaded with the roster.
/// assert_eq!(committed.heads_digest(), heads_digest(chain.group_id(), committed.rows())?);
/// # Ok(()) }
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn heads_to_commit(
    chain: Option<Arc<AcceptedRosters>>,
    group_id: String,
    heads: Option<HeadsRecord>,
    lists: Vec<Arc<AreaLists>>,
    changed: Vec<SignedAreaList>,
    retire: Vec<String>,
    share_logs: HashMap<String, ShareLogHead>,
) -> CoreResult<Arc<CommittedHeads>> {
    uuid(&group_id, "group id")?;
    let mut retired = retire;
    retired.sort();
    let mut org: Option<&OrgChain> = None;
    let mut record: Option<&HeadsRecord> = None;
    if let Some(chain) = &chain {
        same_group(chain, &group_id)?;
        let company = company_of(chain)?;
        let heads = heads.as_ref().ok_or_else(|| input(HEAD_BEHIND))?;
        check_heads_record(chain, company, heads)?;
        if heads.roster_version != chain.roster.roster_version {
            return Err(input(HEAD_BEHIND));
        }
        (org, record) = (Some(company), Some(heads));
    }
    let rows_of = |workspace_id: &str| record.and_then(|record| record.areas.get(workspace_id));
    let log_of = |workspace_id: &str| -> CoreResult<(u64, String)> {
        let committed = rows_of(workspace_id).and_then(|rows| furthest_of(rows));
        let verified = share_logs.get(workspace_id);
        if let (Some(verified), Some(committed)) = (verified, &committed) {
            if verified.index < committed.share_log_index {
                return Err(input(HEADS_NOT_BELOW));
            }
        }
        Ok(match (verified, committed) {
            (Some(verified), _) => (verified.index, verified.digest.clone()),
            (None, Some(committed)) => (committed.share_log_index, committed.share_log_digest),
            (None, None) => (0, log_start(&group_id, workspace_id)?),
        })
    };
    let mut rows: Vec<HeadRow> = Vec::new();
    let mut built: Vec<(String, u64, String)> = Vec::new();
    // The areas this roster creates or rotates: their base lists, as it will list them.
    for signed in &changed {
        let list = parse_list(&signed.statement)?;
        let listed =
            chain.as_ref().and_then(|chain| chain.area_keys.get(&list.workspace_id)).map_or(0, Vec::len)
                as u64;
        if list.group_id != group_id
            || !list.previous_list_digest.is_empty()
            || list.workspace_key_version != listed + 1
            || retired.contains(&list.workspace_id)
            || built.iter().any(|at| at.0 == list.workspace_id)
        {
            return Err(input(NOT_THE_BASE));
        }
        // Never below what a roster committed for the area before.
        let furthest =
            rows_of(&list.workspace_id).into_iter().flatten().map(|row| row.list_version).max().unwrap_or(0);
        if list.list_version <= furthest {
            return Err(input(HEADS_NOT_BELOW));
        }
        let list_digest = digest(&signed.statement);
        let (share_log_index, share_log_digest) = log_of(&list.workspace_id)?;
        built.push((list.workspace_id.clone(), list.workspace_key_version, list_digest.clone()));
        rows.push(HeadRow {
            workspace_id: list.workspace_id,
            workspace_key_version: list.workspace_key_version,
            list_version: list.list_version,
            list_digest,
            share_log_index,
            share_log_digest,
        });
    }
    // Every other live area: its head as this device verified it.
    let live: Vec<String> = match (&chain, org) {
        (Some(chain), Some(org)) => {
            live_areas_at(org, chain.roster.roster_version).into_iter().cloned().collect()
        }
        _ => Vec::new(),
    };
    for workspace_id in &live {
        if retired.contains(workspace_id) || built.iter().any(|at| at.0 == *workspace_id) {
            continue;
        }
        let chain = chain.as_ref().expect("live areas come from a chain");
        let lists = lists
            .iter()
            .find(|at| at.view.workspace_id == *workspace_id)
            .ok_or_else(|| input(HEADS_INCOMPLETE))?;
        let view = require_read(chain, lists)?;
        if view.state == HeadState::Behind {
            return Err(input(HEAD_BEHIND));
        }
        let furthest = rows_of(workspace_id)
            .and_then(|rows| furthest_of(rows))
            .filter(|furthest| furthest.workspace_key_version == view.workspace_key_version)
            .ok_or_else(|| input(HEAD_FORKED))?;
        // A head past the end of everything this device holds, which nothing served reaches
        // (it is forked, or went on by a later roster's lower row): the furthest committed row
        // is carried on, as the chain has it.
        let unreached = furthest.list_version > view.list_version;
        if view.state == HeadState::Forked && !unreached {
            return Err(input(HEAD_FORKED));
        }
        if view.list_version == 0 && !unreached {
            return Err(input(HEAD_BEHIND));
        }
        let (list_version, list_digest) = if unreached {
            (furthest.list_version, furthest.list_digest)
        } else {
            (view.list_version, view.list_digest.clone())
        };
        let (share_log_index, share_log_digest) = log_of(workspace_id)?;
        rows.push(HeadRow {
            workspace_id: workspace_id.clone(),
            workspace_key_version: view.workspace_key_version,
            list_version,
            list_digest,
            share_log_index,
            share_log_digest,
        });
    }
    if retired.iter().any(|workspace_id| !live.contains(workspace_id)) {
        return Err(input(NOT_AN_AREA));
    }
    rows.sort_by(|x, y| x.workspace_id.cmp(&y.workspace_id));
    Ok(Arc::new(CommittedHeads {
        group_id: group_id.clone(),
        roster_version: Some(chain.as_ref().map_or(0, |chain| chain.roster.roster_version)),
        heads_digest: digest_of_rows(&group_id, &rows)?,
        rows,
        changed: built,
        retired,
        carried: false,
    }))
}

/* The signed dismissal (2.3, "The note, and who clears it") */

/// Which record forked: a folder's list, or its share log (2.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ForkKind {
    List,
    ShareLog,
}

impl ForkKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ForkKind::List => "list",
            ForkKind::ShareLog => "share-log",
        }
    }
}

/// An Admin's dismissal of a fork, for the Admins: it names both records, the
/// head the roster committed and the head the device reported (a list
/// version, or a log index).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ForkDismissal {
    pub group_id: String,
    pub workspace_id: String,
    pub kind: ForkKind,
    pub committed_position: u64,
    pub committed_digest: String,
    pub reported_position: u64,
    pub reported_digest: String,
    pub signer_user_id: String,
    pub signer_key_version: u64,
    pub roster_version: u64,
    pub roster_digest: String,
}

const FORK_DISMISSAL_DOMAIN: &str = "hushos/group/fork-dismissal";
const NOT_AN_ADMIN: &str = "Only an admin dismisses a fork for the admins.";
const DISMISSAL_KEYS_REPLACED: &str =
    "This dismissal is signed with keys its signer has since replaced: it has to be signed again.";

/// The bytes of a fork dismissal:
/// `["hushos/group/fork-dismissal",1,groupId,workspaceId,kind,committedPosition,committedDigest,reportedPosition,reportedDigest,signerUserId,signerKeyVersion,rosterVersion,rosterDigest]`.
///
/// ```
/// use hushos_core::*;
/// let digest = |text: &str| roster_digest(text.as_bytes().to_vec());
/// let dismissal = ForkDismissal {
///     group_id: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".into(),
///     workspace_id: "80558a81-8dfc-8914-8447-0417b55e2ec5".into(),
///     kind: ForkKind::List,
///     committed_position: 2,
///     committed_digest: digest("the list the roster committed"),
///     reported_position: 2,
///     reported_digest: digest("the list this device held"),
///     signer_user_id: "00000003-abcd-4abc-8abc-abcdefabcdef".into(),
///     signer_key_version: 1,
///     roster_version: 4,
///     roster_digest: digest("roster 4"),
/// };
/// let statement = fork_dismissal_statement(dismissal.clone())?;
/// assert_eq!(fork_dismissal_parse(statement)?, dismissal);
/// // A list's position is its version, from 1; a share log's is its length, from 0.
/// assert!(fork_dismissal_statement(ForkDismissal { committed_position: 0, ..dismissal.clone() }).is_err());
/// let log = ForkDismissal { kind: ForkKind::ShareLog, committed_position: 0, ..dismissal.clone() };
/// assert!(fork_dismissal_statement(log).is_ok());
/// // It dismisses only the fork whose two digests it names.
/// let note = ForkNote {
///     kind: ForkKind::List,
///     committed_position: 2,
///     committed_digest: dismissal.committed_digest.clone(),
///     reported_position: 2,
///     reported_digest: dismissal.reported_digest.clone(),
///     roster_version: 4,
///     settled: false,
/// };
/// assert!(fork_dismisses(dismissal.clone(), dismissal.workspace_id.clone(), note.clone()));
/// let other = ForkNote { reported_digest: digest("another list"), ..note };
/// assert!(!fork_dismisses(dismissal.clone(), dismissal.workspace_id.clone(), other));
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn fork_dismissal_statement(dismissal: ForkDismissal) -> CoreResult<Vec<u8>> {
    dismissal_bytes(&dismissal)
}

fn dismissal_bytes(dismissal: &ForkDismissal) -> CoreResult<Vec<u8>> {
    // A list's position is its version, from 1; a share log's is its length, from 0.
    let position = |value: u64| match dismissal.kind {
        ForkKind::List => integer(value, "fork position"),
        ForkKind::ShareLog if value <= crate::signatures::MAX_SAFE_INTEGER => Ok(value),
        ForkKind::ShareLog => Err(input("Invalid fork position.")),
    };
    encode_statement(&[
        json!(FORK_DISMISSAL_DOMAIN),
        json!(1),
        json!(uuid(&dismissal.group_id, "group id")?),
        json!(uuid(&dismissal.workspace_id, "workspace id")?),
        json!(dismissal.kind.as_str()),
        json!(position(dismissal.committed_position)?),
        json!(digest_of(&dismissal.committed_digest, "fork digest")?),
        json!(position(dismissal.reported_position)?),
        json!(digest_of(&dismissal.reported_digest, "fork digest")?),
        json!(uuid(&dismissal.signer_user_id, "user id")?),
        json!(integer(dismissal.signer_key_version, "key version")?),
        json!(integer(dismissal.roster_version, "roster version")?),
        json!(digest_of(&dismissal.roster_digest, "roster digest")?),
    ])
}

/// The dismissal a statement's bytes hold, refused unless the bytes are its
/// canonical encoding.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn fork_dismissal_parse(statement: Vec<u8>) -> CoreResult<ForkDismissal> {
    let parts = parse_statement(&statement, "fork dismissal")?;
    if parts.len() != 13 || parts[0] != json!(FORK_DISMISSAL_DOMAIN) || parts[1] != json!(1) {
        return Err(input("Invalid fork dismissal."));
    }
    let dismissal = ForkDismissal {
        group_id: text(&parts[2], "group id")?.into(),
        workspace_id: text(&parts[3], "workspace id")?.into(),
        kind: match text(&parts[4], "fork kind")? {
            "list" => ForkKind::List,
            "share-log" => ForkKind::ShareLog,
            _ => return Err(input("Invalid fork kind.")),
        },
        committed_position: count(&parts[5], "fork position")?,
        committed_digest: text(&parts[6], "fork digest")?.into(),
        reported_position: count(&parts[7], "fork position")?,
        reported_digest: text(&parts[8], "fork digest")?.into(),
        signer_user_id: text(&parts[9], "user id")?.into(),
        signer_key_version: number(&parts[10], "key version")?,
        roster_version: number(&parts[11], "roster version")?,
        roster_digest: text(&parts[12], "roster digest")?.into(),
    };
    require_canonical(&statement, &dismissal_bytes(&dismissal)?, "fork dismissal")?;
    Ok(dismissal)
}

/* Whether the dismissal names an area of this company and a signer who is an Admin now, at the keys named. */
fn dismissal_holds(chain: &AcceptedRosters, org: &OrgChain, dismissal: &ForkDismissal) -> bool {
    org.area_kinds.contains_key(&dismissal.workspace_id)
        && chain
            .roster
            .entry(&dismissal.signer_user_id)
            .is_some_and(|entry| entry.active_with(Some(GroupRole::Members)))
        && span_at(org.data_admins.get(&dismissal.signer_user_id), dismissal.roster_version).is_some()
        && keys_at(org, &dismissal.signer_user_id, dismissal.roster_version)
            .is_some_and(|keys| keys.key_version == dismissal.signer_key_version)
}

/// A signed dismissal: its statement and the Admin's hybrid identity
/// signature (3373 bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SignedForkDismissal {
    pub statement: Vec<u8>,
    pub signature: Vec<u8>,
}

/// Signs a dismissal with the Admin's hybrid identity signature: only for an
/// active `Members` holder, at the keys their entry names, naming their
/// latest accepted roster.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn fork_dismissal_sign(
    dismissal: ForkDismissal,
    chain: Arc<AcceptedRosters>,
    signer: IdentityKeys,
) -> CoreResult<SignedForkDismissal> {
    let statement = dismissal_bytes(&dismissal)?;
    same_group(&chain, &dismissal.group_id)?;
    let org = company_of(&chain)?;
    sealed_at_latest(&chain, dismissal.roster_version, &dismissal.roster_digest)?;
    if !dismissal_holds(&chain, org, &dismissal) {
        return Err(input(NOT_AN_ADMIN));
    }
    sealer_holds(&chain, &dismissal.signer_user_id, &signer)?;
    let signature = sign_hybrid(&signer.signing_seed, &signer.ml_dsa_seed, &statement)?;
    Ok(SignedForkDismissal { statement, signature })
}

/// A dismissal as the server and the area's people take it: the bytes
/// canonical, for this company and one of its areas, naming a roster on the
/// chain, from someone who held `Members` on that roster and still does on
/// the latest (a signature carries no time: a removed Admin's dismissal, with
/// any roster named, hides nothing), and signed under the keys their entry
/// named at the roster named. Anything else is refused.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn fork_dismissal_verify(
    statement: Vec<u8>,
    signature: Vec<u8>,
    chain: Arc<AcceptedRosters>,
    signer_ml_dsa_public_key: Vec<u8>,
) -> CoreResult<ForkDismissal> {
    let dismissal = fork_dismissal_parse(statement.clone())?;
    same_group(&chain, &dismissal.group_id)?;
    let org = company_of(&chain)?;
    let on_chain = chain.roster_digests.get((dismissal.roster_version - 1) as usize);
    if on_chain != Some(&dismissal.roster_digest) {
        return Err(input(NOT_ON_CHAIN));
    }
    if !dismissal_holds(&chain, org, &dismissal) {
        return Err(input(NOT_AN_ADMIN));
    }
    // A key change is treated like leaving: a dismissal has no head to be within, so one signed
    // under keys its signer's entry has since moved off hides nothing. They sign it again.
    if keys_replaced_at(org, &dismissal.signer_user_id, dismissal.roster_version).is_some() {
        return Err(input(DISMISSAL_KEYS_REPLACED));
    }
    let unsigned = || input("This dismissal is not signed by the admin it names.");
    let named = keys_at(org, &dismissal.signer_user_id, dismissal.roster_version).ok_or_else(unsigned)?;
    if signature.len() != HYBRID_SIGNATURE_BYTES
        || signer_ml_dsa_public_key.len() != ML_DSA_PUBLIC_KEY_BYTES
        || digest(&signer_ml_dsa_public_key) != named.ml_dsa_public_key_digest
    {
        return Err(unsigned());
    }
    let keys = HybridPublicKey {
        signing_public_key: decode("signingPublicKey", &named.signing_public_key, Some(32))?,
        ml_dsa_public_key: signer_ml_dsa_public_key,
    };
    if !verify_hybrid(&keys, &statement, &signature) {
        return Err(unsigned());
    }
    Ok(dismissal)
}

/// Whether a verified dismissal is of this very fork: the same area and kind,
/// and both digests, with their positions. A device hides the Admins' note
/// only then. It clears no override (2.4): only the committed record does.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn fork_dismisses(dismissal: ForkDismissal, workspace_id: String, note: ForkNote) -> bool {
    dismissal.workspace_id == workspace_id
        && dismissal.kind == note.kind
        && dismissal.committed_position == note.committed_position
        && dismissal.committed_digest == note.committed_digest
        && dismissal.reported_position == note.reported_position
        && dismissal.reported_digest == note.reported_digest
}

/* The resolver (2.3, "Who is entitled") */

/// On what basis someone reaches a company folder, and as what:
///
/// - `List`: active on the roster, not suspended, and on the folder's latest
///   list by an entry that counts for them, or covered by `everyone`;
/// - `Share`: named in a live share whose record verifies, on that node's
///   subtree (the record is the share log's: the caller says so);
/// - `Browse`: an active data admin in a browse session: everything except
///   making shares and links;
/// - `KeyChange`: an active data admin in a key-change session, for an area
///   that is owed one: the rotation work and nothing else.
///
/// Nobody else has any: membership of the company alone grants nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum AreaAccess {
    List { role: ListRole },
    Share { role: ListRole },
    Browse,
    KeyChange,
}

/// A data admin's live session a request is made in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum AreaSession {
    Browse,
    KeyChange,
}

/// What someone asks to do in a folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum AreaAction {
    Read,
    Download,
    Write,
    Share,
    Manage,
    Rotate,
}

/* The role a list gives someone active on the latest roster: their own entry, where it counts, or `everyone`. */
fn list_role(
    chain: &AcceptedRosters,
    org: &OrgChain,
    view: &AreaListsView,
    user_id: &str,
) -> Option<ListRole> {
    if !chain.roster.entry(user_id).is_some_and(|entry| entry.active_with(None)) {
        return None;
    }
    // An entry counts only from the roster that last let its person in (2.3, "After someone comes back").
    let admitted = org.active.get(user_id).and_then(|spans| spans.last()).map_or(u64::MAX, |span| span.from);
    let named = view
        .people
        .iter()
        .find(|person| person.user_id == user_id && person.since >= admitted)
        .map(|person| person.role);
    if rank(named) >= rank(view.everyone) {
        named
    } else {
        view.everyone
    }
}

fn owed(org: &OrgChain, view: &AreaListsView) -> bool {
    let Some(listed) = org.area_rosters.get(&view.workspace_id).and_then(|rows| rows.last()) else {
        return false;
    };
    let listed = listed.roster_version;
    if org.custody_keys.len() > 1 && org.custody_keys.last().is_some_and(|key| key.roster_version > listed) {
        return true;
    }
    let left_since = |user_id: &String| {
        org.active
            .get(user_id)
            .is_some_and(|spans| spans.iter().any(|span| span.until.is_some_and(|until| until > listed)))
    };
    if view.everyone.is_some() {
        org.active.keys().any(left_since)
    } else {
        view.people.iter().any(|person| left_since(&person.user_id))
    }
}

/// Whether an area is owed a key change (3.6, "While a key change is owed"),
/// from the device's own chain and list, never the server's word: the roster
/// row of its current key is older than the roster that marked left anyone
/// its list names (anyone at all where `everyone` is set), or than the roster
/// that last replaced the company key.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn area_owed(chain: Arc<AcceptedRosters>, lists: Arc<AreaLists>) -> CoreResult<bool> {
    Ok(owed(company_of(&chain)?, require_read(&chain, &lists)?))
}

/// The one resolver (2.3): what `user_id` may do in the area `lists` is of,
/// on the device's own chain and the list it verified; `None` for nothing.
/// `suspended` is the server's word (a pause changes no key and is on no
/// roster): a paused member reaches nothing. `session` is the data admin's
/// live session the request is made in, if any (it then decides, and a
/// session of someone who is no data admin, or a key-change session for an
/// area that is owed none, is no basis at all); `share` is the role of a live
/// share whose record verifies and that covers the node asked for, if any.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn area_access(
    chain: Arc<AcceptedRosters>,
    lists: Arc<AreaLists>,
    user_id: String,
    suspended: bool,
    session: Option<AreaSession>,
    share: Option<ListRole>,
) -> CoreResult<Option<AreaAccess>> {
    let view = require_read(&chain, &lists)?;
    let org = company_of(&chain)?;
    if suspended {
        return Ok(None);
    }
    // Someone the list names is one of the folder's people: an admin who is on it is not
    // browsing (3.7), whatever session the request came in.
    if let Some(role) = list_role(&chain, org, view, &user_id) {
        return Ok(Some(AreaAccess::List { role }));
    }
    if chain.roster.entry(&user_id).is_some_and(|entry| entry.active_with(Some(GroupRole::DataAdmin))) {
        match session {
            Some(AreaSession::Browse) => return Ok(Some(AreaAccess::Browse)),
            Some(AreaSession::KeyChange) if owed(org, view) => return Ok(Some(AreaAccess::KeyChange)),
            _ => {}
        }
    }
    Ok(match share {
        Some(ListRole::Manager) => return Err(input("Invalid list role.")),
        Some(role) => Some(AreaAccess::Share { role }),
        None => None,
    })
}

/// What a basis allows (2.3's table): a viewer reads and downloads; an editor
/// also writes and shares; a manager also signs additions; a share grantee
/// reads, downloads and, as editor, writes, and does not share on; a browsing
/// data admin does everything but make shares and links; a key-change session
/// does the rotation work and nothing else, no download URL.
///
/// ```
/// use hushos_core::*;
/// let viewer = Some(AreaAccess::List { role: ListRole::Viewer });
/// assert!(area_allows(viewer, AreaAction::Download) && !area_allows(viewer, AreaAction::Write));
/// let grantee = Some(AreaAccess::Share { role: ListRole::Editor });
/// assert!(area_allows(grantee, AreaAction::Write) && !area_allows(grantee, AreaAction::Share));
/// assert!(!area_allows(Some(AreaAccess::Browse), AreaAction::Share));
/// // A key-change session asking for a download URL gets nothing, and so does nobody at all.
/// assert!(!area_allows(Some(AreaAccess::KeyChange), AreaAction::Download));
/// assert!(area_allows(Some(AreaAccess::KeyChange), AreaAction::Rotate));
/// assert!(!area_allows(None, AreaAction::Read));
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn area_allows(access: Option<AreaAccess>, action: AreaAction) -> bool {
    use AreaAction::*;
    match access {
        None => false,
        Some(AreaAccess::List { role }) => match action {
            Read | Download => true,
            Write | Share => role != ListRole::Viewer,
            Manage => role == ListRole::Manager,
            Rotate => false,
        },
        Some(AreaAccess::Share { role }) => match action {
            Read | Download => true,
            Write => role == ListRole::Editor,
            Share | Manage | Rotate => false,
        },
        Some(AreaAccess::Browse) => !matches!(action, Share | Rotate),
        Some(AreaAccess::KeyChange) => action == Rotate,
    }
}

/// Who is owed an area's current key (2.3, "Grants"): everyone its list
/// entitles who is active and not suspended, the uploader included, sorted.
/// A roster call that creates or rotates an area owes them the new key's
/// grant; an admission owes the newcomer the grants of the folders this names
/// them for (those whose list has `everyone` set, and their own).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn area_grants_owed(
    chain: Arc<AcceptedRosters>,
    lists: Arc<AreaLists>,
    suspended: Vec<String>,
) -> CoreResult<Vec<String>> {
    let view = require_read(&chain, &lists)?;
    let org = company_of(&chain)?;
    let mut owed: Vec<String> = chain
        .roster
        .members
        .iter()
        .filter(|entry| {
            !suspended.contains(&entry.user_id) && list_role(&chain, org, view, &entry.user_id).is_some()
        })
        .map(|entry| entry.user_id.clone())
        .collect();
    owed.sort();
    Ok(owed)
}

/* Whether `user_id` is entitled to an area's key by the list this device verified (2.3, "Grants"). */
pub(crate) fn grant_allowed(
    chain: &AcceptedRosters,
    lists: &AreaLists,
    user_id: &str,
    workspace_id: &str,
    workspace_key_version: u64,
) -> CoreResult<bool> {
    let view = require_read(chain, lists)?;
    Ok(view.workspace_id == workspace_id
        && view.list_version > 0
        && workspace_key_version <= view.workspace_key_version
        && list_role(chain, company_of(chain)?, view, user_id).is_some())
}

/*
 * The keys a company area's grant is checked under (2.3, "Grants"): the ones
 * its granter's entry named at the roster the grant names, where the granter
 * was active. Judged there and not on the latest roster, so a grant an Admin
 * made opens after that Admin is removed, as a list they signed still stands.
 * (What it opens to is the key the chain commits to, for a reader the list
 * entitles: an old grant, or old keys, deliver nothing else.)
 */
pub(crate) fn granter_at(
    chain: &AcceptedRosters,
    granter_user_id: &str,
    roster_version: u64,
    served_ml_dsa_public_key: &[u8],
) -> CoreResult<Vec<HybridPublicKey>> {
    let org = company_of(chain)?;
    if active_at(org, granter_user_id, roster_version).is_none() {
        return Err(input("This grant is not from an active member of the group."));
    }
    let named = keys_at(org, granter_user_id, roster_version)
        .filter(|named| {
            served_ml_dsa_public_key.len() == ML_DSA_PUBLIC_KEY_BYTES
                && digest(served_ml_dsa_public_key) == named.ml_dsa_public_key_digest
        })
        .ok_or_else(|| input(crate::groups::NOT_LISTED))?;
    Ok(vec![HybridPublicKey {
        signing_public_key: decode("signingPublicKey", &named.signing_public_key, Some(32))?,
        ml_dsa_public_key: served_ml_dsa_public_key.to_vec(),
    }])
}

/* Who writes (2.3) */

/// A writer's standing on a company folder, for a writer active on the roster
/// whose signature holds (2.3, "Who writes"), in order: `Unchecked` (the
/// reader's list did not load or verify, or is behind or forked from a head a
/// roster committed), `Listed` (an editor or manager on the list, or covered
/// by `everyone` as editor), `DataAdmin` (an active data admin the list does
/// not make an editor), `Share` (a colleague who edits that subtree by a
/// share record that verifies), `NotOnThisFolder` (none of those).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum FolderStanding {
    Unchecked,
    Listed,
    DataAdmin,
    Share,
    NotOnThisFolder,
}

/// A writer's standing on the folder `workspace_id`, by the list this device
/// read at the chain's latest roster (`None` when it did not load).
/// `shared_editors` is the colleagues who edit the record's subtree by a
/// share record that verifies (the share log's).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn folder_standing(
    chain: Arc<AcceptedRosters>,
    lists: Option<Arc<AreaLists>>,
    workspace_id: String,
    writer_user_id: String,
    shared_editors: Vec<String>,
) -> FolderStanding {
    let Some(lists) = lists else {
        return FolderStanding::Unchecked;
    };
    let (Ok(view), Ok(org)) = (require_read(&chain, &lists), company_of(&chain)) else {
        return FolderStanding::Unchecked;
    };
    if view.workspace_id != workspace_id
        || view.list_version == 0
        || matches!(view.state, HeadState::Behind | HeadState::Forked)
    {
        return FolderStanding::Unchecked;
    }
    if matches!(list_role(&chain, org, view, &writer_user_id), Some(ListRole::Editor | ListRole::Manager)) {
        return FolderStanding::Listed;
    }
    if chain.roster.entry(&writer_user_id).is_some_and(|entry| entry.active_with(Some(GroupRole::DataAdmin)))
    {
        return FolderStanding::DataAdmin;
    }
    if shared_editors.contains(&writer_user_id) {
        return FolderStanding::Share;
    }
    FolderStanding::NotOnThisFolder
}
