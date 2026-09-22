//! Drive: the workspace grant, node keys, metadata, version envelopes and
//! content chunks, sealed and opened exactly as `packages/crypto/drive.ts`
//! does it. The chunk arithmetic lives here too, so no app repeats it.

use crate::bytes::{decode, encode, expect_len, random, KEY_BYTES, NONCE_BYTES, TAG_BYTES};
use crate::envelope::{context, open, open_key, open_with_nonce, seal, seal_with_nonce};
use crate::error::{input, CoreError, CoreResult};
use blake2::digest::consts::U32;
use blake2::digest::{Mac, Update, VariableOutput};
use blake2::{Blake2bMac, Blake2bVar};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::Sha256;

const KEY_ENVELOPE_BYTES: usize = NONCE_BYTES + KEY_BYTES + TAG_BYTES; // 72
const VERSION_RECORD_BYTES: usize = KEY_BYTES + 8 + 4;
const VERSION_ENVELOPE_BYTES: usize = NONCE_BYTES + VERSION_RECORD_BYTES + TAG_BYTES; // 84
const METADATA_MAX_BYTES: usize = 4096;
const METADATA_PAD_STEP: usize = 256;
const NAME_MAX_CODE_POINTS: usize = 255;
const MIME_MAX_CHARS: usize = 255;
const MODIFIED_MAX_CHARS: usize = 64;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const THUMBNAIL_MAX_BYTES: u32 = 65_536;
const CONTENT_NONCE_BYTES: usize = 16;
const ENVELOPE_SUITE: u32 = 1;
const LEGACY_CONTENT_SUITE: u32 = 1;
const CONTENT_SUITE: u32 = 2;
const CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const THUMBNAIL_KDF_CONTEXT: &str = "hushthmb";
const THUMBNAIL_KDF_SUBKEY: u64 = 1;

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/// A workspace key sealed to one account, as the server hands it out.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct WorkspaceGrant {
    pub version: u32,
    pub workspace_id: String,
    pub key_version: u64,
    pub workspace_key_version: u64,
    pub wrapping_salt: String,
    pub wrapping_nonce: String,
    pub encrypted_key: String,
}

/// Account key -> workspace key: HKDF-SHA256 over the account key, then XChaCha.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn workspace_open(user_id: String, account_key: Vec<u8>, grant: WorkspaceGrant) -> CoreResult<Vec<u8>> {
    if grant.version != 1 {
        return Err(input("Unsupported workspace grant version."));
    }
    expect_len("accountKey", &account_key, KEY_BYTES)?;
    let salt = decode("wrappingSalt", &grant.wrapping_salt, Some(32))?;
    let nonce = decode("wrappingNonce", &grant.wrapping_nonce, Some(NONCE_BYTES))?;
    let ciphertext = decode("encryptedKey", &grant.encrypted_key, Some(KEY_BYTES + TAG_BYTES))?;
    let mut wrap = [0u8; KEY_BYTES];
    Hkdf::<Sha256>::new(Some(&salt), &account_key)
        .expand(b"hushos/workspace/grant-wrap/v1", &mut wrap)
        .map_err(|_| input("HKDF failed"))?;
    let aad = context(&[
        json!("hushos/workspace/grant"),
        json!(1),
        json!(user_id.to_lowercase()),
        json!(grant.workspace_id.to_lowercase()),
        json!(grant.key_version),
        json!(grant.workspace_key_version),
    ]);
    let key = open_with_nonce(&wrap, &nonce, &ciphertext, &aad)?;
    expect_len("workspace key", &key, KEY_BYTES)
        .map_err(|_| CoreError::Sealed("Invalid workspace key.".into()))?;
    Ok(key)
}

/// The same workspace key under a new account key, for a master-key rotation:
/// a fresh salt and nonce, the key inside unchanged.
///
/// ```no_run
/// # let (old_root, new_root, grant) = (vec![0u8; 32], vec![1u8; 32], todo!());
/// let rewrapped = hushos_core::workspace_grant_rewrap("user-1".into(), old_root, new_root, grant, 2)?;
/// assert_eq!(rewrapped.key_version, 2);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn workspace_grant_rewrap(
    user_id: String,
    old_root: Vec<u8>,
    new_root: Vec<u8>,
    grant: WorkspaceGrant,
    key_version: u64,
) -> CoreResult<WorkspaceGrant> {
    let workspace_key = workspace_open(user_id.clone(), old_root, grant.clone())?;
    expect_len("new account key", &new_root, KEY_BYTES)?;
    let salt = random(32);
    let nonce = random(NONCE_BYTES);
    let mut wrap = [0u8; KEY_BYTES];
    Hkdf::<Sha256>::new(Some(&salt), &new_root)
        .expand(b"hushos/workspace/grant-wrap/v1", &mut wrap)
        .map_err(|_| input("HKDF failed"))?;
    let aad = context(&[
        json!("hushos/workspace/grant"),
        json!(1),
        json!(user_id.to_lowercase()),
        json!(grant.workspace_id.to_lowercase()),
        json!(key_version),
        json!(grant.workspace_key_version),
    ]);
    Ok(WorkspaceGrant {
        version: 1,
        workspace_id: grant.workspace_id,
        key_version,
        workspace_key_version: grant.workspace_key_version,
        wrapping_salt: encode(&salt),
        wrapping_nonce: encode(&nonce),
        encrypted_key: encode(&seal_with_nonce(&wrap, &nonce, &workspace_key, &aad)?),
    })
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/// What binds a node key to its place in the tree.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct NodeKeyContext {
    pub workspace_id: String,
    pub node_id: String,
    pub parent_id: String,
    pub parent_key_epoch: u64,
    pub key_epoch: u64,
}

fn node_key_context(ctx: &NodeKeyContext) -> Vec<u8> {
    context(&[
        json!("hushos/drive/node-key"),
        json!(ENVELOPE_SUITE),
        json!(ctx.workspace_id),
        json!(ctx.node_id),
        json!(ctx.parent_id),
        json!(ctx.parent_key_epoch),
        json!(ctx.key_epoch),
    ])
}

