//! Writer signatures, as `packages/crypto/signatures.ts` makes them and
//! `docs/integrity-design.md` fixes them: every statement is the compact JSON
//! array the web builds, with lowercase ids and SHA-256 digests (base64url) of
//! the sealed bytes it vouches for, signed detached with the identity's
//! Ed25519 key and verified strictly.
//!
//! Each record has three statement forms: the ordinary one ("I wrote this"),
//! the saved one ("I saved this from a link", with a trailing `"link"`), and
//! the re-sealed one ("I re-locked this; I don't vouch for who wrote it"),
//! which a rotation or copy signs over a record it could not verify. Their
//! domains differ, so no signature passes for another form.
//!
//! A rotation that keeps the writer's record (its "origin") signs a fourth,
//! the rekeyed statement, binding the origin to the envelope it sealed again
//! (`docs/integrity-design.md`, "Re-keyed records"). A reader judges such a
//! record by its origin's signature, after opening both envelopes and
//! comparing their bytes.
//!
//! What decides whose keys to trust (the keys statement, successions and
//! shares) is signed with the hybrid signature instead: Ed25519 and ML-DSA-65
//! over the same statement, valid only if both halves verify
//! (`docs/identity-pq-design.md`).

use crate::bytes::{decode, encode, expect_len, KEY_BYTES};
use crate::drive::{
    metadata_context, origin_key_context, version_context, version_envelope_len, MetadataContext,
    OriginKeyContext, OriginRecord, VersionContext, KEY_ENVELOPE_BYTES, METADATA_ENVELOPE_MAX_BYTES,
};
use crate::envelope::{context, open, open_key, open_with_opening_key};
use crate::error::{input, CoreError, CoreResult};
use crate::identity::KEM_PUBLIC_KEY_BYTES;
use crate::pq::{ml_dsa_sign, ml_dsa_verify, ML_DSA_PUBLIC_KEY_BYTES, ML_DSA_SIGNATURE_BYTES};
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use serde_json::{json, Value};
use sha2::{Digest as _, Sha256};
use zeroize::Zeroizing;

pub(crate) const SIGNATURE_BYTES: usize = 64;

/// What a node is; signed with its metadata, so a folder's name is never a file's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum NodeKind {
    Folder,
    File,
}

impl NodeKind {
    fn as_str(self) -> &'static str {
        match self {
            NodeKind::Folder => "folder",
            NodeKind::File => "file",
        }
    }
}

/// What a reader can say about who wrote a record. `Verified` is clean and
/// `SavedFromLink` is shown without a mark (with a neutral line in Info);
/// every other verdict is shown as Unverified.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum Integrity {
    /// The signer is someone this person trusts, and the signature holds under
    /// their current signing key over the ordinary statement.
    Verified,
    /// There is a signature, but by nobody this person has verified.
    UnknownSigner,
    /// The signer is trusted, and the signature does not hold.
    BadSignature,
    /// There is no signature: written before signatures, or stripped.
    Unsigned,
    /// It holds under the signer's current key, but over the re-sealed
    /// statement: they re-locked it and vouch for nothing more.
    Resealed,
    /// It holds only under a signing key the signer has since replaced (an
    /// earlier key their succession chain vouches for, or the reader's own
    /// earlier key), which vouches for nothing any more.
    RetiredKey,
    /// The check could not run: what the reader trusts did not load, or it
    /// failed. The core never returns it; apps use it so a failure is never
    /// shown as clean.
    Unchecked,
    /// It holds under the signer's current key over the saved statement: they
    /// saved it from a link, where nobody's signature could be checked. No
    /// mark on a row; Info and the viewer say "Saved from a link by …".
    SavedFromLink,
}

/// The signing keys a reader trusts for one account: the current one, which
/// alone can make a record `Verified` (or `Resealed`), and the ones it held
/// before, which can only make it `RetiredKey`.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct TrustedKeys {
    pub current: Vec<u8>,
    pub retired: Vec<Vec<u8>>,
}

/// The node a metadata envelope belongs to, as its signature names it.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct MetadataStatement {
    pub workspace_id: String,
    pub node_id: String,
    pub kind: NodeKind,
    pub metadata_version: u64,
}

/// The version a content-key envelope belongs to, as its signature names it.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct VersionStatement {
    pub workspace_id: String,
    pub node_id: String,
    pub version_id: String,
    pub object_id: String,
    pub content_suite: u32,
}

/* SHA-256, base64url: how a statement names sealed bytes. */
pub(crate) fn digest(bytes: &[u8]) -> String {
    encode(&Sha256::digest(bytes))
}

fn positive(value: u64, what: &str) -> CoreResult<u64> {
    if value < 1 {
        return Err(input(format!("Invalid {what}.")));
    }
    Ok(value)
}

/* The web's safe integers, 1..=2^53-1: an identity's key versions, as the web bounds them. */
pub(crate) const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
fn key_version(value: u64) -> CoreResult<u64> {
    if !(1..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(input("Invalid key version."));
    }
    Ok(value)
}

const METADATA_DOMAIN: &str = "hushos/drive/sig/metadata";
const VERSION_DOMAIN: &str = "hushos/drive/sig/version";
const METADATA_RESEALED_DOMAIN: &str = "hushos/drive/sig/metadata-resealed";
const VERSION_RESEALED_DOMAIN: &str = "hushos/drive/sig/version-resealed";
const METADATA_SAVED_DOMAIN: &str = "hushos/drive/sig/metadata-saved";
const VERSION_SAVED_DOMAIN: &str = "hushos/drive/sig/version-saved";
const METADATA_REKEYED_DOMAIN: &str = "hushos/drive/sig/metadata-rekeyed";
const VERSION_REKEYED_DOMAIN: &str = "hushos/drive/sig/version-rekeyed";
/* Where a saved copy came from, the saved statements' last element. Only links, in version 1. */
const SAVED_FROM_LINK: &str = "link";

/* An id as a record statement carries it: lowercased, never empty (the web refuses an empty one). */
fn id(value: &str, what: &str) -> CoreResult<String> {
    if value.is_empty() {
        return Err(input(format!("Invalid {what}.")));
    }
    Ok(value.to_lowercase())
}

/* A count as a record statement carries it: 1..2^53-1, the web's safe integers. */
fn safe_positive(value: u64, what: &str) -> CoreResult<u64> {
    if !(1..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(input(format!("Invalid {what}.")));
    }
    Ok(value)
}

/* Which statement a signature makes over a record. */
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Form {
    Ordinary,
    Saved,
    Resealed,
}

/*
 * [domain, 1, workspaceId, nodeId, kind, metadataVersion, sha256(metadataEnvelope)],
 * and for the saved form "link" after the digest.
 */
fn metadata_parts(form: Form, statement: &MetadataStatement, envelope: &[u8]) -> CoreResult<Vec<u8>> {
    let domain = match form {
        Form::Ordinary => METADATA_DOMAIN,
        Form::Saved => METADATA_SAVED_DOMAIN,
        Form::Resealed => METADATA_RESEALED_DOMAIN,
    };
    let mut parts = vec![
        json!(domain),
        json!(1),
        json!(id(&statement.workspace_id, "workspace id")?),
        json!(id(&statement.node_id, "node id")?),
        json!(statement.kind.as_str()),
        json!(safe_positive(statement.metadata_version, "metadata version")?),
        json!(digest(envelope)),
    ];
    if form == Form::Saved {
        parts.push(json!(SAVED_FROM_LINK));
    }
    Ok(context(&parts))
}

/*
 * [domain, 1, workspaceId, nodeId, versionId, objectId, contentSuite, sha256(contentKeyEnvelope)],
 * and for the saved form "link" after the digest.
 */
fn version_parts(form: Form, statement: &VersionStatement, envelope: &[u8]) -> CoreResult<Vec<u8>> {
    let domain = match form {
        Form::Ordinary => VERSION_DOMAIN,
        Form::Saved => VERSION_SAVED_DOMAIN,
        Form::Resealed => VERSION_RESEALED_DOMAIN,
    };
    let mut parts = vec![
        json!(domain),
        json!(1),
        json!(id(&statement.workspace_id, "workspace id")?),
        json!(id(&statement.node_id, "node id")?),
        json!(id(&statement.version_id, "version id")?),
        json!(id(&statement.object_id, "object id")?),
        json!(positive(statement.content_suite as u64, "content suite")?),
        json!(digest(envelope)),
    ];
    if form == Form::Saved {
        parts.push(json!(SAVED_FROM_LINK));
    }
    Ok(context(&parts))
}

/* The three writer forms by name, for the fuzz targets (crate::fuzzing). */
#[cfg(feature = "fuzzing")]
fn form_named(form: &str) -> Option<Form> {
    match form {
        "ordinary" => Some(Form::Ordinary),
        "saved" => Some(Form::Saved),
        "resealed" => Some(Form::Resealed),
        _ => None,
    }
}

#[cfg(feature = "fuzzing")]
pub(crate) fn metadata_statement_as(
    form: &str,
    statement: &MetadataStatement,
    envelope: &[u8],
) -> Option<Vec<u8>> {
    metadata_parts(form_named(form)?, statement, envelope).ok()
}

#[cfg(feature = "fuzzing")]
pub(crate) fn version_statement_as(
    form: &str,
    statement: &VersionStatement,
    envelope: &[u8],
) -> Option<Vec<u8>> {
    version_parts(form_named(form)?, statement, envelope).ok()
}

fn metadata_message(statement: &MetadataStatement, envelope: &[u8]) -> CoreResult<Vec<u8>> {
    metadata_parts(Form::Ordinary, statement, envelope)
}

fn version_message(statement: &VersionStatement, envelope: &[u8]) -> CoreResult<Vec<u8>> {
    version_parts(Form::Ordinary, statement, envelope)
}

fn metadata_resealed_message(statement: &MetadataStatement, envelope: &[u8]) -> CoreResult<Vec<u8>> {
    metadata_parts(Form::Resealed, statement, envelope)
}

fn version_resealed_message(statement: &VersionStatement, envelope: &[u8]) -> CoreResult<Vec<u8>> {
    version_parts(Form::Resealed, statement, envelope)
}

fn metadata_saved_message(statement: &MetadataStatement, envelope: &[u8]) -> CoreResult<Vec<u8>> {
    metadata_parts(Form::Saved, statement, envelope)
}

fn version_saved_message(statement: &VersionStatement, envelope: &[u8]) -> CoreResult<Vec<u8>> {
    version_parts(Form::Saved, statement, envelope)
}

/* Ed25519 over `message` with the identity's 32-byte signing seed. */
pub(crate) fn sign(signing_seed: &[u8], message: &[u8]) -> CoreResult<Vec<u8>> {
    expect_len("signing seed", signing_seed, 32)?;
    let seed = Zeroizing::new(<[u8; 32]>::try_from(signing_seed).expect("32 bytes"));
    Ok(SigningKey::from_bytes(&seed).sign(message).to_bytes().to_vec())
}

/* Strict Ed25519 verification; anything malformed is simply not a valid signature. */
pub(crate) fn verify(signing_public_key: &[u8], message: &[u8], signature: &[u8]) -> bool {
    let (Ok(key), Ok(signature)) =
        (<[u8; 32]>::try_from(signing_public_key), <[u8; SIGNATURE_BYTES]>::try_from(signature))
    else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&key) else {
        return false;
    };
    key.verify_strict(message, &Signature::from_bytes(&signature)).is_ok()
}

/* A record's three statements, in the order a reader tries them. */
#[derive(Clone)]
pub(crate) struct Messages {
    ordinary: Vec<u8>,
    saved: Vec<u8>,
    resealed: Vec<u8>,
}

/*
 * The verdict, as packages/crypto's integrityOf gives it: no signature is
 * Unsigned; no trusted keys for the signer is UnknownSigner; then the
 * ordinary, saved and re-sealed statements under the current key (Verified,
 * SavedFromLink, Resealed); then any of them under a replaced key
 * (RetiredKey); else BadSignature, a record no statement can be built over
 * included.
 */
