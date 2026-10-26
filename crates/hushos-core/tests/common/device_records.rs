//! The device record and the settings pin, for the shared fixtures, the twin
//! of `packages/crypto/src/device-record-testkit.ts`: both build the same
//! cases in the same order from the same people (person 1 reads, person 2 is
//! the other member), seal each case's chain record with their own acceptance
//! (`AreaLedger::accept_served`; the worker's `groupAccept`) and change it as
//! the case says, and run the other twin's records and served chains through
//! their own order (`accept_served`, following `FetchFromVersionOne`; the
//! web's `acceptFromRecord` driving `groupAccept`) to the declared outcome.
//! Used by `tests/area_ledger_fixtures.rs` and
//! `examples/area_ledger_fixtures.rs`; the merge cases are
//! `fixtures/merge-pin-cases.json`.
//!
//! The family: person 1 holds members, person 2's roles change at each of
//! three rosters (format 2); two branches of it, one with another roster 3,
//! one with another roster 2 (and so another roster 3 after it).
#![allow(dead_code)]

use super::groups::{
    e, pattern, person, pin_from, pin_json, pin_of, served_keys, served_ml_dsa, signed_json, signed_of,
    History, Person, CHECKED, GROUP, OTHER_GROUP,
};
use hushos_core::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

pub fn root() -> Vec<u8> {
    pattern(32, 90)
}

