//! Joining and consent (groups 1d, Core 4), for the shared fixtures: the twin
//! of `packages/crypto/src/join-testkit.ts`. Both build the same cases in the
//! same order from the same people (group testkit persons 1, 2 and 3; person 2
//! is the newcomer who previews), write the histories they signed, the chain
//! records their own acceptance sealed and the identities their own code made,
//! and run the other twin's document through their own code to the same
//! outcome:
//!
//! - `joinPreviews`: `AreaLedger::group_join_preview` (the worker's
//!   `groupJoinPreview`) over named histories, each case's outcome in full;
//! - `joinChecks`: `join_check` (`joinCheck`) over `fixtures/join-check-cases.json`;
//! - `consents`: `links_needing_consent` (`linksNeedingConsent`) and
//!   `succession_consent_sign` (the worker's `identityConsent`) over one
//!   account's identities, every consent either twin signed verified by the other.
//!
//! Used by `tests/join_fixtures.rs` and `examples/join_fixtures.rs`.
#![allow(dead_code)]

use super::device_records::{ledger_of, root, rotated_root};
use super::groups::{
    e, group_seed, n, pattern, person, pin_from, pin_json, pin_of, s, served_keys, served_ml_dsa,
    signed_json, signed_of, History, Person, GROUP,
};
use hushos_core::*;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

/* Join previews ------------------------------------------------------------ */

pub struct Family {
    pub p1: Person,
    pub p2: Person,
    pub p3: Person,
    /* Person 2 let in at roster 2, roles changed at 3, marked left at 4, let in again at 5. */
    pub main: History,
    /* The same, with person 2 admitted with other roles: another admission. */
    pub other: History,
    /* Person 3, a holder, removed at 2; a succession; person 2 let in at 3 under key 2. */
    pub succ: History,
    /* Another roster 2 that leaves person 2 out: served beside main's, a dead branch. */
    pub dead: History,
    /*
     * Person 3, a holder, at 2; person 2 let in at 3 (on first use), billing at 4; person 3
     * removed at 5 with every folder rotated and a succession tied to it.
     */
    pub removal: History,
    /* The same to 3, then another 4 and 5 (person 2 with members): another history above 3. */
    pub removal_fork: History,
    /* succ's rosters 1 and 2, then a succession to another key 2 (seed 7) and roster 3 under it. */
    pub succ_other: (Vec<SignedGroupStatement>, Vec<SignedGroupStatement>),
}

fn join_with(p1: &Person, p2: &Person, roles: &[GroupRole]) -> History {
    let owner = p1.entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active);
    let mut h = History::format_2();
    h.roster(p1, vec![owner.clone()], None);
    h.roster(p1, vec![owner.clone(), p2.entry(roles, 1, MemberStatus::Active)], None);
    h.roster(p1, vec![owner.clone(), p2.entry(&[GroupRole::Billing], 1, MemberStatus::Active)], None);
    h.roster(p1, vec![owner.clone(), p2.entry(&[GroupRole::Billing], 1, MemberStatus::Left)], None);
    h.roster(p1, vec![owner, p2.entry(&[], 1, MemberStatus::Active)], None);
    h
}

pub fn family() -> &'static Family {
    static FAMILY: OnceLock<Family> = OnceLock::new();
    FAMILY.get_or_init(|| {
        let (p1, p2, p3) = (person(1), person(2), person(3));
        let main = join_with(&p1, &p2, &[]);
        let other = join_with(&p1, &p2, &[GroupRole::Billing]);
        let owner = p1.entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active);
        let mut succ = History::format_2();
        succ.roster(&p1, vec![owner.clone(), p3.entry(&[GroupRole::Members], 1, MemberStatus::Active)], None);
        succ.roster(&p1, vec![owner.clone(), p3.entry(&[GroupRole::Members], 1, MemberStatus::Left)], None);
        succ.succession(&p1);
        succ.roster(
            &p1,
            vec![
                owner.clone(),
                p3.entry(&[GroupRole::Members], 1, MemberStatus::Left),
                p2.entry(&[], 1, MemberStatus::Active),
            ],
            Some(2),
        );
        let mut dead = History::format_2();
        dead.roster(&p1, vec![owner.clone()], None);
        dead.roster(&p1, vec![owner.clone()], None);
        let removal_of = |later: &[GroupRole]| {
            let mut h = History::format_2();
            let holder = p3.entry(&[GroupRole::Members], 1, MemberStatus::Active);
            h.roster(&p1, vec![owner.clone()], None);
            h.roster(&p1, vec![owner.clone(), holder.clone()], None);
            h.roster(&p1, vec![owner.clone(), holder.clone(), p2.entry(&[], 1, MemberStatus::Active)], None);
            h.roster(&p1, vec![owner.clone(), holder, p2.entry(later, 1, MemberStatus::Active)], None);
            h.roster(
                &p1,
                vec![
                    owner.clone(),
                    p3.entry(&[GroupRole::Members], 1, MemberStatus::Left),
                    p2.entry(later, 1, MemberStatus::Active),
                ],
                None,
            );
            h.succession(&p1);
            h
        };
        let removal = removal_of(&[GroupRole::Billing]);
        let removal_fork = removal_of(&[GroupRole::Members]);
        let (key1, other7) = (succ.key(1), group_public_key(group_seed(7)).unwrap());
        let away = GroupKeySuccession {
            group_id: GROUP.into(),
            old_version: 1,
            new_version: 2,
            old_ed25519_public_key: key1.ed25519_public_key,
            old_ml_dsa_public_key: key1.ml_dsa_public_key,
            new_ed25519_public_key: other7.ed25519_public_key,
            new_ml_dsa_public_key: other7.ml_dsa_public_key,
            last_roster_version: 2,
            last_roster_digest: roster_digest(succ.rosters[1].statement.clone()),
            signer_user_id: p1.user_id.clone(),
        };
        let away = group_succession_sign(away, group_seed(1), p1.keys.clone()).unwrap();
        let third = roster_sign(succ.statements[2].clone(), group_seed(7), p1.keys.clone()).unwrap();
        let succ_other = (vec![succ.rosters[0].clone(), succ.rosters[1].clone(), third], vec![away]);
        Family { p1, p2, p3, main, other, succ, dead, removal, removal_fork, succ_other }
    })
}

/* The version 1 keys the server made up, under which it re-signs main's first three rosters. */
fn made_up_seed() -> Vec<u8> {
    pattern(64, 150)
}

fn history_json(
    first_keys: &GroupPublicKey,
    rosters: &[SignedGroupStatement],
    successions: &[SignedGroupStatement],
) -> Value {
    json!({
        "firstKeys": { "ed25519PublicKey": first_keys.ed25519_public_key, "mlDsaPublicKey": first_keys.ml_dsa_public_key },
        "rosters": rosters.iter().map(signed_json).collect::<Vec<_>>(),
        "successions": successions.iter().map(signed_json).collect::<Vec<_>>(),
    })
}

/* The code the admitting admin's screen shows for roster `version` of `h`, under key `key_version`. */
fn admin_code(h: &History, version: usize, key_version: u8) -> Vec<String> {
    join_code(roster_digest(h.rosters[version - 1].statement.clone()), h.key(key_version), key_version as u64)
        .unwrap()
}

#[derive(Clone, Copy)]
enum Settings {
    /* Opened, with no pin for the family. */
    None,
    /* A rejoin: the settings pin at main's roster 2. */
    PinMain2,
    NotOpen,
}

#[derive(Clone, Copy)]
enum Held {
    Chain,
    Fork,
}

