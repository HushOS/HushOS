//! The folders' lists and heads for the shared company fixtures
//! (docs/companies-design.md 2.3), the Rust twin of the web's
//! `company-lists-testkit.ts`: what this core says of a case, step by step, as
//! the JSON the web's verdict is, so the two are compared whole (the record a
//! device keeps included).
#![allow(dead_code)]

use super::company::{chain_through, entry};
use super::groups::*;
use hushos_core::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

fn role_name(role: ListRole) -> &'static str {
    match role {
        ListRole::Editor => "editor",
        ListRole::Manager => "manager",
        ListRole::Viewer => "viewer",
    }
}

fn role_of(value: &Value) -> Option<ListRole> {
    match value.as_str()? {
        "editor" => Some(ListRole::Editor),
        "manager" => Some(ListRole::Manager),
        "viewer" => Some(ListRole::Viewer),
        _ => None,
    }
}

fn kind_name(kind: ForkKind) -> &'static str {
    match kind {
        ForkKind::List => "list",
        ForkKind::ShareLog => "share-log",
    }
}

fn state_name(state: HeadState) -> &'static str {
    match state {
        HeadState::Level => "level",
        HeadState::Behind => "behind",
        HeadState::Ahead => "ahead",
        HeadState::Forked => "forked",
    }
}

fn note_json(note: &ForkNote) -> Value {
    json!({
        "kind": kind_name(note.kind),
        "committed": { "position": note.committed_position, "digest": note.committed_digest },
        "reported": { "position": note.reported_position, "digest": note.reported_digest },
        "rosterVersion": note.roster_version,
        "settled": note.settled,
    })
}

fn signed_json(statement: &[u8], signature: &[u8]) -> Value {
    json!({ "statement": e(statement), "signature": e(signature) })
}

/* A list record as the web keeps it. */
pub fn list_record_json(record: &AreaListRecord) -> Value {
    json!({
        "groupId": record.group_id,
        "workspaceId": record.workspace_id,
        "workspaceKeyVersion": record.workspace_key_version,
        "baseListVersion": record.base_list_version,
        "digests": record.digests,
        "committed": { "rosterVersion": record.committed_roster_version, "listVersion": record.committed_list_version },
        "lists": record.lists.iter().map(|stored| json!({
            "statement": e(&stored.statement),
            "signature": e(&stored.signature),
            "heldAt": stored.held_at,
            "reportedAt": stored.reported_at,
        })).collect::<Vec<_>>(),
        "since": record.since,
        "judgedThrough": record.judged_through,
        "forks": record.forks.iter().map(note_json).collect::<Vec<_>>(),
    })
}

/* The same record from the web's JSON; `None` for a field of the wrong kind (refused as an invalid record). */
pub fn list_record_of(value: &Value) -> Option<AreaListRecord> {
    let text = |value: &Value| value.as_str().map(str::to_string);
    Some(AreaListRecord {
        group_id: text(&value["groupId"])?,
        workspace_id: text(&value["workspaceId"])?,
        workspace_key_version: value["workspaceKeyVersion"].as_u64()?,
        base_list_version: value["baseListVersion"].as_u64()?,
        digests: value["digests"].as_array()?.iter().map(text).collect::<Option<_>>()?,
        committed_roster_version: value["committed"]["rosterVersion"].as_u64()?,
        committed_list_version: value["committed"]["listVersion"].as_u64()?,
        lists: value["lists"]
            .as_array()?
            .iter()
            .map(|stored| {
                Some(StoredAreaList {
                    statement: base64url_decode(text(&stored["statement"])?).ok()?,
                    signature: base64url_decode(text(&stored["signature"])?).ok()?,
                    held_at: stored["heldAt"].as_u64()?,
                    reported_at: match &stored["reportedAt"] {
                        Value::Null => None,
                        at => Some(at.as_u64()?),
                    },
                })
            })
            .collect::<Option<_>>()?,
        since: value["since"]
            .as_object()?
            .iter()
            .map(|(id, at)| Some((id.clone(), at.as_u64()?)))
            .collect::<Option<_>>()?,
        judged_through: value["judgedThrough"].as_u64()?,
        forks: value["forks"]
            .as_array()?
            .iter()
            .map(|note| {
                Some(ForkNote {
                    kind: match note["kind"].as_str()? {
                        "list" => ForkKind::List,
                        // A list's record holds no share log's fork: read as given, and refused.
                        "share-log" if note["committed"].is_object() => ForkKind::ShareLog,
                        _ => return None,
                    },
                    committed_position: note["committed"]["position"].as_u64()?,
                    committed_digest: text(&note["committed"]["digest"])?,
                    reported_position: note["reported"]["position"].as_u64()?,
                    reported_digest: text(&note["reported"]["digest"])?,
                    roster_version: note["rosterVersion"].as_u64()?,
                    settled: note["settled"].as_bool()?,
                })
            })
            .collect::<Option<_>>()?,
    })
}

