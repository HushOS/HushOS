//! The family write rules (docs/groups-design.md 2.6 and 2.10, flags F9 and
//! F14) and the keys they hold, the twin of the web worker's area ledger
//! (`packages/crypto/src/area-ledger.ts`, which `session.ts` and
//! `session-groups.ts` use):
//!
//! - an area is written only under its **write version**: the latest the
//!   committed chain lists, held by a grant at that version, with the server
//!   agreeing and a root opened at that version whose key the chain committed
//!   to ([`AreaLedger::open_area`], [`AreaLedger::open_listed_node`]);
//! - every node key is held with the area key version its path is **rooted
//!   at** (the root opened under the area key at that version, each child
//!   under its parent's current key); a key reached through any previous key
//!   (option A's previous-root envelope, a parent's previous key, a walk's old
//!   key) is rooted nowhere: it reads and never writes ([`KEY_CHANGE_PENDING`]);
//! - a walk is held to the same rule: its fresh key goes only under a parent
//!   rooted at the write version (or pending in the same walk, made since the
//!   area's latest roster), a node at the target is carried only when its key
//!   is rooted there ([`NOT_CARRIED`]), and the area's root is re-keyed only by
//!   a roster ([`AREA_ROOT`]).
//!
//! The web keeps these in its crypto worker; the apps keep one `AreaLedger`
//! per unlocked session (the File Provider and the DocumentsProvider build
//! theirs from listings, as the worker does after a reload). It holds keys
//! and decides; it never fetches. The shared fixtures run the same scenarios
//! through both twins (`fixtures/web-area-ledger.json`, written by
//! `packages/crypto/scripts/area-ledger-fixtures.ts`, and
//! `packages/crypto/src/__fixtures__/core-area-ledger.json`, by
//! `examples/area_ledger_fixtures.rs`), and the fuzz target `area_ledger`
//! compares them on any sequence of steps.
//!
//! Area state is kept per (family, area): an area resolves only through the
//! family [`AreaLedger::open_area`] derived its id under, so another family's
//! member list (one a removed member manages, say) can neither move an area's
//! write version nor drop its keys; its listing of the area, or of the
//! account's own workspace ([`AreaLedger::open_personal_workspace`]), is
//! ignored and reported ([`AreaLedger::foreign_listings`]). A chain older than
//! the one held, or another at its version, is refused.
//!
//! A walk runs one node at a time through [`AreaLedger::rotate_node`], which
//! makes the fresh key, re-keys the node's records with it
//! (`rotation_records.rs`, the twin of the worker's `rekeyNode`) and only then
//! marks the key pending, as the worker's `rotateKey` does: a node whose
//! records do not re-key leaves nothing behind. A refused batch is dropped
//! with [`AreaLedger::rotate_drop`], or [`AreaLedger::rotate_drop_all`] when
//! the app lost track of it. [`AreaLedger::record_verdict`] and
//! [`AreaLedger::copy_form`] judge records against the chain this ledger
//! committed (`group_verdicts.rs`, the twin of the worker's `recordVerdicts`
//! and `judgeWith`).

use crate::bytes::{random, SecretBytes};
use crate::canonical::uuid;
use crate::drive::{node_open_checked, node_wrap_checked, previous_root_key_open, NodeKeyContext};
use crate::error::{input, CoreError, CoreResult};
use crate::group_trust::{AcceptedRosters, GroupPin};
use crate::group_trust::{GroupReading, GroupVerdict, SuccessionCache};
use crate::group_verdicts::{
    copy_prior, GroupWriter, Judge, RecordReader, RecordStatement, RecordVerdict, ServedRecord,
};
use crate::groups::{area_key_commitment, area_root_check, area_write_version};
use crate::ids::{check_id, IdKind};
use crate::rotation_records::{rekey_node_records, RotatedNode, RotatingNode};
use crate::signatures::{signing_public_key_of, Integrity};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use zeroize::Zeroizing;

/// A write in a family folder under a key whose path is not rooted at the
/// folder's current key: a key change has not reached it yet. Uploads wait it
/// out, as for the server's 409 `rotating`.
pub const KEY_CHANGE_PENDING: &str = "This folder’s keys changed: the key change has not reached it yet.";
/// A walk handed a key it reached only through one the rotation replaces: the
/// item is not carried into the new tree.
pub const NOT_CARRIED: &str =
    "This item was added under a key the key change replaces, so it is not carried over.";
/// A write under keys the session no longer has as current.
pub const KEYS_CHANGED: &str = "This folder’s keys changed. Reload to continue.";
/// A family folder read before its member list was checked on this device.
pub const NOT_CHECKED_KEYS: &str = "Couldn’t check this folder’s keys. Reload to continue.";
/// Anything in Drive that would wrap a key straight under a family folder's area key.
pub const AREA_ROOT: &str = "A family folder’s top level changes only with the family’s member list.";
/// A family folder's top level whose key is not the one its member list committed to.
pub const NOT_COMMITTED_ROOT: &str = "This folder’s key is not the one the family’s member list names.";
const OPEN_DRIVE: &str = "Open Drive again to continue.";
const OLDER_WORKSPACE_KEY: &str = "This folder was wrapped under an older workspace key.";
const OPEN_PARENT: &str = "Open the containing folder first.";
const OLDER_FOLDER_KEY: &str = "This item was wrapped under an older folder key.";
const OWN_WORKSPACE: &str = "This was refused: it claims to be a folder of your own.";
const NO_CHAIN: &str = "Check the family’s member list first.";
const NOT_THE_FAMILYS: &str = "This folder does not belong to the family.";
const NOT_LISTED: &str = "This folder is not on the family’s member list.";
const ITEM_CHANGED: &str = "This item changed since it was opened. Refresh and retry.";
const FAMILY_FOLDER: &str = "This was refused: it is a family folder.";
/// A walk handed a node outside the family folders: personal rotations re-seal as the apps always have.
pub const NOT_A_FAMILY_FOLDER: &str = "Only a family folder's items are re-keyed here.";
/// A node in a family folder with shares or links, which a family folder never has (design 3.4).
pub const SHARED_IN_FAMILY: &str =
    "This item has shares or links, which a family folder never has, so it was not re-keyed.";
/// A copy out of, or a verdict in, a folder the family's committed chain does not list, or that was
/// not opened under this family here.
pub const NOT_THIS_FAMILYS: &str = "This folder is not one of this family’s.";
/// A verdict or a walk before the account was opened on the ledger ([`AreaLedger::open_account`]).
pub const NO_ACCOUNT: &str = "Unlock your account first.";
/// A reader or signing seed that is not the unlocked account's.
pub const NOT_THIS_ACCOUNT: &str = "These keys are not this account's. Unlock again and retry.";
/// A chain older than the one this device already holds for the family (a
/// background acceptance that lost a race with the foreground's): refused,
/// and nothing of it (the record, the pin) is to be written.
pub const OLDER_CHAIN: &str = "This device already holds a later member list for this family. Sync again.";
/// Another chain at the very roster version held for the family, with another
/// digest: a split view, never committed. An app reports it as the fork (the
/// hard warning); acceptance with the session's committed chain as a mark
/// (core step 3, `accept_served`) answers the fork before this.
pub const SPLIT_CHAIN: &str = "This family’s member list was shown differently to this device.";

/// Settings served as none after settings that opened, within one unlock.
const OLDER_SETTINGS: &str =
    "The server sent older settings than this device has opened, so nothing was changed.";
/// An acceptance before the app opened the account's settings.
pub(crate) const OPEN_SETTINGS: &str = "Open your settings first.";

/* What an acceptance needs of the unlocked account. */
pub(crate) struct ServedAccount {
    pub(crate) user_id: String,
    pub(crate) signing_public_key: Vec<u8>,
    pub(crate) store_key: Zeroizing<[u8; 32]>,
    pub(crate) generation: u64,
}

/// Why a family folder may not be written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum AreaBlock {
    /// The grant this device holds is for an earlier version than the chain's latest.
    NoGrantAtLatest,
    /// The server reports an earlier version than the chain lists.
    ServerBehind,
    /// The server reports a later version than the chain lists.
    ServerAhead,
    /// No root has been opened at the latest version yet.
    RootUnknown,
    /// The root last opened was at an earlier version.
    RootBehind,
}

impl AreaBlock {
    /// The web's name for it (`groupOpenArea`'s `reason`).
    pub fn name(self) -> &'static str {
        match self {
            AreaBlock::NoGrantAtLatest => "no-grant-at-latest",
            AreaBlock::ServerBehind => "server-behind",
            AreaBlock::ServerAhead => "server-ahead",
            AreaBlock::RootUnknown => "root-unknown",
            AreaBlock::RootBehind => "root-behind",
        }
    }
}

/// What opening a family folder's key found: the version held, and whether
/// (and why not) the folder may be written now.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct AreaOpened {
    pub version: u64,
    pub writable: bool,
    pub reason: Option<AreaBlock>,
    /// The area as a pin may record it ([`crate::merge_pin`]): the only way an area enters one.
    pub pin_area: Arc<crate::device_record::OpenedArea>,
}

/// A node key envelope as a listing serves it, with its previous one while a rotation runs.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ServedNodeKey {
    pub node_id: String,
    pub parent_id: String,
    pub parent_key_epoch: u64,
    pub key_epoch: u64,
    pub key_envelope: Vec<u8>,
    pub prev_key_envelope: Option<Vec<u8>>,
    pub prev_key_epoch: Option<u64>,
    pub prev_parent_key_epoch: Option<u64>,
}

/// A node as rotation work serves it, as far as its key goes.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RotatingNodeKey {
    pub node_id: String,
    pub parent_id: String,
    /// The parent's key epoch the node's key is wrapped under now: the walk's target for a rotated parent.
    pub parent_key_epoch: u64,
    /// The node's key epoch now, and the parent epoch its envelope was wrapped under.
    pub key_epoch: u64,
    pub wrapped_parent_key_epoch: u64,
    pub key_envelope: Vec<u8>,
}

/// A committed chain listing a workspace that is not its family's: a folder
/// another family opened here (`opened_by`), or the account's own workspace
/// (`opened_by` none). Ignored for every decision; shown as a warning.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ForeignListing {
    pub group_id: String,
    pub workspace_id: String,
    pub opened_by: Option<String>,
}

/// A node key the session holds, at its epoch: the app's copy to wipe.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct HeldNodeKey {
    pub key: SecretBytes,
    pub epoch: u64,
}

/// A new node's key and its envelope under the parent.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct NewNodeKey {
    pub key: SecretBytes,
    pub key_envelope: Vec<u8>,
}

/// One node of a walk's key half ([`AreaLedger::rotate_key`], for the shared
/// scenarios and the fuzz target): its key envelope under the parent's key at
/// the target; the node's key as it was (`old_key`); and, unless the node was
/// only re-wrapped under a re-keyed parent (`rewrap`), the fresh key that
/// replaces it. Apps never see one: [`AreaLedger::rotate_node`] keeps both keys.
#[derive(Debug, Clone)]
pub struct RotatedKey {
    pub key_envelope: Vec<u8>,
    pub rewrap: bool,
    pub old_key: Option<SecretBytes>,
    pub fresh_key: Option<SecretBytes>,
}

type Slot = (String, String);
/* (group id, workspace id). */
type AreaSlot = (String, String);

struct Held {
    key: Zeroizing<Vec<u8>>,
    epoch: u64,
    own: bool,
}

struct Pending {
    fresh: Zeroizing<Vec<u8>>,
    epoch: u64,
    old: Zeroizing<Vec<u8>>,
    old_epoch: u64,
    /* What the parent key the fresh one is wrapped under is rooted at. */
    rooted_at: Option<u64>,
}

#[derive(Default)]
struct WorkspaceKeys {
    current: u64,
    keys: BTreeMap<u64, Zeroizing<Vec<u8>>>,
}

#[derive(Clone)]
struct OpenedArea {
    #[allow(dead_code)]
    id_seed: String,
    version: u64,
}

/* The worker's Drive key store (session.ts) and its group session's area state (session-groups.ts). */
#[derive(Default)]
struct State {
    workspace_keys: HashMap<String, WorkspaceKeys>,
    own: HashMap<Slot, Held>,
    guest: HashMap<Slot, Held>,
    own_prev: HashMap<Slot, Held>,
    guest_prev: HashMap<Slot, Held>,
    lineage: HashMap<Slot, Option<u64>>,
    pending: HashMap<Slot, Pending>,
    root_opened_under: HashMap<Slot, u64>,
    /* Per (family, area): never per area alone, so one family's chain never moves another's area. */
    area_write: HashMap<AreaSlot, u64>,
    blocked: HashMap<AreaSlot, AreaBlock>,
    root_seen_at: HashMap<AreaSlot, u64>,
    /* Each area's root node: the first top-level row, at the write version, whose key the chain committed to. */
    root_ids: HashMap<AreaSlot, String>,
    /* The account's own workspaces: never an area, whatever a family's roster lists. */
    personal: std::collections::HashSet<String>,
    /* What the web's group session holds: committed chains by group, and areas opened per group. */
    chains: HashMap<String, Arc<AcceptedRosters>>,
    opened: HashMap<String, BTreeMap<String, OpenedArea>>,
    /* Families whose last acceptance was the fork (uncommit with fork): read by personal keys alone. */
    forked: std::collections::HashSet<String>,
    /* The unlocked account: its user id and current signing public key (open_account). */
    account: Option<(String, Vec<u8>)>,
    /* The device store key, derived from the account root at open_account; wiped when dropped. */
    store_key: Option<Zeroizing<[u8; 32]>>,
    /* Bumped by open_account and clear: an acceptance commits only under the account it began with. */
    generation: u64,
    /* The settings document's group pins as last opened (use_settings), and whether it opened. */
    settings: Option<Settings>,
    /*
     * Per family, the highest chain committed in this session: accept_served's
     * floor and mark. A refusal's uncommit never drops it; only forget_group and
     * clear do, so a run that lost to a later commit can never take an older chain.
     */
    floors: HashMap<String, Arc<AcceptedRosters>>,
}

/* The settings the app last opened for the account: their group pins, or none when no document opened. */
struct Settings {
    user_id: String,
    pins: HashMap<String, GroupPin>,
    opened: bool,
}

fn slot(workspace_id: &str, node_id: &str) -> Slot {
    (workspace_id.to_string(), node_id.to_string())
}

fn refused(message: &str) -> CoreError {
    input(message)
}

fn ctx(
    workspace_id: &str,
    node_id: &str,
    parent_id: &str,
    parent_key_epoch: u64,
    key_epoch: u64,
) -> NodeKeyContext {
    NodeKeyContext {
        workspace_id: workspace_id.to_string(),
        node_id: node_id.to_string(),
        parent_id: parent_id.to_string(),
        parent_key_epoch,
        key_epoch,
    }
}

impl State {
    /* ------------------------------------------------------------ */
    /* Which workspaces are areas, and the version each is written under */
    /* ------------------------------------------------------------ */

    /* The families that opened the area here (one, unless something is badly wrong). */
    fn opened_by(&self, workspace_id: &str) -> Vec<String> {
        let mut groups: Vec<String> = self
            .opened
            .iter()
            .filter(|(_, areas)| areas.contains_key(workspace_id))
            .map(|(group_id, _)| group_id.clone())
            .collect();
        groups.sort();
        groups
    }

    /* How many committed chains list the area. */
    fn listings(&self, workspace_id: &str) -> usize {
        self.chains.values().filter(|chain| chain.area_keys.contains_key(workspace_id)).count()
    }

    /*
     * The family an area is resolved through: the one it was opened under (open_area checked its
     * id as derived under it), and only while no second committed chain lists it.
     */
    fn family_of(&self, workspace_id: &str) -> Option<String> {
        // The family it was opened under, whatever another family's chain lists (only a warning:
        // `foreign_listings`); an area no family opened resolves through none.
        let families = self.opened_by(workspace_id);
        if families.len() != 1 {
            return None;
        }
        families.into_iter().next()
    }

    fn foreign_listings(&self) -> Vec<ForeignListing> {
        let mut out = vec![];
        for (group_id, chain) in &self.chains {
            for workspace_id in chain.area_keys.keys() {
                let families = self.opened_by(workspace_id);
                if self.personal.contains(workspace_id) {
                    out.push(ForeignListing {
                        group_id: group_id.clone(),
                        workspace_id: workspace_id.clone(),
                        opened_by: None,
                    });
                } else if !families.is_empty() && !families.contains(group_id) {
                    out.push(ForeignListing {
                        group_id: group_id.clone(),
                        workspace_id: workspace_id.clone(),
                        opened_by: families.into_iter().next(),
                    });
                }
            }
        }
        out.sort_by(|a, b| (&a.group_id, &a.workspace_id).cmp(&(&b.group_id, &b.workspace_id)));
        out
    }

    fn is_area(&self, workspace_id: &str) -> bool {
        if self.personal.contains(workspace_id) {
            return false;
        }
        !self.opened_by(workspace_id).is_empty()
            || self.listings(workspace_id) > 0
            || self.area_write.keys().any(|(_, ws)| ws == workspace_id)
            || self.blocked.keys().any(|(_, ws)| ws == workspace_id)
            || self.root_seen_at.keys().any(|(_, ws)| ws == workspace_id)
    }

    /* The family and version an area is read under; none for a workspace that is no family's area. */
    fn read_at(&self, workspace_id: &str) -> CoreResult<Option<(AreaSlot, u64)>> {
        if !self.is_area(workspace_id) {
            return Ok(None);
        }
        let group_id = self.family_of(workspace_id).ok_or_else(|| refused(NOT_CHECKED_KEYS))?;
        let at = (group_id, workspace_id.to_string());
        let version = *self.area_write.get(&at).ok_or_else(|| refused(NOT_CHECKED_KEYS))?;
        Ok(Some((at, version)))
    }

    fn read_version(&self, workspace_id: &str) -> CoreResult<Option<u64>> {
        Ok(self.read_at(workspace_id)?.map(|(_, version)| version))
    }

    fn write_version(&self, workspace_id: &str) -> CoreResult<Option<u64>> {
        let Some((at, version)) = self.read_at(workspace_id)? else {
            return Ok(None);
        };
        if self.blocked.contains_key(&at) {
            return Err(refused(KEYS_CHANGED));
        }
        // Only once a root wrapped under this very version was opened here. A root seen under
        // an earlier version is a key change this device committed but has not listed yet (a
        // sync between its acceptance and its root listing): a wait, which the next listing
        // ends. No root seen at all, or one past the chain, is not.
        match self.root_seen_at.get(&at) {
            Some(seen) if *seen == version => Ok(Some(version)),
            Some(seen) if *seen < version => Err(refused(KEY_CHANGE_PENDING)),
            _ => Err(refused(KEYS_CHANGED)),
        }
    }

