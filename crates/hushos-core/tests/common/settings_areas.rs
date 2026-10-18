//! The settings document opened by the ledger and family folders opened from
//! route 25 (groups 1d, Core 6), for the shared fixtures: the twin of
//! `packages/crypto/src/settings-areas-testkit.ts`. Both twins run the cases
//! of `fixtures/settings-area-cases.json` over the roster-call family through
//! their own code (here [`AreaLedger::use_settings_envelope`] and
//! [`AreaLedger::open_family_area`]; there the worker's `settingsKeyOpen`,
//! `settingsOpen` and `groupOpenArea`), check each case's `expected`, and
//! write into their roster-call document what they sealed:
//!
//! - `settingsReadings`: each step's settings key and document envelopes,
//!   read by the other twin to the same outcomes (each step's answer, the
//!   family's acceptance, person 4's admission and person 2's join code);
//! - `areaOpens`: each case's self-grant (sealed by this twin) and outcome,
//!   opened by the other twin alike; every self-grant this twin made to store
//!   is opened by the other to the folder's key, and opens the folder there.
#![allow(dead_code)]

use super::device_records::root;
use super::groups::{pattern, s, CHECKED};
use super::roster_calls::{area_key, envelope, family, join_code_with, me, run_on, served_of};
use hushos_core::*;
use serde_json::{json, Map, Value};
use std::sync::{Arc, OnceLock};

pub fn cases() -> &'static Value {
    static CASES: OnceLock<Value> = OnceLock::new();
    CASES.get_or_init(|| {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/settings-area-cases.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    })
}

const OTHER_GROUP: &str = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const FOREIGN_AREA: &str = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";

fn other_root() -> Vec<u8> {
    pattern(32, 77)
}

/* A person's id as a case names it: p2..p5, or P4 for p4's in capitals. */
fn id_of(name: &str) -> String {
    let n: usize = name[1..].parse().unwrap();
    let id = family().p[n - 1].user_id.clone();
    if name.starts_with('P') {
        id.to_uppercase()
    } else {
        id
    }
}

/* Person `n`'s version 3 contact pin as the web writes it. */
fn contact(n: usize) -> Value {
    let p = &family().p[n - 1];
    json!({
        "userId": p.user_id,
        "email": format!("person{n}@hushos.test"),
        "name": format!("Person {n}"),
        "encryptionPublicKey": p.served.encryption_public_key,
        "signingPublicKey": p.served.signing_public_key,
        "fingerprint": identity_fingerprint_of_keys(
            base64url_decode(p.served.encryption_public_key.clone()).unwrap(),
            base64url_decode(p.served.signing_public_key.clone()).unwrap(),
            p.ml_dsa(),
            p.kem(),
        )
        .unwrap(),
        "pinnedAt": CHECKED,
        "mlDsaPublicKeyHash": key_digest(p.ml_dsa()),
        "kemPublicKeyHash": key_digest(p.kem()),
        "keyVersion": 1,
    })
}

fn group_pin_at_head() -> Value {
    let f = family();
    let chain = super::roster_calls::chain_of(f.h.key(1), &f.group_id, f.h.rosters.clone(), vec![]);
    super::groups::pin_json(&pin_after(vec![], chain, CHECKED.into()).unwrap())
}

/*
 * A case's document, as JSON text in the case's member order. The contacts member is written by
 * hand so the order of its members is the case's (serde_json's map would sort them).
 */