/// Parent key (the workspace key at the root) -> node key.
///
/// ```
/// use hushos_core::{node_open, node_wrap, random_bytes, NodeKeyContext};
/// let parent_key = random_bytes(32)?;
/// let node_key = random_bytes(32)?;
/// let ctx = NodeKeyContext { workspace_id: "ws".into(), node_id: "n1".into(), parent_id: "root".into(), parent_key_epoch: 1, key_epoch: 1 };
/// let envelope = node_wrap(ctx.clone(), parent_key.clone(), node_key.clone())?;
/// assert_eq!(envelope.len(), 72);
/// assert_eq!(node_open(ctx, parent_key, envelope)?, node_key);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn node_open(ctx: NodeKeyContext, parent_key: Vec<u8>, key_envelope: Vec<u8>) -> CoreResult<Vec<u8>> {
    expect_len("parentKey", &parent_key, KEY_BYTES)?;
    expect_len("keyEnvelope", &key_envelope, KEY_ENVELOPE_BYTES)?;
    open_key(&parent_key, &key_envelope, &node_key_context(&ctx), "node key")
}

/// A node key wrapped under its parent's: the 72-byte envelope the server stores.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn node_wrap(ctx: NodeKeyContext, parent_key: Vec<u8>, node_key: Vec<u8>) -> CoreResult<Vec<u8>> {
    expect_len("parentKey", &parent_key, KEY_BYTES)?;
    expect_len("nodeKey", &node_key, KEY_BYTES)?;
    seal(&parent_key, &node_key, &node_key_context(&ctx))
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/// What the server cannot read about a node. `size` and `modified` describe the
/// file as the uploader saw it; the version envelope holds the sealed size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct NodeMetadata {
    pub name: String,
    pub mime: Option<String>,
    pub size: Option<u64>,
    /// ISO 8601, at most 64 characters.
    pub modified: Option<String>,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct MetadataContext {
    pub workspace_id: String,
    pub node_id: String,
    pub metadata_version: u64,
}

fn metadata_context(ctx: &MetadataContext) -> Vec<u8> {
    context(&[
        json!("hushos/drive/node-meta"),
        json!(ENVELOPE_SUITE),
        json!(ctx.workspace_id),
        json!(ctx.node_id),
        json!(ctx.metadata_version),
    ])
}

/// Names are enforced by the client because the server cannot read them:
/// 1 to 255 code points, no slash, no control characters, not `.` or `..`.
/// Returns the name unchanged so it can sit inline in a call.
///
/// ```
/// use hushos_core::check_name;
/// assert!(check_name("Tax 2026.pdf".into()).is_ok());
/// assert!(check_name("a/b".into()).is_err());
/// assert!(check_name("..".into()).is_err());
/// assert!(check_name("x".repeat(256)).is_err());
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn check_name(name: String) -> CoreResult<String> {
    let count = name.chars().count();
    if count == 0 || count > NAME_MAX_CODE_POINTS {
        return Err(input("Use a name of 1 to 255 characters."));
    }
    if name == "." || name == ".." || name.contains('/') {
        return Err(input("A name cannot be . or .. or contain a slash."));
    }
    if name.chars().any(char::is_control) {
        return Err(input("A name cannot contain control characters."));
    }
    Ok(name)
}

/// Metadata JSON padded with trailing spaces to 256-byte steps, so a name's
/// length is hidden. Out-of-range `mime`, `size` and `modified` become `null`
/// rather than errors, as the web does; a bad name is an error.
///
/// ```
/// use hushos_core::{metadata_open, metadata_seal, random_bytes, MetadataContext, NodeMetadata};
/// let key = random_bytes(32)?;
/// let ctx = MetadataContext { workspace_id: "ws".into(), node_id: "n1".into(), metadata_version: 1 };
/// let metadata = NodeMetadata { name: "notes.md".into(), mime: Some("text/markdown".into()), size: Some(12), modified: None };
/// let envelope = metadata_seal(ctx.clone(), key.clone(), metadata.clone())?;
/// assert_eq!(envelope.len(), 24 + 256 + 16, "one padding step");
/// assert_eq!(metadata_open(ctx, key, envelope)?, metadata);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_seal(ctx: MetadataContext, node_key: Vec<u8>, metadata: NodeMetadata) -> CoreResult<Vec<u8>> {
    expect_len("nodeKey", &node_key, KEY_BYTES)?;
    let clean = NodeMetadata {
        name: check_name(metadata.name)?,
        mime: metadata.mime.filter(|mime| mime.chars().count() <= MIME_MAX_CHARS),
        size: metadata.size.filter(|size| *size <= MAX_SAFE_INTEGER),
        modified: metadata.modified.filter(|modified| modified.chars().count() <= MODIFIED_MAX_CHARS),
    };
    let mut plaintext = serde_json::to_vec(&clean).map_err(|_| input("metadata is not encodable"))?;
    if plaintext.len() > METADATA_MAX_BYTES {
        return Err(input("This name is too long."));
    }
    let target = plaintext.len().div_ceil(METADATA_PAD_STEP) * METADATA_PAD_STEP;
    plaintext.resize(target.min(METADATA_MAX_BYTES), b' ');
    seal(&node_key, &plaintext, &metadata_context(&ctx))
}

/// The inverse of [`metadata_seal`]; the version in the context must be the one the envelope was sealed for.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_open(ctx: MetadataContext, node_key: Vec<u8>, envelope: Vec<u8>) -> CoreResult<NodeMetadata> {
    expect_len("nodeKey", &node_key, KEY_BYTES)?;
    if envelope.len() > NONCE_BYTES + METADATA_MAX_BYTES + TAG_BYTES {
        return Err(CoreError::Sealed("This encrypted envelope is damaged.".into()));
    }
    let plaintext = open(&node_key, &envelope, &metadata_context(&ctx))?;
    let text =
        String::from_utf8(plaintext).map_err(|_| CoreError::Sealed("Metadata is not UTF-8.".into()))?;
    serde_json::from_str(text.trim_end()).map_err(|_| CoreError::Sealed("Metadata is not JSON.".into()))
}

