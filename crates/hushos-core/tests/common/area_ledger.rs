//! The family write rules as steps, the twin of
//! `packages/crypto/src/area-ledger-testkit.ts`: both read the same steps the
//! same way (a step that does not fit is a skip, as the fuzz shapes say), run
//! them on their own ledger, and must give the same outcome for every step.
//! Used by `tests/area_ledger_fixtures.rs`, `examples/area_ledger_fixtures.rs`
//! and the fuzz target `area_ledger` (which includes this file by path).
//! The scenarios both run are `fixtures/area-ledger-scenarios.json`.
#![allow(dead_code)]

use super::groups::{
    accepted_of, area_key_at, area_row, key_row_at, pattern, person, reader, root_key_at, served_ml_dsa,
    tombstone_at, History, AREA, AREA_SEED, GROUP, OTHER_GROUP,
};
use hushos_core::*;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

/// Every chain a step may commit: AREA in GROUP, created by person 1, rotated or retired; and
/// another family (OTHER_GROUP) whose chain also lists AREA at version 1, as a removed member who
/// manages a second family the person is in could sign it.
pub const CHAINS: &[&str] = &[
    "f2-v1",
    "f2-v2",
    "f2-v3",
    "f1-v1",
    "f1-v2",
    "f1-to-f2",
    "f2-retired",
    "other-f2-v1",
    "f2-v2-split",
    "other-lists-personal",
];

/// The account's own workspace in the steps, and its key (pattern(32, 209), named k:9).
pub const PERSONAL: &str = "f0f0f0f0-0000-4000-8000-00000000000f";

/// Node names a step may use.
pub const NODES: &[&str] = &["ROOT", "A", "B", "C", "D", "E", "F", "G"];

fn node_id(name: &str) -> String {
    let index = NODES.iter().position(|n| *n == name).expect("a known node") + 1;
    format!("0e0e0e0e-0000-4000-8000-{index:012x}")
}

fn id(name: &str) -> String {
    if name == "WS" {
        AREA.to_string()
    } else {
        node_id(name)
    }
}

/* The codes a refusal is compared by: the ledger's own messages, anything else "refused". */
pub fn code_of(error: &CoreError) -> &'static str {
    let message = error.to_string();
    let codes: &[(&str, &str)] = &[
        (KEY_CHANGE_PENDING, "key-change-pending"),
        (NOT_CARRIED, "not-carried"),
        (KEYS_CHANGED, "keys-changed"),
        (NOT_CHECKED_KEYS, "not-checked"),
        (AREA_ROOT, "area-root"),
        (NOT_COMMITTED_ROOT, "not-committed-root"),
        ("Open Drive again to continue.", "open-drive"),
        ("This folder was wrapped under an older workspace key.", "older-workspace-key"),
        ("Open the containing folder first.", "open-parent"),
        ("This item was wrapped under an older folder key.", "older-folder-key"),
        ("Check the family’s member list first.", "no-chain"),
        ("This folder does not belong to the family.", "not-the-familys"),
        ("This folder is not on the family’s member list.", "not-listed"),
        ("This item changed since it was opened. Refresh and retry.", "item-changed"),
        (OLDER_CHAIN, "older-chain"),
        (SPLIT_CHAIN, "split-chain"),
    ];
    codes.iter().find(|(text, _)| *text == message).map(|(_, code)| *code).unwrap_or("refused")
}