fn integrity(
    trusted: Option<&TrustedKeys>,
    messages: CoreResult<Messages>,
    signature: Option<Vec<u8>>,
) -> Integrity {
    let Some(signature) = signature else {
        return Integrity::Unsigned;
    };
    let Some(trusted) = trusted else {
        return Integrity::UnknownSigner;
    };
    let Ok(messages) = messages else {
        return Integrity::BadSignature;
    };
    if verify(&trusted.current, &messages.ordinary, &signature) {
        return Integrity::Verified;
    }
    if verify(&trusted.current, &messages.saved, &signature) {
        return Integrity::SavedFromLink;
    }
    if verify(&trusted.current, &messages.resealed, &signature) {
        return Integrity::Resealed;
    }
    if trusted.retired.iter().any(|key| {
        [&messages.ordinary, &messages.saved, &messages.resealed]
            .into_iter()
            .any(|message| verify(key, message, &signature))
    }) {
        return Integrity::RetiredKey;
    }
    Integrity::BadSignature
}

fn metadata_messages(statement: &MetadataStatement, envelope: &[u8]) -> CoreResult<Messages> {
    Ok(Messages {
        ordinary: metadata_message(statement, envelope)?,
        saved: metadata_saved_message(statement, envelope)?,
        resealed: metadata_resealed_message(statement, envelope)?,
    })
}

fn version_messages(statement: &VersionStatement, envelope: &[u8]) -> CoreResult<Messages> {
    Ok(Messages {
        ordinary: version_message(statement, envelope)?,
        saved: version_saved_message(statement, envelope)?,
        resealed: version_resealed_message(statement, envelope)?,
    })
}

/*
 * How a rotation or rename re-signs a record it sealed again, from the
 * record's verdict as it was: Verified stays ordinary, SavedFromLink stays
 * saved, anything else is re-sealed; an Unchecked record is not signed at all.
 */
fn reseal_form(prior: Integrity) -> CoreResult<Form> {
    match prior {
        Integrity::Verified => Ok(Form::Ordinary),
        Integrity::SavedFromLink => Ok(Form::Saved),
        Integrity::Unchecked => {
            Err(input("HushOS couldn't check who wrote this, so it was not locked again."))
        }
        _ => Ok(Form::Resealed),
    }
}

/* How a copy signs: saved when it came from a link (whose signatures a visitor never sees), else as a reseal. */
fn copy_form(prior: Integrity, from_link: bool) -> CoreResult<Form> {
    if from_link {
        return Ok(Form::Saved);
    }
    reseal_form(prior)
}

/*
 * The legacy signature a rotation writes beside the rekeyed one, for readers
 * that do not know it yet (the honest form, docs/integrity-design.md,
 * "Re-keyed records"): ordinary (or saved) only for the re-keyer's own record
 * whose origin verified as such; re-sealed for everything else, an unchecked
 * record included, so it never claims another person's authorship and never
 * blocks the rotation.
 */
fn compat_form(prior: Integrity, own_record: bool) -> Form {
    match (prior, own_record) {
        (Integrity::Verified, true) => Form::Ordinary,
        (Integrity::SavedFromLink, true) => Form::Saved,
        _ => Form::Resealed,
    }
}

fn sign_metadata_as(
    form: Form,
    signing_seed: &[u8],
    statement: &MetadataStatement,
    envelope: &[u8],
) -> CoreResult<Vec<u8>> {
    sign(signing_seed, &metadata_parts(form, statement, envelope)?)
}

fn sign_version_as(
    form: Form,
    signing_seed: &[u8],
    statement: &VersionStatement,
    envelope: &[u8],
) -> CoreResult<Vec<u8>> {
    sign(signing_seed, &version_parts(form, statement, envelope)?)
}

/// Signs a metadata envelope as its writer, with the identity's signing seed
/// ([`crate::IdentityKeys::signing_seed`]): send as `metadataSignature`.
///
/// ```
/// use hushos_core::{metadata_sign, metadata_verify, random_bytes, MetadataStatement, NodeKind};
/// let seed = random_bytes(32)?;
/// let public = hushos_core::signing_public_key(seed.clone())?;
/// let statement = MetadataStatement { workspace_id: "ws".into(), node_id: "n1".into(), kind: NodeKind::File, metadata_version: 1 };
/// let signature = metadata_sign(seed, statement.clone(), b"sealed".to_vec())?;
/// assert!(metadata_verify(public.clone(), statement.clone(), b"sealed".to_vec(), signature.clone()));
/// assert!(!metadata_verify(public, statement, b"other".to_vec(), signature));
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_sign(
    signing_seed: Vec<u8>,
    statement: MetadataStatement,
    metadata_envelope: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    sign(&signing_seed, &metadata_message(&statement, &metadata_envelope)?)
}

/// Whether `signature` is `signing_public_key`'s over this metadata envelope at this node.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_verify(
    signing_public_key: Vec<u8>,
    statement: MetadataStatement,
    metadata_envelope: Vec<u8>,
    signature: Vec<u8>,
) -> bool {
    metadata_message(&statement, &metadata_envelope)
        .is_ok_and(|message| verify(&signing_public_key, &message, &signature))
}

/// Signs a content-key envelope as its writer: send as `versionSignature`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_sign(
    signing_seed: Vec<u8>,
    statement: VersionStatement,
    content_key_envelope: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    sign(&signing_seed, &version_message(&statement, &content_key_envelope)?)
}

/// Whether `signature` is `signing_public_key`'s over this content-key envelope at this version.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_verify(
    signing_public_key: Vec<u8>,
    statement: VersionStatement,
    content_key_envelope: Vec<u8>,
    signature: Vec<u8>,
) -> bool {
    version_message(&statement, &content_key_envelope)
        .is_ok_and(|message| verify(&signing_public_key, &message, &signature))
}

/// Signs a re-sealed metadata envelope with the re-sealed statement
/// (`"hushos/drive/sig/metadata-resealed"`): "I re-locked this; I don't vouch
/// for who wrote it". Send as `metadataSignature`, exactly like an ordinary one.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_resealed_sign(
    signing_seed: Vec<u8>,
    statement: MetadataStatement,
    metadata_envelope: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    sign(&signing_seed, &metadata_resealed_message(&statement, &metadata_envelope)?)
}

/// Whether `signature` is `signing_public_key`'s re-sealed statement over this metadata envelope.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_resealed_verify(
    signing_public_key: Vec<u8>,
    statement: MetadataStatement,
    metadata_envelope: Vec<u8>,
    signature: Vec<u8>,
) -> bool {
    metadata_resealed_message(&statement, &metadata_envelope)
        .is_ok_and(|message| verify(&signing_public_key, &message, &signature))
}

/// Signs a re-sealed content-key envelope with the re-sealed statement
/// (`"hushos/drive/sig/version-resealed"`): send as `versionSignature`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_resealed_sign(
    signing_seed: Vec<u8>,
    statement: VersionStatement,
    content_key_envelope: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    sign(&signing_seed, &version_resealed_message(&statement, &content_key_envelope)?)
}

/// Whether `signature` is `signing_public_key`'s re-sealed statement over this content-key envelope.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_resealed_verify(
    signing_public_key: Vec<u8>,
    statement: VersionStatement,
    content_key_envelope: Vec<u8>,
    signature: Vec<u8>,
) -> bool {
    version_resealed_message(&statement, &content_key_envelope)
        .is_ok_and(|message| verify(&signing_public_key, &message, &signature))
}

/// Signs a metadata envelope a save from a link created (the copied file's,
/// or a folder the save made) with the saved statement
/// (`"hushos/drive/sig/metadata-saved"`, ending in `"link"`): "I saved this
/// from a link". Send as `metadataSignature`, exactly like an ordinary one.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_saved_sign(
    signing_seed: Vec<u8>,
    statement: MetadataStatement,
    metadata_envelope: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    sign(&signing_seed, &metadata_saved_message(&statement, &metadata_envelope)?)
}

/// Whether `signature` is `signing_public_key`'s saved statement over this metadata envelope.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_saved_verify(
    signing_public_key: Vec<u8>,
    statement: MetadataStatement,
    metadata_envelope: Vec<u8>,
    signature: Vec<u8>,
) -> bool {
    metadata_saved_message(&statement, &metadata_envelope)
        .is_ok_and(|message| verify(&signing_public_key, &message, &signature))
}

/// Signs a content-key envelope a save from a link created with the saved
/// statement (`"hushos/drive/sig/version-saved"`): send as `versionSignature`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_saved_sign(
    signing_seed: Vec<u8>,
    statement: VersionStatement,
    content_key_envelope: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    sign(&signing_seed, &version_saved_message(&statement, &content_key_envelope)?)
}

/// Whether `signature` is `signing_public_key`'s saved statement over this content-key envelope.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_saved_verify(
    signing_public_key: Vec<u8>,
    statement: VersionStatement,
    content_key_envelope: Vec<u8>,
    signature: Vec<u8>,
) -> bool {
    version_saved_message(&statement, &content_key_envelope)
        .is_ok_and(|message| verify(&signing_public_key, &message, &signature))
}

/// How a rotation or a rename signs metadata it sealed again: `prior` is the
/// record's verdict as it was (from [`metadata_integrity`] over the old
/// envelope). A `Verified` record is signed with the ordinary statement and a
/// `SavedFromLink` one with the saved statement; anything else gets the
/// re-sealed one, so re-locking never launders a record into one this person
/// vouches for. An `Unchecked` record is refused: load the trust set and
/// retry rather than re-seal blind. A copy uses [`metadata_copy_sign`].
///
/// ```
/// use hushos_core::*;
/// let seed = random_bytes(32)?;
/// let me = TrustedKeys { current: signing_public_key(seed.clone())?, retired: vec![] };
/// let statement = MetadataStatement { workspace_id: "ws".into(), node_id: "n1".into(), kind: NodeKind::File, metadata_version: 1 };
/// // A planted record nobody this person trusts signed, re-sealed by them:
/// let signature = metadata_reseal_sign(seed.clone(), Integrity::UnknownSigner, statement.clone(), b"new".to_vec())?;
/// assert_eq!(metadata_integrity(Some(me.clone()), statement.clone(), b"new".to_vec(), Some(signature)), Integrity::Resealed);
/// let signature = metadata_reseal_sign(seed.clone(), Integrity::Verified, statement.clone(), b"new".to_vec())?;
/// assert_eq!(metadata_integrity(Some(me), statement.clone(), b"new".to_vec(), Some(signature)), Integrity::Verified);
/// assert!(metadata_reseal_sign(seed, Integrity::Unchecked, statement, b"new".to_vec()).is_err());
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_reseal_sign(
    signing_seed: Vec<u8>,
    prior: Integrity,
    statement: MetadataStatement,
    metadata_envelope: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    sign_metadata_as(reseal_form(prior)?, &signing_seed, &statement, &metadata_envelope)
}

/// How a rotation or a rename signs a content-key envelope it sealed again;
/// see [`metadata_reseal_sign`]. `prior` is the old version's verdict.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_reseal_sign(
    signing_seed: Vec<u8>,
    prior: Integrity,
    statement: VersionStatement,
    content_key_envelope: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    sign_version_as(reseal_form(prior)?, &signing_seed, &statement, &content_key_envelope)
}