fn head_row_json(row: &HeadRow) -> Value {
    json!({
        "workspaceId": row.workspace_id,
        "workspaceKeyVersion": row.workspace_key_version,
        "listVersion": row.list_version,
        "listDigest": row.list_digest,
        "shareLogIndex": row.share_log_index,
        "shareLogDigest": row.share_log_digest,
    })
}

fn signed_lists(value: &Value) -> Vec<SignedAreaList> {
    value.as_array().map_or(Vec::new(), |lists| {
        lists
            .iter()
            .map(|at| SignedAreaList { statement: b(at, "statement"), signature: b(at, "signature") })
            .collect()
    })
}

fn head_row_of(row: &Value) -> HeadRow {
    HeadRow {
        workspace_id: s(row, "workspaceId"),
        workspace_key_version: n(row, "workspaceKeyVersion"),
        list_version: n(row, "listVersion"),
        list_digest: s(row, "listDigest"),
        share_log_index: n(row, "shareLogIndex"),
        share_log_digest: s(row, "shareLogDigest"),
    }
}

pub fn heads_record_of(value: &Value) -> Option<HeadsRecord> {
    Some(HeadsRecord {
        group_id: value["groupId"].as_str()?.to_string(),
        roster_version: value["rosterVersion"].as_u64()?,
        roster_digest: value["rosterDigest"].as_str()?.to_string(),
        areas: value["areas"]
            .as_object()?
            .iter()
            .map(|(id, rows)| {
                let rows = rows
                    .as_array()?
                    .iter()
                    .map(|row| {
                        Some(CommittedHead {
                            roster_version: row["rosterVersion"].as_u64()?,
                            workspace_key_version: row["workspaceKeyVersion"].as_u64()?,
                            list_version: row["listVersion"].as_u64()?,
                            list_digest: row["listDigest"].as_str()?.to_string(),
                            share_log_index: row["shareLogIndex"].as_u64()?,
                            share_log_digest: row["shareLogDigest"].as_str()?.to_string(),
                        })
                    })
                    .collect::<Option<_>>()?;
                Some((id.clone(), rows))
            })
            .collect::<Option<_>>()?,
    })
}

fn lists_json(view: &AreaListsView) -> Value {
    json!({
        "groupId": view.group_id,
        "workspaceId": view.workspace_id,
        "areaKind": match view.area_kind { AreaKind::Employee => "employee", AreaKind::Shared => "shared" },
        "workspaceKeyVersion": view.workspace_key_version,
        "rosterVersion": view.roster_version,
        "rosterDigest": view.roster_digest,
        "state": state_name(view.state),
        "listVersion": view.list_version,
        "listDigest": view.list_digest,
        "everyone": view.everyone.map_or("", role_name),
        "people": view.people.iter().map(|person| json!({
            "userId": person.user_id, "role": role_name(person.role), "since": person.since,
        })).collect::<Vec<_>>(),
        "record": view.record.as_ref().map(list_record_json),
        "repost": view.repost.iter().map(|at| signed_json(&at.statement, &at.signature)).collect::<Vec<_>>(),
        "report": view.report.map(|report| match report { HeadReport::Ahead => "ahead", HeadReport::Fork => "fork" }),
        "missing": view.missing,
        "refused": view.refused.iter().map(|at| json!({
            "listVersion": at.list_version, "listDigest": at.list_digest, "reason": at.reason,
        })).collect::<Vec<_>>(),
        "lost": view.lost.iter().map(|person| json!({ "userId": person.user_id, "role": role_name(person.role) })).collect::<Vec<_>>(),
        "fork": view.fork.as_ref().map(note_json),
        "head": view.head.as_ref().map(|head| json!({
            "rosterVersion": head.roster_version, "listVersion": head.list_version, "listDigest": head.list_digest,
        })),
        "furthestListVersion": view.furthest_list_version,
    })
}

fn access_json(access: Option<AreaAccess>) -> Value {
    match access {
        None => Value::Null,
        Some(AreaAccess::List { role }) => json!({ "basis": "list", "role": role_name(role) }),
        Some(AreaAccess::Share { role }) => json!({ "basis": "share", "role": role_name(role) }),
        Some(AreaAccess::Browse) => json!({ "basis": "browse" }),
        Some(AreaAccess::KeyChange) => json!({ "basis": "key-change" }),
    }
}

const ACTIONS: [(AreaAction, &str); 6] = [
    (AreaAction::Read, "read"),
    (AreaAction::Download, "download"),
    (AreaAction::Write, "write"),
    (AreaAction::Share, "share"),
    (AreaAction::Manage, "manage"),
    (AreaAction::Rotate, "rotate"),
];

