//! Removals, key replacements and folder deletions (groups 1d, Core 5b), for
//! the shared fixtures: the twin of `packages/crypto/src/removal-calls-testkit.ts`,
//! over the family of `roster_calls.rs`. Each twin builds the same calls on
//! person 1's device (here [`AreaLedger::removal_body`], `mark_left_body`,
//! `area_rotation_body` and `area_delete_body`, there the worker's
//! `groupStage` kinds remove, markLeft, rotate and retire) with the same
//! folders gathered (each live folder's root as the server serves it: an id
//! derived from its seed, under its fixed keys, its name signed by person 1;
//! A1's tags, one named by a lone surrogate, sealed under its key, and A3's
//! junk nobody can open), with person 1's account key at version 2 and their
//! identity at 1 (a master-key rotation since), and reads the other twin's
//! bodies through its own code:
//!
//! - `removalCalls`: each body verified as every member takes it (the 5a
//!   verdict), then each folder's new key opened from its grants (the
//!   roster's commitment names it) and from it the root's new key (the
//!   roster's root commitment), the root's old key under its previous-root
//!   label, the root's name, the self-grant and the account key version it
//!   names, and every workspace document's text sealed again; the roster's
//!   area rows exactly what the call writes (one tombstone for a deletion,
//!   nothing else). A refusal must be the same sentence.
//! - `removalRoots`: the roots and documents this twin's calls were built
//!   from, which `packages/groups/src/server.test.ts` stores before it posts
//!   the bodies.
//! - `previousRoots`: route 25's served previous envelope checked by
//!   [`AreaLedger::previous_root_repair`] (the worker's `groupPreviousRoot`)
//!   on person 1's device. A repair needs an old key the device opened
//!   itself, which only a Drive rotation's commit leaves; each twin's unit
//!   tests hold that rule.
#![allow(dead_code)]

use super::device_records::root;
use super::groups::{e, pattern, s, signed_of};
use super::roster_calls::{area_key, chain_of, envelope, family, grant_key, ledger, me, root_key, verdict};
use hushos_core::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

/* The roots of A1, A2 (deleted) and A3: id seeds, key epochs, change sequences, at the area's latest listed version. */
fn root_seed(index: usize) -> String {
    e(&pattern(16, 51 + index as u8))
}
fn root_id(index: usize) -> String {
    derive_id(IdKind::Node, family().areas[index].0.clone(), root_seed(index)).unwrap()
}
const ROOT_EPOCHS: [u64; 3] = [1, 1, 2];
const CHANGE_SEQS: [u64; 3] = [4, 5, 6];
const LATEST: [u64; 3] = [1, 1, 2];
const TARGET_EPOCH: u64 = 9;
/* Person 1's account key version: rotated once, while their identity is still at 1. */
pub const ACCOUNT_KEY: u64 = 2;
/* A1's tags, one named by a lone surrogate (JSON.parse reads it, a serde_json Value cannot), as JSON.stringify writes them. */
const TAGS: &str =
    r#"{"version":2,"tags":[{"id":"t1","name":"Recipes"},{"id":"t2","name":"\ud800"}],"items":{}}"#;
const EMPTY_TAGS: &str = r#"{"version":2,"tags":[],"items":{}}"#;
/* The key epoch of a previous root key in route 25's cases, and that key. */
const PREVIOUS_EPOCH: u64 = 7;
fn previous_key() -> Vec<u8> {
    pattern(32, 77)
}

fn d(value: &Value) -> Vec<u8> {
    base64url_decode(value.as_str().expect("base64url text").into()).expect("base64url")
}

/*
 * One folder's rotation, gathered as the app gathers it for the call: the root
 * as route 25 serves it, its documents. Built once per process, so every call
 * in a document is built from the roots `removalRoots` writes.
 */
pub fn rotation_input(index: usize) -> AreaRotation {
    static GATHERED: OnceLock<Vec<AreaRotation>> = OnceLock::new();
    GATHERED.get_or_init(|| (0..3).map(gather).collect())[index].clone()
}

