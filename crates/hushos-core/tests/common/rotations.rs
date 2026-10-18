//! A family folder's walk, node by node, the twin of
//! `packages/crypto/src/rotation-testkit.ts`: both build the same cases in the
//! same order from the same keys (the shared people of `groups.rs`, the named
//! keys of the area-ledger scenarios), walk each case's nodes in order with
//! their own walk (here [`AreaLedger::rotate_node`]), and read the other
//! twin's walked nodes with their own verdicts (here
//! [`AreaLedger::record_verdict`]) on a fresh member's ledger. Both declare
//! each case's verdicts, which records are re-keyed, re-sealed or dropped,
//! what may be written after the walk, and this core's one refusal the web
//! does not make (a node with shares or links in a family folder, which the
//! web re-seals). Used by `tests/area_ledger_fixtures.rs` and
//! `examples/area_ledger_fixtures.rs`.
//!
//! The family: person 1 manages it, 2 writes, 3 was removed at roster 2 (the
//! area's key version 2), 4 reads. AREA's top level is ROOT, with root:1
//! before the removal and root:2 after (option A's previous key under area:2).
#![allow(dead_code)]

use super::groups::{
    accepted_of, area_key_at, e, key_row_at, pattern, person, root_key_at, History, Person, AREA, AREA_SEED,
    GROUP,
};
use hushos_core::*;
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};

pub const ROOT: &str = "0e0e0e0e-0000-4000-8000-000000000001";
pub const FILE: &str = "0e0e0e0e-0000-4000-8000-000000000002";
pub const FOLDER: &str = "0e0e0e0e-0000-4000-8000-000000000003";
pub const CHILD_A: &str = "0e0e0e0e-0000-4000-8000-000000000004";
pub const CHILD_B: &str = "0e0e0e0e-0000-4000-8000-000000000005";
pub const STALE: &str = "0e0e0e0e-0000-4000-8000-000000000006";
const SHARE: &str = "5a5a5a5a-0000-4000-8000-000000000001";
const LINK: &str = "1e1e1e1e-0000-4000-8000-000000000001";

fn version_id(n: u32) -> String {
    format!("5e5e5e5e-0000-4000-8000-{n:012x}")
}
fn object_id(n: u32) -> String {
    format!("0b0b0b0b-0000-4000-8000-{n:012x}")
}
/* The scenarios' named keys: k:n is pattern(32, 200 + n). */
fn key(n: u8) -> Vec<u8> {
    pattern(32, 200 + n)
}
fn d(value: &Value) -> Vec<u8> {
    let text = value.as_str().expect("base64url");
    if text.is_empty() {
        return vec![];
    }
    base64url_decode(text.into()).expect("base64url")
}
fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

pub struct Family {
    pub people: Vec<Person>,
    pub chain: Arc<AcceptedRosters>,
}

/// The family's chain: roster 1 with everyone at area version 1, roster 2 removing person 3 at version 2.
pub fn family() -> &'static Family {
    static FAMILY: OnceLock<Family> = OnceLock::new();
    FAMILY.get_or_init(|| {
        let people: Vec<Person> = (1..=4).map(person).collect();
        let everyone = |removed: bool| {
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
        let mut h = History { format: 2, ..History::new() };
        h.roster_with(&people[0], everyone(false), None, Some(vec![key_row_at(AREA, 1)]));
        h.roster_with(&people[0], everyone(true), None, Some(vec![key_row_at(AREA, 2)]));
        let refs: Vec<&Person> = people.iter().collect();
        let chain = accepted_of(&h, &refs);
        Family { people, chain }
    })
}

fn node_ctx(node_id: &str, parent_id: &str, parent_key_epoch: u64, key_epoch: u64) -> NodeKeyContext {
    NodeKeyContext {
        workspace_id: AREA.into(),
        node_id: node_id.into(),
        parent_id: parent_id.into(),
        parent_key_epoch,
        key_epoch,
    }
}

/* Person `account`'s ledger: their account opened, the chain committed, the area opened at version 2, its top level listed. */
fn member_ledger(account: usize) -> Arc<AreaLedger> {
    let ledger = AreaLedger::new();
    let person = &family().people[account - 1];
    ledger
        .open_account(
            person.user_id.clone(),
            base64url_decode(person.served.signing_public_key.clone()).unwrap(),
            vec![9u8; 32],
        )
        .unwrap();
    ledger.commit(Arc::clone(&family().chain)).unwrap();
    ledger.open_area(GROUP.into(), AREA.into(), AREA_SEED.into(), 2, area_key_at(AREA, 2), 2).unwrap();
    ledger
        .open_listed_node(
            AREA.into(),
            ServedNodeKey {
                node_id: ROOT.into(),
                parent_id: AREA.into(),
                parent_key_epoch: 2,
                key_epoch: 2,
                key_envelope: node_wrap(
                    node_ctx(ROOT, AREA, 2, 2),
                    area_key_at(AREA, 2),
                    root_key_at(AREA, 2),
                )
                .unwrap(),
                prev_key_envelope: Some(
                    previous_root_key_wrap(
                        node_ctx(ROOT, AREA, 2, 1),
                        area_key_at(AREA, 2),
                        root_key_at(AREA, 1),
                    )
                    .unwrap(),
                ),
                prev_key_epoch: Some(1),
                prev_parent_key_epoch: Some(2),
            },
        )
        .unwrap();
    ledger
}

