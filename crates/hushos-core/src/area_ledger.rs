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
//! family [`AreaLedger::open_area`] derived its id under, and never while a
//! second committed chain lists it, so another family's member list (one a
//! removed member manages, say) can neither move an area's write version nor
//! drop its keys. A chain older than the one held is refused.
//!
//! Where it differs from the worker, on purpose: [`AreaLedger::rotate_key`]
//! marks a walk's fresh key pending at once (the worker's `rotateKey` does
//! after re-keying the node's records, a callback UniFFI does not carry), so
//! an app whose record re-keying fails calls [`AreaLedger::rotate_drop`] for
//! the node, or [`AreaLedger::rotate_drop_all`] when it lost track of the
//! batch, as a refused batch does.

use crate::bytes::{random, SecretBytes};
use crate::canonical::uuid;
use crate::drive::{node_open_checked, node_wrap_checked, previous_root_key_open, NodeKeyContext};
use crate::error::{input, CoreError, CoreResult};
use crate::group_trust::AcceptedRosters;
use crate::groups::{area_key_commitment, area_root_check, area_write_version};
use crate::ids::{check_id, IdKind};
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
/// A chain older than the one this device already holds for the family (a
/// background acceptance that lost a race with the foreground's): refused,
/// and nothing of it (the record, the pin) is to be written.
pub const OLDER_CHAIN: &str = "This device already holds a later member list for this family. Sync again.";
/// Another chain at the very roster version held for the family, with another
/// digest: a split view, never committed. An app reports it as the fork (the
/// hard warning); acceptance with the session's committed chain as a mark
/// (core step 3, `accept_served`) answers the fork before this.
pub const SPLIT_CHAIN: &str = "This family’s member list was shown differently to this device.";

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

