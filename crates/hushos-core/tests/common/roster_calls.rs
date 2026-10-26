//! Roster calls (groups 1d, Core 5a), for the shared fixtures: the twin of
//! `packages/crypto/src/roster-calls-testkit.ts`. Both twins build the same
//! family from the same people (group testkit persons 1 to 5) and keys, the
//! same calls in the same order through their own code (here the
//! [`AreaLedger`] builders, there the worker's `groupStage` and
//! `groupGrants`), write the history they signed, the bodies, and the outbox
//! entries their own code sealed, and read the other twin's document through
//! their own code:
//!
//! - `calls`: each body verified as every member and the server would take
//!   it (the next roster, its succession, every seal and grant opened by its
//!   holder to the key it must be), to the declared verdict; a refusal must
//!   be the same sentence;
//! - `grantCalls`: owed grants (`grants_body`, the worker's `groupGrants`),
//!   each opened by its grantee to the folder's key at its version;
//! - `joinCodes`: the admin's join code (`member_join_code`, the worker's
//!   `groupJoinCode`) over the family's history, the contact pin as filed;
//! - `outboxEntries`: entries each twin sealed under person 1's device store,
//!   read by the other's reader (`outbox_open`, `readOutboxEntry`) against a
//!   committed head.
//!
//! The family is replayable on the server's routes (`packages/groups/src/server.test.ts`
//! stores it and posts every body): a group id derived under person 1, roster 1
//! creating A1, 2 admitting person 2, 3 admitting person 3 with members, 4
//! creating A2, 5 deleting A2, 6 creating A3, 7 rotating A3 to key version 2.
//! Persons 4 and 5 wait to be let in. Person 1 holds a contact pin of everyone.
#![allow(dead_code)]

use super::device_records::root;
use super::groups::{e, pattern, person, s, served_keys, signed_json, signed_of, History, Person, CHECKED};
use hushos_core::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

pub struct Family {
    pub p: Vec<Person>,
    pub group_id: String,
    pub group_seed: String,
    /* (workspace id, id seed) of A1, A2 (deleted) and A3. */
    pub areas: Vec<(String, String)>,
    pub h: History,
}

/* The key the family gives an area at a version: A1 at 1, A2 at 1, A3 at 1 and 2. */
pub fn area_key(index: usize, version: u64) -> Vec<u8> {
    pattern(32, (120 + index as u64 * 2 + version - 1) as u8)
}
fn root_key(index: usize, version: u64) -> Vec<u8> {
    pattern(32, (140 + index as u64 * 2 + version - 1) as u8)
}

fn row(f_areas: &[(String, String)], index: usize, version: u64) -> RosterArea {
    RosterArea {
        workspace_id: f_areas[index].0.clone(),
        workspace_key_version: version,
        commitment: area_key_commitment(&area_key(index, version)).unwrap(),
        root_commitment: Some(area_root_commitment(&root_key(index, version)).unwrap()),
        retired: false,
    }
}

pub fn family() -> &'static Family {
    static FAMILY: OnceLock<Family> = OnceLock::new();
    FAMILY.get_or_init(|| {
        let p: Vec<Person> = (1..=5).map(person).collect();
        let group_seed = e(&pattern(16, 40));
        let group_id = derive_id(IdKind::Group, p[0].user_id.clone(), group_seed.clone()).unwrap();
        let areas: Vec<(String, String)> = (0..3)
            .map(|i| {
                let seed = e(&pattern(16, 41 + i));
                (derive_id(IdKind::Workspace, group_id.clone(), seed.clone()).unwrap(), seed)
            })
            .collect();
        let mut h = History { format: 2, group_id: group_id.clone(), ..History::new() };
        let owner = p[0].entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active);
        let p2 = p[1].entry(&[], 1, MemberStatus::Active);
        let p3 = p[2].entry(&[GroupRole::Members], 1, MemberStatus::Active);
        let all = vec![owner.clone(), p2.clone(), p3.clone()];
        h.roster_with(&p[0], vec![owner.clone()], None, Some(vec![row(&areas, 0, 1)]));
        h.roster_with(&p[0], vec![owner.clone(), p2.clone()], None, Some(vec![]));
        h.roster_with(&p[0], all.clone(), None, Some(vec![]));
        h.roster_with(&p[0], all.clone(), None, Some(vec![row(&areas, 1, 1)]));
        h.roster_with(
            &p[0],
            all.clone(),
            None,
            Some(vec![RosterArea {
                workspace_id: areas[1].0.clone(),
                workspace_key_version: 2,
                commitment: String::new(),
                root_commitment: None,
                retired: true,
            }]),
        );
        h.roster_with(&p[0], all.clone(), None, Some(vec![row(&areas, 2, 1)]));
        h.roster_with(&p[0], all, None, Some(vec![row(&areas, 2, 2)]));
        Family { p, group_id, group_seed, areas, h }
    })
}

pub fn people() -> Vec<&'static Person> {
    family().p.iter().collect()
}

pub fn ml_dsa_keys() -> HashMap<String, String> {
    super::groups::served_ml_dsa(&people())
}

/* A history's chain, accepted from version 1 by a reader outside the family. */
pub fn chain_of(
    first_keys: GroupPublicKey,
    group_id: &str,
    rosters: Vec<SignedGroupStatement>,
    successions: Vec<SignedGroupStatement>,
) -> Arc<AcceptedRosters> {
    let reader = OwnIdentities { user_id: "ffffffff-ffff-4fff-8fff-ffffffffffff".into(), identities: vec![] };
    match accept_rosters(
        group_id.into(),
        first_keys,
        Some(GroupAnchor::Created),
        vec![],
        rosters,
        successions,
        ml_dsa_keys(),
        reader,
        None,
    )
    .unwrap()
    {
        RosterChain::Accepted { chain } => chain,
        fork => panic!("{fork:?}"),
    }
}

pub fn me(n: usize) -> OwnIdentities {
    let p = &family().p[n - 1];
    OwnIdentities { user_id: p.user_id.clone(), identities: vec![served_keys(p)] }
}

/* Person `n`'s identity envelope under the shared device root: what their phone opened. */
pub fn envelope(n: usize) -> IdentityEnvelope {
    let p = &family().p[n - 1];
    identity_wrap(p.user_id.clone(), root(), &p.keys).unwrap()
}

/* Person `n`'s version 3 pin, as comparing their words writes it. */
pub fn pin(n: usize) -> VerifiedPin {
    let p = &family().p[n - 1];
    VerifiedPin {
        user_id: p.user_id.clone(),
        key_version: 1,
        encryption_public_key: p.served.encryption_public_key.clone(),
        signing_public_key: p.served.signing_public_key.clone(),
        ml_dsa_public_key_hash: key_digest(p.ml_dsa()),
        kem_public_key_hash: key_digest(p.kem()),
        fingerprint: identity_fingerprint_of_keys(
            base64url_decode(p.served.encryption_public_key.clone()).unwrap(),
            base64url_decode(p.served.signing_public_key.clone()).unwrap(),
            p.ml_dsa(),
            p.kem(),
        )
        .unwrap(),
        trusted_via: None,
    }
}

/* The contact pins a person's settings hold: everyone but themself, or `filed` (who, whose keys) alone. */
fn contacts(of: usize, filed: Option<Vec<(usize, usize)>>) -> HashMap<String, VerifiedPin> {
    let f = family();
    let filed = filed.unwrap_or_else(|| (1..=5).filter(|n| *n != of).map(|n| (n, n)).collect());
    filed
        .into_iter()
        .map(|(who, keys)| {
            let user_id = f.p[who - 1].user_id.clone();
            (user_id.clone(), VerifiedPin { user_id, ..pin(keys) })
        })
        .collect()
}

