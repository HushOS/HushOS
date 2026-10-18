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
mod area_ledger;
mod bytes;
mod canonical;
mod contacts;
mod devices;
mod drive;
mod envelope;
mod error;
mod group_trust;
mod group_verdicts;
mod groups;
mod identity;
mod ids;
mod links;
mod opaque;
mod pq;
mod recovery;
mod reports;
mod rotation_records;
mod shares;
mod signatures;
mod succession_path;

pub use account::*;
pub use area_ledger::*;
pub use bytes::*;
pub use contacts::*;
pub use devices::*;
pub use drive::*;
pub use error::*;
pub use group_trust::*;
pub use group_verdicts::*;
pub use groups::*;
pub use identity::*;
pub use ids::*;
pub use links::*;
pub use opaque::*;
pub use recovery::*;
pub use reports::*;
pub use rotation_records::*;
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

    /// A metadata statement in one of its three writer forms (`ordinary`,
    /// `saved`, `resealed`), or none when its fields are refused or the form is
    /// another; the rekeyed form is `metadata_rekeyed_statement`.
    pub fn metadata_statement_as(
        form: &str,
        statement: &crate::MetadataStatement,
        envelope: &[u8],
    ) -> Option<Vec<u8>> {
        crate::signatures::metadata_statement_as(form, statement, envelope)
    }

    /// A version statement in one of its three writer forms; see [`metadata_statement_as`].
    pub fn version_statement_as(
        form: &str,
        statement: &crate::VersionStatement,
        envelope: &[u8],
    ) -> Option<Vec<u8>> {
        crate::signatures::version_statement_as(form, statement, envelope)
    }

    /// An envelope's plaintext exactly as sealed, under `key` and `aad`, or none.
    pub fn plaintext(key: &[u8], envelope: &[u8], aad: &[u8]) -> Option<Vec<u8>> {
        crate::envelope::open(key, envelope, aad).ok()
    }

    /// An envelope's plaintext under its opening key (an origin key), or none.
    pub fn origin_plaintext(origin_key: &[u8], envelope: &[u8], aad: &[u8]) -> Option<Vec<u8>> {
        crate::envelope::open_with_opening_key(origin_key, envelope, aad).ok()
    }

    /// A metadata envelope's associated data, or none when its fields are refused.
    pub fn metadata_aad(ctx: &crate::MetadataContext) -> Option<Vec<u8>> {
        crate::drive::metadata_context(ctx).ok()
    }

    /// A version envelope's associated data in `suite`, or none when its fields are refused.
    pub fn version_aad(ctx: &crate::VersionContext, suite: u32) -> Option<Vec<u8>> {
        crate::drive::version_context(ctx, suite).ok()
    }
}

#[cfg(feature = "uniffi")]
uniffi::setup_scaffolding!();