/// Every chain in [`CHAINS`], built once: the same statements as the web's, signatures aside.
pub fn chains() -> &'static HashMap<&'static str, Arc<AcceptedRosters>> {
    static BUILT: OnceLock<HashMap<&'static str, Arc<AcceptedRosters>>> = OnceLock::new();
    BUILT.get_or_init(|| {
        let owner = person(1);
        let entry = owner.entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active);
        enum Step {
            Rows(Vec<RosterArea>),
            Switch,
        }
        let make = |format: u8, steps: Vec<Step>| {
            let mut h = History { format, ..History::new() };
            for step in steps {
                match step {
                    Step::Switch => h.format = 2,
                    Step::Rows(rows) => h.roster_with(&owner, vec![entry.clone()], None, Some(rows)),
                }
            }
            accepted_of(&h, &[&owner])
        };
        let mut out = HashMap::new();
        out.insert("f2-v1", make(2, vec![Step::Rows(vec![key_row_at(AREA, 1)])]));
        out.insert(
            "f2-v2",
            make(2, vec![Step::Rows(vec![key_row_at(AREA, 1)]), Step::Rows(vec![key_row_at(AREA, 2)])]),
        );
        out.insert(
            "f2-v3",
            make(
                2,
                vec![
                    Step::Rows(vec![key_row_at(AREA, 1)]),
                    Step::Rows(vec![key_row_at(AREA, 2)]),
                    Step::Rows(vec![key_row_at(AREA, 3)]),
                ],
            ),
        );
        out.insert("f1-v1", make(1, vec![Step::Rows(vec![area_row(AREA, 1)])]));
        out.insert(
            "f1-v2",
            make(1, vec![Step::Rows(vec![area_row(AREA, 1)]), Step::Rows(vec![area_row(AREA, 2)])]),
        );
        out.insert(
            "f1-to-f2",
            make(
                1,
                vec![
                    Step::Rows(vec![area_row(AREA, 1)]),
                    Step::Switch,
                    Step::Rows(vec![key_row_at(AREA, 2)]),
                ],
            ),
        );
        out.insert(
            "f2-retired",
            make(2, vec![Step::Rows(vec![key_row_at(AREA, 1)]), Step::Rows(vec![tombstone_at(AREA, 2)])]),
        );
        // Roster 2 with no rows: the version f2-v2 holds, another digest (a split view).
        out.insert("f2-v2-split", make(2, vec![Step::Rows(vec![key_row_at(AREA, 1)]), Step::Rows(vec![])]));
        let mut other = History { format: 2, group_id: OTHER_GROUP.into(), ..History::new() };
        other.roster_with(&owner, vec![entry.clone()], None, Some(vec![key_row_at(AREA, 1)]));
        let Ok(RosterChain::Accepted { chain }) = accept_rosters(
            OTHER_GROUP.into(),
            other.key(1),
            Some(GroupAnchor::Created),
            vec![],
            other.rosters.clone(),
            vec![],
            served_ml_dsa(&[&owner]),
            reader(),
            None,
        ) else {
            panic!("the other family's chain is accepted");
        };
        out.insert("other-f2-v1", chain);
        // Another family whose roster names this account's own workspace as one of its areas.
        let mut hostile = History { format: 2, group_id: OTHER_GROUP.into(), ..History::new() };
        hostile.roster_with(&owner, vec![entry.clone()], None, Some(vec![key_row_at(PERSONAL, 1)]));
        let Ok(RosterChain::Accepted { chain }) = accept_rosters(
            OTHER_GROUP.into(),
            hostile.key(1),
            Some(GroupAnchor::Created),
            vec![],
            hostile.rosters.clone(),
            vec![],
            served_ml_dsa(&[&owner]),
            reader(),
            None,
        ) else {
            panic!("the hostile family's chain is accepted");
        };
        out.insert("other-lists-personal", chain);
        out
    })
}

/* A named key: the testkit's area and root keys, or a pattern. */
fn named_key(name: &str) -> Option<Vec<u8>> {
    let (kind, n) = name.split_once(':')?;
    if n.is_empty() || n.len() > 2 || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u64 = n.parse().ok()?;
    match kind {
        "area" if (1..=9).contains(&n) => Some(area_key_at(AREA, n)),
        "root" if (1..=9).contains(&n) => Some(root_key_at(AREA, n)),
        "k" if n <= 15 => Some(pattern(32, 200 + n as u8)),
        _ => None,
    }
}

fn named() -> Vec<String> {
    (1..=9)
        .map(|n| format!("area:{n}"))
        .chain((1..=9).map(|n| format!("root:{n}")))
        .chain((0..16).map(|n| format!("k:{n}")))
        .collect()
}

fn made_ref(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("made:") else {
        return false;
    };
    let Some((node, epoch)) = rest.split_once('@') else {
        return false;
    };
    !node.is_empty()
        && node.bytes().all(|b| b.is_ascii_uppercase())
        && !epoch.is_empty()
        && epoch.len() <= 2
        && epoch.bytes().all(|b| b.is_ascii_digit())
}

fn key_ref(value: &Value) -> Option<String> {
    let value = value.as_str()?;
    (named_key(value).is_some() || made_ref(value)).then(|| value.to_string())
}