/// How a copy ("Save a copy", or a copy within a drive) signs the new
/// metadata envelope, by where the original came from: with `from_link` the
/// saved statement, whatever `prior` is (a visitor never sees signatures);
/// otherwise as [`metadata_reseal_sign`] from the original's verdict
/// (`Verified` ordinary, `SavedFromLink` saved, anything else re-sealed,
/// `Unchecked` refused). Folders a save from a link creates pass `from_link`.
///
/// ```
/// use hushos_core::*;
/// let seed = random_bytes(32)?;
/// let me = TrustedKeys { current: signing_public_key(seed.clone())?, retired: vec![] };
/// let statement = MetadataStatement { workspace_id: "ws".into(), node_id: "n1".into(), kind: NodeKind::File, metadata_version: 1 };
/// let check = |signature| metadata_integrity(Some(me.clone()), statement.clone(), b"copy".to_vec(), Some(signature));
/// let from_link = metadata_copy_sign(seed.clone(), Integrity::Unchecked, true, statement.clone(), b"copy".to_vec())?;
/// assert_eq!(check(from_link), Integrity::SavedFromLink);
/// let verified = metadata_copy_sign(seed.clone(), Integrity::Verified, false, statement.clone(), b"copy".to_vec())?;
/// assert_eq!(check(verified), Integrity::Verified);
/// let planted = metadata_copy_sign(seed.clone(), Integrity::UnknownSigner, false, statement.clone(), b"copy".to_vec())?;
/// assert_eq!(check(planted), Integrity::Resealed);
/// assert!(metadata_copy_sign(seed, Integrity::Unchecked, false, statement, b"copy".to_vec()).is_err());
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_copy_sign(
    signing_seed: Vec<u8>,
    prior: Integrity,
    from_link: bool,
    statement: MetadataStatement,
    metadata_envelope: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    sign_metadata_as(copy_form(prior, from_link)?, &signing_seed, &statement, &metadata_envelope)
}

/// How a copy signs the new version's content-key envelope; see
/// [`metadata_copy_sign`]. `prior` is the original version's verdict.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_copy_sign(
    signing_seed: Vec<u8>,
    prior: Integrity,
    from_link: bool,
    statement: VersionStatement,
    content_key_envelope: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    sign_version_as(copy_form(prior, from_link)?, &signing_seed, &statement, &content_key_envelope)
}

/// The legacy metadata signature a rotation writes beside the rekeyed one
/// ([`metadata_rekey_sign`]), for readers that do not know rekeyed records
/// yet: the ordinary statement only when the origin is the re-keyer's own
/// (`own_record`) and verified, the saved one when it is their own and
/// verified as saved, the re-sealed one otherwise. Never refuses: an
/// `Unchecked` origin is signed re-sealed.
///
/// ```
/// use hushos_core::*;
/// let seed = random_bytes(32)?;
/// let me = TrustedKeys { current: signing_public_key(seed.clone())?, retired: vec![] };
/// let statement = MetadataStatement { workspace_id: "ws".into(), node_id: "n1".into(), kind: NodeKind::File, metadata_version: 1 };
/// let read = |signature| metadata_integrity(Some(me.clone()), statement.clone(), b"new".to_vec(), Some(signature));
/// let own = metadata_compat_sign(seed.clone(), Integrity::Verified, true, statement.clone(), b"new".to_vec())?;
/// assert_eq!(read(own), Integrity::Verified);
/// // Someone else's verified file: re-locked, never "written by" the re-keyer.
/// let theirs = metadata_compat_sign(seed.clone(), Integrity::Verified, false, statement.clone(), b"new".to_vec())?;
/// assert_eq!(read(theirs), Integrity::Resealed);
/// let unchecked = metadata_compat_sign(seed, Integrity::Unchecked, true, statement.clone(), b"new".to_vec())?;
/// assert_eq!(read(unchecked), Integrity::Resealed);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_compat_sign(
    signing_seed: Vec<u8>,
    prior: Integrity,
    own_record: bool,
    statement: MetadataStatement,
    metadata_envelope: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    sign_metadata_as(compat_form(prior, own_record), &signing_seed, &statement, &metadata_envelope)
}

/// The legacy version signature a rotation writes beside the rekeyed one; see
/// [`metadata_compat_sign`].
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_compat_sign(
    signing_seed: Vec<u8>,
    prior: Integrity,
    own_record: bool,
    statement: VersionStatement,
    content_key_envelope: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    sign_version_as(compat_form(prior, own_record), &signing_seed, &statement, &content_key_envelope)
}

/// A record as its writer signed it, before a rotation re-sealed it (the
/// envelope, who the server says signed it, the signature), and the wrapped
/// key the rotation hands readers to open it. What a rekeyed statement names.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RecordOrigin {
    pub envelope: Vec<u8>,
    pub signer_id: String,
    pub signature: Vec<u8>,
    pub key_envelope: Vec<u8>,
}

/*
 * [domain, 1, ...the record's fields, keyEpoch, sha256(envelope), sha256(originEnvelope),
 *  originSignerId, sha256(originSignature), sha256(originKeyEnvelope)]
 * The wrapped key is covered too: a server that garbles it alone breaks the
 * re-keyer's signature, so it can never pass for the re-keyer's mistake.
 */
fn rekeyed_tail(key_epoch: u64, envelope: &[u8], origin: &RecordOrigin) -> CoreResult<[Value; 6]> {
    Ok([
        json!(safe_positive(key_epoch, "key epoch")?),
        json!(digest(envelope)),
        json!(digest(&origin.envelope)),
        json!(id(&origin.signer_id, "user id")?),
        json!(digest(&origin.signature)),
        json!(digest(&origin.key_envelope)),
    ])
}

fn metadata_rekeyed_message(
    statement: &MetadataStatement,
    key_epoch: u64,
    envelope: &[u8],
    origin: &RecordOrigin,
) -> CoreResult<Vec<u8>> {
    let mut parts = vec![
        json!(METADATA_REKEYED_DOMAIN),
        json!(1),
        json!(id(&statement.workspace_id, "workspace id")?),
        json!(id(&statement.node_id, "node id")?),
        json!(statement.kind.as_str()),
        json!(safe_positive(statement.metadata_version, "metadata version")?),
    ];
    parts.extend(rekeyed_tail(key_epoch, envelope, origin)?);
    Ok(context(&parts))
}

fn version_rekeyed_message(
    statement: &VersionStatement,
    key_epoch: u64,
    envelope: &[u8],
    origin: &RecordOrigin,
) -> CoreResult<Vec<u8>> {
    let mut parts = vec![
        json!(VERSION_REKEYED_DOMAIN),
        json!(1),
        json!(id(&statement.workspace_id, "workspace id")?),
        json!(id(&statement.node_id, "node id")?),
        json!(id(&statement.version_id, "version id")?),
        json!(id(&statement.object_id, "object id")?),
        json!(positive(statement.content_suite as u64, "content suite")?),
    ];
    parts.extend(rekeyed_tail(key_epoch, envelope, origin)?);
    Ok(context(&parts))
}

/// `["hushos/drive/sig/metadata-rekeyed",1,workspaceId,nodeId,kind,metadataVersion,keyEpoch,sha256(metadataEnvelope),sha256(originEnvelope),originSignerId,sha256(originSignature),sha256(originKeyEnvelope)]`:
/// what the account running a rotation signs over metadata it re-keyed while
/// keeping the writer's record, `key_epoch` the node key's new epoch. It
/// vouches only that it re-sealed that origin and wrapped that key; who wrote
/// it is the origin's signature's business.
///
/// ```
/// use hushos_core::*;
/// let statement = MetadataStatement { workspace_id: "WS".into(), node_id: "n1".into(), kind: NodeKind::File, metadata_version: 2 };
/// let origin = RecordOrigin { envelope: b"origin".to_vec(), signer_id: "Sam".into(), signature: vec![7; 64], key_envelope: vec![1; 72] };
/// let bytes = metadata_rekeyed_statement(statement, 5, b"current".to_vec(), origin)?;
/// assert!(String::from_utf8(bytes).unwrap().starts_with(r#"["hushos/drive/sig/metadata-rekeyed",1,"ws","n1","file",2,5,"#));
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_rekeyed_statement(
    statement: MetadataStatement,
    key_epoch: u64,
    metadata_envelope: Vec<u8>,
    origin: RecordOrigin,
) -> CoreResult<Vec<u8>> {
    metadata_rekeyed_message(&statement, key_epoch, &metadata_envelope, &origin)
}

/// `["hushos/drive/sig/version-rekeyed",1,workspaceId,nodeId,versionId,objectId,contentSuite,keyEpoch,sha256(contentKeyEnvelope),sha256(originEnvelope),originSignerId,sha256(originSignature),sha256(originKeyEnvelope)]`;
/// see [`metadata_rekeyed_statement`].
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_rekeyed_statement(
    statement: VersionStatement,
    key_epoch: u64,
    content_key_envelope: Vec<u8>,
    origin: RecordOrigin,
) -> CoreResult<Vec<u8>> {
    version_rekeyed_message(&statement, key_epoch, &content_key_envelope, &origin)
}

/// Signs the rekeyed statement over re-keyed metadata with the re-keyer's
/// signing seed: send as the record's `rekey.signature`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_rekey_sign(
    signing_seed: Vec<u8>,
    statement: MetadataStatement,
    key_epoch: u64,
    metadata_envelope: Vec<u8>,
    origin: RecordOrigin,
) -> CoreResult<Vec<u8>> {
    sign(&signing_seed, &metadata_rekeyed_message(&statement, key_epoch, &metadata_envelope, &origin)?)
}

/// Signs the rekeyed statement over a re-keyed version; see [`metadata_rekey_sign`].
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_rekey_sign(
    signing_seed: Vec<u8>,
    statement: VersionStatement,
    key_epoch: u64,
    content_key_envelope: Vec<u8>,
    origin: RecordOrigin,
) -> CoreResult<Vec<u8>> {
    sign(&signing_seed, &version_rekeyed_message(&statement, key_epoch, &content_key_envelope, &origin)?)
}

/// Whether `signature` is `signing_public_key`'s rekeyed statement over this metadata.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_rekeyed_verify(
    signing_public_key: Vec<u8>,
    statement: MetadataStatement,
    key_epoch: u64,
    metadata_envelope: Vec<u8>,
    origin: RecordOrigin,
    signature: Vec<u8>,
) -> bool {
    metadata_rekeyed_message(&statement, key_epoch, &metadata_envelope, &origin)
        .is_ok_and(|message| verify(&signing_public_key, &message, &signature))
}

/// Whether `signature` is `signing_public_key`'s rekeyed statement over this version.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_rekeyed_verify(
    signing_public_key: Vec<u8>,
    statement: VersionStatement,
    key_epoch: u64,
    content_key_envelope: Vec<u8>,
    origin: RecordOrigin,
    signature: Vec<u8>,
) -> bool {
    version_rekeyed_message(&statement, key_epoch, &content_key_envelope, &origin)
        .is_ok_and(|message| verify(&signing_public_key, &message, &signature))
}

/// A re-keyed record's origin as the server serves it: the writer's
/// envelope, signer (`None` once their account is gone) and signature, and
/// the origin's opening key wrapped under the current node key.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ServedOrigin {
    pub envelope: Vec<u8>,
    pub signer_id: Option<String>,
    pub signature: Option<Vec<u8>>,
    pub key_envelope: Vec<u8>,
}

/// Re-keyed metadata as served: the current envelope (under the node key at
/// `key_epoch`), its origin and the re-keyer's signature.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RekeyedMetadata {
    pub statement: MetadataStatement,
    pub key_epoch: u64,
    pub envelope: Vec<u8>,
    pub origin: ServedOrigin,
    pub rekey_signature: Option<Vec<u8>>,
}

/// A re-keyed version as served; see [`RekeyedMetadata`].
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RekeyedVersion {
    pub statement: VersionStatement,
    pub key_epoch: u64,
    pub envelope: Vec<u8>,
    pub origin: ServedOrigin,
    pub rekey_signature: Option<Vec<u8>>,
}

/// The keys a reader trusts for a re-keyed record's two signers: the origin's
/// writer and the re-keyer (`None` for someone the reader has not checked).
/// The origin's are ignored when the record names no origin signer.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RekeyedTrust {
    pub origin: Option<TrustedKeys>,
    pub rekeyer: Option<TrustedKeys>,
}

