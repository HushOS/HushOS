//! The client side of the HushOS protocol, once, for every app that is not the
//! web: OPAQUE, the account key and its device memory, workspace grants, Drive
//! node, metadata and version envelopes, content chunks, writer signatures,
//! shares, links, reports, identity succession, scoped ids, the group core (group key,
//! rosters, successions, seals and scoped verdicts), the recovery key and the device key. Everything here
//! is byte-for-byte what `packages/crypto` seals in the browser, so a record
//! written on one platform opens on the others.
//!
//! No I/O lives here. The apps fetch and store; this crate seals and opens.
//! With the `uniffi` feature the public functions and records are exported to
//! Swift and Kotlin; without it the crate is plain Rust for a WebAssembly build.
#![forbid(unsafe_code)]

mod account;
mod bytes;
mod canonical;
mod contacts;
mod devices;
mod drive;
mod envelope;
mod error;
mod group_trust;
mod groups;
mod identity;
mod ids;
mod links;
mod opaque;
mod pq;
mod recovery;
mod reports;
mod shares;
mod signatures;
mod succession_path;

pub use account::*;
pub use bytes::*;
pub use contacts::*;
pub use devices::*;
pub use drive::*;
pub use error::*;
pub use group_trust::*;
pub use groups::*;
pub use identity::*;
pub use ids::*;
pub use links::*;
pub use opaque::*;
pub use recovery::*;
pub use reports::*;
pub use shares::*;
pub use signatures::*;

/// The statement grammar's parser and encoder, for the fuzz targets in
/// `fuzz/` only: what every group statement is checked against, which the
/// apps never call directly.
#[cfg(feature = "fuzzing")]
#[doc(hidden)]
pub mod fuzzing {
    use serde_json::Value;

    /// The parts a statement's bytes hold, or none when the grammar refuses them.
    pub fn parse_statement(bytes: &[u8]) -> Option<Vec<Value>> {
        crate::canonical::parse_statement(bytes, "statement").ok()
    }

    /// The bytes of a statement made of `parts`, or none when the grammar refuses them.
    pub fn encode_statement(parts: &[Value]) -> Option<Vec<u8>> {
        crate::canonical::encode_statement(parts).ok()
    }
}

#[cfg(feature = "uniffi")]
uniffi::setup_scaffolding!();