/* A JSON number 0 to 64 with no fraction: `1`, `1.0` and `1e0` alike, as JSON.parse reads them. */
fn epoch_of(value: &Value) -> Option<u64> {
    if let Some(n) = value.as_u64() {
        return (n <= 64).then_some(n);
    }
    let f = value.as_f64()?;
    (f.fract() == 0.0 && (0.0..=64.0).contains(&f)).then_some(f as u64)
}

fn node_of(value: &Value) -> Option<String> {
    let value = value.as_str()?;
    NODES.contains(&value).then(|| value.to_string())
}

/* The family a step names: GROUP unless it says "other". */
fn group_of(value: Option<&Value>) -> Option<String> {
    match value {
        None => Some(GROUP.into()),
        Some(Value::String(name)) if name == "family" => Some(GROUP.into()),
        Some(Value::String(name)) if name == "other" => Some(OTHER_GROUP.into()),
        _ => None,
    }
}

fn parent_of(value: &Value) -> Option<String> {
    if value.as_str() == Some("WS") {
        Some("WS".into())
    } else {
        node_of(value)
    }
}

#[derive(Clone, Debug)]
pub struct Wrapped {
    key: String,
    under: String,
    parent_key_epoch: u64,
    key_epoch: u64,
    previous_root: bool,
}

fn wrapped_of(value: &Value) -> Option<Wrapped> {
    let object = value.as_object()?;
    let field = |name: &str| object.get(name).unwrap_or(&Value::Null);
    let previous_root = match object.get("label") {
        None => false,
        Some(Value::String(label)) if label == "node" => false,
        Some(Value::String(label)) if label == "previous-root" => true,
        _ => return None,
    };
    Some(Wrapped {
        key: key_ref(field("key"))?,
        under: key_ref(field("under"))?,
        parent_key_epoch: epoch_of(field("parentKeyEpoch"))?,
        key_epoch: epoch_of(field("keyEpoch"))?,
        previous_root,
    })
}

#[derive(Clone, Debug)]
pub enum Step {
    Commit(String),
    /* The group, and whether it is the worker's uncommit after a fork. */
    Uncommit(String, bool),
    Forget(String),
    OpenArea { group: String, version: u64, served: u64, key: String, id_seed: String },
    List { node: String, parent: String, envelope: Wrapped, prev: Option<Wrapped> },
    Create { node: String, parent: String, parent_key_epoch: u64, key_epoch: u64 },
    Writable(String),
    RequireWritable,
    Rewrap { node: String, parent: String, parent_key_epoch: u64, key_epoch: u64 },
    Rotate { node: String, parent: String, parent_key_epoch: u64, target: u64, envelope: Wrapped },
    CommitPending(Vec<String>),
    DropPending(Vec<String>),
    DropAllPending,
    OpenPersonal(u64),
    PersonalCreate { node: String, parent_key_epoch: u64, key_epoch: u64 },
    PersonalState,
    Foreign,
    KeyAt { node: String, epoch: u64 },
    NodeKey(String),
    State,
}