fn standing_name(standing: FolderStanding) -> &'static str {
    match standing {
        FolderStanding::Unchecked => "unchecked",
        FolderStanding::Listed => "listed",
        FolderStanding::DataAdmin => "data-admin",
        FolderStanding::Share => "share",
        FolderStanding::NotOnThisFolder => "not-on-this-folder",
    }
}

fn standing_of(name: &str) -> FolderStanding {
    match name {
        "unchecked" => FolderStanding::Unchecked,
        "listed" => FolderStanding::Listed,
        "data-admin" => FolderStanding::DataAdmin,
        "share" => FolderStanding::Share,
        "not-on-this-folder" => FolderStanding::NotOnThisFolder,
        other => panic!("no standing {other}"),
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map_or(Vec::new(), |list| list.iter().map(|at| at.as_str().unwrap().to_string()).collect())
}

/*
 * What this core says of a case, step by step (the web's listCaseVerdict): the
 * heads it reads, the list it reads (or the fork it settles) with the record
 * it would keep, and the probes the step asks. The record and the heads
 * record pass from each step to the next, as a device's own would.
 */
pub fn list_case_verdict(case: &Value, ml_dsa_keys: &HashMap<String, String>) -> Value {
    let (_, mut input, _) = case_from(&json!({ "name": "", "input": case["input"], "expected": null }));
    input.ml_dsa_keys = ml_dsa_keys.clone();
    let all_heads: Vec<ServedHeads> = case["heads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|at| ServedHeads {
            roster_version: n(at, "rosterVersion"),
            rows: at["rows"].as_array().unwrap().iter().map(head_row_of).collect(),
        })
        .collect();
    let mut out = Vec::new();
    // `Err` holds a record the bindings cannot even hold: refused as an invalid record.
    let mut record: Result<Option<AreaListRecord>, ()> = Ok(None);
    let mut heads_record: Result<Option<HeadsRecord>, ()> = Ok(None);
    for step in case["steps"].as_array().unwrap() {
        let chain = chain_through(&input, n(step, "through"));
        if let Some(given) = step.get("headsRecord") {
            heads_record =
                if given.is_null() { Ok(None) } else { heads_record_of(given).map(Some).ok_or(()) };
        }
        if let Some(given) = step.get("record") {
            record = if given.is_null() { Ok(None) } else { list_record_of(given).map(Some).ok_or(()) };
        }
        let mut verdict = serde_json::Map::new();
        let mut heads = Value::Null;
        if step.get("headsThrough") != Some(&json!(false)) {
            let up_to = step.get("headsThrough").and_then(Value::as_u64).unwrap_or(n(step, "through"));
            let served = all_heads.iter().filter(|at| at.roster_version <= up_to).cloned().collect();
            let read = match &heads_record {
                Ok(kept) => {
                    heads_read(chain.clone(), kept.clone(), served).map_err(|error| error.to_string())
                }
                Err(()) => Err("Invalid heads record.".to_string()),
            };
            heads = match read {
                Ok(read) => {
                    let lowered: Vec<Value> = read
                        .lowered
                        .iter()
                        .map(|at| {
                            json!({
                                "rosterVersion": at.roster_version,
                                "workspaceId": at.workspace_id,
                                "list": at.list,
                                "shareLog": at.share_log,
                            })
                        })
                        .collect();
                    let through = read.record.roster_version;
                    heads_record = Ok(Some(read.record));
                    json!({ "rosterVersion": through, "lowered": lowered })
                }
                Err(error) => json!({ "error": error }),
            };
        }
        verdict.insert("heads".into(), heads);
        let served = step["served"].as_array().map(|lists| {
            lists
                .iter()
                .map(|at| SignedAreaList { statement: b(at, "statement"), signature: b(at, "signature") })
                .collect()
        });
        let workspace_id = s(step, "workspaceId");
        let read: Result<Arc<AreaLists>, String> = match (&heads_record, &record) {
            (Err(()), _) => Err("Invalid heads record.".into()),
            (_, Err(())) => Err("Invalid list record.".into()),
            (Ok(heads), Ok(kept)) => {
                let call = if step.get("call") == Some(&json!("settle")) {
                    area_fork_settle
                } else {
                    area_lists_read
                };
                call(
                    chain.clone(),
                    heads.clone(),
                    workspace_id.clone(),
                    kept.clone(),
                    served,
                    ml_dsa_keys.clone(),
                )
                .map_err(|error| error.to_string())
            }
        };
        let lists = match read {
            Ok(lists) => {
                record = Ok(lists.record());
                verdict.insert("lists".into(), lists_json(&lists.view()));
                Some(lists)
            }
            Err(error) => {
                verdict.insert("lists".into(), json!({ "error": error }));
                None
            }
        };
        let probes = &step["probes"];
        if let Some(lists) = &lists {
            if let Some(access) = probes["access"].as_array() {
                let said: Vec<Value> = access
                    .iter()
                    .map(|probe| {
                        let access = area_access(
                            chain.clone(),
                            lists.clone(),
                            s(probe, "userId"),
                            probe["suspended"].as_bool().unwrap_or(false),
                            match probe["session"].as_str() {
                                Some("browse") => Some(AreaSession::Browse),
                                Some("key-change") => Some(AreaSession::KeyChange),
                                _ => None,
                            },
                            role_of(&probe["share"]),
                        )
                        .unwrap();
                        let allows: Vec<&str> = ACTIONS
                            .iter()
                            .filter(|(action, _)| area_allows(access, *action))
                            .map(|(_, name)| *name)
                            .collect();
                        json!({ "access": access_json(access), "allows": allows.join(",") })
                    })
                    .collect();
                verdict.insert("access".into(), json!(said));
            }
            if probes["owed"] == json!(true) {
                verdict.insert("owed".into(), json!(area_owed(chain.clone(), lists.clone()).unwrap()));
            }
            if probes["grants"].is_object() {
                let suspended = strings(&probes["grants"]["suspended"]);
                verdict.insert(
                    "grants".into(),
                    json!(area_grants_owed(chain.clone(), lists.clone(), suspended).unwrap()),
                );
            }
            if probes["writable"] == json!(true) {
                let said = area_writable(chain.clone(), lists.clone())
                    .map_or_else(|error| error.to_string(), |()| "ok".into());
                verdict.insert("writable".into(), json!(said));
            }
            if let Some(dismissals) = probes["dismissals"].as_array() {
                let notes = lists.record().map_or(Vec::new(), |record| record.forks);
                let said: Vec<&str> = dismissals
                    .iter()
                    .map(|probe| {
                        let signer = person_at(
                            n(probe, "signer") as u8,
                            probe["keyVersion"].as_u64().unwrap_or(1) as u8,
                        );
                        match fork_dismissal_verify(
                            b(probe, "statement"),
                            b(probe, "signature"),
                            chain.clone(),
                            signer.ml_dsa(),
                        ) {
                            Ok(dismissal)
                                if notes.iter().any(|note| {
                                    fork_dismisses(dismissal.clone(), workspace_id.clone(), note.clone())
                                }) =>
                            {
                                "dismisses"
                            }
                            Ok(_) => "verified",
                            Err(_) => "refused",
                        }
                    })
                    .collect();
                verdict.insert("dismissals".into(), json!(said));
            }
        }
        if let (Some(lists), true) = (&lists, probes["commit"].is_object()) {
            // The heads a roster's signer would commit now, every other live folder read afresh.
            let commit = &probes["commit"];
            let built = (|| -> CoreResult<Arc<CommittedHeads>> {
                let mut all = vec![lists.clone()];
                for (other, served) in commit["others"].as_object().unwrap() {
                    all.push(area_lists_read(
                        chain.clone(),
                        heads_record.clone().unwrap_or(None),
                        other.clone(),
                        None,
                        Some(signed_lists(served)),
                        ml_dsa_keys.clone(),
                    )?);
                }
                heads_to_commit(
                    Some(chain.clone()),
                    chain.group_id(),
                    heads_record.clone().unwrap_or(None),
                    all,
                    signed_lists(&commit["changed"]),
                    strings(&commit["retire"]),
                    HashMap::new(),
                )
            })();
            verdict.insert(
                "commit".into(),
                match built {
                    Ok(built) => json!({
                        "headsDigest": built.heads_digest(),
                        "rows": built.rows().iter().map(head_row_json).collect::<Vec<_>>(),
                    }),
                    Err(error) => json!({ "error": error.to_string() }),
                },
            );
        }
        if let Some(standing) = probes["standing"].as_array() {
            let said: Vec<&str> = standing
                .iter()
                .map(|probe| {
                    standing_name(folder_standing(
                        chain.clone(),
                        lists.clone(),
                        workspace_id.clone(),
                        s(probe, "writerUserId"),
                        strings(&probe["sharedEditors"]),
                    ))
                })
                .collect();
            verdict.insert("standing".into(), json!(said));
        }
        out.push(Value::Object(verdict));
    }
    json!(out)
}