    fn unwritable(&self, at: &AreaSlot, latest: u64) -> Option<AreaBlock> {
        if let Some(reason) = self.blocked.get(at) {
            return Some(*reason);
        }
        match self.root_seen_at.get(at) {
            Some(seen) if *seen == latest => None,
            None => Some(AreaBlock::RootUnknown),
            Some(_) => Some(AreaBlock::RootBehind),
        }
    }

    fn require_writable(&self, workspace_id: &str) -> CoreResult<()> {
        if let Some(version) = self.write_version(workspace_id)? {
            let held = self.workspace_keys.get(workspace_id).is_some_and(|w| w.keys.contains_key(&version));
            if !held {
                return Err(refused(KEYS_CHANGED));
            }
        }
        Ok(())
    }

    /*
     * A root a listing just opened under the area key at `parent_key_epoch`: seen only when its
     * family's chain committed to its key there; an older root that holds never lowers what was
     * seen, and the first that holds is the area's root node from then on.
     */
    fn root_seen(
        &mut self,
        workspace_id: &str,
        node_id: &str,
        parent_key_epoch: u64,
        root_key: &[u8],
    ) -> CoreResult<bool> {
        if !self.is_area(workspace_id) {
            return Ok(true);
        }
        // Without its family's committed chain nothing says which root is current: no write until one.
        let Some(group_id) = self.family_of(workspace_id) else {
            return Ok(true);
        };
        let Some(chain) = self.chains.get(&group_id).cloned() else {
            return Ok(true);
        };
        let at = (group_id, workspace_id.to_string());
        if area_root_check(chain, workspace_id.to_string(), parent_key_epoch, root_key.to_vec()).is_err() {
            // A root refused at the version seen, or at the write version itself, leaves no root
            // seen: the area reads as a key change that went wrong (KEYS_CHANGED), not one still on
            // its way, until a committed root at the write version opens.
            if self.root_seen_at.get(&at) == Some(&parent_key_epoch)
                || self.area_write.get(&at) == Some(&parent_key_epoch)
            {
                self.root_seen_at.remove(&at);
            }
            return Ok(false);
        }
        let seen = self.root_seen_at.get(&at).copied();
        if seen.is_none_or(|seen| seen < parent_key_epoch) {
            self.root_seen_at.insert(at.clone(), parent_key_epoch);
        }
        // Only a root at the area's write version names the root node: an older top-level row (one
        // a removed member holding an old area key could plant) never wins it.
        if self.area_write.get(&at) == Some(&parent_key_epoch) {
            self.root_ids.entry(at).or_insert_with(|| node_id.to_string());
        }
        Ok(true)
    }

    /* Whether a top-level row is another node than the root its family's area already has. */
    fn not_the_root(&self, workspace_id: &str, node_id: &str) -> bool {
        let Some(group_id) = self.family_of(workspace_id) else {
            return false;
        };
        self.root_ids.get(&(group_id, workspace_id.to_string())).is_some_and(|root| root != node_id)
    }

    fn commit(&mut self, chain: Arc<AcceptedRosters>) -> CoreResult<()> {
        // The family's floor first: the highest chain committed this session, which a refusal's
        // uncommit leaves in place, so no chain below it (or beside it) is ever committed again.
        if let Some(floor) = self.floors.get(&chain.group_id) {
            if floor.roster.roster_version > chain.roster.roster_version {
                return Err(refused(OLDER_CHAIN));
            }
            if floor.roster.roster_version == chain.roster.roster_version
                && floor.roster_digest != chain.roster_digest
            {
                return Err(refused(SPLIT_CHAIN));
            }
        }
        if let Some(held) = self.chains.get(&chain.group_id) {
            if held.roster.roster_version > chain.roster.roster_version {
                return Err(refused(OLDER_CHAIN));
            }
            // Another roster at the very version held: a split view, never committed over it.
            if held.roster.roster_version == chain.roster.roster_version
                && held.roster_digest != chain.roster_digest
            {
                return Err(refused(SPLIT_CHAIN));
            }
        }
        let group_id = chain.group_id.clone();
        for workspace_id in chain.area_keys.keys() {
            let at = (group_id.clone(), workspace_id.clone());
            match area_write_version_of(&chain, workspace_id) {
                None => {
                    self.area_write.remove(&at);
                    self.root_seen_at.remove(&at);
                }
                Some(version) => {
                    self.area_write.insert(at, version);
                }
            }
        }
        self.forked.remove(&group_id);
        let higher = self
            .floors
            .get(&group_id)
            .is_none_or(|floor| floor.roster.roster_version < chain.roster.roster_version);
        if higher {
            self.floors.insert(group_id.clone(), Arc::clone(&chain));
        }
        self.chains.insert(group_id, chain);
        Ok(())
    }

    fn uncommit(&mut self, group_id: &str, fork: bool) {
        self.area_write.retain(|(group, _), _| group != group_id);
        self.chains.remove(group_id);
        if fork {
            self.forked.insert(group_id.to_string());
        } else {
            self.forked.remove(group_id);
        }
    }

    fn forget_group(&mut self, group_id: &str) {
        let opened: Vec<String> =
            self.opened.get(group_id).map(|areas| areas.keys().cloned().collect()).unwrap_or_default();
        for workspace_id in opened {
            self.drop_workspace(&workspace_id);
        }
        self.area_write.retain(|(group, _), _| group != group_id);
        self.blocked.retain(|(group, _), _| group != group_id);
        self.root_seen_at.retain(|(group, _), _| group != group_id);
        self.root_ids.retain(|(group, _), _| group != group_id);
        self.opened.remove(group_id);
        self.chains.remove(group_id);
        self.forked.remove(group_id);
        self.floors.remove(group_id);
    }

    /* The reader the app passes, held to the unlocked account: its id and its current signing key. */
    fn check_reader(&self, reader: &RecordReader) -> CoreResult<()> {
        let (user_id, signing_public_key) = self.account.as_ref().ok_or_else(|| refused(NO_ACCOUNT))?;
        if !reader.user_id.eq_ignore_ascii_case(user_id) || reader.keys.current != *signing_public_key {
            return Err(refused(NOT_THIS_ACCOUNT));
        }
        Ok(())
    }

    /* A signing seed the app passes, held to the unlocked account's current signing key. */
    fn check_seed(&self, signing_seed: &[u8]) -> CoreResult<()> {
        let (_, signing_public_key) = self.account.as_ref().ok_or_else(|| refused(NO_ACCOUNT))?;
        if signing_public_key_of(signing_seed)? != *signing_public_key {
            return Err(refused(NOT_THIS_ACCOUNT));
        }
        Ok(())
    }

    /* The family a folder is read under: the one it was opened under here, and only that one. */
    fn check_family(&self, group_id: &str, workspace_id: &str) -> CoreResult<()> {
        if self.family_of(workspace_id).as_deref() != Some(group_id) {
            return Err(refused(NOT_THIS_FAMILYS));
        }
        Ok(())
    }

    fn admit_area_key(
        &mut self,
        group_id: &str,
        workspace_id: &str,
        version: u64,
        key: Vec<u8>,
        served: u64,
        latest: u64,
    ) -> Option<AreaBlock> {
        let reason = if version < latest {
            Some(AreaBlock::NoGrantAtLatest)
        } else if served < latest {
            Some(AreaBlock::ServerBehind)
        } else if served > latest {
            Some(AreaBlock::ServerAhead)
        } else {
            None
        };
        self.hold_workspace_key(workspace_id, version, key);
        let at = (group_id.to_string(), workspace_id.to_string());
        match reason {
            Some(reason) => self.blocked.insert(at.clone(), reason),
            None => self.blocked.remove(&at),
        };
        // The root is the listing's to decide: until one is opened at the latest version, the
        // area reads root-unknown (or root-behind) and is not written.
        self.unwritable(&at, latest)
    }

    /* ------------------------------------------------------------ */
    /* Workspace and node keys                                       */
    /* ------------------------------------------------------------ */

    fn hold_workspace_key(&mut self, workspace_id: &str, version: u64, key: Vec<u8>) {
        let entry = self
            .workspace_keys
            .entry(workspace_id.to_string())
            .or_insert_with(|| WorkspaceKeys { current: version, keys: BTreeMap::new() });
        entry.keys.insert(version, Zeroizing::new(key));
        entry.current = entry.current.max(version);
    }

    fn drop_workspace(&mut self, workspace_id: &str) {
        self.workspace_keys.remove(workspace_id);
        for pool in [&mut self.own, &mut self.guest, &mut self.own_prev, &mut self.guest_prev] {
            pool.retain(|(ws, _), _| ws != workspace_id);
        }
        self.root_opened_under.retain(|(ws, _), _| ws != workspace_id);
        self.lineage.retain(|(ws, _), _| ws != workspace_id);
        self.pending.retain(|(ws, _), _| ws != workspace_id);
    }

    fn pool(&self, workspace_id: &str) -> &HashMap<Slot, Held> {
        if self.workspace_keys.contains_key(workspace_id) {
            &self.own
        } else {
            &self.guest
        }
    }

    fn pool_mut(&mut self, workspace_id: &str) -> &mut HashMap<Slot, Held> {
        if self.workspace_keys.contains_key(workspace_id) {
            &mut self.own
        } else {
            &mut self.guest
        }
    }

    fn prev_pool(&self, workspace_id: &str) -> &HashMap<Slot, Held> {
        if self.workspace_keys.contains_key(workspace_id) {
            &self.own_prev
        } else {
            &self.guest_prev
        }
    }

    fn prev_pool_mut(&mut self, workspace_id: &str) -> &mut HashMap<Slot, Held> {
        if self.workspace_keys.contains_key(workspace_id) {
            &mut self.own_prev
        } else {
            &mut self.guest_prev
        }
    }

    fn node_key(&self, workspace_id: &str, node_id: &str) -> Option<&Held> {
        self.pool(workspace_id).get(&slot(workspace_id, node_id))
    }

    fn key_at_epoch(&self, workspace_id: &str, node_id: &str, epoch: u64) -> Option<Vec<u8>> {
        if let Some(current) = self.node_key(workspace_id, node_id) {
            if current.epoch == epoch {
                return Some(current.key.to_vec());
            }
        }
        let previous = self.prev_pool(workspace_id).get(&slot(workspace_id, node_id))?;
        (previous.epoch == epoch).then(|| previous.key.to_vec())
    }

    fn lineage_of(&self, workspace_id: &str, node_id: &str) -> Option<u64> {
        self.lineage.get(&slot(workspace_id, node_id)).copied().flatten()
    }

    /* The key a node is wrapped under, to open it, and what its path is rooted at. */
    fn parent_key_and_root(
        &self,
        workspace_id: &str,
        parent_id: &str,
        parent_key_epoch: u64,
    ) -> CoreResult<(Zeroizing<Vec<u8>>, Option<u64>)> {
        if parent_id == workspace_id {
            let workspace = self.workspace_keys.get(workspace_id).ok_or_else(|| refused(OPEN_DRIVE))?;
            let key = workspace.keys.get(&parent_key_epoch).ok_or_else(|| refused(OLDER_WORKSPACE_KEY))?;
            return Ok((key.clone(), Some(parent_key_epoch)));
        }
        if let Some(pending) = self.pending.get(&slot(workspace_id, parent_id)) {
            if pending.epoch == parent_key_epoch {
                return Ok((pending.fresh.clone(), pending.rooted_at));
            }
            if pending.old_epoch == parent_key_epoch {
                return Ok((pending.old.clone(), None));
            }
        }
        let parent = self.node_key(workspace_id, parent_id).ok_or_else(|| refused(OPEN_PARENT))?;
        if parent.epoch == parent_key_epoch {
            return Ok((parent.key.clone(), self.lineage_of(workspace_id, parent_id)));
        }
        if let Some(previous) = self.prev_pool(workspace_id).get(&slot(workspace_id, parent_id)) {
            if previous.epoch == parent_key_epoch {
                return Ok((previous.key.clone(), None));
            }
        }
        Err(refused(OLDER_FOLDER_KEY))
    }

    fn rooted_now(&self, workspace_id: &str, rooted_at: Option<u64>) -> CoreResult<bool> {
        let Some(rooted_at) = rooted_at else {
            return Ok(false);
        };
        Ok(Some(rooted_at) == self.write_version(workspace_id)?)
    }

    fn rooted_at_write_version(&self, workspace_id: &str, node_id: &str) -> CoreResult<bool> {
        self.rooted_now(workspace_id, self.lineage_of(workspace_id, node_id))
    }

    fn writable_node_key(&self, workspace_id: &str, node_id: &str) -> CoreResult<Option<&Held>> {
        let node = self.node_key(workspace_id, node_id);
        if node.is_some()
            && self.is_area(workspace_id)
            && !self.rooted_at_write_version(workspace_id, node_id)?
        {
            return Err(refused(KEY_CHANGE_PENDING));
        }
        Ok(node)
    }

    fn write_version_of(&self, workspace_id: &str) -> CoreResult<(u64, Zeroizing<Vec<u8>>)> {
        let workspace = self.workspace_keys.get(workspace_id).ok_or_else(|| refused(OPEN_DRIVE))?;
        let version = match self.write_version(workspace_id)? {
            Some(version) => version,
            None => workspace.current,
        };
        let key = workspace.keys.get(&version).ok_or_else(|| refused(KEYS_CHANGED))?;
        Ok((version, key.clone()))
    }

    /* The key a new or re-wrapped node goes under. */
    fn wrap_key_for(
        &self,
        workspace_id: &str,
        parent_id: &str,
        parent_key_epoch: u64,
    ) -> CoreResult<Zeroizing<Vec<u8>>> {
        if parent_id == workspace_id {
            // A family folder has one root, made and re-keyed only with its roster.
            if self.is_area(workspace_id) {
                return Err(refused(AREA_ROOT));
            }
            let (version, key) = self.write_version_of(workspace_id)?;
            if version != parent_key_epoch {
                return Err(refused(KEYS_CHANGED));
            }
            return Ok(key);
        }
        if !self.is_area(workspace_id) {
            return Ok(self.parent_key_and_root(workspace_id, parent_id, parent_key_epoch)?.0);
        }
        // A write needs a parent whose key path is rooted at the area's write version (F14).
        let pending = self.pending.get(&slot(workspace_id, parent_id));
        if let Some(pending) = pending {
            if pending.epoch == parent_key_epoch {
                if !self.rooted_now(workspace_id, pending.rooted_at)? {
                    return Err(refused(KEY_CHANGE_PENDING));
                }
                return Ok(pending.fresh.clone());
            }
        }
        let parent = self.node_key(workspace_id, parent_id).ok_or_else(|| refused(OPEN_PARENT))?;
        if !self.rooted_at_write_version(workspace_id, parent_id)? {
            return Err(refused(KEY_CHANGE_PENDING));
        }
        if parent.epoch == parent_key_epoch && !pending.is_some_and(|p| p.old_epoch == parent_key_epoch) {
            return Ok(parent.key.clone());
        }
        Err(refused(KEYS_CHANGED))
    }

    fn remember_node_key(
        &mut self,
        workspace_id: &str,
        node_id: &str,
        key: Vec<u8>,
        epoch: u64,
        rooted_at: Option<u64>,
    ) {
        let at = slot(workspace_id, node_id);
        self.pool_mut(workspace_id).insert(at.clone(), Held { key: Zeroizing::new(key), epoch, own: false });
        self.lineage.insert(at.clone(), rooted_at);
        // Whatever opened it before, this key was not opened from a root row here.
        self.root_opened_under.remove(&at);
    }

    fn remember_prev_node_key(
        &mut self,
        workspace_id: &str,
        node_id: &str,
        key: Vec<u8>,
        epoch: u64,
        own: bool,
    ) {
        self.prev_pool_mut(workspace_id)
            .insert(slot(workspace_id, node_id), Held { key: Zeroizing::new(key), epoch, own });
    }

    /* ------------------------------------------------------------ */
    /* Listings, new nodes and rotations                             */
    /* ------------------------------------------------------------ */

    fn open_listed_node(&mut self, workspace_id: &str, node: &ServedNodeKey) -> CoreResult<Vec<u8>> {
        let at = slot(workspace_id, &node.node_id);
        let area_root = node.parent_id == workspace_id && self.is_area(workspace_id);
        // Another top-level node than the area's root: nothing in Drive goes there (wrap_key_for),
        // so it is planted, and it decides nothing about the area.
        if area_root && self.not_the_root(workspace_id, &node.node_id) {
            return Err(refused(NOT_COMMITTED_ROOT));
        }
        let cached = self.node_key(workspace_id, &node.node_id).map(|held| (held.key.to_vec(), held.epoch));
        // A group area's root is taken from the cache only under the area key version it was
        // opened under: a row that names another is opened again.
        let mut key = cached.as_ref().and_then(|(key, epoch)| {
            (*epoch == node.key_epoch
                && (!area_root || self.root_opened_under.get(&at) == Some(&node.parent_key_epoch)))
            .then(|| Zeroizing::new(key.clone()))
        });
        // An area root re-keyed since this device opened it: the key it held is the root's
        // previous one, kept if the served previous envelope does not open.
        let mut held_previous: Option<Zeroizing<Vec<u8>>> = match (&cached, key.is_none()) {
            (Some((cached_key, epoch)), true)
                if area_root && node.prev_key_epoch == Some(*epoch) && *epoch != node.key_epoch =>
            {
                Some(Zeroizing::new(cached_key.clone()))
            }
            _ => None,
        };
        if key.is_none() {
            let (parent_key, rooted_at) =
                self.parent_key_and_root(workspace_id, &node.parent_id, node.parent_key_epoch)?;
            let opened = Zeroizing::new(node_open_checked(
                &ctx(workspace_id, &node.node_id, &node.parent_id, node.parent_key_epoch, node.key_epoch),
                &parent_key,
                &node.key_envelope,
            )?);
            self.remember_node_key(workspace_id, &node.node_id, opened.to_vec(), node.key_epoch, rooted_at);
            if area_root {
                self.root_opened_under.insert(at.clone(), node.parent_key_epoch);
            }
            key = Some(opened);
        }
        let key = key.expect("opened or cached");
        // A group area's root decides whether the area may be written: only one whose envelope
        // opened under the area's write version, and whose key the roster committed to there.
        if area_root && !self.root_seen(workspace_id, &node.node_id, node.parent_key_epoch, &key)? {
            self.pool_mut(workspace_id).remove(&at);
            self.root_opened_under.remove(&at);
            return Err(refused(NOT_COMMITTED_ROOT));
        }
        // Mid-rotation: the same key under the previous parent key opens children the rotation
        // has not reached; failure to open it is not failure to open the node.
        let prev = match (&node.prev_key_envelope, node.prev_parent_key_epoch, node.prev_key_epoch) {
            (Some(envelope), Some(parent_epoch), Some(epoch))
                if !envelope.is_empty() && parent_epoch != 0 && epoch != 0 =>
            {
                Some((envelope.clone(), parent_epoch, epoch))
            }
            _ => None,
        };
        if let Some((envelope, prev_parent_epoch, prev_epoch)) = prev {
            let previous = (|| -> CoreResult<Vec<u8>> {
                let (previous_parent, _) =
                    self.parent_key_and_root(workspace_id, &node.parent_id, prev_parent_epoch)?;
                let context =
                    ctx(workspace_id, &node.node_id, &node.parent_id, prev_parent_epoch, prev_epoch);
                if envelope.len() != 72 {
                    return Err(input("Invalid key envelope."));
                }
                // An area root's previous key under the new area key is option A's, under its own
                // label; one a Drive batch kept is a plain node key.
                if area_root {
                    previous_root_key_open(context.clone(), previous_parent.to_vec(), envelope.clone())
                        .or_else(|_| node_open_checked(&context, &previous_parent, &envelope))
                } else {
                    node_open_checked(&context, &previous_parent, &envelope)
                }
            })()
            .ok()
            .map(Zeroizing::new);
            // An area root's old key this device opened itself outranks whatever the served
            // envelope opens to.
            let kept = self
                .prev_pool(workspace_id)
                .get(&at)
                .filter(|kept| area_root && kept.own && kept.epoch == prev_epoch)
                .map(|kept| Zeroizing::new(kept.key.to_vec()));
            let own = held_previous.take().or(kept);
            if let Some(own) = own {
                self.remember_prev_node_key(workspace_id, &node.node_id, own.to_vec(), prev_epoch, true);
            } else if let Some(previous) = previous {
                self.remember_prev_node_key(
                    workspace_id,
                    &node.node_id,
                    previous.to_vec(),
                    prev_epoch,
                    false,
                );
            }
        }
        Ok(key.to_vec())
    }