fn kind_name(kind: NodeKind) -> &'static str {
    match kind {
        NodeKind::File => "file",
        NodeKind::Folder => "folder",
    }
}
fn metadata_statement(node_id: &str, kind: NodeKind) -> MetadataStatement {
    MetadataStatement { workspace_id: AREA.into(), node_id: node_id.into(), kind, metadata_version: 1 }
}
fn version_statement(node_id: &str, n: u32) -> VersionStatement {
    VersionStatement {
        workspace_id: AREA.into(),
        node_id: node_id.into(),
        version_id: version_id(n),
        object_id: object_id(n),
        content_suite: 3,
    }
}
fn version_ctx(node_id: &str, n: u32) -> VersionContext {
    VersionContext {
        workspace_id: AREA.into(),
        node_id: node_id.into(),
        version_id: version_id(n),
        object_id: object_id(n),
    }
}

/* Version `n` of `node_id` sealed under `under` (content key filled with n), signed by `by` when given. */
fn version_by(node_id: &str, n: u32, under: &[u8], by: Option<&Person>) -> RotatingVersion {
    let envelope =
        version_seal(version_ctx(node_id, n), under.to_vec(), vec![n as u8; 32], 100 * n as u64, 0)
            .unwrap()
            .envelope;
    RotatingVersion {
        version_id: version_id(n),
        object_id: object_id(n),
        content_suite: 3,
        envelope: envelope.clone(),
        signer: by.map(|p| p.user_id.clone()),
        signature: by.map(|p| {
            version_sign(p.keys.signing_seed.to_vec(), version_statement(node_id, n), envelope).unwrap()
        }),
        rekey: None,
    }
}

/*
 * Version `n` of `node_id` as an earlier walk from epoch 1 (key `first`) to 2 (key `now`) left
 * it: written by `writer` under `first`, re-keyed raw under `now`, attested by `rekeyer` at epoch 2.
 */
fn version_rekeyed(
    node_id: &str,
    n: u32,
    first: &[u8],
    now: &[u8],
    writer: &Person,
    rekeyer: &Person,
) -> RotatingVersion {
    version_rekeyed_wrapped(node_id, n, first, now, writer, rekeyer, 2, n)
}

/*
 * The same, its origin key wrapped (and attested) at `wrap_epoch` for version `wrap_version`: a
 * dishonest earlier walker's wrap, at another epoch or for another version than the record's.
 */
#[allow(clippy::too_many_arguments)]
fn version_rekeyed_wrapped(
    node_id: &str,
    n: u32,
    first: &[u8],
    now: &[u8],
    writer: &Person,
    rekeyer: &Person,
    wrap_epoch: u64,
    wrap_version: u32,
) -> RotatingVersion {
    let written = version_by(node_id, n, first, Some(writer));
    let origin = written.envelope.clone();
    let envelope =
        version_rekey(version_ctx(node_id, n), 3, first.to_vec(), now.to_vec(), origin.clone()).unwrap();
    let key_envelope = origin_key_wrap(
        OriginKeyContext {
            workspace_id: AREA.into(),
            node_id: node_id.into(),
            key_epoch: wrap_epoch,
            record: OriginRecord::Version { version_id: version_id(wrap_version) },
            origin_envelope: origin.clone(),
        },
        now.to_vec(),
        origin_opening_key(origin.clone(), first.to_vec()).unwrap(),
    )
    .unwrap();
    let named = RecordOrigin {
        envelope: origin.clone(),
        signer_id: writer.user_id.clone(),
        signature: written.signature.clone().unwrap(),
        key_envelope: key_envelope.clone(),
    };
    let signature = version_rekey_sign(
        rekeyer.keys.signing_seed.to_vec(),
        version_statement(node_id, n),
        2,
        envelope.clone(),
        named,
    )
    .unwrap();
    RotatingVersion {
        envelope,
        signer: Some(rekeyer.user_id.clone()),
        signature: None,
        rekey: Some(ServedRekey {
            origin: ServedOrigin {
                envelope: origin,
                signer_id: Some(writer.user_id.clone()),
                signature: written.signature.clone(),
                key_envelope,
            },
            signature,
        }),
        ..written
    }
}

/* A node: its key `node_key` at `key_epoch`, wrapped under `parent_key` at `wrapped`, named by `by`. */
struct NodeSpec<'a> {
    id: &'a str,
    kind: NodeKind,
    parent_id: &'a str,
    parent_key: Vec<u8>,
    wrapped: u64,
    /* The parent epoch the walk wraps the fresh key under. */
    parent_key_epoch: u64,
    node_key: Vec<u8>,
    key_epoch: u64,
    by: Option<&'a Person>,
    versions: Vec<RotatingVersion>,
}

fn make_node(o: NodeSpec) -> RotatingNode {
    let name = if o.kind == NodeKind::Folder { "Plans" } else { "plan.txt" };
    let envelope = metadata_seal(
        MetadataContext { workspace_id: AREA.into(), node_id: o.id.into(), metadata_version: 1 },
        o.node_key.clone(),
        NodeMetadata { name: name.into(), mime: None, size: None, modified: None },
    )
    .unwrap();
    RotatingNode {
        node_id: o.id.into(),
        parent_id: o.parent_id.into(),
        parent_key_epoch: o.parent_key_epoch,
        key_epoch: o.key_epoch,
        wrapped_parent_key_epoch: o.wrapped,
        key_envelope: node_wrap(
            node_ctx(o.id, o.parent_id, o.wrapped, o.key_epoch),
            o.parent_key,
            o.node_key,
        )
        .unwrap(),
        kind: o.kind,
        metadata_version: 1,
        metadata_envelope: envelope.clone(),
        metadata_signer: o.by.map(|p| p.user_id.clone()),
        metadata_signature: o.by.map(|p| {
            metadata_sign(p.keys.signing_seed.to_vec(), metadata_statement(o.id, o.kind), envelope).unwrap()
        }),
        metadata_rekey: None,
        versions: o.versions,
        share_ids: vec![],
        link_ids: vec![],
    }
}