/* What this core says of a raw statement: its fields re-encoded, or refused. */
pub fn list_statement_verdict(kind: &str, statement: Vec<u8>) -> String {
    let again = match kind {
        "area-list" => area_list_parse(statement).and_then(area_list_statement),
        _ => fork_dismissal_parse(statement).and_then(fork_dismissal_statement),
    };
    again.map_or("refused".into(), |bytes| e(&bytes))
}

fn verdict_of(name: &str) -> GroupVerdict {
    match name {
        "verified" => GroupVerdict::Verified,
        "seen" => GroupVerdict::Seen,
        "saved-from-link" => GroupVerdict::SavedFromLink,
        "resealed" => GroupVerdict::Resealed,
        "retired-key" => GroupVerdict::RetiredKey,
        "bad-signature" => GroupVerdict::BadSignature,
        "unsigned" => GroupVerdict::Unsigned,
        "unchecked" => GroupVerdict::Unchecked,
        "key-conflict" => GroupVerdict::KeyConflict,
        "former-member" => GroupVerdict::FormerMember,
        other => panic!("no verdict {other}"),
    }
}

fn group_verdict_name(verdict: GroupVerdict) -> &'static str {
    match verdict {
        GroupVerdict::Verified => "verified",
        GroupVerdict::Seen => "seen",
        GroupVerdict::SavedFromLink => "saved-from-link",
        GroupVerdict::Resealed => "resealed",
        GroupVerdict::RetiredKey => "retired-key",
        GroupVerdict::UnknownSigner => "unknown-signer",
        GroupVerdict::BadSignature => "bad-signature",
        GroupVerdict::Unsigned => "unsigned",
        GroupVerdict::Unchecked => "unchecked",
        GroupVerdict::KeyConflict => "key-conflict",
        GroupVerdict::FormerMember => "former-member",
    }
}