/// One step from JSON; none when it does not fit.
pub fn read_step(value: &Value) -> Option<Step> {
    let object = value.as_object()?;
    let field = |name: &str| object.get(name).unwrap_or(&Value::Null);
    Some(match field("op").as_str()? {
        "commit" => {
            let chain = field("chain").as_str()?;
            Step::Commit(CHAINS.iter().find(|c| **c == chain)?.to_string())
        }
        "uncommit" => {
            let fork = match object.get("fork") {
                None => false,
                Some(Value::Bool(fork)) => *fork,
                Some(_) => return None,
            };
            Step::Uncommit(group_of(object.get("group"))?, fork)
        }
        "forget" => Step::Forget(group_of(object.get("group"))?),
        "dropAllPending" => Step::DropAllPending,
        "personalState" => Step::PersonalState,
        "foreign" => Step::Foreign,
        "openPersonal" => Step::OpenPersonal(epoch_of(field("version"))?),
        "personalCreate" => Step::PersonalCreate {
            node: node_of(field("node"))?,
            parent_key_epoch: epoch_of(field("parentKeyEpoch"))?,
            key_epoch: epoch_of(field("keyEpoch"))?,
        },
        "requireWritable" => Step::RequireWritable,
        "state" => Step::State,
        "openArea" => {
            let group = group_of(object.get("group"))?;
            let version = epoch_of(field("version"))?;
            let served = epoch_of(field("served"))?;
            let key = match object.get("key") {
                None => key_ref(&json!(format!("area:{version}")))?,
                Some(value) => key_ref(value)?,
            };
            let id_seed = match object.get("idSeed") {
                None => AREA_SEED.to_string(),
                Some(Value::String(seed)) => seed.clone(),
                Some(_) => return None,
            };
            Step::OpenArea { group, version, served, key, id_seed }
        }
        "list" => {
            let prev = match object.get("prev") {
                None => None,
                Some(value) => Some(wrapped_of(value)?),
            };
            Step::List {
                node: node_of(field("node"))?,
                parent: parent_of(field("parent"))?,
                envelope: wrapped_of(value)?,
                prev,
            }
        }
        op @ ("create" | "rewrap") => {
            let (node, parent) = (node_of(field("node"))?, parent_of(field("parent"))?);
            let (parent_key_epoch, key_epoch) =
                (epoch_of(field("parentKeyEpoch"))?, epoch_of(field("keyEpoch"))?);
            if op == "create" {
                Step::Create { node, parent, parent_key_epoch, key_epoch }
            } else {
                Step::Rewrap { node, parent, parent_key_epoch, key_epoch }
            }
        }
        "writable" => Step::Writable(node_of(field("node"))?),
        "keyAt" => Step::KeyAt { node: node_of(field("node"))?, epoch: epoch_of(field("epoch"))? },
        "nodeKey" => Step::NodeKey(node_of(field("node"))?),
        "rotate" => {
            let envelope = wrapped_of(field("served"))?;
            if envelope.previous_root {
                return None;
            }
            Step::Rotate {
                node: node_of(field("node"))?,
                parent: parent_of(field("parent"))?,
                parent_key_epoch: epoch_of(field("parentKeyEpoch"))?,
                target: epoch_of(field("target"))?,
                envelope,
            }
        }
        op @ ("commitPending" | "dropPending") => {
            let nodes = field("nodes").as_array()?;
            if nodes.len() > 8 {
                return None;
            }
            let nodes = nodes.iter().map(node_of).collect::<Option<Vec<_>>>()?;
            if op == "commitPending" {
                Step::CommitPending(nodes)
            } else {
                Step::DropPending(nodes)
            }
        }
        _ => return None,
    })
}

/// Steps from JSON (at most 64); none when any does not fit.
pub fn read_steps(value: &Value) -> Option<Vec<Step>> {
    let steps = value.as_array()?;
    if steps.len() > 64 {
        return None;
    }
    steps.iter().map(read_step).collect()
}

/// What running steps gave: each step's outcome, and every envelope a step made.
pub struct Run {
    pub outcomes: Vec<Value>,
    pub made: Vec<Value>,
    /// Every envelope a step served the ledger, for the other twin to open under its label.
    pub served: Vec<Value>,
    /// What the rule oracles caught (both must stay empty): a write under a parent not rooted at
    /// the area's write version, or a node a write made that is not writable at once.
    pub violations: Vec<String>,
}

struct Runner {
    ledger: Arc<AreaLedger>,
    made: HashMap<String, Vec<u8>>,
    labels: HashMap<Vec<u8>, String>,
    pending_fresh: HashMap<String, Vec<u8>>,
    /* Each walk's pending key by NODE@EPOCH: the write version it is rooted at, or none. */
    pending_rooted: HashMap<String, Option<u64>>,
    /* The families that opened AREA here: forgetting one of them drops AREA's keys, pending ones included. */
    opened_by: std::collections::HashSet<String>,
    out: Vec<Value>,
    served: std::cell::RefCell<Vec<Value>>,
}

