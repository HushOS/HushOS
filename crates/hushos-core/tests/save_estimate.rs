//! The save path's room estimate (`fixtures/save-estimate-cases.json`, written
//! by the web from packages/drive/src/save-runs.ts), as this core gives it;
//! `packages/drive/src/save-runs.test.ts` holds the web to the same file. A
//! number the twins give differently is a run one client refuses and another
//! starts.

use hushos_core::*;
use serde_json::Value;

fn cases() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/save-estimate-cases.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("JSON")
}

fn number(value: &Value, key: &str) -> u64 {
    value[key].as_u64().unwrap_or_else(|| panic!("{key} in {value}"))
}

#[test]
fn every_known_result_estimates_as_the_web_estimates_it() {
    let cases = cases();
    let known = cases["known"].as_array().expect("known");
    assert!(known.len() >= 10);
    for case in known {
        assert_eq!(result_estimate(number(case, "size")).unwrap(), number(case, "estimate"), "{case}");
    }
}

#[test]
fn every_unknown_result_is_its_sources_and_one_percent_as_on_the_web() {
    let cases = cases();
    for case in cases["unknown"].as_array().expect("unknown") {
        let size = unknown_result_size(number(case, "sourcesSize")).unwrap();
        assert_eq!(size, number(case, "size"), "{case}");
        assert_eq!(result_estimate(size).unwrap(), number(case, "estimate"), "{case}");
    }
}

#[test]
fn a_whole_run_adds_up_as_on_the_web() {
    let cases = cases();
    let results = cases["run"]["results"]
        .as_array()
        .expect("results")
        .iter()
        .map(|result| match result.get("size") {
            Some(size) => PlannedResult::Known { size: size.as_u64().unwrap() },
            None => PlannedResult::FromSources { sources_size: number(result, "sourcesSize") },
        })
        .collect();
    assert_eq!(run_estimate(results).unwrap(), number(&cases["run"], "estimate"));
}
