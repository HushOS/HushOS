//! Joining and consent (groups 1d, Core 4) as this core decides them, for the
//! web to match (`packages/crypto/src/join-fixtures.test.ts`) and for the
//! server's consent check (`packages/db/src/auth.consent.test.ts`): the join
//! previews over the histories this core signed and the records its
//! acceptance sealed, the typed-words checks of `fixtures/join-check-cases.json`,
//! and one account's identities with the links that need consent and the
//! consent this core signed. Every case is checked against its declaration
//! before anything is written (`tests/common/join.rs`). The mirror of
//! `packages/crypto/scripts/join-fixtures.ts`; writes
//! `packages/crypto/src/__fixtures__/core-join.json`. Fresh keys differ on
//! every run. Regenerate with `bun run fixtures:groups` at the root.

#[path = "../tests/common/device_records.rs"]
mod device_records;
#[path = "../tests/common/groups.rs"]
mod groups;
#[path = "../tests/common/join.rs"]
mod join;

use serde_json::json;
use std::fs;
use std::path::PathBuf;

fn main() {
    let mut document = json!({ "generatedBy": "crates/hushos-core/examples/join_fixtures.rs" });
    for (key, value) in join::fixture().as_object().unwrap() {
        document[key] = value.clone();
    }
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/crypto/src/__fixtures__/core-join.json");
    fs::write(&out, serde_json::to_string_pretty(&document).unwrap() + "\n").expect("written");
    println!("wrote packages/crypto/src/__fixtures__/core-join.json");
}
