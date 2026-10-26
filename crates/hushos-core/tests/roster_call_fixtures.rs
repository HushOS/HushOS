//! Roster calls (groups 1d, Core 5a) against the web: the web's bodies,
//! join codes and outbox entries (`fixtures/web-roster-calls.json`, written by
//! `packages/crypto/scripts/roster-call-fixtures.ts`) read through this core
//! to the same outcomes, this core's own document built and checked
//! (`tests/common/roster_calls.rs`), and the outbox answer table
//! (`fixtures/outbox-steps.json`) held to `outbox_step`.

mod common;

use common::roster_calls::{check, fixture, step_name};
use hushos_core::outbox_step;
use serde_json::Value;

fn read(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures").join(name);
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("JSON")
}

#[test]
fn the_web_s_roster_calls_read_here_as_the_web_declared() {
    check(&read("web-roster-calls.json"));
}

#[test]
fn this_core_s_roster_calls_say_what_they_declare() {
    let doc = fixture();
    // And this core reads its own document as it reads the web's.
    check(&doc);
}

#[test]
fn the_outbox_answer_table_is_the_shared_one() {
    let table = read("outbox-steps.json");
    for case in table["cases"].as_array().unwrap() {
        let status = case["status"].as_u64().unwrap() as u16;
        let code = case["code"].as_str().map(str::to_string);
        assert_eq!(step_name(outbox_step(status, code)), case["step"].as_str().unwrap(), "{case}");
    }
}

#[test]
fn a_manager_s_device_over_time_never_resends_other_bytes_or_builds_while_locked() {
    use common::roster_calls::{session_run, session_step};
    let doc = read("roster-call-sessions.json");
    for scenario in doc["scenarios"].as_array().unwrap() {
        let steps: Vec<Value> =
            scenario["steps"].as_array().unwrap().iter().map(|step| session_step(step).unwrap()).collect();
        assert_eq!(Value::Array(session_run(&steps)), scenario["expected"], "{}", scenario["name"]);
    }
}

#[test]
fn the_web_s_settings_and_family_folders_open_here_as_there() {
    common::settings_areas::check(&read("web-roster-calls.json"));
}

#[test]
fn this_core_s_settings_and_family_folders_say_what_they_declare() {
    let doc = common::settings_areas::fixture();
    common::settings_areas::check(&doc);
}

/*
 * The family guard an acceptance hands back (docs/optional-verification.md 2.8) carries the
 * folders opened on this device: person 2 opens a family folder at version 2, and the next
 * acceptance's guard has that floor (none without it); with that guard held, the same chain
 * again records nothing new and hands none back.
 */
#[test]
fn a_folder_opened_here_raises_the_guard_an_acceptance_hands_back() {
    use common::groups::CHECKED;
    use common::roster_calls::{family, ledger_with, me, served_of};
    use common::settings_areas::{cases, seal_self_grant, served_area};
    use hushos_core::{FamilyGuard, ServedAcceptance};
    let f = family();
    let accept = |ledger: &hushos_core::AreaLedger, guard: FamilyGuard| match ledger.accept_served(
        me(2),
        f.group_id.clone(),
        None,
        served_of(f.h.key(1), f.h.rosters.clone()),
        guard,
        CHECKED.into(),
    ) {
        Ok(ServedAcceptance::Accepted { guard, .. }) => guard,
        other => panic!("{other:?}"),
    };
    // Nothing opened: the guard is the chain's pin, no floors.
    let plain = accept(&ledger_with(2, None, None, false, false), FamilyGuard::Absent).expect("a guard");
    assert!(plain.areas.is_empty(), "{plain:?}");
    let ledger = ledger_with(2, None, None, false, false);
    let spec = cases()["areas"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "a-current-self-grant-alone")
        .unwrap();
    let opened = ledger
        .open_family_area(f.group_id.clone(), served_area(2, spec, Some(&seal_self_grant(2, spec))), 1)
        .unwrap();
    let guard = accept(&ledger, FamilyGuard::Absent).expect("a guard");
    assert_eq!(guard.areas.values().copied().collect::<Vec<_>>(), vec![opened.opened.version]);
    assert_eq!(opened.opened.version, 2);
    // Held, the same chain and folders again: nothing new to write.
    assert_eq!(accept(&ledger, FamilyGuard::Held { pin: guard.clone() }), None);
    // A guard held from before the folder opened rises to it.
    let raised = accept(&ledger, FamilyGuard::Held { pin: plain.clone() }).expect("a raised guard");
    assert_eq!(raised, guard);
    // The wipe, with that raised guard never stored: an unreadable guard refuses and forgets
    // nothing; held at the plain one, the wipe hands back the guard to store first, folder included.
    let forget = |held: FamilyGuard| ledger.forget_group(f.group_id.clone(), held, CHECKED.into());
    assert!(forget(FamilyGuard::Unreadable).is_err());
    assert_eq!(forget(FamilyGuard::Held { pin: plain }).unwrap(), Some(guard.clone()));
    // Forgotten: nothing accepted this session any more, nothing to store.
    assert_eq!(forget(FamilyGuard::Absent).unwrap(), None);
}