/// Runs `steps` on a fresh ledger, as the web's `runSteps` does.
pub fn run_steps(steps: &[Step]) -> Run {
    let mut runner = Runner {
        ledger: AreaLedger::new(),
        made: HashMap::new(),
        labels: HashMap::new(),
        pending_fresh: HashMap::new(),
        pending_rooted: HashMap::new(),
        opened_by: Default::default(),
        out: vec![],
        served: Default::default(),
    };
    let mut outcomes = vec![];
    let mut violations = vec![];
    for (index, step) in steps.iter().enumerate() {
        let parent = match step {
            Step::Create { parent, parent_key_epoch, .. }
            | Step::Rewrap { parent, parent_key_epoch, .. }
            | Step::Rotate { parent, parent_key_epoch, .. } => {
                runner.rooted_parent(parent, *parent_key_epoch)
            }
            _ => true,
        };
        outcomes.push(match runner.run(index, step, parent) {
            Ok(Value::Object(mut fields)) => {
                fields.insert("ok".into(), json!(true));
                if !parent {
                    violations.push(format!(
                        "step {index}: a write went under a parent not rooted at the write version"
                    ));
                }
                if let Step::Create { node, .. } = step {
                    if runner.ledger.is_area(AREA.into())
                        && !runner
                            .ledger
                            .writable_node_key(AREA.into(), id(node))
                            .is_ok_and(|held| held.is_some())
                    {
                        violations.push(format!("step {index}: a node a write made is not writable"));
                    }
                }
                Value::Object(fields)
            }
            Ok(_) => unreachable!("every outcome is an object"),
            Err(error) => json!({ "error": code_of(&error) }),
        });
    }
    Run { outcomes, made: runner.out, served: runner.served.into_inner(), violations }
}

fn unknown_key() -> CoreError {
    CoreError::Input("unknown key".into())
}

impl Runner {
    fn forget_pending(&mut self, node: &str) {
        let prefix = format!("{node}@");
        self.pending_fresh.retain(|at, _| !at.starts_with(&prefix));
        self.pending_rooted.retain(|at, _| !at.starts_with(&prefix));
    }

    fn write_version_now(&self) -> Option<u64> {
        self.ledger.write_version(AREA.into()).ok().flatten()
    }

    /* The oracle's view: whether a parent at `epoch` is rooted at the area's write version. */
    fn rooted_parent(&self, parent: &str, epoch: u64) -> bool {
        if !self.ledger.is_area(AREA.into()) {
            return true;
        }
        if parent == "WS" {
            return false;
        }
        if let Some(pending) = self.pending_rooted.get(&format!("{parent}@{epoch}")) {
            return pending.is_some() && *pending == self.write_version_now();
        }
        matches!(self.ledger.writable_node_key(AREA.into(), id(parent)), Ok(Some(held)) if held.epoch == epoch)
    }

    fn remember(&mut self, node: &str, epoch: u64, key: &[u8]) {
        let label = format!("made:{node}@{epoch}");
        self.made.insert(label.clone(), key.to_vec());
        self.labels.insert(key.to_vec(), label);
    }

    fn resolve(&self, reference: &str) -> Option<Vec<u8>> {
        named_key(reference).or_else(|| self.made.get(reference).cloned())
    }

    fn name_of(&self, key: &[u8]) -> String {
        for name in named() {
            if named_key(&name).as_deref() == Some(key) {
                return name;
            }
        }
        self.labels.get(key).cloned().unwrap_or_else(|| "unknown".into())
    }

    fn envelope_of(&self, node: &str, parent: &str, wrapped: &Wrapped) -> Option<Vec<u8>> {
        let key = self.resolve(&wrapped.key)?;
        let under = self.resolve(&wrapped.under)?;
        let ctx = NodeKeyContext {
            workspace_id: AREA.into(),
            node_id: id(node),
            parent_id: id(parent),
            parent_key_epoch: wrapped.parent_key_epoch,
            key_epoch: wrapped.key_epoch,
        };
        // Fields the envelope's context refuses (the web's wrap throws): an envelope that opens nowhere.
        let valid = wrapped.parent_key_epoch >= 1 && wrapped.key_epoch >= 1;
        let sealed = if !valid {
            None
        } else if wrapped.previous_root {
            previous_root_key_wrap(ctx.clone(), under.clone(), key.clone()).ok()
        } else {
            node_wrap(ctx.clone(), under.clone(), key.clone()).ok()
        };
        if let Some(envelope) = &sealed {
            self.served.borrow_mut().push(json!({
                "label": if wrapped.previous_root { "previous-root" } else { "node" },
                "workspaceId": ctx.workspace_id,
                "nodeId": ctx.node_id,
                "parentId": ctx.parent_id,
                "parentKeyEpoch": ctx.parent_key_epoch,
                "keyEpoch": ctx.key_epoch,
                "parentKey": base64url_encode(under),
                "key": base64url_encode(key),
                "keyEnvelope": base64url_encode(envelope.clone()),
            }));
        }
        Some(sealed.unwrap_or_else(|| vec![0; 72]))
    }