struct Spec {
    name: &'static str,
    settings: Settings,
    record: Option<&'static str>,
    held: Option<Held>,
    history: &'static str,
    after: usize,
    through: usize,
    cut: Option<&'static str>,
    /* `me` as another account than the one unlocked, or without the account's signing key. */
    me: Option<&'static str>,
    expected: Value,
}

const LEFT_OUT: &str = "The server left out part of the family’s member list.";
const UNSIGNED: &str = "This roster is not signed by the group key.";
/* What acceptance answers when nothing vouches for the served first keys. */
const UNCHECKED: &str = "These group keys have not been checked: compare the join code first.";

/* The cases, in the order both twins build them. */
fn specs() -> Vec<Spec> {
    let f = family();
    let code = |version: u64, words: Vec<String>| json!({ "status": "code", "rosterVersion": version, "code": words });
    let not_code = |version: u64, words: Vec<String>| json!({ "status": "code", "rosterVersion": version, "notCode": words });
    let not_admitted = || json!({ "status": "not-admitted" });
    let fork = || json!({ "status": "fork" });
    let refused = |message: Option<&str>| json!({ "status": "refused", "message": message });
    let spec = |name, history, through, expected| Spec {
        name,
        settings: Settings::None,
        record: None,
        held: None,
        history,
        after: 0,
        through,
        cut: None,
        me: None,
        expected,
    };
    let honest = admin_code(&f.main, 2, 1);
    vec![
        spec("admitted-at-roster-2", "main", 2, code(2, honest.clone())),
        spec("the-head-moved-on", "main", 3, code(2, honest.clone())),
        spec("not-let-in-yet", "main", 1, not_admitted()),
        spec("marked-left", "main", 4, not_admitted()),
        spec("let-in-again", "main", 5, code(5, admin_code(&f.main, 5, 1))),
        spec("another-admission", "other", 2, {
            let mut out = code(2, admin_code(&f.other, 2, 1));
            out["notCode"] = json!(honest.clone());
            out
        }),
        spec("made-up-first-keys", "madeUp", 3, not_code(2, honest.clone())),
        spec("after-a-succession", "succ", 3, {
            let mut out = code(3, admin_code(&f.succ, 3, 2));
            out["notCode"] = json!(admin_code(&f.succ, 3, 1));
            out
        }),
        Spec { settings: Settings::PinMain2, ..spec("a-rejoin-pin-on-another-history", "other", 2, fork()) },
        Spec {
            settings: Settings::PinMain2,
            ..spec("a-rejoin-pin-agrees", "main", 5, code(5, admin_code(&f.main, 5, 1)))
        },
        Spec {
            record: Some("3"),
            ..spec("the-record-continues", "main", 5, code(5, admin_code(&f.main, 5, 1)))
        },
        Spec { record: Some("3"), ..spec("the-record-on-another-history", "other", 3, fork()) },
        Spec {
            record: Some("2-other-root"),
            ..spec(
                "a-record-after-a-master-key-rotation",
                "main",
                3,
                json!({ "status": "record-unreadable" }),
            )
        },
        Spec {
            record: Some("2"),
            after: 2,
            ..spec("a-roster-of-the-run-left-out", "main", 3, refused(Some(LEFT_OUT)))
        },
        Spec {
            cut: Some("beside"),
            ..spec("a-roster-beside-the-chain-is-not-read", "main", 3, code(2, honest.clone()))
        },
        Spec {
            settings: Settings::NotOpen,
            ..spec("settings-first", "main", 2, refused(Some("Open your settings first.")))
        },
        Spec {
            cut: Some("bad-signature"),
            ..spec("a-bad-group-signature", "main", 2, refused(Some(UNSIGNED)))
        },
        Spec {
            held: Some(Held::Chain),
            ..spec("a-chain-this-session-holds-is-a-mark", "main", 3, refused(Some(UNCHECKED)))
        },
        Spec {
            held: Some(Held::Fork),
            ..spec("a-fork-this-session-holds-is-a-mark", "main", 3, refused(Some(UNCHECKED)))
        },
        // The account checked in the worker's order: another account first, then the record,
        // then the settings, then the identity.
        Spec {
            me: Some("other-account"),
            ..spec(
                "another-account-than-the-one-unlocked",
                "main",
                2,
                refused(Some("Unlock your account first.")),
            )
        },
        Spec {
            me: Some("not-open"),
            ..spec("an-identity-not-open", "main", 2, refused(Some("Open your identity first.")))
        },
        Spec {
            me: Some("not-open"),
            record: Some("2-other-root"),
            ..spec(
                "an-unreadable-record-before-the-identity",
                "main",
                2,
                json!({ "status": "record-unreadable" }),
            )
        },
    ]
}

/* The record person 2's device keeps after accepting main's first `through` rosters, pinned at 2. */
fn record_through(through: usize) -> String {
    let f = family();
    let ledger = ledger_of(&f.p2, root());
    let pin = pin_of(&f.main, 2, &[&f.p1, &f.p2]);
    ledger
        .use_settings(f.p2.user_id.clone(), Some([(GROUP.to_string(), pin)].into()), Default::default())
        .unwrap();
    let served = ServedChain {
        after: 0,
        first_keys: f.main.key(1),
        rosters: f.main.rosters[..through].to_vec(),
        successions: vec![],
        signer_keys: served_ml_dsa(&[&f.p1, &f.p2, &f.p3]),
    };
    match ledger
        .accept_served(me(), GROUP.into(), None, served, FamilyGuard::Absent, super::groups::CHECKED.into())
        .unwrap()
    {
        ServedAcceptance::Accepted { record, .. } => record,
        _ => panic!("the record was not sealed"),
    }
}

fn me() -> OwnIdentities {
    let f = family();
    OwnIdentities { user_id: f.p2.user_id.clone(), identities: vec![served_keys(&f.p2)] }
}

/* Every case and what it runs over, as this twin signed and sealed it. */
pub fn preview_doc() -> Value {
    let f = family();
    let made_up = made_up_seed();
    let remade: Vec<SignedGroupStatement> = f.main.rosters[..3]
        .iter()
        .map(|signed| SignedGroupStatement {
            signature: group_sign(made_up.clone(), signed.statement.clone()).unwrap(),
            ..signed.clone()
        })
        .collect();
    let histories = json!({
        "main": history_json(&f.main.key(1), &f.main.rosters, &f.main.successions),
        "other": history_json(&f.other.key(1), &f.other.rosters, &f.other.successions),
        "succ": history_json(&f.succ.key(1), &f.succ.rosters, &f.succ.successions),
        "madeUp": history_json(&group_public_key(made_up).unwrap(), &remade, &[]),
        "dead": history_json(&f.dead.key(1), &f.dead.rosters, &f.dead.successions),
        "removal": history_json(&f.removal.key(1), &f.removal.rosters, &f.removal.successions),
        "removalFork": history_json(&f.removal_fork.key(1), &f.removal_fork.rosters, &f.removal_fork.successions),
        "succOther": history_json(&f.succ.key(1), &f.succ_other.0, &f.succ_other.1),
    });
    let rotated = {
        let record = record_through(2);
        let value = chain_record_open_value(&root(), &f.p2.user_id, GROUP, &record).unwrap();
        chain_record_seal_value(&rotated_root(), &f.p2.user_id, GROUP, &value).unwrap()
    };
    let (two, three) = (record_through(2), record_through(3));
    let value_of = |record: &str| chain_record_open_value(&root(), &f.p2.user_id, GROUP, record).unwrap();
    // The JSON each record holds, for the fuzz seeds.
    let record_values = json!({ "2": value_of(&two), "3": value_of(&three) });
    let records = json!({ "2": two, "3": three, "2-other-root": rotated });
    let cases: Vec<Value> = specs()
        .into_iter()
        .map(|spec| {
            json!({
                "name": spec.name,
                "settings": match spec.settings { Settings::None => "none", Settings::PinMain2 => "pin-main-2", Settings::NotOpen => "not-open" },
                "record": spec.record,
                "held": spec.held.map(|held| match held { Held::Chain => "chain", Held::Fork => "fork" }),
                "served": { "history": spec.history, "after": spec.after, "through": spec.through, "cut": spec.cut },
                "me": spec.me,
                "expected": spec.expected,
            })
        })
        .collect();
    json!({
        "histories": histories,
        "signerKeys": served_ml_dsa(&[&f.p1, &f.p2, &f.p3]),
        "pinMain2": pin_json(&pin_of(&f.main, 2, &[&f.p1, &f.p2])),
        "records": records,
        "recordValues": record_values,
        "cases": cases,
    })
}