/* The folder's rows over one verdict of design 2.8 (the web's folderVerdict). */
pub fn folder_verdict(case: &Value) -> Value {
    let signer = TrustedKeys { current: vec![1; 32], retired: vec![], seen: false };
    let trust = match s(case, "trust").as_str() {
        "roster" => GroupWriterTrust::Roster { signer, via: None, followed: None, links_loaded: true },
        "outside" => GroupWriterTrust::Outside,
        "former-member" => GroupWriterTrust::FormerMember { signer, links_loaded: true },
        "key-conflict" => GroupWriterTrust::KeyConflict,
        _ => GroupWriterTrust::Unchecked,
    };
    let said = folder_integrity(
        GroupIntegrity {
            verdict: verdict_of(&s(case, "integrity")),
            via: case["via"].as_str().map(str::to_string),
        },
        trust,
        standing_of(&s(case, "standing")),
    );
    let integrity = match said.verdict {
        FolderVerdict::Group { verdict } => group_verdict_name(verdict),
        FolderVerdict::NotOnThisFolder => "not-on-this-folder",
    };
    json!({ "integrity": integrity, "via": said.via })
}

/* The folder's list as a device served `which` of its lists reads it at `through`; None when it read none. */
fn folder_lists(folder: &Value, input: &CaseInput, through: u64, which: &str) -> Option<Arc<AreaLists>> {
    if which == "none" {
        return None;
    }
    let chain = chain_through(input, through);
    let served: Vec<ServedHeads> = folder["heads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|at| ServedHeads {
            roster_version: n(at, "rosterVersion"),
            rows: at["rows"].as_array().unwrap().iter().map(head_row_of).collect(),
        })
        .collect();
    let heads = heads_read(chain.clone(), None, served).unwrap().record;
    let lists = area_lists_read(
        chain,
        Some(heads),
        AREA.into(),
        None,
        Some(signed_lists(&folder["served"][which])),
        input.ml_dsa_keys.clone(),
    );
    Some(lists.unwrap())
}

fn folder_input(folder: &Value, ml_dsa_keys: &HashMap<String, String>) -> CaseInput {
    let mut input = case_from(&json!({ "name": "", "input": folder["input"], "expected": null })).1;
    input.ml_dsa_keys = ml_dsa_keys.clone();
    input
}

/* What this core says of a grant item (the web's grantItemVerdict): `opened:<key>`, `sealed` or `refused`. */
pub fn grant_item_verdict(folder: &Value, item: &Value, ml_dsa_keys: &HashMap<String, String>) -> String {
    let input = folder_input(folder, ml_dsa_keys);
    let through = n(item, "through");
    let chain = chain_through(&input, through);
    let lists = folder_lists(folder, &input, through, &s(item, "lists"));
    let (granter, reader) = (person(n(item, "granter") as u8), person(n(item, "reader") as u8));
    let ctx = &item["ctx"];
    let ctx = AreaGrantContext {
        group_id: s(ctx, "groupId"),
        workspace_id: s(ctx, "workspaceId"),
        workspace_key_version: n(ctx, "workspaceKeyVersion"),
        grantee_user_id: s(ctx, "granteeUserId"),
        grantee_key_version: n(ctx, "granteeKeyVersion"),
        granter_user_id: s(ctx, "granterUserId"),
        roster_version: n(ctx, "rosterVersion"),
        roster_digest: s(ctx, "rosterDigest"),
    };
    if s(item, "kind") == "sealing" {
        let key = area_key_at(AREA, 1);
        let sealed = match lists {
            Some(lists) => company_area_grant_seal(
                key,
                ctx,
                chain,
                AREA_SEED.into(),
                reader.kem(),
                granter.keys.clone(),
                lists,
            ),
            // Without a list a company's folder key is sealed to nobody.
            None => area_grant_seal(key, ctx, chain, AREA_SEED.into(), reader.kem(), granter.keys.clone()),
        };
        return if sealed.is_ok() { "sealed".into() } else { "refused".into() };
    }
    let envelope = b(item, "envelope");
    let opened = match lists {
        Some(lists) => company_area_grant_open(
            envelope,
            ctx,
            chain,
            AREA_SEED.into(),
            granter.ml_dsa(),
            None,
            reader.user_id.clone(),
            1,
            reader.keys.clone(),
            lists,
        ),
        // Without a list a company's grant opens through nothing: the family opener refuses it.
        None => area_grant_open(
            envelope,
            ctx,
            chain,
            AREA_SEED.into(),
            granter.ml_dsa(),
            None,
            reader.user_id.clone(),
            1,
            reader.keys.clone(),
        ),
    };
    opened.map_or("refused".into(), |key| format!("opened:{}", e(&key)))
}