    fn parent_key_of(&self, parent: &str, epoch: u64) -> Option<Vec<u8>> {
        if parent == "WS" {
            return None;
        }
        // A walk's pending key first, as wrap_key_for takes it; pending_fresh holds only uncommitted ones.
        self.pending_fresh
            .get(&format!("{parent}@{epoch}"))
            .cloned()
            .or_else(|| self.ledger.key_at_epoch(AREA.into(), id(parent), epoch).map(|key| key.to_vec()))
    }

    #[allow(clippy::too_many_arguments)]
    fn made_of(
        &mut self,
        step: usize,
        node: &str,
        parent: &str,
        parent_key_epoch: u64,
        key_epoch: u64,
        key: &[u8],
        key_envelope: &[u8],
        parent_key: Option<Vec<u8>>,
    ) {
        let under = parent_key.or_else(|| self.parent_key_of(parent, parent_key_epoch));
        self.out.push(json!({
            "step": step,
            "workspaceId": AREA,
            "nodeId": id(node),
            "parentId": id(parent),
            "parentKeyEpoch": parent_key_epoch,
            "keyEpoch": key_epoch,
            "parentKey": under.map(base64url_encode).unwrap_or_default(),
            "key": base64url_encode(key.to_vec()),
            "keyEnvelope": base64url_encode(key_envelope.to_vec()),
        }));
    }