/* What a case's served chain carries, from the document's histories. */
pub fn served_of(doc: &Value, served: &Value) -> ServedChain {
    let history = &doc["histories"][s(served, "history")];
    let rosters: Vec<SignedGroupStatement> =
        history["rosters"].as_array().unwrap().iter().map(signed_of).collect();
    let (after, through) = (n(served, "after") as usize, n(served, "through") as usize);
    let mut cut = rosters[after..through].to_vec();
    match served["cut"].as_str() {
        None => {}
        // Another roster 2, served right after the chain's own.
        Some("beside") => cut.insert(2 - after, signed_of(&doc["histories"]["dead"]["rosters"][1])),
        // The last roster's group signature, zeroed.
        Some("bad-signature") => {
            let last = cut.last_mut().unwrap();
            last.signature.ed25519 = vec![0; 64];
        }
        Some(other) => panic!("a cut {other}"),
    }
    ServedChain {
        after: after as u64,
        first_keys: GroupPublicKey {
            ed25519_public_key: s(&history["firstKeys"], "ed25519PublicKey"),
            ml_dsa_public_key: s(&history["firstKeys"], "mlDsaPublicKey"),
        },
        rosters: cut,
        successions: history["successions"].as_array().unwrap().iter().map(signed_of).collect(),
        signer_keys: signer_keys(doc),
    }
}