/* The file at `key_epoch` (key `node_key`) under the top level's key at `parent_epoch`, named by `by`. */
fn file_node(
    node_key: &[u8],
    key_epoch: u64,
    parent_epoch: u64,
    by: Option<&Person>,
    versions: Vec<RotatingVersion>,
) -> RotatingNode {
    make_node(NodeSpec {
        id: FILE,
        kind: NodeKind::File,
        parent_id: ROOT,
        parent_key: root_key_at(AREA, parent_epoch),
        wrapped: parent_epoch,
        parent_key_epoch: 2,
        node_key: node_key.to_vec(),
        key_epoch,
        by,
        versions,
    })
}

/*
 * The node with its metadata as an earlier walk from epoch 1 (key `first`) to 2 (key `now`) left
 * it: named by `writer` under `first`, re-keyed raw under `now`, attested by `rekeyer` at epoch 2.
 */
fn with_metadata_rekeyed(
    node: RotatingNode,
    first: &[u8],
    now: &[u8],
    writer: &Person,
    rekeyer: &Person,
) -> RotatingNode {
    let ctx =
        MetadataContext { workspace_id: AREA.into(), node_id: node.node_id.clone(), metadata_version: 1 };
    let statement = metadata_statement(&node.node_id, node.kind);
    let origin = metadata_seal(
        ctx.clone(),
        first.to_vec(),
        NodeMetadata { name: "plan.txt".into(), mime: None, size: None, modified: None },
    )
    .unwrap();
    let signature =
        metadata_sign(writer.keys.signing_seed.to_vec(), statement.clone(), origin.clone()).unwrap();
    let envelope = metadata_rekey(ctx, first.to_vec(), now.to_vec(), origin.clone()).unwrap();
    let key_envelope = origin_key_wrap(
        OriginKeyContext {
            workspace_id: AREA.into(),
            node_id: node.node_id.clone(),
            key_epoch: 2,
            record: OriginRecord::Metadata { metadata_version: 1 },
            origin_envelope: origin.clone(),
        },
        now.to_vec(),
        origin_opening_key(origin.clone(), first.to_vec()).unwrap(),
    )
    .unwrap();
    let named = RecordOrigin {
        envelope: origin.clone(),
        signer_id: writer.user_id.clone(),
        signature: signature.clone(),
        key_envelope: key_envelope.clone(),
    };
    let rekey_signature =
        metadata_rekey_sign(rekeyer.keys.signing_seed.to_vec(), statement, 2, envelope.clone(), named)
            .unwrap();
    RotatingNode {
        metadata_envelope: envelope,
        metadata_signer: Some(rekeyer.user_id.clone()),
        metadata_signature: None,
        metadata_rekey: Some(ServedRekey {
            origin: ServedOrigin {
                envelope: origin,
                signer_id: Some(writer.user_id.clone()),
                signature: Some(signature),
                key_envelope,
            },
            signature: rekey_signature,
        }),
        ..node
    }
}

/// A child listed after the walk, written under its folder's old key: what a removed member could plant.
pub struct StaleChild {
    pub id: &'static str,
    pub parent_id: &'static str,
    pub parent_key_epoch: u64,
    pub key_epoch: u64,
    pub key_envelope: Vec<u8>,
}

/// A case as both twins declare it: the nodes walked in order, who walks and reads, what each
/// node's records are and read as (per node, metadata first), or this core's refusal (its exact
/// message) with what the web re-seals instead; and, after the walk, whether the first child
/// walked is writable and a stale child (and anything under it) is not.
pub struct Case {
    pub name: &'static str,
    pub walker: usize,
    pub reader: usize,
    pub target: u64,
    pub nodes: Vec<RotatingNode>,
    pub shapes: Vec<Vec<&'static str>>,
    /* For a node only re-wrapped: the named key it holds. */
    pub key: Option<&'static str>,
    pub refused: Option<&'static str>,
    pub stale: Option<StaleChild>,
    pub writes: Option<Value>,
    pub expected: Vec<Vec<Value>>,
}

fn side(integrity: &str, via: bool) -> Value {
    json!({ "integrity": integrity, "via": if via { Some(GROUP) } else { None } })
}
fn rekeyed_verdict(origin: Value, rekeyer: Value, bound: Option<bool>) -> Value {
    json!({ "kind": "rekeyed", "origin": origin, "rekeyer": rekeyer, "bound": bound })
}
fn signed_verdict(integrity: &str) -> Value {
    json!({ "kind": "signed", "integrity": integrity, "via": null })
}