// ---------------------------------------------------------------------------
// Workspace documents: the tags registry and the like, sealed under the
// workspace key so a share's recipient, who holds node keys only, learns nothing.
// ---------------------------------------------------------------------------

const DOCUMENT_MAX_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct DocumentContext {
    pub workspace_id: String,
    /// `[a-z][a-z0-9-]{0,31}`, such as `tags`.
    pub kind: String,
    pub version: u64,
}

fn document_context(ctx: &DocumentContext) -> CoreResult<Vec<u8>> {
    let kind = ctx.kind.as_bytes();
    let valid = !kind.is_empty()
        && kind.len() <= 32
        && kind[0].is_ascii_lowercase()
        && kind.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-');
    if !valid {
        return Err(input("Invalid document kind."));
    }
    Ok(context(&[
        json!("hushos/drive/workspace-doc"),
        json!(ENVELOPE_SUITE),
        json!(ctx.workspace_id),
        json!(ctx.kind),
        json!(ctx.version),
    ]))
}

/* Documents pad in coarser steps as they grow, as the web does. */
fn document_pad_step(length: usize) -> usize {
    if length <= 64 * 1024 {
        1024
    } else if length <= 256 * 1024 {
        4 * 1024
    } else {
        16 * 1024
    }
}

/// A workspace document (JSON text) sealed under the workspace key, padded
/// with trailing spaces in 1 KiB, 4 KiB or 16 KiB steps up to 1 MiB.
///
/// ```
/// use hushos_core::{document_open, document_seal, random_bytes, DocumentContext};
/// let key = random_bytes(32)?;
/// let ctx = DocumentContext { workspace_id: "ws".into(), kind: "tags".into(), version: 1 };
/// let envelope = document_seal(ctx.clone(), key.clone(), r#"{"version":2,"tags":[],"items":{}}"#.into())?;
/// assert_eq!(envelope.len(), 24 + 1024 + 16);
/// assert_eq!(document_open(ctx, key, envelope)?, r#"{"version":2,"tags":[],"items":{}}"#);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn document_seal(ctx: DocumentContext, workspace_key: Vec<u8>, json: String) -> CoreResult<Vec<u8>> {
    expect_len("workspaceKey", &workspace_key, KEY_BYTES)?;
    let mut plaintext = json.into_bytes();
    if plaintext.len() > DOCUMENT_MAX_BYTES {
        return Err(input("This document is too large to save."));
    }
    let step = document_pad_step(plaintext.len());
    let target = plaintext.len().div_ceil(step) * step;
    plaintext.resize(target.min(DOCUMENT_MAX_BYTES), b' ');
    seal(&workspace_key, &plaintext, &document_context(&ctx)?)
}

/// The inverse of [`document_seal`]: the JSON text, padding trimmed.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn document_open(ctx: DocumentContext, workspace_key: Vec<u8>, envelope: Vec<u8>) -> CoreResult<String> {
    expect_len("workspaceKey", &workspace_key, KEY_BYTES)?;
    if envelope.len() > NONCE_BYTES + DOCUMENT_MAX_BYTES + TAG_BYTES {
        return Err(CoreError::Sealed("This encrypted document is damaged.".into()));
    }
    let plaintext = open(&workspace_key, &envelope, &document_context(&ctx)?)?;
    let text =
        String::from_utf8(plaintext).map_err(|_| CoreError::Sealed("This document is not UTF-8.".into()))?;
    Ok(text.trim_end().to_string())
}

// ---------------------------------------------------------------------------
// Versions and content
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct VersionContext {
    pub workspace_id: String,
    pub node_id: String,
    pub version_id: String,
    pub object_id: String,
}

fn version_context(ctx: &VersionContext, suite: u32) -> Vec<u8> {
    context(&[
        json!("hushos/drive/content-key"),
        json!(suite),
        json!(ctx.workspace_id),
        json!(ctx.node_id),
        json!(ctx.version_id),
        json!(ctx.object_id),
    ])
}

/// What opens a version's object: its key, its true size and its thumbnail trailer.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ContentKey {
    pub key: Vec<u8>,
    pub plaintext_size: u64,
    pub thumbnail_bytes: u32,
}

/// Node key -> content key. Suite 1 (legacy, read-only) keeps the size on the
/// server row and must be given it; suite 2 seals size and thumbnail length.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_open(
    ctx: VersionContext,
    suite: u32,
    node_key: Vec<u8>,
    envelope: Vec<u8>,
    row_size: Option<u64>,
) -> CoreResult<ContentKey> {
    expect_len("nodeKey", &node_key, KEY_BYTES)?;
    let aad = version_context(&ctx, suite);
    match suite {
        LEGACY_CONTENT_SUITE => {
            expect_len("envelope", &envelope, KEY_ENVELOPE_BYTES)?;
            let key = open_key(&node_key, &envelope, &aad, "content key")?;
            let plaintext_size = row_size.ok_or_else(|| input("This file has no size on record."))?;
            Ok(ContentKey { key, plaintext_size, thumbnail_bytes: 0 })
        }
        CONTENT_SUITE => {
            expect_len("envelope", &envelope, VERSION_ENVELOPE_BYTES)?;
            let record = open(&node_key, &envelope, &aad)?;
            if record.len() != VERSION_RECORD_BYTES {
                return Err(CoreError::Sealed("Invalid version envelope.".into()));
            }
            let plaintext_size =
                u64::from_be_bytes(record[KEY_BYTES..KEY_BYTES + 8].try_into().expect("8 bytes"));
            let thumbnail_bytes = u32::from_be_bytes(record[KEY_BYTES + 8..].try_into().expect("4 bytes"));
            if plaintext_size > MAX_SAFE_INTEGER || thumbnail_bytes > THUMBNAIL_MAX_BYTES {
                return Err(CoreError::Sealed("Invalid version envelope.".into()));
            }
            Ok(ContentKey { key: record[..KEY_BYTES].to_vec(), plaintext_size, thumbnail_bytes })
        }
        other => Err(input(format!("Unsupported content suite {other}."))),
    }
}