fn signer_keys(doc: &Value) -> HashMap<String, String> {
    doc["signerKeys"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
        .collect()
}

fn settings_of(ledger: &AreaLedger, doc: &Value, which: &str) {
    let user = family().p2.user_id.clone();
    let pins: HashMap<String, GroupPin> = match which {
        "none" | "checked-before" | "checked-malformed" => HashMap::new(),
        "pin-main-2" => [(GROUP.to_string(), pin_from(&doc["pinMain2"]))].into(),
        "not-open" => return,
        other => panic!("settings {other}"),
    };
    ledger.use_settings(user.clone(), Some(pins), Default::default()).unwrap();
    // A family check record with no code (the migration's `before`, a mark but no pair mark), or
    // one that is no pair mark at all.
    let checks = match which {
        "checked-before" => json!({ GROUP: { "how": "before", "rosterVersion": 2 } }),
        "checked-malformed" => json!({ GROUP: { "rosterVersion": 2, "with": "someone", "code": "words" } }),
        _ => return,
    };
    ledger.use_family_checks(user, checks.to_string()).unwrap();
}

pub fn fork_json(of: ForkOf, version: u64, sides: &[MarkSide]) -> Value {
    json!({
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
    })
}

/* The draws both twins' fixture ledgers take for hidden positions: the same list, from the start, on every ledger. */
pub fn draws() -> Vec<u32> {
    (0..256u64)
        // The second draw repeats the first, so a showing draws its second position anew.
        .map(|i| if i == 1 { 0 } else { i })
        .map(|i| if i % 7 == 3 { u32::MAX } else { ((i * 2_654_435_761 + 12_345) % (1 << 32)) as u32 })
        .collect()
}

/* Person `p`'s ledger under `account_root`, drawing positions from draws(): the account opened, its settings not yet. */
pub fn drawn_ledger(p: &Person, account_root: Vec<u8>) -> std::sync::Arc<AreaLedger> {
    let ledger = AreaLedger::with_draws(draws());
    let signing = base64url_decode(p.served.signing_public_key.clone()).unwrap();
    ledger.open_account(p.user_id.clone(), signing, account_root).unwrap();
    ledger
}

/* The `me` a case runs as: person 2, another account, or person 2 without their signing key. */
fn me_of(c: &Value) -> OwnIdentities {
    let f = family();
    match c["me"].as_str() {
        None => me(),
        Some("other-account") => {
            OwnIdentities { user_id: f.p1.user_id.clone(), identities: vec![served_keys(&f.p1)] }
        }
        Some("not-open") => {
            OwnIdentities { user_id: f.p2.user_id.clone(), identities: vec![served_keys(&f.p1)] }
        }
        Some(other) => panic!("me {other}"),
    }
}

pub fn preview_json(preview: CoreResult<JoinPreview>) -> Value {
    match preview {
        Ok(JoinPreview::Code { roster_version, code, session }) => {
            json!({ "status": "code", "rosterVersion": roster_version, "code": code, "hidden": session.hidden() })
        }
        Ok(JoinPreview::NotAdmitted) => json!({ "status": "not-admitted" }),
        Ok(JoinPreview::Fork { of, version, sides }) => fork_json(of, version, &sides),
        Ok(JoinPreview::RecordUnreadable) => json!({ "status": "record-unreadable" }),
        Err(error) => json!({ "status": "refused", "message": error.to_string() }),
    }
}

/* One case through this core, on `doc`'s histories and records: the outcome as both twins write it. */
pub fn run_preview(doc: &Value, c: &Value) -> Value {
    let f = family();
    let ledger = drawn_ledger(&f.p2, root());
    if let Some(held) = c["held"].as_str() {
        settings_of(&ledger, doc, "pin-main-2");
        let history = if held == "chain" { "main" } else { "other" };
        let served = served_of(doc, &json!({ "history": history, "after": 0, "through": 2 }));
        let outcome = ledger
            .accept_served(
                me(),
                GROUP.into(),
                None,
                served,
                FamilyGuard::Absent,
                super::groups::CHECKED.into(),
            )
            .unwrap();
        let fits = matches!(
            (held, outcome),
            ("chain", ServedAcceptance::Accepted { .. }) | ("fork", ServedAcceptance::Fork { .. })
        );
        assert!(fits, "{}: the held {held} was not reached", c["name"]);
    }
    settings_of(&ledger, doc, &s(c, "settings"));
    let record = c["record"].as_str().map(|name| s(&doc["records"], name));
    preview_json(ledger.group_join_preview(
        me_of(c),
        GROUP.into(),
        record,
        served_of(doc, &c["served"]),
        None,
    ))
}

/* Whether an outcome is what its case declares. */
pub fn preview_says(outcome: &Value, expected: &Value) -> bool {
    let field = |key: &str| expected.get(key).is_none_or(|want| &outcome[key] == want);
    outcome["status"] == expected["status"]
        && field("rosterVersion")
        && field("code")
        && field("message")
        && expected.get("notCode").is_none_or(|not| &outcome["code"] != not)
}

/* Join checks -------------------------------------------------------------- */

pub fn check_cases() -> Value {
    serde_json::from_str(include_str!("../../fixtures/join-check-cases.json"))
        .expect("fixtures/join-check-cases.json is JSON")
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect()
}

/* One shared case through join_words: "match", "no-match", "incomplete" or {"refused": message}. */
pub fn run_check(file: &Value, c: &Value) -> Value {
    let code = strings(c.get("code").unwrap_or(&file["code"]));
    let hidden: Vec<u32> =
        c["hidden"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect();
    match join_words(code, hidden, strings(&c["typed"])) {
        Ok(JoinWords::Match) => json!("match"),
        Ok(JoinWords::NoMatch) => json!("no-match"),
        Ok(JoinWords::Incomplete) => json!("incomplete"),
        Err(error) => json!({ "refused": error.to_string() }),
    }
}

/* Consents ----------------------------------------------------------------- */

pub const CONSENT_USER: &str = "00000007-abcd-4abc-8abc-abcdefabcdef";

pub fn consent_root() -> Vec<u8> {
    pattern(32, 120)
}

fn other_root() -> Vec<u8> {
    pattern(32, 121)
}

/* An identity envelope as the API and the web write it. */
pub fn envelope_json(envelope: &IdentityEnvelope) -> Value {
    json!({
        "version": envelope.version, "keyVersion": envelope.key_version, "wrappingSalt": envelope.wrapping_salt,
        "encryptionPublicKey": envelope.encryption_public_key, "encryptionPrivateKeyNonce": envelope.encryption_private_key_nonce,
        "encryptedEncryptionPrivateKey": envelope.encrypted_encryption_private_key,
        "signingPublicKey": envelope.signing_public_key, "signingSeedNonce": envelope.signing_seed_nonce, "encryptedSigningSeed": envelope.encrypted_signing_seed,
        "kem": envelope.kem.as_ref().map(|k| json!({ "publicKey": k.public_key, "seedNonce": k.seed_nonce, "encryptedSeed": k.encrypted_seed })),
        "mlDsa": envelope.ml_dsa.as_ref().map(|k| json!({ "publicKey": k.public_key, "seedNonce": k.seed_nonce, "encryptedSeed": k.encrypted_seed })),
        "keysSignature": envelope.keys_signature,
    })
}

pub fn envelope_of(value: &Value) -> IdentityEnvelope {
    let text = |v: &Value, k: &str| v[k].as_str().unwrap_or_else(|| panic!("{k}")).to_string();
    IdentityEnvelope {
        version: value["version"].as_u64().unwrap() as u32,
        key_version: value["keyVersion"].as_u64().unwrap(),
        wrapping_salt: text(value, "wrappingSalt"),
        encryption_public_key: text(value, "encryptionPublicKey"),
        encryption_private_key_nonce: text(value, "encryptionPrivateKeyNonce"),
        encrypted_encryption_private_key: text(value, "encryptedEncryptionPrivateKey"),
        signing_public_key: text(value, "signingPublicKey"),
        signing_seed_nonce: text(value, "signingSeedNonce"),
        encrypted_signing_seed: text(value, "encryptedSigningSeed"),
        kem: value["kem"].as_object().map(|_| IdentityKem {
            public_key: text(&value["kem"], "publicKey"),
            seed_nonce: text(&value["kem"], "seedNonce"),
            encrypted_seed: text(&value["kem"], "encryptedSeed"),
            signature: value["kem"]["signature"].as_str().map(Into::into),
        }),
        ml_dsa: value["mlDsa"].as_object().map(|_| IdentityMlDsa {
            public_key: text(&value["mlDsa"], "publicKey"),
            seed_nonce: text(&value["mlDsa"], "seedNonce"),
            encrypted_seed: text(&value["mlDsa"], "encryptedSeed"),
        }),
        keys_signature: value["keysSignature"].as_str().map(Into::into),
    }
}

/* The link the server serves for a succession from `old` to `next`, with `signature` and `consent`. */
pub fn link_between(
    old: &IdentityEnvelope,
    next: &IdentityEnvelope,
    signature: &str,
    consent: Option<&str>,
) -> SuccessionLink {
    let ml = |e: &IdentityEnvelope| e.ml_dsa.as_ref().map_or(String::new(), |k| k.public_key.clone());
    SuccessionLink {
        old_key_version: old.key_version,
        new_key_version: next.key_version,
        old_encryption_public_key: old.encryption_public_key.clone(),
        old_signing_public_key: old.signing_public_key.clone(),
        old_ml_dsa_public_key: ml(old),
        new_encryption_public_key: next.encryption_public_key.clone(),
        new_signing_public_key: next.signing_public_key.clone(),
        new_ml_dsa_public_key: ml(next),
        new_kem_public_key: next.kem.as_ref().map_or(String::new(), |k| k.public_key.clone()),
        signature: signature.into(),
        consent: consent.map(Into::into),
    }
}

pub fn link_json(l: &SuccessionLink) -> Value {
    super::groups::link_json(l)
}

pub fn served_keys_json(envelope: &IdentityEnvelope) -> Value {
    let p = public_identity(envelope.clone()).unwrap();
    json!({
        "keyVersion": p.key_version, "encryptionPublicKey": p.encryption_public_key,
        "signingPublicKey": p.signing_public_key, "mlDsaPublicKey": p.ml_dsa_public_key, "kemPublicKey": p.kem_public_key,
    })
}

/* The due and sign cases, in the order both twins build them. */
fn due_specs() -> Value {
    json!([
        { "name": "only-links-without-consent", "links": ["ab", "bcConsented"], "identities": ["a", "b", "c"],
          "expected": [{ "oldKeyVersion": 1, "old": 0, "next": 1 }] },
        { "name": "empty-consent-is-none", "links": ["abEmpty"], "identities": ["a", "b", "c"],
          "expected": [{ "oldKeyVersion": 1, "old": 0, "next": 1 }] },
        { "name": "a-version-1-identity-is-never-offered", "links": ["ab", "bc"], "identities": ["aLegacy", "b", "c"],
          "expected": [{ "oldKeyVersion": 2, "old": 1, "next": 2 }] },
        { "name": "a-version-1-claim-beside-an-ml-dsa-key", "links": ["ab"], "identities": ["aClaimsV1", "b"], "expected": [] },
        { "name": "keys-that-are-not-the-account-s", "links": ["abKem"], "identities": ["a", "b", "c"], "expected": [] },
        { "name": "an-identity-at-another-key-version", "links": ["ab"], "identities": ["aMoved", "b"], "expected": [] },
        { "name": "the-next-identity-at-another-key-version", "links": ["ab"], "identities": ["a", "bMoved"], "expected": [] },
        { "name": "an-identity-the-account-does-not-have", "links": ["ab"], "identities": ["a", "c"], "expected": [] },
        { "name": "the-first-copy-is-offered", "links": ["ab"], "identities": ["bTampered", "b", "a"],
          "expected": [{ "oldKeyVersion": 1, "old": 2, "next": 0 }] },
    ])
}

fn sign_specs() -> Value {
    let upgraded = "Only a link between two upgraded identities takes consent.";
    let not_own = "This identity does not open on this account.";
    let apart = "These are not two identities this device opened one after the other.";
    let not_link = "This link is not one this account made.";
    let all = json!(["a", "b", "c"]);
    let case = |name: &str, old: &str, next: &str, link: &str, me: Value, expected: Value| json!({ "name": name, "old": old, "next": next, "link": link, "me": me, "expected": expected });
    let signed = || json!({ "status": "signed" });
    let refused = |message: &str| json!({ "status": "refused", "message": message });
    Value::Array(vec![
        case("one-step", "a", "b", "ab", all.clone(), signed()),
        case("the-next-step-listed-in-any-order", "b", "c", "bc", json!(["c", "a", "b"]), signed()),
        case("a-version-1-identity", "aLegacy", "b", "ab", all.clone(), refused(upgraded)),
        case("backwards", "b", "a", "ab", all.clone(), refused(upgraded)),
        case("another-account-root", "a", "bOtherRoot", "ab", all.clone(), refused(not_own)),
        case("a-keys-statement-that-does-not-hold", "a", "bTampered", "ab", all.clone(), refused(not_own)),
        case("a-link-naming-other-keys", "a", "b", "bc", all.clone(), refused(not_link)),
        case("a-made-up-link-past-an-identity", "a", "c", "acServed", all.clone(), refused(not_link)),
        case(
            "leaving-b-out-makes-no-made-up-link-a-step",
            "a",
            "c",
            "acServed",
            json!(["a", "c"]),
            refused(not_link),
        ),
        case("a-link-the-account-signed-that-skips-one", "a", "c", "acSigned", all.clone(), refused(apart)),
        case("a-link-naming-other-old-keys", "a", "c", "bcSignedByA", json!(["a", "c"]), refused(not_link)),
        // A genuine link to b, offered for a and c with b left out: the link names other keys.
        case("a-genuine-link-offered-for-another-step", "a", "c", "ab", json!(["a", "c"]), refused(not_link)),
        case("the-app-left-one-out", "a", "b", "ab", json!(["a", "c"]), refused(apart)),
        {
            let mut other =
                case("another-account", "a", "b", "ab", all, refused("Unlock your account first."));
            other["meUser"] = json!("00000009-abcd-4abc-8abc-abcdefabcdef");
            other
        },
    ])
}

/* The account's identities and links as this core makes them (fresh keys every run), and the cases. */
pub fn consent_doc() -> Value {
    let (user, root) = (CONSENT_USER.to_string(), consent_root());
    let a = identity_create(user.clone(), root.clone(), 1).unwrap();
    let b = identity_succeed(user.clone(), root.clone(), a.clone()).unwrap();
    let c = identity_succeed(user.clone(), root.clone(), b.identity.clone()).unwrap();
    let mut tampered = b.identity.clone();
    let mut signature = base64url_decode(tampered.keys_signature.clone().unwrap()).unwrap();
    signature[100] ^= 1;
    tampered.keys_signature = Some(e(&signature));
    let identities = json!({
        "a": envelope_json(&a),
        "b": envelope_json(&b.identity),
        "c": envelope_json(&c.identity),
        "aLegacy": envelope_json(&IdentityEnvelope { version: 1, ml_dsa: None, keys_signature: None, ..a.clone() }),
        "aClaimsV1": envelope_json(&IdentityEnvelope { version: 1, ..a.clone() }),
        "aMoved": envelope_json(&IdentityEnvelope { key_version: 7, ..a.clone() }),
        "bMoved": envelope_json(&IdentityEnvelope { key_version: 7, ..b.identity.clone() }),
        "bOtherRoot": envelope_json(&identity_create(user.clone(), other_root(), 2).unwrap()),
        "bTampered": envelope_json(&tampered),
    });
    let ab = link_between(&a, &b.identity, &b.signature, None);
    let bc = link_between(&b.identity, &c.identity, &c.signature, None);
    // a → c: as a server could make it up (b → c's signature, not a's), and as a itself signed it.
    let ac_served = link_between(&a, &c.identity, &c.signature, None);
    let a_keys = identity_open(user.clone(), root.clone(), a.clone()).unwrap();
    let statement = succession_statement(user.clone(), ac_served.clone()).unwrap();
    let ac_signature =
        hybrid_sign(a_keys.signing_seed.to_vec(), a_keys.ml_dsa_seed.to_vec(), statement).unwrap();
    let ac_signed = SuccessionLink { signature: e(&ac_signature), ..ac_served.clone() };
    // b → c's statement, signed by a: a link that verifies under a's keys but names other old keys.
    let bc_statement = succession_statement(user.clone(), bc.clone()).unwrap();
    let bc_by_a =
        hybrid_sign(a_keys.signing_seed.to_vec(), a_keys.ml_dsa_seed.to_vec(), bc_statement).unwrap();
    let bc_signed_by_a = SuccessionLink { signature: e(&bc_by_a), ..bc.clone() };
    let links = json!({
        "ab": link_json(&ab),
        "bc": link_json(&bc),
        "bcConsented": link_json(&SuccessionLink { consent: Some(c.consent.clone()), ..bc.clone() }),
        "abEmpty": link_json(&SuccessionLink { consent: Some(String::new()), ..ab.clone() }),
        "abKem": link_json(&SuccessionLink { new_kem_public_key: c.identity.kem.clone().unwrap().public_key, ..ab }),
        "acServed": link_json(&ac_served),
        "acSigned": link_json(&ac_signed),
        "bcSignedByA": link_json(&bc_signed_by_a),
    });
    json!({
        "userId": user,
        "root": e(&root),
        "identities": identities,
        "links": links,
        "due": due_specs(),
        "signs": sign_specs(),
    })
}

fn named(doc: &Value, kind: &str, names: &Value) -> Vec<Value> {
    names.as_array().unwrap().iter().map(|name| doc[kind][name.as_str().unwrap()].clone()).collect()
}

/* A due case through links_needing_consent: each offered link's old key version and its two identities' places. */
pub fn run_due(doc: &Value, c: &Value) -> Value {
    let identities: Vec<IdentityEnvelope> =
        named(doc, "identities", &c["identities"]).iter().map(envelope_of).collect();
    let links: Vec<SuccessionLink> =
        named(doc, "links", &c["links"]).iter().map(super::groups::link_of).collect();
    let place = |envelope: &IdentityEnvelope| identities.iter().position(|e| e == envelope).unwrap();
    Value::Array(
        links_needing_consent(links, identities.clone())
            .iter()
            .map(|due| {
                json!({ "oldKeyVersion": due.link.old_key_version, "old": place(&due.old_identity), "next": place(&due.next_identity) })
            })
            .collect(),
    )
}

/* A sign case through AreaLedger::succession_consent_sign, on a ledger the account opened. */
pub fn run_sign(doc: &Value, c: &Value) -> Value {
    let envelope = |key: &str| envelope_of(&doc["identities"][s(c, key)]);
    let me = OwnIdentities {
        user_id: c["meUser"].as_str().map_or_else(|| s(doc, "userId"), str::to_string),
        identities: named(doc, "identities", &c["me"])
            .iter()
            .map(|value| {
                let p = public_identity(envelope_of(value)).unwrap();
                ServedKeys {
                    key_version: p.key_version,
                    encryption_public_key: p.encryption_public_key,
                    signing_public_key: p.signing_public_key,
                    ml_dsa_public_key: p.ml_dsa_public_key,
                    kem_public_key: p.kem_public_key,
                }
            })
            .collect(),
    };
    let root = base64url_decode(s(doc, "root")).unwrap();
    // The account unlocked with the first of `me` open, the rest its history, as the worker's host has it.
    let current = base64url_decode(me.identities[0].signing_public_key.clone()).unwrap();
    let ledger = AreaLedger::new();
    ledger.open_account(s(doc, "userId"), current, root).unwrap();
    let link = super::groups::link_of(&doc["links"][s(c, "link")]);
    match ledger.succession_consent_sign(me, link, envelope("old"), envelope("next")) {
        Ok(consent) => json!({ "status": "signed", "consent": consent }),
        Err(error) => json!({ "status": "refused", "message": error.to_string() }),
    }
}

/* Whether a sign outcome is what its case declares (or what the other twin reached): the consent itself differs per run. */
pub fn sign_says(outcome: &Value, expected: &Value) -> bool {
    outcome["status"] == expected["status"]
        && expected.get("message").is_none_or(|m| &outcome["message"] == m)
}

/* Whether a signed case's consent holds for the link between its two identities, here. */
pub fn consent_holds(doc: &Value, c: &Value, consent: &str) -> bool {
    let old = envelope_of(&doc["identities"][s(c, "old")]);
    let next = envelope_of(&doc["identities"][s(c, "next")]);
    succession_consent_verify(s(doc, "userId"), link_between(&old, &next, "", Some(consent)))
}

/* The whole document this core writes: every case with its outcome, each checked against its declaration first. */
pub fn fixture() -> Value {
    let previews = {
        let mut doc = preview_doc();
        let cases: Vec<Value> = doc["cases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                let outcome = run_preview(&doc, c);
                assert!(preview_says(&outcome, &c["expected"]), "{}: {outcome}", c["name"]);
                let mut c = c.clone();
                c["outcome"] = outcome;
                c
            })
            .collect();
        doc["cases"] = json!(cases);
        doc
    };
    let checks = check_cases();
    let results: Vec<Value> = checks["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let result = run_check(&checks, c);
            assert_eq!(result, c["expected"], "{}", c["name"]);
            json!({ "name": c["name"], "result": result })
        })
        .collect();
    let consents = {
        let mut doc = consent_doc();
        for kind in ["due", "signs"] {
            let cases: Vec<Value> = doc[kind]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| {
                    let outcome = if kind == "due" { run_due(&doc, c) } else { run_sign(&doc, c) };
                    if kind == "due" {
                        assert_eq!(outcome, c["expected"], "{}", c["name"]);
                    } else {
                        assert!(sign_says(&outcome, &c["expected"]), "{}: {outcome}", c["name"]);
                        if let Some(consent) = outcome["consent"].as_str() {
                            assert!(consent_holds(&doc, c, consent), "{}: the consent holds", c["name"]);
                        }
                    }
                    let mut c = c.clone();
                    c["outcome"] = outcome;
                    c
                })
                .collect();
            doc[kind] = json!(cases);
        }
        doc
    };
    let mut out = Map::new();
    out.insert("joinSessions".into(), session_fixture(&previews));
    out.insert("joinPreviews".into(), previews);
    out.insert("joinChecks".into(), json!(results));
    out.insert("consents".into(), consents);
    Value::Object(out)
}