/// What a reader shows for a re-keyed record.
///
/// - `bound`: `Some(true)` when the reader opened both the origin and the
///   current envelope and their bytes are equal; `Some(false)` when they
///   differ, or when the wrapped key or the origin does not open under a
///   re-keyer signature that verified (the re-keyer attested to them);
///   `None` when it could not be confirmed (the current envelope does not
///   open under the reader's node key, or the wrap or origin does not open
///   and no verified signature covers them): what a server alone can cause.
/// - `origin`: with `bound` true, the origin's verdict under its signer's
///   keys, as [`metadata_integrity`] gives it, named after the origin's
///   signer; `BadSignature` when `bound` is false; `Unchecked` when it is
///   `None`.
/// - `rekeyer`: the re-keyer's verdict over the rekeyed statement. Info only
///   when it verified, retired, is an unknown signer or unchecked; a missing
///   or bad signature (or, in a group's area, a key conflict) is an Unverified
///   mark, "the re-key isn't attested", never a mismatch on its own.
///
/// Name a person as at fault only when their verified signature covers what
/// failed; otherwise say it could not be confirmed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RekeyedVerdict {
    pub origin: Integrity,
    pub rekeyer: Integrity,
    pub bound: Option<bool>,
}

/* Why an origin is not bound to the current envelope, from the reader's side. */
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Unbound {
    /* The current envelope does not open under the node key (or its context or length is refused). */
    Current,
    /* The wrapped key or the origin does not open (or its context or length is refused). */
    Origin,
    /* Both opened, to different bytes. */
    Differ,
}

/*
 * A record's contexts and length checks, as a reader builds them from the
 * served fields: the envelope's associated data, the wrap's (at `key_epoch`),
 * and whether each envelope has the length its record allows.
 */
struct Sealed<'a> {
    aad: CoreResult<Vec<u8>>,
    key_ctx: OriginKeyContext,
    envelope: &'a [u8],
    envelope_fits: bool,
    origin: &'a ServedOrigin,
    origin_fits: bool,
}

impl<'a> Sealed<'a> {
    fn of_metadata(record: &'a RekeyedMetadata) -> Sealed<'a> {
        let s = &record.statement;
        let fits = |envelope: &[u8]| envelope.len() <= METADATA_ENVELOPE_MAX_BYTES;
        Sealed {
            aad: metadata_context(&MetadataContext {
                workspace_id: s.workspace_id.clone(),
                node_id: s.node_id.clone(),
                metadata_version: s.metadata_version,
            }),
            key_ctx: OriginKeyContext {
                workspace_id: s.workspace_id.clone(),
                node_id: s.node_id.clone(),
                key_epoch: record.key_epoch,
                record: OriginRecord::Metadata { metadata_version: s.metadata_version },
                origin_envelope: record.origin.envelope.clone(),
            },
            envelope: &record.envelope,
            envelope_fits: fits(&record.envelope),
            origin: &record.origin,
            origin_fits: fits(&record.origin.envelope),
        }
    }

    fn of_version(record: &'a RekeyedVersion) -> Sealed<'a> {
        let s = &record.statement;
        let length = version_envelope_len(s.content_suite).ok();
        Sealed {
            aad: version_context(
                &VersionContext {
                    workspace_id: s.workspace_id.clone(),
                    node_id: s.node_id.clone(),
                    version_id: s.version_id.clone(),
                    object_id: s.object_id.clone(),
                },
                s.content_suite,
            ),
            key_ctx: OriginKeyContext {
                workspace_id: s.workspace_id.clone(),
                node_id: s.node_id.clone(),
                key_epoch: record.key_epoch,
                record: OriginRecord::Version { version_id: s.version_id.clone() },
                origin_envelope: record.origin.envelope.clone(),
            },
            envelope: &record.envelope,
            envelope_fits: length == Some(record.envelope.len()),
            origin: &record.origin,
            origin_fits: length == Some(record.origin.envelope.len()),
        }
    }

    /*
     * The origin's opening key, when the origin opens with it to exactly the
     * bytes the current envelope holds under `node_key`; otherwise why not.
     * The current envelope is opened first, so a server that garbles anything
     * of the origin's never makes the reader's own key look wrong.
     */
    fn open(&self, node_key: &[u8]) -> Result<Zeroizing<Vec<u8>>, Unbound> {
        let aad = self.aad.as_ref().map_err(|_| Unbound::Current)?;
        if node_key.len() != KEY_BYTES || !self.envelope_fits {
            return Err(Unbound::Current);
        }
        let current = Zeroizing::new(open(node_key, self.envelope, aad).map_err(|_| Unbound::Current)?);
        if !self.origin_fits || self.origin.key_envelope.len() != KEY_ENVELOPE_BYTES {
            return Err(Unbound::Origin);
        }
        let key_aad = origin_key_context(&self.key_ctx).map_err(|_| Unbound::Origin)?;
        let key = Zeroizing::new(
            open_key(node_key, &self.origin.key_envelope, &key_aad, "origin key")
                .map_err(|_| Unbound::Origin)?,
        );
        let written = Zeroizing::new(
            open_with_opening_key(&key, &self.origin.envelope, aad).map_err(|_| Unbound::Origin)?,
        );
        if *written != *current {
            return Err(Unbound::Differ);
        }
        Ok(key)
    }
}

/*
 * A re-keyed record's checks, before trust: whether its origin opens to the
 * current envelope's bytes, the origin's statements and signature, and the
 * rekeyed statement (None when the origin's signer is gone, so the statement
 * cannot name them) with the re-keyer's signature.
 */
pub(crate) struct Rekeyed {
    opened: Result<(), Unbound>,
    origin: CoreResult<Messages>,
    pub(crate) origin_signature: Option<Vec<u8>>,
    /* The record names no origin signer: whatever trust a caller passes for the origin is not theirs. */
    pub(crate) origin_signer_gone: bool,
    rekeyed: Option<CoreResult<Vec<u8>>>,
    pub(crate) rekey_signature: Option<Vec<u8>>,
}

/*
 * The origin as its rekeyed statement names it: none when its signer is gone
 * (the statement names them and the server no longer does), refused when its
 * signature is missing (no state a server may serve).
 */
fn served_origin(origin: &ServedOrigin) -> Option<CoreResult<RecordOrigin>> {
    let signer_id = origin.signer_id.clone()?;
    Some(match &origin.signature {
        Some(signature) => Ok(RecordOrigin {
            envelope: origin.envelope.clone(),
            signer_id,
            signature: signature.clone(),
            key_envelope: origin.key_envelope.clone(),
        }),
        None => Err(input("This record's origin carries no signature.")),
    })
}

impl Rekeyed {
    pub(crate) fn of_metadata(node_key: &[u8], record: &RekeyedMetadata) -> Rekeyed {
        let s = &record.statement;
        Rekeyed {
            opened: Sealed::of_metadata(record).open(node_key).map(|_| ()),
            origin: metadata_messages(s, &record.origin.envelope),
            origin_signature: record.origin.signature.clone(),
            origin_signer_gone: record.origin.signer_id.is_none(),
            rekeyed: served_origin(&record.origin).map(|origin| {
                origin.and_then(|origin| {
                    metadata_rekeyed_message(s, record.key_epoch, &record.envelope, &origin)
                })
            }),
            rekey_signature: record.rekey_signature.clone(),
        }
    }

    pub(crate) fn of_version(node_key: &[u8], record: &RekeyedVersion) -> Rekeyed {
        let s = &record.statement;
        Rekeyed {
            opened: Sealed::of_version(record).open(node_key).map(|_| ()),
            origin: version_messages(s, &record.origin.envelope),
            origin_signature: record.origin.signature.clone(),
            origin_signer_gone: record.origin.signer_id.is_none(),
            rekeyed: served_origin(&record.origin).map(|origin| {
                origin.and_then(|origin| {
                    version_rekeyed_message(s, record.key_epoch, &record.envelope, &origin)
                })
            }),
            rekey_signature: record.rekey_signature.clone(),
        }
    }

    /*
     * Whether the origin is bound to the current envelope, given whether a
     * re-keyer signature that verified (under a current key the reader
     * trusts for them) covers the wrap and the origin.
     */
    pub(crate) fn bound(&self, attested: bool) -> Option<bool> {
        match self.opened {
            Ok(()) => Some(true),
            Err(Unbound::Differ) => Some(false),
            Err(Unbound::Origin) if attested => Some(false),
            Err(_) => None,
        }
    }

    /*
     * The origin's verdict under the keys trusted for its signer, exactly as
     * metadata_integrity gives it; with no origin signer named, under none.
     */
    pub(crate) fn origin(&self, trusted: Option<&TrustedKeys>) -> Integrity {
        let trusted = if self.origin_signer_gone { None } else { trusted };
        integrity(trusted, self.origin.clone(), self.origin_signature.clone())
    }

    /*
     * The re-keyer's verdict over the rekeyed statement, its one form: no
     * signature is Unsigned, no trusted keys UnknownSigner, an origin whose
     * signer is gone Unchecked (the statement names them, and the server no
     * longer does), a statement that does not build BadSignature; then the
     * current key (Verified), the retired ones (RetiredKey), else BadSignature.
     */
    pub(crate) fn rekeyer(&self, trusted: Option<&TrustedKeys>) -> Integrity {
        let Some(signature) = &self.rekey_signature else {
            return Integrity::Unsigned;
        };
        let Some(trusted) = trusted else {
            return Integrity::UnknownSigner;
        };
        let Some(message) = &self.rekeyed else {
            return Integrity::Unchecked;
        };
        let Ok(message) = message else {
            return Integrity::BadSignature;
        };
        if verify(&trusted.current, message, signature) {
            return Integrity::Verified;
        }
        if trusted.retired.iter().any(|key| verify(key, message, signature)) {
            return Integrity::RetiredKey;
        }
        Integrity::BadSignature
    }
}

const UNCHECKED: RekeyedVerdict =
    RekeyedVerdict { origin: Integrity::Unchecked, rekeyer: Integrity::Unchecked, bound: None };

fn rekeyed_verdict(rekeyed: Option<Rekeyed>, trust: Option<RekeyedTrust>) -> RekeyedVerdict {
    let (Some(rekeyed), Some(trust)) = (rekeyed, trust) else {
        return UNCHECKED;
    };
    let rekeyer = rekeyed.rekeyer(trust.rekeyer.as_ref());
    let bound = rekeyed.bound(rekeyer == Integrity::Verified);
    let origin = match bound {
        Some(true) => rekeyed.origin(trust.origin.as_ref()),
        Some(false) => Integrity::BadSignature,
        None => Integrity::Unchecked,
    };
    RekeyedVerdict { origin, rekeyer, bound }
}

/// What a reader shows for re-keyed metadata ([`RekeyedVerdict`]).
/// `node_key` is the node's key at `record.key_epoch`, `None` when the reader
/// does not hold it; `trust` is `None` when what the reader trusts did not
/// load. Either missing is `Unchecked`, never clean.
///
/// ```
/// use hushos_core::*;
/// let (ws, n1) = ("0b6f0e1c-6a52-4f37-9d0e-5f1f2a3b4c5d", "f4a7c2d9-1e3b-4c5a-8f6e-7d8c9b0a1e2f");
/// let (old, fresh) = (random_bytes(32)?, random_bytes(32)?);
/// let (writer, rekeyer) = (random_bytes(32)?, random_bytes(32)?);
/// let trusted = |seed: &Vec<u8>| Some(TrustedKeys { current: signing_public_key(seed.clone()).unwrap(), retired: vec![] });
/// let ctx = MetadataContext { workspace_id: ws.into(), node_id: n1.into(), metadata_version: 1 };
/// let statement = MetadataStatement { workspace_id: ws.into(), node_id: n1.into(), kind: NodeKind::File, metadata_version: 1 };
/// // Sam writes; Maya rotates the folder to epoch 2 and keeps Sam's record.
/// let origin = metadata_seal(ctx.clone(), old.clone(), NodeMetadata { name: "a.txt".into(), mime: None, size: None, modified: None })?;
/// let signature = metadata_sign(writer.clone(), statement.clone(), origin.clone())?;
/// let envelope = metadata_rekey(ctx, old.clone(), fresh.clone(), origin.clone())?;
/// let key_ctx = OriginKeyContext { workspace_id: ws.into(), node_id: n1.into(), key_epoch: 2, record: OriginRecord::Metadata { metadata_version: 1 }, origin_envelope: origin.clone() };
/// let key_envelope = origin_key_wrap(key_ctx, fresh.clone(), origin_opening_key(origin.clone(), old)?)?;
/// let named = RecordOrigin { envelope: origin.clone(), signer_id: "sam".into(), signature: signature.clone(), key_envelope: key_envelope.clone() };
/// let rekey_signature = metadata_rekey_sign(rekeyer.clone(), statement.clone(), 2, envelope.clone(), named)?;
/// let record = RekeyedMetadata {
///     statement, key_epoch: 2, envelope,
///     origin: ServedOrigin { envelope: origin, signer_id: Some("sam".into()), signature: Some(signature), key_envelope },
///     rekey_signature: Some(rekey_signature),
/// };
/// let trust = RekeyedTrust { origin: trusted(&writer), rekeyer: trusted(&rekeyer) };
/// let verdict = metadata_rekeyed_integrity(Some(fresh.clone()), Some(trust.clone()), record.clone());
/// assert_eq!(verdict, RekeyedVerdict { origin: Integrity::Verified, rekeyer: Integrity::Verified, bound: Some(true) });
/// assert_eq!(metadata_rekeyed_integrity(None, Some(trust), record).origin, Integrity::Unchecked);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_rekeyed_integrity(
    node_key: Option<Vec<u8>>,
    trust: Option<RekeyedTrust>,
    record: RekeyedMetadata,
) -> RekeyedVerdict {
    rekeyed_verdict(node_key.map(|key| Rekeyed::of_metadata(&key, &record)), trust)
}

/// What a reader shows for a re-keyed version; see [`metadata_rekeyed_integrity`].
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_rekeyed_integrity(
    node_key: Option<Vec<u8>>,
    trust: Option<RekeyedTrust>,
    record: RekeyedVersion,
) -> RekeyedVerdict {
    rekeyed_verdict(node_key.map(|key| Rekeyed::of_version(&key, &record)), trust)
}

/*
 * The next rotation of a record that already carries an origin: the origin's
 * opening key out of its wrap under `old_key`, re-wrapped under `new_key` at
 * `target_epoch`, but only after the rotating client's own bound check (the
 * origin opens with that key to exactly the current envelope's bytes). An
 * origin that is not bound is `None`: the caller drops it and signs the record
 * legacy re-sealed, so an honest rotation never signs its name under a
 * dishonest re-keyer's mismatch. A record the rotator itself cannot open (its
 * old key does not open the current envelope, or the served ids, version or
 * suite are refused) is an error, not a dropped origin: the rotation has the
 * wrong key or the wrong row, and must stop rather than re-seal blind.
 */
fn carry(sealed: Sealed, old_key: &[u8], new_key: &[u8], target_epoch: u64) -> CoreResult<Option<Vec<u8>>> {
    expect_len("newKey", new_key, KEY_BYTES)?;
    let next = origin_key_context(&OriginKeyContext { key_epoch: target_epoch, ..sealed.key_ctx.clone() })?;
    match sealed.open(old_key) {
        Ok(key) => Ok(Some(crate::envelope::seal(new_key, &key, &next)?)),
        Err(Unbound::Current) => Err(CoreError::Sealed(
            "This item does not open under the key this rotation holds. Load the folder again.".into(),
        )),
        Err(Unbound::Origin | Unbound::Differ) => Ok(None),
    }
}

/// What the next rotation does with metadata that already carries an origin:
/// the origin key re-wrapped under the fresh node key at `target_epoch` (send
/// it as the record's new `originKeyEnvelope`, and sign the rekeyed statement
/// over it), or `None` when the origin is not bound to the current envelope
/// under `old_key` (the node key at `record.key_epoch`): drop the origin and
/// sign the record legacy re-sealed. Refuses a malformed `new_key` or
/// `target_epoch`, served ids, version or suite the contexts refuse, and a
/// current envelope `old_key` does not open: those stop the rotation.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_origin_carry(
    old_key: Vec<u8>,
    new_key: Vec<u8>,
    target_epoch: u64,
    record: RekeyedMetadata,
) -> CoreResult<Option<Vec<u8>>> {
    carry(Sealed::of_metadata(&record), &old_key, &new_key, target_epoch)
}

