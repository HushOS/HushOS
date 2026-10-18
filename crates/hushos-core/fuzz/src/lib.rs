//! Fuzz targets for hushos-core, and the verdicts the TypeScript twin is held
//! to. `fuzz_targets/` are the cargo-fuzz binaries (nightly, sanitizers);
//! `examples/verdicts.rs` serves the same verdicts over stdin for the
//! differential test in `packages/crypto/fuzz`. See CONTRIBUTING.md (Fuzzing).

pub mod fixtures;
pub mod shape;
pub mod structured;
pub mod targets;

/// Re-keyed records as the shared fixtures write them, read and judged as the fixture tests do.
#[allow(dead_code, clippy::all)]
#[path = "../../tests/common/rekeyed.rs"]
pub mod rekeyed;

/// People, group keys and the shared cases' JSON shapes, as the fixture tests use them.
#[allow(dead_code, unused_imports, clippy::all)]
#[path = "../../tests/common/groups.rs"]
pub mod groups;

/// The family write rules as steps, run as the fixture tests run them.
#[allow(dead_code, clippy::all)]
#[path = "../../tests/common/area_ledger.rs"]
pub mod area_ledger;

/// Device records and the settings pin, run as the fixture tests run them.
#[allow(dead_code, clippy::all)]
#[path = "../../tests/common/device_records.rs"]
pub mod device_records;

/// Join previews, typed-words checks and consent, run as the fixture tests run them.
#[allow(dead_code, clippy::all)]
#[path = "../../tests/common/join.rs"]
pub mod join;

/// Runs `target` on `data` with every invariant asserted: what a fuzz target calls.
pub fn check(target: &str, data: &[u8]) {
    targets::verdict(target, data).expect("a known target");
}