    fn new_node_key(
        &mut self,
        workspace_id: &str,
        node_id: &str,
        parent_id: &str,
        parent_key_epoch: u64,
        key_epoch: u64,
    ) -> CoreResult<NewNodeKey> {
        let parent_key = self.wrap_key_for(workspace_id, parent_id, parent_key_epoch)?;
        let key = Zeroizing::new(random(32));
        let key_envelope = node_wrap_checked(
            &ctx(workspace_id, node_id, parent_id, parent_key_epoch, key_epoch),
            &parent_key,
            &key,
        )?;
        // Rooted where its parent is (wrap_key_for saw to it).
        let rooted_at = self.parent_key_and_root(workspace_id, parent_id, parent_key_epoch)?.1;
        self.remember_node_key(workspace_id, node_id, key.to_vec(), key_epoch, rooted_at);
        Ok(NewNodeKey { key: SecretBytes::new(key.to_vec()), key_envelope })
    }

    fn current_key_of(&self, workspace_id: &str, node: &RotatingNodeKey) -> CoreResult<Zeroizing<Vec<u8>>> {
        if let Some(cached) = self.node_key(workspace_id, &node.node_id) {
            if cached.epoch == node.key_epoch {
                return Ok(cached.key.clone());
            }
        }
        let (parent_key, _) =
            self.parent_key_and_root(workspace_id, &node.parent_id, node.wrapped_parent_key_epoch)?;
        Ok(Zeroizing::new(node_open_checked(
            &ctx(workspace_id, &node.node_id, &node.parent_id, node.wrapped_parent_key_epoch, node.key_epoch),
            &parent_key,
            &node.key_envelope,
        )?))
    }

    fn rotation_old_key(&self, workspace_id: &str, node: &RotatingNodeKey) -> CoreResult<Zeroizing<Vec<u8>>> {
        if node.parent_id == workspace_id && self.is_area(workspace_id) {
            return Err(refused(AREA_ROOT));
        }
        self.current_key_of(workspace_id, node)
    }

    fn rewrap_at_target(
        &mut self,
        workspace_id: &str,
        node: &RotatingNodeKey,
        old: Zeroizing<Vec<u8>>,
    ) -> CoreResult<Vec<u8>> {
        let cached = self.node_key(workspace_id, &node.node_id).map(|held| held.epoch);
        // What the key is rooted at: this device's own copy, or the envelope's path.
        let rooted_at = if cached == Some(node.key_epoch) {
            self.lineage_of(workspace_id, &node.node_id)
        } else {
            self.parent_key_and_root(workspace_id, &node.parent_id, node.wrapped_parent_key_epoch)?.1
        };
        // In a group area, a key reached through one the rotation replaces is anyone's who held
        // that key: only a key rooted at the write version is carried into the new tree.
        if self.is_area(workspace_id) && !self.rooted_now(workspace_id, rooted_at)? {
            return Err(refused(NOT_CARRIED));
        }
        let parent_key = self.wrap_key_for(workspace_id, &node.parent_id, node.parent_key_epoch)?;
        let key_envelope = node_wrap_checked(
            &ctx(workspace_id, &node.node_id, &node.parent_id, node.parent_key_epoch, node.key_epoch),
            &parent_key,
            &old,
        )?;
        // The same key, still, rooted where it was: never vouched for by this re-wrap.
        if cached.is_none() {
            self.remember_node_key(workspace_id, &node.node_id, old.to_vec(), node.key_epoch, rooted_at);
        }
        Ok(key_envelope)
    }

    /*
     * One node of a walk to `target_epoch` (the worker's rotateKey): a node
     * already at the target is re-wrapped, only if its key is rooted at the
     * write version (NOT_CARRIED); any other gets a fresh key under a parent
     * the rules allow, handed to `rekey` with the key it replaces, and is
     * marked pending only once `rekey` succeeded. A family folder's top level
     * is never a walk's (AREA_ROOT).
     */
    fn rotate_key_with<T>(
        &mut self,
        workspace_id: &str,
        node: &RotatingNodeKey,
        target_epoch: u64,
        rekey: impl FnOnce(&[u8], &[u8]) -> CoreResult<T>,
    ) -> CoreResult<Rotation<T>> {
        // As the web's driveRotateNodes: no walk in a family folder this device found unwritable.
        self.require_writable(workspace_id)?;
        let old = self.rotation_old_key(workspace_id, node)?;
        // Already at the target, only wrapped under an unrotated parent: the same key, re-wrapped.
        if node.key_epoch >= target_epoch {
            let kept = old.clone();
            let key_envelope = self.rewrap_at_target(workspace_id, node, old)?;
            return Ok(Rotation::Rewrap { key_envelope, key: kept });
        }
        // A second walk of the node to the same target while the first is pending: the first's fresh
        // key would be replaced under children already wrapped under it.
        if self.pending.get(&slot(workspace_id, &node.node_id)).is_some_and(|p| p.epoch == target_epoch) {
            return Err(refused(ITEM_CHANGED));
        }
        let fresh = Zeroizing::new(random(32));
        // A fresh key is a write like any other (F14): its parent is pending in this walk or
        // rooted at the write version.
        let parent_key = self.wrap_key_for(workspace_id, &node.parent_id, node.parent_key_epoch)?;
        let rooted_at = self.parent_key_and_root(workspace_id, &node.parent_id, node.parent_key_epoch)?.1;
        let key_envelope = node_wrap_checked(
            &ctx(workspace_id, &node.node_id, &node.parent_id, node.parent_key_epoch, target_epoch),
            &parent_key,
            &fresh,
        )?;
        // The node's records, re-keyed before anything is held: a failure leaves no pending key.
        let result = rekey(&old, &fresh)?;
        self.pending.insert(
            slot(workspace_id, &node.node_id),
            Pending {
                fresh: fresh.clone(),
                epoch: target_epoch,
                old: old.clone(),
                old_epoch: node.key_epoch,
                rooted_at,
            },
        );
        Ok(Rotation::Fresh { key_envelope, old, fresh, result })
    }

    fn commit_pending(&mut self, workspace_id: &str, node_ids: &[String]) -> u32 {
        let mut count = 0;
        for node_id in node_ids {
            let Some(pending) = self.pending.remove(&slot(workspace_id, node_id)) else {
                continue;
            };
            count += 1;
            self.remember_prev_node_key(workspace_id, node_id, pending.old.to_vec(), pending.old_epoch, true);
            // A fresh key: rooted where the parent it was wrapped under was.
            self.remember_node_key(
                workspace_id,
                node_id,
                pending.fresh.to_vec(),
                pending.epoch,
                pending.rooted_at,
            );
        }
        count
    }

    fn drop_all_pending(&mut self, workspace_id: &str) -> u32 {
        let before = self.pending.len();
        self.pending.retain(|(ws, _), _| ws != workspace_id);
        (before - self.pending.len()) as u32
    }

    fn drop_pending(&mut self, workspace_id: &str, node_ids: &[String]) -> u32 {
        let mut count = 0;
        for node_id in node_ids {
            if self.pending.remove(&slot(workspace_id, node_id)).is_some() {
                count += 1;
            }
        }
        count
    }
}

impl State {
    /*
     * The verdict glue's view of a family (the worker's verdicts): its
     * committed chain, or the fork its last acceptance was, or nothing; the
     * areas it opened here at the version opened.
     */
    fn judge(
        &self,
        group_id: &str,
        record: &ServedRecord,
        reader: RecordReader,
        writers: Vec<GroupWriter>,
        cache: Option<Arc<SuccessionCache>>,
    ) -> Judge {
        let reading = match self.chains.get(group_id) {
            Some(chain) => GroupReading::Accepted { chain: Arc::clone(chain) },
            None if self.forked.contains(group_id) => GroupReading::Fork,
            None => GroupReading::Unavailable,
        };
        let areas = self
            .opened
            .get(group_id)
            .map(|areas| areas.iter().map(|(at, area)| (at.clone(), area.version)).collect())
            .unwrap_or_default();
        let (workspace_id, _) = record_node(&record.statement);
        Judge::new(group_id.to_string(), workspace_id.to_string(), reading, areas, reader, writers, cache)
    }
}

/* The workspace and node a record belongs to, as its statement names them. */
fn record_node(statement: &RecordStatement) -> (&str, &str) {
    match statement {
        RecordStatement::Metadata { statement } => (&statement.workspace_id, &statement.node_id),
        RecordStatement::Version { statement } => (&statement.workspace_id, &statement.node_id),
    }
}

/* What a walk did with one node's key: re-wrapped it at the target, or replaced it (pending). */
enum Rotation<T> {
    Rewrap { key_envelope: Vec<u8>, key: Zeroizing<Vec<u8>> },
    Fresh { key_envelope: Vec<u8>, old: Zeroizing<Vec<u8>>, fresh: Zeroizing<Vec<u8>>, result: T },
}

fn area_write_version_of(chain: &AcceptedRosters, workspace_id: &str) -> Option<u64> {
    if chain.retired_areas.iter().any(|retired| retired == workspace_id) {
        return None;
    }
    chain.area_keys.get(workspace_id).map(|list| list.len() as u64)
}

/// The keys an unlocked session holds for Drive, and the family write rules
/// that decide which of them a write may use (module docs). One per session:
/// the app's Vault, its File Provider extension and its DocumentsProvider each
/// keep one, filled from listings as they open folders. It holds keys only in
/// memory; dropping it wipes them.
#[derive(Default)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct AreaLedger {
    state: Mutex<State>,
}