fn gather(index: usize) -> AreaRotation {
    let f = family();
    let p1 = &f.p[0];
    let workspace_id = f.areas[index].0.clone();
    let version = LATEST[index];
    let node_id = root_id(index);
    let key = root_key(index, version);
    let key_envelope = node_wrap(
        NodeKeyContext {
            workspace_id: workspace_id.clone(),
            node_id: node_id.clone(),
            parent_id: workspace_id.clone(),
            parent_key_epoch: version,
            key_epoch: ROOT_EPOCHS[index],
        },
        area_key(index, version),
        key.clone(),
    )
    .unwrap();
    let metadata_envelope = metadata_seal(
        MetadataContext { workspace_id: workspace_id.clone(), node_id: node_id.clone(), metadata_version: 1 },
        key,
        NodeMetadata {
            name: "Family".into(),
            mime: None,
            size: None,
            modified: None,
            attributes: Default::default(),
        },
    )
    .unwrap();
    // Its creator's signature over the name, as every family folder's root carries one.
    let statement = MetadataStatement {
        workspace_id: workspace_id.clone(),
        node_id: node_id.clone(),
        kind: NodeKind::Folder,
        metadata_version: 1,
    };
    let metadata_signature =
        metadata_sign(p1.keys.signing_seed.to_vec(), statement, metadata_envelope.clone()).unwrap();
    let documents = if index == 0 {
        let ctx = DocumentContext { workspace_id: workspace_id.clone(), kind: "tags".into(), version: 3 };
        vec![ServedDocument {
            kind: "tags".into(),
            version: 3,
            envelope: document_seal(ctx, area_key(0, 1), TAGS.into()).unwrap(),
        }]
    } else {
        vec![ServedDocument { kind: "tags".into(), version: 1, envelope: vec![7; 80] }]
    };
    AreaRotation {
        workspace_id: workspace_id.clone(),
        target_epoch: TARGET_EPOCH,
        root: RotatingNode {
            node_id,
            parent_id: workspace_id,
            parent_key_epoch: version + 1,
            key_epoch: ROOT_EPOCHS[index],
            wrapped_parent_key_epoch: version,
            key_envelope,
            kind: NodeKind::Folder,
            metadata_version: 1,
            metadata_envelope,
            metadata_signer: Some(p1.user_id.clone()),
            metadata_signature: Some(metadata_signature),
            metadata_rekey: None,
            versions: vec![],
            share_ids: vec![],
            link_ids: vec![],
        },
        change_seq: CHANGE_SEQS[index],
        documents,
    }
}

fn sorted(mut list: Vec<Value>) -> Vec<Value> {
    list.sort_by_key(|value| value.to_string());
    list
}

