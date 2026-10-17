//! The family write rules on the scenarios both twins run
//! (`fixtures/area-ledger-scenarios.json`), and the web's run of them
//! (`fixtures/web-area-ledger.json`, written by
//! `packages/crypto/scripts/area-ledger-fixtures.ts`): every stated outcome
//! holds here, every step gives here what it gave on the web, and every key
//! envelope the web's ledger made opens here to the key it says. The other
//! direction is `packages/crypto/src/area-ledger-fixtures.test.ts`.
//! Regenerate both with `bun run fixtures:groups`.

mod common;

use common::area_ledger::*;
use serde_json::Value;

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
