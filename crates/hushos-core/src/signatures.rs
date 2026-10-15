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
//! What decides whose keys to trust (the keys statement, successions and
//! shares) is signed with the hybrid signature instead: Ed25519 and ML-DSA-65
//! over the same statement, valid only if both halves verify
//! (`docs/identity-pq-design.md`).

use crate::bytes::{decode, encode, expect_len};
use crate::envelope::context;
use crate::error::{input, CoreResult};
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

const METADATA_DOMAIN: &str = "hushos/drive/sig/metadata";
const VERSION_DOMAIN: &str = "hushos/drive/sig/version";
const METADATA_RESEALED_DOMAIN: &str = "hushos/drive/sig/metadata-resealed";
const VERSION_RESEALED_DOMAIN: &str = "hushos/drive/sig/version-resealed";
const METADATA_SAVED_DOMAIN: &str = "hushos/drive/sig/metadata-saved";
const VERSION_SAVED_DOMAIN: &str = "hushos/drive/sig/version-saved";
/* Where a saved copy came from, the saved statements' last element. Only links, in version 1. */
const SAVED_FROM_LINK: &str = "link";

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
        json!(statement.workspace_id.to_lowercase()),
        json!(statement.node_id.to_lowercase()),
        json!(statement.kind.as_str()),
        json!(positive(statement.metadata_version, "metadata version")?),
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
        json!(statement.workspace_id.to_lowercase()),
        json!(statement.node_id.to_lowercase()),
        json!(statement.version_id.to_lowercase()),
        json!(statement.object_id.to_lowercase()),
        json!(positive(statement.content_suite as u64, "content suite")?),
        json!(digest(envelope)),
    ];
    if form == Form::Saved {
        parts.push(json!(SAVED_FROM_LINK));
    }
    Ok(context(&parts))
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
struct Messages {
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
        json!(positive(key_version, "key version")?),
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
    // Minted at old + 1; a reader asks only that it rose (a rotation may lift it in between).
    let old_version = positive(link.old_key_version, "key version")?;
    if link.new_key_version <= old_version {
        return Err(input("Invalid key version."));
    }
    let kem = decode("newKemPublicKey", &link.new_kem_public_key, Some(KEM_PUBLIC_KEY_BYTES))?;
    Ok(context(&[
        json!("hushos/identity/succession"),
        json!(2),
        json!(identifier(&user_id, "user id")?),
        json!(old_version),
        json!(link.new_key_version),
        public_key(&link.old_encryption_public_key, 32, "oldEncryptionPublicKey")?,
        public_key(&link.old_signing_public_key, 32, "oldSigningPublicKey")?,
        public_key(&link.old_ml_dsa_public_key, ML_DSA_PUBLIC_KEY_BYTES, "oldMlDsaPublicKey")?,
        public_key(&link.new_encryption_public_key, 32, "newEncryptionPublicKey")?,
        public_key(&link.new_signing_public_key, 32, "newSigningPublicKey")?,
        public_key(&link.new_ml_dsa_public_key, ML_DSA_PUBLIC_KEY_BYTES, "newMlDsaPublicKey")?,
        json!(digest(&kem)),
    ]))
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
}