/// The shared cases, in the order `rotation-testkit.ts` builds them.
pub fn rotation_cases() -> Vec<Case> {
    let p = &family().people;
    let mut unbound = version_rekeyed(FILE, 4, &key(0), &key(1), &p[1], &p[0]);
    // Its current bytes are not its origin's: an earlier walker sealed something else.
    unbound.envelope = version_seal(version_ctx(FILE, 4), key(1), vec![9; 32], 1, 0).unwrap().envelope;
    let mut gone = version_rekeyed(FILE, 3, &key(0), &key(1), &p[1], &p[0]);
    gone.rekey.as_mut().unwrap().origin.signer_id = None;
    // A version whose writer's account is gone: the signature stays, the signer is served as nobody.
    let mut writer_gone = version_by(FILE, 23, &key(2), Some(&p[1]));
    writer_gone.signer = None;
    // Origins an earlier walker wrapped at another epoch, or for another version, and one naming its
    // writer with no signature.
    let other_epoch = version_rekeyed_wrapped(FILE, 31, &key(0), &key(1), &p[1], &p[0], 3, 31);
    let other_version = version_rekeyed_wrapped(FILE, 32, &key(0), &key(1), &p[1], &p[0], 2, 33);
    let mut no_signature = version_rekeyed(FILE, 34, &key(0), &key(1), &p[1], &p[0]);
    no_signature.rekey.as_mut().unwrap().origin.signature = None;
    // Named as person 2's, signed by person 3: a planted signer.
    let mut planted = version_by(FILE, 41, &key(1), Some(&p[2]));
    planted.signer = Some(p[1].user_id.clone());
    let folder = make_node(NodeSpec {
        id: FOLDER,
        kind: NodeKind::Folder,
        parent_id: ROOT,
        parent_key: root_key_at(AREA, 1),
        wrapped: 1,
        parent_key_epoch: 2,
        node_key: key(2),
        key_epoch: 1,
        by: Some(&p[1]),
        versions: vec![],
    });
    // The folder's children: wrapped under its key at epoch 1 now, under its walk's pending key next.
    let child = |id: &'static str, node_key: Vec<u8>, by: &Person, versions: Vec<RotatingVersion>| {
        make_node(NodeSpec {
            id,
            kind: NodeKind::File,
            parent_id: FOLDER,
            parent_key: key(2),
            wrapped: 1,
            parent_key_epoch: 2,
            node_key,
            key_epoch: 1,
            by: Some(by),
            versions,
        })
    };
    let shared =
        RotatingNode { share_ids: vec![SHARE.into()], ..file_node(&key(1), 1, 1, Some(&p[1]), vec![]) };
    let linked =
        RotatingNode { link_ids: vec![LINK.into()], ..file_node(&key(1), 1, 1, Some(&p[1]), vec![]) };
    let case = |name, nodes, shapes, expected| Case {
        name,
        walker: 1,
        reader: 4,
        target: 2,
        nodes,
        shapes,
        key: None,
        refused: None,
        stale: None,
        writes: None,
        expected,
    };
    let verified = || rekeyed_verdict(side("verified", true), side("verified", true), Some(true));
    vec![
        case(
            "a removal walk keeps every writer record",
            vec![file_node(&key(1), 1, 1, Some(&p[2]), vec![version_by(FILE, 1, &key(1), Some(&p[1]))])],
            vec![vec!["rekeyed", "rekeyed"]],
            vec![vec![
                rekeyed_verdict(side("former-member", false), side("verified", true), Some(true)),
                verified(),
            ]],
        ),
        Case {
            walker: 4,
            reader: 1,
            target: 3,
            ..case(
                "a second walk carries a bound origin and drops the rest",
                vec![with_metadata_rekeyed(
                    file_node(
                        &key(1),
                        2,
                        1,
                        None,
                        vec![version_rekeyed(FILE, 2, &key(0), &key(1), &p[1], &p[0]), gone, unbound],
                    ),
                    &key(0),
                    &key(1),
                    &p[1],
                    &p[0],
                )],
                vec![vec!["rekeyed", "rekeyed", "dropped", "dropped"]],
                vec![vec![verified(), verified(), signed_verdict("resealed"), signed_verdict("resealed")]],
            )
        },
        Case {
            target: 3,
            ..case(
                "carried origins wrapped elsewhere or unsigned are dropped",
                vec![with_metadata_rekeyed(
                    file_node(&key(1), 2, 1, None, vec![other_epoch, other_version, no_signature]),
                    &key(0),
                    &key(1),
                    &p[1],
                    &p[0],
                )],
                vec![vec!["rekeyed", "dropped", "dropped", "dropped"]],
                vec![vec![
                    verified(),
                    signed_verdict("resealed"),
                    signed_verdict("resealed"),
                    signed_verdict("resealed"),
                ]],
            )
        },
        // Under the top level's current key: its own re-key and re-seal judged by its own keys.
        Case {
            reader: 1,
            ..case(
                "the walker reads its own walk",
                vec![file_node(
                    &key(2),
                    1,
                    2,
                    Some(&p[2]),
                    vec![version_by(FILE, 1, &key(2), Some(&p[1])), version_by(FILE, 5, &key(2), None)],
                )],
                vec![vec!["rekeyed", "rekeyed", "resealed"]],
                vec![vec![
                    rekeyed_verdict(side("former-member", false), side("verified", false), Some(true)),
                    rekeyed_verdict(side("verified", true), side("verified", false), Some(true)),
                    signed_verdict("resealed"),
                ]],
            )
        },
        Case {
            reader: 2,
            target: 3,
            key: Some("k:4"),
            ..case(
                "a node already at the target is only re-wrapped",
                vec![file_node(&key(4), 3, 2, Some(&p[1]), vec![])],
                vec![vec![]],
                vec![vec![]],
            )
        },
        Case {
            stale: Some(StaleChild {
                id: STALE,
                parent_id: FOLDER,
                parent_key_epoch: 1,
                key_epoch: 1,
                key_envelope: node_wrap(node_ctx(STALE, FOLDER, 1, 1), key(2), key(6)).unwrap(),
            }),
            writes: Some(
                json!({ "walked": "writable", "stale": "key-change-pending", "under": "key-change-pending" }),
            ),
            ..case(
                "a folder walk wraps its children under its pending key",
                vec![
                    folder,
                    child(CHILD_A, key(3), &p[1], vec![version_by(CHILD_A, 11, &key(3), Some(&p[1]))]),
                    child(CHILD_B, key(5), &p[2], vec![version_by(CHILD_B, 12, &key(5), Some(&p[2]))]),
                ],
                vec![vec!["rekeyed"], vec!["rekeyed", "rekeyed"], vec!["rekeyed", "rekeyed"]],
                vec![
                    vec![verified()],
                    vec![verified(), verified()],
                    vec![
                        rekeyed_verdict(side("former-member", false), side("verified", true), Some(true)),
                        rekeyed_verdict(side("former-member", false), side("verified", true), Some(true)),
                    ],
                ],
            )
        },
        // A later walk under the top level's current key, so the gone writer's version is re-sealed.
        case(
            "a file with three versions, one by a writer since gone",
            vec![file_node(
                &key(2),
                1,
                2,
                Some(&p[1]),
                vec![
                    version_by(FILE, 21, &key(2), Some(&p[1])),
                    version_by(FILE, 22, &key(2), Some(&p[2])),
                    writer_gone,
                ],
            )],
            vec![vec!["rekeyed", "rekeyed", "rekeyed", "resealed"]],
            vec![vec![
                verified(),
                verified(),
                rekeyed_verdict(side("former-member", false), side("verified", true), Some(true)),
                signed_verdict("resealed"),
            ]],
        ),
        case(
            "a planted signer reads back as a bad signature in its name",
            vec![file_node(&key(1), 1, 1, Some(&p[1]), vec![planted])],
            vec![vec!["rekeyed", "rekeyed"]],
            vec![vec![
                verified(),
                rekeyed_verdict(side("bad-signature", false), side("verified", true), Some(true)),
            ]],
        ),
        // A removal's walk re-seals what nobody signed as the walker's: re-locked, never written by.
        case(
            "an unsigned record under the replaced key is re-sealed as the walker's",
            vec![file_node(&key(1), 1, 1, Some(&p[1]), vec![version_by(FILE, 5, &key(1), None)])],
            vec![vec!["rekeyed", "resealed"]],
            vec![vec![verified(), signed_verdict("resealed")]],
        ),
        Case {
            refused: Some(SHARED_IN_FAMILY),
            ..case("a shared node in a family folder is refused", vec![shared], vec![], vec![])
        },
        Case {
            refused: Some(SHARED_IN_FAMILY),
            ..case("a linked node in a family folder is refused", vec![linked], vec![], vec![])
        },
    ]
}