impl std::fmt::Debug for AreaLedger {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AreaLedger(<keys>)")
    }
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl AreaLedger {
    /// An empty ledger.
    ///
    /// ```
    /// use hushos_core::AreaLedger;
    /// let ledger = AreaLedger::new();
    /// assert!(!ledger.is_area("11111111-1111-4111-8111-111111111111".into()));
    /// ```
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn new() -> Arc<AreaLedger> {
        Arc::new(AreaLedger::default())
    }

    /// A refusal (`fork` false) or a fork (`fork` true) for the family: none of its areas is written
    /// until a chain is committed again. After a fork, its records read by personal keys alone
    /// ([`AreaLedger::record_verdict`]); a commit or forgetting the family clears it.
    pub fn uncommit(&self, group_id: String, fork: bool) {
        self.lock().uncommit(&group_id, fork);
    }

    /// The unlocked account: its user id and current signing public key, as its open identity
    /// proves them, and its root (`account_key`, 32 bytes), from which the device store's key is
    /// derived and held (`hushos/group/device-store/v1`). Every verdict's reader, every walk's
    /// signing seed and every device record must be this account's; a lock
    /// ([`AreaLedger::clear`]) forgets it and wipes the key. Opening another account (or the same
    /// one again, after a master-key rotation) keeps no acceptance begun under the last one.
    pub fn open_account(
        &self,
        user_id: String,
        signing_public_key: Vec<u8>,
        account_key: Vec<u8>,
    ) -> CoreResult<()> {
        let account_key = Zeroizing::new(account_key);
        uuid(&user_id, "user id")?;
        if signing_public_key.len() != 32 {
            return Err(input("Invalid signing key."));
        }
        let store_key = crate::device_record::store_key(&account_key)?;
        let mut state = self.lock();
        // Another account than the one open: nothing of the last one stays (keys, chains, floors,
        // settings), as the web's unlock of another user forgets the Drive keys and the families.
        let another = state.account.as_ref().is_some_and(|(held, _)| !held.eq_ignore_ascii_case(&user_id));
        if another {
            let generation = state.generation + 1;
            *state = State::default();
            state.generation = generation;
        }
        state.account = Some((user_id.to_lowercase(), signing_public_key));
        state.store_key = Some(store_key);
        Ok(())
    }

    /// Settings served as a version 1 document, which opens nowhere and is not
    /// "no settings" either (the worker's `legacySettings`): after settings that
    /// opened in this unlock it is a rollback, refused; otherwise nothing is set,
    /// so acceptance stays refused until settings that open are used.
    pub fn legacy_settings(&self, user_id: String) -> CoreResult<()> {
        uuid(&user_id, "user id")?;
        let state = self.lock();
        let held = state.settings.as_ref().filter(|held| held.user_id.eq_ignore_ascii_case(&user_id));
        if held.is_some_and(|held| held.opened) {
            return Err(refused(OLDER_SETTINGS));
        }
        Ok(())
    }

    /// The group pins of the settings document the app just opened for `user_id`, or `None` when
    /// the server served none; a version 1 document is [`AreaLedger::legacy_settings`]. Within one unlock,
    /// settings that opened never give way to none: refused, and the pins held stay (decision D7;
    /// the worker's `useSettings`). [`AreaLedger::accept_served`] takes its settings pin from here.
    pub fn use_settings(&self, user_id: String, pins: Option<HashMap<String, GroupPin>>) -> CoreResult<()> {
        uuid(&user_id, "user id")?;
        let mut state = self.lock();
        let held = state.settings.as_ref().filter(|held| held.user_id.eq_ignore_ascii_case(&user_id));
        if pins.is_none() && held.is_some_and(|held| held.opened) {
            return Err(refused(OLDER_SETTINGS));
        }
        state.settings = Some(Settings {
            user_id: user_id.to_lowercase(),
            opened: pins.is_some(),
            pins: pins.unwrap_or_default(),
        });
        Ok(())
    }

    /// A family the person no longer reads: the keys of the areas it opened, and all it knew of them.
    /// Another family's chain listing those areas touches nothing.
    pub fn forget_group(&self, group_id: String) {
        self.lock().forget_group(&group_id);
    }

    /// Every key, wiped: a lock or a sign-out.
    pub fn clear(&self) {
        let mut state = self.lock();
        let generation = state.generation + 1;
        *state = State::default();
        state.generation = generation;
    }

    /// A family folder's key at `version`, as a grant (`area_grant_open`) or
    /// self-grant opened it, with the version the server reports
    /// (`served_version`). Refused unless the group's chain is committed here,
    /// the folder's id is derived under the group from `id_seed`, and the
    /// chain lists the folder with this key's commitment at that version.
    /// Writable only once a root at the chain's latest version is listed too.
    pub fn open_area(
        &self,
        group_id: String,
        workspace_id: String,
        id_seed: String,
        version: u64,
        area_key: Vec<u8>,
        served_version: u64,
    ) -> CoreResult<AreaOpened> {
        let area_key = Zeroizing::new(area_key);
        let mut state = self.lock();
        uuid(&group_id, "group id")?;
        let chain = state.chains.get(&group_id).cloned().ok_or_else(|| refused(NO_CHAIN))?;
        uuid(&workspace_id, "workspace id")?;
        if state.personal.contains(&workspace_id) {
            return Err(refused(NOT_THE_FAMILYS));
        }
        check_id(IdKind::Workspace, group_id.clone(), id_seed.clone(), workspace_id.clone())
            .map_err(|_| refused(NOT_THE_FAMILYS))?;
        let latest = area_write_version(Arc::clone(&chain), workspace_id.clone())
            .ok_or_else(|| refused(NOT_LISTED))?;
        let listed = chain.area_keys.get(&workspace_id).cloned().unwrap_or_default();
        let index = usize::try_from(version.wrapping_sub(1)).unwrap_or(usize::MAX);
        let commitment = area_key_commitment(&area_key).map_err(|_| refused(NOT_CHECKED_KEYS))?;
        if version == 0 || listed.get(index) != Some(&commitment) {
            return Err(refused(NOT_CHECKED_KEYS));
        }
        let group_id_of_area = group_id.clone();
        let areas = state.opened.entry(group_id).or_default();
        let before = areas.get(&workspace_id).map(|area| area.version).unwrap_or(0);
        areas.insert(workspace_id.clone(), OpenedArea { id_seed, version: before.max(version) });
        let reason = state.admit_area_key(
            &group_id_of_area,
            &workspace_id,
            version,
            area_key.to_vec(),
            served_version,
            latest,
        );
        Ok(AreaOpened {
            version,
            writable: reason.is_none(),
            reason,
            pin_area: crate::device_record::OpenedArea::new(group_id_of_area.clone(), workspace_id, version),
        })
    }

    /// The account's own workspace, its key at `version` opened from its grant
    /// (`workspace_open`): never a family folder, whatever a family's roster
    /// lists, so a hostile family naming it cannot lock the drive. Call it
    /// when the session opens its personal workspace, before any family sync.
    /// Refused for a family folder this session opened (its id derived under its family).
    pub fn open_personal_workspace(
        &self,
        workspace_id: String,
        version: u64,
        workspace_key: Vec<u8>,
    ) -> CoreResult<()> {
        let workspace_key = Zeroizing::new(workspace_key);
        let mut state = self.lock();
        if !state.opened_by(&workspace_id).is_empty() {
            return Err(refused(FAMILY_FOLDER));
        }
        state.personal.insert(workspace_id.clone());
        state.hold_workspace_key(&workspace_id, version, workspace_key.to_vec());
        Ok(())
    }

    /// Committed chains listing a family folder another family opened here,
    /// or the account's own workspace: what a hostile family's roster names,
    /// ignored for every decision, for the app to tell the person about.
    pub fn foreign_listings(&self) -> Vec<ForeignListing> {
        self.lock().foreign_listings()
    }

    /// Whether the workspace is a family folder this session knows.
    pub fn is_area(&self, workspace_id: String) -> bool {
        self.lock().is_area(&workspace_id)
    }

    /// The version a family folder is read under, none for a workspace that is no family's.
    pub fn read_version(&self, workspace_id: String) -> CoreResult<Option<u64>> {
        self.lock().read_version(&workspace_id)
    }

    /// The version a family folder is written under, none for a workspace that
    /// is no family's; refused while it may not be written.
    pub fn write_version(&self, workspace_id: String) -> CoreResult<Option<u64>> {
        self.lock().write_version(&workspace_id)
    }

    /// Refuses every write into a family folder this session has not found
    /// writable: blocked, not checked against a committed chain, without the
    /// key at the write version, or with no root seen at it (F9).
    pub fn require_writable(&self, workspace_id: String) -> CoreResult<()> {
        self.lock().require_writable(&workspace_id)
    }

    /// A listed node's key, opened (or taken from the session) and held with
    /// what its path is rooted at, and its previous key while a rotation runs.
    /// A family folder's top level decides whether the folder may be written:
    /// one whose key is not the one the chain committed to is dropped and
    /// refused ([`NOT_COMMITTED_ROOT`]).
    pub fn open_listed_node(&self, workspace_id: String, node: ServedNodeKey) -> CoreResult<SecretBytes> {
        self.lock().open_listed_node(&workspace_id, &node).map(SecretBytes::new)
    }

    /// The node's current key as the session holds it.
    pub fn node_key(&self, workspace_id: String, node_id: String) -> Option<HeldNodeKey> {
        self.lock()
            .node_key(&workspace_id, &node_id)
            .map(|held| HeldNodeKey { key: SecretBytes::new(held.key.to_vec()), epoch: held.epoch })
    }

    /// The node's key at `epoch` (its current key, or the previous one a
    /// rotation in progress keeps), for a re-keyed record's check; none when
    /// the session holds neither, which reads unchecked.
    pub fn key_at_epoch(&self, workspace_id: String, node_id: String, epoch: u64) -> Option<SecretBytes> {
        self.lock().key_at_epoch(&workspace_id, &node_id, epoch).map(SecretBytes::new)
    }

    /// A node's key for a write that puts something under it (its metadata, a
    /// version, a re-wrap): in a family folder only one whose path is rooted
    /// at the folder's write version, never one reached through a previous
    /// key ([`KEY_CHANGE_PENDING`]). None when the session holds none.
    pub fn writable_node_key(
        &self,
        workspace_id: String,
        node_id: String,
    ) -> CoreResult<Option<HeldNodeKey>> {
        let state = self.lock();
        Ok(state
            .writable_node_key(&workspace_id, &node_id)?
            .map(|held| HeldNodeKey { key: SecretBytes::new(held.key.to_vec()), epoch: held.epoch }))
    }

    /// A new node's key, made and wrapped under its parent by the write rules
    /// (never straight under a family folder's area key, never under a key not
    /// rooted at the write version), and held rooted where its parent is.
    pub fn new_node_key(
        &self,
        workspace_id: String,
        node_id: String,
        parent_id: String,
        parent_key_epoch: u64,
        key_epoch: u64,
    ) -> CoreResult<NewNodeKey> {
        let mut state = self.lock();
        state.require_writable(&workspace_id)?;
        state.new_node_key(&workspace_id, &node_id, &parent_id, parent_key_epoch, key_epoch)
    }

    /// A new node key made in a batch the server refused: dropped from the session.
    pub fn forget_node_key(&self, workspace_id: String, node_id: String) {
        let mut state = self.lock();
        state.pool_mut(&workspace_id).remove(&slot(&workspace_id, &node_id));
    }

    /// A move: the node's key (at `key_epoch`, as opened) wrapped under its new parent by the write rules.
    pub fn rewrap_node(
        &self,
        workspace_id: String,
        node_id: String,
        parent_id: String,
        parent_key_epoch: u64,
        key_epoch: u64,
    ) -> CoreResult<Vec<u8>> {
        let state = self.lock();
        state.require_writable(&workspace_id)?;
        let entry = state.writable_node_key(&workspace_id, &node_id)?.ok_or_else(|| refused(OPEN_PARENT))?;
        if entry.epoch != key_epoch {
            return Err(refused(ITEM_CHANGED));
        }
        let key = entry.key.clone();
        let parent_key = state.wrap_key_for(&workspace_id, &parent_id, parent_key_epoch)?;
        node_wrap_checked(
            &ctx(&workspace_id, &node_id, &parent_id, parent_key_epoch, key_epoch),
            &parent_key,
            &key,
        )
    }

    /// One node of a walk to `target_epoch` in a family folder, whole: a node
    /// already at the target is re-wrapped under its re-keyed parent, only if
    /// its key is rooted at the write version ([`NOT_CARRIED`]), its records
    /// untouched (`rewrap`); any other gets a fresh key under a parent the
    /// rules allow, and its metadata and versions are re-keyed raw under it
    /// and signed with `signing_seed`, which must be the unlocked account's
    /// ([`AreaLedger::open_account`]): an origin already kept is carried after
    /// the bound check, or dropped (`drop_origin`, re-sealed) when it does not
    /// bind, its writer is gone, or it names a writer with no signature; a
    /// signed record becomes its own origin; an unsigned one is re-sealed as the
    /// walker's (docs/integrity-design.md, "What the check does not stop"). No legacy
    /// signature goes beside a re-key. The fresh key is pending, for the
    /// node's children in the same walk, only once every record re-keyed,
    /// until [`AreaLedger::rotate_commit`]; it never leaves the ledger, and a
    /// second walk of the node to the same target meanwhile is refused
    /// (`ITEM_CHANGED`). Refused for a workspace that is no family folder
    /// ([`NOT_A_FAMILY_FOLDER`]), a node with shares or links
    /// ([`SHARED_IN_FAMILY`]), and a family folder's top level ([`AREA_ROOT`]).
    ///
    /// ```
    /// use hushos_core::*;
    /// let ledger = AreaLedger::new();
    /// let seed = random_bytes(32)?;
    /// ledger.open_account("00000001-abcd-4abc-8abc-abcdefabcdef".into(), signing_public_key(seed.clone())?, vec![9u8; 32])?;
    /// let personal = "f0f0f0f0-0000-4000-8000-00000000000f";
    /// ledger.open_personal_workspace(personal.into(), 1, random_bytes(32)?)?;
    /// let node = RotatingNode {
    ///     node_id: "0e0e0e0e-0000-4000-8000-000000000002".into(), parent_id: personal.into(),
    ///     parent_key_epoch: 1, key_epoch: 1, wrapped_parent_key_epoch: 1, key_envelope: vec![0; 72],
    ///     kind: NodeKind::File, metadata_version: 1, metadata_envelope: vec![0; 64],
    ///     metadata_signer: None, metadata_signature: None, metadata_rekey: None,
    ///     versions: vec![], share_ids: vec![], link_ids: vec![],
    /// };
    /// // Another identity's seed is refused before anything is made.
    /// let other = ledger.rotate_node(personal.into(), node.clone(), 2, random_bytes(32)?).unwrap_err();
    /// assert_eq!(other.to_string(), NOT_THIS_ACCOUNT);
    /// // A personal folder's walk stays with the app's own re-sealing.
    /// let refused = ledger.rotate_node(personal.into(), node, 2, seed).unwrap_err();
    /// assert_eq!(refused.to_string(), NOT_A_FAMILY_FOLDER);
    /// assert_eq!(ledger.rotate_drop_all(personal.into()), 0, "nothing pending");
    /// # Ok::<(), hushos_core::CoreError>(())
    /// ```
    pub fn rotate_node(
        &self,
        workspace_id: String,
        node: RotatingNode,
        target_epoch: u64,
        signing_seed: Vec<u8>,
    ) -> CoreResult<RotatedNode> {
        let signing_seed = Zeroizing::new(signing_seed);
        let mut state = self.lock();
        state.check_seed(&signing_seed)?;
        state.require_writable(&workspace_id)?;
        if !state.is_area(&workspace_id) {
            return Err(refused(NOT_A_FAMILY_FOLDER));
        }
        if !node.share_ids.is_empty() || !node.link_ids.is_empty() {
            return Err(refused(SHARED_IN_FAMILY));
        }
        let key = RotatingNodeKey {
            node_id: node.node_id.clone(),
            parent_id: node.parent_id.clone(),
            parent_key_epoch: node.parent_key_epoch,
            key_epoch: node.key_epoch,
            wrapped_parent_key_epoch: node.wrapped_parent_key_epoch,
            key_envelope: node.key_envelope.clone(),
        };
        let rotation = state.rotate_key_with(&workspace_id, &key, target_epoch, |old, fresh| {
            rekey_node_records(&workspace_id, &node, old, fresh, target_epoch, &signing_seed)
        })?;
        Ok(match rotation {
            Rotation::Rewrap { key_envelope, .. } => RotatedNode {
                node_id: node.node_id,
                key_envelope,
                rewrap: true,
                metadata: None,
                versions: vec![],
            },
            Rotation::Fresh { key_envelope, result: (metadata, versions), .. } => RotatedNode {
                node_id: node.node_id,
                key_envelope,
                rewrap: false,
                metadata: Some(metadata),
                versions,
            },
        })
    }

    /// What a reader shows for one record in a family folder (design 2.8): a
    /// signed record by this account under its own keys, anyone else's as the
    /// family's committed chain says ([`crate::group_writer_trust`], each
    /// writer's pin, served identity and links from `writers`, and their
    /// personal keys where the roster does not speak); a re-keyed one with the
    /// node's key at `record.key_epoch` as this ledger holds it (unchecked
    /// without an epoch), its origin judged as its writer's trust says and the
    /// re-keyer (the record's signer) as theirs. The family is the one the
    /// folder was opened under here: another `group_id` is refused
    /// ([`NOT_THIS_FAMILYS`]). Without a committed chain the family reads as
    /// unchecked, or, when its last acceptance was the fork
    /// ([`AreaLedger::uncommit`]), by personal keys alone. `reader` must be the
    /// unlocked account ([`AreaLedger::open_account`]). `cache` is the
    /// session's, shared across calls.
    ///
    /// ```
    /// use hushos_core::*;
    /// let seed = random_bytes(32)?;
    /// let me = TrustedKeys { current: signing_public_key(seed.clone())?, retired: vec![] };
    /// let statement = MetadataStatement {
    ///     workspace_id: "80558a81-8dfc-8914-8447-0417b55e2ec5".into(),
    ///     node_id: "0e0e0e0e-0000-4000-8000-000000000002".into(), kind: NodeKind::File, metadata_version: 1,
    /// };
    /// let record = ServedRecord {
    ///     statement: RecordStatement::Metadata { statement: statement.clone() },
    ///     key_epoch: Some(1), envelope: b"sealed".to_vec(), signer: None,
    ///     signature: Some(metadata_sign(seed, statement, b"sealed".to_vec())?), rekey: None,
    /// };
    /// let ledger = AreaLedger::new();
    /// let account = "00000001-abcd-4abc-8abc-abcdefabcdef";
    /// ledger.open_account(account.into(), me.current.clone(), vec![9u8; 32])?;
    /// let reader = RecordReader { user_id: account.into(), keys: me };
    /// // A folder no family opened here: no family speaks for it.
    /// let refused = ledger
    ///     .record_verdict("0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".into(), reader, vec![], record, None)
    ///     .unwrap_err();
    /// assert_eq!(refused.to_string(), NOT_THIS_FAMILYS);
    /// # Ok::<(), hushos_core::CoreError>(())
    /// ```
    pub fn record_verdict(
        &self,
        group_id: String,
        reader: RecordReader,
        writers: Vec<GroupWriter>,
        record: ServedRecord,
        cache: Option<Arc<SuccessionCache>>,
    ) -> CoreResult<RecordVerdict> {
        let (judge, node_key) = {
            let state = self.lock();
            state.check_reader(&reader)?;
            let (workspace_id, node_id) = record_node(&record.statement);
            state.check_family(&group_id, workspace_id)?;
            let node_key =
                record.key_epoch.and_then(|epoch| state.key_at_epoch(workspace_id, node_id, epoch));
            (state.judge(&group_id, &record, reader, writers, cache), node_key)
        };
        let node_key = node_key.map(Zeroizing::new);
        Ok(match &record.rekey {
            Some(rekey) => RecordVerdict::Rekeyed {
                verdict: judge.rekeyed(
                    &record.statement,
                    record.key_epoch.unwrap_or(0),
                    &record.envelope,
                    rekey,
                    record.signer.as_deref(),
                    node_key.as_ref().map(|key| key.to_vec()),
                ),
            },
            None => RecordVerdict::Signed {
                verdict: judge.signed(
                    &record.statement,
                    &record.envelope,
                    record.signer.as_deref(),
                    record.signature.as_deref(),
                ),
            },
        })
    }

    /// How a copy of `record` out of a family folder signs it: the prior to
    /// pass to [`crate::metadata_copy_sign`] or [`crate::version_copy_sign`]
    /// with `from_link` false. `Verified` and `SavedFromLink` stay so; a
    /// former member's record, a key conflict's, a re-keyed record whose
    /// origin does not bind (or whose node key this ledger does not hold), and
    /// anything else read `Resealed`; an unchecked record is refused, so
    /// nothing is vouched for blind, and so is a re-keyed record served
    /// without its key epoch (never judged through the walker's legacy
    /// columns). Refused for a folder the family's committed chain does not
    /// list or that was not opened under this family here
    /// ([`NOT_THIS_FAMILYS`]), and for a `reader` that is not the unlocked
    /// account.
    ///
    /// ```
    /// use hushos_core::*;
    /// let seed = random_bytes(32)?;
    /// let me = TrustedKeys { current: signing_public_key(seed.clone())?, retired: vec![] };
    /// let statement = MetadataStatement {
    ///     workspace_id: "80558a81-8dfc-8914-8447-0417b55e2ec5".into(),
    ///     node_id: "0e0e0e0e-0000-4000-8000-000000000002".into(), kind: NodeKind::File, metadata_version: 1,
    /// };
    /// let record = ServedRecord {
    ///     statement: RecordStatement::Metadata { statement: statement.clone() },
    ///     key_epoch: Some(1), envelope: b"sealed".to_vec(), signer: None,
    ///     signature: Some(metadata_sign(seed, statement, b"sealed".to_vec())?), rekey: None,
    /// };
    /// let ledger = AreaLedger::new();
    /// let account = "00000001-abcd-4abc-8abc-abcdefabcdef";
    /// ledger.open_account(account.into(), me.current.clone(), vec![9u8; 32])?;
    /// let reader = RecordReader { user_id: account.into(), keys: me };
    /// // No family chain committed here: nothing is copied out on its word.
    /// let refused = ledger
    ///     .copy_form("0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".into(), reader, vec![], record, None)
    ///     .unwrap_err();
    /// assert_eq!(refused.to_string(), NOT_THIS_FAMILYS);
    /// # Ok::<(), hushos_core::CoreError>(())
    /// ```
    pub fn copy_form(
        &self,
        group_id: String,
        reader: RecordReader,
        writers: Vec<GroupWriter>,
        record: ServedRecord,
        cache: Option<Arc<SuccessionCache>>,
    ) -> CoreResult<Integrity> {
        let (judge, node_key) = {
            let state = self.lock();
            state.check_reader(&reader)?;
            let (workspace_id, node_id) = record_node(&record.statement);
            let listed =
                state.chains.get(&group_id).is_some_and(|chain| chain.area_keys.contains_key(workspace_id));
            if !listed {
                return Err(refused(NOT_THIS_FAMILYS));
            }
            state.check_family(&group_id, workspace_id)?;
            let node_key =
                record.key_epoch.and_then(|epoch| state.key_at_epoch(workspace_id, node_id, epoch));
            (state.judge(&group_id, &record, reader, writers, cache), node_key)
        };
        let node_key = node_key.map(Zeroizing::new);
        let verdict = match (&record.rekey, record.key_epoch) {
            (Some(rekey), Some(key_epoch)) => {
                let checked = judge.rekeyed(
                    &record.statement,
                    key_epoch,
                    &record.envelope,
                    rekey,
                    record.signer.as_deref(),
                    node_key.as_ref().map(|key| key.to_vec()),
                );
                // Bytes that do not bind to the writer's record: re-sealed, never vouched for.
                if checked.bound != Some(true) {
                    return Ok(Integrity::Resealed);
                }
                checked.origin.verdict
            }
            // A re-keyed record without its epoch: its signature columns are the walker's, so
            // nothing about its writer can be judged. Unchecked, and not copied.
            (Some(_), None) => GroupVerdict::Unchecked,
            (None, _) => {
                judge
                    .signed(
                        &record.statement,
                        &record.envelope,
                        record.signer.as_deref(),
                        record.signature.as_deref(),
                    )
                    .verdict
            }
        };
        if matches!(verdict, GroupVerdict::KeyConflict | GroupVerdict::FormerMember) {
            return Ok(Integrity::Resealed);
        }
        copy_prior(verdict)
    }

    /// The server took the batch: each node's fresh key is its own, the key it replaced its previous one.
    pub fn rotate_commit(&self, workspace_id: String, node_ids: Vec<String>) -> u32 {
        self.lock().commit_pending(&workspace_id, &node_ids)
    }

    /// The server refused the batch (or re-keying a node's records failed): the fresh keys are dropped.
    pub fn rotate_drop(&self, workspace_id: String, node_ids: Vec<String>) -> u32 {
        self.lock().drop_pending(&workspace_id, &node_ids)
    }

    /// A walk abandoned, or a batch whose node list the app lost: every fresh key pending in the
    /// workspace, dropped. What an app calls when it cannot tell which nodes a failed batch held.
    pub fn rotate_drop_all(&self, workspace_id: String) -> u32 {
        self.lock().drop_all_pending(&workspace_id)
    }

    /// A share, link or report naming one of this session's own workspaces: a key planted, never taken.
    pub fn refuse_own_workspace(&self, workspace_id: String) -> CoreResult<()> {
        if self.lock().workspace_keys.contains_key(&workspace_id) {
            return Err(refused(OWN_WORKSPACE));
        }
        Ok(())
    }
}