/// A sealed version envelope and the object layout it implies.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SealedVersion {
    /// 84 bytes; send as `contentKeyEnvelope` with suite 2.
    pub envelope: Vec<u8>,
    pub layout: ContentLayout,
}

/// Suite 2: the content key, the size and the trailer length under the node key.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_seal(
    ctx: VersionContext,
    node_key: Vec<u8>,
    content_key: Vec<u8>,
    plaintext_size: u64,
    thumbnail_bytes: u32,
) -> CoreResult<SealedVersion> {
    expect_len("nodeKey", &node_key, KEY_BYTES)?;
    expect_len("contentKey", &content_key, KEY_BYTES)?;
    if thumbnail_bytes > THUMBNAIL_MAX_BYTES {
        return Err(input("Invalid thumbnail size."));
    }
    if plaintext_size > MAX_SAFE_INTEGER {
        return Err(input("This file is too large."));
    }
    let mut record = Vec::with_capacity(VERSION_RECORD_BYTES);
    record.extend_from_slice(&content_key);
    record.extend_from_slice(&plaintext_size.to_be_bytes());
    record.extend_from_slice(&thumbnail_bytes.to_be_bytes());
    let envelope = seal(&node_key, &record, &version_context(&ctx, CONTENT_SUITE))?;
    Ok(SealedVersion { envelope, layout: content_layout(plaintext_size, thumbnail_bytes) })
}

/// The opened content of one version sealed again under another node key, in
/// the object's own suite: what a server-side copy needs, since the object
/// and its chunks stay as they are and only the envelope changes hands.
///
/// ```
/// use hushos_core::{random_bytes, version_open, version_reseal, version_seal, ContentKey, VersionContext};
/// let source_key = random_bytes(32)?;
/// let target_key = random_bytes(32)?;
/// let ctx = VersionContext { workspace_id: "ws".into(), node_id: "n1".into(), version_id: "v1".into(), object_id: "obj".into() };
/// let sealed = version_seal(ctx.clone(), source_key.clone(), random_bytes(32)?, 10, 0)?;
/// let opened = version_open(ctx.clone(), 2, source_key, sealed.envelope, None)?;
/// let copy = VersionContext { node_id: "n2".into(), version_id: "v2".into(), ..ctx };
/// let envelope = version_reseal(copy.clone(), 2, target_key.clone(), opened.clone())?;
/// assert_eq!(version_open(copy, 2, target_key, envelope, None)?.key, opened.key);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_reseal(
    ctx: VersionContext,
    suite: u32,
    node_key: Vec<u8>,
    content: ContentKey,
) -> CoreResult<Vec<u8>> {
    expect_len("nodeKey", &node_key, KEY_BYTES)?;
    expect_len("contentKey", &content.key, KEY_BYTES)?;
    match suite {
        LEGACY_CONTENT_SUITE => seal(&node_key, &content.key, &version_context(&ctx, LEGACY_CONTENT_SUITE)),
        CONTENT_SUITE => {
            Ok(version_seal(ctx, node_key, content.key, content.plaintext_size, content.thumbnail_bytes)?
                .envelope)
        }
        other => Err(input(format!("Unsupported content suite {other}."))),
    }
}

/// Where the chunks and the thumbnail trailer sit inside an object.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ContentLayout {
    /// At least one: an empty file is one 16-byte chunk.
    pub chunk_count: u64,
    /// Plaintext bytes per chunk before the last.
    pub chunk_bytes: u64,
    /// The tag every chunk and the trailer end with.
    pub tag_bytes: u64,
    /// The whole object: chunks, tags and the trailer if any.
    pub ciphertext_size: u64,
}

/// The layout of an object for a given file: how many 8 MiB chunks, and how
/// long the whole ciphertext is once every chunk has its tag.
///
/// ```
/// use hushos_core::content_layout;
/// assert_eq!(content_layout(0, 0).chunk_count, 1, "an empty file is one tagged empty chunk");
/// assert_eq!(content_layout(0, 0).ciphertext_size, 16);
/// assert_eq!(content_layout(8 * 1024 * 1024, 0).chunk_count, 1);
/// assert_eq!(content_layout(8 * 1024 * 1024 + 1, 0).chunk_count, 2);
/// assert_eq!(content_layout(100, 2000).ciphertext_size, 100 + 16 + 2000 + 16);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn content_layout(plaintext_size: u64, thumbnail_bytes: u32) -> ContentLayout {
    let chunk_count = plaintext_size.div_ceil(CHUNK_BYTES).max(1);
    let trailer = if thumbnail_bytes > 0 { thumbnail_bytes as u64 + TAG_BYTES as u64 } else { 0 };
    ContentLayout {
        chunk_count,
        chunk_bytes: CHUNK_BYTES,
        tag_bytes: TAG_BYTES as u64,
        ciphertext_size: plaintext_size + TAG_BYTES as u64 * chunk_count + trailer,
    }
}

/// Inclusive byte offsets, as an HTTP range header wants them.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

fn chunk_plaintext_len(plaintext_size: u64, index: u64) -> u64 {
    let start = index.saturating_mul(CHUNK_BYTES);
    if start >= plaintext_size {
        0
    } else {
        CHUNK_BYTES.min(plaintext_size - start)
    }
}

/// How many plaintext bytes chunk `index` carries.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn chunk_length(plaintext_size: u64, index: u64) -> u64 {
    chunk_plaintext_len(plaintext_size, index)
}