fn rekey_json(rekey: &Option<ServedRekey>) -> Value {
    match rekey {
        None => Value::Null,
        Some(r) => json!({
            "origin": {
                "envelope": e(&r.origin.envelope),
                "signerId": r.origin.signer_id,
                "signature": r.origin.signature.as_ref().map(|s| e(s)),
                "keyEnvelope": e(&r.origin.key_envelope),
            },
            "signature": e(&r.signature),
        }),
    }
}
fn rekey_of(value: &Value) -> Option<ServedRekey> {
    if value.is_null() {
        return None;
    }
    let o = &value["origin"];
    Some(ServedRekey {
        origin: ServedOrigin {
            envelope: d(&o["envelope"]),
            signer_id: text(&o["signerId"]),
            signature: (!o["signature"].is_null()).then(|| d(&o["signature"])),
            key_envelope: d(&o["keyEnvelope"]),
        },
        signature: d(&value["signature"]),
    })
}

/// A node as the web's `RotateNodeInput` writes it (shares are to person 3, links unsealable).
pub fn node_json(node: &RotatingNode) -> Value {
    let grantee = &family().people[2];
    json!({
        "id": node.node_id,
        "kind": kind_name(node.kind),
        "parentId": node.parent_id,
        "parentKeyEpoch": node.parent_key_epoch,
        "keyEpoch": node.key_epoch,
        "wrappedParentKeyEpoch": node.wrapped_parent_key_epoch,
        "keyEnvelope": e(&node.key_envelope),
        "metadataVersion": node.metadata_version,
        "metadataEnvelope": e(&node.metadata_envelope),
        "metadataSigner": node.metadata_signer,
        "metadataSignature": node.metadata_signature.as_ref().map(|s| e(s)),
        "metadataRekey": rekey_json(&node.metadata_rekey),
        "versions": node.versions.iter().map(|v| json!({
            "id": v.version_id,
            "objectId": v.object_id,
            "contentKeyEnvelope": e(&v.envelope),
            "contentSuite": v.content_suite,
            "plaintextSize": null,
            "signer": v.signer,
            "signature": v.signature.as_ref().map(|s| e(s)),
            "rekey": rekey_json(&v.rekey),
        })).collect::<Vec<_>>(),
        "shares": node.share_ids.iter().map(|id| json!({
            "id": id,
            "granteeUserId": grantee.user_id,
            "granteePublicKey": grantee.served.encryption_public_key,
            "granteeKemPublicKey": grantee.served.kem_public_key,
        })).collect::<Vec<_>>(),
        "links": node.link_ids.iter().map(|id| json!({
            "id": id, "hasPassword": false, "secretEnvelope": null,
        })).collect::<Vec<_>>(),
    })
}

/// A node from the web's `RotateNodeInput` JSON.
pub fn node_of(value: &Value) -> RotatingNode {
    let optional = |v: &Value| (!v.is_null()).then(|| d(v));
    RotatingNode {
        node_id: text(&value["id"]).unwrap(),
        parent_id: text(&value["parentId"]).unwrap(),
        parent_key_epoch: value["parentKeyEpoch"].as_u64().unwrap(),
        key_epoch: value["keyEpoch"].as_u64().unwrap(),
        wrapped_parent_key_epoch: value["wrappedParentKeyEpoch"].as_u64().unwrap(),
        key_envelope: d(&value["keyEnvelope"]),
        kind: if value["kind"] == "folder" { NodeKind::Folder } else { NodeKind::File },
        metadata_version: value["metadataVersion"].as_u64().unwrap(),
        metadata_envelope: d(&value["metadataEnvelope"]),
        metadata_signer: text(&value["metadataSigner"]),
        metadata_signature: optional(&value["metadataSignature"]),
        metadata_rekey: rekey_of(&value["metadataRekey"]),
        versions: value["versions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| RotatingVersion {
                version_id: text(&v["id"]).unwrap(),
                object_id: text(&v["objectId"]).unwrap(),
                content_suite: v["contentSuite"].as_u64().unwrap() as u32,
                envelope: d(&v["contentKeyEnvelope"]),
                signer: text(&v["signer"]),
                signature: optional(&v["signature"]),
                rekey: rekey_of(&v["rekey"]),
            })
            .collect(),
        share_ids: value["shares"].as_array().unwrap().iter().map(|s| text(&s["id"]).unwrap()).collect(),
        link_ids: value["links"].as_array().unwrap().iter().map(|l| text(&l["id"]).unwrap()).collect(),
    }
}

