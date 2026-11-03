//! Core 5b (docs/groups-mobile-plan.md): the roster calls that rotate a
//! family's folders, twins of the worker's `groupStage` kinds `remove`,
//! `markLeft`, `rotate` and `retire` and of `groupPreviousRoot`
//! (`packages/crypto/src/session-groups.ts`): a removal (the person marked
//! left, every live folder rotated, a succession when a manager leaves), the
//! departed marked left (route 7), one folder's key replacement (route 24),
//! a folder's deletion (the tombstone roster, route 30), and the
//! previous-root repair (route 28), plus the rebuild of a kept call's
//! rotations with the same roster (the worker's `groupRestage` with
//! `rebuild`, what `OutboxStep::Rebuild` asks for).
//!
//! A rotation (the worker's `rotationOf`): the area's new key and its root's
//! new key are this call's own; the root is re-keyed under the new area key
//! at the target epoch, its records re-keyed as a walk re-keys them
//! (`rekey_node_records`: no legacy signature in a family folder, the
//! worker's `rekeyOnly`), its old key wrapped under the new area key as the
//! previous root key (option A), both checked to open before anything is
//! sent; every workspace document is opened under the key being replaced and
//! sealed for its next version under the new one (a `tags` document that
//! does not open goes on empty, and says so); and this account's self-grant
//! of the new key goes with it.

use super::*;
use crate::area_ledger::SHARED_IN_FAMILY;
use crate::area_open::self_grant_seal;
use crate::drive::{
    document_open, document_seal, node_open, node_wrap, previous_root_key_open, previous_root_key_wrap,
    DocumentContext, NodeKeyContext,
};
use crate::rotation_records::{rekey_node_records, RotatedRecord, RotatingNode};
use crate::NodeKind;

/// A removal that does not rotate exactly the folders it must (the worker's words).
pub const EVERY_FOLDER: &str = "Every family folder must get new keys in this change.";
/// A folder the committed member list does not name as live (the worker's words).
pub const NOT_ON_LIST: &str = "This folder is not on the family’s member list.";
const NOBODY_LEFT: &str = "No one is due to be marked as left.";
const NOT_THE_ROOT: &str = "This is not the root of the family folder being rotated.";
const DRAW_EPOCH: &str = "Draw a new key epoch for this folder first.";
const ONE_DOCUMENT: &str = "A folder’s document is sealed again only once.";
const DOCUMENT_DAMAGED: &str = "This document could not be opened. It may be damaged.";
const KEYS_DID_NOT_OPEN: &str = "The family folder’s new keys didn’t open, so nothing was sent.";
const EARLIER_DID_NOT_OPEN: &str = "The folder’s earlier key didn’t open, so nothing was sent.";
const NOT_THIS_CHANGE: &str = "This saved change does not match its member list.";
pub(super) const NOT_ROTATED_HERE: &str = "This change does not rotate that folder.";
/* JavaScript's Number.MAX_SAFE_INTEGER: the worker refuses a target epoch past it. */
const MAX_SAFE: u64 = (1 << 53) - 1;

/// One family folder's rotation, as the app gathers it for the call (the
/// worker's `AreaRotationInput`): the target epoch drawn from route
/// `/drive/workspaces/:id/epochs` above every epoch in the area, the root as
/// the rotation work serves it (`parent_id` the workspace, `parent_key_epoch`
/// the version the root goes under, `wrapped_parent_key_epoch` the one it is
/// under now; no shares or links in a family folder), its change sequence,
/// and every workspace document of the area as served.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct AreaRotation {
    pub workspace_id: String,
    pub target_epoch: u64,
    pub root: RotatingNode,
    pub change_seq: u64,
    pub documents: Vec<ServedDocument>,
}

/// A workspace document as served (`/drive/workspaces/:id/documents/:kind`):
/// its kind, the version read (the precondition), and its envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ServedDocument {
    pub kind: String,
    pub version: u64,
    pub envelope: Vec<u8>,
}