impl AreaLedger {
    /// A walk's key half alone, for the shared scenarios and the fuzz target
    /// (Rust callers only, never exported to the apps): [`AreaLedger::rotate_node`]
    /// with no records, the fresh key pending once it is wrapped.
    #[doc(hidden)]
    pub fn rotate_key(
        &self,
        workspace_id: String,
        node: RotatingNodeKey,
        target_epoch: u64,
    ) -> CoreResult<RotatedKey> {
        Ok(match self.lock().rotate_key_with(&workspace_id, &node, target_epoch, |_, _| Ok(()))? {
            Rotation::Rewrap { key_envelope, key } => RotatedKey {
                key_envelope,
                rewrap: true,
                old_key: Some(SecretBytes::new(key.to_vec())),
                fresh_key: None,
            },
            Rotation::Fresh { key_envelope, old, fresh, .. } => RotatedKey {
                key_envelope,
                rewrap: false,
                old_key: Some(SecretBytes::new(old.to_vec())),
                fresh_key: Some(SecretBytes::new(fresh.to_vec())),
            },
        })
    }

    /// A family's chain, accepted from what the server served (never a staged
    /// one): its areas are written under the versions it lists, and only its
    /// own areas (an area is resolved only through the family it was opened
    /// under; another family listing it is only reported). A new write
    /// version needs its root seen again; a retired area is written no more.
    /// Refused ([`OLDER_CHAIN`]) for a chain older than the family's floor (the
    /// highest committed this session, kept across refusals) or the one held,
    /// and ([`SPLIT_CHAIN`]) for another chain at that version. Not exported:
    /// apps commit only through [`AreaLedger::accept_served`] (Core 4's join
    /// and creation will go through it too); the shared scenarios and tests
    /// call it directly.
    pub fn commit(&self, chain: Arc<AcceptedRosters>) -> CoreResult<()> {
        self.lock().commit(chain)
    }

    /* The chain committed for the family, if any (accept_served's mark and floor). */
    #[cfg(test)]
    pub(crate) fn held_chain(&self, group_id: &str) -> Option<Arc<AcceptedRosters>> {
        self.lock().chains.get(group_id).cloned()
    }

    #[cfg(test)]
    pub(crate) fn is_forked(&self, group_id: &str) -> bool {
        self.lock().forked.contains(group_id)
    }

    /* The unlocked account as an acceptance runs for it: user id, signing key, store key and generation. */
    pub(crate) fn served_account(&self) -> Option<ServedAccount> {
        let state = self.lock();
        let (user_id, signing_public_key) = state.account.clone()?;
        let store_key = state.store_key.clone()?;
        Some(ServedAccount { user_id, signing_public_key, store_key, generation: state.generation })
    }

    /* The settings pin for the family, from the settings the account last opened; refused before any. */
    pub(crate) fn settings_pin(&self, user_id: &str, group_id: &str) -> CoreResult<Option<GroupPin>> {
        let state = self.lock();
        let settings = state
            .settings
            .as_ref()
            .filter(|held| held.user_id.eq_ignore_ascii_case(user_id))
            .ok_or_else(|| refused(OPEN_SETTINGS))?;
        Ok(settings.pins.get(group_id).cloned())
    }

    /* The highest chain committed for the family in this session (accept_served's floor and mark). */
    pub(crate) fn floor(&self, group_id: &str) -> Option<Arc<AcceptedRosters>> {
        self.lock().floors.get(group_id).cloned()
    }

    /*
     * An acceptance's commit, under the lock: still the account it began with
     * (`NOT_THIS_ACCOUNT` after a lock, a sign-out or another account), never
     * below or beside the family's floor (`OLDER_CHAIN`, `SPLIT_CHAIN`: a run
     * another overtook, even one a refusal uncommitted since), then commit.
     */
    pub(crate) fn commit_served(
        &self,
        chain: Arc<AcceptedRosters>,
        generation: u64,
    ) -> CoreResult<Zeroizing<[u8; 32]>> {
        let mut state = self.lock();
        let store_key = state.store_key.clone().filter(|_| state.generation == generation);
        let Some(store_key) = store_key else {
            return Err(refused(NOT_THIS_ACCOUNT));
        };
        state.commit(chain)?;
        // The record is sealed under the key held now (a master-key rotation meanwhile included).
        Ok(store_key)
    }

    /*
     * A refusal (`fork` none: a fork stays a fork) or a fork (`Some(true)`) of an
     * acceptance, under the account and session it began in; otherwise
     * `NOT_THIS_ACCOUNT`, and nothing of the family is touched.
     */
    pub(crate) fn uncommit_served(
        &self,
        group_id: &str,
        generation: u64,
        fork: Option<bool>,
    ) -> CoreResult<()> {
        let mut state = self.lock();
        if state.generation != generation || state.account.is_none() {
            return Err(refused(NOT_THIS_ACCOUNT));
        }
        let fork = fork.unwrap_or_else(|| state.forked.contains(group_id));
        state.uncommit(group_id, fork);
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        // A panic inside a call leaves nothing half-written that a later call would trust.
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drive::{node_open, node_wrap, previous_root_key_wrap};
    use crate::group_trust::{accept_rosters, RosterChain};
    use crate::groups::tests::{
        area_key_at, group_seed_at, ml_dsa_keys, reader, Person, AREA, AREA_SEED, GROUP, OTHER_AREA_SEED,
        OTHER_GROUP,
    };
    use crate::groups::{
        area_root_commitment, group_public_key, roster_digest, roster_sign, GroupKind, GroupRole,
        MemberStatus, Roster, RosterArea,
    };

    /* What these tests give an area's top level at an area version, and a folder's key. */
    fn root_key(version: u64) -> Vec<u8> {
        vec![150 + version as u8; 32]
    }
    fn key(n: u8) -> Vec<u8> {
        vec![200 + n; 32]
    }
    fn node(n: u32) -> String {
        format!("0e0e0e0e-0000-4000-8000-{n:012x}")
    }
    const ROOT: u32 = 1;

    enum Row {
        Key(u64),
        F1(u64),
        Retired(u64),
    }

    /* A family whose rosters carry `rows` (one list per roster), signed by its only holder and accepted. */
    fn chain(rows: Vec<Vec<Row>>) -> Arc<AcceptedRosters> {
        chain_of(GROUP, rows)
    }

    /* The same for the family `group_id`, whose rosters may list AREA too (another family's chain). */
    fn chain_of(group_id: &str, rows: Vec<Vec<Row>>) -> Arc<AcceptedRosters> {
        let owner = Person::new(1);
        let entry = owner.entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active);
        let mut signed: Vec<crate::groups::SignedGroupStatement> = vec![];
        for (index, rows) in rows.into_iter().enumerate() {
            let format = if rows.iter().any(|row| matches!(row, Row::F1(_))) { 1 } else { 2 };
            let areas = rows
                .into_iter()
                .map(|row| match row {
                    Row::Key(v) => RosterArea {
                        workspace_id: AREA.into(),
                        workspace_key_version: v,
                        commitment: area_key_commitment(&area_key_at(AREA, v)).unwrap(),
                        root_commitment: Some(area_root_commitment(&root_key(v)).unwrap()),
                        retired: false,
                    },
                    Row::F1(v) => RosterArea {
                        workspace_id: AREA.into(),
                        workspace_key_version: v,
                        commitment: area_key_commitment(&area_key_at(AREA, v)).unwrap(),
                        root_commitment: None,
                        retired: false,
                    },
                    Row::Retired(v) => RosterArea {
                        workspace_id: AREA.into(),
                        workspace_key_version: v,
                        commitment: String::new(),
                        root_commitment: None,
                        retired: true,
                    },
                })
                .collect();
            let roster = Roster {
                group_id: group_id.into(),
                kind: GroupKind::Family,
                roster_version: index as u64 + 1,
                previous_roster_digest: signed
                    .last()
                    .map(|s| roster_digest(s.statement.clone()))
                    .unwrap_or_default(),
                group_key_version: 1,
                signer_user_id: owner.user_id.clone(),
                members: vec![entry.clone()],
                areas,
                format,
            };
            signed.push(roster_sign(roster, group_seed_at(1), owner.keys.clone()).unwrap());
        }
        match accept_rosters(
            group_id.into(),
            group_public_key(group_seed_at(1)).unwrap(),
            true,
            vec![],
            signed,
            vec![],
            ml_dsa_keys(&[&owner]),
            reader(),
            None,
        )
        .unwrap()
        {
            RosterChain::Accepted { chain } => chain,
            RosterChain::Fork { .. } => panic!("forked"),
        }
    }

    fn wrap(
        node_id: &str,
        parent_id: &str,
        parent_key_epoch: u64,
        key_epoch: u64,
        under: &[u8],
        key: &[u8],
    ) -> Vec<u8> {
        node_wrap(ctx(AREA, node_id, parent_id, parent_key_epoch, key_epoch), under.to_vec(), key.to_vec())
            .unwrap()
    }

    fn served(
        node_id: &str,
        parent_id: &str,
        parent_key_epoch: u64,
        key_epoch: u64,
        under: &[u8],
        key: &[u8],
    ) -> ServedNodeKey {
        ServedNodeKey {
            node_id: node_id.into(),
            parent_id: parent_id.into(),
            parent_key_epoch,
            key_epoch,
            key_envelope: wrap(node_id, parent_id, parent_key_epoch, key_epoch, under, key),
            prev_key_envelope: None,
            prev_key_epoch: None,
            prev_parent_key_epoch: None,
        }
    }

    /* The top level at area version `v`, with option A's previous key (root `v - 1`) under the new area key. */
    fn root_row(v: u64) -> ServedNodeKey {
        let mut row = served(&node(ROOT), AREA, v, v, &area_key_at(AREA, v), &root_key(v));
        if v > 1 {
            row.prev_key_envelope = Some(
                previous_root_key_wrap(
                    ctx(AREA, &node(ROOT), AREA, v, v - 1),
                    area_key_at(AREA, v),
                    root_key(v - 1),
                )
                .unwrap(),
            );
            row.prev_key_epoch = Some(v - 1);
            row.prev_parent_key_epoch = Some(v);
        }
        row
    }

    fn open(ledger: &AreaLedger, v: u64, served_version: u64) -> AreaOpened {
        ledger
            .open_area(GROUP.into(), AREA.into(), AREA_SEED.into(), v, area_key_at(AREA, v), served_version)
            .unwrap()
    }

    fn message<T: std::fmt::Debug>(result: CoreResult<T>) -> String {
        result.unwrap_err().to_string()
    }

    /* A ledger with the area at `v` (of a chain listing versions 1..=v), its top level opened. */
    fn writable_at(v: u64) -> Arc<AreaLedger> {
        let ledger = AreaLedger::new();
        ledger.commit(chain((1..=v).map(|at| vec![Row::Key(at)]).collect())).unwrap();
        open(&ledger, v, v);
        ledger.open_listed_node(AREA.into(), root_row(v)).unwrap();
        ledger
    }

    #[test]
    fn a_family_folder_takes_writes_only_once_its_committed_top_level_is_seen() {
        let ledger = AreaLedger::new();
        ledger.commit(chain(vec![vec![Row::Key(1)]])).unwrap();
        let opened = open(&ledger, 1, 1);
        assert_eq!((opened.writable, opened.reason), (false, Some(AreaBlock::RootUnknown)));
        assert_eq!(message(ledger.require_writable(AREA.into())), KEYS_CHANGED);
        ledger.open_listed_node(AREA.into(), root_row(1)).unwrap();
        assert_eq!(ledger.write_version(AREA.into()), Ok(Some(1)));
        let folder = ledger.new_node_key(AREA.into(), node(2), node(ROOT), 1, 1).unwrap();
        // The folder's envelope opens under the top level's key, and its key is held as writable.
        assert_eq!(
            node_open(ctx(AREA, &node(2), &node(ROOT), 1, 1), root_key(1), folder.key_envelope).unwrap(),
            folder.key
        );
        assert_eq!(ledger.writable_node_key(AREA.into(), node(2)).unwrap().unwrap().key, folder.key);
        // Nothing in Drive wraps a key straight under the area key, nor walks the top level.
        assert_eq!(message(ledger.new_node_key(AREA.into(), node(3), AREA.into(), 1, 1)), AREA_ROOT);
        let rotating = RotatingNodeKey {
            node_id: node(ROOT),
            parent_id: AREA.into(),
            parent_key_epoch: 1,
            key_epoch: 1,
            wrapped_parent_key_epoch: 1,
            key_envelope: root_row(1).key_envelope,
        };
        assert_eq!(message(ledger.rotate_key(AREA.into(), rotating, 2)), AREA_ROOT);
    }

    #[test]
    fn a_top_level_under_the_right_area_key_but_not_the_committed_key_is_dropped() {
        let ledger = AreaLedger::new();
        ledger.commit(chain(vec![vec![Row::Key(1)]])).unwrap();
        open(&ledger, 1, 1);
        let planted = served(&node(ROOT), AREA, 1, 1, &area_key_at(AREA, 1), &key(5));
        assert_eq!(message(ledger.open_listed_node(AREA.into(), planted)), NOT_COMMITTED_ROOT);
        assert!(ledger.key_at_epoch(AREA.into(), node(ROOT), 1).is_none());
        assert_eq!(message(ledger.require_writable(AREA.into())), KEYS_CHANGED);
        // A format 1 version committed to no top level: the envelope opening is the rule there.
        let old = AreaLedger::new();
        old.commit(chain(vec![vec![Row::F1(1)]])).unwrap();
        open(&old, 1, 1);
        old.open_listed_node(AREA.into(), served(&node(ROOT), AREA, 1, 1, &area_key_at(AREA, 1), &key(5)))
            .unwrap();
        assert_eq!(old.write_version(AREA.into()), Ok(Some(1)));
    }

    #[test]
    fn a_folder_reached_through_the_previous_top_level_key_reads_and_never_writes() {
        let ledger = writable_at(2);
        // Option A: the old top-level key opens a folder the walk has not reached.
        assert_eq!(ledger.key_at_epoch(AREA.into(), node(ROOT), 1).unwrap(), root_key(1));
        let folder = served(&node(2), &node(ROOT), 1, 1, &root_key(1), &key(1));
        assert_eq!(ledger.open_listed_node(AREA.into(), folder).unwrap(), key(1));
        assert_eq!(message(ledger.writable_node_key(AREA.into(), node(2))), KEY_CHANGE_PENDING);
        assert_eq!(message(ledger.new_node_key(AREA.into(), node(3), node(2), 1, 1)), KEY_CHANGE_PENDING);
        assert_eq!(message(ledger.rewrap_node(AREA.into(), node(2), node(ROOT), 2, 1)), KEY_CHANGE_PENDING);
        // Under the top level's current key, writes go on.
        assert!(ledger.new_node_key(AREA.into(), node(4), node(ROOT), 2, 2).is_ok());
    }

    #[test]
    fn a_walk_re_keys_under_the_committed_top_level_and_its_key_writes_once_the_server_takes_it() {
        let ledger = writable_at(2);
        let folder = served(&node(2), &node(ROOT), 1, 1, &root_key(1), &key(1));
        ledger.open_listed_node(AREA.into(), folder.clone()).unwrap();
        let rotating = RotatingNodeKey {
            node_id: node(2),
            parent_id: node(ROOT),
            parent_key_epoch: 2,
            key_epoch: 1,
            wrapped_parent_key_epoch: 1,
            key_envelope: folder.key_envelope,
        };
        let rotated = ledger.rotate_key(AREA.into(), rotating.clone(), 2).unwrap();
        let fresh = rotated.fresh_key.clone().unwrap();
        assert_eq!(rotated.old_key.unwrap(), key(1));
        assert_eq!(
            node_open(ctx(AREA, &node(2), &node(ROOT), 2, 2), root_key(2), rotated.key_envelope).unwrap(),
            fresh
        );
        // Children of the walk wrap under the pending key; the node itself is not writable yet.
        assert!(ledger.new_node_key(AREA.into(), node(3), node(2), 2, 2).is_ok());
        assert_eq!(message(ledger.writable_node_key(AREA.into(), node(2))), KEY_CHANGE_PENDING);
        assert_eq!(ledger.rotate_commit(AREA.into(), vec![node(2)]), 1);
        assert_eq!(ledger.writable_node_key(AREA.into(), node(2)).unwrap().unwrap().key, fresh);
        assert_eq!(ledger.key_at_epoch(AREA.into(), node(2), 1).unwrap(), key(1));
        // A refused batch leaves the old key as it was.
        let again = writable_at(2);
        again
            .open_listed_node(AREA.into(), served(&node(2), &node(ROOT), 1, 1, &root_key(1), &key(1)))
            .unwrap();
        again.rotate_key(AREA.into(), rotating, 2).unwrap();
        assert_eq!(again.rotate_drop(AREA.into(), vec![node(2)]), 1);
        assert!(again.key_at_epoch(AREA.into(), node(2), 2).is_none());
        assert_eq!(message(again.writable_node_key(AREA.into(), node(2))), KEY_CHANGE_PENDING);
    }

    #[test]
    fn a_walk_s_key_made_before_the_next_roster_landed_takes_no_write() {
        let ledger = writable_at(1);
        let folder = served(&node(2), &node(ROOT), 1, 1, &root_key(1), &key(1));
        ledger.open_listed_node(AREA.into(), folder.clone()).unwrap();
        let rotating = RotatingNodeKey {
            node_id: node(2),
            parent_id: node(ROOT),
            parent_key_epoch: 1,
            key_epoch: 1,
            wrapped_parent_key_epoch: 1,
            key_envelope: folder.key_envelope,
        };
        ledger.rotate_key(AREA.into(), rotating, 2).unwrap();
        ledger.commit(chain(vec![vec![Row::Key(1)], vec![Row::Key(2)]])).unwrap();
        assert_eq!(open(&ledger, 2, 2).reason, Some(AreaBlock::RootBehind));
        ledger.open_listed_node(AREA.into(), root_row(2)).unwrap();
        assert_eq!(message(ledger.new_node_key(AREA.into(), node(3), node(2), 2, 2)), KEY_CHANGE_PENDING);
        ledger.rotate_commit(AREA.into(), vec![node(2)]);
        assert_eq!(message(ledger.writable_node_key(AREA.into(), node(2))), KEY_CHANGE_PENDING);
    }

