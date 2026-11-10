//! A company as the Rust core makes it, for the web to judge and open, the
//! mirror of `packages/crypto/scripts/company-fixtures.ts`: a history written
//! with `company_roster_first`, `company_roster_next` and
//! `recovery_roster_sign`, the company key, kit and notice keys from the
//! shared seeds, and the seals of a company's life. Writes
//! `packages/crypto/src/__fixtures__/core-company.json`; `bun run fixtures`
//! at the repository root runs both directions. Signatures and seals differ
//! on every run.

#[path = "../tests/common/groups.rs"]
mod groups;

#[path = "../tests/common/company.rs"]
mod company;

use serde_json::json;
use std::fs;
use std::path::PathBuf;

fn main() {
    let (history, items) = company::company_made_here();
    let out = json!({
        "generatedBy": "crates/hushos-core/examples/company_fixtures.rs",
        "groupId": groups::GROUP,
        "keys": company::company_keys(),
        "history": history,
        "seals": { "items": items },
    });
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/crypto/src/__fixtures__/core-company.json");
    fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&out).unwrap()))
        .expect("write the fixture");
    println!("wrote packages/crypto/src/__fixtures__/core-company.json");
}