/// One node of a walk: its key envelope under the parent's key at the
/// target; the node's key as it was (`old_key`); and, unless the node was
/// only re-wrapped under a re-keyed parent (`rewrap`), the fresh key that
/// replaces it, to re-key its records with.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
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
    /* Each area's root node: the first top-level row whose key the family's chain committed to. */
    root_ids: HashMap<AreaSlot, String>,
    /* What the web's group session holds: committed chains by group, and areas opened per group. */
    chains: HashMap<String, Arc<AcceptedRosters>>,
    opened: HashMap<String, BTreeMap<String, OpenedArea>>,
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
        let families = self.opened_by(workspace_id);
        if families.len() != 1 || self.listings(workspace_id) > 1 {
            return None;
        }
        families.into_iter().next()
    }

    fn is_area(&self, workspace_id: &str) -> bool {
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
        // Only once a root wrapped under this very version was opened here.
        if self.root_seen_at.get(&at) != Some(&version) {
            return Err(refused(KEYS_CHANGED));
        }
        Ok(Some(version))
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
            if self.root_seen_at.get(&at) == Some(&parent_key_epoch) {
                self.root_seen_at.remove(&at);
            }
            return Ok(false);
        }
        let seen = self.root_seen_at.get(&at).copied();
        if seen.is_none_or(|seen| seen < parent_key_epoch) {
            self.root_seen_at.insert(at.clone(), parent_key_epoch);
        }
        self.root_ids.entry(at).or_insert_with(|| node_id.to_string());
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
        self.chains.insert(group_id, chain);
        Ok(())
    }

    fn uncommit(&mut self, group_id: &str) {
        self.area_write.retain(|(group, _), _| group != group_id);
        self.chains.remove(group_id);
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

    fn rotate_key(
        &mut self,
        workspace_id: &str,
        node: &RotatingNodeKey,
        target_epoch: u64,
    ) -> CoreResult<RotatedKey> {
        // As the web's driveRotateNodes: no walk in a family folder this device found unwritable.
        self.require_writable(workspace_id)?;
        let old = self.rotation_old_key(workspace_id, node)?;
        // Already at the target, only wrapped under an unrotated parent: the same key, re-wrapped.
        if node.key_epoch >= target_epoch {
            let kept = SecretBytes::new(old.to_vec());
            let key_envelope = self.rewrap_at_target(workspace_id, node, old)?;
            return Ok(RotatedKey { key_envelope, rewrap: true, old_key: Some(kept), fresh_key: None });
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
        Ok(RotatedKey {
            key_envelope,
            rewrap: false,
            old_key: Some(SecretBytes::new(old.to_vec())),
            fresh_key: Some(SecretBytes::new(fresh.to_vec())),
        })
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

    /// A family's chain, accepted from what the server served (never a staged
    /// one): its areas are written under the versions it lists, and only its
    /// own areas (an area is resolved only through the family it was opened
    /// under, and never while a second committed chain lists it). A new write
    /// version needs its root seen again; a retired area is written no more.
    /// Refused ([`OLDER_CHAIN`]) for a chain older than the one held, and
    /// ([`SPLIT_CHAIN`]) for another chain at the version held: an app then
    /// writes nothing of that acceptance (record, pin), and shows the second
    /// as the fork.
    pub fn commit(&self, chain: Arc<AcceptedRosters>) -> CoreResult<()> {
        self.lock().commit(chain)
    }

    /// A refusal or a fork for the family: none of its areas is written until a chain is committed again.
    pub fn uncommit(&self, group_id: String) {
        self.lock().uncommit(&group_id);
    }

    /// A family the person no longer reads: the keys of the areas it opened, and all it knew of them.
    /// Another family's chain listing those areas touches nothing.
    pub fn forget_group(&self, group_id: String) {
        self.lock().forget_group(&group_id);
    }

    /// Every key, wiped: a lock or a sign-out.
    pub fn clear(&self) {
        *self.lock() = State::default();
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
        Ok(AreaOpened { version, writable: reason.is_none(), reason })
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

    /// One node of a walk to `target_epoch`: a node already at the target is
    /// re-wrapped, only if its key is rooted at the write version
    /// ([`NOT_CARRIED`]); any other gets a fresh key under a parent the rules
    /// allow, pending until [`AreaLedger::rotate_commit`]. A family folder's
    /// top level is never a walk's ([`AREA_ROOT`]).
    pub fn rotate_key(
        &self,
        workspace_id: String,
        node: RotatingNodeKey,
        target_epoch: u64,
    ) -> CoreResult<RotatedKey> {
        self.lock().rotate_key(&workspace_id, &node, target_epoch)
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
        refused.uncommit(GROUP.into());
        assert_eq!(message(refused.require_writable(AREA.into())), NOT_CHECKED_KEYS);
        refused.commit(chain(vec![vec![Row::Key(1)]])).unwrap();
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
        assert_eq!(message(ledger.write_version(AREA.into())), NOT_CHECKED_KEYS);
        let old_root = served(&node(ROOT), AREA, 1, 1, &area_key_at(AREA, 1), &root_key(1));
        ledger.open_listed_node(AREA.into(), old_root).unwrap();
        assert_eq!(message(ledger.new_node_key(AREA.into(), node(2), node(ROOT), 1, 1)), NOT_CHECKED_KEYS);
        // The other family gone again, the area is its own family's: version 2, and the old top
        // level writes nothing.
        ledger.uncommit(OTHER_GROUP.into());
        assert_eq!(ledger.write_version(AREA.into()), Ok(Some(2)));
        assert_eq!(message(ledger.new_node_key(AREA.into(), node(2), node(ROOT), 1, 1)), KEY_CHANGE_PENDING);
        ledger.open_listed_node(AREA.into(), root_row(2)).unwrap();
        assert!(ledger.new_node_key(AREA.into(), node(2), node(ROOT), 2, 2).is_ok());
    }

    #[test]
    fn another_family_uncommitted_or_forgotten_leaves_this_family_s_folder_alone() {
        let ledger = writable_at(1);
        let folder = ledger.new_node_key(AREA.into(), node(2), node(ROOT), 1, 1).unwrap();
        // Its chain refused, or forgotten, without ever being committed here: nothing changes.
        ledger.uncommit(OTHER_GROUP.into());
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
}
