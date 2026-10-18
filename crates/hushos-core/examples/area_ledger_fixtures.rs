//! The family write rules as the core's `AreaLedger` runs the shared
//! scenarios (`fixtures/area-ledger-scenarios.json`): every step's outcome
//! and every key envelope a step made, for the web to match step for step and
//! open (`packages/crypto/src/area-ledger-fixtures.test.ts`), the mirror of
//! `packages/crypto/scripts/area-ledger-fixtures.ts`. Writes
//! `packages/crypto/src/__fixtures__/core-area-ledger.json`; each scenario's
//! stated outcomes are checked before anything is written. Also the nodes this
//! core walked (`rotations`, `tests/common/rotations.rs`), each read back here
//! as its case declares before it is written, for the web to read.

#[path = "../tests/common/area_ledger.rs"]
mod area_ledger;
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
    });
    fs::write(&out, serde_json::to_string_pretty(&document).unwrap() + "\n").expect("written");
    println!("wrote packages/crypto/src/__fixtures__/core-area-ledger.json");
}