/// Where chunk `index` sits in the object: the bytes to ask for with an HTTP
/// range and hand to [`chunk_decrypt`].
///
/// ```
/// use hushos_core::{chunk_range, ByteRange};
/// let chunk = 8 * 1024 * 1024;
/// assert_eq!(chunk_range(chunk + 10, 0), ByteRange { start: 0, end: chunk + 16 - 1 });
/// assert_eq!(chunk_range(chunk + 10, 1), ByteRange { start: chunk + 16, end: chunk + 16 + 10 + 16 - 1 });
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn chunk_range(plaintext_size: u64, index: u64) -> ByteRange {
    let start = index * (CHUNK_BYTES + TAG_BYTES as u64);
    ByteRange { start, end: start + chunk_plaintext_len(plaintext_size, index) + TAG_BYTES as u64 - 1 }
}

/// Where the thumbnail trailer sits in a suite 2 object, after the last chunk's tag.
///
/// ```
/// use hushos_core::{thumbnail_range, ByteRange};
/// assert_eq!(thumbnail_range(100, 2000), ByteRange { start: 116, end: 116 + 2000 + 16 - 1 });
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn thumbnail_range(plaintext_size: u64, thumbnail_bytes: u32) -> ByteRange {
    let layout = content_layout(plaintext_size, 0);
    ByteRange {
        start: layout.ciphertext_size,
        end: layout.ciphertext_size + thumbnail_bytes as u64 + TAG_BYTES as u64 - 1,
    }
}

/// Everything a chunk's seal is bound to. `nonce` is the 16-byte content nonce
/// the version row carries; the chunk index completes it.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct Content {
    pub workspace_id: String,
    pub object_id: String,
    pub suite: u32,
    pub key: Vec<u8>,
    pub nonce: Vec<u8>,
    pub plaintext_size: u64,
    pub thumbnail_bytes: u32,
}

fn chunk_nonce(content: &Content, index: u64) -> CoreResult<[u8; NONCE_BYTES]> {
    expect_len("key", &content.key, KEY_BYTES)?;
    expect_len("nonce", &content.nonce, CONTENT_NONCE_BYTES)?;
    let mut nonce = [0u8; NONCE_BYTES];
    nonce[..CONTENT_NONCE_BYTES].copy_from_slice(&content.nonce);
    nonce[CONTENT_NONCE_BYTES..].copy_from_slice(&index.to_be_bytes());
    Ok(nonce)
}

fn chunk_context(content: &Content, index: u64, chunk_count: u64) -> Vec<u8> {
    context(&[
        json!("hushos/drive/content"),
        json!(content.suite),
        json!(content.workspace_id),
        json!(content.object_id),
        json!(index),
        json!(chunk_count),
        json!(content.plaintext_size),
    ])
}

/// One chunk sealed; `plaintext` must be exactly the chunk's length for its
/// index ([`chunk_length`]). The nonce is the content nonce with the index
/// appended, so the same key and nonce never seal two different chunks.
///
/// ```
/// use hushos_core::{chunk_decrypt, chunk_encrypt, random_bytes, Content};
/// let content = Content {
///     workspace_id: "ws".into(), object_id: "obj".into(), suite: 2,
///     key: random_bytes(32)?, nonce: random_bytes(16)?, plaintext_size: 5, thumbnail_bytes: 0,
/// };
/// let sealed = chunk_encrypt(content.clone(), 0, b"hello".to_vec())?;
/// assert_eq!(sealed.len(), 5 + 16);
/// assert_eq!(chunk_decrypt(content, 0, sealed)?, b"hello");
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn chunk_encrypt(content: Content, index: u64, plaintext: Vec<u8>) -> CoreResult<Vec<u8>> {
    let layout = content_layout(content.plaintext_size, content.thumbnail_bytes);
    if index >= layout.chunk_count {
        return Err(input("chunk index is past the end"));
    }
    if plaintext.len() as u64 != chunk_plaintext_len(content.plaintext_size, index) {
        return Err(input("the chunk does not have the length its index requires"));
    }
    let nonce = chunk_nonce(&content, index)?;
    seal_with_nonce(&content.key, &nonce, &plaintext, &chunk_context(&content, index, layout.chunk_count))
}

/// One chunk opened; `ciphertext` is the bytes of `chunk_range`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn chunk_decrypt(content: Content, index: u64, ciphertext: Vec<u8>) -> CoreResult<Vec<u8>> {
    let layout = content_layout(content.plaintext_size, content.thumbnail_bytes);
    if index >= layout.chunk_count {
        return Err(input("chunk index is past the end"));
    }
    if ciphertext.len() as u64 != chunk_plaintext_len(content.plaintext_size, index) + TAG_BYTES as u64 {
        return Err(CoreError::Sealed("This file could not be decrypted. It may be damaged.".into()));
    }
    let nonce = chunk_nonce(&content, index)?;
    open_with_nonce(&content.key, &nonce, &ciphertext, &chunk_context(&content, index, layout.chunk_count))
        .map_err(|_| CoreError::Sealed("This file could not be decrypted. It may be damaged.".into()))
}

fn thumbnail_key(content: &Content) -> CoreResult<[u8; KEY_BYTES]> {
    if content.suite != CONTENT_SUITE {
        return Err(input("Only content suite 2 carries a thumbnail."));
    }
    derive_subkey(&content.key, THUMBNAIL_KDF_SUBKEY, THUMBNAIL_KDF_CONTEXT)
}

fn thumbnail_context(content: &Content) -> Vec<u8> {
    context(&[
        json!("hushos/drive/thumbnail"),
        json!(CONTENT_SUITE),
        json!(content.workspace_id),
        json!(content.object_id),
        json!(content.thumbnail_bytes),
    ])
}

/// The thumbnail trailer sealed under its own derived key, after the last chunk.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn thumbnail_encrypt(content: Content, thumbnail: Vec<u8>) -> CoreResult<Vec<u8>> {
    if thumbnail.is_empty()
        || thumbnail.len() as u64 != content.thumbnail_bytes as u64
        || content.thumbnail_bytes > THUMBNAIL_MAX_BYTES
    {
        return Err(input("the thumbnail does not have the length the version was sealed with"));
    }
    let layout = content_layout(content.plaintext_size, content.thumbnail_bytes);
    let nonce = chunk_nonce(&content, layout.chunk_count)?;
    seal_with_nonce(&thumbnail_key(&content)?, &nonce, &thumbnail, &thumbnail_context(&content))
}