/* The calls, in the order both twins build them. */
pub fn removal_specs() -> Vec<Value> {
    let f = family();
    let u = |n: usize| f.p[n - 1].user_id.clone();
    let a = |index: usize| f.areas[index].0.clone();
    let left = |n: usize, roles: &[&str]| json!({ "userId": u(n), "status": "left", "roles": roles });
    let grant = |n: usize, index: usize, version: u64| json!({ "userId": u(n), "workspaceId": a(index), "version": version });
    let row = |index: usize, version: u64, retired: bool| json!({ "workspaceId": a(index), "version": version, "retired": retired });
    let rotated = |index: usize, documents: Value| {
        json!({
            "workspaceId": a(index),
            "fromVersion": LATEST[index],
            "toVersion": LATEST[index] + 1,
            "targetEpoch": TARGET_EPOCH,
            "rootId": root_id(index),
            "name": "Family",
            // The creator's signed name is kept as its origin, re-keyed, never signed again.
            "record": "rekey",
            // The account key's version, never the identity's (1).
            "selfGrantKeyVersion": ACCOUNT_KEY,
            "documents": documents,
        })
    };
    let a3 = rotated(2, json!([{ "kind": "tags", "version": 2, "text": EMPTY_TAGS }]));
    let mut both = vec![rotated(0, json!([{ "kind": "tags", "version": 4, "text": TAGS }])), a3.clone()];
    both.sort_by_key(|rotation| s(rotation, "workspaceId"));
    let all_rows = sorted(vec![row(0, 2, false), row(2, 3, false)]);
    let replaced = json!([{ "workspaceId": a(2), "kind": "tags" }]);
    let staying =
        |a: usize, b: usize| sorted(vec![grant(a, 0, 2), grant(a, 2, 3), grant(b, 0, 2), grant(b, 2, 3)]);
    vec![
        json!({ "name": "remove-member", "op": { "kind": "remove", "who": 2 }, "replaced": replaced,
            "expected": { "route": { "kind": "remove", "userId": u(2) }, "rosterVersion": 8, "groupKeyVersion": 1,
                "changed": [left(2, &[])], "keySeal": null, "seals": [], "grants": staying(1, 3),
                "areas": all_rows, "rotations": both } }),
        // A manager leaving takes the family's key with them: a succession, sealed to the rest.
        json!({ "name": "remove-manager", "op": { "kind": "remove", "who": 3 }, "replaced": replaced,
            "expected": { "route": { "kind": "remove", "userId": u(3) }, "rosterVersion": 8, "groupKeyVersion": 2,
                "changed": [left(3, &["members"])], "keySeal": null, "seals": [u(1)], "grants": staying(1, 2),
                "areas": all_rows, "rotations": both } }),
        json!({ "name": "mark-left", "op": { "kind": "markLeft", "who": [2] }, "replaced": replaced,
            "expected": { "route": { "kind": "rosters" }, "rosterVersion": 8, "groupKeyVersion": 1,
                "changed": [left(2, &[])], "keySeal": null, "seals": [], "grants": staying(1, 3),
                "areas": all_rows, "rotations": both } }),
        json!({ "name": "replace-keys", "op": { "kind": "rotate", "area": 2 }, "replaced": replaced,
            "expected": { "route": { "kind": "rotation", "workspaceId": a(2) }, "rosterVersion": 8, "groupKeyVersion": 1,
                "changed": [], "keySeal": null, "seals": [],
                "grants": sorted(vec![grant(1, 2, 3), grant(2, 2, 3), grant(3, 2, 3)]),
                "areas": [row(2, 3, false)], "rotations": [a3] } }),
        // Exactly one tombstone: no key, no grant, no rotation, no other row.
        json!({ "name": "delete-folder", "op": { "kind": "retire", "area": 0 }, "replaced": [],
            "expected": { "route": { "kind": "delete", "workspaceId": a(0) }, "rosterVersion": 8, "groupKeyVersion": 1,
                "changed": [], "keySeal": null, "seals": [], "grants": [],
                "areas": [row(0, 2, true)], "rotations": [] } }),
        json!({ "name": "refused-a-folder-left-unrotated", "op": { "kind": "remove", "who": 2, "rotate": [0] },
            "refused": EVERY_FOLDER }),
        json!({ "name": "refused-a-folder-rotated-twice", "op": { "kind": "remove", "who": 2, "rotate": [0, 2, 2] },
            "refused": EVERY_FOLDER }),
        json!({ "name": "refused-a-deleted-folder-rotated", "op": { "kind": "remove", "who": 2, "rotate": [0, 1, 2] },
            "refused": EVERY_FOLDER }),
        json!({ "name": "refused-replace-a-deleted-folder", "op": { "kind": "rotate", "area": 1 },
            "refused": NOT_ON_LIST }),
        json!({ "name": "refused-delete-a-deleted-folder", "op": { "kind": "retire", "area": 1 },
            "refused": NOT_ON_LIST }),
        json!({ "name": "refused-remove-someone-not-in", "op": { "kind": "remove", "who": 4 },
            "refused": "This person is not in the family now." }),
        json!({ "name": "refused-folders-not-opened", "op": { "kind": "remove", "who": 2, "noArea": true },
            "refused": "Open every family folder first." }),
    ]
}

fn route_of(op: &Value) -> Value {
    let f = family();
    match op["kind"].as_str().unwrap() {
        "remove" => {
            json!({ "kind": "remove", "userId": f.p[op["who"].as_u64().unwrap() as usize - 1].user_id })
        }
        "markLeft" => json!({ "kind": "rosters" }),
        "rotate" => {
            json!({ "kind": "rotation", "workspaceId": f.areas[op["area"].as_u64().unwrap() as usize].0 })
        }
        "retire" => {
            json!({ "kind": "delete", "workspaceId": f.areas[op["area"].as_u64().unwrap() as usize].0 })
        }
        other => panic!("{other}"),
    }
}