pub fn document(spec: &Value) -> String {
    let f = family();
    let version = spec.get("version").cloned().unwrap_or(json!(2));
    let contacts = match spec.get("contacts") {
        None => {
            let members: Vec<String> =
                (2..=5).map(|n| format!("{}:{}", json!(f.p[n - 1].user_id), contact(n))).collect();
            format!("{{{}}}", members.join(","))
        }
        Some(Value::Array(list)) => {
            let members: Vec<String> = list
                .iter()
                .map(|member| {
                    let key = id_of(member[0].as_str().unwrap());
                    let spec = &member[1];
                    let value = match spec.get("raw") {
                        Some(raw) => raw.clone(),
                        None => {
                            let mut pin = contact(spec["pin"].as_u64().unwrap() as usize);
                            if let Some(user) = spec["userId"].as_str() {
                                pin["userId"] = json!(id_of(user));
                            }
                            for field in spec["without"].as_array().into_iter().flatten() {
                                pin.as_object_mut().unwrap().remove(field.as_str().unwrap());
                            }
                            for (field, value) in spec["with"].as_object().into_iter().flatten() {
                                pin[field] = value.clone();
                            }
                            pin
                        }
                    };
                    format!("{}:{}", json!(key), value)
                })
                .collect();
            format!("{{{}}}", members.join(","))
        }
        Some(other) => other["raw"].to_string(),
    };
    let groups = match spec.get("groups") {
        None => json!({ f.group_id.clone(): group_pin_at_head() }),
        Some(groups) => match groups.get("rawGroups") {
            Some(raw) => raw.clone(),
            None => json!({ f.group_id.clone(): groups["raw"].clone() }),
        },
    };
    format!(r#"{{"version":{version},"contacts":{contacts},"groups":{groups}}}"#)
}

/* A step's envelopes, sealed by this core as person 1's device would be served them (None: not served). */
fn seal_step(step: &Value) -> Value {
    let user = family().p[0].user_id.clone();
    let key_root = if step["key"] == json!("other-root") { other_root() } else { root() };
    let made = settings_key_create(user.clone(), key_root).unwrap();
    let mut envelope = settings_seal_raw(&user, &made.key.to_vec(), 5, &document(&step["document"])).unwrap();
    if step["tamper"] == json!(true) {
        let mut bytes = base64url_decode(envelope.ciphertext.clone()).unwrap();
        bytes[3] ^= 1;
        envelope.ciphertext = base64url_encode(bytes);
    }
    match step["envelope"].as_str() {
        Some("legacy") => envelope.version = 1,
        Some("version-3") => envelope.version = 3,
        _ => {}
    }
    let served = step["envelope"] != json!("none");
    json!({
        "key": if step["key"] == json!("missing") { Value::Null } else { json!({ "nonce": made.envelope.nonce, "ciphertext": made.envelope.ciphertext }) },
        "envelope": if served { json!({ "version": envelope.version, "settingsVersion": envelope.settings_version, "nonce": envelope.nonce, "ciphertext": envelope.ciphertext }) } else { Value::Null },
    })
}

fn key_of(value: &Value) -> Option<SettingsKeyEnvelope> {
    (!value.is_null())
        .then(|| SettingsKeyEnvelope { nonce: s(value, "nonce"), ciphertext: s(value, "ciphertext") })
}
fn envelope_of(value: &Value) -> Option<SettingsEnvelope> {
    (!value.is_null()).then(|| SettingsEnvelope {
        version: value["version"].as_u64().unwrap() as u32,
        settings_version: value["settingsVersion"].as_u64().unwrap(),
        nonce: s(value, "nonce"),
        ciphertext: s(value, "ciphertext"),
    })
}

/*
 * Person 1's device over `sealed` steps: each settings read's answer, then the family's history
 * accepted, and when it is, the group key and folders opened, person 4 admitted and person 2's
 * join code read: the outcome both twins must give.
 */
pub fn run_settings(sealed: &[Value]) -> Value {
    let f = family();
    let p1 = &f.p[0];
    let ledger = AreaLedger::new();
    ledger
        .open_account(
            p1.user_id.clone(),
            base64url_decode(p1.served.signing_public_key.clone()).unwrap(),
            root(),
        )
        .unwrap();
    let steps: Vec<Value> = sealed
        .iter()
        .map(|step| {
            let envelope = envelope_of(&step["envelope"]);
            let kind = match &envelope {
                None => "none",
                Some(envelope) if envelope.version == 1 => "legacy",
                Some(_) => "opened",
            };
            match ledger.use_settings_envelope(p1.user_id.clone(), key_of(&step["key"]), envelope) {
                Ok(()) => json!(kind),
                Err(error) => json!({ "refused": error.to_string() }),
            }
        })
        .collect();
    let accepted = ledger.accept_served(
        me(1),
        f.group_id.clone(),
        None,
        served_of(f.h.key(1), f.h.rosters.clone()),
        CHECKED.into(),
    );
    let accept = match &accepted {
        Ok(ServedAcceptance::Accepted { .. }) => json!("accepted"),
        Ok(ServedAcceptance::Fork { .. }) => json!({ "refused": "fork" }),
        Ok(ServedAcceptance::RecordUnreadable) => json!({ "refused": "record-unreadable" }),
        Ok(ServedAcceptance::FetchFromVersionOne) => json!({ "refused": "fetch-from-version-1" }),
        Ok(ServedAcceptance::Overtaken { .. }) => json!({ "refused": "overtaken" }),
        Err(error) => json!({ "refused": error.to_string() }),
    };
    let mut out = json!({ "steps": steps, "accept": accept });
    if out["accept"] == json!("accepted") {
        open_key_and_folders(&ledger);
        out["admit"] =
            match run_on(Some(Arc::clone(&ledger)), &json!({ "kind": "admit", "who": 4, "roles": [] })) {
                Ok(_) => json!("staged"),
                Err(message) => json!({ "refused": message }),
            };
        let doc = json!({ "family": { "groupId": f.group_id } });
        out["join"] = join_code_with(&ledger, &doc, 2, f.h.rosters.clone());
    }
    out
}

/* Person 1's own seal of the group key, opened; A1 and A3 opened from person 1's grants to themself. */
fn open_key_and_folders(ledger: &AreaLedger) {
    let f = family();
    let p1 = &f.p[0];
    let chain = super::roster_calls::chain_of(f.h.key(1), &f.group_id, f.h.rosters.clone(), vec![]);
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
    ledger.open_group_key(me(1), f.group_id.clone(), seal, p1.ml_dsa(), None, envelope(1)).unwrap();
    for (name, index, version) in [("A1", 0, 1), ("A3", 2, 2)] {
        let area = served_area(
            1,
            &json!({ "area": name, "served": version,
            "grant": { "key": [index, version] }, "selfGrant": null }),
            None,
        );
        ledger.open_family_area(f.group_id.clone(), area, 1).unwrap();
    }
}

/* A self-grant as JSON (the personal workspace grant's shape) and back. */
pub fn grant_json(grant: &WorkspaceGrant) -> Value {
    json!({
        "version": grant.version,
        "workspaceId": grant.workspace_id,
        "keyVersion": grant.key_version,
        "workspaceKeyVersion": grant.workspace_key_version,
        "wrappingSalt": grant.wrapping_salt,
        "wrappingNonce": grant.wrapping_nonce,
        "encryptedKey": grant.encrypted_key,
    })
}
pub fn grant_of(value: &Value) -> WorkspaceGrant {
    WorkspaceGrant {
        version: value["version"].as_u64().unwrap() as u32,
        workspace_id: s(value, "workspaceId"),
        key_version: value["keyVersion"].as_u64().unwrap(),
        workspace_key_version: value["workspaceKeyVersion"].as_u64().unwrap(),
        wrapping_salt: s(value, "wrappingSalt"),
        wrapping_nonce: s(value, "wrappingNonce"),
        encrypted_key: s(value, "encryptedKey"),
    }
}

fn area_ids(name: &str) -> (String, String) {
    let f = family();
    match name {
        "A1" => f.areas[0].clone(),
        "A2" => f.areas[1].clone(),
        "A3" => f.areas[2].clone(),
        _ => (FOREIGN_AREA.to_string(), f.areas[0].1.clone()),
    }
}

/* This core's self-grant for a case: person `n`'s own wrap of the case's key, as the case says. */
pub fn seal_self_grant(n: usize, spec: &Value) -> Value {
    let f = family();
    let Some(own) = spec["selfGrant"].as_object() else { return Value::Null };
    let key = &own["key"];
    let area = own.get("area").and_then(Value::as_str).unwrap_or(spec["area"].as_str().unwrap());
    let group =
        if own.get("group") == Some(&json!("other")) { OTHER_GROUP.to_string() } else { f.group_id.clone() };
    let account_root = if own.get("root") == Some(&json!("other")) { other_root() } else { root() };
    let mut grant = area_self_grant_seal(
        &area_key(key[0].as_u64().unwrap() as usize, key[1].as_u64().unwrap()),
        &account_root,
        &f.p[n - 1].user_id,
        &group,
        &area_ids(area).0,
        1,
        own["version"].as_u64().unwrap(),
    )
    .unwrap();
    if let Some(version) = own.get("envelopeVersion").and_then(Value::as_u64) {
        grant.version = version as u32;
    }
    grant_json(&grant)
}

/* Route 25's row for a case, opened by person `n` (the grant from person 1; `self_grant` as sealed). */
pub fn served_area(n: usize, spec: &Value, self_grant: Option<&Value>) -> ServedArea {
    let f = family();
    let (p1, me) = (&f.p[0], &f.p[n - 1]);
    let (workspace_id, id_seed) = area_ids(spec["area"].as_str().unwrap());
    let chain = super::roster_calls::chain_of(f.h.key(1), &f.group_id, f.h.rosters.clone(), vec![]);
    let grant = spec["grant"].as_object().map(|grant| {
        let key = &grant["key"];
        let (index, version) = (key[0].as_u64().unwrap() as usize, key[1].as_u64().unwrap());
        let ctx = AreaGrantContext {
            group_id: f.group_id.clone(),
            workspace_id: workspace_id.clone(),
            workspace_key_version: version,
            grantee_user_id: me.user_id.clone(),
            grantee_key_version: 1,
            granter_user_id: p1.user_id.clone(),
            roster_version: chain.roster().roster_version,
            roster_digest: chain.roster_digest(),
        };
        let sealed = area_grant_seal(
            area_key(index, version),
            ctx.clone(),
            Arc::clone(&chain),
            id_seed.clone(),
            me.kem(),
            p1.keys.clone(),
        )
        // A folder nobody may grant (deleted, or not the family's): a grant of zeros, which opens nothing.
        .unwrap_or_else(|_| vec![0; 4565]);
        ServedAreaGrant {
            envelope: sealed,
            workspace_key_version: version,
            grantee_key_version: 1,
            granter_user_id: p1.user_id.clone(),
            roster_version: ctx.roster_version,
            roster_digest: ctx.roster_digest,
            granter_ml_dsa_public_key: (grant.get("granterKey") != Some(&json!(false))).then(|| p1.ml_dsa()),
            granter_history: None,
            holder: envelope(n),
        }
    });
    ServedArea {
        workspace_id,
        id_seed,
        served_version: spec["served"].as_u64().unwrap(),
        grant,
        self_grant: self_grant.filter(|value| !value.is_null()).map(grant_of),
    }
}

/* Person 2's device opening a case's folder: the outcome both twins must give, and the self-grant to store. */
pub fn run_area(spec: &Value, self_grant: &Value) -> (Value, Option<WorkspaceGrant>) {
    let f = family();
    let ledger = super::roster_calls::ledger_with(2, None, None, false, false);
    match ledger.open_family_area(f.group_id.clone(), served_area(2, spec, Some(self_grant)), 1) {
        Ok(opened) => {
            let stored = opened.self_grant_to_store.clone();
            let outcome = json!({
                "from": match opened.from { AreaKeyFrom::SelfGrant => "self-grant", AreaKeyFrom::Grant => "grant" },
                "version": opened.opened.version,
                "writable": opened.opened.writable,
                "reason": opened.opened.reason.map(AreaBlock::name),
                "stored": stored.as_ref().map(|own| own.workspace_key_version),
            });
            (outcome, stored)
        }
        Err(error) => (json!({ "refused": error.to_string() }), None),
    }
}

/* Whether an outcome says what its case declared (the declaration leaves out what it does not care about). */
fn says(outcome: &Value, expected: &Value) -> bool {
    expected.as_object().unwrap().iter().all(|(key, want)| match (key.as_str(), &outcome[key]) {
        ("join", got) => want.as_object().unwrap().iter().all(|(k, v)| got[k] == *v),
        (_, got) => got == want,
    })
}

/* A self-grant stored by a case: opened by person 2 to the folder's key, then opening the folder by itself. */
fn check_stored(spec: &Value, stored: &Value) {
    let f = family();
    let name = s(spec, "name");
    let grant = grant_of(stored);
    let key = area_self_grant_open(&root(), &f.p[1].user_id, &f.group_id, &grant).unwrap();
    let index = spec["grant"]["key"][0].as_u64().unwrap() as usize;
    assert_eq!(key, area_key(index, grant.workspace_key_version), "{name}: the stored self-grant's key");
    let again = json!({ "area": spec["area"], "served": spec["served"], "grant": null, "selfGrant": {} });
    let (outcome, _) = run_area(&again, stored);
    assert_eq!(
        outcome["from"],
        json!("self-grant"),
        "{name}: the stored self-grant opens the folder: {outcome}"
    );
}

/* This core's sections of the roster-call document. */
pub fn fixture() -> Value {
    let mut readings = vec![];
    for spec in cases()["settings"].as_array().unwrap() {
        let sealed: Vec<Value> = spec["steps"].as_array().unwrap().iter().map(seal_step).collect();
        let outcome = run_settings(&sealed);
        assert!(says(&outcome, &spec["expected"]), "{}: {outcome}", spec["name"]);
        readings.push(json!({ "name": spec["name"], "sealed": sealed, "outcome": outcome }));
    }
    let mut opens = vec![];
    for spec in cases()["areas"].as_array().unwrap() {
        let self_grant = seal_self_grant(2, spec);
        let (outcome, stored) = run_area(spec, &self_grant);
        assert!(says(&outcome, &spec["expected"]), "{}: {outcome}", spec["name"]);
        let stored = stored.as_ref().map(grant_json).unwrap_or(Value::Null);
        if !stored.is_null() {
            check_stored(spec, &stored);
        }
        opens.push(
            json!({ "name": spec["name"], "selfGrant": self_grant, "outcome": outcome, "stored": stored }),
        );
    }
    let mut out = Map::new();
    out.insert("settingsReadings".into(), Value::Array(readings));
    out.insert("areaOpens".into(), Value::Array(opens));
    Value::Object(out)
}

/* The other twin's sections through this core: every outcome the same, every stored self-grant opening here. */
pub fn check(doc: &Value) {
    let specs = cases()["settings"].as_array().unwrap();
    let theirs = doc["settingsReadings"].as_array().expect("settingsReadings");
    assert_eq!(theirs.len(), specs.len(), "the same settings cases");
    for (reading, spec) in theirs.iter().zip(specs) {
        assert_eq!(reading["name"], spec["name"]);
        let outcome = run_settings(reading["sealed"].as_array().unwrap());
        assert_eq!(outcome, reading["outcome"], "{}: their envelopes read here", spec["name"]);
        assert!(says(&outcome, &spec["expected"]), "{}: {outcome}", spec["name"]);
    }
    let specs = cases()["areas"].as_array().unwrap();
    let theirs = doc["areaOpens"].as_array().expect("areaOpens");
    assert_eq!(theirs.len(), specs.len(), "the same area cases");
    for (open, spec) in theirs.iter().zip(specs) {
        assert_eq!(open["name"], spec["name"]);
        let (outcome, _) = run_area(spec, &open["selfGrant"]);
        assert_eq!(outcome, open["outcome"], "{}: their self-grant opened here", spec["name"]);
        if !open["stored"].is_null() {
            check_stored(spec, &open["stored"]);
        }
    }
}