/* Join sessions ------------------------------------------------------------ */

pub fn session_scenarios() -> Value {
    serde_json::from_str(include_str!("../../fixtures/join-session-scenarios.json"))
        .expect("fixtures/join-session-scenarios.json is JSON")
}

/* A served chain of the preview document's histories: `{history, through, cut}`, from version 1. */
fn session_served(doc: &Value, served: &Value) -> ServedChain {
    let mut served = served.clone();
    served["after"] = json!(0);
    if served.get("cut").is_none() {
        served["cut"] = Value::Null;
    }
    served_of(doc, &served)
}

/* The words a step types for a showing: as read out, one of them misheard, or one blank. */
fn typed_for(code: &[String], hidden: &[u32], words: &str) -> Vec<String> {
    let right: Vec<String> = hidden.iter().map(|at| code[*at as usize].clone()).collect();
    let other = |word: &str| if word == "abandon" { "ability".to_string() } else { "abandon".to_string() };
    match words {
        "right" => right,
        "misheard" => vec![right[0].clone(), other(&right[1])],
        "blank" => vec![right[0].clone(), " ".into()],
        other => panic!("words {other}"),
    }
}

/*
 * A joins record no match of this account's sealed (the web's forgedRecord): an app's (the
 * outbox store), another family's, the data layer's version 2, a version this release does not
 * know (5); or `value`, any JSON sealed as this account's joins record of the family (the fuzz
 * kind joins_record).
 */