    fn run(&mut self, index: usize, step: &Step, rooted_before: bool) -> CoreResult<Value> {
        let ledger = Arc::clone(&self.ledger);
        Ok(match step {
            Step::Commit(name) => {
                ledger.commit(Arc::clone(&chains()[name.as_str()]))?;
                json!({})
            }
            Step::Uncommit(group, fork) => {
                ledger.uncommit(group.clone(), *fork);
                json!({})
            }
            Step::Forget(group) => {
                ledger.forget_group(group.clone());
                if self.opened_by.remove(group) {
                    for node in NODES {
                        self.forget_pending(node);
                    }
                }
                json!({})
            }
            Step::OpenArea { group, version, served, key, id_seed } => {
                let key = self.resolve(key).ok_or_else(unknown_key)?;
                let opened =
                    ledger.open_area(group.clone(), AREA.into(), id_seed.clone(), *version, key, *served)?;
                self.opened_by.insert(group.clone());
                json!({ "version": opened.version, "writable": opened.writable, "reason": opened.reason.map(AreaBlock::name) })
            }
            Step::List { node, parent, envelope, prev } => {
                let key_envelope = self.envelope_of(node, parent, envelope).ok_or_else(unknown_key)?;
                let prev_envelope = match prev {
                    None => None,
                    Some(prev) => Some(self.envelope_of(node, parent, prev).ok_or_else(unknown_key)?),
                };
                let key = ledger.open_listed_node(
                    AREA.into(),
                    ServedNodeKey {
                        node_id: id(node),
                        parent_id: id(parent),
                        parent_key_epoch: envelope.parent_key_epoch,
                        key_epoch: envelope.key_epoch,
                        key_envelope,
                        prev_key_envelope: prev_envelope,
                        prev_key_epoch: prev.as_ref().map(|p| p.key_epoch),
                        prev_parent_key_epoch: prev.as_ref().map(|p| p.parent_key_epoch),
                    },
                )?;
                json!({ "key": self.name_of(&key) })
            }
            Step::Create { node, parent, parent_key_epoch, key_epoch } => {
                // The parent's key as it was before the step (a node may be made under its own id).
                let under = self.parent_key_of(parent, *parent_key_epoch);
                let made =
                    ledger.new_node_key(AREA.into(), id(node), id(parent), *parent_key_epoch, *key_epoch)?;
                self.remember(node, *key_epoch, &made.key);
                self.made_of(
                    index,
                    node,
                    parent,
                    *parent_key_epoch,
                    *key_epoch,
                    &made.key,
                    &made.key_envelope,
                    under,
                );
                json!({ "key": self.name_of(&made.key) })
            }
            Step::Writable(node) => match ledger.writable_node_key(AREA.into(), id(node))? {
                Some(held) => json!({ "key": self.name_of(&held.key), "epoch": held.epoch }),
                None => json!({ "none": true }),
            },
            Step::RequireWritable => {
                ledger.require_writable(AREA.into())?;
                json!({})
            }
            Step::Rewrap { node, parent, parent_key_epoch, key_epoch } => {
                let under = self.parent_key_of(parent, *parent_key_epoch);
                let key_envelope =
                    ledger.rewrap_node(AREA.into(), id(node), id(parent), *parent_key_epoch, *key_epoch)?;
                let key = ledger.node_key(AREA.into(), id(node)).expect("a node rewrap_node held").key;
                self.made_of(index, node, parent, *parent_key_epoch, *key_epoch, &key, &key_envelope, under);
                json!({})
            }
            Step::Rotate { node, parent, parent_key_epoch, target, envelope } => {
                let served = self.envelope_of(node, parent, envelope).ok_or_else(unknown_key)?;
                let under = self.parent_key_of(parent, *parent_key_epoch);
                let rotated = ledger.rotate_key(
                    AREA.into(),
                    RotatingNodeKey {
                        node_id: id(node),
                        parent_id: id(parent),
                        parent_key_epoch: *parent_key_epoch,
                        key_epoch: envelope.key_epoch,
                        wrapped_parent_key_epoch: envelope.parent_key_epoch,
                        key_envelope: served,
                    },
                    *target,
                )?;
                let old = rotated.old_key.expect("the old key").to_vec();
                if rotated.rewrap {
                    let name = self.name_of(&old);
                    self.made_of(
                        index,
                        node,
                        parent,
                        *parent_key_epoch,
                        envelope.key_epoch,
                        &old,
                        &rotated.key_envelope,
                        under,
                    );
                    json!({ "rewrap": true, "key": name })
                } else {
                    let fresh = rotated.fresh_key.expect("a fresh key").to_vec();
                    let old_name = self.name_of(&old);
                    self.remember(node, *target, &fresh);
                    self.forget_pending(node);
                    self.pending_fresh.insert(format!("{node}@{target}"), fresh.clone());
                    let rooted = if rooted_before { self.write_version_now() } else { None };
                    self.pending_rooted.insert(format!("{node}@{target}"), rooted);
                    self.made_of(
                        index,
                        node,
                        parent,
                        *parent_key_epoch,
                        *target,
                        &fresh,
                        &rotated.key_envelope,
                        under,
                    );
                    json!({ "rewrap": false, "old": old_name, "fresh": self.name_of(&fresh) })
                }
            }
            Step::OpenPersonal(version) => {
                ledger.open_personal_workspace(PERSONAL.into(), *version, named_key("k:9").unwrap())?;
                json!({})
            }
            Step::PersonalCreate { node, parent_key_epoch, key_epoch } => {
                let made = ledger.new_node_key(
                    PERSONAL.into(),
                    id(node),
                    PERSONAL.into(),
                    *parent_key_epoch,
                    *key_epoch,
                )?;
                self.remember(node, *key_epoch, &made.key);
                json!({ "key": self.name_of(&made.key) })
            }
            Step::PersonalState => {
                let attempt = |read: CoreResult<Option<u64>>| match read {
                    Ok(version) => json!(version),
                    Err(error) => json!(code_of(&error)),
                };
                json!({
                    "isArea": ledger.is_area(PERSONAL.into()),
                    "read": attempt(ledger.read_version(PERSONAL.into())),
                    "write": attempt(ledger.write_version(PERSONAL.into())),
                })
            }
            Step::Foreign => {
                let name = |group: &str| if group == GROUP { "family" } else { "other" };
                let listings: Vec<Value> = ledger
                    .foreign_listings()
                    .into_iter()
                    .map(|at| {
                        json!({
                            "group": name(&at.group_id),
                            "workspace": if at.workspace_id == AREA { "area" } else { "personal" },
                            "openedBy": at.opened_by.as_deref().map(name),
                        })
                    })
                    .collect();
                json!({ "listings": listings })
            }
            Step::DropAllPending => {
                for node in NODES {
                    self.forget_pending(node);
                }
                json!({ "count": ledger.rotate_drop_all(AREA.into()) })
            }
            Step::CommitPending(nodes) | Step::DropPending(nodes) => {
                for node in nodes {
                    self.forget_pending(node);
                }
                let ids = nodes.iter().map(|n| id(n)).collect();
                let count = if matches!(step, Step::CommitPending(_)) {
                    ledger.rotate_commit(AREA.into(), ids)
                } else {
                    ledger.rotate_drop(AREA.into(), ids)
                };
                json!({ "count": count })
            }
            Step::KeyAt { node, epoch } => {
                let key = ledger.key_at_epoch(AREA.into(), id(node), *epoch);
                json!({ "key": key.map(|k| self.name_of(&k)) })
            }
            // What a cached read (metadata, a download) takes: the node's current key as held.
            Step::NodeKey(node) => match ledger.node_key(AREA.into(), id(node)) {
                Some(held) => json!({ "key": self.name_of(&held.key.to_vec()), "epoch": held.epoch }),
                None => json!({ "none": true }),
            },
            Step::State => {
                let attempt = |read: CoreResult<Option<u64>>| match read {
                    Ok(version) => json!(version),
                    Err(error) => json!(code_of(&error)),
                };
                json!({
                    "isArea": ledger.is_area(AREA.into()),
                    "read": attempt(ledger.read_version(AREA.into())),
                    "write": attempt(ledger.write_version(AREA.into())),
                })
            }
        })
    }
}