/* The same account's root after a master-key rotation. */
pub fn rotated_root() -> Vec<u8> {
    pattern(32, 91)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Change {
    OtherRoot,
    OtherAccount,
    OtherFamily,
    NewerRecord,
    NewerCache,
    DamagedCache,
    HeadlessCache,
    DamagedPin,
    NewerCacheNoPin,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Branch {
    Main,
    At3,
    At2,
}

#[derive(Clone, Copy)]
struct Served {
    after: usize,
    through: usize,
    branch: Branch,
    bad_signature: bool,
}

const fn served(after: usize, through: usize) -> Served {
    Served { after, through, branch: Branch::Main, bad_signature: false }
}

#[derive(Clone, Copy)]
enum Settings {
    None,
    At1,
    At3,
    Branch3,
    /* A version 1 document: legacy_settings, never use_settings. */
    Legacy,
}

struct Spec {
    name: &'static str,
    record: Option<usize>,
    change: Option<Change>,
    settings: Settings,
    held: Option<usize>,
    start: usize,
    served: Vec<Served>,
    expected: Value,
}

/* The cases, in the order both twins build them. */
fn specs() -> Vec<Spec> {
    let accepted = |version: u64, from_version_one: Option<bool>| match from_version_one {
        None => json!({ "status": "accepted", "rosterVersion": version }),
        Some(fetched) => json!({ "status": "accepted", "rosterVersion": version, "fromVersionOne": fetched }),
    };
    let unreadable = || json!({ "status": "record-unreadable" });
    let refused = || json!({ "status": "refused" });
    let older = || json!({ "status": "overtaken", "split": false });
    let fork = |version: u64| json!({ "status": "fork", "version": version });
    let spec = |name, record, change, settings, start, served: Vec<Served>, expected| Spec {
        name,
        record,
        change,
        settings,
        held: None,
        start,
        served,
        expected,
    };
    let held = |spec: Spec| Spec { held: Some(3), ..spec };
    let bad = |s: Served| Served { bad_signature: true, ..s };
    let at3 = Served { branch: Branch::At3, ..served(0, 3) };
    let at2 = Served { branch: Branch::At2, ..served(0, 3) };
    use Change::*;
    use Settings as S;
    vec![
        spec("continues-the-cache", Some(2), None, S::None, 2, vec![served(2, 3)], accepted(3, Some(false))),
        spec(
            "continuation-refused-then-from-version-1",
            Some(2),
            None,
            S::None,
            2,
            vec![bad(served(2, 3)), served(0, 3)],
            accepted(3, Some(true)),
        ),
        spec(
            "record-after-a-master-key-rotation",
            Some(2),
            Some(OtherRoot),
            S::At1,
            2,
            vec![served(2, 3)],
            unreadable(),
        ),
        spec(
            "record-of-another-account",
            Some(2),
            Some(OtherAccount),
            S::At1,
            2,
            vec![served(2, 3)],
            unreadable(),
        ),
        spec(
            "record-of-another-family",
            Some(2),
            Some(OtherFamily),
            S::At1,
            2,
            vec![served(2, 3)],
            unreadable(),
        ),
        spec(
            "record-of-a-newer-release",
            Some(2),
            Some(NewerRecord),
            S::At1,
            2,
            vec![served(2, 3)],
            unreadable(),
        ),
        spec(
            "newer-cache-from-version-1-without-it",
            Some(3),
            Some(NewerCache),
            S::None,
            3,
            vec![served(3, 3), served(0, 3)],
            accepted(3, Some(true)),
        ),
        spec(
            "damaged-cache-from-version-1-without-it",
            Some(3),
            Some(DamagedCache),
            S::None,
            3,
            vec![served(3, 3), served(0, 3)],
            accepted(3, Some(true)),
        ),
        spec(
            "newer-cache-cut-below-the-record-pin",
            Some(3),
            Some(NewerCache),
            S::At1,
            3,
            vec![served(3, 3), served(0, 2)],
            refused(),
        ),
        spec(
            "damaged-cache-cut-below-the-record-pin",
            Some(3),
            Some(DamagedCache),
            S::At1,
            0,
            vec![served(0, 2)],
            refused(),
        ),
        // The break-check of the two above: without the record's own pin, older settings let it in.
        spec(
            "newer-cache-cut-with-no-record-pin",
            Some(3),
            Some(NewerCacheNoPin),
            S::At1,
            3,
            vec![served(3, 3), served(0, 2)],
            accepted(2, Some(true)),
        ),
        spec(
            "record-pin-refused-on-every-path",
            Some(3),
            Some(DamagedPin),
            S::At1,
            0,
            vec![served(0, 3)],
            refused(),
        ),
        spec("cache-is-a-mark-from-version-1", Some(3), None, S::None, 0, vec![at3], fork(3)),
        held(spec(
            "served-older-than-the-committed-chain",
            None,
            None,
            S::At1,
            0,
            vec![served(0, 2)],
            older(),
        )),
        held(spec("committed-chain-is-a-mark", None, None, S::At1, 0, vec![at3], fork(3))),
        spec("no-mark-at-all", None, None, S::None, 0, vec![served(0, 3)], refused()),
        // A session that already committed the family (a warm ledger).
        held(spec(
            "warm-record-at-the-committed-version",
            Some(3),
            None,
            S::None,
            3,
            vec![served(3, 3)],
            accepted(3, Some(false)),
        )),
        held(spec(
            "warm-record-behind-the-committed-chain",
            Some(2),
            None,
            S::None,
            2,
            vec![served(2, 2), served(0, 2)],
            older(),
        )),
        held(spec(
            "warm-damaged-cache-asks-for-version-1",
            Some(3),
            Some(DamagedCache),
            S::None,
            3,
            vec![served(3, 3), served(0, 3)],
            accepted(3, Some(true)),
        )),
        // A damaged cache whose digests are no list names no head: overtaken on the continuation,
        // which is a reason to fetch from version 1, never the answer.
        held(spec(
            "warm-headless-cache-asks-for-version-1",
            Some(3),
            Some(HeadlessCache),
            S::None,
            3,
            vec![served(3, 3), served(0, 3)],
            accepted(3, Some(true)),
        )),
        spec(
            "settings-ahead-of-the-record",
            Some(2),
            None,
            S::At3,
            2,
            vec![served(2, 2), served(0, 2)],
            refused(),
        ),
        spec("settings-on-another-branch", Some(3), None, S::Branch3, 3, vec![served(3, 3)], fork(3)),
        // The background committed roster 3; the foreground, which read the record at 2, gets junk
        // claiming roster 3 (refused, which uncommits), then the genuine rosters 1 and 2.
        held(spec(
            "refused-continuation-keeps-the-floor",
            Some(2),
            None,
            S::None,
            2,
            vec![bad(served(2, 3)), served(0, 2)],
            older(),
        )),
        // With the cache its digests are marks: the fork shows at roster 2 with the cache's side.
        // Without it (only the record's pin, at 3) it would show at 3.
        spec("cache-shows-the-fork-at-roster-2", Some(3), None, S::None, 0, vec![at2], fork(2)),
        // Settings as a version 1 document set nothing: acceptance stays refused until settings open.
        spec("version-1-settings-open-nothing", Some(2), None, S::Legacy, 2, vec![served(2, 3)], refused()),
        // The record is opened before the settings are read, as the worker's marksOf.
        spec(
            "unreadable-record-before-settings",
            Some(2),
            Some(OtherRoot),
            S::Legacy,
            2,
            vec![served(2, 3)],
            unreadable(),
        ),
    ]
}

pub struct Family {
    pub p1: Person,
    pub p2: Person,
    pub h: History,
    pub at3: History,
    pub at2: History,
}

pub fn family() -> &'static Family {
    static FAMILY: OnceLock<Family> = OnceLock::new();
    FAMILY.get_or_init(|| {
        let (p1, p2) = (person(1), person(2));
        let write = |branch_at: Option<usize>| {
            let mut h = History::format_2();
            for at in 0..3 {
                let roles: &[GroupRole] = match (branch_at == Some(at + 1), at % 2) {
                    (true, _) => &[GroupRole::Members],
                    (false, 1) => &[GroupRole::Billing],
                    _ => &[],
                };
                h.roster(
                    &p1,
                    vec![
                        p1.entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active),
                        p2.entry(roles, 1, MemberStatus::Active),
                    ],
                    None,
                );
            }
            h
        };
        let (h, at3, at2) = (write(None), write(Some(3)), write(Some(2)));
        Family { p1, p2, h, at3, at2 }
    })
}