/// The thumbnail opened; `ciphertext` is the bytes of `thumbnail_range`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn thumbnail_decrypt(content: Content, ciphertext: Vec<u8>) -> CoreResult<Vec<u8>> {
    if content.thumbnail_bytes == 0 {
        return Err(input("This version has no thumbnail."));
    }
    if ciphertext.len() as u64 != content.thumbnail_bytes as u64 + TAG_BYTES as u64 {
        return Err(CoreError::Sealed("This thumbnail could not be decrypted.".into()));
    }
    let layout = content_layout(content.plaintext_size, content.thumbnail_bytes);
    let nonce = chunk_nonce(&content, layout.chunk_count)?;
    open_with_nonce(&thumbnail_key(&content)?, &nonce, &ciphertext, &thumbnail_context(&content))
        .map_err(|_| CoreError::Sealed("This thumbnail could not be decrypted.".into()))
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/// BLAKE2b, unkeyed, as libsodium's `crypto_generichash`; 16 to 64 bytes out.
///
/// ```
/// let digest = hushos_core::hash_blake2b(b"abc".to_vec(), 32).unwrap();
/// assert_eq!(hushos_core::base64url_encode(digest), "vd2BPGNCOXIxce8_7phXm5SWTjuxyz5CcmLIwGjVIxk");
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn hash_blake2b(data: Vec<u8>, out_len: u32) -> CoreResult<Vec<u8>> {
    if !(16..=64).contains(&out_len) {
        return Err(input("outLen must be 16..=64"));
    }
    let mut hasher = Blake2bVar::new(out_len as usize).map_err(|_| input("bad length"))?;
    hasher.update(&data);
    let mut out = vec![0u8; out_len as usize];
    hasher.finalize_variable(&mut out).map_err(|_| input("hash failed"))?;
    Ok(out)
}

fn derive_subkey(master: &[u8], subkey_id: u64, ctx: &str) -> CoreResult<[u8; KEY_BYTES]> {
    expect_len("key", master, KEY_BYTES)?;
    if ctx.len() != 8 {
        return Err(input("kdf context must be 8 bytes"));
    }
    let mut salt = [0u8; 16];
    salt[..8].copy_from_slice(&subkey_id.to_le_bytes());
    let mut personal = [0u8; 16];
    personal[..8].copy_from_slice(ctx.as_bytes());
    let mac = Blake2bMac::<U32>::new_with_salt_and_personal(master, &salt, &personal)
        .map_err(|_| input("kdf failed"))?;
    Ok(mac.finalize().into_bytes().into())
}