fn record_json(record: &RotatedRecord) -> Value {
    json!({
        "envelope": e(&record.envelope),
        "signature": record.signature.as_ref().map(|s| e(s)),
        "rekey": record.rekey.as_ref().map(|r| json!({
            "originKeyEnvelope": e(&r.origin_key_envelope),
            "signature": e(&r.signature),
        })),
        "dropOrigin": record.drop_origin,
    })
}

/// What a walk gave: each node rotated as both twins write it, each node's key at the target,
/// and, after a case with a stale child, what may be written.
pub struct Walked {
    pub rotated: Vec<Value>,
    pub node_keys: Vec<Option<String>>,
    pub writes: Option<Value>,
}

/* A refusal's code, as the area-ledger scenarios compare them. */
fn code_of(error: &CoreError) -> &'static str {
    if error.to_string() == KEY_CHANGE_PENDING {
        "key-change-pending"
    } else {
        "refused"
    }
}

/// The nodes walked in order on a member's ledger by person `walker` with this core's walk, the
/// batch committed; then, with a stale child, the first child walked, the stale child and a new
/// node under it tried for a write. The refusal's message when this core refuses a node.
pub fn walk(
    nodes: &[RotatingNode],
    walker: usize,
    target: u64,
    stale: Option<&StaleChild>,
) -> Result<Walked, String> {
    let ledger = member_ledger(walker);
    let walker = &family().people[walker - 1];
    for node in nodes {
        ledger
            .open_listed_node(
                AREA.into(),
                ServedNodeKey {
                    node_id: node.node_id.clone(),
                    parent_id: node.parent_id.clone(),
                    parent_key_epoch: node.wrapped_parent_key_epoch,
                    key_epoch: node.key_epoch,
                    key_envelope: node.key_envelope.clone(),
                    prev_key_envelope: None,
                    prev_key_epoch: None,
                    prev_parent_key_epoch: None,
                },
            )
            .unwrap();
    }
    let mut rotated = vec![];
    for node in nodes {
        let out = ledger
            .rotate_node(AREA.into(), node.clone(), target, walker.keys.signing_seed.to_vec())
            .map_err(|error| error.to_string())?;
        if out.rewrap {
            rotated.push(json!({
                "id": node.node_id, "keyEnvelope": e(&out.key_envelope), "rewrap": true,
                "metadata": null, "versions": [], "shares": 0, "links": 0,
            }));
            continue;
        }
        let versions: Vec<Value> = out
            .versions
            .iter()
            .map(|version| {
                let mut value = record_json(&version.record);
                value["id"] = json!(version.version_id);
                value
            })
            .collect();
        rotated.push(json!({
            "id": node.node_id,
            "keyEnvelope": e(&out.key_envelope),
            "rewrap": false,
            "metadata": record_json(out.metadata.as_ref().unwrap()),
            "versions": versions,
            "shares": 0,
            "links": 0,
        }));
    }
    ledger.rotate_commit(AREA.into(), nodes.iter().map(|n| n.node_id.clone()).collect());
    let node_keys = rotated
        .iter()
        .zip(nodes)
        .map(|(r, n)| {
            (r["rewrap"] != true)
                .then(|| ledger.key_at_epoch(AREA.into(), n.node_id.clone(), target).map(|k| e(&k)))
                .flatten()
        })
        .collect();
    let writes = stale.map(|stale| {
        ledger
            .open_listed_node(
                AREA.into(),
                ServedNodeKey {
                    node_id: stale.id.into(),
                    parent_id: stale.parent_id.into(),
                    parent_key_epoch: stale.parent_key_epoch,
                    key_epoch: stale.key_epoch,
                    key_envelope: stale.key_envelope.clone(),
                    prev_key_envelope: None,
                    prev_key_epoch: None,
                    prev_parent_key_epoch: None,
                },
            )
            .unwrap();
        let attempt = |node_id: &str| match ledger.writable_node_key(AREA.into(), node_id.into()) {
            Ok(Some(_)) => "writable",
            Ok(None) => "none",
            Err(error) => code_of(&error),
        };
        let under = match ledger.new_node_key(
            AREA.into(),
            "0e0e0e0e-0000-4000-8000-000000000007".into(),
            stale.id.into(),
            stale.key_epoch,
            1,
        ) {
            Ok(_) => "writable",
            Err(error) => code_of(&error),
        };
        json!({ "walked": attempt(&nodes[1].node_id), "stale": attempt(stale.id), "under": under })
    });
    Ok(Walked { rotated, node_keys, writes })
}

/// What each walked node's records are, in order: re-keyed, re-sealed, or dropped.
pub fn shapes_of(rotated: &[Value]) -> Vec<Vec<String>> {
    rotated
        .iter()
        .map(|r| {
            if r["rewrap"] == true {
                return vec![];
            }
            let shape = |record: &Value| {
                if !record["rekey"].is_null() {
                    "rekeyed"
                } else if record["dropOrigin"] == true {
                    "dropped"
                } else {
                    "resealed"
                }
                .to_string()
            };
            std::iter::once(&r["metadata"]).chain(r["versions"].as_array().unwrap()).map(shape).collect()
        })
        .collect()
}

