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
mod drive;
mod groups;
mod primitives;
mod tools;
mod trust;

pub use account::account::*;
pub use account::consent::*;
pub use account::device_approval::*;
pub use account::device_record::*;
pub use account::devices::*;
pub use account::drafts::*;
pub use account::identity::*;
pub use account::notifications::*;
pub use account::opaque::*;
pub use account::recovery::*;
pub use account::signup::*;
pub use account::two_step::*;
pub use drive::colour::*;
pub use drive::drive::*;
pub use drive::links::*;
pub use drive::reports::*;
pub use drive::shares::*;
pub use groups::area_ledger::*;
pub use groups::area_open::*;
pub use groups::group_trust::*;
pub use groups::group_verdicts::*;
pub use groups::groups::*;
pub use groups::join::*;
pub use groups::ledger_settings::*;
pub use groups::roster_calls::*;
pub use groups::rotation_records::*;
pub use primitives::bytes::*;
pub use primitives::error::*;
pub use primitives::ids::*;
pub use primitives::signatures::*;
pub use tools::archive::{
    zip_entries_max, zip_entry_asks_first, zip_entry_preview_limits, ArchiveEntry, ArchiveError,
    ArchiveFolders, EntrySink, LocalSource, PreviewLimits, ZipArchiveSession,
};
pub use tools::images_pdf::{
    cut_jpeg, images_pdf_limits, images_pdf_max_pixels, jpeg_icc_profile, page_layout, CutJpeg, ImageRefusal,
    ImagesPdfError, ImagesPdfLimits, ImagesPdfWriter, PageLayout, PageSize, IMAGES_PDF_CARD_BYTES,
    IMAGES_PDF_MAX_IMAGES, IMAGES_PDF_MAX_INPUT_BYTES, IMAGES_PDF_MAX_OUTPUT_BYTES, IMAGES_PDF_MAX_PIXELS,
};
pub use tools::pdf_tools::{
    pdf_image_size, pdf_inspect, pdf_tools_limits, rotation_of, PdfInspection, PdfPage, PdfPagePlan,
    PdfPagesWriter, PdfRefusal, PdfToolsError, PdfToolsLimits, NESTING_MAX_DEPTH, PAGE_TREE_MAX_DEPTH,
    PDF_IMAGES_CARD_PAGES, PDF_IMAGES_MAX_PAGES, PDF_IMAGES_MAX_PIXELS, PDF_TOOLS_CARD_BYTES,
    PDF_TOOLS_MAX_FILES, PDF_TOOLS_MAX_INPUT_BYTES, PDF_TOOLS_MAX_OUTPUT_BYTES, PDF_TOOLS_MAX_PAGES,
};
pub use tools::text_edit::{
    text_edit_limit, text_editable_kind, text_encode, text_open, text_read_only, LineEnding, TextEncoding,
    TextFormat, TextOpened, TextReadOnly, TEXT_EDIT_LIMIT,
};
pub use tools::tools::*;
pub use trust::contact_guard::*;
pub use trust::contacts::*;
pub use trust::first_seen::*;
pub use trust::rollback_marks::*;

/// The statement grammar's parser and encoder, for the fuzz targets in
/// `fuzz/` only: what every group statement is checked against, which the
/// apps never call directly.
#[cfg(feature = "fuzzing")]
#[doc(hidden)]
pub mod fuzzing {
    use serde_json::Value;

    /// Each entry of a zip as its central directory records it, by index: its method (inside
    /// AES, the real one) and its CRC. None when the archive doesn't list.
    pub fn zip_records(bytes: &[u8]) -> Option<Vec<(u32, u16, u32)>> {
        let zip = crate::tools::archive::Zip::open(&bytes.to_vec()).ok()?;
        let listing = zip.listing().ok()?;
        Some(
            listing
                .entries
                .iter()
                .map(|entry| {
                    let method = if entry.lock == crate::tools::archive::Lock::Aes {
                        entry.aes_method.unwrap_or(u16::MAX)
                    } else {
                        entry.method
                    };
                    (entry.index, method, entry.crc)
                })
                .collect(),
        )
    }

    /// The parts a statement's bytes hold, or none when the grammar refuses them.
    pub fn parse_statement(bytes: &[u8]) -> Option<Vec<Value>> {
        crate::primitives::canonical::parse_statement(bytes, "statement").ok()
    }

    /// The bytes of a statement made of `parts`, or none when the grammar refuses them.
    pub fn encode_statement(parts: &[Value]) -> Option<Vec<u8>> {
        crate::primitives::canonical::encode_statement(parts).ok()
    }

    /// A metadata statement in one of its three writer forms (`ordinary`,
    /// `saved`, `resealed`), or none when its fields are refused or the form is
    /// another; the rekeyed form is `metadata_rekeyed_statement`.
    pub fn metadata_statement_as(
        form: &str,
        statement: &crate::MetadataStatement,
        envelope: &[u8],
    ) -> Option<Vec<u8>> {
        crate::primitives::signatures::metadata_statement_as(form, statement, envelope)
    }

    /// A version statement in one of its three writer forms; see [`metadata_statement_as`].
    pub fn version_statement_as(
        form: &str,
        statement: &crate::VersionStatement,
        envelope: &[u8],
    ) -> Option<Vec<u8>> {
        crate::primitives::signatures::version_statement_as(form, statement, envelope)
    }

    /// An envelope's plaintext exactly as sealed, under `key` and `aad`, or none.
    pub fn plaintext(key: &[u8], envelope: &[u8], aad: &[u8]) -> Option<Vec<u8>> {
        crate::primitives::envelope::open(key, envelope, aad).ok()
    }

    /// An envelope's plaintext under its opening key (an origin key), or none.
    pub fn origin_plaintext(origin_key: &[u8], envelope: &[u8], aad: &[u8]) -> Option<Vec<u8>> {
        crate::primitives::envelope::open_with_opening_key(origin_key, envelope, aad).ok()
    }

    /// A metadata envelope's associated data, or none when its fields are refused.
    pub fn metadata_aad(ctx: &crate::MetadataContext) -> Option<Vec<u8>> {
        crate::drive::drive::metadata_context(ctx).ok()
    }

    /// A version envelope's associated data in `suite`, or none when its fields are refused.
    pub fn version_aad(ctx: &crate::VersionContext, suite: u32) -> Option<Vec<u8>> {
        crate::drive::drive::version_context(ctx, suite).ok()
    }
}

#[cfg(feature = "uniffi")]
uniffi::setup_scaffolding!();