    #[test]
    fn a_node_planted_at_the_target_under_a_folder_s_old_key_is_not_carried() {
        let ledger = writable_at(2);
        let folder = served(&node(2), &node(ROOT), 1, 1, &root_key(1), &key(1));
        ledger.open_listed_node(AREA.into(), folder.clone()).unwrap();
        let planted = RotatingNodeKey {
            node_id: node(3),
            parent_id: node(2),
            parent_key_epoch: 3,
            key_epoch: 3,
            wrapped_parent_key_epoch: 1,
            key_envelope: wrap(&node(3), &node(2), 1, 3, &key(1), &key(7)),
        };
        assert_eq!(message(ledger.rotate_key(AREA.into(), planted, 3)), NOT_CARRIED);
        assert!(ledger.key_at_epoch(AREA.into(), node(3), 3).is_none());
        // Once the folder is re-keyed in the walk, a node at the target under it is carried.
        let rotated = ledger
            .rotate_key(
                AREA.into(),
                RotatingNodeKey {
                    node_id: node(2),
                    parent_id: node(ROOT),
                    parent_key_epoch: 2,
                    key_epoch: 1,
                    wrapped_parent_key_epoch: 1,
                    key_envelope: folder.key_envelope,
                },
                3,
            )
            .unwrap();
        let fresh = rotated.fresh_key.unwrap().to_vec();
        let honest = RotatingNodeKey {
            node_id: node(3),
            parent_id: node(2),
            parent_key_epoch: 3,
            key_epoch: 3,
            wrapped_parent_key_epoch: 3,
            key_envelope: wrap(&node(3), &node(2), 3, 3, &fresh, &key(7)),
        };
        let carried = ledger.rotate_key(AREA.into(), honest, 3).unwrap();
        assert!(carried.rewrap);
        assert_eq!(
            node_open(ctx(AREA, &node(3), &node(2), 3, 3), fresh, carried.key_envelope).unwrap(),
            key(7)
        );
    }

    #[test]
    fn a_grant_below_the_latest_a_server_out_of_step_or_a_key_the_chain_did_not_list_blocks_the_folder() {
        let ledger = AreaLedger::new();
        assert_eq!(
            message(ledger.open_area(
                GROUP.into(),
                AREA.into(),
                AREA_SEED.into(),
                1,
                area_key_at(AREA, 1),
                1
            )),
            NO_CHAIN
        );
        ledger.commit(chain(vec![vec![Row::Key(1)], vec![Row::Key(2)]])).unwrap();
        assert_eq!(open(&ledger, 1, 2).reason, Some(AreaBlock::NoGrantAtLatest));
        assert_eq!(open(&ledger, 2, 1).reason, Some(AreaBlock::ServerBehind));
        assert_eq!(open(&ledger, 2, 3).reason, Some(AreaBlock::ServerAhead));
        ledger.open_listed_node(AREA.into(), root_row(2)).unwrap();
        assert_eq!(message(ledger.require_writable(AREA.into())), KEYS_CHANGED);
        assert!(open(&ledger, 2, 2).writable);
        let wrong = ledger.open_area(GROUP.into(), AREA.into(), AREA_SEED.into(), 2, key(3), 2);
        assert_eq!(message(wrong), NOT_CHECKED_KEYS);
        let unlisted =
            ledger.open_area(GROUP.into(), AREA.into(), AREA_SEED.into(), 3, area_key_at(AREA, 3), 3);
        assert_eq!(message(unlisted), NOT_CHECKED_KEYS);
        let other =
            ledger.open_area(GROUP.into(), AREA.into(), OTHER_AREA_SEED.into(), 2, area_key_at(AREA, 2), 2);
        assert_eq!(message(other), NOT_THE_FAMILYS);
        assert!(ledger.require_writable(AREA.into()).is_ok());
    }

    #[test]
    fn a_deleted_folder_is_read_and_never_written_and_forgetting_the_family_wipes_its_keys() {
        let ledger = writable_at(1);
        let folder = ledger.new_node_key(AREA.into(), node(2), node(ROOT), 1, 1).unwrap();
        ledger.commit(chain(vec![vec![Row::Key(1)], vec![Row::Retired(2)]])).unwrap();
        assert_eq!(message(ledger.write_version(AREA.into())), NOT_CHECKED_KEYS);
        assert_eq!(message(ledger.new_node_key(AREA.into(), node(3), node(2), 1, 1)), NOT_CHECKED_KEYS);
        assert_eq!(ledger.key_at_epoch(AREA.into(), node(2), 1).unwrap(), folder.key);
        // A refusal for the group stops writes until a chain is committed again.
        let refused = writable_at(1);
        let held = refused.held_chain(GROUP).unwrap();
        refused.uncommit(GROUP.into(), false);
        assert_eq!(message(refused.require_writable(AREA.into())), NOT_CHECKED_KEYS);
        // The same chain again (another one at its version would be below or beside the floor).
        refused.commit(held).unwrap();
        assert!(refused.require_writable(AREA.into()).is_ok());
        refused.forget_group(GROUP.into());
        assert!(!refused.is_area(AREA.into()));
        assert!(refused.key_at_epoch(AREA.into(), node(ROOT), 1).is_none());
        ledger.clear();
        assert!(ledger.node_key(AREA.into(), node(2)).is_none());
    }

    #[test]
    fn the_top_level_s_previous_key_this_device_opened_outranks_a_served_previous_envelope() {
        let ledger = writable_at(1);
        ledger.commit(chain(vec![vec![Row::Key(1)], vec![Row::Key(2)]])).unwrap();
        open(&ledger, 2, 2);
        let mut row = root_row(2);
        row.prev_key_envelope = Some(
            previous_root_key_wrap(ctx(AREA, &node(ROOT), AREA, 2, 1), area_key_at(AREA, 2), key(4)).unwrap(),
        );
        ledger.open_listed_node(AREA.into(), row).unwrap();
        assert_eq!(ledger.key_at_epoch(AREA.into(), node(ROOT), 1).unwrap(), root_key(1));
    }

    #[test]
    fn a_key_reached_through_a_folder_s_previous_key_is_rooted_nowhere_even_at_the_area_s_version_number() {
        let ledger = writable_at(2);
        // A Drive rotation below the top level moved the folder from epoch 2 to 3: its previous key is
        // at epoch 2, the same number as the area's write version.
        let mut folder = served(&node(2), &node(ROOT), 2, 3, &root_key(2), &key(2));
        folder.prev_key_envelope = Some(wrap(&node(2), &node(ROOT), 2, 2, &root_key(2), &key(1)));
        folder.prev_key_epoch = Some(2);
        folder.prev_parent_key_epoch = Some(2);
        ledger.open_listed_node(AREA.into(), folder).unwrap();
        assert!(ledger.writable_node_key(AREA.into(), node(2)).unwrap().is_some());
        ledger.open_listed_node(AREA.into(), served(&node(3), &node(2), 2, 2, &key(1), &key(3))).unwrap();
        assert_eq!(message(ledger.writable_node_key(AREA.into(), node(3))), KEY_CHANGE_PENDING);
        assert_eq!(message(ledger.new_node_key(AREA.into(), node(4), node(3), 2, 2)), KEY_CHANGE_PENDING);
    }

    #[test]
    fn a_top_level_is_never_a_walk_s_even_one_this_device_cannot_open() {
        let ledger = writable_at(2);
        // Served under the area key at version 1, which this device does not hold.
        let rotating = RotatingNodeKey {
            node_id: node(ROOT),
            parent_id: AREA.into(),
            parent_key_epoch: 2,
            key_epoch: 1,
            wrapped_parent_key_epoch: 1,
            key_envelope: wrap(&node(ROOT), AREA, 1, 1, &area_key_at(AREA, 1), &root_key(1)),
        };
        assert_eq!(message(ledger.rotate_key(AREA.into(), rotating, 3)), AREA_ROOT);
    }

    #[test]
    fn no_write_without_the_area_key_at_the_write_version_even_with_its_top_level_seen() {
        // Not reachable through the API today (keys leave only with the area's whole state); held
        // as the worker holds it, so a later path that drops keys alone still writes nothing.
        let ledger = writable_at(1);
        ledger.lock().workspace_keys.get_mut(AREA).unwrap().keys.clear();
        assert_eq!(message(ledger.require_writable(AREA.into())), KEYS_CHANGED);
    }

    /* Version 2 writable with both area keys held (version 1 first, as a reader catching up opens them). */
    fn writable_with_both() -> Arc<AreaLedger> {
        let ledger = AreaLedger::new();
        ledger.commit(chain(vec![vec![Row::Key(1)], vec![Row::Key(2)]])).unwrap();
        assert_eq!(open(&ledger, 1, 2).reason, Some(AreaBlock::NoGrantAtLatest));
        open(&ledger, 2, 2);
        ledger.open_listed_node(AREA.into(), root_row(2)).unwrap();
        assert_eq!(ledger.write_version(AREA.into()), Ok(Some(2)));
        ledger
    }

    #[test]
    fn another_family_s_chain_listing_an_area_never_moves_its_write_version() {
        // The reviewers' attack: a removed member who manages another family the person is in
        // lists this family's folder at its old version; the server serves the old top level.
        let ledger = writable_with_both();
        ledger.commit(chain_of(OTHER_GROUP, vec![vec![Row::Key(1)]])).unwrap();
        // Opened under this family, its id derived under it: the folder stays this family's.
        assert_eq!(ledger.write_version(AREA.into()), Ok(Some(2)));
        let old_root = served(&node(ROOT), AREA, 1, 1, &area_key_at(AREA, 1), &root_key(1));
        ledger.open_listed_node(AREA.into(), old_root).unwrap();
        assert_eq!(ledger.write_version(AREA.into()), Ok(Some(2)));
        assert_eq!(message(ledger.new_node_key(AREA.into(), node(2), node(ROOT), 1, 1)), KEY_CHANGE_PENDING);
        ledger.uncommit(OTHER_GROUP.into(), false);
        assert_eq!(ledger.write_version(AREA.into()), Ok(Some(2)));
        ledger.open_listed_node(AREA.into(), root_row(2)).unwrap();
        assert!(ledger.new_node_key(AREA.into(), node(2), node(ROOT), 2, 2).is_ok());
    }

    #[test]
    fn another_family_uncommitted_or_forgotten_leaves_this_family_s_folder_alone() {
        let ledger = writable_at(1);
        let folder = ledger.new_node_key(AREA.into(), node(2), node(ROOT), 1, 1).unwrap();
        // Its chain refused, or forgotten, without ever being committed here: nothing changes.
        ledger.uncommit(OTHER_GROUP.into(), false);
        ledger.forget_group(OTHER_GROUP.into());
        assert!(ledger.require_writable(AREA.into()).is_ok());
        // Committed listing the area, then forgotten: the folder's keys stay, and it is written again.
        ledger.commit(chain_of(OTHER_GROUP, vec![vec![Row::Key(1)]])).unwrap();
        ledger.forget_group(OTHER_GROUP.into());
        assert_eq!(ledger.key_at_epoch(AREA.into(), node(2), 1).unwrap(), folder.key);
        assert_eq!(ledger.key_at_epoch(AREA.into(), node(ROOT), 1).unwrap(), root_key(1));
        assert!(ledger.new_node_key(AREA.into(), node(3), node(2), 1, 1).is_ok());
    }

    #[test]
    fn an_older_chain_for_the_family_is_refused_and_changes_nothing() {
        let ledger = AreaLedger::new();
        let held = chain(vec![vec![Row::Key(1)], vec![Row::Key(2)]]);
        ledger.commit(Arc::clone(&held)).unwrap();
        open(&ledger, 2, 2);
        ledger.open_listed_node(AREA.into(), root_row(2)).unwrap();
        assert_eq!(message(ledger.commit(chain(vec![vec![Row::Key(1)]]))), OLDER_CHAIN);
        assert_eq!(ledger.write_version(AREA.into()), Ok(Some(2)));
        // The same chain again is taken (a re-sync).
        assert!(ledger.commit(held).is_ok());
    }

    #[test]
    fn an_old_top_level_served_again_or_another_top_level_node_never_lowers_what_was_seen() {
        let ledger = writable_with_both();
        let old_root = served(&node(ROOT), AREA, 1, 1, &area_key_at(AREA, 1), &root_key(1));
        ledger.open_listed_node(AREA.into(), old_root).unwrap();
        assert_eq!(ledger.write_version(AREA.into()), Ok(Some(2)));
        let planted = served(&node(9), AREA, 2, 2, &area_key_at(AREA, 2), &key(5));
        assert_eq!(message(ledger.open_listed_node(AREA.into(), planted)), NOT_COMMITTED_ROOT);
        assert!(ledger.key_at_epoch(AREA.into(), node(9), 2).is_none());
        assert_eq!(ledger.write_version(AREA.into()), Ok(Some(2)));
        // The real top level served under the right area version with another key still is a rollback.
        let rolled = served(&node(ROOT), AREA, 2, 2, &area_key_at(AREA, 2), &key(6));
        assert_eq!(message(ledger.open_listed_node(AREA.into(), rolled)), NOT_COMMITTED_ROOT);
        assert_eq!(message(ledger.write_version(AREA.into())), KEYS_CHANGED);
    }

    #[test]
    fn a_walk_needs_a_writable_folder_and_an_abandoned_one_drops_every_pending_key() {
        let unseen = AreaLedger::new();
        unseen.commit(chain(vec![vec![Row::Key(1)]])).unwrap();
        open(&unseen, 1, 1);
        let any = RotatingNodeKey {
            node_id: node(2),
            parent_id: node(ROOT),
            parent_key_epoch: 1,
            key_epoch: 1,
            wrapped_parent_key_epoch: 1,
            key_envelope: wrap(&node(2), &node(ROOT), 1, 1, &root_key(1), &key(1)),
        };
        assert_eq!(message(unseen.rotate_key(AREA.into(), any, 2)), KEYS_CHANGED);
        let ledger = writable_at(2);
        for (n, k) in [(2, 1), (3, 2)] {
            let folder = served(&node(n), &node(ROOT), 1, 1, &root_key(1), &key(k));
            ledger.open_listed_node(AREA.into(), folder.clone()).unwrap();
            let rotating = RotatingNodeKey {
                node_id: node(n),
                parent_id: node(ROOT),
                parent_key_epoch: 2,
                key_epoch: 1,
                wrapped_parent_key_epoch: 1,
                key_envelope: folder.key_envelope,
            };
            ledger.rotate_key(AREA.into(), rotating, 2).unwrap();
        }
        assert_eq!(ledger.rotate_drop_all(AREA.into()), 2);
        assert_eq!(ledger.rotate_drop_all(AREA.into()), 0);
        assert!(ledger.key_at_epoch(AREA.into(), node(2), 2).is_none());
        assert_eq!(message(ledger.new_node_key(AREA.into(), node(4), node(2), 2, 2)), KEY_CHANGE_PENDING);
    }

    #[test]
    fn a_walk_s_fresh_key_never_goes_under_a_parent_reached_through_a_previous_key() {
        let ledger = writable_at(2);
        ledger
            .open_listed_node(AREA.into(), served(&node(2), &node(ROOT), 1, 1, &root_key(1), &key(1)))
            .unwrap();
        let child = served(&node(3), &node(2), 1, 1, &key(1), &key(7));
        ledger.open_listed_node(AREA.into(), child.clone()).unwrap();
        let rotating = RotatingNodeKey {
            node_id: node(3),
            parent_id: node(2),
            parent_key_epoch: 1,
            key_epoch: 1,
            wrapped_parent_key_epoch: 1,
            key_envelope: child.key_envelope,
        };
        assert_eq!(message(ledger.rotate_key(AREA.into(), rotating, 2)), KEY_CHANGE_PENDING);
        assert!(ledger.key_at_epoch(AREA.into(), node(3), 2).is_none());
    }

    #[test]
    fn forgetting_the_family_mid_walk_drops_the_walk_s_pending_keys() {
        let ledger = writable_at(2);
        let folder = served(&node(2), &node(ROOT), 1, 1, &root_key(1), &key(1));
        ledger.open_listed_node(AREA.into(), folder.clone()).unwrap();
        let rotating = RotatingNodeKey {
            node_id: node(2),
            parent_id: node(ROOT),
            parent_key_epoch: 2,
            key_epoch: 1,
            wrapped_parent_key_epoch: 1,
            key_envelope: folder.key_envelope.clone(),
        };
        ledger.rotate_key(AREA.into(), rotating, 2).unwrap();
        ledger.forget_group(GROUP.into());
        // Back in the family: the walk's fresh key is gone, nothing goes under it, nothing commits it.
        ledger.commit(chain(vec![vec![Row::Key(1)], vec![Row::Key(2)]])).unwrap();
        open(&ledger, 2, 2);
        ledger.open_listed_node(AREA.into(), root_row(2)).unwrap();
        ledger.open_listed_node(AREA.into(), folder).unwrap();
        assert_eq!(message(ledger.new_node_key(AREA.into(), node(3), node(2), 2, 2)), KEY_CHANGE_PENDING);
        assert_eq!(ledger.rotate_commit(AREA.into(), vec![node(2)]), 0);
    }

    #[test]
    fn another_chain_at_the_version_held_is_never_committed() {
        let ledger = writable_at(2);
        // Roster 2 with no rows: the same version, another digest.
        let split = chain(vec![vec![Row::Key(1)], vec![]]);
        assert_eq!(message(ledger.commit(split)), SPLIT_CHAIN);
        assert_eq!(ledger.write_version(AREA.into()), Ok(Some(2)));
    }