/* One call through this core on person 1's device: the staged call, or the refusal's sentence. */
pub fn removal_run(op: &Value) -> Result<StagedCall, String> {
    let f = family();
    let ledger: Arc<AreaLedger> = ledger(true, op["noArea"] != json!(true));
    let kems: HashMap<String, String> =
        f.p.iter().map(|p| (p.user_id.clone(), p.served.kem_public_key.clone())).collect();
    let user = |n: &Value| f.p[n.as_u64().unwrap() as usize - 1].user_id.clone();
    let rotations = || -> Vec<AreaRotation> {
        match op.get("rotate").and_then(Value::as_array) {
            Some(list) => list.iter().map(|index| rotation_input(index.as_u64().unwrap() as usize)).collect(),
            None => vec![rotation_input(0), rotation_input(2)],
        }
    };
    let group = f.group_id.clone();
    let result = match op["kind"].as_str().unwrap() {
        "remove" => ledger.removal_body(
            me(1),
            envelope(1),
            group,
            7,
            user(&op["who"]),
            rotations(),
            vec![],
            ACCOUNT_KEY,
            kems,
        ),
        "markLeft" => {
            let ids = op["who"].as_array().unwrap().iter().map(user).collect();
            ledger.mark_left_body(me(1), envelope(1), group, 7, ids, rotations(), ACCOUNT_KEY, kems)
        }
        "rotate" => ledger.area_rotation_body(
            me(1),
            envelope(1),
            group,
            7,
            rotation_input(op["area"].as_u64().unwrap() as usize),
            ACCOUNT_KEY,
            kems,
        ),
        "retire" => ledger.area_delete_body(
            me(1),
            envelope(1),
            group,
            7,
            f.areas[op["area"].as_u64().unwrap() as usize].0.clone(),
            kems,
        ),
        other => panic!("{other}"),
    };
    match result {
        Ok(RosterCall::Staged { call }) => Ok(call),
        Ok(RosterCall::OpenKeyFirst) => Err("Open the family’s key first.".into()),
        Ok(RosterCall::OpenFoldersFirst) => Err("Open every family folder first.".into()),
        Ok(RosterCall::SyncFirst) => Err("Check the family’s member list first.".into()),
        Err(error) => Err(error.to_string()),
    }
}

/* What a record carries after the rotation: an origin kept, a signature, or neither. */
fn record_of(rotated: &Value) -> &'static str {
    if !rotated["metadataRekey"].is_null() {
        "rekey"
    } else if !rotated["metadataSignature"].is_null() {
        "signed"
    } else {
        "none"
    }
}

/*
 * A body as every member takes it (the 5a verdict), and what the call's
 * folders open to from their new keys: the verdict both twins declare.
 */
