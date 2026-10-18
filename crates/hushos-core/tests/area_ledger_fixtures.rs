//! The family write rules on the scenarios both twins run
//! (`fixtures/area-ledger-scenarios.json`), and the web's run of them
//! (`fixtures/web-area-ledger.json`, written by
//! `packages/crypto/scripts/area-ledger-fixtures.ts`): every stated outcome
//! holds here, every step gives here what it gave on the web, and every key
//! envelope the web's ledger made opens here to the key it says. The other
//! direction is `packages/crypto/src/area-ledger-fixtures.test.ts`. The
//! nodes the web walked (`rotations`) read here as both twins declare, and
//! walk here to the same records. The web's chain records (`deviceRecords`)
//! open here and reach here what they reached on the web, the app's own
//! records open as sealed and nowhere else, and the merge cases give here what
//! they gave there. Regenerate both with `bun run fixtures:groups`.

mod common;

use common::area_ledger::*;
use common::{device_records, rotations};
use hushos_core::RotatingNode;
use serde_json::{json, Value};

fn scenarios() -> Vec<Value> {
    let file: Value = serde_json::from_str(include_str!("../fixtures/area-ledger-scenarios.json"))
        .expect("fixtures/area-ledger-scenarios.json is JSON");
    file["scenarios"].as_array().expect("scenarios").clone()
}

#[test]
fn every_scenario_gives_each_stated_outcome_here() {
    let scenarios = scenarios();
    assert!(scenarios.len() >= 14);
    for scenario in &scenarios {
        let steps = read_steps(&scenario["steps"]).unwrap_or_else(|| panic!("{} fits", scenario["name"]));
        let run = run_steps(&steps);
        assert_eq!(unmet(scenario, &run.outcomes), Vec::<String>::new(), "{}", scenario["name"]);
        assert_eq!(run.violations, Vec::<String>::new(), "{}", scenario["name"]);
    }
}

#[test]
fn every_step_gives_here_what_it_gave_on_the_web_and_the_web_s_envelopes_open_here() {
    let web: Value = serde_json::from_str(include_str!("../fixtures/web-area-ledger.json"))
        .expect("fixtures/web-area-ledger.json is JSON");
    let scenarios = scenarios();
    let runs = web["scenarios"].as_array().expect("the web's runs");
    assert_eq!(runs.len(), scenarios.len(), "the web ran every scenario");
    let mut opened = 0;
    for (scenario, theirs) in scenarios.iter().zip(runs) {
        assert_eq!(scenario["name"], theirs["name"]);
        let ours = run_steps(&read_steps(&scenario["steps"]).unwrap());
        assert_eq!(&Value::Array(ours.outcomes), &theirs["outcomes"], "{}", scenario["name"]);
        // The other twin's envelopes, where the key change would land: each opens to its key.
        let made = theirs["made"].as_array().unwrap();
        assert_eq!(made.len(), ours.made.len(), "{}", scenario["name"]);
        for envelope in made {
            assert!(opens_as_made(envelope), "{}: {envelope}", scenario["name"]);
            opened += 1;
        }
        // And the envelopes the web served its ledger, option A's previous-root label included.
        for envelope in theirs["served"].as_array().unwrap() {
            assert!(opens_as_served(envelope), "{}: {envelope}", scenario["name"]);
            opened += 1;
        }
    }
    assert!(opened >= 60, "only {opened} envelopes were checked");
    let previous_roots = runs
        .iter()
        .flat_map(|run| run["served"].as_array().unwrap())
        .filter(|served| served["label"] == "previous-root")
        .count();
    assert!(previous_roots >= 5, "only {previous_roots} previous-root envelopes were checked");
}

