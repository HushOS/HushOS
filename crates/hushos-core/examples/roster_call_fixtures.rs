//! Roster calls (groups 1d, Core 5a) as this core builds them, for the web
//! to read (`packages/crypto/src/roster-call-fixtures.test.ts`) and for the
//! server to store (`packages/groups/src/server.test.ts`): the family's
//! history, every call's body (or its refusal), the admin's join codes and
//! the outbox entries this core sealed. Every case is checked against its
//! declaration before anything is written (`tests/common/roster_calls.rs`).
//! The mirror of `packages/crypto/scripts/roster-call-fixtures.ts`; writes
//! `packages/crypto/src/__fixtures__/core-roster-calls.json`. Regenerate with
//! `bun run fixtures:groups` at the root.

#[path = "../tests/common/device_records.rs"]
mod device_records;
#[path = "../tests/common/groups.rs"]
mod groups;
#[path = "../tests/common/roster_calls.rs"]
mod roster_calls;
#[path = "../tests/common/settings_areas.rs"]
mod settings_areas;

use serde_json::json;
use std::fs;
use std::path::PathBuf;

fn main() {
    let mut document = json!({ "generatedBy": "crates/hushos-core/examples/roster_call_fixtures.rs" });
    for (key, value) in roster_calls::fixture().as_object().unwrap() {
        document[key] = value.clone();
    }
    // Core 6: the settings this core sealed and the family folders it opened (settingsReadings, areaOpens).
    for (key, value) in settings_areas::fixture().as_object().unwrap() {
        document[key] = value.clone();
    }
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/crypto/src/__fixtures__/core-roster-calls.json");
    fs::write(&out, serde_json::to_string_pretty(&document).unwrap() + "\n").expect("written");
    println!("wrote packages/crypto/src/__fixtures__/core-roster-calls.json");
}