/// The records of each walked node as a listing serves them once the server stored the walk:
/// each re-keyed record with the origin the server keeps (the one it carried, or the writer's).
pub fn served_after(nodes: &[Value], rotated: &[Value], target: u64, walker_id: &str) -> Vec<Vec<Value>> {
    rotated
        .iter()
        .zip(nodes)
        .map(|(rotated, node)| {
            if rotated["rewrap"] == true {
                return vec![];
            }
            let kept = |envelope: &Value, signer: &Value, signature: &Value, rekey: &Value| {
                if !rekey.is_null() {
                    rekey["origin"].clone()
                } else if signer.is_string() && signature.is_string() {
                    json!({ "envelope": envelope, "signerId": signer, "signature": signature, "keyEnvelope": "" })
                } else {
                    Value::Null
                }
            };
            let served = |record: &str, statement: Value, out: &Value, kept: Value| {
                let rekey = if out["rekey"].is_null() {
                    Value::Null
                } else {
                    let mut origin = kept;
                    origin["keyEnvelope"] = out["rekey"]["originKeyEnvelope"].clone();
                    json!({ "origin": origin, "signature": out["rekey"]["signature"] })
                };
                json!({
                    "record": record,
                    "statement": statement,
                    "keyEpoch": target,
                    "envelope": out["envelope"],
                    "signer": walker_id,
                    "signature": out["signature"],
                    "rekey": rekey,
                })
            };
            let mut records = vec![served(
                "metadata",
                json!({ "workspaceId": AREA, "nodeId": node["id"], "kind": node["kind"], "metadataVersion": 1 }),
                &rotated["metadata"],
                kept(
                    &node["metadataEnvelope"],
                    &node["metadataSigner"],
                    &node["metadataSignature"],
                    &node["metadataRekey"],
                ),
            )];
            for (out, before) in rotated["versions"].as_array().unwrap().iter().zip(node["versions"].as_array().unwrap())
            {
                records.push(served(
                    "version",
                    json!({
                        "workspaceId": AREA, "nodeId": node["id"], "versionId": before["id"],
                        "objectId": before["objectId"], "contentSuite": before["contentSuite"],
                    }),
                    out,
                    kept(&before["contentKeyEnvelope"], &before["signer"], &before["signature"], &before["rekey"]),
                ));
            }
            records
        })
        .collect()
}

fn served_record(value: &Value) -> ServedRecord {
    let s = &value["statement"];
    let statement = if value["record"] == "metadata" {
        RecordStatement::Metadata {
            statement: MetadataStatement {
                workspace_id: text(&s["workspaceId"]).unwrap(),
                node_id: text(&s["nodeId"]).unwrap(),
                kind: if s["kind"] == "folder" { NodeKind::Folder } else { NodeKind::File },
                metadata_version: s["metadataVersion"].as_u64().unwrap(),
            },
        }
    } else {
        RecordStatement::Version {
            statement: VersionStatement {
                workspace_id: text(&s["workspaceId"]).unwrap(),
                node_id: text(&s["nodeId"]).unwrap(),
                version_id: text(&s["versionId"]).unwrap(),
                object_id: text(&s["objectId"]).unwrap(),
                content_suite: s["contentSuite"].as_u64().unwrap() as u32,
            },
        }
    };
    ServedRecord {
        statement,
        key_epoch: value["keyEpoch"].as_u64(),
        envelope: d(&value["envelope"]),
        signer: text(&value["signer"]),
        signature: (!value["signature"].is_null()).then(|| d(&value["signature"])),
        rekey: rekey_of(&value["rekey"]),
    }
}

fn verdict_side(side: &GroupIntegrity) -> Value {
    json!({ "integrity": super::rekeyed::group_verdict_name(side.verdict), "via": side.via })
}

/// The walked nodes read by person `reader` on a fresh member's ledger, each new key listed from
/// the walk's envelope under its parent (a child under its folder's new key): each served
/// record's verdict, and the key held for the first node (named when it is one).
pub fn read_back(
    nodes: &[Value],
    rotated: &[Value],
    served: &[Vec<Value>],
    target: u64,
    reader: usize,
) -> (Vec<Vec<Value>>, String) {
    let people = &family().people;
    let ledger = member_ledger(reader);
    let mut held = vec![];
    for (node, r) in nodes.iter().zip(rotated) {
        held.push(
            ledger
                .open_listed_node(
                    AREA.into(),
                    ServedNodeKey {
                        node_id: text(&node["id"]).unwrap(),
                        parent_id: text(&node["parentId"]).unwrap(),
                        parent_key_epoch: node["parentKeyEpoch"].as_u64().unwrap(),
                        key_epoch: if r["rewrap"] == true {
                            node["keyEpoch"].as_u64().unwrap()
                        } else {
                            target
                        },
                        key_envelope: d(&r["keyEnvelope"]),
                        prev_key_envelope: None,
                        prev_key_epoch: None,
                        prev_parent_key_epoch: None,
                    },
                )
                .unwrap(),
        );
    }
    let keys_of = |p: &Person| TrustedKeys {
        current: base64url_decode(p.served.signing_public_key.clone()).unwrap(),
        retired: vec![],
    };
    let me = &people[reader - 1];
    let writers: Vec<GroupWriter> = people
        .iter()
        .map(|p| GroupWriter {
            user_id: p.user_id.clone(),
            pinned: None,
            served: Some(ServedKeys {
                key_version: p.served.key_version,
                encryption_public_key: p.served.encryption_public_key.clone(),
                signing_public_key: p.served.signing_public_key.clone(),
                ml_dsa_public_key: p.served.ml_dsa_public_key.clone(),
                kem_public_key: p.served.kem_public_key.clone(),
            }),
            links: Some(vec![]),
            personal: Some(keys_of(p)),
        })
        .collect();
    let verdicts = served
        .iter()
        .map(|records| {
            records
                .iter()
                .map(|record| {
                    match ledger
                        .record_verdict(
                            GROUP.into(),
                            RecordReader { user_id: me.user_id.clone(), keys: keys_of(me) },
                            writers.clone(),
                            served_record(record),
                            None,
                        )
                        .expect("the family the folder was opened under")
                    {
                        RecordVerdict::Signed { verdict } => json!({
                            "kind": "signed",
                            "integrity": super::rekeyed::group_verdict_name(verdict.verdict),
                            "via": verdict.via,
                        }),
                        RecordVerdict::Rekeyed { verdict } => json!({
                            "kind": "rekeyed",
                            "origin": verdict_side(&verdict.origin),
                            "rekeyer": verdict_side(&verdict.rekeyer),
                            "bound": verdict.bound,
                        }),
                    }
                })
                .collect()
        })
        .collect();
    let name = match held.first() {
        Some(first) if first.to_vec() == key(4) => "k:4".to_string(),
        Some(first) => e(first),
        None => String::new(),
    };
    (verdicts, name)
}