fn served_json(f: &Family, served: Served) -> Value {
    let history = match served.branch {
        Branch::Main => &f.h,
        Branch::At3 => &f.at3,
        Branch::At2 => &f.at2,
    };
    let rosters: Vec<Value> = history.rosters[served.after..served.through]
        .iter()
        .enumerate()
        .map(|(index, signed)| {
            let mut out = signed_json(signed);
            // A continuation the record's cache refuses: a group signature that does not hold.
            if served.bad_signature && index == 0 {
                out["signature"]["ed25519"] = json!(e(&[0; 64]));
            }
            out
        })
        .collect();
    json!({ "after": served.after, "rosters": rosters, "successions": [] })
}

/* A record's JSON changed as the case says, sealed again for the account, family and root it says; with the JSON it holds. */
fn changed(record: &str, change: Option<Change>, f: &Family) -> (String, Value) {
    let mut value = chain_record_open_value(&root(), &f.p1.user_id, GROUP, record).expect("the record opens");
    let Some(change) = change else {
        return (record.to_string(), value);
    };
    let (mut key, mut user, mut group) = (root(), f.p1.user_id.clone(), GROUP);
    match change {
        Change::OtherRoot => key = rotated_root(),
        Change::OtherAccount => user = f.p2.user_id.clone(),
        Change::OtherFamily => group = OTHER_GROUP,
        Change::NewerRecord => value["v"] = json!(2),
        Change::NewerCache => value["cache"]["cacheVersion"] = json!(3),
        Change::DamagedCache => value["cache"]["statement"] = json!(7),
        Change::HeadlessCache => value["cache"]["rosterDigests"] = json!("abc"),
        Change::DamagedPin => value["pin"] = json!({ "rosterVersion": 3 }),
        Change::NewerCacheNoPin => {
            value["cache"]["cacheVersion"] = json!(3);
            value.as_object_mut().unwrap().remove("pin");
        }
    }
    (chain_record_seal_value(&key, &user, group, &value).unwrap(), value)
}