/* The served chain of `rosters` (all from version 1). */
pub fn served_of(first_keys: GroupPublicKey, rosters: Vec<SignedGroupStatement>) -> ServedChain {
    ServedChain { after: 0, first_keys, rosters, successions: vec![], signer_keys: ml_dsa_keys() }
}

/*
 * Person `n`'s phone: the account open under the shared root, the settings
 * (the group pin at the head, `filed` contact pins or everyone's), `rosters`
 * served and committed (the family's history by default); with `seed` the
 * group key opened from person 1's seal to them; with `area` A1 and A3 opened.
 */
pub fn ledger_with(
    n: usize,
    filed: Option<Vec<(usize, usize)>>,
    rosters: Option<Vec<SignedGroupStatement>>,
    seed: bool,
    area: bool,
) -> Arc<AreaLedger> {
    let f = family();
    let p = &f.p[n - 1];
    let ledger = AreaLedger::new();
    let signing = base64url_decode(p.served.signing_public_key.clone()).unwrap();
    ledger.open_account(p.user_id.clone(), signing, root()).unwrap();
    let rosters = rosters.unwrap_or_else(|| f.h.rosters.clone());
    let chain = chain_of(f.h.key(1), &f.group_id, rosters.clone(), vec![]);
    let pin_now = pin_after(vec![], Arc::clone(&chain), CHECKED.into()).unwrap();
    ledger
        .use_settings(p.user_id.clone(), Some([(f.group_id.clone(), pin_now)].into()), contacts(n, filed))
        .unwrap();
    let accepted = ledger.accept_served(
        me(n),
        f.group_id.clone(),
        None,
        served_of(f.h.key(1), rosters),
        FamilyGuard::Absent,
        CHECKED.into(),
    );
    assert!(matches!(accepted, Ok(ServedAcceptance::Accepted { .. })), "{accepted:?}");
    if seed {
        let p1 = &f.p[0];
        let ctx = GroupKeySealContext {
            group_id: f.group_id.clone(),
            group_key_version: 1,
            holder_user_id: p.user_id.clone(),
            holder_key_version: 1,
            sealer_user_id: p1.user_id.clone(),
            roster_version: chain.roster().roster_version,
            roster_digest: chain.roster_digest(),
        };
        let sealed = group_key_seal(
            super::groups::group_seed(1),
            ctx.clone(),
            Arc::clone(&chain),
            p.kem(),
            p1.keys.clone(),
        )
        .unwrap();
        let seal = ServedKeySeal {
            group_key_version: 1,
            holder_key_version: 1,
            sealer_user_id: p1.user_id.clone(),
            roster_version: ctx.roster_version,
            roster_digest: ctx.roster_digest,
            envelope: sealed,
        };
        ledger.open_group_key(me(n), f.group_id.clone(), seal, p1.ml_dsa(), None, envelope(n)).unwrap();
    }
    if area {
        let (a1, a1_seed) = &f.areas[0];
        let (a3, a3_seed) = &f.areas[2];
        ledger.open_area(f.group_id.clone(), a1.clone(), a1_seed.clone(), 1, area_key(0, 1), 1).unwrap();
        ledger.open_area(f.group_id.clone(), a3.clone(), a3_seed.clone(), 2, area_key(2, 2), 2).unwrap();
    }
    ledger
}

pub fn ledger(seed: bool, area: bool) -> Arc<AreaLedger> {
    ledger_with(1, None, None, seed, area)
}

/* The calls, in the order both twins build them. */
pub fn call_specs() -> Vec<Value> {
    let f = family();
    let u = |n: usize| f.p[n - 1].user_id.clone();
    let changed = |n: usize, roles: &[&str]| json!({ "userId": u(n), "status": "active", "roles": roles });
    let a1 = &f.areas[0].0;
    let a3 = &f.areas[2].0;
    let grants = |n: usize| {
        let mut out = vec![
            json!({ "userId": u(n), "workspaceId": a1, "version": 1 }),
            json!({ "userId": u(n), "workspaceId": a3, "version": 2 }),
        ];
        out.sort_by_key(|grant| grant.to_string());
        out
    };
    vec![
        json!({ "name": "admit-member", "op": { "kind": "admit", "who": 4, "roles": [] },
            "expected": { "route": { "kind": "admit", "userId": u(4) }, "rosterVersion": 8, "groupKeyVersion": 1,
                "changed": [changed(4, &[])], "keySeal": null, "seals": [], "grants": grants(4) } }),
        json!({ "name": "admit-manager", "op": { "kind": "admit", "who": 5, "roles": ["members"] },
            "expected": { "route": { "kind": "admit", "userId": u(5) }, "rosterVersion": 8, "groupKeyVersion": 1,
                "changed": [changed(5, &["members"])], "keySeal": u(5), "seals": [], "grants": grants(5) } }),
        json!({ "name": "grant-members", "op": { "kind": "grant", "who": 2 },
            "expected": { "route": { "kind": "member", "userId": u(2) }, "rosterVersion": 8, "groupKeyVersion": 1,
                "changed": [changed(2, &["members"])], "keySeal": u(2), "seals": [], "grants": [] } }),
        json!({ "name": "take-members", "op": { "kind": "take", "who": 3 },
            "expected": { "route": { "kind": "member", "userId": u(3) }, "rosterVersion": 8, "groupKeyVersion": 2,
                "changed": [changed(3, &[])], "keySeal": null, "seals": [u(1)], "grants": [] } }),
        json!({ "name": "handover-to", "op": { "kind": "handover", "who": 2 },
            "expected": { "route": { "kind": "member", "userId": u(2) }, "rosterVersion": 8, "groupKeyVersion": 1,
                "changed": [changed(2, &["billing"])], "keySeal": null, "seals": [], "grants": [] } }),
        json!({ "name": "refused-already-in", "op": { "kind": "admit", "who": 2, "roles": [] },
            "refused": "This person is in the family already." }),
        json!({ "name": "refused-not-checked", "op": { "kind": "admit", "who": 4, "roles": [], "filed": [] },
            "refused": "Check their words first." }),
        json!({ "name": "refused-unchecked-keys", "op": { "kind": "admit", "who": 5, "roles": [], "filed": [[5, 4]] },
            "refused": "These are not the keys whose words were checked." }),
        json!({ "name": "refused-not-in", "op": { "kind": "grant", "who": 4 },
            "refused": "This person is not in the family now." }),
        json!({ "name": "refused-unchanged", "op": { "kind": "grant", "who": 3 },
            "refused": "That doesn’t change their roles." }),
        json!({ "name": "refused-step-down", "op": { "kind": "stepDown" },
            "refused": "Make someone else the organizer first." }),
        json!({ "name": "refused-take-from-oneself", "op": { "kind": "take", "who": 1 },
            "refused": "Ask another manager to take this role from you." }),
        json!({ "name": "refused-not-a-manager", "op": { "kind": "take", "who": 3, "as": 2 },
            "refused": "Only someone who manages the family can change its members." }),
        json!({ "name": "refused-no-seed", "op": { "kind": "grant", "who": 2, "noSeed": true },
            "refused": "Open the family’s key first." }),
        json!({ "name": "refused-folder-not-opened", "op": { "kind": "admit", "who": 4, "roles": [], "noArea": true },
            "refused": "Open every family folder first." }),
    ]
}

fn roles_of(value: &Value) -> Vec<GroupRole> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|role| match role.as_str().unwrap() {
            "members" => GroupRole::Members,
            "billing" => GroupRole::Billing,
            "guardian" => GroupRole::Guardian,
            other => panic!("{other}"),
        })
        .collect()
}

fn filed_of(op: &Value) -> Option<Vec<(usize, usize)>> {
    op.get("filed").and_then(Value::as_array).map(|list| {
        list.iter()
            .map(|pair| (pair[0].as_u64().unwrap() as usize, pair[1].as_u64().unwrap() as usize))
            .collect()
    })
}