/// A workspace document that did not open under the key being replaced and
/// went on empty (only a `tags` document does): said, never silent.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ReplacedDocument {
    pub workspace_id: String,
    pub kind: String,
}

/// A family folder's root as route 25 serves it for the previous-root check
/// (the worker's `groupPreviousRoot` input).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct PreviousRoot {
    pub node_id: String,
    pub parent_key_epoch: u64,
    pub prev_key_envelope: Option<Vec<u8>>,
    pub prev_key_epoch: Option<u64>,
    pub prev_parent_key_epoch: Option<u64>,
}

/// What the previous-root check found (the worker's `groupPreviousRoot`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum PreviousRootRepair {
    /// No previous envelope under the current area key: nothing to check.
    None,
    /// It opens (to the key this device held, when it held one).
    Opens,
    /// It does not open, and this device held the old key: route 28's body.
    Repair { previous_root_key_envelope: Vec<u8> },
    /// It does not open, and this device never held the old key.
    Cannot,
}

/* The keys a rotation is made with, kept in the call's sealed outbox entry for a rebuild. */
pub(super) struct RotationKeys {
    pub(super) area: Zeroizing<Vec<u8>>,
    pub(super) root: Zeroizing<Vec<u8>>,
}

/* A rotated record as the rotation call carries it (the walk's wire, rotatedNodeSchema). */
fn record_wire(record: &RotatedRecord) -> (Value, Value) {
    let signature = record.signature.as_ref().map(|s| json!(encode(s))).unwrap_or(Value::Null);
    let rekey = record
        .rekey
        .as_ref()
        .map(|at| json!({ "originKeyEnvelope": encode(&at.origin_key_envelope), "signature": encode(&at.signature) }))
        .unwrap_or(Value::Null);
    (signature, rekey)
}