pub fn removal_verdict(doc: &Value, route: &Value, body: &Value) -> Value {
    let f = family();
    let mut said = verdict(doc, route, body);
    let group_id = s(&doc["family"], "groupId");
    let first = &doc["family"]["firstKeys"];
    let first_keys = GroupPublicKey {
        ed25519_public_key: s(first, "ed25519PublicKey"),
        ml_dsa_public_key: s(first, "mlDsaPublicKey"),
    };
    let mut rosters: Vec<SignedGroupStatement> =
        doc["family"]["rosters"].as_array().unwrap().iter().map(signed_of).collect();
    let roster = signed_of(&body["roster"]);
    rosters.push(roster.clone());
    let successions: Vec<SignedGroupStatement> = body.get("succession").map(signed_of).into_iter().collect();
    let after = chain_of(first_keys, &group_id, rosters, successions);
    let rows = roster_parse(roster.statement).unwrap().areas;
    let areas = sorted(
        rows.iter()
            .map(|row| json!({ "workspaceId": row.workspace_id, "version": row.workspace_key_version, "retired": row.retired }))
            .collect(),
    );
    // Every grantee of a folder's new key opens the same key: the one the roster commits to.
    let mut keys: HashMap<String, Vec<u8>> = HashMap::new();
    for grant in body["grants"].as_array().into_iter().flatten() {
        let key = grant_key(doc, &after, grant, &f.p[0]);
        let slot = format!("{}:{}", s(grant, "workspaceId"), grant["workspaceKeyVersion"]);
        if let Some(known) = keys.get(&slot) {
            assert_eq!(known, &key, "two grantees of one folder's key opened different keys");
        }
        keys.insert(slot, key);
    }
    let wires: Vec<&Value> = match body.get("rotation") {
        Some(one) => vec![one],
        None => body["rotations"].as_array().map(|list| list.iter().collect()).unwrap_or_default(),
    };
    let mut rotations = vec![];
    for wire in wires {
        let workspace_id = s(wire, "workspaceId");
        let index = f.areas.iter().position(|(id, _)| *id == workspace_id).expect("a folder the family had");
        let from_version = wire["fromVersion"].as_u64().unwrap();
        let to_version = wire["toVersion"].as_u64().unwrap();
        let target = wire["targetEpoch"].as_u64().unwrap();
        let node_id = s(&wire["root"], "id");
        let area = keys
            .get(&format!("{workspace_id}:{to_version}"))
            .expect("a rotated folder's new key granted")
            .clone();
        let row = rows
            .iter()
            .find(|row| {
                row.workspace_id == workspace_id && row.workspace_key_version == to_version && !row.retired
            })
            .expect("a rotation the roster lists");
        let current = NodeKeyContext {
            workspace_id: workspace_id.clone(),
            node_id: node_id.clone(),
            parent_id: workspace_id.clone(),
            parent_key_epoch: to_version,
            key_epoch: target,
        };
        let new_root = node_open(current.clone(), area.clone(), d(&wire["root"]["keyEnvelope"]))
            .expect("the new root key");
        assert_eq!(
            Some(area_root_commitment(&new_root).unwrap()),
            row.root_commitment,
            "the root's new key is the one the roster commits to"
        );
        let old = previous_root_key_open(
            NodeKeyContext { key_epoch: ROOT_EPOCHS[index], ..current },
            area.clone(),
            d(&wire["previousRootKeyEnvelope"]),
        )
        .expect("the previous root key");
        assert_eq!(old, root_key(index, from_version), "the previous root key is the root's old key");
        let name = metadata_open(
            MetadataContext {
                workspace_id: workspace_id.clone(),
                node_id: node_id.clone(),
                metadata_version: 1,
            },
            new_root,
            d(&wire["root"]["rotated"]["metadataEnvelope"]),
        )
        .expect("the root's name")
        .name;
        let grant = &wire["selfGrant"];
        let self_grant = WorkspaceGrant {
            version: grant["version"].as_u64().unwrap() as u32,
            workspace_id: s(grant, "workspaceId"),
            key_version: grant["keyVersion"].as_u64().unwrap(),
            workspace_key_version: grant["workspaceKeyVersion"].as_u64().unwrap(),
            wrapping_salt: s(grant, "wrappingSalt"),
            wrapping_nonce: s(grant, "wrappingNonce"),
            encrypted_key: s(grant, "encryptedKey"),
        };
        let own =
            area_self_grant_open(&root(), &f.p[0].user_id, &group_id, &self_grant).expect("the self-grant");
        assert!(
            own == area && self_grant.workspace_key_version == to_version,
            "the self-grant is of the folder's new key"
        );
        let documents: Vec<Value> = wire["documents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|document| {
                let version = document["version"].as_u64().unwrap() + 1;
                let kind = s(document, "kind");
                let ctx = DocumentContext { workspace_id: workspace_id.clone(), kind: kind.clone(), version };
                let text = document_open(ctx, area.clone(), d(&document["envelope"])).expect("the document");
                // The text as sealed: the core seals what it read, the worker what JSON.stringify writes.
                json!({ "kind": kind, "version": version, "text": text })
            })
            .collect();
        rotations.push(json!({
            "workspaceId": workspace_id,
            "fromVersion": from_version,
            "toVersion": to_version,
            "targetEpoch": target,
            "rootId": node_id,
            "name": name,
            "record": record_of(&wire["root"]["rotated"]),
            "selfGrantKeyVersion": self_grant.key_version,
            "documents": documents,
        }));
    }
    rotations.sort_by_key(|rotation| s(rotation, "workspaceId"));
    said["areas"] = Value::Array(areas);
    said["rotations"] = Value::Array(rotations);
    said
}