/// What the next rotation does with a version that already carries an
/// origin; see [`metadata_origin_carry`].
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_origin_carry(
    old_key: Vec<u8>,
    new_key: Vec<u8>,
    target_epoch: u64,
    record: RekeyedVersion,
) -> CoreResult<Option<Vec<u8>>> {
    carry(Sealed::of_version(&record), &old_key, &new_key, target_epoch)
}

/// What a reader shows for a node's metadata. `trusted` holds the signing
/// keys the reader trusts for the account the server names as the writer:
/// its own (its current key, and its earlier ones as retired), or a verified
/// contact's (their current key, and as retired the earlier ones their
/// succession chain vouches for); `None` for anyone else. Only the current
/// key can verify; a match under a retired key is `RetiredKey`, a valid saved
/// signature is `SavedFromLink`, and a valid re-sealed one is `Resealed`.
///
/// ```
/// use hushos_core::{metadata_integrity, metadata_sign, random_bytes, signing_public_key, Integrity, MetadataStatement, NodeKind, TrustedKeys};
/// let seed = random_bytes(32)?;
/// let statement = MetadataStatement { workspace_id: "ws".into(), node_id: "n1".into(), kind: NodeKind::Folder, metadata_version: 2 };
/// let signature = metadata_sign(seed.clone(), statement.clone(), b"sealed".to_vec())?;
/// let me = TrustedKeys { current: signing_public_key(seed.clone())?, retired: vec![] };
/// assert_eq!(metadata_integrity(Some(me.clone()), statement.clone(), b"sealed".to_vec(), Some(signature.clone())), Integrity::Verified);
/// assert_eq!(metadata_integrity(None, statement.clone(), b"sealed".to_vec(), Some(signature.clone())), Integrity::UnknownSigner);
/// assert_eq!(metadata_integrity(Some(me.clone()), statement.clone(), b"swapped".to_vec(), Some(signature.clone())), Integrity::BadSignature);
/// assert_eq!(metadata_integrity(Some(me), statement.clone(), b"sealed".to_vec(), None), Integrity::Unsigned);
/// let replaced = TrustedKeys { current: signing_public_key(random_bytes(32)?)?, retired: vec![signing_public_key(seed)?] };
/// assert_eq!(metadata_integrity(Some(replaced), statement, b"sealed".to_vec(), Some(signature)), Integrity::RetiredKey);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_integrity(
    trusted: Option<TrustedKeys>,
    statement: MetadataStatement,
    metadata_envelope: Vec<u8>,
    signature: Option<Vec<u8>>,
) -> Integrity {
    integrity(trusted.as_ref(), metadata_messages(&statement, &metadata_envelope), signature)
}

/// What a reader shows for a version; see [`metadata_integrity`].
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_integrity(
    trusted: Option<TrustedKeys>,
    statement: VersionStatement,
    content_key_envelope: Vec<u8>,
    signature: Option<Vec<u8>>,
) -> Integrity {
    integrity(trusted.as_ref(), version_messages(&statement, &content_key_envelope), signature)
}

/// The Ed25519 public key of a 32-byte signing seed.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn signing_public_key(signing_seed: Vec<u8>) -> CoreResult<Vec<u8>> {
    expect_len("signing seed", &signing_seed, 32)?;
    let seed = Zeroizing::new(<[u8; 32]>::try_from(signing_seed.as_slice()).expect("32 bytes"));
    Ok(SigningKey::from_bytes(&seed).verifying_key().to_bytes().to_vec())
}

/*
 * A person's hybrid signature (docs/identity-pq-design.md 1): Ed25519 over the
 * statement, then ML-DSA-65 over the same bytes under this context, 3373
 * bytes, valid only if both halves verify. It signs what decides whose keys to
 * trust: the keys statement, successions and shares. File and folder
 * signatures stay Ed25519.
 */
pub(crate) const HYBRID_SIGNATURE_BYTES: usize = SIGNATURE_BYTES + ML_DSA_SIGNATURE_BYTES; // 3373
pub(crate) const IDENTITY_SIGNATURE_CONTEXT: &[u8] = b"hushos/identity/v1";

/// The two public halves a hybrid signature verifies under: Ed25519 (32
/// bytes) and ML-DSA-65 (1952 bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct HybridPublicKey {
    pub signing_public_key: Vec<u8>,
    pub ml_dsa_public_key: Vec<u8>,
}

/* Ed25519 || ML-DSA-65 over the same statement, from the two 32-byte seeds. */
pub(crate) fn sign_hybrid(signing_seed: &[u8], ml_dsa_seed: &[u8], message: &[u8]) -> CoreResult<Vec<u8>> {
    let mut signature = sign(signing_seed, message)?;
    signature.extend(ml_dsa_sign(ml_dsa_seed, message, IDENTITY_SIGNATURE_CONTEXT)?);
    debug_assert_eq!(signature.len(), HYBRID_SIGNATURE_BYTES);
    Ok(signature)
}

/*
 * Whether `signature` is both halves of the hybrid signature over `message`.
 * The caller knows from context that the statement is a hybrid one; a
 * signature of any other length is not valid, never a classical fallback.
 */
pub(crate) fn verify_hybrid(keys: &HybridPublicKey, message: &[u8], signature: &[u8]) -> bool {
    if signature.len() != HYBRID_SIGNATURE_BYTES {
        return false;
    }
    let (classical, lattice) = signature.split_at(SIGNATURE_BYTES);
    verify(&keys.signing_public_key, message, classical)
        && ml_dsa_verify(&keys.ml_dsa_public_key, message, lattice, IDENTITY_SIGNATURE_CONTEXT)
}

/// Signs `message` with a person's hybrid signature: Ed25519 with the 32-byte
/// signing seed, then ML-DSA-65 (hedged, context `hushos/identity/v1`) with
/// the 32-byte ML-DSA seed ([`crate::IdentityKeys::ml_dsa_seed`]). 3373 bytes.
///
/// ```
/// use hushos_core::*;
/// let root = random_bytes(32)?;
/// let keys = identity_open("u".into(), root.clone(), identity_create("u".into(), root, 1)?)?;
/// let signature = hybrid_sign(keys.signing_seed.to_vec(), keys.ml_dsa_seed.to_vec(), b"statement".to_vec())?;
/// assert_eq!(signature.len(), 3373);
/// let public = HybridPublicKey {
///     signing_public_key: base64url_decode(keys.signing_public_key.clone())?,
///     ml_dsa_public_key: base64url_decode(keys.ml_dsa_public_key.clone().unwrap())?,
/// };
/// assert!(hybrid_verify(public.clone(), b"statement".to_vec(), signature.clone()));
/// // The Ed25519 half alone is never enough.
/// assert!(!hybrid_verify(public, b"statement".to_vec(), signature[..64].to_vec()));
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn hybrid_sign(signing_seed: Vec<u8>, ml_dsa_seed: Vec<u8>, message: Vec<u8>) -> CoreResult<Vec<u8>> {
    let (signing_seed, ml_dsa_seed) = (Zeroizing::new(signing_seed), Zeroizing::new(ml_dsa_seed));
    sign_hybrid(&signing_seed, &ml_dsa_seed, &message)
}

/// Whether `signature` is both halves of `keys`' hybrid signature over
/// `message`. Only a 3373-byte signature can hold: the statement's kind says
/// it is hybrid, never the signature's length.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn hybrid_verify(keys: HybridPublicKey, message: Vec<u8>, signature: Vec<u8>) -> bool {
    verify_hybrid(&keys, &message, &signature)
}

fn identifier(value: &str, what: &str) -> CoreResult<String> {
    if value.is_empty() {
        return Err(input(format!("Invalid {what}.")));
    }
    Ok(value.to_lowercase())
}

/* Canonical base64url of the right length, or refused. */
fn public_key(value: &str, length: usize, what: &str) -> CoreResult<Value> {
    decode(what, value, Some(length))?;
    Ok(json!(value))
}