pub fn forged_record(_doc: &Value, kind: &str, value: &Value) -> String {
    let f = family();
    if kind == "value" {
        return device_store_seal_value(&root(), &f.p2.user_id, GROUP, "joins", value).unwrap();
    }
    let mark = json!({ "rosterVersion": 2, "code": admin_code(&f.main, 2, 1) });
    let record =
        |group: &str, v: u64| json!({ "v": v, "groupId": group, "joinMark": mark, "checkedAt": SESSION_NOW });
    let (store, group, value) = match kind {
        "outbox" => ("outbox", GROUP, record(GROUP, 3)),
        "other-family" => ("joins", super::groups::OTHER_GROUP, record(super::groups::OTHER_GROUP, 3)),
        "earlier-version" => ("joins", GROUP, record(GROUP, 2)),
        "newer-version" => ("joins", GROUP, record(GROUP, 5)),
        other => panic!("record {other}"),
    };
    device_store_seal_value(&root(), &f.p2.user_id, group, store, &value).unwrap()
}

pub const SESSION_NOW: &str = "2026-10-18T12:00:00.000Z";

/* A check's outcome as both twins write it: the escalation's presence (its sealed bytes differ per run). */
pub fn check_json(check: CoreResult<JoinCheck>) -> Value {
    match check {
        Ok(JoinCheck::Matched { holds, .. }) => json!({ "status": "matched", "kept": holds.is_some() }),
        Ok(JoinCheck::WrongWords { holds }) => json!({ "status": "wrong-words", "kept": holds.is_some() }),
        Ok(JoinCheck::Mismatch { holds }) => json!({ "status": "mismatch", "kept": holds.is_some() }),
        Ok(JoinCheck::Incomplete) => json!({ "status": "incomplete" }),
        Ok(JoinCheck::Changed { session }) => json!({
            "status": "changed", "rosterVersion": session.roster_version(), "code": session.code(), "hidden": session.hidden(),
        }),
        Ok(JoinCheck::NotAdmitted) => json!({ "status": "not-admitted" }),
        Ok(JoinCheck::Fork { of, version, sides }) => fork_json(of, version, &sides),
        Ok(JoinCheck::RecordUnreadable) => json!({ "status": "record-unreadable" }),
        Err(error) => json!({ "status": "refused", "message": error.to_string() }),
    }
}

pub fn acceptance_json(acceptance: CoreResult<JoinAcceptance>) -> Value {
    match acceptance {
        Ok(JoinAcceptance::Accepted { chain, pin, guard, .. }) => json!({
            "status": "accepted",
            "rosterVersion": chain.roster().roster_version,
            "checkedAt": pin.checked_at,
            "checked": checked_json(chain.checked()),
            "guard": guard_json(&guard),
        }),
        Ok(JoinAcceptance::Changed { session }) => json!({
            "status": "changed", "rosterVersion": session.roster_version(), "code": session.code(), "hidden": session.hidden(),
        }),
        Ok(JoinAcceptance::NotAdmitted) => json!({ "status": "not-admitted" }),
        Ok(JoinAcceptance::Fork { of, version, sides }) => fork_json(of, version, &sides),
        Ok(JoinAcceptance::RecordUnreadable) => json!({ "status": "record-unreadable" }),
        Ok(JoinAcceptance::Overtaken { split }) => json!({ "status": "overtaken", "split": split }),
        Err(error) => json!({ "status": "refused", "message": error.to_string() }),
    }
}

/*
 * The family guard a step names (docs/optional-verification.md 2.8): none, the pin at main's
 * roster 2, unreadable, or the one this device holds (`held`: the latest an acceptance returned,
 * as the app stores it right after the record).
 */
fn guard_of(doc: &Value, which: &Value, held: &Option<GroupPin>) -> FamilyGuard {
    match which.as_str() {
        None | Some("none") => FamilyGuard::Absent,
        Some("pin-main-2") => FamilyGuard::Held { pin: pin_from(&doc["pinMain2"]) },
        Some("unreadable") => FamilyGuard::Unreadable,
        Some("held") => held.clone().map_or(FamilyGuard::Absent, |pin| FamilyGuard::Held { pin }),
        Some(other) => panic!("a guard {other}"),
    }
}