pub fn replaced_json(replaced: &[ReplacedDocument]) -> Value {
    Value::Array(
        replaced.iter().map(|at| json!({ "workspaceId": at.workspace_id, "kind": at.kind })).collect(),
    )
}

/* Route 25's previous envelopes on person 1's device, in the order both twins build them. */
pub fn previous_root_specs() -> Vec<Value> {
    vec![
        json!({ "name": "no-envelope", "area": 0, "envelope": "none", "expected": { "status": "none" } }),
        json!({ "name": "under-another-version", "area": 0, "envelope": "previous", "prevParentKeyEpoch": 2,
            "expected": { "status": "none" } }),
        json!({ "name": "opens", "area": 0, "envelope": "previous", "expected": { "status": "opens" } }),
        // The root's key under the plain node label opens as no previous key.
        json!({ "name": "a-plain-node-key", "area": 0, "envelope": "node", "expected": { "status": "cannot" } }),
        json!({ "name": "junk", "area": 2, "envelope": "junk", "expected": { "status": "cannot" } }),
        json!({ "name": "a-deleted-folder", "area": 1, "envelope": "previous",
            "expected": { "status": "refused", "message": "Open every family folder first." } }),
    ]
}

/* A spec's served envelope, as this twin seals it (None for none). */
pub fn previous_envelope(spec: &Value) -> Option<Vec<u8>> {
    let f = family();
    let index = spec["area"].as_u64().unwrap() as usize;
    let workspace_id = f.areas[index].0.clone();
    let version = LATEST[index];
    let ctx = NodeKeyContext {
        workspace_id: workspace_id.clone(),
        node_id: root_id(index),
        parent_id: workspace_id,
        parent_key_epoch: version,
        key_epoch: PREVIOUS_EPOCH,
    };
    match spec["envelope"].as_str().unwrap() {
        "none" => None,
        "previous" => Some(previous_root_key_wrap(ctx, area_key(index, version), previous_key()).unwrap()),
        "node" => Some(node_wrap(ctx, area_key(index, version), previous_key()).unwrap()),
        "junk" => Some(vec![9; 72]),
        other => panic!("{other}"),
    }
}

/* A served envelope checked by previous_root_repair on person 1's device: its outcome. */
pub fn previous_root_run(spec: &Value, served: Option<Vec<u8>>) -> Value {
    let f = family();
    let index = spec["area"].as_u64().unwrap() as usize;
    let version = LATEST[index];
    let ledger = ledger(true, true);
    let answer = ledger.previous_root_repair(
        f.group_id.clone(),
        f.areas[index].0.clone(),
        PreviousRoot {
            node_id: root_id(index),
            parent_key_epoch: version,
            prev_key_envelope: served,
            prev_key_epoch: Some(PREVIOUS_EPOCH),
            prev_parent_key_epoch: Some(spec["prevParentKeyEpoch"].as_u64().unwrap_or(version)),
        },
    );
    match answer {
        Ok(PreviousRootRepair::None) => json!({ "status": "none" }),
        Ok(PreviousRootRepair::Opens) => json!({ "status": "opens" }),
        Ok(PreviousRootRepair::Repair { .. }) => json!({ "status": "repair" }),
        Ok(PreviousRootRepair::Cannot) => json!({ "status": "cannot" }),
        Err(error) => json!({ "status": "refused", "message": error.to_string() }),
    }
}

