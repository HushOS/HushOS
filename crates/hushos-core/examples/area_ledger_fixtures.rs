//! The family write rules as the core's `AreaLedger` runs the shared
//! scenarios (`fixtures/area-ledger-scenarios.json`): every step's outcome
//! and every key envelope a step made, for the web to match step for step and
//! open (`packages/crypto/src/area-ledger-fixtures.test.ts`), the mirror of
//! `packages/crypto/scripts/area-ledger-fixtures.ts`. Writes
//! `packages/crypto/src/__fixtures__/core-area-ledger.json`; each scenario's
//! stated outcomes are checked before anything is written. Also the nodes this
//! core walked (`rotations`, `tests/common/rotations.rs`), each read back here
//! as its case declares before it is written, for the web to read; and the
//! chain records this core sealed and the outcomes it reached on them
//! (`deviceRecords`, `tests/common/device_records.rs`), each checked against
//! its case before it is written.

#[path = "../tests/common/area_ledger.rs"]
mod area_ledger;
#[path = "../tests/common/device_records.rs"]
mod device_records;
#[path = "../tests/common/groups.rs"]
mod groups;
#[path = "../tests/common/rekeyed.rs"]
mod rekeyed;
#[path = "../tests/common/rotations.rs"]
mod rotations;

use area_ledger::*;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

fn main() {
    let file: Value = serde_json::from_str(include_str!("../fixtures/area-ledger-scenarios.json"))
        .expect("fixtures/area-ledger-scenarios.json is JSON");
    let mut runs = vec![];
    for scenario in file["scenarios"].as_array().expect("scenarios") {
        let steps = read_steps(&scenario["steps"])
            .unwrap_or_else(|| panic!("{}: a step does not fit", scenario["name"]));
        let run = run_steps(&steps);
        let mut misses = unmet(scenario, &run.outcomes);
        misses.extend(run.violations.iter().cloned());
        assert!(misses.is_empty(), "{}:\n  {}", scenario["name"], misses.join("\n  "));
        runs.push(json!({ "name": scenario["name"], "outcomes": run.outcomes, "made": run.made, "served": run.served }));
    }
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/crypto/src/__fixtures__/core-area-ledger.json");
    // A family folder's walk, node by node: each node walked here, read here, for the web to read.
    let rotations = rotations::rotation_fixture();
    let document = json!({
        "generatedBy": "crates/hushos-core/examples/area_ledger_fixtures.rs",
        "scenarios": runs,
        "rotations": rotations,
        "deviceRecords": device_records_fixture(),
    });
    fs::write(&out, serde_json::to_string_pretty(&document).unwrap() + "\n").expect("written");
    println!("wrote packages/crypto/src/__fixtures__/core-area-ledger.json");
}

/* Each device record case with this core's record and outcome, the app's own records, and the merge cases' results. */
fn device_records_fixture() -> Value {
    let cases: Vec<Value> = device_records::device_cases()
        .into_iter()
        .map(|mut case| {
            let (outcome, _) = device_records::run(&case);
            assert!(device_records::says(&outcome, &case["expected"]), "{}: {outcome}", case["name"]);
            case["outcome"] = outcome;
            case
        })
        .collect();
    let merges: Vec<Value> = device_records::merge_cases()
        .iter()
        .map(|case| {
            let result = device_records::merge_result(case);
            assert_eq!(result, case["expected"], "{}", case["name"]);
            json!({ "name": case["name"], "result": result })
        })
        .collect();
    let race_messages = [hushos_core::served_race_message(false), hushos_core::served_race_message(true)];
    json!({ "cases": cases, "stores": device_records::store_rows(), "mergePins": merges, "raceMessages": race_messages })
}