/// `["hushos/identity/keys",1,userId,keyVersion,x25519,ed25519,mlDsa,sha256(kemPublicKey)]`:
/// what binds a version 2 identity's four public keys (base64url, as the
/// server serves them) to the account. The identity signs it with its own
/// hybrid signature. It replaces the Ed25519-only KEM binding.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn keys_statement(
    user_id: String,
    key_version: u64,
    encryption_public_key: String,
    signing_public_key: String,
    ml_dsa_public_key: String,
    kem_public_key: String,
) -> CoreResult<Vec<u8>> {
    let kem = decode("kemPublicKey", &kem_public_key, Some(KEM_PUBLIC_KEY_BYTES))?;
    Ok(context(&[
        json!("hushos/identity/keys"),
        json!(1),
        json!(identifier(&user_id, "user id")?),
        json!(self::key_version(key_version)?),
        public_key(&encryption_public_key, 32, "encryptionPublicKey")?,
        public_key(&signing_public_key, 32, "signingPublicKey")?,
        public_key(&ml_dsa_public_key, ML_DSA_PUBLIC_KEY_BYTES, "mlDsaPublicKey")?,
        json!(digest(&kem)),
    ]))
}

/// `["hushos/identity/succession",2,userId,oldKeyVersion,newKeyVersion,oldX25519,oldEd25519,oldMlDsa,newX25519,newEd25519,newMlDsa,sha256(newKemPublicKey)]`:
/// one link of an identity's succession, signed with the old identity's hybrid
/// signature (the link's `signature` is not part of it). The new version is
/// above the old one. Version 1 is refused everywhere.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn succession_statement(user_id: String, link: crate::SuccessionLink) -> CoreResult<Vec<u8>> {
    succession_at(2, &user_id, &link)
}

/// Which identity signs a half of a succession's consent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ConsentRole {
    Old,
    New,
}

/// `["hushos/identity/succession-consent",1,role,userId,...the version 2
/// fields...]`, role `"old"` or `"new"`: a succession's consent, its own
/// domain, one half signed by the old identity's hybrid keys over role "old"
/// and the other by the new identity's over role "new"
/// (docs/identity-pq-design.md 2). The domain separates it from the one-sided
/// version 2 statement (and from the version 3 succession the docs keep for a
/// restart link), and the role keeps either half from standing for the other.
/// The group core asks it of links into keys it reached from a member's first
/// keys.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn succession_consent_statement(
    user_id: String,
    link: crate::SuccessionLink,
    role: ConsentRole,
) -> CoreResult<Vec<u8>> {
    let role = match role {
        ConsentRole::Old => "old",
        ConsentRole::New => "new",
    };
    succession_fields("hushos/identity/succession-consent", &[json!(1), json!(role)], &user_id, &link)
}

fn succession_at(version: u64, user_id: &str, link: &crate::SuccessionLink) -> CoreResult<Vec<u8>> {
    succession_fields("hushos/identity/succession", &[json!(version)], user_id, link)
}