/* What this core says of a record item: the verdict of design 2.8, then the folder's own rows. */
pub fn record_item_verdict(folder: &Value, item: &Value, ml_dsa_keys: &HashMap<String, String>) -> Value {
    let input = folder_input(folder, ml_dsa_keys);
    let through = n(item, "through");
    let chain = chain_through(&input, through);
    let lists = folder_lists(folder, &input, through, &s(item, "lists"));
    let (writer, signer) = (person(n(item, "writer") as u8), person(n(item, "signedBy") as u8));
    let pin = (item["pinned"] == json!(true)).then(|| WriterPin::of(pinned(&writer), None));
    let trust = group_writer_trust(
        GROUP.into(),
        HashMap::from([(AREA.to_string(), 1)]),
        GroupReading::Accepted { chain: chain.clone() },
        AREA.into(),
        writer.user_id.clone(),
        pin,
        Some(served_keys(&writer)),
        Some(vec![]),
        None,
    );
    let integrity = group_metadata_integrity(
        trust.clone(),
        None,
        record_statement(),
        record_envelope(),
        Some(base64url_decode(record_signature(&signer)).unwrap()),
    );
    let standing =
        folder_standing(chain, lists, AREA.into(), writer.user_id.clone(), strings(&item["sharedEditors"]));
    let said = folder_integrity(integrity, trust, standing);
    let integrity = match said.verdict {
        FolderVerdict::Group { verdict } => group_verdict_name(verdict),
        FolderVerdict::NotOnThisFolder => "not-on-this-folder",
    };
    json!({ "integrity": integrity, "via": said.via })
}

/*
 * A company's folder written with this core's own builders, for the web to
 * read (`examples/company_fixtures.rs`): its Owner makes it with its first
 * folder and that folder's base list (roster 1), lets two Members in (2),
 * adds one to the folder as a manager, who adds the other as a viewer, a
 * third roster commits the folder's head, and a fourth changes the folder's
 * key, with a base list that leaves the viewer out. Every roster's heads come
 * from `heads_to_commit`, over what a device read. A device reads it before
 * and after each of those rosters. Returned as a list case, its expected
 * verdict this core's own.
 */
