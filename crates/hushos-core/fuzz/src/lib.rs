//! Fuzz targets for hushos-core, and the verdicts the TypeScript twin is held
//! to. `fuzz_targets/` are the cargo-fuzz binaries (nightly, sanitizers);
//! `examples/verdicts.rs` serves the same verdicts over stdin for the
//! differential test in `packages/crypto/fuzz`. See CONTRIBUTING.md (Fuzzing).

pub mod fixtures;
pub mod shape;
pub mod structured;
pub mod targets;

/// People, group keys and the shared cases' JSON shapes, as the fixture tests use them.
#[allow(dead_code, unused_imports, clippy::all)]
#[path = "../../tests/common/groups.rs"]
pub mod groups;

/// Runs `target` on `data` with every invariant asserted: what a fuzz target calls.
pub fn check(target: &str, data: &[u8]) {
    targets::verdict(target, data).expect("a known target");
}