/// libsodium's `crypto_kdf_derive_from_key`: BLAKE2b keyed by the master,
/// salt = subkey id, personal = the 8-byte context. The thumbnail key is
/// subkey 1 under `hushthmb`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn kdf_derive(key: Vec<u8>, subkey_id: u64, context: String) -> CoreResult<Vec<u8>> {
    Ok(derive_subkey(&key, subkey_id, &context)?.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::{encode, random};

    fn node_ctx() -> NodeKeyContext {
        NodeKeyContext {
            workspace_id: "ws".into(),
            node_id: "n1".into(),
            parent_id: "root".into(),
            parent_key_epoch: 1,
            key_epoch: 2,
        }
    }

    fn version_ctx() -> VersionContext {
        VersionContext {
            workspace_id: "ws".into(),
            node_id: "n1".into(),
            version_id: "v1".into(),
            object_id: "obj".into(),
        }
    }

    fn content(plaintext_size: u64, thumbnail_bytes: u32) -> Content {
        Content {
            workspace_id: "ws".into(),
            object_id: "obj".into(),
            suite: CONTENT_SUITE,
            key: random(32),
            nonce: random(16),
            plaintext_size,
            thumbnail_bytes,
        }
    }

    #[test]
    fn workspace_open_derives_the_wrapping_key_from_the_account_key_and_the_salt() {
        // Seal a grant as `packages/crypto` does and open it; every context field must match.
        let account_key = random(32);
        let workspace_key = random(32);
        let salt = random(32);
        let mut wrap = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&salt), &account_key)
            .expand(b"hushos/workspace/grant-wrap/v1", &mut wrap)
            .unwrap();
        let aad = br#"["hushos/workspace/grant",1,"user-1","ws-1",2,5]"#;
        let sealed = seal(&wrap, &workspace_key, aad).unwrap();
        let grant = WorkspaceGrant {
            version: 1,
            workspace_id: "WS-1".into(),
            key_version: 2,
            workspace_key_version: 5,
            wrapping_salt: encode(&salt),
            wrapping_nonce: encode(&sealed[..NONCE_BYTES]),
            encrypted_key: encode(&sealed[NONCE_BYTES..]),
        };
        assert_eq!(
            workspace_open("USER-1".into(), account_key.clone(), grant.clone()).unwrap(),
            workspace_key
        );
        let mut other_version = grant.clone();
        other_version.workspace_key_version = 6;
        assert!(matches!(
            workspace_open("user-1".into(), account_key.clone(), other_version),
            Err(CoreError::Sealed(_))
        ));
        assert!(matches!(workspace_open("user-1".into(), random(32), grant), Err(CoreError::Sealed(_))));
    }

    #[test]
    fn a_node_key_only_opens_under_the_parent_and_epochs_it_was_wrapped_for() {
        let parent = random(32);
        let node = random(32);
        let envelope = node_wrap(node_ctx(), parent.clone(), node.clone()).unwrap();
        assert_eq!(node_open(node_ctx(), parent.clone(), envelope.clone()).unwrap(), node);
        let mut moved = node_ctx();
        moved.parent_id = "other".into();
        assert!(matches!(node_open(moved, parent.clone(), envelope.clone()), Err(CoreError::Sealed(_))));
        let mut rotated = node_ctx();
        rotated.key_epoch = 3;
        assert!(matches!(node_open(rotated, parent.clone(), envelope.clone()), Err(CoreError::Sealed(_))));
        assert!(matches!(node_open(node_ctx(), parent, envelope[..71].to_vec()), Err(CoreError::Input(_))));
    }

    #[test]
    fn metadata_is_padded_in_256_byte_steps_and_capped_at_4096() {
        let key = random(32);
        let ctx = MetadataContext { workspace_id: "ws".into(), node_id: "n1".into(), metadata_version: 1 };
        let short = NodeMetadata { name: "a".into(), mime: None, size: None, modified: None };
        assert_eq!(
            metadata_seal(ctx.clone(), key.clone(), short).unwrap().len(),
            NONCE_BYTES + 256 + TAG_BYTES
        );
        let long_name = NodeMetadata { name: "n".repeat(250), mime: None, size: None, modified: None };
        assert_eq!(
            metadata_seal(ctx.clone(), key.clone(), long_name).unwrap().len(),
            NONCE_BYTES + 512 + TAG_BYTES
        );
        // 255 four-byte code points is a legal name that needs five steps and still fits the cap.
        let wide = NodeMetadata { name: "\u{1F600}".repeat(255), mime: None, size: None, modified: None };
        let sealed = metadata_seal(ctx.clone(), key.clone(), wide.clone()).unwrap();
        assert_eq!(sealed.len(), NONCE_BYTES + 1280 + TAG_BYTES);
        assert_eq!(metadata_open(ctx, key, sealed).unwrap(), wide);
    }

    #[test]
    fn metadata_seal_drops_out_of_range_fields_and_binds_the_version() {
        let key = random(32);
        let ctx = MetadataContext { workspace_id: "ws".into(), node_id: "n1".into(), metadata_version: 4 };
        let dirty = NodeMetadata {
            name: "f".into(),
            mime: Some("x".repeat(256)),
            size: Some(1 << 53),
            modified: Some("2".repeat(65)),
        };
        let envelope = metadata_seal(ctx.clone(), key.clone(), dirty).unwrap();
        let opened = metadata_open(ctx.clone(), key.clone(), envelope.clone()).unwrap();
        assert_eq!(opened, NodeMetadata { name: "f".into(), mime: None, size: None, modified: None });
        let mut stale = ctx.clone();
        stale.metadata_version = 3;
        assert!(matches!(metadata_open(stale, key.clone(), envelope), Err(CoreError::Sealed(_))));
        let bad = NodeMetadata { name: "a/b".into(), mime: None, size: None, modified: None };
        assert!(matches!(metadata_seal(ctx, key, bad), Err(CoreError::Input(_))));
    }

    #[test]
    fn documents_pad_in_growing_steps_and_bind_kind_and_version() {
        let key = random(32);
        let ctx = DocumentContext { workspace_id: "ws".into(), kind: "tags".into(), version: 3 };
        let small = document_seal(ctx.clone(), key.clone(), "{}".into()).unwrap();
        assert_eq!(small.len(), NONCE_BYTES + 1024 + TAG_BYTES);
        let medium = document_seal(ctx.clone(), key.clone(), "x".repeat(70 * 1024)).unwrap();
        assert_eq!(medium.len(), NONCE_BYTES + 72 * 1024 + TAG_BYTES, "4 KiB steps past 64 KiB");
        assert_eq!(document_open(ctx.clone(), key.clone(), small.clone()).unwrap(), "{}");
        let mut other_kind = ctx.clone();
        other_kind.kind = "notes".into();
        assert!(matches!(document_open(other_kind, key.clone(), small.clone()), Err(CoreError::Sealed(_))));
        let mut other_version = ctx.clone();
        other_version.version = 4;
        assert!(matches!(document_open(other_version, key.clone(), small), Err(CoreError::Sealed(_))));
        let mut bad_kind = ctx;
        bad_kind.kind = "Tags".into();
        assert!(matches!(document_seal(bad_kind, key.clone(), "{}".into()), Err(CoreError::Input(_))));
        assert!(matches!(
            document_seal(
                DocumentContext { workspace_id: "ws".into(), kind: "tags".into(), version: 1 },
                key,
                "x".repeat(DOCUMENT_MAX_BYTES + 1)
            ),
            Err(CoreError::Input(_))
        ));
    }

    #[test]
    fn a_version_envelope_carries_the_key_the_size_and_the_trailer_length() {
        let node_key = random(32);
        let content_key = random(32);
        let sealed =
            version_seal(version_ctx(), node_key.clone(), content_key.clone(), 20_000_000, 3000).unwrap();
        assert_eq!(sealed.envelope.len(), VERSION_ENVELOPE_BYTES);
        assert_eq!(
            sealed.layout,
            ContentLayout {
                chunk_count: 3,
                chunk_bytes: CHUNK_BYTES,
                tag_bytes: 16,
                ciphertext_size: 20_000_000 + 48 + 3016
            }
        );
        let opened =
            version_open(version_ctx(), CONTENT_SUITE, node_key.clone(), sealed.envelope.clone(), None)
                .unwrap();
        assert_eq!(opened.key, content_key);
        assert_eq!(opened.plaintext_size, 20_000_000);
        assert_eq!(opened.thumbnail_bytes, 3000);
        // Another version id is another context.
        let mut other = version_ctx();
        other.version_id = "v2".into();
        assert!(matches!(
            version_open(other, CONTENT_SUITE, node_key.clone(), sealed.envelope.clone(), None),
            Err(CoreError::Sealed(_))
        ));
        // A suite 2 envelope is 84 bytes, never a suite 1 one.
        assert!(matches!(
            version_open(version_ctx(), LEGACY_CONTENT_SUITE, node_key.clone(), sealed.envelope, Some(1)),
            Err(CoreError::Input(_))
        ));
        assert!(matches!(
            version_seal(version_ctx(), node_key, content_key, 1, THUMBNAIL_MAX_BYTES + 1),
            Err(CoreError::Input(_))
        ));
    }

    #[test]
    fn a_legacy_version_reseals_as_a_72_byte_key_envelope() {
        let node_key = random(32);
        let content = ContentKey { key: random(32), plaintext_size: 77, thumbnail_bytes: 0 };
        let envelope =
            version_reseal(version_ctx(), LEGACY_CONTENT_SUITE, node_key.clone(), content.clone()).unwrap();
        assert_eq!(envelope.len(), KEY_ENVELOPE_BYTES);
        let opened = version_open(version_ctx(), LEGACY_CONTENT_SUITE, node_key, envelope, Some(77)).unwrap();
        assert_eq!(opened.key, content.key);
        assert!(matches!(version_reseal(version_ctx(), 3, random(32), content), Err(CoreError::Input(_))));
    }

    #[test]
    fn a_legacy_version_needs_the_row_size_and_has_no_thumbnail() {
        let node_key = random(32);
        let content_key = random(32);
        let envelope =
            seal(&node_key, &content_key, &version_context(&version_ctx(), LEGACY_CONTENT_SUITE)).unwrap();
        let opened =
            version_open(version_ctx(), LEGACY_CONTENT_SUITE, node_key.clone(), envelope.clone(), Some(77))
                .unwrap();
        assert_eq!((opened.key, opened.plaintext_size, opened.thumbnail_bytes), (content_key, 77, 0));
        assert!(matches!(
            version_open(version_ctx(), LEGACY_CONTENT_SUITE, node_key.clone(), envelope.clone(), None),
            Err(CoreError::Input(_))
        ));
        assert!(matches!(version_open(version_ctx(), 3, node_key, envelope, None), Err(CoreError::Input(_))));
    }

    #[test]
    fn chunks_are_bound_to_their_index_and_count() {
        let content = content(CHUNK_BYTES + 3, 0);
        let first = chunk_encrypt(content.clone(), 0, vec![1u8; CHUNK_BYTES as usize]).unwrap();
        let last = chunk_encrypt(content.clone(), 1, vec![2, 3, 4]).unwrap();
        assert_eq!(last.len(), 3 + TAG_BYTES);
        assert_eq!(chunk_decrypt(content.clone(), 1, last.clone()).unwrap(), vec![2, 3, 4]);
        assert_eq!(chunk_decrypt(content.clone(), 0, first).unwrap().len(), CHUNK_BYTES as usize);
        // A chunk moved to another index, or to a file of another size, does not open.
        assert!(matches!(chunk_decrypt(content.clone(), 0, last.clone()), Err(CoreError::Sealed(_))));
        let mut resized = content.clone();
        resized.plaintext_size = CHUNK_BYTES + 4;
        assert!(matches!(
            chunk_decrypt(resized, 1, [last.as_slice(), &[0]].concat()),
            Err(CoreError::Sealed(_))
        ));
        assert!(
            matches!(chunk_encrypt(content.clone(), 1, vec![2, 3]), Err(CoreError::Input(_))),
            "wrong length for the index"
        );
        assert!(matches!(chunk_encrypt(content, 2, vec![]), Err(CoreError::Input(_))), "past the end");
    }

    #[test]
    fn an_empty_file_is_one_tagged_empty_chunk() {
        let content = content(0, 0);
        let sealed = chunk_encrypt(content.clone(), 0, vec![]).unwrap();
        assert_eq!(sealed.len(), TAG_BYTES);
        assert_eq!(chunk_range(0, 0), ByteRange { start: 0, end: 15 });
        assert_eq!(chunk_decrypt(content, 0, sealed).unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn the_thumbnail_uses_its_own_derived_key_after_the_last_chunk() {
        let content = content(100, 5);
        let sealed = thumbnail_encrypt(content.clone(), vec![9; 5]).unwrap();
        assert_eq!(sealed.len(), 5 + TAG_BYTES);
        assert_eq!(thumbnail_decrypt(content.clone(), sealed.clone()).unwrap(), vec![9; 5]);
        // The trailer under the plain content key must not open: the key is derived.
        let under_content_key = seal_with_nonce(
            &content.key,
            &chunk_nonce(&content, 1).unwrap(),
            &[9; 5],
            &thumbnail_context(&content),
        )
        .unwrap();
        assert!(matches!(thumbnail_decrypt(content.clone(), under_content_key), Err(CoreError::Sealed(_))));
        assert!(matches!(thumbnail_encrypt(content.clone(), vec![9; 4]), Err(CoreError::Input(_))));
        let mut legacy = content.clone();
        legacy.suite = LEGACY_CONTENT_SUITE;
        assert!(matches!(thumbnail_decrypt(legacy, sealed), Err(CoreError::Input(_))));
        let mut none = content;
        none.thumbnail_bytes = 0;
        assert!(matches!(thumbnail_decrypt(none, vec![0; 16]), Err(CoreError::Input(_))));
    }

    #[test]
    fn kdf_derive_matches_libsodium_for_a_known_key() {
        // libsodium: crypto_kdf_derive_from_key(subkey, 32, 1, "hushthmb", <32 zero bytes>)
        let subkey = kdf_derive(vec![0u8; 32], 1, "hushthmb".into()).unwrap();
        assert_eq!(encode(&subkey), "-l7MUgKvo9ofimofniDTg6pZSGuvgTI-HZq_boQsYLI");
        assert!(matches!(kdf_derive(vec![0u8; 32], 1, "short".into()), Err(CoreError::Input(_))));
        assert!(matches!(kdf_derive(vec![0u8; 16], 1, "hushthmb".into()), Err(CoreError::Input(_))));
    }

    #[test]
    fn hash_blake2b_bounds_the_output_length() {
        assert!(hash_blake2b(vec![], 15).is_err());
        assert!(hash_blake2b(vec![], 65).is_err());
        assert_eq!(hash_blake2b(vec![], 64).unwrap().len(), 64);
        assert_ne!(
            hash_blake2b(vec![], 32).unwrap(),
            hash_blake2b(vec![], 64).unwrap()[..32],
            "BLAKE2b mixes the length into the digest"
        );
    }
}