    #[test]
    fn a_family_naming_the_account_s_own_workspace_or_another_family_s_folder_locks_nothing() {
        let personal = "f0f0f0f0-0000-4000-8000-00000000000f";
        let ledger = writable_at(1);
        // The hostile family lists this family's folder and the account's own workspace.
        let hostile = chain_of(OTHER_GROUP, vec![vec![Row::Key(1)]]);
        ledger.commit(hostile).unwrap();
        ledger.open_personal_workspace(personal.into(), 1, key(9)).unwrap();
        // A family folder this session opened is never taken as the account's own.
        assert_eq!(message(ledger.open_personal_workspace(AREA.into(), 1, key(9))), FAMILY_FOLDER);
        assert!(!ledger.is_area(personal.into()));
        assert_eq!(ledger.write_version(personal.into()), Ok(None));
        assert!(ledger.new_node_key(personal.into(), node(5), personal.into(), 1, 1).is_ok());
        // The family's folder stays the family's: written, and the listing only a warning.
        assert_eq!(ledger.write_version(AREA.into()), Ok(Some(1)));
        assert!(ledger.new_node_key(AREA.into(), node(2), node(ROOT), 1, 1).is_ok());
        assert_eq!(
            ledger.foreign_listings(),
            vec![ForeignListing {
                group_id: OTHER_GROUP.into(),
                workspace_id: AREA.into(),
                opened_by: Some(GROUP.into())
            }]
        );
        // And the account's own workspace is never opened as a family folder.
        let refused =
            ledger.open_area(GROUP.into(), personal.into(), AREA_SEED.into(), 1, area_key_at(AREA, 1), 1);
        assert_eq!(message(refused), NOT_THE_FAMILYS);
    }

    #[test]
    fn an_old_version_top_node_never_takes_the_root_from_the_real_one() {
        let ledger = AreaLedger::new();
        ledger.commit(chain(vec![vec![Row::Key(1)], vec![Row::Key(2)]])).unwrap();
        open(&ledger, 1, 2);
        open(&ledger, 2, 2);
        // A removed member holding area key 1 and the old top level's key plants another node with it.
        let planted = served(&node(9), AREA, 1, 1, &area_key_at(AREA, 1), &root_key(1));
        ledger.open_listed_node(AREA.into(), planted).unwrap();
        ledger.open_listed_node(AREA.into(), root_row(2)).unwrap();
        assert_eq!(ledger.write_version(AREA.into()), Ok(Some(2)));
        assert!(ledger.new_node_key(AREA.into(), node(2), node(ROOT), 2, 2).is_ok());
    }

    /* ---------------------------------------------------------------- */
    /* Core 2: a walk's records, and the verdicts that read them         */
    /* ---------------------------------------------------------------- */

    use crate::drive::{
        metadata_seal, origin_key_wrap, origin_opening_key, version_rekey, version_seal, MetadataContext,
        NodeMetadata, OriginKeyContext, OriginRecord, VersionContext,
    };
    use crate::group_trust::{GroupIntegrity, GroupRekeyedVerdict, WriterPin};
    use crate::rotation_records::{RotatedRecord, RotatingVersion, ServedRekey};
    use crate::signatures::{
        metadata_sign, signing_public_key, version_rekey_sign, version_sign, MetadataStatement, NodeKind,
        RecordOrigin, ServedOrigin, TrustedKeys, VersionStatement,
    };

    /* The walk tests' family: 1 manages and walks, 2 writes, 3 was removed at roster 2, 4 reads. */
    struct Family {
        people: Vec<Person>,
        chain: Arc<AcceptedRosters>,
    }

