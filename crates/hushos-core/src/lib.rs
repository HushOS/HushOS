//! The client side of the HushOS protocol, once, for every app that is not the
//! web: OPAQUE, the account key and its device memory, workspace grants, Drive
//! node, metadata and version envelopes, content chunks, shares, links,
//! reports and the recovery key. Everything here
//! is byte-for-byte what `packages/crypto` seals in the browser, so a record
//! written on one platform opens on the others.
//!
//! No I/O lives here. The apps fetch and store; this crate seals and opens.
//! With the `uniffi` feature the public functions and records are exported to
//! Swift and Kotlin; without it the crate is plain Rust for a WebAssembly build.
#![forbid(unsafe_code)]

mod account;
mod bytes;
mod contacts;
mod drive;
mod envelope;
mod error;
mod identity;
mod links;
mod opaque;
mod recovery;
mod reports;
mod shares;

pub use account::*;
pub use bytes::*;
pub use contacts::*;
pub use drive::*;
pub use error::*;
pub use identity::*;
pub use links::*;
pub use opaque::*;
pub use recovery::*;
pub use reports::*;
pub use shares::*;

#[cfg(feature = "uniffi")]
uniffi::setup_scaffolding!();