/* The worker's words for a typed answer, so both twins' outcomes compare. */
fn worded(answer: RosterCall) -> Result<StagedCall, String> {
    match answer {
        RosterCall::Staged { call } => Ok(call),
        RosterCall::OpenKeyFirst => Err("Open the family’s key first.".into()),
        RosterCall::OpenFoldersFirst => Err("Open every family folder first.".into()),
        RosterCall::SyncFirst => Err("Check the family’s member list first.".into()),
    }
}

/* One call through this core's builders, on `ledger` (one made as the op says when none): the staged call, or the refusal's sentence. */
pub fn run_on(ledger: Option<Arc<AreaLedger>>, op: &Value) -> Result<StagedCall, String> {
    run_at(ledger, op, 7).map_err(|(_, message)| message)
}

/* The same at `revision`, the typed answer kept beside the worded one (`first`: what to do first). */
pub fn run_at(
    ledger: Option<Arc<AreaLedger>>,
    op: &Value,
    revision: u64,
) -> Result<StagedCall, (Option<&'static str>, String)> {
    let f = family();
    let by = op["as"].as_u64().unwrap_or(1) as usize;
    let ledger = ledger.unwrap_or_else(|| {
        ledger_with(
            by,
            filed_of(op),
            None,
            by != 2 && op["noSeed"] != json!(true),
            op["noArea"] != json!(true),
        )
    });
    let who = op["who"].as_u64().map(|n| n as usize);
    let kems: HashMap<String, String> =
        f.p.iter().map(|p| (p.user_id.clone(), p.served.kem_public_key.clone())).collect();
    let user = |n: usize| f.p[n - 1].user_id.clone();
    let result = match op["kind"].as_str().unwrap() {
        "admit" => {
            let mut served = f.p[who.unwrap() - 1].served.clone();
            if let Some(over) = op.get("served").and_then(Value::as_object) {
                for (key, value) in over {
                    let text = || value.as_str().map(str::to_string).unwrap_or_default();
                    match key.as_str() {
                        "keyVersion" => served.key_version = value.as_u64().unwrap_or(0),
                        "encryptionPublicKey" => served.encryption_public_key = text(),
                        "signingPublicKey" => served.signing_public_key = text(),
                        "mlDsaPublicKey" => served.ml_dsa_public_key = text(),
                        "kemPublicKey" => served.kem_public_key = text(),
                        "keysSignature" => served.keys_signature = text(),
                        _ => {}
                    }
                }
            }
            ledger.admit_body(
                me(by),
                envelope(by),
                f.group_id.clone(),
                revision,
                user(who.unwrap()),
                served,
                roles_of(&op["roles"]),
                HashMap::new(),
            )
        }
        "grant" => ledger.roles_body(
            me(by),
            envelope(by),
            f.group_id.clone(),
            revision,
            user(who.unwrap()),
            MembersRole::Grant,
            kems,
        ),
        "take" => ledger.roles_body(
            me(by),
            envelope(by),
            f.group_id.clone(),
            revision,
            user(who.unwrap()),
            MembersRole::Take,
            kems,
        ),
        "handover" => ledger.handover_body(
            me(by),
            envelope(by),
            f.group_id.clone(),
            revision,
            Handover::To { user_id: user(who.unwrap()) },
            kems,
        ),
        "stepDown" => {
            ledger.handover_body(me(by), envelope(by), f.group_id.clone(), revision, Handover::StepDown, kems)
        }
        other => panic!("{other}"),
    };
    match result {
        Ok(answer) => {
            let first = match &answer {
                RosterCall::Staged { .. } => None,
                RosterCall::OpenKeyFirst => Some("open-key"),
                RosterCall::OpenFoldersFirst => Some("open-folders"),
                RosterCall::SyncFirst => Some("sync"),
            };
            worded(answer).map_err(|message| (first, message))
        }
        Err(error) => Err((None, error.to_string())),
    }
}

pub fn run(op: &Value) -> Result<StagedCall, String> {
    run_on(None, op)
}

fn person_of(user_id: &str) -> &'static Person {
    family().p.iter().find(|p| p.user_id == user_id).unwrap()
}

fn first_keys_of(doc: &Value) -> GroupPublicKey {
    GroupPublicKey {
        ed25519_public_key: s(&doc["family"]["firstKeys"], "ed25519PublicKey"),
        ml_dsa_public_key: s(&doc["family"]["firstKeys"], "mlDsaPublicKey"),
    }
}

fn history_of(doc: &Value) -> Vec<SignedGroupStatement> {
    doc["family"]["rosters"].as_array().unwrap().iter().map(signed_of).collect()
}

/* A grant opened by its grantee to the key of the folder at its version, by `granter`; its verdict entry. */
fn open_grant(doc: &Value, chain: &Arc<AcceptedRosters>, grant: &Value, granter: &Person) -> Value {
    let f = family();
    let grantee = person_of(grant["granteeUserId"].as_str().unwrap());
    let workspace_id = s(grant, "workspaceId");
    let version = grant["workspaceKeyVersion"].as_u64().unwrap();
    let index = doc["family"]["areas"]
        .as_array()
        .unwrap()
        .iter()
        .position(|a| a["workspaceId"] == json!(workspace_id))
        .unwrap();
    let key = area_grant_open(
        base64url_decode(s(grant, "envelope")).unwrap(),
        AreaGrantContext {
            group_id: s(&doc["family"], "groupId"),
            workspace_id: workspace_id.clone(),
            workspace_key_version: version,
            grantee_user_id: grantee.user_id.clone(),
            grantee_key_version: grant["granteeKeyVersion"].as_u64().unwrap(),
            granter_user_id: granter.user_id.clone(),
            roster_version: grant["rosterVersion"].as_u64().unwrap(),
            roster_digest: s(grant, "rosterDigest"),
        },
        Arc::clone(chain),
        doc["family"]["areas"][index]["idSeed"].as_str().unwrap().into(),
        granter.ml_dsa(),
        None,
        grantee.user_id.clone(),
        1,
        grantee.keys.clone(),
    )
    .expect("the grant opens");
    assert_eq!(key.to_vec(), area_key(index, version), "the grant is of that folder's key at that version");
    let _ = f;
    json!({ "userId": grantee.user_id, "workspaceId": workspace_id, "version": version })
}

/*
 * A body as every member and the server take it, from the family's history in
 * `doc`: the roster the next on the chain (every changed entry one of its
 * member's identities), its succession replacing the key, every seal opened
 * by its holder to the seed of the key the chain has after the call, every
 * grant opened by its grantee to the folder's key at its version. The verdict
 * both twins declare.
 */