/* Every case, its record sealed by this core's acceptance and changed as it says. */
pub fn device_cases() -> Vec<Value> {
    let f = family();
    let first_keys = f.h.key(1);
    let signer_keys = served_ml_dsa(&[&f.p1, &f.p2]);
    let people = [&f.p1, &f.p2];
    let pin_at = |settings: Settings| match settings {
        Settings::None => Value::Null,
        Settings::At1 => pin_json(&pin_of(&f.h, 1, &people)),
        Settings::At3 => pin_json(&pin_of(&f.h, 3, &people)),
        Settings::Branch3 => pin_json(&pin_of(&f.at3, 3, &people)),
        Settings::Legacy => Value::Null,
    };
    let base = |served: Vec<Value>| {
        json!({
            "firstKeys": { "ed25519PublicKey": first_keys.ed25519_public_key, "mlDsaPublicKey": first_keys.ml_dsa_public_key },
            "signerKeys": signer_keys,
            "served": served,
        })
    };
    let record_through = |through: usize| {
        let mut c = base(vec![served_json(f, served(0, through))]);
        c["name"] = json!("record");
        c["record"] = Value::Null;
        c["settingsPin"] = pin_at(Settings::At1);
        c["held"] = Value::Null;
        c["start"] = json!(0);
        run(&c).1.expect("the record was sealed")
    };
    let records: HashMap<usize, String> = [(2, record_through(2)), (3, record_through(3))].into();
    specs()
        .into_iter()
        .map(|spec| {
            let mut c = base(spec.served.iter().map(|s| served_json(f, *s)).collect());
            c["name"] = json!(spec.name);
            let record = spec.record.map(|at| changed(&records[&at], spec.change, f));
            c["record"] = json!(record.as_ref().map(|(envelope, _)| envelope));
            c["recordValue"] = record.map_or(Value::Null, |(_, value)| value);
            c["recordVersion"] = json!(spec.record);
            c["settingsPin"] = pin_at(spec.settings);
            c["settingsLegacy"] = json!(matches!(spec.settings, Settings::Legacy));
            c["held"] = spec.held.map_or(Value::Null, |through| served_json(f, served(0, through)));
            c["heldSettingsPin"] = if spec.held.is_some() { pin_at(Settings::At1) } else { Value::Null };
            c["start"] = json!(spec.start);
            c["expected"] = spec.expected;
            c
        })
        .collect()
}

fn served_of(c: &Value, after: u64) -> ServedChain {
    let served = c["served"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["after"].as_u64() == Some(after))
        .unwrap_or_else(|| panic!("{}: nothing served after {after}", c["name"]));
    chain_of(c, served)
}