/* A guard as both twins write it in an outcome: where it stands, or null when none was returned. */
fn guard_json(guard: &Option<GroupPin>) -> Value {
    match guard {
        None => Value::Null,
        Some(pin) => {
            json!({ "rosterVersion": pin.roster_version, "keyVersion": pin.key_version, "areas": pin.areas })
        }
    }
}

fn checked_json(checked: Option<FamilyChecked>) -> Value {
    match checked {
        None => Value::Null,
        Some(checked) => json!({
            "how": match checked.how { CheckedHow::Created => "created", CheckedHow::Join => "join", CheckedHow::Compared => "compared" },
            "rosterVersion": checked.roster_version,
        }),
    }
}

/* A first use's outcome as both twins write it, with its record's check time. */
fn first_use_json(result: CoreResult<FirstUseJoin>) -> Value {
    match result {
        Ok(FirstUseJoin::Ready { matched, roster_version }) => {
            let value =
                device_store_open_value(&root(), &family().p2.user_id, GROUP, "joins", &matched.record())
                    .unwrap();
            json!({ "status": "first-use", "rosterVersion": roster_version, "checkedAt": value["firstUse"]["checkedAt"] })
        }
        Ok(FirstUseJoin::NotAdmitted) => json!({ "status": "not-admitted" }),
        Ok(FirstUseJoin::Fork { of, version, sides }) => fork_json(of, version, &sides),
        Ok(FirstUseJoin::RecordUnreadable) => json!({ "status": "record-unreadable" }),
        Err(error) => json!({ "status": "refused", "message": error.to_string() }),
    }
}

/* Person 2's drawn ledger with the scenario's settings. */
fn session_ledger(doc: &Value, settings: &str) -> std::sync::Arc<AreaLedger> {
    let ledger = drawn_ledger(&family().p2, root());
    settings_of(&ledger, doc, settings);
    ledger
}

/* What one run of a scenario leaves: its outcomes, the joins records it sealed by step, and the escalation kept last. */
pub struct SessionRun {
    pub outcomes: Vec<Value>,
    pub records: HashMap<usize, String>,
    pub holds: Option<String>,
}

const SKIPPED: &str = "skipped";

/*
 * One scenario through this core, step by step, as an app drives it: it keeps
 * the escalation each check hands back (`kept`, and what it was after each
 * step), restores it once after a lock or a relaunch (or an older one, with
 * `restore`), on the next showing or check. A lock keeps the showings on
 * screen (checked, they are refused); a relaunch loses them. A match from
 * before a lock or a relaunch is reopened from its joins record, as the app
 * review rules say. A step naming a showing or a match no earlier step made
 * (or one a relaunch lost) is "skipped", in both twins (the fuzz kind's ops).
 * Each step's outcome as both twins write it.
 */
pub fn run_session(doc: &Value, scenario: &Value) -> SessionRun {
    let settings = s(scenario, "settings");
    let f = family();
    let mut ledger = session_ledger(doc, &settings);
    let mut outcomes: Vec<Value> = vec![];
    let mut showings: HashMap<usize, std::sync::Arc<JoinSession>> = HashMap::new();
    let mut matched: HashMap<usize, (usize, std::sync::Arc<JoinMatched>)> = HashMap::new();
    // Bumped by a lock or a relaunch: a match token from an earlier one is reopened from its record.
    let mut unlock = 0usize;
    let mut records: HashMap<usize, String> = HashMap::new();
    let mut kept: Option<String> = None;
    let mut kept_after: Vec<Option<String>> = vec![];
    let mut pending: Option<String> = None;
    // The family guard this device holds: the latest an acceptance returned, never cleared.
    let mut guard: Option<GroupPin> = None;
    for (at, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
        let index = |key: &str| step[key].as_u64().map(|i| i as usize);
        let outcome = match step["op"].as_str().unwrap() {
            "show" => {
                let preview = ledger.group_join_preview(
                    me(),
                    GROUP.into(),
                    None,
                    session_served(doc, &step["served"]),
                    pending.take(),
                );
                if let Ok(JoinPreview::Code { session, .. }) = &preview {
                    showings.insert(at, std::sync::Arc::clone(session));
                }
                preview_json(preview)
            }
            "check" => {
                let session = match &step["session"] {
                    Value::String(elsewhere) if elsewhere == "elsewhere" => {
                        let other = session_ledger(doc, &settings);
                        let served = session_served(doc, &json!({ "history": "main", "through": 2 }));
                        match other.group_join_preview(me(), GROUP.into(), None, served, None).unwrap() {
                            JoinPreview::Code { session, .. } => Some(session),
                            _ => panic!("{}: a code elsewhere", scenario["name"]),
                        }
                    }
                    _ => index("session").and_then(|i| showings.get(&i).cloned()),
                };
                match session {
                    None => json!({ "status": SKIPPED }),
                    Some(session) => {
                        let typed = typed_for(&session.code(), &session.hidden(), &s(step, "words"));
                        let served = session_served(doc, &step["served"]);
                        let check = ledger.join_check(
                            me(),
                            GROUP.into(),
                            None,
                            served,
                            session,
                            typed,
                            SESSION_NOW.into(),
                            pending.take(),
                        );
                        let mut outcome = check_json(check.clone());
                        match &check {
                            Ok(JoinCheck::Matched { matched: m, holds }) => {
                                records.insert(at, m.record());
                                matched.insert(at, (unlock, std::sync::Arc::clone(m)));
                                kept = holds.clone();
                                // The joins record's check time, read as only the fixtures can.
                                let value = device_store_open_value(
                                    &root(),
                                    &f.p2.user_id,
                                    GROUP,
                                    "joins",
                                    &m.record(),
                                )
                                .unwrap();
                                outcome["checkedAt"] = value["checkedAt"].clone();
                            }
                            Ok(JoinCheck::WrongWords { holds }) | Ok(JoinCheck::Mismatch { holds }) => {
                                kept = holds.clone();
                            }
                            Ok(JoinCheck::Changed { session }) => {
                                showings.insert(at, std::sync::Arc::clone(session));
                            }
                            _ => {}
                        }
                        outcome
                    }
                }
            }
            "first-use" => {
                let result = ledger.join_first_use(
                    me(),
                    GROUP.into(),
                    None,
                    session_served(doc, &step["served"]),
                    guard_of(doc, &step["guard"], &guard),
                    SESSION_NOW.into(),
                );
                if let Ok(FirstUseJoin::Ready { matched: m, .. }) = &result {
                    records.insert(at, m.record());
                    matched.insert(at, (unlock, std::sync::Arc::clone(m)));
                }
                first_use_json(result)
            }
            "accept" => {
                let served = session_served(doc, &step["served"]);
                let reopen = |i: usize| {
                    records
                        .get(&i)
                        .map(|sealed| ledger.join_matched_open(GROUP.into(), sealed.clone()).unwrap())
                };
                let token = match (index("matched"), step["record"].as_str()) {
                    (Some(i), _) => match matched.get(&i) {
                        Some((when, token)) if *when == unlock => Some(Some(std::sync::Arc::clone(token))),
                        _ => reopen(i),
                    },
                    (None, Some(record)) => {
                        let sealed = match record.strip_prefix("own:") {
                            Some(i) => records.get(&i.parse::<usize>().unwrap()).cloned(),
                            None => Some(forged_record(doc, record, &step["value"])),
                        };
                        sealed.map(|sealed| ledger.join_matched_open(GROUP.into(), sealed).unwrap())
                    }
                    _ => None,
                };
                match token {
                    None => json!({ "status": SKIPPED }),
                    Some(None) => json!({ "status": "join-unreadable" }),
                    Some(Some(token)) => {
                        let acceptance = ledger.accept_joining(
                            me(),
                            GROUP.into(),
                            None,
                            served,
                            token,
                            guard_of(doc, &step["guard"], &guard),
                        );
                        if let Ok(JoinAcceptance::Changed { session }) = &acceptance {
                            showings.insert(at, std::sync::Arc::clone(session));
                        }
                        if let Ok(JoinAcceptance::Accepted { guard: Some(next), .. }) = &acceptance {
                            guard = Some(next.clone());
                        }
                        acceptance_json(acceptance)
                    }
                }
            }
            "sync" => {
                let served = session_served(doc, &step["served"]);
                match ledger.accept_served(
                    me(),
                    GROUP.into(),
                    None,
                    served,
                    guard_of(doc, &step["guard"], &guard),
                    SESSION_NOW.into(),
                ) {
                    Ok(ServedAcceptance::Accepted { chain, guard: next, .. }) => {
                        let outcome = json!({
                            "status": "accepted",
                            "rosterVersion": chain.roster().roster_version,
                            "guard": guard_json(&next),
                        });
                        if next.is_some() {
                            guard = next;
                        }
                        outcome
                    }
                    Ok(ServedAcceptance::Fork { of, version, .. }) => json!({
                        "status": "fork",
                        "of": match of { ForkOf::Roster => "roster", ForkOf::GroupKey => "group-key" },
                        "version": version,
                    }),
                    Ok(_) => json!({ "status": "not-accepted" }),
                    Err(error) => json!({ "status": "refused", "message": error.to_string() }),
                }
            }
            "holds" => json!({ "status": if kept.is_some() { "kept" } else { "none" } }),
            "guard" => match &guard {
                None => json!({ "status": "none" }),
                Some(pin) => {
                    json!({ "status": "held", "rosterVersion": pin.roster_version, "keyVersion": pin.key_version, "areas": pin.areas })
                }
            },
            "relaunch" | "lock" => {
                unlock += 1;
                if step["op"] == "relaunch" {
                    ledger = session_ledger(doc, &settings);
                    showings.clear();
                } else {
                    ledger.clear();
                    let signing = base64url_decode(f.p2.served.signing_public_key.clone()).unwrap();
                    ledger.open_account(f.p2.user_id.clone(), signing, root()).unwrap();
                    settings_of(&ledger, doc, &settings);
                }
                pending = if step["restore"] == json!(true) { kept.clone() } else { None };
                json!({ "status": if step["op"] == "relaunch" { "relaunched" } else { "locked" } })
            }
            "restore" => match index("from").and_then(|i| kept_after.get(i).cloned()) {
                None => json!({ "status": SKIPPED }),
                Some(older) => {
                    pending = older;
                    json!({ "status": "restoring" })
                }
            },
            "forget" => {
                ledger.forget_group(GROUP.into());
                json!({ "status": "forgotten" })
            }
            other => panic!("an op {other}"),
        };
        outcomes.push(outcome);
        kept_after.push(kept.clone());
    }
    SessionRun { outcomes, records, holds: kept }
}