pub fn lists_made_here() -> Value {
    let (owner, member, biller) = (person(1), person(4), person(6));
    let people = [&owner, &member, &biller, &person(5)];
    let key = custody_public_key(custody_seed_at(1)).unwrap();
    let kit = kit_public_keys(kit_secret_at(1), GROUP.into()).unwrap();
    let mut ml_dsa_keys = served_ml_dsa(&people);
    ml_dsa_keys.extend(super::company::kit_ml_dsa_keys(&[1]));
    let mut input = CaseInput {
        first_keys: group_public_key(group_seed(1)).unwrap(),
        anchor: Some(GroupAnchor::Created),
        pins: vec![],
        rosters: vec![],
        successions: vec![],
        ml_dsa_keys: ml_dsa_keys.clone(),
        me: reader(),
        cache: None,
        record: None,
        next: None,
        root: None,
        join_mark: None,
        pair_marks: vec![],
        raw_cache: None,
        raw_marks: None,
    };
    let manager = |who: &Person| ListPerson { user_id: who.user_id.clone(), role: ListRole::Manager };
    let base_of = |people: Vec<ListPerson>, members: Vec<RosterMember>| BaseAreaList {
        group_id: GROUP.into(),
        workspace_id: AREA.into(),
        area_kind: AreaKind::Shared,
        everyone: None,
        people,
        signer_user_id: owner.user_id.clone(),
        signer_key_version: 1,
        members,
    };
    let signed_of = |at: &SignedListWithDigest| SignedAreaList {
        statement: at.statement.clone(),
        signature: at.signature.clone(),
    };
    let area_key = |version: u64, list_digest: &str| AreaKey {
        workspace_id: AREA.into(),
        workspace_key: area_key_at(AREA, version),
        root_key: Some(root_key_at(AREA, version)),
        area_kind: Some(AreaKind::Shared),
        list_digest: Some(list_digest.into()),
    };
    // The base list, before the company exists: it names no roster. The first roster's heads
    // are built from it.
    let base = area_list_base_sign(
        base_of(vec![manager(&owner)], vec![entry(1, &OWNER_ROLES)]),
        None,
        None,
        owner.keys.clone(),
    )
    .unwrap();
    let first_heads =
        heads_to_commit(None, GROUP.into(), None, vec![], vec![signed_of(&base)], vec![], HashMap::new())
            .unwrap();
    let mut served_heads = vec![ServedHeads { roster_version: 1, rows: first_heads.rows() }];
    let first = company_roster_first(
        GROUP.into(),
        entry(1, &OWNER_ROLES),
        Some(vec![area_key(1, &base.digest)]),
        FirstOrgRoster { custody_key: key, kit, rules: None, heads: first_heads.clone() },
    )
    .unwrap();
    input.rosters.push(roster_sign(first, group_seed(1), owner.keys.clone()).unwrap());
    let all = vec![entry(1, &OWNER_ROLES), entry(4, &[]), entry(6, &[GroupRole::Billing])];
    let mut served = vec![signed_of(&base)];
    // What a device reads at the latest roster: the heads, and the folder's list.
    let read = |input: &CaseInput, served_heads: &[ServedHeads], served: &[SignedAreaList]| {
        let chain = chain_through(input, input.rosters.len() as u64);
        let heads = heads_read(chain.clone(), None, served_heads.to_vec()).unwrap().record;
        let lists = area_lists_read(
            chain.clone(),
            Some(heads.clone()),
            AREA.into(),
            None,
            Some(served.to_vec()),
            ml_dsa_keys.clone(),
        )
        .unwrap();
        (chain, heads, lists)
    };
    let next = |chain: Arc<AcceptedRosters>, keys: Option<Vec<AreaKey>>, heads: Arc<CommittedHeads>| {
        let org = NextOrgRoster {
            custody_key: None,
            kit: None,
            rules: None,
            auto_utc_day: None,
            heads,
            checked: vec![],
        };
        company_roster_next(chain, all.clone(), owner.user_id.clone(), keys, None, org)
    };
    let commit = |chain: &Arc<AcceptedRosters>,
                  heads: &HeadsRecord,
                  lists: Vec<Arc<AreaLists>>,
                  changed: Vec<SignedAreaList>| {
        heads_to_commit(
            Some(chain.clone()),
            GROUP.into(),
            Some(heads.clone()),
            lists,
            changed,
            vec![],
            HashMap::new(),
        )
    };
    // Roster 2 lets the two Members in; the folder's head is the base list still.
    let (chain, heads, lists) = read(&input, &served_heads, &served);
    // Heads are built only over every folder read, and a roster takes only heads built for it.
    assert!(commit(&chain, &heads, vec![], vec![]).is_err(), "no heads over a folder left unread");
    assert!(next(chain.clone(), None, first_heads.clone()).is_err(), "heads built on another roster");
    assert!(next(chain.clone(), None, heads_unverified(first_heads.heads_digest())).is_ok());
    let second_heads = commit(&chain, &heads, vec![lists], vec![]).unwrap();
    served_heads.push(ServedHeads { roster_version: 2, rows: second_heads.rows() });
    let second = next(chain, None, second_heads).unwrap();
    input.rosters.push(roster_sign(second, group_seed(1), owner.keys.clone()).unwrap());
    // The Owner, an Admin on the list, adds a Member as a manager; that manager adds a viewer.
    let (chain, heads, _) = read(&input, &served_heads, &served);
    let sign = |served: &[SignedAreaList], who: &Person, person: ListPerson| {
        let (_, _, lists) = read(&input, &served_heads, served);
        area_list_addition_sign(
            chain.clone(),
            heads.clone(),
            lists,
            vec![person],
            None,
            who.user_id.clone(),
            who.keys.clone(),
        )
    };
    let viewer = |who: &Person| ListPerson { user_id: who.user_id.clone(), role: ListRole::Viewer };
    served.push(signed_of(&sign(&served, &owner, manager(&member)).unwrap()));
    let head = sign(&served, &member, viewer(&biller)).unwrap();
    served.push(signed_of(&head));
    // What verification refuses is never signed: a viewer adds nobody, nobody is taken off,
    // nobody outside the company is added, and an addition that changes nothing is none.
    assert!(sign(&served, &biller, manager(&person(5))).is_err(), "a viewer signs no addition");
    assert!(sign(&served, &member, viewer(&owner)).is_err(), "an addition lowers no role");
    assert!(sign(&served, &member, manager(&person(5))).is_err(), "an addition names only active members");
    let nothing = sign(&served, &member, viewer(&biller)).unwrap_err();
    assert_eq!(nothing.to_string(), "This adds nobody and raises no role on the folder’s list.");
    // Roster 3 commits the folder's head as the Owner's device verified it.
    let (chain, heads, lists) = read(&input, &served_heads, &served);
    let third_heads = commit(&chain, &heads, vec![lists], vec![]).unwrap();
    served_heads.push(ServedHeads { roster_version: 3, rows: third_heads.rows() });
    input.rosters.push(
        roster_sign(next(chain, None, third_heads).unwrap(), group_seed(1), owner.keys.clone()).unwrap(),
    );
    // Roster 4 changes the folder's key: a base list without the viewer, numbered past the head.
    let (chain, heads, lists) = read(&input, &served_heads, &served);
    let rotated = area_list_base_sign(
        base_of(vec![manager(&owner), manager(&member)], vec![]),
        Some(chain.clone()),
        Some(lists.clone()),
        owner.keys.clone(),
    )
    .unwrap();
    let parsed = area_list_parse(rotated.statement.clone()).unwrap();
    assert_eq!(
        (parsed.list_version, parsed.workspace_key_version),
        (4, 2),
        "one past the head, at the next key"
    );
    // The heads for a key change are built with its base list, and fit that roster alone.
    let unchanged = commit(&chain, &heads, vec![lists], vec![]).unwrap();
    assert!(next(chain.clone(), Some(vec![area_key(2, &rotated.digest)]), unchanged).is_err());
    let fourth_heads = commit(&chain, &heads, vec![], vec![signed_of(&rotated)]).unwrap();
    served_heads.push(ServedHeads { roster_version: 4, rows: fourth_heads.rows() });
    let fourth = next(chain, Some(vec![area_key(2, &rotated.digest)]), fourth_heads).unwrap();
    input.rosters.push(roster_sign(fourth, group_seed(1), owner.keys.clone()).unwrap());
    let latest = chain_through(&input, 4);
    let digest_of = |text: &str| roster_digest(text.as_bytes().to_vec());
    let dismissal = fork_dismissal_sign(
        ForkDismissal {
            group_id: GROUP.into(),
            workspace_id: AREA.into(),
            kind: ForkKind::List,
            committed_position: 3,
            committed_digest: head.digest.clone(),
            reported_position: 3,
            reported_digest: digest_of("a list this device held"),
            signer_user_id: owner.user_id.clone(),
            signer_key_version: 1,
            roster_version: 4,
            roster_digest: latest.roster_digest(),
        },
        latest,
        owner.keys.clone(),
    )
    .unwrap();
    let lists_json = |served: &[SignedAreaList]| {
        served.iter().map(|at| signed_json(&at.statement, &at.signature)).collect::<Vec<_>>()
    };
    let probes = |dismissed: bool| {
        let mut probes = json!({
            "access": [
                { "userId": owner.user_id }, { "userId": member.user_id }, { "userId": biller.user_id },
                { "userId": person(5).user_id }, { "userId": owner.user_id, "session": "browse" },
            ],
            "owed": true,
            "grants": {},
            "writable": true,
            "standing": [{ "writerUserId": member.user_id }, { "writerUserId": biller.user_id }],
        });
        if dismissed {
            probes["dismissals"] = json!([{
                "statement": e(&dismissal.statement), "signature": e(&dismissal.signature), "signer": 1, "keyVersion": 1,
            }]);
        }
        probes
    };
    let mut case = case_json("lists-made-by-the-core", &input, &Value::Null);
    case["heads"] = json!(served_heads
        .iter()
        .map(|at| json!({ "rosterVersion": at.roster_version, "rows": at.rows.iter().map(head_row_json).collect::<Vec<_>>() }))
        .collect::<Vec<_>>());
    case["steps"] = json!([
        { "through": 2, "workspaceId": AREA, "served": lists_json(&served), "probes": probes(false) },
        { "through": 3, "workspaceId": AREA, "served": lists_json(&served), "probes": probes(false) },
        { "through": 4, "workspaceId": AREA, "served": lists_json(&[signed_of(&rotated)]), "probes": probes(true) },
    ]);
    case["expected"] = list_case_verdict(&case, &input.ml_dsa_keys);
    assert_eq!(
        case["expected"][0]["lists"]["state"],
        json!("ahead"),
        "two lists past the base the roster committed"
    );
    assert_eq!(case["expected"][1]["lists"]["state"], json!("level"), "the third roster commits them");
    assert_eq!(case["expected"][2]["lists"]["state"], json!("level"), "the fourth changes the key");
    assert_eq!(case["expected"][2]["lists"]["listVersion"], json!(4));
    case
}