    fn family() -> Family {
        let people: Vec<Person> = (1..=4).map(Person::new).collect();
        let entries = |removed: bool| {
            let mut out = vec![
                people[0].entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active),
                people[1].entry(&[], 1, MemberStatus::Active),
                if removed {
                    people[2].entry(&[], 2, MemberStatus::Left)
                } else {
                    people[2].entry(&[], 1, MemberStatus::Active)
                },
                people[3].entry(&[], 1, MemberStatus::Active),
            ];
            out.sort_by(|a, b| a.user_id.cmp(&b.user_id));
            out
        };
        let row = |v: u64| RosterArea {
            workspace_id: AREA.into(),
            workspace_key_version: v,
            commitment: area_key_commitment(&area_key_at(AREA, v)).unwrap(),
            root_commitment: Some(area_root_commitment(&root_key(v)).unwrap()),
            retired: false,
        };
        let mut signed: Vec<crate::groups::SignedGroupStatement> = vec![];
        for (version, removed) in [(1u64, false), (2, true)] {
            let roster = Roster {
                group_id: GROUP.into(),
                kind: GroupKind::Family,
                roster_version: version,
                previous_roster_digest: signed
                    .last()
                    .map(|s| roster_digest(s.statement.clone()))
                    .unwrap_or_default(),
                group_key_version: 1,
                signer_user_id: people[0].user_id.clone(),
                members: entries(removed),
                areas: vec![row(version)],
                format: 2,
            };
            signed.push(roster_sign(roster, group_seed_at(1), people[0].keys.clone()).unwrap());
        }
        let everyone: Vec<&Person> = people.iter().collect();
        let chain = match accept_rosters(
            GROUP.into(),
            group_public_key(group_seed_at(1)).unwrap(),
            true,
            vec![],
            signed,
            vec![],
            ml_dsa_keys(&everyone),
            reader(),
            None,
        )
        .unwrap()
        {
            RosterChain::Accepted { chain } => chain,
            RosterChain::Fork { .. } => panic!("forked"),
        };
        Family { people, chain }
    }

    impl Family {
        fn seed(&self, n: usize) -> Vec<u8> {
            self.people[n - 1].keys.signing_seed.to_vec()
        }
        fn id(&self, n: usize) -> String {
            self.people[n - 1].user_id.clone()
        }
        fn keys(&self, n: usize) -> TrustedKeys {
            TrustedKeys { current: signing_public_key(self.seed(n)).unwrap(), retired: vec![] }
        }
        /* Person `n`'s ledger: the account opened, the area writable at version 2, its top level opened. */
        fn ledger(&self, n: usize) -> Arc<AreaLedger> {
            let ledger = AreaLedger::new();
            ledger.open_account(self.id(n), self.keys(n).current, vec![9u8; 32]).unwrap();
            ledger.commit(Arc::clone(&self.chain)).unwrap();
            open(&ledger, 2, 2);
            ledger.open_listed_node(AREA.into(), root_row(2)).unwrap();
            ledger
        }
        fn reader(&self, n: usize) -> RecordReader {
            RecordReader { user_id: self.id(n), keys: self.keys(n) }
        }
        /* Every member as a writer: their identity and links loaded, their personal keys known too. */
        fn writers(&self) -> Vec<GroupWriter> {
            (1..=4)
                .map(|n| {
                    let served = self.people[n - 1].served();
                    GroupWriter {
                        user_id: self.id(n),
                        pinned: None,
                        served: Some(crate::identity::ServedKeys {
                            key_version: served.key_version,
                            encryption_public_key: served.encryption_public_key,
                            signing_public_key: served.signing_public_key,
                            ml_dsa_public_key: served.ml_dsa_public_key,
                            kem_public_key: served.kem_public_key,
                        }),
                        links: Some(vec![]),
                        personal: Some(self.keys(n)),
                    }
                })
                .collect()
        }
    }

    const FILE: u32 = 2;
    fn version_id(n: u32) -> String {
        format!("5e5e5e5e-0000-4000-8000-{n:012x}")
    }
    fn object_id(n: u32) -> String {
        format!("0b0b0b0b-0000-4000-8000-{n:012x}")
    }
    fn meta_statement() -> MetadataStatement {
        MetadataStatement {
            workspace_id: AREA.into(),
            node_id: node(FILE),
            kind: NodeKind::File,
            metadata_version: 1,
        }
    }
    fn version_ctx(n: u32) -> VersionContext {
        VersionContext {
            workspace_id: AREA.into(),
            node_id: node(FILE),
            version_id: version_id(n),
            object_id: object_id(n),
        }
    }
    fn version_statement(n: u32) -> VersionStatement {
        VersionStatement {
            workspace_id: AREA.into(),
            node_id: node(FILE),
            version_id: version_id(n),
            object_id: object_id(n),
            content_suite: 3,
        }
    }
    /* Version `n` sealed under `under` (content key pattern n), signed by person `by` when given. */
    fn version_by(f: &Family, n: u32, under: &[u8], by: Option<usize>) -> RotatingVersion {
        let envelope = version_seal(version_ctx(n), under.to_vec(), vec![n as u8; 32], 100 * n as u64, 0)
            .unwrap()
            .envelope;
        RotatingVersion {
            version_id: version_id(n),
            object_id: object_id(n),
            content_suite: 3,
            envelope: envelope.clone(),
            signer: by.map(|who| f.id(who)),
            signature: by.map(|who| version_sign(f.seed(who), version_statement(n), envelope).unwrap()),
            rekey: None,
        }
    }
    /*
     * Version `n` as an earlier walk from epoch 1 (`first`) to 2 (`now`) left it: written by
     * `writer` under `first`, re-keyed raw under `now`, attested by `rekeyer` at epoch 2.
     */
    fn version_rekeyed(
        f: &Family,
        n: u32,
        first: &[u8],
        now: &[u8],
        writer: usize,
        rekeyer: usize,
    ) -> RotatingVersion {
        let written = version_by(f, n, first, Some(writer));
        let envelope =
            version_rekey(version_ctx(n), 3, first.to_vec(), now.to_vec(), written.envelope.clone()).unwrap();
        let key_envelope = origin_key_wrap(
            OriginKeyContext {
                workspace_id: AREA.into(),
                node_id: node(FILE),
                key_epoch: 2,
                record: OriginRecord::Version { version_id: version_id(n) },
                origin_envelope: written.envelope.clone(),
            },
            now.to_vec(),
            origin_opening_key(written.envelope.clone(), first.to_vec()).unwrap(),
        )
        .unwrap();
        let origin = RecordOrigin {
            envelope: written.envelope.clone(),
            signer_id: f.id(writer),
            signature: written.signature.clone().unwrap(),
            key_envelope: key_envelope.clone(),
        };
        let signature =
            version_rekey_sign(f.seed(rekeyer), version_statement(n), 2, envelope.clone(), origin).unwrap();
        RotatingVersion {
            envelope,
            signer: Some(f.id(rekeyer)),
            signature: None,
            rekey: Some(ServedRekey {
                origin: ServedOrigin {
                    envelope: written.envelope.clone(),
                    signer_id: Some(f.id(writer)),
                    signature: written.signature.clone(),
                    key_envelope,
                },
                signature,
            }),
            ..written
        }
    }
    /* The file node at `key_epoch` (key `key`) under the top level's key at `parent_epoch`, named by `by`. */
    fn file_node(
        f: &Family,
        key: &[u8],
        key_epoch: u64,
        parent_epoch: u64,
        by: Option<usize>,
    ) -> RotatingNode {
        let envelope = metadata_seal(
            MetadataContext { workspace_id: AREA.into(), node_id: node(FILE), metadata_version: 1 },
            key.to_vec(),
            NodeMetadata { name: "plan.txt".into(), mime: None, size: None, modified: None },
        )
        .unwrap();
        RotatingNode {
            node_id: node(FILE),
            parent_id: node(ROOT),
            parent_key_epoch: 2,
            key_epoch,
            wrapped_parent_key_epoch: parent_epoch,
            key_envelope: wrap(
                &node(FILE),
                &node(ROOT),
                parent_epoch,
                key_epoch,
                &root_key(parent_epoch),
                key,
            ),
            kind: NodeKind::File,
            metadata_version: 1,
            metadata_envelope: envelope.clone(),
            metadata_signer: by.map(|who| f.id(who)),
            metadata_signature: by.map(|who| metadata_sign(f.seed(who), meta_statement(), envelope).unwrap()),
            metadata_rekey: None,
            versions: vec![],
            share_ids: vec![],
            link_ids: vec![],
        }
    }
    /* The node's key as a listing serves it, opened on `ledger`. */
    fn list(ledger: &AreaLedger, n: &RotatingNode) {
        ledger
            .open_listed_node(
                AREA.into(),
                ServedNodeKey {
                    node_id: n.node_id.clone(),
                    parent_id: n.parent_id.clone(),
                    parent_key_epoch: n.wrapped_parent_key_epoch,
                    key_epoch: n.key_epoch,
                    key_envelope: n.key_envelope.clone(),
                    prev_key_envelope: None,
                    prev_key_epoch: None,
                    prev_parent_key_epoch: None,
                },
            )
            .unwrap();
    }
    /*
     * The origin the server keeps for each record of `before` once a walk re-keyed it: the origin
     * it already carried, or the writer's record itself; none for an unsigned one.
     */
    fn kept_origins(before: &RotatingNode) -> Vec<Option<ServedOrigin>> {
        let of = |envelope: &Vec<u8>,
                  signer: &Option<String>,
                  signature: &Option<Vec<u8>>,
                  rekey: &Option<ServedRekey>| {
            match (rekey, signer, signature) {
                (Some(rekey), _, _) => Some(rekey.origin.clone()),
                (None, Some(signer), Some(signature)) => Some(ServedOrigin {
                    envelope: envelope.clone(),
                    signer_id: Some(signer.clone()),
                    signature: Some(signature.clone()),
                    key_envelope: vec![],
                }),
                _ => None,
            }
        };
        let mut out = vec![of(
            &before.metadata_envelope,
            &before.metadata_signer,
            &before.metadata_signature,
            &before.metadata_rekey,
        )];
        out.extend(before.versions.iter().map(|v| of(&v.envelope, &v.signer, &v.signature, &v.rekey)));
        out
    }
    /* The records of `rotated` as a listing serves them once the server stored the walk. */
    fn served_after(
        f: &Family,
        before: &RotatingNode,
        rotated: &RotatedNode,
        target: u64,
        walker: usize,
    ) -> Vec<ServedRecord> {
        let origins = kept_origins(before);
        let served = |statement: RecordStatement, record: &RotatedRecord, origin: &Option<ServedOrigin>| {
            ServedRecord {
                statement,
                key_epoch: Some(target),
                envelope: record.envelope.clone(),
                signer: Some(f.id(walker)),
                signature: record.signature.clone(),
                rekey: record.rekey.as_ref().map(|out| ServedRekey {
                    origin: ServedOrigin {
                        key_envelope: out.origin_key_envelope.clone(),
                        ..origin.clone().expect("a re-keyed record keeps an origin")
                    },
                    signature: out.signature.clone(),
                }),
            }
        };
        let mut out = vec![served(
            RecordStatement::Metadata { statement: meta_statement() },
            rotated.metadata.as_ref().unwrap(),
            &origins[0],
        )];
        for (index, version) in rotated.versions.iter().enumerate() {
            let n = u32::from_str_radix(&version.version_id[24..], 16).unwrap();
            out.push(served(
                RecordStatement::Version { statement: version_statement(n) },
                &version.record,
                &origins[index + 1],
            ));
        }
        out
    }
    /* Person `reader`'s fresh ledger holding the node's new key, opened from the walk's envelope under the top level. */
    fn reading_ledger(f: &Family, rotated: &RotatedNode, target: u64, reader: usize) -> Arc<AreaLedger> {
        let ledger = f.ledger(reader);
        ledger
            .open_listed_node(
                AREA.into(),
                ServedNodeKey {
                    node_id: node(FILE),
                    parent_id: node(ROOT),
                    parent_key_epoch: 2,
                    key_epoch: target,
                    key_envelope: rotated.key_envelope.clone(),
                    prev_key_envelope: None,
                    prev_key_epoch: None,
                    prev_parent_key_epoch: None,
                },
            )
            .unwrap();
        ledger
    }
    fn read_all(
        f: &Family,
        ledger: &AreaLedger,
        records: Vec<ServedRecord>,
        reader: usize,
    ) -> Vec<RecordVerdict> {
        records
            .into_iter()
            .map(|record| {
                ledger.record_verdict(GROUP.into(), f.reader(reader), f.writers(), record, None).unwrap()
            })
            .collect()
    }
    fn side(verdict: GroupVerdict, via: bool) -> GroupIntegrity {
        GroupIntegrity { verdict, via: via.then(|| GROUP.to_string()) }
    }
    fn rekeyed(origin: GroupIntegrity, rekeyer: GroupIntegrity, bound: Option<bool>) -> RecordVerdict {
        RecordVerdict::Rekeyed { verdict: GroupRekeyedVerdict { origin, rekeyer, bound } }
    }
    fn signed(verdict: GroupVerdict) -> RecordVerdict {
        RecordVerdict::Signed { verdict: side(verdict, false) }
    }

    /* A plain record of version `n` as a listing serves it, signer and signature as given. */
    fn plain(f: &Family, n: u32, signer: Option<usize>, signed_by: Option<usize>) -> ServedRecord {
        let version = version_by(f, n, &key(1), signed_by);
        ServedRecord {
            statement: RecordStatement::Version { statement: version_statement(n) },
            key_epoch: Some(1),
            envelope: version.envelope,
            signer: signer.map(|who| f.id(who)),
            signature: version.signature,
            rekey: None,
        }
    }

    #[test]
    fn a_walk_keeps_each_writer_s_record_and_a_reader_names_the_writer_never_the_walker() {
        let f = family();
        let ledger = f.ledger(1);
        // Named by person 3 (since removed), uploaded by person 2; under the top level's old key, as
        // a removal's walk finds it.
        let mut file = file_node(&f, &key(1), 1, 1, Some(3));
        file.versions = vec![version_by(&f, 1, &key(1), Some(2))];
        list(&ledger, &file);
        let rotated = ledger.rotate_node(AREA.into(), file.clone(), 2, f.seed(1)).unwrap();
        assert!(!rotated.rewrap);
        let metadata = rotated.metadata.clone().unwrap();
        assert!(metadata.rekey.is_some() && metadata.signature.is_none() && !metadata.drop_origin);
        let uploaded = &rotated.versions[0].record;
        assert!(uploaded.rekey.is_some() && uploaded.signature.is_none() && !uploaded.drop_origin);
        // Pending only: the fresh key is the node's once the server takes the batch.
        assert!(ledger.key_at_epoch(AREA.into(), node(FILE), 2).is_none());
        assert_eq!(ledger.rotate_commit(AREA.into(), vec![node(FILE)]), 1);
        assert!(ledger.key_at_epoch(AREA.into(), node(FILE), 2).is_some());
        // Person 4 reads it on their own device: the removed member's name stays theirs.
        let reading = reading_ledger(&f, &rotated, 2, 4);
        let verdicts = read_all(&f, &reading, served_after(&f, &file, &rotated, 2, 1), 4);
        let walker = side(GroupVerdict::Verified, true);
        assert_eq!(verdicts[0], rekeyed(side(GroupVerdict::FormerMember, false), walker.clone(), Some(true)));
        assert_eq!(verdicts[1], rekeyed(side(GroupVerdict::Verified, true), walker, Some(true)));
        // The walker reading its own walk: its re-key judged by its own keys, the writers' by the roster.
        let own_ledger = reading_ledger(&f, &rotated, 2, 1);
        let own = read_all(&f, &own_ledger, served_after(&f, &file, &rotated, 2, 1), 1);
        assert_eq!(
            own[1],
            rekeyed(side(GroupVerdict::Verified, true), side(GroupVerdict::Verified, false), Some(true))
        );
        // The origin swapped for another version's record no longer binds.
        let mut swapped = served_after(&f, &file, &rotated, 2, 1);
        let other = version_by(&f, 6, &key(1), Some(2));
        if let Some(rekey) = swapped[1].rekey.as_mut() {
            rekey.origin.envelope = other.envelope;
            rekey.origin.signature = other.signature;
        }
        let RecordVerdict::Rekeyed { verdict } = &read_all(&f, &reading, swapped, 4)[1] else {
            panic!("re-keyed")
        };
        assert_ne!(verdict.bound, Some(true));
    }

    #[test]
    fn an_origin_kept_before_is_carried_only_when_it_binds_and_dropped_otherwise() {
        let f = family();
        let ledger = f.ledger(4);
        // The file was walked once already (epoch 1 to 2, key 0 to key 1): its versions carry origins.
        let mut file = file_node(&f, &key(1), 2, 1, Some(2));
        let carried = version_rekeyed(&f, 2, &key(0), &key(1), 2, 1);
        let mut gone = version_rekeyed(&f, 3, &key(0), &key(1), 2, 1);
        gone.rekey.as_mut().unwrap().origin.signer_id = None;
        // Its current bytes are not its origin's: a dishonest earlier walker re-sealed something else.
        let mut unbound = version_rekeyed(&f, 4, &key(0), &key(1), 2, 1);
        unbound.envelope = version_seal(version_ctx(4), key(1), vec![9; 32], 1, 0).unwrap().envelope;
        // An origin naming its writer with no signature: dropped, never a stop for the node.
        let mut no_signature = version_rekeyed(&f, 5, &key(0), &key(1), 2, 1);
        no_signature.rekey.as_mut().unwrap().origin.signature = None;
        file.versions = vec![carried.clone(), gone, unbound, no_signature];
        list(&ledger, &file);
        let rotated = ledger.rotate_node(AREA.into(), file.clone(), 3, f.seed(4)).unwrap();
        let kept = &rotated.versions[0].record;
        assert!(kept.rekey.is_some() && !kept.drop_origin);
        for dropped in &rotated.versions[1..] {
            assert!(dropped.record.rekey.is_none() && dropped.record.drop_origin, "{}", dropped.version_id);
            assert!(dropped.record.signature.is_some(), "{}", dropped.version_id);
        }
        ledger.rotate_commit(AREA.into(), vec![node(FILE)]);
        // A row not yet walked is read with the node's key at its own epoch (the previous one now).
        let before = ServedRecord {
            statement: RecordStatement::Version { statement: version_statement(2) },
            key_epoch: Some(2),
            envelope: carried.envelope.clone(),
            signer: carried.signer.clone(),
            signature: None,
            rekey: carried.rekey.clone(),
        };
        assert_eq!(
            ledger.record_verdict(GROUP.into(), f.reader(4), f.writers(), before, None).unwrap(),
            rekeyed(side(GroupVerdict::Verified, true), side(GroupVerdict::Verified, true), Some(true))
        );
        let reading = reading_ledger(&f, &rotated, 3, 1);
        let verdicts = read_all(&f, &reading, served_after(&f, &file, &rotated, 3, 4), 1);
        // Person 2's version, carried through two walks: still theirs, and bound.
        assert_eq!(
            verdicts[1],
            rekeyed(side(GroupVerdict::Verified, true), side(GroupVerdict::Verified, true), Some(true))
        );
        for dropped in &verdicts[2..] {
            assert_eq!(*dropped, signed(GroupVerdict::Resealed));
        }
    }

    #[test]
    fn a_node_whose_records_do_not_re_key_leaves_no_pending_key_behind() {
        let f = family();
        let ledger = f.ledger(1);
        let mut file = file_node(&f, &key(1), 1, 1, Some(2));
        // A version sealed under another key than the node's: the walk cannot re-seal it.
        file.versions = vec![version_by(&f, 1, &key(1), Some(2)), version_by(&f, 2, &key(7), Some(2))];
        list(&ledger, &file);
        assert!(ledger.rotate_node(AREA.into(), file.clone(), 2, f.seed(1)).is_err());
        // Nothing pending: no child goes under a fresh key nobody stored, nothing to commit or drop.
        assert_eq!(ledger.rotate_drop_all(AREA.into()), 0);
        assert_eq!(ledger.rotate_commit(AREA.into(), vec![node(FILE)]), 0);
        assert_eq!(message(ledger.new_node_key(AREA.into(), node(3), node(FILE), 2, 2)), KEY_CHANGE_PENDING);
        // A carried origin whose current envelope the walker's key does not open stops it too.
        let mut stale = file_node(&f, &key(1), 2, 1, Some(2));
        let mut wrong = version_rekeyed(&f, 3, &key(0), &key(1), 2, 1);
        wrong.envelope = version_seal(version_ctx(3), key(8), vec![3; 32], 300, 0).unwrap().envelope;
        stale.versions = vec![wrong];
        let fresh_ledger = f.ledger(1);
        list(&fresh_ledger, &stale);
        assert!(fresh_ledger.rotate_node(AREA.into(), stale, 3, f.seed(1)).is_err());
        assert_eq!(fresh_ledger.rotate_drop_all(AREA.into()), 0);
        // A bad signing seed is refused before anything is made.
        assert!(ledger.rotate_node(AREA.into(), file, 2, vec![1; 31]).is_err());
        assert_eq!(ledger.rotate_drop_all(AREA.into()), 0);
    }

    #[test]
    fn an_unsigned_record_under_the_replaced_key_is_re_sealed_and_reads_as_re_locked_by_the_walker() {
        let f = family();
        // Under the top level's old key, as a removal's walk finds it: a version nobody signed, and
        // one whose writer's account is gone (signature kept, signer served as nobody).
        let ledger = f.ledger(1);
        let mut file = file_node(&f, &key(1), 1, 1, Some(2));
        let mut gone = version_by(&f, 6, &key(1), Some(2));
        gone.signer = None;
        file.versions = vec![version_by(&f, 5, &key(1), None), gone];
        list(&ledger, &file);
        let walked = ledger.rotate_node(AREA.into(), file.clone(), 2, f.seed(1)).unwrap();
        for version in &walked.versions {
            let record = &version.record;
            assert!(record.rekey.is_none() && record.signature.is_some() && !record.drop_origin);
        }
        assert_eq!(ledger.rotate_commit(AREA.into(), vec![node(FILE)]), 1);
        // Read by another member: re-locked by the walker, never written by them (decision D6).
        let reading = reading_ledger(&f, &walked, 2, 4);
        let verdicts = read_all(&f, &reading, served_after(&f, &file, &walked, 2, 1), 4);
        assert_eq!(&verdicts[1..], &[signed(GroupVerdict::Resealed), signed(GroupVerdict::Resealed)]);
    }

    #[test]
    fn a_node_is_walked_once_per_target_while_its_fresh_key_is_pending() {
        let f = family();
        let ledger = f.ledger(1);
        let file = file_node(&f, &key(1), 1, 1, Some(2));
        list(&ledger, &file);
        let first = ledger.rotate_node(AREA.into(), file.clone(), 2, f.seed(1)).unwrap();
        // A child wrapped under the first walk's fresh key would be stranded if a second replaced it.
        assert_eq!(message(ledger.rotate_node(AREA.into(), file.clone(), 2, f.seed(1))), ITEM_CHANGED);
        assert_eq!(ledger.rotate_commit(AREA.into(), vec![node(FILE)]), 1);
        assert_eq!(
            node_open(ctx(AREA, &node(FILE), &node(ROOT), 2, 2), root_key(2), first.key_envelope).unwrap(),
            ledger.key_at_epoch(AREA.into(), node(FILE), 2).unwrap().to_vec()
        );
        // Dropped, the node may be walked again.
        let again = f.ledger(1);
        list(&again, &file);
        again.rotate_node(AREA.into(), file.clone(), 2, f.seed(1)).unwrap();
        assert_eq!(again.rotate_drop(AREA.into(), vec![node(FILE)]), 1);
        assert!(again.rotate_node(AREA.into(), file, 2, f.seed(1)).is_ok());
    }

    #[test]
    fn a_walk_and_a_verdict_are_the_unlocked_account_s_alone() {
        let f = family();
        let ledger = f.ledger(1);
        let file = file_node(&f, &key(1), 1, 1, Some(2));
        list(&ledger, &file);
        // Another member's seed on this account's ledger: refused before anything is made.
        assert_eq!(message(ledger.rotate_node(AREA.into(), file.clone(), 2, f.seed(2))), NOT_THIS_ACCOUNT);
        assert_eq!(ledger.rotate_drop_all(AREA.into()), 0);
        let record = plain(&f, 1, Some(2), Some(2));
        // Another reader, or this account's id with another key: refused.
        assert_eq!(
            message(ledger.record_verdict(GROUP.into(), f.reader(4), f.writers(), record.clone(), None)),
            NOT_THIS_ACCOUNT
        );
        let posing = RecordReader { user_id: f.id(1), keys: f.keys(2) };
        assert_eq!(
            message(ledger.record_verdict(GROUP.into(), posing.clone(), f.writers(), record.clone(), None)),
            NOT_THIS_ACCOUNT
        );
        assert_eq!(
            message(ledger.copy_form(GROUP.into(), posing, f.writers(), record.clone(), None)),
            NOT_THIS_ACCOUNT
        );
        // Before the account is opened, nothing is judged or walked; a lock forgets it.
        ledger.clear();
        assert_eq!(
            message(ledger.record_verdict(GROUP.into(), f.reader(1), f.writers(), record, None)),
            NO_ACCOUNT
        );
        assert_eq!(message(ledger.rotate_node(AREA.into(), file, 2, f.seed(1))), NO_ACCOUNT);
    }

    #[test]
    fn a_walk_refuses_shares_links_a_personal_workspace_and_the_top_level() {
        let f = family();
        let ledger = f.ledger(1);
        let file = file_node(&f, &key(1), 1, 1, Some(2));
        list(&ledger, &file);
        let shared = RotatingNode { share_ids: vec![version_id(1)], ..file.clone() };
        assert_eq!(message(ledger.rotate_node(AREA.into(), shared, 2, f.seed(1))), SHARED_IN_FAMILY);
        let linked = RotatingNode { link_ids: vec![version_id(1)], ..file.clone() };
        assert_eq!(message(ledger.rotate_node(AREA.into(), linked, 2, f.seed(1))), SHARED_IN_FAMILY);
        assert_eq!(ledger.rotate_drop_all(AREA.into()), 0);
        let personal = "f0f0f0f0-0000-4000-8000-00000000000f";
        ledger.open_personal_workspace(personal.into(), 1, key(9)).unwrap();
        let mine = RotatingNode { parent_id: personal.into(), ..file.clone() };
        assert_eq!(message(ledger.rotate_node(personal.into(), mine, 2, f.seed(1))), NOT_A_FAMILY_FOLDER);
        let top = RotatingNode {
            node_id: node(ROOT),
            parent_id: AREA.into(),
            key_envelope: root_row(2).key_envelope,
            key_epoch: 2,
            wrapped_parent_key_epoch: 2,
            ..file.clone()
        };
        assert_eq!(message(ledger.rotate_node(AREA.into(), top, 3, f.seed(1))), AREA_ROOT);
        // And the walk goes once the node is what a family folder holds.
        assert!(ledger.rotate_node(AREA.into(), file, 2, f.seed(1)).is_ok());
    }

    #[test]
    fn a_node_already_at_the_target_is_re_wrapped_with_its_records_untouched() {
        let f = family();
        let ledger = f.ledger(1);
        // Already at epoch 3, written under the top level's current key: only re-wrapped.
        let file = file_node(&f, &key(4), 3, 2, Some(2));
        list(&ledger, &file);
        let rotated = ledger.rotate_node(AREA.into(), file, 3, f.seed(1)).unwrap();
        assert!(rotated.rewrap && rotated.metadata.is_none() && rotated.versions.is_empty());
        assert_eq!(
            node_open(ctx(AREA, &node(FILE), &node(ROOT), 2, 3), root_key(2), rotated.key_envelope).unwrap(),
            key(4)
        );
    }

    #[test]
    fn a_record_s_verdict_follows_the_ledger_s_family_chain_and_fork_and_a_withheld_key_is_unchecked() {
        let f = family();
        let ledger = f.ledger(1);
        let mut file = file_node(&f, &key(1), 1, 1, Some(3));
        file.versions = vec![version_by(&f, 1, &key(1), Some(2))];
        list(&ledger, &file);
        let rotated = ledger.rotate_node(AREA.into(), file.clone(), 2, f.seed(1)).unwrap();
        let reading = reading_ledger(&f, &rotated, 2, 4);
        let records = served_after(&f, &file, &rotated, 2, 1);
        let verdict_of = |ledger: &AreaLedger, reader: usize, record: ServedRecord| {
            ledger.record_verdict(GROUP.into(), f.reader(reader), f.writers(), record, None)
        };
        // The node key at another epoch than the record's, or no epoch at all: nothing confirmed.
        for epoch in [Some(5), None] {
            let elsewhere = ServedRecord { key_epoch: epoch, ..records[1].clone() };
            let Ok(RecordVerdict::Rekeyed { verdict }) = verdict_of(&reading, 4, elsewhere) else {
                panic!("re-keyed")
            };
            assert_eq!((verdict.origin.verdict, verdict.bound), (GroupVerdict::Unchecked, None), "{epoch:?}");
        }
        // Another family's id for this folder: refused, never judged under that family's roster.
        assert_eq!(
            message(reading.record_verdict(
                OTHER_GROUP.into(),
                f.reader(4),
                f.writers(),
                records[1].clone(),
                None
            )),
            NOT_THIS_FAMILYS
        );
        // A plain record by person 2: the roster's word; without the chain unchecked; after a fork,
        // personal keys; once a chain is committed again, the roster's word again.
        let record = plain(&f, 1, Some(2), Some(2));
        assert_eq!(
            verdict_of(&reading, 4, record.clone()),
            Ok(RecordVerdict::Signed { verdict: side(GroupVerdict::Verified, true) })
        );
        reading.uncommit(GROUP.into(), false);
        assert_eq!(verdict_of(&reading, 4, record.clone()), Ok(signed(GroupVerdict::Unchecked)));
        reading.uncommit(GROUP.into(), true);
        assert_eq!(verdict_of(&reading, 4, record.clone()), Ok(signed(GroupVerdict::Verified)));
        reading.commit(Arc::clone(&f.chain)).unwrap();
        assert_eq!(
            verdict_of(&reading, 4, record.clone()),
            Ok(RecordVerdict::Signed { verdict: side(GroupVerdict::Verified, true) })
        );
        // Forgetting the family forgets its fork too.
        reading.uncommit(GROUP.into(), true);
        reading.forget_group(GROUP.into());
        assert_eq!(message(verdict_of(&reading, 4, record.clone())), NOT_THIS_FAMILYS);
        // This account's own record is judged by its own keys, whatever the roster says.
        let own = reading_ledger(&f, &rotated, 2, 2);
        own.uncommit(GROUP.into(), false);
        assert_eq!(verdict_of(&own, 2, record.clone()), Ok(signed(GroupVerdict::Verified)));
        // A stripped signature is unsigned, before any trust is looked up.
        let stripped = ServedRecord { signature: None, ..record };
        assert_eq!(verdict_of(&own, 2, stripped), Ok(signed(GroupVerdict::Unsigned)));
    }

    #[test]
    fn a_copy_vouches_only_for_what_verified_and_never_for_a_removed_member_s_record() {
        let f = family();
        let ledger = f.ledger(1);
        let mut file = file_node(&f, &key(1), 1, 1, Some(3));
        file.versions = vec![version_by(&f, 1, &key(1), Some(2))];
        list(&ledger, &file);
        let rotated = ledger.rotate_node(AREA.into(), file.clone(), 2, f.seed(1)).unwrap();
        let reading = reading_ledger(&f, &rotated, 2, 4);
        let records = served_after(&f, &file, &rotated, 2, 1);
        let form = |record: &ServedRecord, writers: Vec<GroupWriter>| {
            reading.copy_form(GROUP.into(), f.reader(4), writers, record.clone(), None)
        };
        assert_eq!(form(&records[0], f.writers()), Ok(Integrity::Resealed), "a removed member's name");
        assert_eq!(form(&records[1], f.writers()), Ok(Integrity::Verified));
        // Person 2 named, person 3's signature; nobody the reader knows; no signature: re-sealed.
        assert_eq!(
            form(&plain(&f, 7, Some(2), Some(3)), f.writers()),
            Ok(Integrity::Resealed),
            "bad signature"
        );
        let stranger = ServedRecord {
            signer: Some("00000009-abcd-4abc-8abc-abcdefabcdef".into()),
            ..plain(&f, 8, None, Some(3))
        };
        assert_eq!(form(&stranger, f.writers()), Ok(Integrity::Resealed), "unknown signer");
        assert_eq!(form(&plain(&f, 9, Some(2), None), f.writers()), Ok(Integrity::Resealed), "unsigned");
        // A re-keyed record whose key epoch is not served: its columns are the walker's, so unchecked.
        let no_epoch = ServedRecord { key_epoch: None, ..records[1].clone() };
        assert!(form(&no_epoch, f.writers()).is_err());
        // Bytes that do not bind are never vouched for.
        let mut unbound = records[1].clone();
        unbound.rekey.as_mut().unwrap().origin.key_envelope[10] ^= 1;
        assert_eq!(form(&unbound, f.writers()), Ok(Integrity::Resealed));
        // A writer the reader cannot check (a pin with an empty origin) stops the copy.
        let mut unsure = f.writers();
        unsure[1].pinned = Some(WriterPin {
            key_version: Some(1),
            encryption_public_key: "x".into(),
            signing_public_key: "x".into(),
            ml_dsa_public_key_hash: "x".into(),
            trusted_via: Some(String::new()),
        });
        assert!(form(&records[1], unsure).is_err());
        // Only out of a folder this family's chain lists and this device opened under it.
        assert_eq!(
            message(reading.copy_form(
                OTHER_GROUP.into(),
                f.reader(4),
                f.writers(),
                records[1].clone(),
                None
            )),
            NOT_THIS_FAMILYS
        );
        reading.uncommit(GROUP.into(), false);
        assert_eq!(message(form(&records[1], f.writers())), NOT_THIS_FAMILYS);
    }
}