/* Whether a step's outcome is what it declares (`hiddenOf`, `notHiddenOf`: that step's showing's positions). */
pub fn step_says(outcomes: &[Value], at: usize, expected: &Value) -> bool {
    let outcome = &outcomes[at];
    expected.as_object().unwrap().iter().all(|(key, want)| match key.as_str() {
        "hiddenOf" => outcome["hidden"] == outcomes[want.as_u64().unwrap() as usize]["hidden"],
        "notHiddenOf" => outcome["hidden"] != outcomes[want.as_u64().unwrap() as usize]["hidden"],
        _ => &outcome[key] == want,
    })
}

/* Every scenario run here, each step checked against its declaration, with what the other twin opens. */
pub fn session_fixture(doc: &Value) -> Value {
    let file = session_scenarios();
    let mut runs = vec![];
    let mut cross = json!({});
    for scenario in file["scenarios"].as_array().unwrap() {
        let run = run_session(doc, scenario);
        for (at, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            assert!(
                step_says(&run.outcomes, at, &step["expect"]),
                "{} step {at}: {}",
                scenario["name"],
                run.outcomes[at]
            );
        }
        if scenario["name"] == "a-match-joins-once" {
            cross["joinsRecord"] = json!(run.records[&1]);
        }
        if scenario["name"] == "a-first-use-joins-once" {
            cross["firstUseRecord"] = json!(run.records[&0]);
        }
        if scenario["name"] == "the-escalation-kept-across-a-relaunch" {
            cross["holds"] = json!(run.holds);
            cross["heldHidden"] = run.outcomes[0]["hidden"].clone();
        }
        runs.push(json!({ "name": scenario["name"], "outcomes": run.outcomes }));
    }
    json!({ "runs": runs, "cross": cross })
}

/*
 * The other twin's sealed records opened here: its joins record joins a fresh
 * ledger of person 2's, and its kept escalation holds the positions it held.
 */
pub fn open_cross(doc: &Value, cross: &Value) -> (Value, Value, Value) {
    let ledger = session_ledger(doc, "none");
    let token = ledger
        .join_matched_open(GROUP.into(), s(cross, "joinsRecord"))
        .unwrap()
        .expect("the joins record opens");
    let served = session_served(doc, &json!({ "history": "main", "through": 3 }));
    let joined =
        acceptance_json(ledger.accept_joining(me(), GROUP.into(), None, served, token, FamilyGuard::Absent));
    // The other twin's first use: its record finishes the join here, against the roster it took.
    let first = session_ledger(doc, "none");
    let token = first
        .join_matched_open(GROUP.into(), s(cross, "firstUseRecord"))
        .unwrap()
        .expect("the first use's record opens");
    let served = session_served(doc, &json!({ "history": "main", "through": 2 }));
    let first_joined =
        acceptance_json(first.accept_joining(me(), GROUP.into(), None, served, token, FamilyGuard::Absent));
    let relaunched = session_ledger(doc, "none");
    let shown = preview_json(relaunched.group_join_preview(
        me(),
        GROUP.into(),
        None,
        session_served(doc, &json!({ "history": "main", "through": 2 })),
        Some(s(cross, "holds")),
    ));
    (joined, first_joined, shown["hidden"].clone())
}

/*
 * A preview case, then (with `words`) "They match" on the same served chain
 * and record, then (with `join`) the join: what the fuzz kind `join_preview`
 * compares, so a served chain and record reach the check and the join too.
 */
pub fn run_preview_flow(doc: &Value, c: &Value) -> Value {
    let f = family();
    let ledger = drawn_ledger(&f.p2, root());
    settings_of(&ledger, doc, &s(c, "settings"));
    let record = c["record"].as_str().map(|name| s(&doc["records"], name));
    let served = served_of(doc, &c["served"]);
    let preview = ledger.group_join_preview(me(), GROUP.into(), record.clone(), served.clone(), None);
    let mut out = json!({ "preview": preview_json(preview.clone()) });
    let (Some(words), Ok(JoinPreview::Code { session, .. })) = (c["words"].as_str(), preview) else {
        return out;
    };
    let typed = typed_for(&session.code(), &session.hidden(), words);
    let check = ledger.join_check(
        me(),
        GROUP.into(),
        record.clone(),
        served.clone(),
        session,
        typed,
        SESSION_NOW.into(),
        None,
    );
    out["check"] = check_json(check.clone());
    if let (true, Ok(JoinCheck::Matched { matched, .. })) = (c["join"] == json!(true), check) {
        out["join"] = acceptance_json(ledger.accept_joining(
            me(),
            GROUP.into(),
            None,
            served,
            matched,
            FamilyGuard::Absent,
        ));
    }
    out
}