/// Each re-keyed record of the walked nodes as the fuzz target `record_integrity` reads one, with
/// its node's key at the target and the roster's trust in its writer and walker.
pub fn rekeyed_inputs(served: &[Vec<Value>], node_keys: &[Option<String>]) -> Vec<Value> {
    let people = &family().people;
    let trust_of =
        |user_id: &Value| match people.iter().find(|p| user_id.as_str() == Some(p.user_id.as_str())) {
            None => json!({ "trust": "outside" }),
            Some(p) if p.n == 3 => json!({
                "trust": "former-member",
                "signer": { "current": p.served.signing_public_key, "retired": [] },
                "linksLoaded": true,
            }),
            Some(p) => json!({
                "trust": "roster",
                "signer": { "current": p.served.signing_public_key, "retired": [] },
                "via": GROUP,
                "linksLoaded": true,
            }),
        };
    served
        .iter()
        .zip(node_keys)
        .flat_map(|(records, node_key)| {
            records
                .iter()
                .filter(|record| !record["rekey"].is_null())
                .map(|record| {
                    json!({
                        "record": record["record"],
                        "statement": record["statement"],
                        "keyEpoch": record["keyEpoch"],
                        "envelope": record["envelope"],
                        "origin": record["rekey"]["origin"],
                        "rekeySignature": record["rekey"]["signature"],
                        "nodeKey": node_key,
                        "group": {
                            "origin": trust_of(&record["rekey"]["origin"]["signerId"]),
                            "originPersonal": null,
                            "rekeyer": trust_of(&record["signer"]),
                            "rekeyerPersonal": null,
                        },
                    })
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

fn stale_json(stale: &Option<StaleChild>) -> Value {
    match stale {
        None => Value::Null,
        Some(s) => json!({
            "id": s.id, "parentId": s.parent_id, "parentKeyEpoch": s.parent_key_epoch,
            "keyEpoch": s.key_epoch, "keyEnvelope": e(&s.key_envelope),
        }),
    }
}

/// A stale child from the web's JSON.
pub fn stale_of(value: &Value, case: &Case) -> Option<StaleChild> {
    if value.is_null() {
        return None;
    }
    let ours = case.stale.as_ref().expect("both twins declare the stale child");
    Some(StaleChild {
        id: ours.id,
        parent_id: ours.parent_id,
        parent_key_epoch: value["parentKeyEpoch"].as_u64().unwrap(),
        key_epoch: value["keyEpoch"].as_u64().unwrap(),
        key_envelope: d(&value["keyEnvelope"]),
    })
}

/// Every case walked by this core, checked against what it declares, as the fixture writes it.
pub fn rotation_fixture() -> Vec<Value> {
    let people = &family().people;
    rotation_cases()
        .into_iter()
        .map(|c| {
            let nodes: Vec<Value> = c.nodes.iter().map(node_json).collect();
            let base = json!({
                "name": c.name,
                "walker": c.walker,
                "reader": c.reader,
                "target": c.target,
                "nodes": nodes,
                "shapes": c.shapes,
                "key": c.key,
                "refused": c.refused,
                "stale": stale_json(&c.stale),
                "writes": c.writes,
                "expected": c.expected,
            });
            let walked = walk(&c.nodes, c.walker, c.target, c.stale.as_ref());
            if let Some(message) = c.refused {
                assert_eq!(walked.err().as_deref(), Some(message), "{}: refused", c.name);
                let mut out = base;
                out["rotated"] = json!([]);
                out["served"] = json!([]);
                out["rekeyedInputs"] = json!([]);
                return out;
            }
            let walked = walked.unwrap_or_else(|error| panic!("{}: {error}", c.name));
            assert_eq!(shapes_of(&walked.rotated), c.shapes, "{}: walked", c.name);
            assert_eq!(walked.writes, c.writes, "{}: writes", c.name);
            let served = served_after(&nodes, &walked.rotated, c.target, &people[c.walker - 1].user_id);
            let (verdicts, held) = read_back(&nodes, &walked.rotated, &served, c.target, c.reader);
            assert_eq!(verdicts, c.expected, "{}: read", c.name);
            if let Some(key) = c.key {
                assert_eq!(held, key, "{}: holds", c.name);
            }
            let mut out = base;
            out["rotated"] = json!(walked.rotated);
            out["served"] = json!(served);
            out["rekeyedInputs"] = json!(rekeyed_inputs(&served, &walked.node_keys));
            out
        })
        .collect()
}