/// Whether the other twin's served envelope opens under its label to the key it says.
pub fn opens_as_served(served: &Value) -> bool {
    let text = |name: &str| served[name].as_str().unwrap_or_default().to_string();
    let (Ok(parent_key), Ok(envelope), Ok(key)) = (
        base64url_decode(text("parentKey")),
        base64url_decode(text("keyEnvelope")),
        base64url_decode(text("key")),
    ) else {
        return false;
    };
    let ctx = NodeKeyContext {
        workspace_id: text("workspaceId"),
        node_id: text("nodeId"),
        parent_id: text("parentId"),
        parent_key_epoch: served["parentKeyEpoch"].as_u64().unwrap_or(0),
        key_epoch: served["keyEpoch"].as_u64().unwrap_or(0),
    };
    let opened = match text("label").as_str() {
        "previous-root" => previous_root_key_open(ctx, parent_key, envelope),
        "node" => node_open(ctx, parent_key, envelope),
        _ => return false,
    };
    opened.is_ok_and(|opened| opened == key)
}

/// Whether the other twin's made envelope opens to the key it says, under the parent key it says.
pub fn opens_as_made(made: &Value) -> bool {
    let text = |name: &str| made[name].as_str().unwrap_or_default().to_string();
    let (Ok(parent_key), Ok(envelope), Ok(key)) = (
        base64url_decode(text("parentKey")),
        base64url_decode(text("keyEnvelope")),
        base64url_decode(text("key")),
    ) else {
        return false;
    };
    let ctx = NodeKeyContext {
        workspace_id: text("workspaceId"),
        node_id: text("nodeId"),
        parent_id: text("parentId"),
        parent_key_epoch: made["parentKeyEpoch"].as_u64().unwrap_or(0),
        key_epoch: made["keyEpoch"].as_u64().unwrap_or(0),
    };
    node_open(ctx, parent_key, envelope).is_ok_and(|opened| opened == key)
}

fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(fields) => {
            let mut keys: Vec<&String> = fields.keys().collect();
            keys.sort();
            Value::Object(keys.into_iter().map(|k| (k.clone(), sorted(&fields[k]))).collect::<Map<_, _>>())
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

/// The scenario's expectations each step's outcome misses, as the web's `unmet` reports them.
pub fn unmet(scenario: &Value, outcomes: &[Value]) -> Vec<String> {
    let mut misses = vec![];
    for (index, step) in scenario["steps"].as_array().expect("steps").iter().enumerate() {
        let Some(want) = step.get("expect") else {
            continue;
        };
        let got = &outcomes[index];
        let same = match want {
            Value::String(text) if text == "ok" => got["ok"] == json!(true),
            Value::String(text) => got["error"] == json!(text),
            Value::Object(fields) => {
                let mut wanted = fields.clone();
                wanted.insert("ok".into(), json!(true));
                sorted(got) == sorted(&Value::Object(wanted))
            }
            _ => false,
        };
        if !same {
            misses.push(format!("step {index}: wanted {want}, got {got}"));
        }
    }
    misses
}