pub fn verdict(doc: &Value, route: &Value, body: &Value) -> Value {
    let f = family();
    let group_id = s(&doc["family"], "groupId");
    let first_keys = first_keys_of(doc);
    let history = history_of(doc);
    let chain = chain_of(first_keys.clone(), &group_id, history.clone(), vec![]);
    let roster = signed_of(&body["roster"]);
    let identities: HashMap<String, Vec<PublicIdentity>> =
        f.p.iter().map(|p| (p.user_id.clone(), vec![p.served.clone()])).collect();
    roster_check_next(Arc::clone(&chain), roster.clone(), ml_dsa_keys(), Some(identities))
        .expect("the next roster");
    let mut rosters = history;
    rosters.push(roster);
    let successions: Vec<SignedGroupStatement> = body.get("succession").map(signed_of).into_iter().collect();
    let after = chain_of(first_keys, &group_id, rosters, successions);
    let p1 = &f.p[0];
    let open_seal = |seal: &Value| -> String {
        let holder = person_of(seal["holderUserId"].as_str().unwrap());
        let ctx = GroupKeySealContext {
            group_id: group_id.clone(),
            group_key_version: seal["groupKeyVersion"].as_u64().unwrap(),
            holder_user_id: holder.user_id.clone(),
            holder_key_version: seal["holderKeyVersion"].as_u64().unwrap(),
            sealer_user_id: p1.user_id.clone(),
            roster_version: seal["rosterVersion"].as_u64().unwrap(),
            roster_digest: s(seal, "rosterDigest"),
        };
        let seed = group_key_open(
            base64url_decode(s(seal, "envelope")).unwrap(),
            ctx,
            Arc::clone(&after),
            p1.ml_dsa(),
            None,
            holder.user_id.clone(),
            1,
            holder.keys.clone(),
        )
        .expect("the seal opens");
        assert_eq!(
            group_public_key(seed.to_vec()).unwrap(),
            after.group_key(),
            "the seal is of the key after the call"
        );
        holder.user_id.clone()
    };
    let mut seals: Vec<String> =
        body["seals"].as_array().map(|list| list.iter().map(open_seal).collect()).unwrap_or_default();
    seals.sort();
    let key_seal = body.get("keySeal").map(open_seal);
    let mut grants: Vec<Value> = body["grants"]
        .as_array()
        .map(|list| list.iter().map(|grant| open_grant(doc, &after, grant, p1)).collect())
        .unwrap_or_default();
    grants.sort_by_key(|grant| grant.to_string());
    let mut changed: Vec<Value> = after
        .roster()
        .members
        .iter()
        .filter(|entry| entry.since_version == after.roster().roster_version)
        .map(|entry| {
            let roles: Vec<&str> = entry
                .roles
                .iter()
                .map(|role| match role {
                    GroupRole::Billing => "billing",
                    GroupRole::Members => "members",
                    GroupRole::Guardian => "guardian",
                    _ => "other",
                })
                .collect();
            let status = if entry.status == MemberStatus::Active { "active" } else { "left" };
            json!({ "userId": entry.user_id, "status": status, "roles": roles })
        })
        .collect();
    changed.sort_by_key(|entry| entry.to_string());
    json!({
        "route": route,
        "rosterVersion": after.roster().roster_version,
        "groupKeyVersion": after.group_key_version(),
        "changed": changed,
        "keySeal": key_seal,
        "seals": seals,
        "grants": grants,
    })
}

pub fn route_json(route: &ChainRoute) -> Value {
    match route {
        ChainRoute::Admit { user_id } => json!({ "kind": "admit", "userId": user_id }),
        ChainRoute::Member { user_id } => json!({ "kind": "member", "userId": user_id }),
        ChainRoute::Remove { user_id } => json!({ "kind": "remove", "userId": user_id }),
        ChainRoute::Create => json!({ "kind": "create" }),
        ChainRoute::Rosters => json!({ "kind": "rosters" }),
        ChainRoute::Areas => json!({ "kind": "areas" }),
        ChainRoute::Rotation { workspace_id } => json!({ "kind": "rotation", "workspaceId": workspace_id }),
        ChainRoute::Delete { workspace_id } => json!({ "kind": "delete", "workspaceId": workspace_id }),
    }
}

pub fn family_json() -> Value {
    let f = family();
    let first = f.h.key(1);
    json!({
        "groupId": f.group_id,
        "groupIdSeed": f.group_seed,
        "firstKeys": { "ed25519PublicKey": first.ed25519_public_key, "mlDsaPublicKey": first.ml_dsa_public_key },
        "areas": f.areas.iter().map(|(id, seed)| json!({ "workspaceId": id, "idSeed": seed })).collect::<Vec<_>>(),
        "rosters": f.h.rosters.iter().map(signed_json).collect::<Vec<_>>(),
        "expectedRevision": 7,
    })
}

/* Owed grants, in the order both twins build them: who owes (any active member), and to whom which folder. */
pub fn grant_specs() -> Vec<Value> {
    let f = family();
    let u = |n: usize| f.p[n - 1].user_id.clone();
    let (a1, a3) = (&f.areas[0].0, &f.areas[2].0);
    let mut owed = vec![
        json!({ "userId": u(3), "workspaceId": a1, "version": 1 }),
        json!({ "userId": u(3), "workspaceId": a3, "version": 2 }),
        json!({ "userId": u(1), "workspaceId": a3, "version": 2 }),
    ];
    owed.sort_by_key(|grant| grant.to_string());
    vec![
        json!({ "name": "a-member-pays-what-is-owed", "as": 2, "missing": [[0, 3], [2, 3], [2, 1]], "expected": owed }),
        json!({ "name": "refused-to-someone-not-in", "as": 2, "missing": [[0, 4]],
            "refused": "Areas are granted only to active members." }),
    ]
}

/* Owed grants through this core: the request bodies, or the refusal's sentence. */
pub fn grant_run(spec: &Value) -> Result<Vec<GrantsRequest>, String> {
    let f = family();
    let by = spec["as"].as_u64().unwrap() as usize;
    let ledger = ledger_with(by, None, None, false, true);
    let missing = spec["missing"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| {
            let (area, who) = (pair[0].as_u64().unwrap() as usize, pair[1].as_u64().unwrap() as usize);
            OwedGrant {
                workspace_id: f.areas[area].0.clone(),
                user_id: f.p[who - 1].user_id.clone(),
                kem_public_key: f.p[who - 1].served.kem_public_key.clone(),
            }
        })
        .collect();
    match ledger.grants_body(me(by), envelope(by), f.group_id.clone(), missing) {
        Ok(GrantsCall::Grants { requests }) => Ok(requests),
        Ok(other) => Err(format!("{other:?}")),
        Err(error) => Err(error.to_string()),
    }
}

/* Route 22 bodies (by folder), each grant opened by its grantee, as the twins declare them. */
pub fn grants_verdict(doc: &Value, by: usize, requests: &Value) -> Value {
    let f = family();
    let chain = chain_of(first_keys_of(doc), &s(&doc["family"], "groupId"), history_of(doc), vec![]);
    let mut out: Vec<Value> = vec![];
    for request in requests.as_array().unwrap() {
        let body: Value = serde_json::from_str(request["body"].as_str().unwrap()).unwrap();
        for grant in body["grants"].as_array().unwrap() {
            assert_eq!(grant["workspaceId"], request["workspaceId"], "a request is one folder's");
            out.push(open_grant(doc, &chain, grant, &f.p[by - 1]));
        }
    }
    out.sort_by_key(|grant| grant.to_string());
    Value::Array(out)
}

fn requests_json(requests: &[GrantsRequest]) -> Value {
    Value::Array(requests.iter().map(|r| json!({ "workspaceId": r.workspace_id, "body": r.body })).collect())
}

/* The admin's join codes over the family: (name, who, the contact filed for them, which rosters, expected). */
pub fn join_specs(doc: &Value) -> Vec<Value> {
    let history = history_of(doc);
    let first_keys = first_keys_of(doc);
    let code = |version: usize| {
        join_code(roster_digest(history[version - 1].statement.clone()), first_keys.clone(), 1).unwrap()
    };
    vec![
        json!({ "name": "let-in-at-2", "who": 2, "keys": 2, "rosters": "all",
            "expected": { "status": "code", "rosterVersion": 2, "code": code(2) } }),
        json!({ "name": "let-in-at-3", "who": 3, "keys": 3, "rosters": "all",
            "expected": { "status": "code", "rosterVersion": 3, "code": code(3) } }),
        json!({ "name": "the-organizer-at-1", "who": 1, "keys": 1, "rosters": "all",
            "expected": { "status": "code", "rosterVersion": 1, "code": code(1) } }),
        json!({ "name": "other-keys-pinned", "who": 2, "keys": 3, "rosters": "all",
            "expected": { "status": "other-keys", "rosterVersion": 2 } }),
        json!({ "name": "never-checked", "who": 2, "keys": null, "rosters": "all", "expected": { "status": "not-pinned" } }),
        json!({ "name": "not-let-in", "who": 4, "keys": 4, "rosters": "all", "expected": { "status": "not-admitted" } }),
        json!({ "name": "a-roster-of-the-run-left-out", "who": 2, "keys": 2, "rosters": "without-2",
            "expected": { "status": "refused", "message": "The server left out part of the family’s member list." } }),
        json!({ "name": "junk-beside-the-chain", "who": 2, "keys": 2, "rosters": "with-junk",
            "expected": { "status": "code", "rosterVersion": 2, "code": code(2) } }),
    ]
}