fn succession_fields(
    domain: &str,
    head: &[serde_json::Value],
    user_id: &str,
    link: &crate::SuccessionLink,
) -> CoreResult<Vec<u8>> {
    // Minted at old + 1; a reader asks only that it rose (a rotation may lift it in between).
    let old_version = key_version(link.old_key_version)?;
    if key_version(link.new_key_version)? <= old_version {
        return Err(input("Invalid key version."));
    }
    let kem = decode("newKemPublicKey", &link.new_kem_public_key, Some(KEM_PUBLIC_KEY_BYTES))?;
    let mut parts = vec![json!(domain)];
    parts.extend(head.iter().cloned());
    parts.extend([
        json!(identifier(user_id, "user id")?),
        json!(old_version),
        json!(link.new_key_version),
        public_key(&link.old_encryption_public_key, 32, "oldEncryptionPublicKey")?,
        public_key(&link.old_signing_public_key, 32, "oldSigningPublicKey")?,
        public_key(&link.old_ml_dsa_public_key, ML_DSA_PUBLIC_KEY_BYTES, "oldMlDsaPublicKey")?,
        public_key(&link.new_encryption_public_key, 32, "newEncryptionPublicKey")?,
        public_key(&link.new_signing_public_key, 32, "newSigningPublicKey")?,
        public_key(&link.new_ml_dsa_public_key, ML_DSA_PUBLIC_KEY_BYTES, "newMlDsaPublicKey")?,
        json!(digest(&kem)),
    ]);
    Ok(context(&parts))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::random;

    fn statement() -> MetadataStatement {
        MetadataStatement {
            workspace_id: "WS".into(),
            node_id: "N1".into(),
            kind: NodeKind::Folder,
            metadata_version: 2,
        }
    }

    #[test]
    fn codex_r3_record_statement_fields_are_bounded_as_the_web_bounds_them() {
        let envelope = b"sealed metadata".to_vec();
        // Empty ids are refused, as the web refuses them.
        for change in [
            MetadataStatement { workspace_id: String::new(), ..statement() },
            MetadataStatement { node_id: String::new(), ..statement() },
        ] {
            assert!(metadata_message(&change, &envelope).unwrap_err().to_string().contains("Invalid"));
        }
        let version = VersionStatement {
            workspace_id: "ws".into(),
            node_id: "n1".into(),
            version_id: "v1".into(),
            object_id: "o1".into(),
            content_suite: u32::MAX,
        };
        assert!(version_message(&version, &envelope).is_ok());
        for change in [
            VersionStatement { version_id: String::new(), ..version.clone() },
            VersionStatement { object_id: String::new(), ..version.clone() },
            VersionStatement { content_suite: 0, ..version.clone() },
        ] {
            assert!(version_message(&change, &envelope).is_err());
        }
        // A metadata version the web cannot hold exactly (above 2^53 - 1) is refused.
        let top = MetadataStatement { metadata_version: MAX_SAFE_INTEGER, ..statement() };
        assert!(metadata_message(&top, &envelope).is_ok());
        let above = MetadataStatement { metadata_version: MAX_SAFE_INTEGER + 1, ..statement() };
        assert!(metadata_message(&above, &envelope).is_err());
    }

    #[test]
    fn statements_are_the_web_s_canonical_arrays() {
        let envelope = b"sealed metadata";
        let message = metadata_message(&statement(), envelope).unwrap();
        assert_eq!(
            String::from_utf8(message).unwrap(),
            format!(r#"["hushos/drive/sig/metadata",1,"ws","n1","folder",2,"{}"]"#, digest(envelope))
        );
        let version = VersionStatement {
            workspace_id: "ws".into(),
            node_id: "n1".into(),
            version_id: "V1".into(),
            object_id: "o1".into(),
            content_suite: 3,
        };
        assert_eq!(
            String::from_utf8(version_message(&version, envelope).unwrap()).unwrap(),
            format!(r#"["hushos/drive/sig/version",1,"ws","n1","v1","o1",3,"{}"]"#, digest(envelope))
        );
        // SHA-256 of "abc", base64url: the digest is the standard one.
        assert_eq!(digest(b"abc"), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
        let mut zero = statement();
        zero.metadata_version = 0;
        assert!(metadata_sign(random(32), zero, envelope.to_vec()).is_err());
    }

    #[test]
    fn a_signature_holds_for_its_record_and_nothing_near_it() {
        let seed = random(32);
        let public = signing_public_key(seed.clone()).unwrap();
        let envelope = random(296);
        let signature = metadata_sign(seed.clone(), statement(), envelope.clone()).unwrap();
        assert_eq!(signature.len(), 64);
        assert!(metadata_verify(public.clone(), statement(), envelope.clone(), signature.clone()));
        let mut flipped = envelope.clone();
        flipped[9] ^= 1;
        let near = [
            (statement(), flipped),
            (MetadataStatement { metadata_version: 3, ..statement() }, envelope.clone()),
            (MetadataStatement { node_id: "n2".into(), ..statement() }, envelope.clone()),
            (MetadataStatement { kind: NodeKind::File, ..statement() }, envelope.clone()),
        ];
        for (other, bytes) in near {
            assert!(!metadata_verify(public.clone(), other, bytes, signature.clone()));
        }
        // The same bytes as a version's envelope: another statement kind.
        let as_version = VersionStatement {
            workspace_id: "ws".into(),
            node_id: "n1".into(),
            version_id: "v".into(),
            object_id: "o".into(),
            content_suite: 2,
        };
        assert!(!version_verify(public.clone(), as_version, envelope.clone(), signature.clone()));
        // Another signer, a flipped signature, a short one, a malformed key.
        let stranger = signing_public_key(random(32)).unwrap();
        assert!(!metadata_verify(stranger, statement(), envelope.clone(), signature.clone()));
        let mut bad = signature.clone();
        bad[0] ^= 1;
        assert!(!metadata_verify(public.clone(), statement(), envelope.clone(), bad));
        assert!(!metadata_verify(public, statement(), envelope.clone(), signature[1..].to_vec()));
        assert!(!metadata_verify(vec![0; 31], statement(), envelope, signature));
    }

    fn version() -> VersionStatement {
        VersionStatement {
            workspace_id: "ws".into(),
            node_id: "n1".into(),
            version_id: "v1".into(),
            object_id: "o1".into(),
            content_suite: 3,
        }
    }

    fn key(seed: &[u8]) -> Vec<u8> {
        signing_public_key(seed.to_vec()).unwrap()
    }

    #[test]
    fn only_the_current_key_verifies_and_a_replaced_one_is_a_retired_key() {
        let (earlier, current) = (random(32), random(32));
        let envelope = random(84);
        let by_earlier = version_sign(earlier.clone(), version(), envelope.clone()).unwrap();
        let by_current = version_sign(current.clone(), version(), envelope.clone()).unwrap();
        let chain = TrustedKeys { current: key(&current), retired: vec![key(&earlier)] };
        let check = |trusted: Option<TrustedKeys>, signature: &[u8]| {
            version_integrity(trusted, version(), envelope.clone(), Some(signature.to_vec()))
        };
        assert_eq!(check(Some(chain.clone()), &by_current), Integrity::Verified);
        assert_eq!(check(Some(chain.clone()), &by_earlier), Integrity::RetiredKey);
        // No chain to the earlier key at all: it is simply not theirs.
        assert_eq!(
            check(Some(TrustedKeys { current: key(&current), retired: vec![] }), &by_earlier),
            Integrity::BadSignature
        );
        assert_eq!(check(None, &by_current), Integrity::UnknownSigner);
        assert_eq!(version_integrity(Some(chain), version(), envelope, None), Integrity::Unsigned);
    }

    #[test]
    fn a_resealed_signature_is_never_an_ordinary_one_and_the_reverse() {
        let (seed, earlier) = (random(32), random(32));
        let envelope = random(84);
        assert_eq!(
            String::from_utf8(version_resealed_message(&version(), &envelope).unwrap()).unwrap(),
            format!(
                r#"["hushos/drive/sig/version-resealed",1,"ws","n1","v1","o1",3,"{}"]"#,
                digest(&envelope)
            )
        );
        assert_eq!(
            String::from_utf8(metadata_resealed_message(&statement(), &envelope).unwrap()).unwrap(),
            format!(
                r#"["hushos/drive/sig/metadata-resealed",1,"ws","n1","folder",2,"{}"]"#,
                digest(&envelope)
            )
        );
        let resealed = version_resealed_sign(seed.clone(), version(), envelope.clone()).unwrap();
        let ordinary = version_sign(seed.clone(), version(), envelope.clone()).unwrap();
        // Domain separation both ways, at the primitive and for metadata too.
        assert!(!version_verify(key(&seed), version(), envelope.clone(), resealed.clone()));
        assert!(!version_resealed_verify(key(&seed), version(), envelope.clone(), ordinary.clone()));
        assert!(version_resealed_verify(key(&seed), version(), envelope.clone(), resealed.clone()));
        let metadata_resealed = metadata_resealed_sign(seed.clone(), statement(), envelope.clone()).unwrap();
        assert!(!metadata_verify(key(&seed), statement(), envelope.clone(), metadata_resealed.clone()));
        let trusted = TrustedKeys { current: key(&seed), retired: vec![key(&earlier)] };
        assert_eq!(
            version_integrity(Some(trusted.clone()), version(), envelope.clone(), Some(resealed.clone())),
            Integrity::Resealed
        );
        assert_eq!(
            version_integrity(Some(trusted.clone()), version(), envelope.clone(), Some(ordinary)),
            Integrity::Verified
        );
        assert_eq!(
            metadata_integrity(Some(trusted.clone()), statement(), envelope.clone(), Some(metadata_resealed)),
            Integrity::Resealed
        );
        // Re-sealed under a replaced key is still only a retired key.
        let old = version_resealed_sign(earlier, version(), envelope.clone()).unwrap();
        assert_eq!(
            version_integrity(Some(trusted.clone()), version(), envelope, Some(old)),
            Integrity::RetiredKey
        );
        // Over another record it holds for nothing.
        assert_eq!(
            version_integrity(Some(trusted), version(), random(84), Some(resealed)),
            Integrity::BadSignature
        );
    }

    #[test]
    fn re_signing_after_a_check_vouches_only_for_what_verified() {
        let seed = random(32);
        let me = TrustedKeys { current: key(&seed), retired: vec![] };
        let envelope = random(84);
        for prior in [
            Integrity::UnknownSigner,
            Integrity::BadSignature,
            Integrity::Unsigned,
            Integrity::Resealed,
            Integrity::RetiredKey,
        ] {
            let signature = version_reseal_sign(seed.clone(), prior, version(), envelope.clone()).unwrap();
            assert_eq!(
                version_integrity(Some(me.clone()), version(), envelope.clone(), Some(signature)),
                Integrity::Resealed,
                "{prior:?}"
            );
            let signature = metadata_reseal_sign(seed.clone(), prior, statement(), envelope.clone()).unwrap();
            assert_eq!(
                metadata_integrity(Some(me.clone()), statement(), envelope.clone(), Some(signature)),
                Integrity::Resealed,
                "{prior:?}"
            );
        }
        let signature =
            version_reseal_sign(seed.clone(), Integrity::Verified, version(), envelope.clone()).unwrap();
        assert_eq!(
            version_integrity(Some(me), version(), envelope.clone(), Some(signature)),
            Integrity::Verified
        );
        assert!(version_reseal_sign(seed.clone(), Integrity::Unchecked, version(), envelope.clone()).is_err());
        assert!(metadata_reseal_sign(seed, Integrity::Unchecked, statement(), envelope).is_err());
    }

    #[test]
    fn saved_statements_end_in_link_and_no_form_passes_for_another() {
        let seed = random(32);
        let envelope = random(84);
        assert_eq!(
            String::from_utf8(metadata_saved_message(&statement(), &envelope).unwrap()).unwrap(),
            format!(
                r#"["hushos/drive/sig/metadata-saved",1,"ws","n1","folder",2,"{}","link"]"#,
                digest(&envelope)
            )
        );
        assert_eq!(
            String::from_utf8(version_saved_message(&version(), &envelope).unwrap()).unwrap(),
            format!(
                r#"["hushos/drive/sig/version-saved",1,"ws","n1","v1","o1",3,"{}","link"]"#,
                digest(&envelope)
            )
        );
        let public = key(&seed);
        // Each form's signature, checked by every form's verifier: only its own holds.
        let metadata = [
            (Form::Ordinary, metadata_sign(seed.clone(), statement(), envelope.clone()).unwrap()),
            (Form::Saved, metadata_saved_sign(seed.clone(), statement(), envelope.clone()).unwrap()),
            (Form::Resealed, metadata_resealed_sign(seed.clone(), statement(), envelope.clone()).unwrap()),
        ];
        for (form, signature) in &metadata {
            let held = [
                (
                    Form::Ordinary,
                    metadata_verify(public.clone(), statement(), envelope.clone(), signature.clone()),
                ),
                (
                    Form::Saved,
                    metadata_saved_verify(public.clone(), statement(), envelope.clone(), signature.clone()),
                ),
                (
                    Form::Resealed,
                    metadata_resealed_verify(
                        public.clone(),
                        statement(),
                        envelope.clone(),
                        signature.clone(),
                    ),
                ),
            ];
            for (verifier, ok) in held {
                assert_eq!(ok, verifier == *form, "{form:?} signature under the {verifier:?} verifier");
            }
        }
        let versions = [
            (Form::Ordinary, version_sign(seed.clone(), version(), envelope.clone()).unwrap()),
            (Form::Saved, version_saved_sign(seed.clone(), version(), envelope.clone()).unwrap()),
            (Form::Resealed, version_resealed_sign(seed.clone(), version(), envelope.clone()).unwrap()),
        ];
        for (form, signature) in &versions {
            let held = [
                (
                    Form::Ordinary,
                    version_verify(public.clone(), version(), envelope.clone(), signature.clone()),
                ),
                (
                    Form::Saved,
                    version_saved_verify(public.clone(), version(), envelope.clone(), signature.clone()),
                ),
                (
                    Form::Resealed,
                    version_resealed_verify(public.clone(), version(), envelope.clone(), signature.clone()),
                ),
            ];
            for (verifier, ok) in held {
                assert_eq!(ok, verifier == *form, "{form:?} signature under the {verifier:?} verifier");
            }
        }
        // And the verdicts: each form reads as itself, saved under a replaced key is only retired.
        let trusted = TrustedKeys { current: public.clone(), retired: vec![] };
        let verdicts: Vec<_> = versions
            .iter()
            .map(|(_, signature)| {
                version_integrity(Some(trusted.clone()), version(), envelope.clone(), Some(signature.clone()))
            })
            .collect();
        assert_eq!(verdicts, [Integrity::Verified, Integrity::SavedFromLink, Integrity::Resealed]);
        assert_eq!(
            metadata_integrity(
                Some(trusted.clone()),
                statement(),
                envelope.clone(),
                Some(metadata[1].1.clone())
            ),
            Integrity::SavedFromLink
        );
        let replaced = TrustedKeys { current: key(&random(32)), retired: vec![public] };
        assert_eq!(
            version_integrity(Some(replaced), version(), envelope.clone(), Some(versions[1].1.clone())),
            Integrity::RetiredKey
        );
        // Over another envelope a saved signature holds for nothing.
        assert_eq!(
            version_integrity(Some(trusted), version(), random(84), Some(versions[1].1.clone())),
            Integrity::BadSignature
        );
    }

    #[test]
    fn a_copy_is_signed_by_where_it_came_from_and_a_reseal_keeps_only_what_checked() {
        let seed = random(32);
        let me = TrustedKeys { current: key(&seed), retired: vec![] };
        let envelope = random(84);
        let read = |signature: Vec<u8>| {
            version_integrity(Some(me.clone()), version(), envelope.clone(), Some(signature))
        };
        let read_metadata = |signature: Vec<u8>| {
            metadata_integrity(Some(me.clone()), statement(), envelope.clone(), Some(signature))
        };
        // From a link: saved, whatever the original's verdict (a visitor has none to check).
        for prior in
            [Integrity::Unchecked, Integrity::Verified, Integrity::UnknownSigner, Integrity::Unsigned]
        {
            let signature =
                version_copy_sign(seed.clone(), prior, true, version(), envelope.clone()).unwrap();
            assert_eq!(read(signature), Integrity::SavedFromLink, "{prior:?}");
            let signature =
                metadata_copy_sign(seed.clone(), prior, true, statement(), envelope.clone()).unwrap();
            assert_eq!(read_metadata(signature), Integrity::SavedFromLink, "{prior:?}");
        }
        // Not from a link: a verified original stays ordinary, a saved one stays saved,
        // everything else is re-sealed, and an unchecked one is refused.
        let expected = [
            (Integrity::Verified, Integrity::Verified),
            (Integrity::SavedFromLink, Integrity::SavedFromLink),
            (Integrity::UnknownSigner, Integrity::Resealed),
            (Integrity::BadSignature, Integrity::Resealed),
            (Integrity::Unsigned, Integrity::Resealed),
            (Integrity::Resealed, Integrity::Resealed),
            (Integrity::RetiredKey, Integrity::Resealed),
        ];
        for (prior, verdict) in expected {
            let copied = version_copy_sign(seed.clone(), prior, false, version(), envelope.clone()).unwrap();
            assert_eq!(read(copied), verdict, "copy of {prior:?}");
            let copied =
                metadata_copy_sign(seed.clone(), prior, false, statement(), envelope.clone()).unwrap();
            assert_eq!(read_metadata(copied), verdict, "copy of {prior:?}");
            // A rotation or rename re-signs the same way, saved only for what verified as saved.
            let rotated = version_reseal_sign(seed.clone(), prior, version(), envelope.clone()).unwrap();
            assert_eq!(read(rotated), verdict, "reseal of {prior:?}");
            let renamed = metadata_reseal_sign(seed.clone(), prior, statement(), envelope.clone()).unwrap();
            assert_eq!(read_metadata(renamed), verdict, "reseal of {prior:?}");
        }
        assert!(version_copy_sign(seed.clone(), Integrity::Unchecked, false, version(), envelope.clone())
            .is_err());
        assert!(metadata_copy_sign(seed, Integrity::Unchecked, false, statement(), envelope).is_err());
    }

    /* Round 8 (Codex 1): identity key versions stop at 2^53 - 1, as the web's safe integers do. */
    #[test]
    fn identity_key_versions_stop_where_the_web_s_safe_integers_do() {
        let key = |n: u8| crate::bytes::encode(&[n; 32]);
        let ml_dsa = crate::bytes::encode(&vec![3; crate::pq::ML_DSA_PUBLIC_KEY_BYTES]);
        let kem = crate::bytes::encode(&vec![4; crate::identity::KEM_PUBLIC_KEY_BYTES]);
        let user = "11111111-1111-4111-8111-111111111111".to_string();
        let link = |old: u64, new: u64| crate::SuccessionLink {
            old_key_version: old,
            new_key_version: new,
            old_encryption_public_key: key(1),
            old_signing_public_key: key(2),
            old_ml_dsa_public_key: ml_dsa.clone(),
            new_encryption_public_key: key(5),
            new_signing_public_key: key(6),
            new_ml_dsa_public_key: ml_dsa.clone(),
            new_kem_public_key: kem.clone(),
            signature: String::new(),
            consent: None,
        };
        assert!(succession_statement(user.clone(), link(1, MAX_SAFE_INTEGER)).is_ok());
        assert!(succession_statement(user.clone(), link(1, MAX_SAFE_INTEGER + 1)).is_err());
        assert!(succession_statement(user.clone(), link(1, u64::MAX)).is_err());
        assert!(succession_statement(user.clone(), link(MAX_SAFE_INTEGER + 1, u64::MAX)).is_err());
        assert!(keys_statement(user.clone(), MAX_SAFE_INTEGER, key(1), key(2), ml_dsa.clone(), kem.clone())
            .is_ok());
        assert!(keys_statement(user, MAX_SAFE_INTEGER + 1, key(1), key(2), ml_dsa, kem).is_err());
    }

    const SAM: &str = "55555555-5555-4555-8555-555555555555";
    const WS: &str = "11111111-1111-4111-8111-111111111111";
    const NODE: &str = "22222222-2222-4222-8222-222222222222";

    #[test]
    fn the_rekeyed_statements_are_the_web_s_canonical_arrays_the_wrap_covered() {
        let (current, origin, signature, wrap) = (random(296), random(296), random(64), random(72));
        let named = RecordOrigin {
            envelope: origin.clone(),
            signer_id: SAM.to_uppercase(),
            signature: signature.clone(),
            key_envelope: wrap.clone(),
        };
        assert_eq!(
            String::from_utf8(metadata_rekeyed_message(&statement(), 7, &current, &named).unwrap()).unwrap(),
            format!(
                r#"["hushos/drive/sig/metadata-rekeyed",1,"ws","n1","folder",2,7,"{}","{}","{SAM}","{}","{}"]"#,
                digest(&current),
                digest(&origin),
                digest(&signature),
                digest(&wrap)
            )
        );
        assert_eq!(
            String::from_utf8(version_rekeyed_message(&version(), 7, &current, &named).unwrap()).unwrap(),
            format!(
                r#"["hushos/drive/sig/version-rekeyed",1,"ws","n1","v1","o1",3,7,"{}","{}","{SAM}","{}","{}"]"#,
                digest(&current),
                digest(&origin),
                digest(&signature),
                digest(&wrap)
            )
        );
        assert!(metadata_rekeyed_message(&statement(), 0, &current, &named).is_err());
        assert!(metadata_rekeyed_message(&statement(), MAX_SAFE_INTEGER + 1, &current, &named).is_err());
        let nobody = RecordOrigin { signer_id: String::new(), ..named };
        assert!(version_rekeyed_message(&version(), 7, &current, &nobody).is_err());
    }

    /* The envelope contexts take lowercase UUIDs, as the web's do. */
    fn sealed() -> MetadataStatement {
        MetadataStatement { workspace_id: WS.into(), node_id: NODE.into(), ..statement() }
    }

    fn metadata_ctx() -> MetadataContext {
        MetadataContext { workspace_id: WS.into(), node_id: NODE.into(), metadata_version: 2 }
    }

    fn key_ctx(origin: &[u8], key_epoch: u64) -> OriginKeyContext {
        OriginKeyContext {
            workspace_id: WS.into(),
            node_id: NODE.into(),
            key_epoch,
            record: OriginRecord::Metadata { metadata_version: 2 },
            origin_envelope: origin.to_vec(),
        }
    }

    /* Sam writes and signs; Maya rotates to epoch 3 keeping Sam's record. */
    struct Rotated {
        sam: Vec<u8>,
        maya: Vec<u8>,
        old: Vec<u8>,
        fresh: Vec<u8>,
        record: RekeyedMetadata,
    }

    /* Maya's signature over the record as it stands: the current envelope and the wrap it carries. */
    fn rekey_signed(maya: &[u8], record: &RekeyedMetadata) -> Vec<u8> {
        let named = RecordOrigin {
            envelope: record.origin.envelope.clone(),
            signer_id: SAM.into(),
            signature: record.origin.signature.clone().unwrap(),
            key_envelope: record.origin.key_envelope.clone(),
        };
        metadata_rekey_sign(maya.to_vec(), sealed(), 3, record.envelope.clone(), named).unwrap()
    }

    fn rotated() -> Rotated {
        let (sam, maya, old, fresh) = (random(32), random(32), random(32), random(32));
        let metadata =
            crate::NodeMetadata { name: "plan.md".into(), mime: None, size: Some(4), modified: None };
        let origin = crate::metadata_seal(metadata_ctx(), old.clone(), metadata).unwrap();
        let written = metadata_sign(sam.clone(), sealed(), origin.clone()).unwrap();
        let key_envelope = crate::origin_key_wrap(
            key_ctx(&origin, 3),
            fresh.clone(),
            crate::origin_opening_key(origin.clone(), old.clone()).unwrap(),
        )
        .unwrap();
        let mut record = RekeyedMetadata {
            statement: sealed(),
            key_epoch: 3,
            envelope: crate::metadata_rekey(metadata_ctx(), old.clone(), fresh.clone(), origin.clone())
                .unwrap(),
            origin: ServedOrigin {
                envelope: origin,
                signer_id: Some(SAM.into()),
                signature: Some(written),
                key_envelope,
            },
            rekey_signature: None,
        };
        record.rekey_signature = Some(rekey_signed(&maya, &record));
        Rotated { sam, maya, old, fresh, record }
    }

    fn trust_of(r: &Rotated) -> RekeyedTrust {
        RekeyedTrust {
            origin: Some(TrustedKeys { current: key(&r.sam), retired: vec![] }),
            rekeyer: Some(TrustedKeys { current: key(&r.maya), retired: vec![] }),
        }
    }

    fn read(r: &Rotated, record: RekeyedMetadata) -> RekeyedVerdict {
        metadata_rekeyed_integrity(Some(r.fresh.clone()), Some(trust_of(r)), record)
    }

    fn verdict(origin: Integrity, rekeyer: Integrity, bound: Option<bool>) -> RekeyedVerdict {
        RekeyedVerdict { origin, rekeyer, bound }
    }

    #[test]
    fn a_rekeyed_record_reads_as_its_writer_s_bound_and_the_re_keyer_stays_in_info() {
        let r = rotated();
        assert_eq!(read(&r, r.record.clone()), verdict(Integrity::Verified, Integrity::Verified, Some(true)));
        let unchecked = verdict(Integrity::Unchecked, Integrity::Unchecked, None);
        assert_eq!(metadata_rekeyed_integrity(None, Some(trust_of(&r)), r.record.clone()), unchecked);
        assert_eq!(metadata_rekeyed_integrity(Some(r.fresh.clone()), None, r.record.clone()), unchecked);
        // The current envelope does not open under the old key: never confirmed, never the re-keyer's fault.
        assert_eq!(
            metadata_rekeyed_integrity(Some(r.old.clone()), Some(trust_of(&r)), r.record),
            verdict(Integrity::Unchecked, Integrity::Verified, None)
        );
    }

    #[test]
    fn the_re_keyer_cannot_pair_the_writer_s_signature_with_other_bytes() {
        let r = rotated();
        let other = crate::metadata_seal(
            metadata_ctx(),
            r.fresh.clone(),
            crate::NodeMetadata { name: "not-sam.md".into(), mime: None, size: Some(4), modified: None },
        )
        .unwrap();
        let mut forged = RekeyedMetadata { envelope: other, ..r.record.clone() };
        forged.rekey_signature = Some(rekey_signed(&r.maya, &forged));
        assert_eq!(read(&r, forged), verdict(Integrity::BadSignature, Integrity::Verified, Some(false)));
    }

    #[test]
    fn a_server_that_garbles_only_the_wrapped_key_frames_nobody() {
        let r = rotated();
        let mut garbled = r.record.clone();
        garbled.origin.key_envelope[30] ^= 1;
        assert_eq!(read(&r, garbled), verdict(Integrity::Unchecked, Integrity::BadSignature, None));
    }

    #[test]
    fn the_origin_key_is_not_the_node_key_a_wrapped_old_node_key_opens_nothing() {
        let r = rotated();
        let mut swapped = r.record.clone();
        swapped.origin.key_envelope =
            crate::origin_key_wrap(key_ctx(&r.record.origin.envelope, 3), r.fresh.clone(), r.old.clone())
                .unwrap();
        // Unsigned over it, it could be the server's doing: not confirmed.
        assert_eq!(read(&r, swapped.clone()).bound, None);
        // Under Maya's verified signature she attested to it: not bound.
        swapped.rekey_signature = Some(rekey_signed(&r.maya, &swapped));
        assert_eq!(read(&r, swapped), verdict(Integrity::BadSignature, Integrity::Verified, Some(false)));
    }

    #[test]
    fn a_missing_or_bad_rekey_signature_over_equal_bytes_is_no_mismatch() {
        let r = rotated();
        let unsigned = RekeyedMetadata { rekey_signature: None, ..r.record.clone() };
        assert_eq!(read(&r, unsigned), verdict(Integrity::Verified, Integrity::Unsigned, Some(true)));
        let maya = TrustedKeys { current: key(&r.maya), retired: vec![] };
        for form in [Form::Ordinary, Form::Saved, Form::Resealed] {
            let signed = sign_metadata_as(form, &r.maya, &sealed(), &r.record.envelope).unwrap();
            let record = RekeyedMetadata { rekey_signature: Some(signed), ..r.record.clone() };
            assert_eq!(
                read(&r, record),
                verdict(Integrity::Verified, Integrity::BadSignature, Some(true)),
                "{form:?}"
            );
        }
        assert_eq!(
            metadata_integrity(
                Some(maya),
                sealed(),
                r.record.envelope.clone(),
                r.record.rekey_signature.clone()
            ),
            Integrity::BadSignature
        );
    }

    #[test]
    fn with_no_origin_signer_named_no_caller_s_trust_speaks_for_one() {
        let r = rotated();
        let mut gone = r.record.clone();
        gone.origin.signer_id = None;
        assert_eq!(read(&r, gone), verdict(Integrity::UnknownSigner, Integrity::Unchecked, Some(true)));
    }

    #[test]
    fn the_next_rotation_carries_a_bound_origin_re_wrapped_for_the_new_epoch() {
        let r = rotated();
        let next = random(32);
        let wrap =
            metadata_origin_carry(r.fresh.clone(), next.clone(), 4, r.record.clone()).unwrap().unwrap();
        let key = crate::origin_key_open(key_ctx(&r.record.origin.envelope, 4), next.clone(), wrap).unwrap();
        let aad = metadata_context(&metadata_ctx()).unwrap();
        assert_eq!(
            open_with_opening_key(&key, &r.record.origin.envelope, &aad).unwrap(),
            open(&r.fresh, &r.record.envelope, &aad).unwrap()
        );
        // A malformed next wrap is the caller's mistake, not a dropped origin.
        assert!(metadata_origin_carry(r.fresh.clone(), random(16), 4, r.record.clone()).is_err());
        assert!(metadata_origin_carry(r.fresh.clone(), next, 0, r.record).is_err());
    }

    #[test]
    fn the_next_rotation_drops_an_origin_that_is_not_bound_whoever_signed_it() {
        let r = rotated();
        let next = random(32);
        let carry = |record: RekeyedMetadata, old: &[u8]| {
            metadata_origin_carry(old.to_vec(), next.clone(), 4, record).unwrap()
        };
        let other = crate::metadata_seal(
            metadata_ctx(),
            r.fresh.clone(),
            crate::NodeMetadata { name: "not-sam.md".into(), mime: None, size: Some(4), modified: None },
        )
        .unwrap();
        let mut forged = RekeyedMetadata { envelope: other, ..r.record.clone() };
        forged.rekey_signature = Some(rekey_signed(&r.maya, &forged));
        assert_eq!(carry(forged, &r.fresh), None, "a dishonest re-keyer's mismatch is never adopted");
        let mut leaked = r.record.clone();
        leaked.origin.key_envelope =
            crate::origin_key_wrap(key_ctx(&r.record.origin.envelope, 3), r.fresh.clone(), r.old.clone())
                .unwrap();
        leaked.rekey_signature = Some(rekey_signed(&r.maya, &leaked));
        assert_eq!(carry(leaked, &r.fresh), None, "a wrapped old node key is never passed on");
        assert_eq!(carry(RekeyedMetadata { key_epoch: 2, ..r.record.clone() }, &r.fresh), None);
        // A key the current envelope does not open under is the rotation's own mistake: it stops.
        assert!(metadata_origin_carry(r.old.clone(), next.clone(), 4, r.record.clone()).is_err());
        let mut nameless = r.record.clone();
        nameless.statement.node_id = "n1".into();
        assert!(metadata_origin_carry(r.fresh.clone(), next.clone(), 4, nameless).is_err());
    }

    #[test]
    fn the_legacy_form_beside_it_is_honest_and_never_refuses() {
        let seed = random(32);
        let me = TrustedKeys { current: key(&seed), retired: vec![] };
        let envelope = random(84);
        for prior in [
            Integrity::Verified,
            Integrity::SavedFromLink,
            Integrity::Resealed,
            Integrity::RetiredKey,
            Integrity::UnknownSigner,
            Integrity::BadSignature,
            Integrity::Unsigned,
            Integrity::Unchecked,
        ] {
            let own = match prior {
                Integrity::Verified => Integrity::Verified,
                Integrity::SavedFromLink => Integrity::SavedFromLink,
                _ => Integrity::Resealed,
            };
            let mine = version_compat_sign(seed.clone(), prior, true, version(), envelope.clone()).unwrap();
            assert_eq!(
                version_integrity(Some(me.clone()), version(), envelope.clone(), Some(mine)),
                own,
                "{prior:?}"
            );
            let theirs =
                metadata_compat_sign(seed.clone(), prior, false, statement(), envelope.clone()).unwrap();
            assert_eq!(
                metadata_integrity(Some(me.clone()), statement(), envelope.clone(), Some(theirs)),
                Integrity::Resealed,
                "{prior:?}"
            );
        }
    }
}