#[test]
fn every_node_the_web_walked_reads_here_as_both_twins_declared_and_walks_here_alike() {
    let web: Value = serde_json::from_str(include_str!("../fixtures/web-area-ledger.json"))
        .expect("fixtures/web-area-ledger.json is JSON");
    let theirs = web["rotations"].as_array().expect("the web's walks");
    let ours = rotations::rotation_cases();
    assert_eq!(theirs.len(), ours.len(), "the web walked every case");
    let (mut rekeyed, mut refused, mut stale) = (0, 0, 0);
    for (case, walked) in ours.iter().zip(theirs) {
        assert_eq!(walked["name"], case.name);
        let target = walked["target"].as_u64().unwrap();
        let nodes: Vec<Value> = walked["nodes"].as_array().unwrap().clone();
        let input: Vec<RotatingNode> = nodes.iter().map(rotations::node_of).collect();
        let rotated = walked["rotated"].as_array().unwrap();
        if let Some(message) = case.refused {
            // Both twins refuse the node, with exactly this message, and write nothing of it.
            assert_eq!(walked["refused"], message, "{}: the web declares the refusal", case.name);
            assert_eq!(rotated.len(), 0, "{}: the web wrote nothing", case.name);
            let here = rotations::walk(&input, case.walker, target, None);
            assert_eq!(here.err().as_deref(), Some(message), "{}: refused here", case.name);
            refused += 1;
            continue;
        }
        // What the web's walk wrote: the records each case says, re-keyed, re-sealed or dropped.
        assert_eq!(rotations::shapes_of(rotated), case.shapes, "{}: the web's walk", case.name);
        assert_eq!(
            walked["writes"],
            case.writes.clone().unwrap_or(Value::Null),
            "{}: the web's writes",
            case.name
        );
        // Read here, on a fresh member's ledger, with this core's verdicts.
        let served: Vec<Vec<Value>> =
            walked["served"].as_array().unwrap().iter().map(|s| s.as_array().unwrap().clone()).collect();
        let (verdicts, held) = rotations::read_back(&nodes, rotated, &served, target, case.reader);
        assert_eq!(verdicts, case.expected, "{}: read here", case.name);
        assert_eq!(json!(verdicts), walked["expected"], "{}: as the web declared", case.name);
        if let Some(key) = case.key {
            assert_eq!(held, key, "{}: the re-wrapped key", case.name);
        }
        // And the web's nodes, walked by this core, come out the same, with the same writes after.
        let stale_child = rotations::stale_of(&walked["stale"], case);
        let again = rotations::walk(&input, case.walker, target, stale_child.as_ref())
            .unwrap_or_else(|error| panic!("{}: {error}", case.name));
        assert_eq!(
            rotations::shapes_of(&again.rotated),
            case.shapes,
            "{}: the web's nodes walked here",
            case.name
        );
        assert_eq!(again.writes, case.writes, "{}: writes here", case.name);
        stale += usize::from(case.writes.is_some());
        rekeyed += walked["rekeyedInputs"].as_array().unwrap().len();
    }
    assert!(rekeyed >= 10, "only {rekeyed} re-keyed records were read");
    assert_eq!((refused, stale), (2, 1));
}

fn web_device_records() -> Value {
    let web: Value = serde_json::from_str(include_str!("../fixtures/web-area-ledger.json"))
        .expect("fixtures/web-area-ledger.json is JSON");
    web["deviceRecords"].clone()
}

#[test]
fn every_chain_record_the_web_sealed_reaches_here_what_it_reached_there() {
    let theirs = web_device_records()["cases"].as_array().expect("the web's device record cases").clone();
    let ours = device_records::device_cases();
    assert_eq!(theirs.len(), ours.len(), "the web ran every case");
    let mut read_cache = 0;
    for (case, mine) in theirs.iter().zip(&ours) {
        assert_eq!(case["name"], mine["name"]);
        let (outcome, _) = device_records::run(case);
        // The case as this core declares it, and exactly what the web reached on the same bytes.
        assert!(device_records::says(&outcome, &mine["expected"]), "{}: {outcome}", case["name"]);
        assert_eq!(outcome, case["outcome"], "{}: as on the web", case["name"]);
        // A continuation of only the rosters after the web's record, never fetched from 1: its cache was read here.
        if case["start"].as_u64() > Some(0)
            && outcome["status"] == "accepted"
            && outcome["fromVersionOne"] == false
        {
            read_cache += 1;
        }
    }
    assert_eq!(read_cache, 2, "the web's cache was continued here, cold and warm");
}

#[test]
fn the_web_s_own_records_open_here_as_sealed_and_nowhere_else() {
    let stores = web_device_records()["stores"].clone();
    let envelope = stores["envelope"].as_str().unwrap();
    let rows = stores["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 5);
    for row in rows {
        assert_eq!(device_records::open_row(envelope, row), row["value"], "{}", row["name"]);
    }
}

#[test]
fn every_merge_case_gives_here_what_it_states_and_what_the_web_gave() {
    let theirs = web_device_records()["mergePins"].as_array().unwrap().clone();
    let cases = device_records::merge_cases();
    assert_eq!(theirs.len(), cases.len());
    for (case, web) in cases.iter().zip(&theirs) {
        assert_eq!(case["name"], web["name"]);
        let ours = device_records::merge_result(case);
        assert_eq!(ours, case["expected"], "{}", case["name"]);
        assert_eq!(ours, web["result"], "{}: as on the web", case["name"]);
    }
}

#[test]
fn the_overtaken_words_are_the_web_s() {
    let theirs = web_device_records()["raceMessages"].clone();
    assert_eq!(
        theirs,
        json!([hushos_core::served_race_message(false), hushos_core::served_race_message(true)])
    );
}