fn chain_of(c: &Value, served: &Value) -> ServedChain {
    ServedChain {
        after: served["after"].as_u64().unwrap(),
        first_keys: GroupPublicKey {
            ed25519_public_key: c["firstKeys"]["ed25519PublicKey"].as_str().unwrap().into(),
            ml_dsa_public_key: c["firstKeys"]["mlDsaPublicKey"].as_str().unwrap().into(),
        },
        rosters: served["rosters"].as_array().unwrap().iter().map(signed_of).collect(),
        successions: served["successions"].as_array().unwrap().iter().map(signed_of).collect(),
        signer_keys: c["signerKeys"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
            .collect(),
    }
}

/* Person `p`'s ledger under `root`: the account opened, its settings not yet. */
pub fn ledger_of(p: &Person, account_root: Vec<u8>) -> Arc<AreaLedger> {
    let ledger = AreaLedger::new();
    let signing = base64url_decode(p.served.signing_public_key.clone()).unwrap();
    ledger.open_account(p.user_id.clone(), signing, account_root).unwrap();
    ledger
}

fn use_settings(ledger: &AreaLedger, p: &Person, pin: &Value) {
    let pins = if pin.is_null() { HashMap::new() } else { [(GROUP.to_string(), pin_from(pin))].into() };
    ledger.use_settings(p.user_id.clone(), Some(pins), Default::default()).unwrap();
}

/*
 * One case through this core's order: accept_served from the case's `start`,
 * and again from version 1 with the same record when it answers
 * FetchFromVersionOne. The outcome as both twins write it, and the record the
 * acceptance sealed.
 */
pub fn run(c: &Value) -> (Value, Option<String>) {
    let f = family();
    let ledger = ledger_of(&f.p1, root());
    let me = OwnIdentities { user_id: f.p1.user_id.clone(), identities: vec![served_keys(&f.p1)] };
    let record = c["record"].as_str().map(str::to_string);
    let accept = |record: Option<String>, served: ServedChain| {
        ledger.accept_served(me.clone(), GROUP.into(), record, served, FamilyGuard::Absent, CHECKED.into())
    };
    if !c["held"].is_null() {
        use_settings(&ledger, &f.p1, &c["heldSettingsPin"]);
        let held = accept(None, chain_of(c, &c["held"]));
        assert!(
            matches!(held, Ok(ServedAcceptance::Accepted { .. })),
            "{}: the held chain is accepted",
            c["name"]
        );
    }
    if c["settingsLegacy"] == json!(true) {
        ledger.legacy_settings(f.p1.user_id.clone()).unwrap();
    } else {
        use_settings(&ledger, &f.p1, &c["settingsPin"]);
    }
    // Without a record there is nothing to continue: from version 1, as the app fetches it.
    let start = if record.is_some() { c["start"].as_u64().unwrap() } else { 0 };
    let mut outcome = accept(record.clone(), served_of(c, start));
    let from_version_one = matches!(outcome, Ok(ServedAcceptance::FetchFromVersionOne));
    if from_version_one {
        outcome = accept(record, served_of(c, 0));
    }
    let mut out = match outcome {
        Ok(ServedAcceptance::Accepted { chain, record, pin, .. }) => {
            let out = json!({ "status": "accepted", "rosterVersion": chain.roster().roster_version, "pin": pin_json(&pin) });
            return (with_fetch(out, from_version_one), Some(record));
        }
        Ok(ServedAcceptance::Fork { of, version, sides }) => json!({
            "status": "fork",
            "of": match of { ForkOf::Roster => "roster", ForkOf::GroupKey => "group-key" },
            "version": version,
            "sides": sides.iter().map(|side| json!({
                "digest": side.digest,
                "from": side.from.iter().map(|from| match from {
                    MarkSource::Pin => "pin",
                    MarkSource::Cache => "cache",
                    MarkSource::Join => "join",
                    MarkSource::Pair => "pair",
                    MarkSource::Served => "served",
                }).collect::<Vec<_>>(),
                "signerUserId": side.signer_user_id,
            })).collect::<Vec<_>>(),
        }),
        Ok(ServedAcceptance::RecordUnreadable) => json!({ "status": "record-unreadable" }),
        Ok(ServedAcceptance::Overtaken { split }) => json!({ "status": "overtaken", "split": split }),
        Ok(ServedAcceptance::FetchFromVersionOne) => panic!("{}: asked for version 1 twice", c["name"]),
        Err(error) => json!({ "status": "refused", "message": error.to_string() }),
    };
    out = with_fetch(out, from_version_one);
    (out, None)
}

fn with_fetch(mut out: Value, from_version_one: bool) -> Value {
    out["fromVersionOne"] = json!(from_version_one);
    out
}

/* Whether an outcome is what its case declares. */
pub fn says(outcome: &Value, expected: &Value) -> bool {
    outcome["status"] == expected["status"]
        && match expected["status"].as_str().unwrap() {
            "accepted" => {
                outcome["rosterVersion"] == expected["rosterVersion"]
                    && (expected["fromVersionOne"].is_null()
                        || outcome["fromVersionOne"] == expected["fromVersionOne"])
            }
            "fork" => outcome["version"] == expected["version"],
            "overtaken" => outcome["split"] == expected["split"],
            _ => true,
        }
}

/* The app's own records in the device store: what one twin sealed, opened by the other as each row says. */
pub fn store_value() -> Value {
    json!({ "calls": [{ "id": "a", "body": "x" }], "v": 1 })
}

pub fn store_rows() -> Value {
    let f = family();
    let envelope = ledger_of(&f.p1, root())
        .group_device_record_seal(GROUP.into(), DeviceStore::Outbox, store_value().to_string())
        .unwrap();
    let at = |over: Value| {
        let mut open =
            json!({ "root": e(&root()), "userId": f.p1.user_id, "groupId": GROUP, "store": "outbox" });
        for (key, value) in over.as_object().unwrap() {
            open[key] = value.clone();
        }
        open
    };
    json!({
        "envelope": envelope,
        "rows": [
            { "name": "as-sealed", "open": at(json!({})), "value": store_value() },
            { "name": "another-store", "open": at(json!({ "store": "joins" })), "value": null },
            { "name": "another-family", "open": at(json!({ "groupId": OTHER_GROUP })), "value": null },
            { "name": "another-account", "open": at(json!({ "userId": f.p2.user_id })), "value": null },
            { "name": "a-rotated-root", "open": at(json!({ "root": e(&rotated_root()) })), "value": null },
        ],
    })
}

/* A row opened here, by the account it names under the root it names: the value, or null when it does not open. */
pub fn open_row(envelope: &str, row: &Value) -> Value {
    let f = family();
    let open = &row["open"];
    let who = if open["userId"] == json!(f.p2.user_id) { &f.p2 } else { &f.p1 };
    let root = base64url_decode(open["root"].as_str().unwrap().into()).unwrap();
    let store = match open["store"].as_str().unwrap() {
        "outbox" => DeviceStore::Outbox,
        // The core's own stores are no app's to open: read as the fixtures read them.
        other => {
            let group = open["groupId"].as_str().unwrap();
            return device_store_open_value(&root, &who.user_id, group, other, envelope)
                .unwrap_or(Value::Null);
        }
    };
    let ledger = ledger_of(who, root);
    match ledger.group_device_record_open(open["groupId"].as_str().unwrap().into(), store, envelope.into()) {
        Ok(text) => serde_json::from_str(&text).unwrap(),
        Err(CoreError::Sealed(_)) => Value::Null,
        Err(other) => panic!("{}: {other}", row["name"]),
    }
}

/* The shared merge cases, as this core decides them. */
pub fn merge_cases() -> Vec<Value> {
    let file: Value = serde_json::from_str(include_str!("../../fixtures/merge-pin-cases.json"))
        .expect("fixtures/merge-pin-cases.json is JSON");
    file["cases"].as_array().unwrap().clone()
}

pub fn merge_result(c: &Value) -> Value {
    let current = (!c["current"].is_null()).then(|| pin_from(&c["current"]));
    let next = pin_from(&c["next"]);
    let opened: Vec<Arc<OpenedArea>> = c["opened"]
        .as_array()
        .unwrap()
        .iter()
        .map(|area| {
            opened_area(
                area["groupId"].as_str().unwrap().into(),
                area["workspaceId"].as_str().unwrap().into(),
                area["version"].as_u64().unwrap(),
            )
        })
        .collect();
    match merge_pin(c["groupId"].as_str().unwrap().into(), current.clone(), next, opened) {
        Err(_) => json!("refused"),
        Ok(PinMerge::Behind) => json!("behind"),
        Ok(PinMerge::Conflict) => json!("conflict"),
        Ok(PinMerge::Merged { pin }) => {
            json!({ "merged": pin_json(&pin), "ahead": pin_ahead(current, pin.clone()) })
        }
    }
}