/*
 * Person 1's ledger that committed `doc`'s history (its rosters served and
 * accepted as this core accepts them), with `filed` contacts: where the
 * admin's join code and an outbox entry are read.
 */
pub fn committed_ledger(
    doc: &Value,
    filed: Vec<(usize, usize)>,
    extra: Option<SignedGroupStatement>,
) -> Arc<AreaLedger> {
    let f = family();
    let p1 = &f.p[0];
    let group_id = s(&doc["family"], "groupId");
    let first_keys = first_keys_of(doc);
    let mut history = history_of(doc);
    history.extend(extra);
    let ledger = AreaLedger::new();
    ledger
        .open_account(
            p1.user_id.clone(),
            base64url_decode(p1.served.signing_public_key.clone()).unwrap(),
            root(),
        )
        .unwrap();
    let chain = chain_of(first_keys.clone(), &group_id, history.clone(), vec![]);
    let pin_now = pin_after(vec![], chain, CHECKED.into()).unwrap();
    ledger
        .use_settings(
            p1.user_id.clone(),
            Some([(group_id.clone(), pin_now)].into()),
            contacts(1, Some(filed)),
        )
        .unwrap();
    let accepted = ledger
        .accept_served(
            me(1),
            group_id,
            None,
            served_of(first_keys, history),
            FamilyGuard::Absent,
            CHECKED.into(),
        )
        .unwrap();
    assert!(matches!(accepted, ServedAcceptance::Accepted { .. }));
    ledger
}

/* The junk roster a served page may carry beside the chain. */
pub fn junk_roster() -> SignedGroupStatement {
    SignedGroupStatement {
        statement: b"[\"junk\"]".to_vec(),
        signature: GroupSignature { ed25519: vec![0; 64], ml_dsa: vec![0; 3309] },
        signer_signature: vec![0; 3373],
    }
}

/* The admin's join code for person `who` (6: someone never in it) over `rosters`. */
pub fn join_code_with(
    ledger: &AreaLedger,
    doc: &Value,
    who: usize,
    rosters: Vec<SignedGroupStatement>,
) -> Value {
    let f = family();
    let who = if who == 6 {
        "ffffffff-0000-4000-8000-000000000006".to_string()
    } else {
        f.p[who - 1].user_id.clone()
    };
    match ledger.member_join_code(s(&doc["family"], "groupId"), who, rosters) {
        Ok(MemberJoinCode::Code { roster_version, code }) => {
            json!({ "status": "code", "rosterVersion": roster_version, "code": code })
        }
        Ok(MemberJoinCode::OtherKeys { roster_version }) => {
            json!({ "status": "other-keys", "rosterVersion": roster_version })
        }
        Ok(MemberJoinCode::NotAdmitted) => json!({ "status": "not-admitted" }),
        Ok(MemberJoinCode::NotPinned) => json!({ "status": "not-pinned" }),
        Ok(MemberJoinCode::SyncFirst) => {
            json!({ "status": "refused", "message": "Check the family’s member list first." })
        }
        Err(error) => json!({ "status": "refused", "message": error.to_string() }),
    }
}

fn filed_for(spec: &Value) -> Vec<(usize, usize)> {
    match (spec["who"].as_u64(), spec["keys"].as_u64()) {
        (Some(who), Some(keys)) if who <= 5 => vec![(who as usize, keys as usize)],
        _ => vec![],
    }
}

/* A join code spec over the doc's history: its rosters as the spec says. */
pub fn join_run_over(doc: &Value, spec: &Value) -> Value {
    let mut rosters = history_of(doc);
    match spec["rosters"].as_str().unwrap() {
        "without-2" => {
            rosters.remove(1);
        }
        "with-junk" => rosters.push(junk_roster()),
        _ => {}
    }
    let ledger = committed_ledger(doc, filed_for(spec), None);
    join_code_with(&ledger, doc, spec["who"].as_u64().unwrap() as usize, rosters)
}

/* The outbox entries: which call's entry, how it is changed, the pin filed, the head committed, what is declared. */
pub fn entry_specs(doc: &Value) -> Vec<Value> {
    let route = |name: &str| {
        let call = doc["calls"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap();
        call["expected"]["route"].clone()
    };
    vec![
        json!({ "name": "an-admission-as-signed", "call": "admit-member", "keys": 4, "head": "family",
            "expected": { "status": "send", "route": route("admit-member"), "body": "admit-member" } }),
        json!({ "name": "an-admission-with-no-head-yet", "call": "admit-member", "keys": 4, "head": null,
            "expected": { "status": "send", "route": route("admit-member"), "body": "admit-member" } }),
        json!({ "name": "an-admission-to-other-keys", "call": "admit-member", "keys": 5, "head": "family",
            "expected": { "status": "hold", "route": route("admit-member"), "reason": "other-keys" } }),
        json!({ "name": "an-admission-never-checked", "call": "admit-member", "keys": null, "head": "family",
            "expected": { "status": "hold", "route": route("admit-member"), "reason": "other-keys" } }),
        json!({ "name": "a-role-change", "call": "take-members", "keys": null, "head": "family",
            "expected": { "status": "send", "route": route("take-members"), "body": "take-members" } }),
        json!({ "name": "landed-already", "call": "grant-members", "keys": null, "head": "with:grant-members",
            "expected": { "status": "landed", "route": route("grant-members") } }),
        json!({ "name": "superseded-by-another", "call": "grant-members", "keys": null, "head": "with:handover-to",
            "expected": { "status": "superseded", "route": route("grant-members") } }),
        json!({ "name": "held-back-by-an-earlier-version", "call": "admit-member", "change": "awaiting-check", "keys": 4, "head": "family",
            "expected": { "status": "hold", "route": route("admit-member"), "reason": "awaiting-check" } }),
        json!({ "name": "a-creation-stored-not-pinned", "call": "grant-members", "change": "committed", "keys": null, "head": null,
            "expected": { "status": "hold", "route": route("grant-members"), "reason": "committed" } }),
        json!({ "name": "kept-under-another-id", "call": "grant-members", "change": "other-id", "keys": null, "head": "family",
            "expected": { "status": "lost" } }),
        json!({ "name": "a-later-version", "call": "grant-members", "change": "v2", "keys": null, "head": "family",
            "expected": { "status": "lost" } }),
        json!({ "name": "another-family", "call": "grant-members", "change": "other-family", "keys": null, "head": "family",
            "expected": { "status": "lost" } }),
        json!({ "name": "an-unknown-route", "call": "grant-members", "change": "unknown-route", "keys": null, "head": "family",
            "expected": { "status": "lost" } }),
    ]
}

/* An entry's JSON changed as the spec says, and whether it is sealed for another family. */
pub fn entry_value(entry: &Value, change: Option<&str>) -> (Value, bool) {
    let mut value = entry.clone();
    let mut other_family = false;
    match change {
        Some("awaiting-check") => value["state"] = json!("awaiting-check"),
        Some("committed") => value["state"] = json!("committed"),
        Some("v2") => value["v"] = json!(2),
        Some("other-family") => other_family = true,
        Some("unknown-route") => value["route"] = json!({ "kind": "join" }),
        _ => {}
    }
    (value, other_family)
}

pub const OTHER_FAMILY: &str = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
pub const OTHER_ID: &str = "f0f0f0f0-0000-4000-8000-000000000001";

pub fn hold_name(reason: OutboxHold) -> &'static str {
    match reason {
        OutboxHold::AwaitingCheck => "awaiting-check",
        OutboxHold::OtherKeys => "other-keys",
        OutboxHold::Committed => "committed",
    }
}