/* The live folders' roots and documents as this twin's calls gathered them: what the server stores first. */
pub fn removal_roots() -> Value {
    Value::Array(
        [0, 2]
            .into_iter()
            .map(|index| {
                let AreaRotation { workspace_id, target_epoch, root, change_seq, documents } =
                    rotation_input(index);
                json!({
                    "workspaceId": workspace_id,
                    "id": root.node_id,
                    "idSeed": root_seed(index),
                    "keyEpoch": root.key_epoch,
                    "parentKeyEpoch": root.wrapped_parent_key_epoch,
                    "changeSeq": change_seq,
                    "keyEnvelope": e(&root.key_envelope),
                    "metadataEnvelope": e(&root.metadata_envelope),
                    "metadataSignature": root.metadata_signature.as_ref().map(|s| e(s)),
                    "targetEpoch": target_epoch,
                    "documents": documents.iter().map(|at| json!({
                        "kind": at.kind, "version": at.version, "envelope": e(&at.envelope),
                    })).collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

/* This core's Core 5b sections over `doc`'s family, each case checked against its declaration. */
pub fn fixture(doc: &Value) -> Value {
    let mut calls = vec![];
    for spec in removal_specs() {
        let name = s(&spec, "name");
        let mut out = spec.clone();
        match removal_run(&spec["op"]) {
            Ok(call) => {
                assert!(spec["refused"].is_null(), "{name}: built");
                assert_eq!(replaced_json(&call.replaced), spec["replaced"], "{name}: replaced");
                let body: Value = serde_json::from_str(&call.body).unwrap();
                let route = super::roster_calls::route_json(&call.route);
                assert_eq!(route, route_of(&spec["op"]), "{name}: route");
                assert_eq!(removal_verdict(doc, &route, &body), spec["expected"], "{name}");
                out["body"] = body;
            }
            Err(message) => {
                assert_eq!(Some(message.as_str()), spec["refused"].as_str(), "{name}: refusal");
                out["body"] = Value::Null;
            }
        }
        calls.push(out);
    }
    let mut roots = vec![];
    for mut spec in previous_root_specs() {
        let served = previous_envelope(&spec);
        assert_eq!(previous_root_run(&spec, served.clone()), spec["expected"], "{}", spec["name"]);
        spec["served"] = served.map(|bytes| json!(e(&bytes))).unwrap_or(Value::Null);
        roots.push(spec);
    }
    json!({ "removalCalls": calls, "previousRoots": roots, "removalRoots": removal_roots() })
}

/* The other twin's Core 5b sections through this core: every outcome the same. */
pub fn check(doc: &Value) {
    let specs = removal_specs();
    let names: Vec<String> = specs.iter().map(|spec| s(spec, "name")).collect();
    let theirs: Vec<String> = doc["removalCalls"].as_array().unwrap().iter().map(|c| s(c, "name")).collect();
    assert_eq!(names, theirs, "the same removal calls in the same order");
    for call in doc["removalCalls"].as_array().unwrap() {
        let spec = specs.iter().find(|spec| spec["name"] == call["name"]).unwrap();
        if call["body"].is_null() {
            assert_eq!(call["refused"], spec["refused"], "{}: another refusal", call["name"]);
            assert_eq!(
                removal_run(&spec["op"]).err().as_deref(),
                spec["refused"].as_str(),
                "{}",
                call["name"]
            );
            continue;
        }
        assert_eq!(call["expected"], spec["expected"], "{}: declared otherwise", call["name"]);
        assert_eq!(
            removal_verdict(doc, &call["expected"]["route"], &call["body"]),
            spec["expected"],
            "{}",
            call["name"]
        );
    }
    let root_specs = previous_root_specs();
    let names: Vec<String> = root_specs.iter().map(|spec| s(spec, "name")).collect();
    let theirs: Vec<String> = doc["previousRoots"].as_array().unwrap().iter().map(|c| s(c, "name")).collect();
    assert_eq!(names, theirs, "the same previous roots in the same order");
    for at in doc["previousRoots"].as_array().unwrap() {
        let spec = root_specs.iter().find(|spec| spec["name"] == at["name"]).unwrap();
        let served = at["served"].as_str().map(|text| base64url_decode(text.into()).unwrap());
        assert_eq!(previous_root_run(spec, served), spec["expected"], "{}", spec["name"]);
    }
}