/* A document as the worker's openOrReplace opens it: its JSON text, or an empty `tags` document. */
fn open_or_replace(document: &ServedDocument, key: &[u8], workspace_id: &str) -> CoreResult<(String, bool)> {
    let ctx = DocumentContext {
        workspace_id: workspace_id.into(),
        kind: document.kind.clone(),
        version: document.version,
    };
    let opened = document_open(ctx, key.to_vec(), document.envelope.clone())
        .ok()
        .filter(|text| serde_json::from_str::<Value>(text).is_ok());
    match opened {
        Some(text) => Ok((text, false)),
        None if document.kind == "tags" => Ok((r#"{"version":2,"tags":[],"items":{}}"#.into(), true)),
        None => Err(CoreError::Sealed(DOCUMENT_DAMAGED.into())),
    }
}

/*
 * One folder's rotation wire (the worker's rotationOf): from `from_version`
 * (the area's write version, whose key `from_key` is) to the next, with the
 * new area and root keys, records re-keyed with `signing_seed` (the open
 * identity's), and the self-grant given.
 */
#[allow(clippy::too_many_arguments)]
pub(super) fn rotation_wire(
    rotation: &AreaRotation,
    from_version: u64,
    from_key: &[u8],
    old: impl FnOnce() -> CoreResult<Zeroizing<Vec<u8>>>,
    keys: &RotationKeys,
    self_grant: Value,
    signing_seed: &[u8],
    replaced: &mut Vec<ReplacedDocument>,
) -> CoreResult<Value> {
    let workspace_id = rotation.workspace_id.as_str();
    let root = &rotation.root;
    let to_version = from_version + 1;
    if root.parent_id != workspace_id || root.parent_key_epoch != to_version {
        return Err(input(NOT_THE_ROOT));
    }
    if rotation.target_epoch > MAX_SAFE || rotation.target_epoch <= root.key_epoch {
        return Err(input(DRAW_EPOCH));
    }
    if root.kind != NodeKind::Folder {
        return Err(input(NOT_THE_ROOT));
    }
    // The area's documents, opened under the key being replaced (and only that one) and sealed for
    // their next version under the new key: they move with the roster, never after it.
    let mut documents = vec![];
    let mut kinds = std::collections::HashSet::new();
    for document in &rotation.documents {
        if !kinds.insert(document.kind.clone()) {
            return Err(input(ONE_DOCUMENT));
        }
        let (text, empty) = open_or_replace(document, from_key, workspace_id)?;
        if empty {
            replaced
                .push(ReplacedDocument { workspace_id: workspace_id.into(), kind: document.kind.clone() });
        }
        let ctx = DocumentContext {
            workspace_id: workspace_id.into(),
            kind: document.kind.clone(),
            version: document.version + 1,
        };
        documents.push(json!({
            "kind": document.kind,
            "version": document.version,
            "envelope": encode(&document_seal(ctx, keys.area.to_vec(), text)?),
        }));
    }
    // The root's key as it is now (the worker's currentKeyOf), after its documents as there.
    let old = old()?;
    let old = old.as_slice();
    // Sharing is hidden in family folders (design 3.4): re-sealing a share would hand the key on.
    if !root.share_ids.is_empty() || !root.link_ids.is_empty() {
        return Err(input(SHARED_IN_FAMILY));
    }
    let current = NodeKeyContext {
        workspace_id: workspace_id.into(),
        node_id: root.node_id.clone(),
        parent_id: workspace_id.into(),
        parent_key_epoch: to_version,
        key_epoch: rotation.target_epoch,
    };
    let previous = NodeKeyContext { key_epoch: root.key_epoch, ..current.clone() };
    let key_envelope = node_wrap(current.clone(), keys.area.to_vec(), keys.root.to_vec())?;
    let (metadata, versions) =
        rekey_node_records(workspace_id, root, old, &keys.root, rotation.target_epoch, signing_seed)?;
    let previous_envelope = previous_root_key_wrap(previous.clone(), keys.area.to_vec(), old.to_vec())?;
    // groups-server.md 8: a member holding only the new area key must open both.
    let opens_new = Zeroizing::new(node_open(current, keys.area.to_vec(), key_envelope.clone())?);
    let opens_old =
        Zeroizing::new(previous_root_key_open(previous, keys.area.to_vec(), previous_envelope.clone())?);
    if opens_new.as_slice() != keys.root.as_slice() || opens_old.as_slice() != old {
        return Err(input(KEYS_DID_NOT_OPEN));
    }
    let (metadata_signature, metadata_rekey) = record_wire(&metadata);
    let mut rotated = json!({
        "metadataEnvelope": encode(&metadata.envelope),
        "metadataSignature": metadata_signature,
        "metadataRekey": metadata_rekey,
        "versions": versions.iter().map(|version| {
            let (signature, rekey) = record_wire(&version.record);
            let mut out = json!({
                "id": version.version_id,
                "contentKeyEnvelope": encode(&version.record.envelope),
                "signature": signature,
                "rekey": rekey,
            });
            if version.record.drop_origin {
                out["dropOrigin"] = json!(true);
            }
            out
        }).collect::<Vec<_>>(),
        "shares": [],
        "links": [],
        "unsealableLinks": [],
    });
    if metadata.drop_origin {
        rotated["metadataDropOrigin"] = json!(true);
    }
    Ok(json!({
        "workspaceId": workspace_id,
        "fromVersion": from_version,
        "toVersion": to_version,
        "targetEpoch": rotation.target_epoch,
        "root": {
            "id": root.node_id,
            "changeSeq": rotation.change_seq,
            "parentKeyEpoch": to_version,
            "keyEnvelope": encode(&key_envelope),
            "rotated": rotated,
        },
        "previousRootKeyEnvelope": encode(&previous_envelope),
        "selfGrant": self_grant,
        "documents": documents,
    }))
}

/* The account's self-grant of a new area key, as route 23 and a rotation carry it. */
pub(super) fn self_grant_wire(
    key: &[u8],
    root: &[u8],
    user_id: &str,
    group_id: &str,
    workspace_id: &str,
    key_version: u64,
    version: u64,
) -> CoreResult<Value> {
    let grant = self_grant_seal(key, root, user_id, group_id, workspace_id, key_version, version)?;
    Ok(json!({
        "version": grant.version,
        "workspaceId": grant.workspace_id,
        "keyVersion": grant.key_version,
        "workspaceKeyVersion": grant.workspace_key_version,
        "wrappingSalt": grant.wrapping_salt,
        "wrappingNonce": grant.wrapping_nonce,
        "encryptedKey": grant.encrypted_key,
    }))
}

/*
 * The rotations a call must carry, checked as the worker's stage checks them
 * before anything is signed: exactly the folders `to_rotate` names, each once,
 * each live on the committed chain.
 */
pub(super) fn check_rotations(
    chain: &AcceptedRosters,
    to_rotate: &[String],
    rotations: &[AreaRotation],
) -> CoreResult<()> {
    let mut named: Vec<&str> = rotations.iter().map(|rotation| rotation.workspace_id.as_str()).collect();
    named.sort_unstable();
    let mut wanted: Vec<&str> = to_rotate.iter().map(String::as_str).collect();
    wanted.sort_unstable();
    let mut unique = named.clone();
    unique.dedup();
    if named != wanted || unique.len() != named.len() {
        return Err(input(EVERY_FOLDER));
    }
    if to_rotate.iter().any(|workspace_id| area_write_version_of(chain, workspace_id).is_none()) {
        return Err(input(NOT_ON_LIST));
    }
    Ok(())
}

/* The keys kept in a rotating call's outbox entry: each folder's new area and root keys. */
pub(super) fn keys_json(keys: &[(String, RotationKeys)]) -> Value {
    Value::Object(
        keys.iter()
            .map(|(workspace_id, at)| {
                (workspace_id.clone(), json!({ "area": encode(&at.area), "root": encode(&at.root) }))
            })
            .collect(),
    )
}

fn keys_of(entry: &Value) -> CoreResult<Vec<(String, RotationKeys)>> {
    let Some(kept) = entry.get("rotationKeys").and_then(Value::as_object) else { return Ok(vec![]) };
    kept.iter()
        .map(|(workspace_id, at)| {
            let key = |name: &str| -> CoreResult<Zeroizing<Vec<u8>>> {
                let text = at.get(name).and_then(Value::as_str).ok_or_else(|| input(NOT_THIS_CHANGE))?;
                Ok(Zeroizing::new(decode("key", text, Some(32)).map_err(|_| input(NOT_THIS_CHANGE))?))
            };
            Ok((workspace_id.clone(), RotationKeys { area: key("area")?, root: key("root")? }))
        })
        .collect()
}

fn signed_of(wire: &Value) -> CoreResult<SignedGroupStatement> {
    let text = |value: Option<&Value>| -> CoreResult<Vec<u8>> {
        decode("statement", value.and_then(Value::as_str).ok_or_else(|| input(NOT_THIS_CHANGE))?, None)
    };
    let signature = wire.get("signature").ok_or_else(|| input(NOT_THIS_CHANGE))?;
    Ok(SignedGroupStatement {
        statement: text(wire.get("statement"))?,
        signature: crate::groups::GroupSignature {
            ed25519: text(signature.get("ed25519"))?,
            ml_dsa: text(signature.get("mlDsa"))?,
        },
        signer_signature: text(wire.get("signerSignature"))?,
    })
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl AreaLedger {
    /// Removing `user_id` from the family (route 19), the worker's `groupStage`
    /// kind `remove`: they are marked left on the next roster, every live
    /// family folder is rotated in the same call (`rotations`, one per folder
    /// [`crate::areas_to_rotate`] names, each gathered as [`AreaRotation`]
    /// says), the new keys granted to everyone who stays, and the family key
    /// replaced (a succession) when they managed it. `ends_lapsed`: the lapsed
    /// plans (ids) the person pays for that the remover confirmed end, carried
    /// on the route and in the body. Refused as [`AreaLedger::roles_body`] up
    /// to the identity, then: someone not in the family now, rotations other
    /// than exactly the live folders ([`EVERY_FOLDER`]); a folder not open here
    /// answers [`RosterCall::OpenFoldersFirst`].
    ///
    /// ```
    /// use hushos_core::*;
    /// use std::collections::HashMap;
    /// let ledger = AreaLedger::new();
    /// let me = OwnIdentities { user_id: "00000001-abcd-4abc-8abc-abcdefabcdef".into(), identities: vec![] };
    /// let identity = identity_create(me.user_id.clone(), vec![7u8; 32], 1)?;
    /// let refused = ledger
    ///     .removal_body(me, identity, "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".into(), 5,
    ///         "00000002-abcd-4abc-8abc-abcdefabcdef".into(), vec![], vec![], HashMap::new())
    ///     .unwrap_err();
    /// assert_eq!(refused.to_string(), "Unlock your account first.");
    /// # Ok::<(), hushos_core::CoreError>(())
    /// ```
    #[allow(clippy::too_many_arguments)]
    pub fn removal_body(
        &self,
        me: OwnIdentities,
        identity: IdentityEnvelope,
        group_id: String,
        expected_revision: u64,
        user_id: String,
        rotations: Vec<AreaRotation>,
        ends_lapsed: Vec<String>,
        kems: HashMap<String, String>,
    ) -> CoreResult<RosterCall> {
        let user_id = user_id.to_lowercase();
        uuid(&user_id, "user id")?;
        let caller = match self.caller(me, identity, &group_id, true)? {
            Ok(caller) => caller,
            Err(first) => return Ok(first),
        };
        self.stage(
            caller,
            &group_id,
            expected_revision,
            Change::Remove { user_id, ends_lapsed, rotations },
            kems,
        )
    }

    /// Marking the departed left (route 7), the worker's `groupStage` kind
    /// `markLeft`: what a `left-due` answer or route 3's `due.markLeft` asks,
    /// each of `user_ids` marked left and every live family folder rotated as a
    /// removal rotates them. Refused for an empty list, and as
    /// [`AreaLedger::removal_body`].
    ///
    /// ```
    /// use hushos_core::*;
    /// use std::collections::HashMap;
    /// let ledger = AreaLedger::new();
    /// let me = OwnIdentities { user_id: "00000001-abcd-4abc-8abc-abcdefabcdef".into(), identities: vec![] };
    /// let identity = identity_create(me.user_id.clone(), vec![7u8; 32], 1)?;
    /// let refused = ledger
    ///     .mark_left_body(me, identity, "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".into(), 5, vec![], vec![], HashMap::new())
    ///     .unwrap_err();
    /// assert_eq!(refused.to_string(), "Unlock your account first.");
    /// # Ok::<(), hushos_core::CoreError>(())
    /// ```
    #[allow(clippy::too_many_arguments)]
    pub fn mark_left_body(
        &self,
        me: OwnIdentities,
        identity: IdentityEnvelope,
        group_id: String,
        expected_revision: u64,
        user_ids: Vec<String>,
        rotations: Vec<AreaRotation>,
        kems: HashMap<String, String>,
    ) -> CoreResult<RosterCall> {
        let user_ids: Vec<String> = user_ids.into_iter().map(|id| id.to_lowercase()).collect();
        for id in &user_ids {
            uuid(id, "user id")?;
        }
        let caller = match self.caller(me, identity, &group_id, true)? {
            Ok(caller) => caller,
            Err(first) => return Ok(first),
        };
        if user_ids.is_empty() {
            return Err(input(NOBODY_LEFT));
        }
        self.stage(caller, &group_id, expected_revision, Change::MarkLeft { user_ids, rotations }, kems)
    }

    /// One family folder's key replacement (route 24, Replace keys), the
    /// worker's `groupStage` kind `rotate`: the next roster carries the
    /// folder's new key, granted to every member, and the call the folder's
    /// rotation. Refused as [`AreaLedger::removal_body`].
    ///
    /// ```
    /// use hushos_core::*;
    /// use std::collections::HashMap;
    /// let ledger = AreaLedger::new();
    /// let me = OwnIdentities { user_id: "00000001-abcd-4abc-8abc-abcdefabcdef".into(), identities: vec![] };
    /// let identity = identity_create(me.user_id.clone(), vec![7u8; 32], 1)?;
    /// let root = RotatingNode {
    ///     node_id: "0e0e0e0e-0000-4000-8000-000000000002".into(), parent_id: "f0f0f0f0-0000-4000-8000-00000000000f".into(),
    ///     parent_key_epoch: 2, key_epoch: 1, wrapped_parent_key_epoch: 1, key_envelope: vec![0; 72],
    ///     kind: NodeKind::Folder, metadata_version: 1, metadata_envelope: vec![0; 64],
    ///     metadata_signer: None, metadata_signature: None, metadata_rekey: None,
    ///     versions: vec![], share_ids: vec![], link_ids: vec![],
    /// };
    /// let rotation = AreaRotation {
    ///     workspace_id: "f0f0f0f0-0000-4000-8000-00000000000f".into(), target_epoch: 2, root, change_seq: 1, documents: vec![],
    /// };
    /// let refused = ledger
    ///     .area_rotation_body(me, identity, "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".into(), 5, rotation, HashMap::new())
    ///     .unwrap_err();
    /// assert_eq!(refused.to_string(), "Unlock your account first.");
    /// # Ok::<(), hushos_core::CoreError>(())
    /// ```
    pub fn area_rotation_body(
        &self,
        me: OwnIdentities,
        identity: IdentityEnvelope,
        group_id: String,
        expected_revision: u64,
        rotation: AreaRotation,
        kems: HashMap<String, String>,
    ) -> CoreResult<RosterCall> {
        uuid(&rotation.workspace_id, "workspace id")?;
        let caller = match self.caller(me, identity, &group_id, true)? {
            Ok(caller) => caller,
            Err(first) => return Ok(first),
        };
        self.stage(caller, &group_id, expected_revision, Change::Rotate { rotation }, kems)
    }

    /// A family folder's deletion (route 30), the worker's `groupStage` kind
    /// `retire`: the next roster carries the folder's tombstone (a retired row,
    /// design 2.10) and nothing else; nobody is granted it again. Refused for a
    /// folder the committed member list does not name as live ([`NOT_ON_LIST`]),
    /// and as [`AreaLedger::roles_body`].
    ///
    /// ```
    /// use hushos_core::*;
    /// use std::collections::HashMap;
    /// let ledger = AreaLedger::new();
    /// let me = OwnIdentities { user_id: "00000001-abcd-4abc-8abc-abcdefabcdef".into(), identities: vec![] };
    /// let identity = identity_create(me.user_id.clone(), vec![7u8; 32], 1)?;
    /// let refused = ledger
    ///     .area_delete_body(me, identity, "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".into(), 5,
    ///         "f0f0f0f0-0000-4000-8000-00000000000f".into(), HashMap::new())
    ///     .unwrap_err();
    /// assert_eq!(refused.to_string(), "Unlock your account first.");
    /// # Ok::<(), hushos_core::CoreError>(())
    /// ```
    pub fn area_delete_body(
        &self,
        me: OwnIdentities,
        identity: IdentityEnvelope,
        group_id: String,
        expected_revision: u64,
        workspace_id: String,
        kems: HashMap<String, String>,
    ) -> CoreResult<RosterCall> {
        uuid(&workspace_id, "workspace id")?;
        let caller = match self.caller(me, identity, &group_id, true)? {
            Ok(caller) => caller,
            Err(first) => return Ok(first),
        };
        self.stage(caller, &group_id, expected_revision, Change::Retire { workspace_id }, kems)
    }

    /// The previous-root check (route 28's repair), the worker's
    /// `groupPreviousRoot`: a family folder's root whose previous key
    /// envelope is under the area's current key is checked to open, to the
    /// key this device opened itself as the root's own at that epoch when it
    /// holds one; one that does not open is wrapped again from that key
    /// ([`PreviousRootRepair::Repair`], checked to open first), never from what
    /// a served envelope gave.
    ///
    /// ```
    /// use hushos_core::*;
    /// let ledger = AreaLedger::new();
    /// let root = PreviousRoot {
    ///     node_id: "0e0e0e0e-0000-4000-8000-000000000002".into(), parent_key_epoch: 2,
    ///     prev_key_envelope: None, prev_key_epoch: None, prev_parent_key_epoch: None,
    /// };
    /// // No committed member list: nothing is checked.
    /// let refused = ledger
    ///     .previous_root_repair("0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".into(), "f0f0f0f0-0000-4000-8000-00000000000f".into(), root)
    ///     .unwrap_err();
    /// assert_eq!(refused.to_string(), "Check the family’s member list first.");
    /// # Ok::<(), hushos_core::CoreError>(())
    /// ```
    pub fn previous_root_repair(
        &self,
        group_id: String,
        workspace_id: String,
        root: PreviousRoot,
    ) -> CoreResult<PreviousRootRepair> {
        let workspace_id = workspace_id.to_lowercase();
        uuid(&workspace_id, "workspace id")?;
        let state = self.call_state(&group_id);
        if state.chain.is_none() {
            return Err(input(NO_CHAIN));
        }
        let (version, key, _) = state
            .areas
            .iter()
            .find(|(id, _)| *id == workspace_id)
            .and_then(|(_, held)| held.clone())
            .ok_or_else(|| input(NOT_OPENED))?;
        // An empty envelope is none, as the worker's `!root.prevKeyEnvelope` reads it.
        let envelope = root.prev_key_envelope.as_ref().filter(|envelope| !envelope.is_empty());
        let (Some(envelope), Some(prev_epoch)) = (envelope, root.prev_key_epoch) else {
            return Ok(PreviousRootRepair::None);
        };
        if root.prev_parent_key_epoch != Some(version) || root.parent_key_epoch != version {
            return Ok(PreviousRootRepair::None);
        }
        let context = NodeKeyContext {
            workspace_id: workspace_id.clone(),
            node_id: root.node_id.clone(),
            parent_id: workspace_id.clone(),
            parent_key_epoch: version,
            key_epoch: prev_epoch,
        };
        let served =
            previous_root_key_open(context.clone(), key.to_vec(), envelope.clone()).ok().map(Zeroizing::new);
        // The old key this device opened itself as the root's own, before the key change: an
        // envelope that opens to anything else is no better than one that does not open.
        let old = self.own_previous_node_key(&workspace_id, &root.node_id, prev_epoch);
        if let Some(served) = &served {
            if old.as_ref().is_none_or(|old| old.as_slice() == served.as_slice()) {
                return Ok(PreviousRootRepair::Opens);
            }
        }
        let Some(old) = old else { return Ok(PreviousRootRepair::Cannot) };
        let envelope = previous_root_key_wrap(context.clone(), key.to_vec(), old.to_vec())?;
        // As a rotation's own: refused unless the current key opens it to the key wrapped.
        let back = Zeroizing::new(previous_root_key_open(context, key.to_vec(), envelope.clone())?);
        if back.as_slice() != old.as_slice() {
            return Err(input(EARLIER_DID_NOT_OPEN));
        }
        Ok(PreviousRootRepair::Repair { previous_root_key_envelope: envelope })
    }

    /// A kept rotating call's rotations built again with the same roster and
    /// keys (the worker's `groupRestage` with `rebuild`): what
    /// [`OutboxStep::Rebuild`] asks for after `rotating`, `epoch-stale`,
    /// `root-moved` or `document-stale`. `rotations` are the folders gathered
    /// again; each must be one the call rotates. The entry is opened as
    /// [`AreaLedger::outbox_open`] opens it and must still follow the
    /// committed chain; the body keeps everything but those rotations, and the
    /// returned call (same outbox id) is to be kept over the old entry before
    /// it is sent.
    pub fn outbox_rebuild(
        &self,
        me: OwnIdentities,
        identity: IdentityEnvelope,
        group_id: String,
        outbox_id: String,
        entry: String,
        rotations: Vec<AreaRotation>,
    ) -> CoreResult<StagedCall> {
        let caller = match self.caller(me, identity, &group_id, false)? {
            Ok(caller) => caller,
            Err(_) => return Err(input(NO_CHAIN)),
        };
        let Caller { me, keys, state, chain, .. } = caller;
        let account = self.served_account().ok_or_else(|| input(NO_ACCOUNT))?;
        let plaintext = open_bytes(&account.store_key, &account.user_id, &group_id, OUTBOX, &entry)?;
        let mut value: Value =
            serde_json::from_slice(&plaintext).map_err(|_| CoreError::Sealed(RECORD_UNREADABLE.into()))?;
        let reading = Reading { id: Some(&outbox_id), pin: &|_| None, head: None };
        let route = match entry_read(&value, &chain.group_id, &reading) {
            Some(OutboxCall::Send { route, .. }) => route,
            _ => return Err(CoreError::Sealed(NOT_AN_ENTRY.into())),
        };
        let mut body: Value = serde_json::from_str(
            &body_text(value.get("body").ok_or_else(|| input(NOT_THIS_CHANGE))?)
                .ok_or_else(|| input(NOT_THIS_CHANGE))?,
        )
        .map_err(|_| input(NOT_THIS_CHANGE))?;
        let signed = signed_of(body.get("roster").ok_or_else(|| input(NOT_THIS_CHANGE))?)?;
        let succession = body.get("succession").map(signed_of).transpose()?;
        let staged = stage_chain(&chain, &signed, succession.as_ref(), &me)?;
        let kept = keys_of(&value)?;
        // The body's roster must be the one these keys were made for: its rows are their keys, and
        // nothing else (the worker's row count).
        if staged.roster.areas.len() != kept.len() {
            return Err(input(NOT_THIS_CHANGE));
        }
        for (workspace_id, at) in &kept {
            let row = staged.area_keys.get(workspace_id).and_then(|rows| rows.last());
            if row != Some(&crate::groups::area_key_commitment(&at.area)?) {
                return Err(input(NOT_THIS_CHANGE));
            }
        }
        let mut replaced = vec![];
        for rotation in &rotations {
            let workspace_id = rotation.workspace_id.as_str();
            let at = kept.iter().find(|(id, _)| id == workspace_id).map(|(_, at)| at);
            let slot = if body.get("rotation").and_then(|r| r.get("workspaceId")).and_then(Value::as_str)
                == Some(workspace_id)
            {
                Some(&mut body["rotation"])
            } else {
                body.get_mut("rotations").and_then(Value::as_array_mut).and_then(|all| {
                    all.iter_mut()
                        .find(|r| r.get("workspaceId").and_then(Value::as_str) == Some(workspace_id))
                })
            };
            let (Some(at), Some(slot)) = (at, slot) else { return Err(input(NOT_ROTATED_HERE)) };
            let version = staged.area_keys.get(workspace_id).map(Vec::len).unwrap_or(0) as u64;
            let (_, from_key, _) = state
                .areas
                .iter()
                .find(|(id, _)| id == workspace_id)
                .and_then(|(_, held)| held.clone())
                .filter(|(held_version, _, _)| *held_version + 1 == version)
                .ok_or_else(|| input(NOT_OPENED))?;
            let self_grant = slot.get("selfGrant").cloned().ok_or_else(|| input(NOT_THIS_CHANGE))?;
            let old = || self.rotation_root_key(workspace_id, &rotation.root);
            *slot = rotation_wire(
                rotation,
                version - 1,
                &from_key,
                old,
                at,
                self_grant,
                &keys.signing_seed,
                &mut replaced,
            )?;
        }
        let body = body.to_string();
        value["body"] = Value::String(body.clone());
        let Some((user_id, store_key)) =
            self.call_still_holds(&group_id, state.generation, &chain.roster_digest)?
        else {
            return Err(input(NOT_FOLLOWING));
        };
        let plaintext = Zeroizing::new(value.to_string().into_bytes());
        let entry = seal_bytes(&store_key, &user_id, &chain.group_id, OUTBOX, &plaintext)?;
        Ok(StagedCall { outbox_id, route, body, entry, replaced })
    }
}