/* The roster of the named call in `doc`, to commit as the head ("with:<call>"). */
fn call_roster(doc: &Value, name: &str) -> SignedGroupStatement {
    let call = doc["calls"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap();
    signed_of(&call["body"]["roster"])
}

/* An entry read by this core, as kept under `id`: sent, held, landed, superseded, or lost (deleted). */
pub fn entry_read(doc: &Value, spec: &Value, id: &str, envelope: &str) -> Value {
    let f = family();
    let p1 = &f.p[0];
    let group_id = s(&doc["family"], "groupId");
    let route_user = spec["call"].as_str().and_then(|name| {
        doc["calls"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .and_then(|c| c["expected"]["route"]["userId"].as_str())
    });
    let who = route_user.and_then(|user| f.p.iter().position(|p| p.user_id == user)).map(|i| i + 1);
    let filed: Vec<(usize, usize)> = match (who, spec["keys"].as_u64()) {
        (Some(who), Some(keys)) => vec![(who, keys as usize)],
        _ => vec![],
    };
    let ledger = match spec["head"].as_str() {
        None => {
            let ledger = AreaLedger::new();
            ledger
                .open_account(
                    p1.user_id.clone(),
                    base64url_decode(p1.served.signing_public_key.clone()).unwrap(),
                    root(),
                )
                .unwrap();
            ledger.use_settings(p1.user_id.clone(), Some(HashMap::new()), contacts(1, Some(filed))).unwrap();
            ledger
        }
        Some("family") => committed_ledger(doc, filed, None),
        Some(with) => {
            committed_ledger(doc, filed, Some(call_roster(doc, with.strip_prefix("with:").unwrap())))
        }
    };
    match ledger.outbox_open(group_id, id.into(), p1.user_id.clone(), envelope.into()) {
        Ok(OutboxCall::Send { route, body, .. }) => {
            let body: Value = serde_json::from_str(&body).unwrap();
            json!({ "status": "send", "route": route_json(&route), "body": body })
        }
        Ok(OutboxCall::Hold { route, reason, .. }) => {
            json!({ "status": "hold", "route": route_json(&route), "reason": hold_name(reason) })
        }
        Ok(OutboxCall::Landed { route, .. }) => json!({ "status": "landed", "route": route_json(&route) }),
        Ok(OutboxCall::Superseded { route, .. }) => {
            json!({ "status": "superseded", "route": route_json(&route) })
        }
        Err(CoreError::Sealed(_)) => json!({ "status": "lost" }),
        Err(other) => panic!("{other}"),
    }
}

/* Whether a read says what the spec declares: a body must be the named call's, by content. */
pub fn entry_says(doc: &Value, read: &Value, expected: &Value) -> bool {
    let mut expected = expected.clone();
    if let Some(name) = expected["body"].as_str() {
        let call = doc["calls"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap();
        expected["body"] = call["body"].clone();
    }
    *read == expected
}

/* This core's whole document. */
pub fn fixture() -> Value {
    let f = family();
    let mut doc = json!({ "family": family_json(), "accountRoot": e(&root()) });
    let mut calls = vec![];
    let mut entries: HashMap<String, Value> = HashMap::new();
    for spec in call_specs() {
        let name = spec["name"].as_str().unwrap().to_string();
        let mut out = spec.clone();
        match run(&spec["op"]) {
            Ok(call) => {
                let body: Value = serde_json::from_str(&call.body).unwrap();
                assert_eq!(route_json(&call.route), spec["expected"]["route"], "{name}: route");
                out["body"] = body;
                let opened =
                    device_store_open_value(&root(), &f.p[0].user_id, &f.group_id, "outbox", &call.entry)
                        .unwrap();
                assert_eq!(opened["body"], json!(call.body), "{name}: the entry keeps the exact text");
                entries.insert(name.clone(), opened);
            }
            Err(message) => {
                assert_eq!(Some(message.as_str()), spec["refused"].as_str(), "{name}: refusal");
                out["body"] = Value::Null;
            }
        }
        calls.push(out);
    }
    doc["calls"] = Value::Array(calls);
    for call in doc["calls"].as_array().unwrap() {
        if !call["body"].is_null() {
            assert_eq!(
                verdict(&doc, &call["expected"]["route"], &call["body"]),
                call["expected"],
                "{}",
                call["name"]
            );
        }
    }
    let mut grants = vec![];
    for mut spec in grant_specs() {
        match grant_run(&spec) {
            Ok(requests) => {
                let requests = requests_json(&requests);
                let by = spec["as"].as_u64().unwrap() as usize;
                assert_eq!(grants_verdict(&doc, by, &requests), spec["expected"], "{}", spec["name"]);
                spec["requests"] = requests;
            }
            Err(message) => {
                assert_eq!(Some(message.as_str()), spec["refused"].as_str(), "{}", spec["name"]);
                spec["requests"] = Value::Null;
            }
        }
        grants.push(spec);
    }
    doc["grantCalls"] = Value::Array(grants);
    let mut joins = vec![];
    for mut spec in join_specs(&doc) {
        let outcome = join_run_over(&doc, &spec);
        assert_eq!(outcome, spec["expected"], "{}", spec["name"]);
        spec["outcome"] = outcome;
        joins.push(spec);
    }
    doc["joinCodes"] = Value::Array(joins);
    let mut pairs = vec![];
    for mut spec in pair_specs(&doc) {
        let outcome = pair_run_over(&doc, &spec);
        assert_eq!(outcome, spec["expected"], "pair {}-{}", spec["me"], spec["other"]);
        spec["outcome"] = outcome;
        pairs.push(spec);
    }
    doc["pairCodes"] = Value::Array(pairs);
    let mut sealed = vec![];
    for mut spec in entry_specs(&doc) {
        let entry = &entries[spec["call"].as_str().unwrap()];
        let (value, other) = entry_value(entry, spec["change"].as_str());
        let group = if other { OTHER_FAMILY.to_string() } else { f.group_id.clone() };
        let envelope = outbox_entry_seal(&root(), &f.p[0].user_id, &group, &value).unwrap();
        let id = if spec["change"] == json!("other-id") { OTHER_ID.to_string() } else { s(&value, "id") };
        let read = entry_read(&doc, &spec, &id, &envelope);
        assert!(entry_says(&doc, &read, &spec["expected"]), "{}: {read}", spec["name"]);
        spec["envelope"] = json!(envelope);
        spec["id"] = json!(id);
        sealed.push(spec);
    }
    doc["outboxEntries"] = Value::Array(sealed);
    doc
}

/* The other twin's document through this core: every outcome the same. */
pub fn check(doc: &Value) {
    let names: Vec<String> = call_specs().iter().map(|spec| s(spec, "name")).collect();
    let theirs: Vec<String> = doc["calls"].as_array().unwrap().iter().map(|c| s(c, "name")).collect();
    assert_eq!(names, theirs, "the same calls in the same order");
    for call in doc["calls"].as_array().unwrap() {
        let name = s(call, "name");
        let spec = call_specs().into_iter().find(|spec| spec["name"] == call["name"]).unwrap();
        if call["body"].is_null() {
            assert_eq!(call["refused"], spec["refused"], "{name}: the same refusal");
            assert_eq!(run(&spec["op"]).unwrap_err(), s(&spec, "refused"), "{name}: refused here too");
            continue;
        }
        assert_eq!(call["expected"], spec["expected"], "{name}: the same declaration");
        assert_eq!(
            verdict(doc, &call["expected"]["route"], &call["body"]),
            spec["expected"],
            "{name}: their body"
        );
    }
    let specs = grant_specs();
    assert_eq!(doc["grantCalls"].as_array().unwrap().len(), specs.len(), "the same grant calls");
    for (theirs, spec) in doc["grantCalls"].as_array().unwrap().iter().zip(specs) {
        assert_eq!(theirs["name"], spec["name"]);
        if theirs["requests"].is_null() {
            assert_eq!(theirs["refused"], spec["refused"]);
            assert_eq!(grant_run(&spec).unwrap_err(), s(&spec, "refused"));
            continue;
        }
        let by = spec["as"].as_u64().unwrap() as usize;
        assert_eq!(
            grants_verdict(doc, by, &theirs["requests"]),
            spec["expected"],
            "{}: their grants",
            spec["name"]
        );
    }
    for spec in doc["joinCodes"].as_array().unwrap() {
        let outcome = join_run_over(doc, spec);
        assert_eq!(outcome, spec["outcome"], "{}", spec["name"]);
    }
    // Every pair code the other twin worked out over its own chain, worked out here alike, and as
    // this core's own specs declare it over those bytes.
    let here = pair_specs(doc);
    let theirs = doc["pairCodes"].as_array().unwrap();
    assert_eq!(
        theirs.iter().map(|at| (at["me"].clone(), at["other"].clone())).collect::<Vec<_>>(),
        here.iter().map(|at| (at["me"].clone(), at["other"].clone())).collect::<Vec<_>>(),
        "the same pairs in the same order"
    );
    for (theirs, spec) in theirs.iter().zip(&here) {
        let outcome = pair_run_over(doc, theirs);
        assert_eq!(outcome, theirs["outcome"], "pair {}-{}: their words", theirs["me"], theirs["other"]);
        assert_eq!(outcome, spec["expected"], "pair {}-{}: as declared here", theirs["me"], theirs["other"]);
    }
    for spec in doc["outboxEntries"].as_array().unwrap() {
        let read = entry_read(doc, spec, spec["id"].as_str().unwrap(), spec["envelope"].as_str().unwrap());
        assert!(entry_says(doc, &read, &spec["expected"]), "{}: {read}", spec["name"]);
    }
}

/*
 * The pair codes of every two people of the family, each worked out by `me` over the doc's own
 * chain as `me` accepts it (docs/optional-verification.md 3.4): at the later admission of the
 * two (1 and 2 at roster 2; 1 and 3, 2 and 3 at roster 3), the same words from either side, over
 * that roster's digest, group key 1 and the two ids; someone not let in has none. The twin of
 * the web's pairSpecs.
 */
pub fn pair_specs(doc: &Value) -> Vec<Value> {
    let f = family();
    let rosters = history_of(doc);
    let words = |version: usize, a: usize, b: usize| {
        pair_code_of(
            &roster_digest(rosters[version - 1].statement.clone()),
            &first_keys_of(doc),
            1,
            &f.p[a - 1].user_id,
            &f.p[b - 1].user_id,
        )
        .unwrap()
    };
    let mut specs = vec![];
    for (a, b, version) in [(1, 2, 2), (1, 3, 3), (2, 3, 3)] {
        let code = words(version, a, b);
        let expected = json!({ "status": "code", "rosterVersion": version, "code": code });
        specs.push(json!({ "me": a, "other": b, "expected": expected }));
        specs.push(json!({ "me": b, "other": a, "expected": expected }));
    }
    specs.push(json!({ "me": 1, "other": 4, "expected": { "status": "not-admitted" } }));
    specs
}

/*
 * A pair code as `spec.me` works it out over the doc's chain, accepted as their own (the web's
 * pairRunOver): holding the keys of person `spec.as` (their own when absent; the fuzz kind
 * pair_code holds another's). `not-accepted` when the chain is not, `refused` when either call
 * refuses.
 */
pub fn pair_run_over(doc: &Value, spec: &Value) -> Value {
    let f = family();
    let person = |key: &str| &f.p[spec[key].as_u64().unwrap() as usize - 1];
    let holding = if spec["as"].is_u64() { person("as") } else { person("me") };
    let me = OwnIdentities { user_id: person("me").user_id.clone(), identities: vec![served_keys(holding)] };
    let chain = match accept_rosters(
        s(&doc["family"], "groupId"),
        first_keys_of(doc),
        Some(GroupAnchor::Created),
        vec![],
        history_of(doc),
        vec![],
        ml_dsa_keys(),
        me.clone(),
        None,
    ) {
        Ok(RosterChain::Accepted { chain }) => chain,
        Ok(_) => return json!({ "status": "not-accepted" }),
        Err(_) => return json!({ "status": "refused" }),
    };
    match pair_code(chain, me, person("other").user_id.clone(), history_of(doc)) {
        Ok(PairCode::Code { roster_version, code }) => {
            json!({ "status": "code", "rosterVersion": roster_version, "code": code })
        }
        Ok(PairCode::OwnEntryWrong { roster_version }) => {
            json!({ "status": "own-entry-wrong", "rosterVersion": roster_version })
        }
        Ok(PairCode::NotAdmitted) => json!({ "status": "not-admitted" }),
        Err(_) => json!({ "status": "refused" }),
    }
}

/* fixtures/outbox-steps.json through outbox_step. */
pub fn step_name(step: OutboxStep) -> &'static str {
    match step {
        OutboxStep::Landed => "landed",
        OutboxStep::Resend => "resend",
        OutboxStep::SendGrants => "send-grants",
        OutboxStep::Rebuild => "rebuild",
        OutboxStep::Stale => "stale",
        OutboxStep::MembershipMoved => "membership-moved",
        OutboxStep::Refused => "refused",
        OutboxStep::Wiped => "wiped",
    }
}

/* A manager's device over time (the fuzz kind `roster_call_session`) ------- */

/* The server the session talks to: the family's history, and whatever lands on it. */
struct Server {
    rosters: Vec<SignedGroupStatement>,
    successions: Vec<SignedGroupStatement>,
}

impl Server {
    fn chain(&self) -> Arc<AcceptedRosters> {
        chain_of(family().h.key(1), &family().group_id, self.rosters.clone(), self.successions.clone())
    }
}

/* Person 1's ledger as an unlock leaves it: the account under the shared root, the settings (the pin at roster 7, every contact). */
fn unlocked_ledger(ledger: Option<Arc<AreaLedger>>) -> Arc<AreaLedger> {
    let f = family();
    let p1 = &f.p[0];
    let ledger = ledger.unwrap_or_default();
    ledger
        .open_account(
            p1.user_id.clone(),
            base64url_decode(p1.served.signing_public_key.clone()).unwrap(),
            root(),
        )
        .unwrap();
    let chain = chain_of(f.h.key(1), &f.group_id, f.h.rosters.clone(), vec![]);
    let pin_now = pin_after(vec![], chain, CHECKED.into()).unwrap();
    ledger
        .use_settings(p1.user_id.clone(), Some([(f.group_id.clone(), pin_now)].into()), contacts(1, None))
        .unwrap();
    ledger
}

/* The ops a session takes, each with only the fields it reads; none when a step does not fit. */
pub fn session_step(step: &Value) -> Option<Value> {
    let op = step.get("op")?.as_str()?;
    Some(match op {
        "sync" | "openKey" | "openArea" | "lock" | "unlock" | "relaunch" | "commitOther" => {
            json!({ "op": op })
        }
        "build" => {
            let call = step.get("call")?.as_object()?;
            let kind = call.get("kind")?.as_str()?;
            let who = call.get("who").and_then(Value::as_u64).filter(|n| (1..=5).contains(n));
            match kind {
                "admit" => json!({ "op": op, "call": { "kind": kind, "who": who?, "roles": [] } }),
                "grant" | "take" | "handover" => json!({ "op": op, "call": { "kind": kind, "who": who? } }),
                "stepDown" => json!({ "op": op, "call": { "kind": kind } }),
                _ => return None,
            }
        }
        "send" => {
            let entry = step.get("entry")?.as_u64().filter(|n| *n < 16)?;
            let answer = step.get("answer")?.as_str().filter(|a| ["land", "none"].contains(a))?;
            json!({ "op": op, "entry": entry, "answer": answer })
        }
        _ => return None,
    })
}

/*
 * Steps of a manager's device (person 1) against a server holding the
 * family: sync, open the key or the folders, build a call, lock and unlock,
 * relaunch, another manager (person 3) committing a roster, and sending a
 * kept entry with the server's answer. The outcome of each step, as both
 * twins write it. Invariants: a sent body is the kept one, byte for byte; a
 * built call's expectedRevision is the head it was built on; nothing is built
 * or read while locked.
 */
pub fn session_run(steps: &[Value]) -> Vec<Value> {
    let f = family();
    let p1 = &f.p[0];
    let mut server = Server { rosters: f.h.rosters.clone(), successions: vec![] };
    let mut ledger = unlocked_ledger(None);
    let mut locked = false;
    let mut kept: Vec<StagedCall> = vec![];
    let mut out = vec![];
    for step in steps {
        let outcome = match step["op"].as_str().unwrap() {
            "sync" if locked => json!("locked"),
            "sync" => {
                let served = ServedChain {
                    after: 0,
                    first_keys: f.h.key(1),
                    rosters: server.rosters.clone(),
                    successions: server.successions.clone(),
                    signer_keys: ml_dsa_keys(),
                };
                match ledger.accept_served(
                    me(1),
                    f.group_id.clone(),
                    None,
                    served,
                    FamilyGuard::Absent,
                    CHECKED.into(),
                ) {
                    Ok(ServedAcceptance::Accepted { chain, .. }) => {
                        json!(format!("accepted:{}", chain.roster().roster_version))
                    }
                    Ok(_) | Err(_) => json!("refused"),
                }
            }
            "openKey" => {
                let chain = server.chain();
                if chain.group_key_version() != 1 || locked {
                    json!("no-seal")
                } else {
                    let ctx = GroupKeySealContext {
                        group_id: f.group_id.clone(),
                        group_key_version: 1,
                        holder_user_id: p1.user_id.clone(),
                        holder_key_version: 1,
                        sealer_user_id: p1.user_id.clone(),
                        roster_version: chain.roster().roster_version,
                        roster_digest: chain.roster_digest(),
                    };
                    let sealed = group_key_seal(
                        super::groups::group_seed(1),
                        ctx.clone(),
                        Arc::clone(&chain),
                        p1.kem(),
                        p1.keys.clone(),
                    );
                    let seal = sealed.map(|envelope| ServedKeySeal {
                        group_key_version: 1,
                        holder_key_version: 1,
                        sealer_user_id: p1.user_id.clone(),
                        roster_version: ctx.roster_version,
                        roster_digest: ctx.roster_digest,
                        envelope,
                    });
                    match seal.and_then(|seal| {
                        ledger.open_group_key(me(1), f.group_id.clone(), seal, p1.ml_dsa(), None, envelope(1))
                    }) {
                        Ok(_) => json!("opened"),
                        Err(_) => json!("refused"),
                    }
                }
            }
            "openArea" => {
                let (a1, a1_seed) = &f.areas[0];
                let (a3, a3_seed) = &f.areas[2];
                let one =
                    ledger.open_area(f.group_id.clone(), a1.clone(), a1_seed.clone(), 1, area_key(0, 1), 1);
                let three =
                    ledger.open_area(f.group_id.clone(), a3.clone(), a3_seed.clone(), 2, area_key(2, 2), 2);
                json!(if one.is_ok() && three.is_ok() { "opened" } else { "refused" })
            }
            "build" if locked => {
                let revision = server.rosters.len() as u64;
                assert!(
                    run_at(Some(Arc::clone(&ledger)), &step["call"], revision).is_err(),
                    "built while locked"
                );
                json!("locked-refused")
            }
            "build" => {
                let revision = server.rosters.len() as u64;
                match run_at(Some(Arc::clone(&ledger)), &step["call"], revision) {
                    Ok(call) => {
                        let body: Value = serde_json::from_str(&call.body).unwrap();
                        assert_eq!(
                            body["expectedRevision"],
                            json!(revision),
                            "expectedRevision is not the head's"
                        );
                        let route = route_json(&call.route);
                        kept.push(call);
                        json!(format!("staged:{}", route["kind"].as_str().unwrap()))
                    }
                    Err((Some(first), _)) => json!(format!("first:{first}")),
                    Err((None, _)) => json!("refused"),
                }
            }
            "send" if locked || kept.is_empty() => json!("nothing"),
            "send" => {
                let call = &kept[step["entry"].as_u64().unwrap() as usize % kept.len()];
                let read = ledger.outbox_open(
                    f.group_id.clone(),
                    call.outbox_id.clone(),
                    p1.user_id.clone(),
                    call.entry.clone(),
                );
                match read {
                    Ok(OutboxCall::Send { body, .. }) => {
                        assert_eq!(body, call.body, "read back other bytes than kept");
                        let answer = if step["answer"] == json!("land") {
                            let body: Value = serde_json::from_str(&body).unwrap();
                            let roster = signed_of(&body["roster"]);
                            let parsed = roster_parse(roster.statement.clone()).unwrap();
                            let head = roster_digest(server.rosters.last().unwrap().statement.clone());
                            let own = roster_digest(roster.statement.clone());
                            // A resend of what the server stored is answered as a replay.
                            if server.rosters.iter().any(|at| roster_digest(at.statement.clone()) == own) {
                                outbox_step(200, None)
                            } else if parsed.previous_roster_digest == head {
                                server.rosters.push(roster);
                                server.successions.extend(body.get("succession").map(signed_of));
                                outbox_step(201, None)
                            } else {
                                outbox_step(409, Some("stale".into()))
                            }
                        } else {
                            outbox_step(0, None)
                        };
                        json!(format!("send:{}", step_name(answer)))
                    }
                    Ok(OutboxCall::Hold { reason, .. }) => json!(format!("hold:{}", hold_name(reason))),
                    Ok(OutboxCall::Landed { .. }) => json!("landed"),
                    Ok(OutboxCall::Superseded { .. }) => json!("superseded"),
                    Err(CoreError::Sealed(_)) => json!("lost"),
                    Err(_) => json!("refused"),
                }
            }
            "commitOther" => {
                let chain = server.chain();
                let p3 = &f.p[2];
                let holds = chain.roster().members.iter().any(|m| {
                    m.user_id == p3.user_id
                        && m.status == MemberStatus::Active
                        && m.roles.contains(&GroupRole::Members)
                });
                if chain.group_key_version() != 1 || !holds {
                    json!("skipped")
                } else {
                    // Person 3 gives person 2 billing, or takes it back.
                    let members: Vec<RosterMember> = chain
                        .roster()
                        .members
                        .iter()
                        .map(|m| {
                            let mut m = m.clone();
                            if m.user_id == f.p[1].user_id && m.status == MemberStatus::Active {
                                if m.roles.contains(&GroupRole::Billing) {
                                    m.roles.retain(|r| *r != GroupRole::Billing);
                                } else {
                                    m.roles.push(GroupRole::Billing);
                                }
                            }
                            m
                        })
                        .collect();
                    let roster =
                        roster_next(Arc::clone(&chain), members, p3.user_id.clone(), None, None, Some(2))
                            .unwrap();
                    server
                        .rosters
                        .push(roster_sign(roster, super::groups::group_seed(1), p3.keys.clone()).unwrap());
                    json!(format!("committed:{}", server.rosters.len()))
                }
            }
            "lock" => {
                ledger.clear();
                locked = true;
                json!("locked")
            }
            "unlock" => {
                ledger = unlocked_ledger(Some(Arc::clone(&ledger)));
                locked = false;
                json!("unlocked")
            }
            "relaunch" => {
                ledger = unlocked_ledger(None);
                locked = false;
                json!("relaunched")
            }
            other => panic!("{other}"),
        };
        out.push(outcome);
    }
    out
}
