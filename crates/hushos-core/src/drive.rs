//! Drive: the workspace grant, node keys, metadata, version envelopes and
//! content chunks, sealed and opened exactly as `packages/crypto/drive.ts`
//! does it. The chunk arithmetic lives here too, so no app repeats it: content
//! suite 3 pads every object to a Padmé bucket, and only this module knows
//! where the file ends inside one.

use crate::bytes::{
    decode, encode, expect_len, random, Redacted, SecretBytes, KEY_BYTES, NONCE_BYTES, TAG_BYTES,
};
use crate::envelope::{context, open, open_key, open_with_nonce, opening_key, rekey, seal, seal_with_nonce};
use crate::error::{input, CoreError, CoreResult};
use blake2::digest::consts::U32;
use blake2::digest::{Mac, Update, VariableOutput};
use blake2::{Blake2bMac, Blake2bVar};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::Sha256;
use std::collections::{BTreeMap, HashMap};
use std::fmt;
use zeroize::Zeroizing;

pub(crate) const KEY_ENVELOPE_BYTES: usize = NONCE_BYTES + KEY_BYTES + TAG_BYTES; // 72
const VERSION_RECORD_BYTES: usize = KEY_BYTES + 8 + 4;
pub(crate) const VERSION_ENVELOPE_BYTES: usize = NONCE_BYTES + VERSION_RECORD_BYTES + TAG_BYTES; // 84
const METADATA_MAX_BYTES: usize = 4096;
/* The longest metadata envelope: the padded maximum, its nonce and its tag. */
pub(crate) const METADATA_ENVELOPE_MAX_BYTES: usize = NONCE_BYTES + METADATA_MAX_BYTES + TAG_BYTES;
const METADATA_PAD_STEP: usize = 256;
const NAME_MAX_CODE_POINTS: usize = 255;
const MIME_MAX_CHARS: usize = 255;
const MODIFIED_MAX_CHARS: usize = 64;
/* An attribute key is `^[a-z][a-z0-9_-]{0,31}$`, as `ATTRIBUTE_KEY` in drive.ts; at most 32 of them. */
const ATTRIBUTE_KEY_MAX_BYTES: usize = 32;
const ATTRIBUTES_MAX_KEYS: usize = 32;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const THUMBNAIL_MAX_BYTES: u32 = 65_536;
const CONTENT_NONCE_BYTES: usize = 16;
const ENVELOPE_SUITE: u32 = 1;
pub(crate) const LEGACY_CONTENT_SUITE: u32 = 1;
pub(crate) const UNPADDED_CONTENT_SUITE: u32 = 2;
pub(crate) const CONTENT_SUITE: u32 = 3;
const CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const THUMBNAIL_KDF_CONTEXT: &str = "hushthmb";
const THUMBNAIL_KDF_SUBKEY: u64 = 1;

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/// A workspace key sealed to one account, as the server hands it out.
#[derive(Clone)]
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

/* Debug by hand, like every record that carries a key: the sealed key stays out of prints too. */
impl fmt::Debug for WorkspaceGrant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WorkspaceGrant")
            .field("version", &self.version)
            .field("workspace_id", &self.workspace_id)
            .field("key_version", &self.key_version)
            .field("workspace_key_version", &self.workspace_key_version)
            .field("encrypted_key", &Redacted)
            .finish_non_exhaustive()
    }
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
    let mut wrap = Zeroizing::new([0u8; KEY_BYTES]);
    Hkdf::<Sha256>::new(Some(&salt), &account_key)
        .expand(b"hushos/workspace/grant-wrap/v1", wrap.as_mut())
        .map_err(|_| input("HKDF failed"))?;
    let aad = context(&[
        json!("hushos/workspace/grant"),
        json!(1),
        json!(user_id.to_lowercase()),
        json!(grant.workspace_id.to_lowercase()),
        json!(grant.key_version),
        json!(grant.workspace_key_version),
    ]);
    let key = open_with_nonce(wrap.as_slice(), &nonce, &ciphertext, &aad)?;
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
    let workspace_key = Zeroizing::new(workspace_open(user_id.clone(), old_root, grant.clone())?);
    expect_len("new account key", &new_root, KEY_BYTES)?;
    let salt = random(32);
    let nonce = random(NONCE_BYTES);
    let mut wrap = Zeroizing::new([0u8; KEY_BYTES]);
    Hkdf::<Sha256>::new(Some(&salt), &new_root)
        .expand(b"hushos/workspace/grant-wrap/v1", wrap.as_mut())
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
        encrypted_key: encode(&seal_with_nonce(wrap.as_slice(), &nonce, &workspace_key, &aad)?),
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
/// let ctx = NodeKeyContext { workspace_id: "11111111-1111-4111-8111-111111111111".into(), node_id: "22222222-2222-4222-8222-222222222222".into(), parent_id: "77777777-7777-4777-8777-777777777777".into(), parent_key_epoch: 1, key_epoch: 1 };
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

/*
 * A node key's associated data as the web's `nodeKeyContext` builds it, ids
 * and epochs checked the same way (lowercase UUIDs, 1 to 2^53 - 1), under
 * `label`. `node_open` and `node_wrap` keep their unchecked context (the
 * shipped apps call them); the area ledger and the previous-root envelope
 * use this one, so they refuse exactly what the web refuses.
 */
pub(crate) fn node_key_context_checked(ctx: &NodeKeyContext, label: &str) -> CoreResult<Vec<u8>> {
    Ok(context(&[
        json!(label),
        json!(ENVELOPE_SUITE),
        json!(context_id(&ctx.workspace_id, "workspace id")?),
        json!(context_id(&ctx.node_id, "node id")?),
        json!(context_id(&ctx.parent_id, "parent id")?),
        json!(context_epoch(ctx.parent_key_epoch, "parent key epoch")?),
        json!(context_epoch(ctx.key_epoch, "key epoch")?),
    ]))
}

pub(crate) const NODE_KEY_LABEL: &str = "hushos/drive/node-key";
const PREVIOUS_ROOT_KEY_LABEL: &str = "hushos/drive/previous-root-key";

/* A node key under its parent's, the context checked as the web checks it. */
pub(crate) fn node_wrap_checked(
    ctx: &NodeKeyContext,
    parent_key: &[u8],
    node_key: &[u8],
) -> CoreResult<Vec<u8>> {
    let aad = node_key_context_checked(ctx, NODE_KEY_LABEL)?;
    expect_len("parentKey", parent_key, KEY_BYTES)?;
    expect_len("nodeKey", node_key, KEY_BYTES)?;
    seal(parent_key, node_key, &aad)
}

/* A node key out of its envelope, the context checked as the web checks it. */
pub(crate) fn node_open_checked(
    ctx: &NodeKeyContext,
    parent_key: &[u8],
    envelope: &[u8],
) -> CoreResult<Vec<u8>> {
    let aad = node_key_context_checked(ctx, NODE_KEY_LABEL)?;
    expect_len("keyEnvelope", envelope, KEY_ENVELOPE_BYTES)?;
    open_key(parent_key, envelope, &aad, "node key")
}

/// A group area root's previous key wrapped under the new area key by a
/// roster rotation (option A, docs/groups-server.md 8): the node key
/// envelope's fields under the label `hushos/drive/previous-root-key`, so it
/// opens only as a previous root key, never as a node key. Twin of the web's
/// `wrapPreviousRootKey`; only a root (parent = workspace) has one.
///
/// ```
/// use hushos_core::{previous_root_key_open, previous_root_key_wrap, random_bytes, NodeKeyContext};
/// let ws = "11111111-1111-4111-8111-111111111111".to_string();
/// let ctx = NodeKeyContext { workspace_id: ws.clone(), node_id: "22222222-2222-4222-8222-222222222222".into(), parent_id: ws, parent_key_epoch: 2, key_epoch: 1 };
/// let (root_key, area_key) = (random_bytes(32)?, random_bytes(32)?);
/// let envelope = previous_root_key_wrap(ctx.clone(), area_key.clone(), root_key.clone())?;
/// assert_eq!(previous_root_key_open(ctx, area_key, envelope)?, root_key);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn previous_root_key_wrap(
    ctx: NodeKeyContext,
    area_key: Vec<u8>,
    root_key: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    expect_len("rootKey", &root_key, KEY_BYTES).map_err(|_| input("Invalid node key."))?;
    if ctx.parent_id != ctx.workspace_id {
        return Err(input("Invalid node key."));
    }
    let aad = node_key_context_checked(&ctx, PREVIOUS_ROOT_KEY_LABEL)?;
    expect_len("areaKey", &area_key, KEY_BYTES)?;
    seal(&area_key, &root_key, &aad)
}

/// A group area root's previous key out of its option A envelope; see [`previous_root_key_wrap`].
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn previous_root_key_open(
    ctx: NodeKeyContext,
    area_key: Vec<u8>,
    envelope: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    let aad = node_key_context_checked(&ctx, PREVIOUS_ROOT_KEY_LABEL)?;
    expect_len("keyEnvelope", &envelope, KEY_ENVELOPE_BYTES)?;
    open_key(&area_key, &envelope, &aad, "node key")
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/// What the server cannot read about a node. `size` and `modified` describe the
/// file as the uploader saw it; the version envelope holds the sealed size.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct NodeMetadata {
    pub name: String,
    pub mime: Option<String>,
    pub size: Option<u64>,
    /// ISO 8601, at most 64 characters.
    pub modified: Option<String>,
    /// Plain data a feature keeps on the node (a folder's colour): keys match
    /// `^[a-z][a-z0-9_-]{0,31}$`, at most 32 of them, values are strings, and
    /// the whole record stays within 4096 bytes. Anything that seals a record
    /// again carries every key through, the ones it does not know included:
    /// build the new record from the opened one. Empty is none, and is written
    /// as no field at all, so a record without attributes seals as it did
    /// before them; keys are written sorted. A record that breaks a limit is
    /// refused, sealing and opening, never trimmed.
    #[serde(
        default,
        skip_serializing_if = "HashMap::is_empty",
        serialize_with = "sorted_attributes",
        deserialize_with = "unique_attributes"
    )]
    pub attributes: HashMap<String, String>,
}

/* Sorted, as the web writes them: the same record is the same plaintext in both twins. */
fn sorted_attributes<S: serde::Serializer>(
    attributes: &HashMap<String, String>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_map(attributes.iter().collect::<BTreeMap<_, _>>())
}

/* Read refusing a key named twice: serde_json's map would keep the last, and the web refuses it too. */
fn unique_attributes<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<HashMap<String, String>, D::Error> {
    struct Unique;
    impl<'de> serde::de::Visitor<'de> for Unique {
        type Value = HashMap<String, String>;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("an object of strings")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut out = HashMap::new();
            while let Some((key, value)) = map.next_entry::<String, String>()? {
                if out.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom("an attribute is named twice"));
                }
            }
            Ok(out)
        }
    }
    deserializer.deserialize_map(Unique)
}

/*
 * Whether JSON text names one key twice in any object, escapes decoded, as
 * `hasDuplicateKey` in drive.ts reads it. Only called on text that is JSON
 * (an unterminated string ends the scan as no duplicate; serde refuses it).
 */
fn has_duplicate_key(text: &str) -> bool {
    let bytes = text.as_bytes();
    // One entry per open object (its keys so far) or array (None).
    let mut open: Vec<Option<std::collections::HashSet<String>>> = Vec::new();
    let mut key_next = false;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                let mut end = i + 1;
                while end < bytes.len() && bytes[end] != b'"' {
                    end += if bytes[end] == b'\\' { 2 } else { 1 };
                }
                if end >= bytes.len() {
                    return false;
                }
                if key_next {
                    if let Some(Some(keys)) = open.last_mut() {
                        let Ok(key) = serde_json::from_str::<String>(&text[i..=end]) else { return false };
                        if !keys.insert(key) {
                            return true;
                        }
                        key_next = false;
                    }
                }
                i = end;
            }
            b'{' => {
                open.push(Some(Default::default()));
                key_next = true;
            }
            b'[' => {
                open.push(None);
                key_next = false;
            }
            b'}' | b']' => {
                open.pop();
                key_next = false;
            }
            b',' => key_next = matches!(open.last(), Some(Some(_))),
            _ => {}
        }
        i += 1;
    }
    false
}

/* The name is exactly what the server must not learn, so it is kept out of prints and logs as well; attribute values with it. */
impl fmt::Debug for NodeMetadata {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut keys: Vec<&String> = self.attributes.keys().collect();
        keys.sort();
        f.debug_struct("NodeMetadata")
            .field("name", &Redacted)
            .field("mime", &self.mime)
            .field("size", &self.size)
            .field("modified", &self.modified)
            .field("attributes", &keys)
            .finish()
    }
}

/* Why a node's attributes are refused, or `None`: the limits `NodeMetadata::attributes` states. */
fn attributes_refusal(attributes: &HashMap<String, String>) -> Option<&'static str> {
    if attributes.len() > ATTRIBUTES_MAX_KEYS {
        return Some("An item can have at most 32 attributes.");
    }
    let valid = |key: &str| {
        let bytes = key.as_bytes();
        !bytes.is_empty()
            && bytes.len() <= ATTRIBUTE_KEY_MAX_BYTES
            && bytes[0].is_ascii_lowercase()
            && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_' || *b == b'-')
    };
    if !attributes.keys().all(|key| valid(key)) {
        return Some("Invalid attribute name.");
    }
    None
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct MetadataContext {
    pub workspace_id: String,
    pub node_id: String,
    pub metadata_version: u64,
}

/* An id as the web's envelope contexts take it: a lowercase UUID, or refused, as `drive.ts` refuses it. */
fn context_id<'a>(value: &'a str, what: &str) -> CoreResult<&'a str> {
    crate::canonical::uuid(value, what).map_err(|_| input(format!("Invalid {what}.")))
}

/* An epoch or version as the web's envelope contexts take it: 1 to 2^53 - 1. */
fn context_epoch(value: u64, what: &str) -> CoreResult<u64> {
    if !(1..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(input(format!("Invalid {what}.")));
    }
    Ok(value)
}

pub(crate) fn metadata_context(ctx: &MetadataContext) -> CoreResult<Vec<u8>> {
    Ok(context(&[
        json!("hushos/drive/node-meta"),
        json!(ENVELOPE_SUITE),
        json!(context_id(&ctx.workspace_id, "workspace id")?),
        json!(context_id(&ctx.node_id, "node id")?),
        json!(context_epoch(ctx.metadata_version, "metadata version")?),
    ]))
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
/// let ctx = MetadataContext { workspace_id: "11111111-1111-4111-8111-111111111111".into(), node_id: "22222222-2222-4222-8222-222222222222".into(), metadata_version: 1 };
/// let metadata = NodeMetadata { name: "notes.md".into(), mime: Some("text/markdown".into()), size: Some(12), modified: None, attributes: Default::default() };
/// let envelope = metadata_seal(ctx.clone(), key.clone(), metadata.clone())?;
/// assert_eq!(envelope.len(), 24 + 256 + 16, "one padding step");
/// assert_eq!(metadata_open(ctx, key, envelope)?, metadata);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_seal(ctx: MetadataContext, node_key: Vec<u8>, metadata: NodeMetadata) -> CoreResult<Vec<u8>> {
    expect_len("nodeKey", &node_key, KEY_BYTES)?;
    if let Some(refusal) = attributes_refusal(&metadata.attributes) {
        return Err(input(refusal));
    }
    let clean = NodeMetadata {
        name: check_name(metadata.name)?,
        mime: metadata.mime.filter(|mime| mime.chars().count() <= MIME_MAX_CHARS),
        size: metadata.size.filter(|size| *size <= MAX_SAFE_INTEGER),
        modified: metadata.modified.filter(|modified| modified.chars().count() <= MODIFIED_MAX_CHARS),
        attributes: metadata.attributes,
    };
    let mut plaintext = serde_json::to_vec(&clean).map_err(|_| input("metadata is not encodable"))?;
    if plaintext.len() > METADATA_MAX_BYTES {
        return Err(input(if clean.attributes.is_empty() {
            "This name is too long."
        } else {
            "This name and its attributes are too long to save."
        }));
    }
    let target = plaintext.len().div_ceil(METADATA_PAD_STEP) * METADATA_PAD_STEP;
    plaintext.resize(target.min(METADATA_MAX_BYTES), b' ');
    seal(&node_key, &plaintext, &metadata_context(&ctx)?)
}

/// The inverse of [`metadata_seal`]; the version in the context must be the one the envelope was sealed for.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_open(ctx: MetadataContext, node_key: Vec<u8>, envelope: Vec<u8>) -> CoreResult<NodeMetadata> {
    expect_len("nodeKey", &node_key, KEY_BYTES)?;
    if envelope.len() > NONCE_BYTES + METADATA_MAX_BYTES + TAG_BYTES {
        return Err(CoreError::Sealed("This encrypted envelope is damaged.".into()));
    }
    let plaintext = open(&node_key, &envelope, &metadata_context(&ctx)?)?;
    let text =
        String::from_utf8(plaintext).map_err(|_| CoreError::Sealed("Metadata is not UTF-8.".into()))?;
    let metadata: NodeMetadata = serde_json::from_str(text.trim_end())
        .map_err(|_| CoreError::Sealed("Metadata is not JSON.".into()))?;
    // Any key named twice, an unknown one included: the web refuses the same text.
    if has_duplicate_key(text.trim_end()) {
        return Err(CoreError::Sealed("This item could not be opened. It may be damaged.".into()));
    }
    // Refused whole, never trimmed: a re-save would otherwise drop what it could not read.
    if attributes_refusal(&metadata.attributes).is_some() {
        return Err(CoreError::Sealed("This item could not be opened. It may be damaged.".into()));
    }
    Ok(metadata)
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
/// let ctx = DocumentContext { workspace_id: "11111111-1111-4111-8111-111111111111".into(), kind: "tags".into(), version: 1 };
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

pub(crate) fn version_context(ctx: &VersionContext, suite: u32) -> CoreResult<Vec<u8>> {
    Ok(context(&[
        json!("hushos/drive/content-key"),
        json!(check_suite(suite)?),
        json!(context_id(&ctx.workspace_id, "workspace id")?),
        json!(context_id(&ctx.node_id, "node id")?),
        json!(context_id(&ctx.version_id, "version id")?),
        json!(context_id(&ctx.object_id, "object id")?),
    ]))
}

/// What opens a version's object: its key, its true size and its thumbnail trailer.
#[derive(Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ContentKey {
    pub key: SecretBytes,
    pub plaintext_size: u64,
    pub thumbnail_bytes: u32,
}

impl fmt::Debug for ContentKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ContentKey")
            .field("key", &Redacted)
            .field("plaintext_size", &self.plaintext_size)
            .field("thumbnail_bytes", &self.thumbnail_bytes)
            .finish()
    }
}

/// Node key -> content key. Suite 1 (legacy, read-only) keeps the size on the
/// server row and must be given it; suites 2 and 3 seal the size and the
/// thumbnail length, each under its own suite number.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_open(
    ctx: VersionContext,
    suite: u32,
    node_key: Vec<u8>,
    envelope: Vec<u8>,
    row_size: Option<u64>,
) -> CoreResult<ContentKey> {
    expect_len("nodeKey", &node_key, KEY_BYTES)?;
    let aad = version_context(&ctx, suite)?;
    match suite {
        LEGACY_CONTENT_SUITE => {
            expect_len("envelope", &envelope, KEY_ENVELOPE_BYTES)?;
            let key = open_key(&node_key, &envelope, &aad, "content key")?;
            let plaintext_size = row_size.ok_or_else(|| input("This file has no size on record."))?;
            Ok(ContentKey { key: key.into(), plaintext_size, thumbnail_bytes: 0 })
        }
        UNPADDED_CONTENT_SUITE | CONTENT_SUITE => {
            expect_len("envelope", &envelope, VERSION_ENVELOPE_BYTES)?;
            let record = Zeroizing::new(open(&node_key, &envelope, &aad)?);
            if record.len() != VERSION_RECORD_BYTES {
                return Err(CoreError::Sealed("Invalid version envelope.".into()));
            }
            let plaintext_size =
                u64::from_be_bytes(record[KEY_BYTES..KEY_BYTES + 8].try_into().expect("8 bytes"));
            let thumbnail_bytes = u32::from_be_bytes(record[KEY_BYTES + 8..].try_into().expect("4 bytes"));
            if plaintext_size > MAX_SAFE_INTEGER || thumbnail_bytes > THUMBNAIL_MAX_BYTES {
                return Err(CoreError::Sealed("Invalid version envelope.".into()));
            }
            Ok(ContentKey { key: record[..KEY_BYTES].to_vec().into(), plaintext_size, thumbnail_bytes })
        }
        other => Err(input(format!("Unsupported content suite {other}."))),
    }
}

/// A sealed version envelope and the object layout it implies.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SealedVersion {
    /// 84 bytes; send as `contentKeyEnvelope` with `contentSuite` [`content_suite`] (3).
    pub envelope: Vec<u8>,
    /// Suite 3's layout: what to declare as `chunkCount` and `ciphertextSize`.
    pub layout: ContentLayout,
}

/// The content suite this core writes, for `contentSuite` on an upload; suites 1 and 2 are read only.
///
/// ```
/// assert_eq!(hushos_core::content_suite(), 3);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn content_suite() -> u32 {
    CONTENT_SUITE
}

/// Suite 3, the one written: the content key, the size and the trailer length under the node key.
///
/// ```
/// use hushos_core::{random_bytes, version_open, version_seal, VersionContext};
/// let node_key = random_bytes(32)?;
/// let ctx = VersionContext { workspace_id: "11111111-1111-4111-8111-111111111111".into(), node_id: "22222222-2222-4222-8222-222222222222".into(), version_id: "44444444-4444-4444-8444-444444444444".into(), object_id: "66666666-6666-4666-8666-666666666666".into() };
/// let sealed = version_seal(ctx.clone(), node_key.clone(), random_bytes(32)?, 1000, 0)?;
/// assert_eq!(sealed.envelope.len(), 84);
/// assert_eq!(sealed.layout.ciphertext_size, 1024 + 16, "1000 bytes pad to the 1024 bucket");
/// assert_eq!(version_open(ctx.clone(), 3, node_key.clone(), sealed.envelope.clone(), None)?.plaintext_size, 1000);
/// assert!(version_open(ctx, 2, node_key, sealed.envelope, None).is_err(), "the suite is bound");
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
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
    let envelope =
        seal_record(&ctx, CONTENT_SUITE, &node_key, &content_key, plaintext_size, thumbnail_bytes)?;
    Ok(SealedVersion { envelope, layout: content_layout(CONTENT_SUITE, plaintext_size, thumbnail_bytes)? })
}

fn seal_record(
    ctx: &VersionContext,
    suite: u32,
    node_key: &[u8],
    content_key: &[u8],
    plaintext_size: u64,
    thumbnail_bytes: u32,
) -> CoreResult<Vec<u8>> {
    let mut record = Zeroizing::new(Vec::with_capacity(VERSION_RECORD_BYTES));
    record.extend_from_slice(content_key);
    record.extend_from_slice(&plaintext_size.to_be_bytes());
    record.extend_from_slice(&thumbnail_bytes.to_be_bytes());
    seal(node_key, &record, &version_context(ctx, suite)?)
}

/// The opened content of one version sealed again under another node key, in
/// the object's own suite: what a server-side copy needs, since the object
/// and its chunks stay as they are and only the envelope changes hands.
///
/// ```
/// use hushos_core::{random_bytes, version_open, version_reseal, version_seal, ContentKey, VersionContext};
/// let source_key = random_bytes(32)?;
/// let target_key = random_bytes(32)?;
/// let ctx = VersionContext { workspace_id: "11111111-1111-4111-8111-111111111111".into(), node_id: "22222222-2222-4222-8222-222222222222".into(), version_id: "44444444-4444-4444-8444-444444444444".into(), object_id: "66666666-6666-4666-8666-666666666666".into() };
/// let sealed = version_seal(ctx.clone(), source_key.clone(), random_bytes(32)?, 10, 0)?;
/// let opened = version_open(ctx.clone(), 3, source_key, sealed.envelope, None)?;
/// let copy = VersionContext { node_id: "33333333-3333-4333-8333-333333333333".into(), version_id: "55555555-5555-4555-8555-555555555555".into(), ..ctx };
/// let envelope = version_reseal(copy.clone(), 3, target_key.clone(), opened.clone())?;
/// assert_eq!(version_open(copy, 3, target_key, envelope, None)?.key, opened.key);
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
        LEGACY_CONTENT_SUITE => seal(&node_key, &content.key, &version_context(&ctx, LEGACY_CONTENT_SUITE)?),
        UNPADDED_CONTENT_SUITE | CONTENT_SUITE => {
            if content.thumbnail_bytes > THUMBNAIL_MAX_BYTES || content.plaintext_size > MAX_SAFE_INTEGER {
                return Err(input("Invalid version record."));
            }
            seal_record(&ctx, suite, &node_key, &content.key, content.plaintext_size, content.thumbnail_bytes)
        }
        other => Err(input(format!("Unsupported content suite {other}."))),
    }
}

/// Where the chunks and the thumbnail trailer sit inside an object.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ContentLayout {
    /// At least one: an empty file is one 16-byte chunk. Under suite 3 it counts
    /// the padding's chunks too: every one of them is fetched on a full read.
    pub chunk_count: u64,
    /// Plaintext bytes per chunk before the last.
    pub chunk_bytes: u64,
    /// The tag every chunk and the trailer end with.
    pub tag_bytes: u64,
    /// The whole object: chunks, tags and the trailer if any.
    pub ciphertext_size: u64,
    /// What the chunks cover: the file and, under suite 3, the zeros after it.
    pub content_length: u64,
}

fn check_suite(suite: u32) -> CoreResult<u32> {
    match suite {
        LEGACY_CONTENT_SUITE | UNPADDED_CONTENT_SUITE | CONTENT_SUITE => Ok(suite),
        other => Err(input(format!("Unsupported content suite {other}."))),
    }
}

fn trailer_len(thumbnail_bytes: u32) -> CoreResult<u64> {
    if thumbnail_bytes > THUMBNAIL_MAX_BYTES {
        return Err(input("Invalid thumbnail size."));
    }
    Ok(if thumbnail_bytes > 0 { thumbnail_bytes as u64 + TAG_BYTES as u64 } else { 0 })
}

/// Padmé: `length` rounded up so that only its top bits survive, about
/// log2(log2(length)) of them; everything up to 256 bytes is one bucket. What
/// the server learns of a suite 3 object is this number: the padding is under
/// 6.25% of the length up to 64 KiB, 3.125% up to 4 GiB, 1.5625% beyond.
///
/// ```
/// use hushos_core::padded_length;
/// assert_eq!(padded_length(0)?, 256);
/// assert_eq!(padded_length(257)?, 272);
/// assert_eq!(padded_length(1000)?, 1024);
/// assert_eq!(padded_length((1 << 20) + 1)?, 1_081_344);
/// assert_eq!(padded_length(10_000_000_000)?, 10_066_329_600);
/// assert_eq!(padded_length(padded_length(123_456)?)?, padded_length(123_456)?, "idempotent");
/// assert!(padded_length(1 << 53).is_err(), "past what the web can count");
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn padded_length(length: u64) -> CoreResult<u64> {
    if length > MAX_SAFE_INTEGER {
        return Err(input("This file is too large."));
    }
    if length <= 256 {
        return Ok(256);
    }
    let e = 63 - length.leading_zeros() as u64; // floor(log2 L) >= 8
    let s = 64 - e.leading_zeros() as u64; // floor(log2 E) + 1
    let mask = (1u64 << (e - s)) - 1;
    let out = (length + mask) & !mask;
    if out > MAX_SAFE_INTEGER {
        return Err(input("This file is too large."));
    }
    Ok(out)
}

fn content_length(suite: u32, plaintext_size: u64, thumbnail_bytes: u32) -> CoreResult<u64> {
    if plaintext_size > MAX_SAFE_INTEGER {
        return Err(input("This file is too large."));
    }
    let trailer = trailer_len(thumbnail_bytes)?;
    if check_suite(suite)? < CONTENT_SUITE {
        return Ok(plaintext_size);
    }
    Ok(padded_length(plaintext_size + trailer)? - trailer)
}

/// The layout of an object in the given content suite: how many 8 MiB chunks,
/// how much they cover and how long the whole ciphertext is once every chunk
/// has its tag. Under suite 3 the chunks run on past the file in zeros so that
/// the chunks and the trailer together come to a Padmé bucket; under suites 1
/// and 2 they cover the file alone.
///
/// ```
/// use hushos_core::content_layout;
/// assert_eq!(content_layout(3, 0, 0)?.chunk_count, 1, "an empty file is one tagged chunk");
/// assert_eq!(content_layout(3, 0, 0)?.ciphertext_size, 256 + 16, "padded to the smallest bucket");
/// assert_eq!(content_layout(2, 0, 0)?.ciphertext_size, 16);
/// assert_eq!(content_layout(2, 8 * 1024 * 1024 + 1, 0)?.chunk_count, 2);
/// assert_eq!(content_layout(2, 100, 2000)?.ciphertext_size, 100 + 16 + 2000 + 16);
/// // With or without a thumbnail, the server sees a bucket.
/// let a = content_layout(3, 8500, 0)?;
/// let b = content_layout(3, 8000, 300)?;
/// assert_eq!(a.ciphertext_size, b.ciphertext_size);
/// assert!(content_layout(4, 1, 0).is_err());
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn content_layout(suite: u32, plaintext_size: u64, thumbnail_bytes: u32) -> CoreResult<ContentLayout> {
    let content_length = content_length(suite, plaintext_size, thumbnail_bytes)?;
    let chunk_count = content_length.div_ceil(CHUNK_BYTES).max(1);
    Ok(ContentLayout {
        chunk_count,
        chunk_bytes: CHUNK_BYTES,
        tag_bytes: TAG_BYTES as u64,
        ciphertext_size: content_length + TAG_BYTES as u64 * chunk_count + trailer_len(thumbnail_bytes)?,
        content_length,
    })
}

/// Inclusive byte offsets, as an HTTP range header wants them.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

fn chunk_plaintext_len(length: u64, index: u64) -> u64 {
    let start = index.saturating_mul(CHUNK_BYTES);
    if start >= length {
        0
    } else {
        CHUNK_BYTES.min(length - start)
    }
}

/// How many bytes of the file chunk `index` carries: what to read from the
/// file for [`chunk_encrypt`], and what [`chunk_decrypt`] gives back. Under
/// suite 3 a chunk may carry fewer (the rest is padding), or none at all.
///
/// ```
/// use hushos_core::chunk_length;
/// let chunk = 8 * 1024 * 1024;
/// assert_eq!(chunk_length(chunk + 10, 0), chunk);
/// assert_eq!(chunk_length(chunk + 10, 1), 10);
/// assert_eq!(chunk_length(chunk, 1), 0, "a chunk of padding alone holds none of the file");
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn chunk_length(plaintext_size: u64, index: u64) -> u64 {
    chunk_plaintext_len(plaintext_size, index)
}

/// The bytes to fetch for chunk `index`, to hand to [`chunk_decrypt`]. The
/// last chunk runs on to the end of the object, padding and thumbnail trailer
/// and all: a range that stopped where the trailer or the padding begins would
/// hand the store where the file ends.
///
/// ```
/// use hushos_core::{chunk_range, ByteRange};
/// let chunk = 8 * 1024 * 1024;
/// assert_eq!(chunk_range(2, chunk + 10, 0, 0)?, ByteRange { start: 0, end: chunk + 16 - 1 });
/// assert_eq!(chunk_range(2, chunk + 10, 0, 1)?, ByteRange { start: chunk + 16, end: chunk + 16 + 10 + 16 - 1 });
/// // With a 2000-byte thumbnail the last chunk's range ends where the object does.
/// assert_eq!(chunk_range(2, chunk + 10, 2000, 1)?.end, chunk + 16 + 10 + 16 + 2000 + 16 - 1);
/// // Suite 3: the last range runs through the padding to the object's end.
/// let layout = hushos_core::content_layout(3, chunk + 10, 2000)?;
/// assert_eq!(chunk_range(3, chunk + 10, 2000, 1)?.end, layout.ciphertext_size - 1);
/// assert!(chunk_range(3, chunk + 10, 2000, 2).is_err());
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn chunk_range(
    suite: u32,
    plaintext_size: u64,
    thumbnail_bytes: u32,
    index: u64,
) -> CoreResult<ByteRange> {
    let layout = content_layout(suite, plaintext_size, thumbnail_bytes)?;
    if index >= layout.chunk_count {
        return Err(input("chunk index is past the end"));
    }
    let start = index * (CHUNK_BYTES + TAG_BYTES as u64);
    if index + 1 == layout.chunk_count {
        return Ok(ByteRange { start, end: layout.ciphertext_size - 1 });
    }
    Ok(ByteRange { start, end: start + CHUNK_BYTES + TAG_BYTES as u64 - 1 })
}

/// The bytes to fetch for a thumbnail: always the object's last 64 KiB and a
/// tag (or all of it, when smaller), whatever the trailer's length. Asking for
/// the trailer's own range would hand the store its length and with it the
/// file's exact size; `thumbnail_decrypt` takes the trailer from the end.
///
/// ```
/// use hushos_core::{thumbnail_range, ByteRange};
/// // Suite 2, 100 bytes of content and a 2000-byte thumbnail: 2132 bytes, all of it fetched.
/// assert_eq!(thumbnail_range(2, 100, 2000)?, ByteRange { start: 0, end: 116 + 2000 + 16 - 1 });
/// // Ten MB of content: the same window length for any thumbnail size.
/// let a = thumbnail_range(3, 10_000_000, 2000)?;
/// let b = thumbnail_range(3, 10_000_000, 60_000)?;
/// assert_eq!(a.end - a.start, b.end - b.start);
/// assert!(thumbnail_range(3, 100, 0).is_err());
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn thumbnail_range(suite: u32, plaintext_size: u64, thumbnail_bytes: u32) -> CoreResult<ByteRange> {
    if thumbnail_bytes == 0 {
        return Err(input("This version has no thumbnail."));
    }
    let total = content_layout(suite, plaintext_size, thumbnail_bytes)?.ciphertext_size;
    let window = THUMBNAIL_MAX_BYTES as u64 + TAG_BYTES as u64;
    Ok(ByteRange { start: total.saturating_sub(window), end: total - 1 })
}

/// Everything a chunk's seal is bound to. `nonce` is the 16-byte content nonce
/// the version row carries; the chunk index completes it. `suite` is the
/// object's (`contentSuite` on the version), which fixes the layout.
#[derive(Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct Content {
    pub workspace_id: String,
    pub object_id: String,
    pub suite: u32,
    /// The content key: wiped when the record is dropped.
    pub key: SecretBytes,
    pub nonce: Vec<u8>,
    pub plaintext_size: u64,
    pub thumbnail_bytes: u32,
}

impl fmt::Debug for Content {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Content")
            .field("workspace_id", &self.workspace_id)
            .field("object_id", &self.object_id)
            .field("suite", &self.suite)
            .field("key", &Redacted)
            .field("nonce", &self.nonce)
            .field("plaintext_size", &self.plaintext_size)
            .field("thumbnail_bytes", &self.thumbnail_bytes)
            .finish()
    }
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

fn layout_of(content: &Content) -> CoreResult<ContentLayout> {
    content_layout(content.suite, content.plaintext_size, content.thumbnail_bytes)
}

/// One chunk sealed. `plaintext` is the file's bytes for the index, exactly
/// [`chunk_length`] of them; under suite 3 the core appends the zeros the
/// layout calls for, so an app never builds padding itself. The nonce is the
/// content nonce with the index appended, so the same key and nonce never seal
/// two different chunks.
///
/// ```
/// use hushos_core::{chunk_decrypt, chunk_encrypt, content_layout, random_bytes, Content};
/// let content = Content {
///     workspace_id: "11111111-1111-4111-8111-111111111111".into(), object_id: "66666666-6666-4666-8666-666666666666".into(), suite: 3,
///     key: random_bytes(32)?.into(), nonce: random_bytes(16)?, plaintext_size: 5, thumbnail_bytes: 0,
/// };
/// let sealed = chunk_encrypt(content.clone(), 0, b"hello".to_vec())?;
/// assert_eq!(sealed.len(), 256 + 16, "padded to the smallest bucket");
/// assert_eq!(sealed.len() as u64, content_layout(3, 5, 0)?.ciphertext_size);
/// assert_eq!(chunk_decrypt(content, 0, sealed)?, b"hello", "the padding is dropped");
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn chunk_encrypt(content: Content, index: u64, plaintext: Vec<u8>) -> CoreResult<Vec<u8>> {
    let layout = layout_of(&content)?;
    if index >= layout.chunk_count {
        return Err(input("chunk index is past the end"));
    }
    if plaintext.len() as u64 != chunk_plaintext_len(content.plaintext_size, index) {
        return Err(input("the chunk does not have the length its index requires"));
    }
    let mut padded = Zeroizing::new(plaintext);
    padded.resize(chunk_plaintext_len(layout.content_length, index) as usize, 0);
    let nonce = chunk_nonce(&content, index)?;
    seal_with_nonce(&content.key, &nonce, &padded, &chunk_context(&content, index, layout.chunk_count))
}

/// One chunk opened: the file's bytes in it, padding dropped (none, for a
/// chunk wholly past the file's end). `ciphertext` is the bytes of
/// [`chunk_range`]; the last chunk's may carry the trailer behind it.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn chunk_decrypt(content: Content, index: u64, ciphertext: Vec<u8>) -> CoreResult<Vec<u8>> {
    let layout = layout_of(&content)?;
    if index >= layout.chunk_count {
        return Err(input("chunk index is past the end"));
    }
    // The last chunk may come with the trailer behind it (see chunk_range); every other must be exact.
    let length = (chunk_plaintext_len(layout.content_length, index) + TAG_BYTES as u64) as usize;
    let last = index + 1 == layout.chunk_count;
    if if last { ciphertext.len() < length } else { ciphertext.len() != length } {
        return Err(CoreError::Sealed("This file could not be decrypted. It may be damaged.".into()));
    }
    let nonce = chunk_nonce(&content, index)?;
    let mut plaintext = open_with_nonce(
        &content.key,
        &nonce,
        &ciphertext[..length],
        &chunk_context(&content, index, layout.chunk_count),
    )
    .map_err(|_| CoreError::Sealed("This file could not be decrypted. It may be damaged.".into()))?;
    plaintext.truncate(chunk_plaintext_len(content.plaintext_size, index) as usize);
    Ok(plaintext)
}

fn thumbnail_key(content: &Content) -> CoreResult<Zeroizing<[u8; KEY_BYTES]>> {
    if check_suite(content.suite)? == LEGACY_CONTENT_SUITE {
        return Err(input("Content suite 1 carries no thumbnail."));
    }
    derive_subkey(&content.key, THUMBNAIL_KDF_SUBKEY, THUMBNAIL_KDF_CONTEXT)
}

fn thumbnail_context(content: &Content) -> Vec<u8> {
    context(&[
        json!("hushos/drive/thumbnail"),
        json!(content.suite),
        json!(content.workspace_id),
        json!(content.object_id),
        json!(content.thumbnail_bytes),
    ])
}

/// The thumbnail trailer sealed under its own derived key, its nonce index the
/// one after the last chunk's (the padded count under suite 3).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn thumbnail_encrypt(content: Content, thumbnail: Vec<u8>) -> CoreResult<Vec<u8>> {
    if thumbnail.is_empty()
        || thumbnail.len() as u64 != content.thumbnail_bytes as u64
        || content.thumbnail_bytes > THUMBNAIL_MAX_BYTES
    {
        return Err(input("the thumbnail does not have the length the version was sealed with"));
    }
    let key = thumbnail_key(&content)?;
    let nonce = chunk_nonce(&content, layout_of(&content)?.chunk_count)?;
    seal_with_nonce(key.as_slice(), &nonce, &thumbnail, &thumbnail_context(&content))
}

/// The thumbnail opened; `fetched` is the bytes of `thumbnail_range`, whose
/// last `thumbnail_bytes` and a tag are the trailer.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn thumbnail_decrypt(content: Content, fetched: Vec<u8>) -> CoreResult<Vec<u8>> {
    if content.thumbnail_bytes == 0 {
        return Err(input("This version has no thumbnail."));
    }
    let key = thumbnail_key(&content)?;
    let trailer = trailer_len(content.thumbnail_bytes)? as usize;
    if fetched.len() < trailer {
        return Err(CoreError::Sealed("This thumbnail could not be decrypted.".into()));
    }
    let ciphertext = &fetched[fetched.len() - trailer..];
    let nonce = chunk_nonce(&content, layout_of(&content)?.chunk_count)?;
    open_with_nonce(key.as_slice(), &nonce, ciphertext, &thumbnail_context(&content))
        .map_err(|_| CoreError::Sealed("This thumbnail could not be decrypted.".into()))
}

// ---------------------------------------------------------------------------
// Re-keyed records (docs/integrity-design.md, "Re-keyed records")
// ---------------------------------------------------------------------------

/// Which record a re-keyed origin is: a node's metadata at a metadata version,
/// or one version of a file.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum OriginRecord {
    Metadata { metadata_version: u64 },
    Version { version_id: String },
}

/// What binds a wrapped origin key: the node, the record, the node key's
/// epoch it is wrapped under, and the origin envelope it opens.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct OriginKeyContext {
    pub workspace_id: String,
    pub node_id: String,
    pub key_epoch: u64,
    pub record: OriginRecord,
    pub origin_envelope: Vec<u8>,
}

/*
 * ["hushos/drive/origin-key", 1, ws, nodeId, "metadata", metadataVersion, keyEpoch, sha256(originEnvelope)]
 * ["hushos/drive/origin-key", 1, ws, nodeId, "version", versionId, keyEpoch, sha256(originEnvelope)]
 * Its own label: the wrapped origin key is 72 bytes, as a node key or a
 * legacy content key envelope is, and must never open as either.
 */
pub(crate) fn origin_key_context(ctx: &OriginKeyContext) -> CoreResult<Vec<u8>> {
    let (record, position) = match &ctx.record {
        OriginRecord::Metadata { metadata_version } => {
            ("metadata", json!(context_epoch(*metadata_version, "metadata version")?))
        }
        OriginRecord::Version { version_id } => ("version", json!(context_id(version_id, "version id")?)),
    };
    Ok(context(&[
        json!("hushos/drive/origin-key"),
        json!(ENVELOPE_SUITE),
        json!(context_id(&ctx.workspace_id, "workspace id")?),
        json!(context_id(&ctx.node_id, "node id")?),
        json!(record),
        position,
        json!(context_epoch(ctx.key_epoch, "key epoch")?),
        json!(crate::signatures::digest(&ctx.origin_envelope)),
    ]))
}

/// A metadata envelope sealed again under a new node key, exactly as it was:
/// the padded plaintext is never parsed, so the writer's bytes survive and a
/// reader can compare them with the origin. What a rotation writes.
///
/// ```
/// use hushos_core::*;
/// let (old, new) = (random_bytes(32)?, random_bytes(32)?);
/// let ctx = MetadataContext { workspace_id: "11111111-1111-4111-8111-111111111111".into(), node_id: "22222222-2222-4222-8222-222222222222".into(), metadata_version: 1 };
/// let metadata = NodeMetadata { name: "notes.md".into(), mime: None, size: None, modified: None, attributes: Default::default() };
/// let origin = metadata_seal(ctx.clone(), old.clone(), metadata.clone())?;
/// let rekeyed = metadata_rekey(ctx.clone(), old.clone(), new.clone(), origin.clone())?;
/// assert_eq!(rekeyed.len(), origin.len());
/// assert_eq!(metadata_open(ctx.clone(), new, rekeyed)?, metadata);
/// assert!(metadata_rekey(ctx, random_bytes(32)?, old, origin).is_err(), "only the old key opens it");
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_rekey(
    ctx: MetadataContext,
    old_key: Vec<u8>,
    new_key: Vec<u8>,
    envelope: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    let (old_key, new_key) = (Zeroizing::new(old_key), Zeroizing::new(new_key));
    metadata_rekey_with(&ctx, &old_key, &new_key, &envelope)
}

/* The same over borrowed keys: no copy of either outlives the call. */
pub(crate) fn metadata_rekey_with(
    ctx: &MetadataContext,
    old_key: &[u8],
    new_key: &[u8],
    envelope: &[u8],
) -> CoreResult<Vec<u8>> {
    expect_len("oldKey", old_key, KEY_BYTES)?;
    expect_len("newKey", new_key, KEY_BYTES)?;
    if envelope.len() > METADATA_ENVELOPE_MAX_BYTES {
        return Err(CoreError::Sealed("This encrypted envelope is damaged.".into()));
    }
    rekey(old_key, new_key, envelope, &metadata_context(ctx)?)
}

/// A version envelope sealed again under a new node key, byte for byte, in
/// the object's own suite (72 bytes for suite 1, 84 for 2 and 3). What a
/// rotation writes.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_rekey(
    ctx: VersionContext,
    suite: u32,
    old_key: Vec<u8>,
    new_key: Vec<u8>,
    envelope: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    let (old_key, new_key) = (Zeroizing::new(old_key), Zeroizing::new(new_key));
    version_rekey_with(&ctx, suite, &old_key, &new_key, &envelope)
}

/* The same over borrowed keys: no copy of either outlives the call. */
pub(crate) fn version_rekey_with(
    ctx: &VersionContext,
    suite: u32,
    old_key: &[u8],
    new_key: &[u8],
    envelope: &[u8],
) -> CoreResult<Vec<u8>> {
    expect_len("oldKey", old_key, KEY_BYTES)?;
    expect_len("newKey", new_key, KEY_BYTES)?;
    expect_len("envelope", envelope, version_envelope_len(suite)?)?;
    rekey(old_key, new_key, envelope, &version_context(ctx, suite)?)
}

/* A version envelope's length in its suite. */
pub(crate) fn version_envelope_len(suite: u32) -> CoreResult<usize> {
    match suite {
        LEGACY_CONTENT_SUITE => Ok(KEY_ENVELOPE_BYTES),
        UNPADDED_CONTENT_SUITE | CONTENT_SUITE => Ok(VERSION_ENVELOPE_BYTES),
        other => Err(input(format!("Unsupported content suite {other}."))),
    }
}

/// The key that opens one origin envelope and nothing else the node key
/// sealed: XChaCha20-Poly1305's own subkey for that envelope's nonce
/// (HChaCha20 of `node_key` and the nonce's first 16 bytes). A rotation wraps
/// it under the fresh node key with [`origin_key_wrap`] instead of handing
/// out the old node key, which still opens what was moved out before.
///
/// ```
/// use hushos_core::*;
/// let (old, fresh) = (random_bytes(32)?, random_bytes(32)?);
/// let origin = node_wrap(NodeKeyContext { workspace_id: "11111111-1111-4111-8111-111111111111".into(), node_id: "22222222-2222-4222-8222-222222222222".into(), parent_id: "77777777-7777-4777-8777-777777777777".into(), parent_key_epoch: 1, key_epoch: 1 }, old.clone(), random_bytes(32)?)?;
/// let key = origin_opening_key(origin.clone(), old.clone())?;
/// assert_eq!(key.len(), 32);
/// assert_ne!(key, old);
/// let ctx = OriginKeyContext { workspace_id: "11111111-1111-4111-8111-111111111111".into(), node_id: "22222222-2222-4222-8222-222222222222".into(), key_epoch: 2, record: OriginRecord::Metadata { metadata_version: 1 }, origin_envelope: origin };
/// let wrapped = origin_key_wrap(ctx.clone(), fresh.clone(), key.clone())?;
/// assert_eq!(wrapped.len(), 72);
/// assert_eq!(origin_key_open(ctx.clone(), fresh.clone(), wrapped.clone())?, key);
/// assert!(origin_key_open(OriginKeyContext { key_epoch: 3, ..ctx }, fresh, wrapped).is_err());
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn origin_opening_key(origin_envelope: Vec<u8>, node_key: Vec<u8>) -> CoreResult<Vec<u8>> {
    let node_key = Zeroizing::new(node_key);
    Ok(origin_opening_key_with(&origin_envelope, &node_key)?.to_vec())
}

/* The same over a borrowed node key, the opening key wiped when dropped. */
pub(crate) fn origin_opening_key_with(
    origin_envelope: &[u8],
    node_key: &[u8],
) -> CoreResult<Zeroizing<[u8; KEY_BYTES]>> {
    expect_len("nodeKey", node_key, KEY_BYTES)?;
    opening_key(node_key, origin_envelope)
}

/// An origin's opening key wrapped under the node key at the epoch it now
/// has: the 72-byte `originKeyEnvelope` a re-keyed record carries.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn origin_key_wrap(ctx: OriginKeyContext, node_key: Vec<u8>, origin_key: Vec<u8>) -> CoreResult<Vec<u8>> {
    let (node_key, origin_key) = (Zeroizing::new(node_key), Zeroizing::new(origin_key));
    origin_key_wrap_with(&ctx, &node_key, &origin_key)
}

/* The same over borrowed keys: no copy of either outlives the call. */
pub(crate) fn origin_key_wrap_with(
    ctx: &OriginKeyContext,
    node_key: &[u8],
    origin_key: &[u8],
) -> CoreResult<Vec<u8>> {
    expect_len("nodeKey", node_key, KEY_BYTES)?;
    expect_len("originKey", origin_key, KEY_BYTES)?;
    seal(node_key, origin_key, &origin_key_context(ctx)?)
}

/// The inverse of [`origin_key_wrap`]: what a reader, or the next rotation,
/// opens the origin with.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn origin_key_open(
    ctx: OriginKeyContext,
    node_key: Vec<u8>,
    key_envelope: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    expect_len("nodeKey", &node_key, KEY_BYTES)?;
    expect_len("originKeyEnvelope", &key_envelope, KEY_ENVELOPE_BYTES)?;
    open_key(&node_key, &key_envelope, &origin_key_context(&ctx)?, "origin key")
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

fn derive_subkey(master: &[u8], subkey_id: u64, ctx: &str) -> CoreResult<Zeroizing<[u8; KEY_BYTES]>> {
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
    Ok(Zeroizing::new(mac.finalize().into_bytes().into()))
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
            workspace_id: "11111111-1111-4111-8111-111111111111".into(),
            node_id: "22222222-2222-4222-8222-222222222222".into(),
            parent_id: "77777777-7777-4777-8777-777777777777".into(),
            parent_key_epoch: 1,
            key_epoch: 2,
        }
    }

    fn version_ctx() -> VersionContext {
        VersionContext {
            workspace_id: "11111111-1111-4111-8111-111111111111".into(),
            node_id: "22222222-2222-4222-8222-222222222222".into(),
            version_id: "44444444-4444-4444-8444-444444444444".into(),
            object_id: "66666666-6666-4666-8666-666666666666".into(),
        }
    }

    #[test]
    fn debug_prints_hide_content_keys_the_sealed_workspace_key_and_names() {
        use crate::bytes::shows;
        let content = content(100, 0);
        let printed = format!("{content:?}");
        assert!(!shows(&printed, &content.key), "{printed}");
        assert!(printed.contains("plaintext_size: 100"));
        let key = ContentKey { key: random(32).into(), plaintext_size: 5, thumbnail_bytes: 0 };
        assert!(!shows(&format!("{key:?}"), &key.key));
        let grant = WorkspaceGrant {
            version: 1,
            workspace_id: "11111111-1111-4111-8111-111111111111".into(),
            key_version: 1,
            workspace_key_version: 1,
            wrapping_salt: encode(&random(32)),
            wrapping_nonce: encode(&random(24)),
            encrypted_key: encode(&random(48)),
        };
        assert!(!format!("{grant:?}").contains(&grant.encrypted_key));
        let metadata = NodeMetadata {
            name: "Tax return 2025.pdf".into(),
            mime: None,
            size: Some(3),
            modified: None,
            attributes: Default::default(),
        };
        assert!(!format!("{metadata:?}").contains("Tax return"));
    }

    fn content(plaintext_size: u64, thumbnail_bytes: u32) -> Content {
        Content {
            workspace_id: "11111111-1111-4111-8111-111111111111".into(),
            object_id: "66666666-6666-4666-8666-666666666666".into(),
            suite: CONTENT_SUITE,
            key: random(32).into(),
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
        moved.parent_id = "88888888-8888-4888-8888-888888888888".into();
        assert!(matches!(node_open(moved, parent.clone(), envelope.clone()), Err(CoreError::Sealed(_))));
        let mut rotated = node_ctx();
        rotated.key_epoch = 3;
        assert!(matches!(node_open(rotated, parent.clone(), envelope.clone()), Err(CoreError::Sealed(_))));
        assert!(matches!(node_open(node_ctx(), parent, envelope[..71].to_vec()), Err(CoreError::Input(_))));
    }

    #[test]
    fn metadata_is_padded_in_256_byte_steps_and_capped_at_4096() {
        let key = random(32);
        let ctx = MetadataContext {
            workspace_id: "11111111-1111-4111-8111-111111111111".into(),
            node_id: "22222222-2222-4222-8222-222222222222".into(),
            metadata_version: 1,
        };
        let short = NodeMetadata {
            name: "a".into(),
            mime: None,
            size: None,
            modified: None,
            attributes: Default::default(),
        };
        assert_eq!(
            metadata_seal(ctx.clone(), key.clone(), short).unwrap().len(),
            NONCE_BYTES + 256 + TAG_BYTES
        );
        let long_name = NodeMetadata {
            name: "n".repeat(250),
            mime: None,
            size: None,
            modified: None,
            attributes: Default::default(),
        };
        assert_eq!(
            metadata_seal(ctx.clone(), key.clone(), long_name).unwrap().len(),
            NONCE_BYTES + 512 + TAG_BYTES
        );
        // 255 four-byte code points is a legal name that needs five steps and still fits the cap.
        let wide = NodeMetadata {
            name: "\u{1F600}".repeat(255),
            mime: None,
            size: None,
            modified: None,
            attributes: Default::default(),
        };
        let sealed = metadata_seal(ctx.clone(), key.clone(), wide.clone()).unwrap();
        assert_eq!(sealed.len(), NONCE_BYTES + 1280 + TAG_BYTES);
        assert_eq!(metadata_open(ctx, key, sealed).unwrap(), wide);
    }

    #[test]
    fn metadata_seal_drops_out_of_range_fields_and_binds_the_version() {
        let key = random(32);
        let ctx = MetadataContext {
            workspace_id: "11111111-1111-4111-8111-111111111111".into(),
            node_id: "22222222-2222-4222-8222-222222222222".into(),
            metadata_version: 4,
        };
        let dirty = NodeMetadata {
            name: "f".into(),
            mime: Some("x".repeat(256)),
            size: Some(1 << 53),
            modified: Some("2".repeat(65)),
            attributes: Default::default(),
        };
        let envelope = metadata_seal(ctx.clone(), key.clone(), dirty).unwrap();
        let opened = metadata_open(ctx.clone(), key.clone(), envelope.clone()).unwrap();
        assert_eq!(
            opened,
            NodeMetadata {
                name: "f".into(),
                mime: None,
                size: None,
                modified: None,
                attributes: Default::default()
            }
        );
        let mut stale = ctx.clone();
        stale.metadata_version = 3;
        assert!(matches!(metadata_open(stale, key.clone(), envelope), Err(CoreError::Sealed(_))));
        let bad = NodeMetadata {
            name: "a/b".into(),
            mime: None,
            size: None,
            modified: None,
            attributes: Default::default(),
        };
        assert!(matches!(metadata_seal(ctx, key, bad), Err(CoreError::Input(_))));
    }

    fn attributes_of(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn attributed(attributes: HashMap<String, String>) -> NodeMetadata {
        NodeMetadata {
            name: "Plans".into(),
            mime: None,
            size: None,
            modified: Some("2026-10-28T09:00:00.000Z".into()),
            attributes,
        }
    }

    fn metadata_ctx() -> MetadataContext {
        MetadataContext {
            workspace_id: "11111111-1111-4111-8111-111111111111".into(),
            node_id: "22222222-2222-4222-8222-222222222222".into(),
            metadata_version: 2,
        }
    }

    /* An envelope over exactly `plaintext`, as a writer other than metadata_seal could make it. */
    fn sealed_as(plaintext: &str, key: &[u8]) -> Vec<u8> {
        seal(key, plaintext.as_bytes(), &metadata_context(&metadata_ctx()).unwrap()).unwrap()
    }

    fn plaintext_of(envelope: &[u8], key: &[u8]) -> String {
        let bytes = open(key, envelope, &metadata_context(&metadata_ctx()).unwrap()).unwrap();
        String::from_utf8(bytes).unwrap().trim_end().to_string()
    }

    #[test]
    fn attributes_come_back_exactly_unknown_keys_included_written_sorted() {
        let key = random(32);
        let metadata = attributed(attributes_of(&[("zz-future", "kept"), ("colour", "blue"), ("a_b", "")]));
        let envelope = metadata_seal(metadata_ctx(), key.clone(), metadata.clone()).unwrap();
        assert_eq!(metadata_open(metadata_ctx(), key.clone(), envelope.clone()).unwrap(), metadata);
        // The same bytes the web writes: drive.test.ts asserts this exact plaintext.
        assert_eq!(
            plaintext_of(&envelope, &key),
            r#"{"name":"Plans","mime":null,"size":null,"modified":"2026-10-28T09:00:00.000Z","attributes":{"a_b":"","colour":"blue","zz-future":"kept"}}"#
        );
        // Debug never prints a value.
        assert!(!format!("{metadata:?}").contains("blue"));
    }

    #[test]
    fn no_attributes_is_no_field_and_records_from_before_them_open() {
        let key = random(32);
        let none = metadata_seal(metadata_ctx(), key.clone(), attributed(HashMap::new())).unwrap();
        assert_eq!(
            plaintext_of(&none, &key),
            r#"{"name":"Plans","mime":null,"size":null,"modified":"2026-10-28T09:00:00.000Z"}"#
        );
        let old = sealed_as(
            &format!("{}{}", r#"{"name":"Plans","mime":null,"size":null,"modified":null}"#, " ".repeat(200)),
            &key,
        );
        let opened = metadata_open(metadata_ctx(), key.clone(), old).unwrap();
        assert!(opened.attributes.is_empty());
        assert_eq!(opened.name, "Plans");
        let empty = sealed_as(r#"{"name":"P","attributes":{}}"#, &key);
        assert!(metadata_open(metadata_ctx(), key, empty).unwrap().attributes.is_empty());
    }

    #[test]
    fn an_attribute_named_like_a_known_field_never_stands_in_for_it() {
        let key = random(32);
        let attributes =
            attributes_of(&[("name", "a/b"), ("mime", "text/html"), ("size", "9"), ("modified", "x")]);
        let metadata = attributed(attributes);
        let envelope = metadata_seal(metadata_ctx(), key.clone(), metadata.clone()).unwrap();
        assert_eq!(metadata_open(metadata_ctx(), key.clone(), envelope).unwrap(), metadata);
        let bad_name = NodeMetadata { name: "a/b".into(), ..attributed(attributes_of(&[("name", "fine")])) };
        assert!(matches!(metadata_seal(metadata_ctx(), key.clone(), bad_name), Err(CoreError::Input(_))));
        // A record with no name of its own is refused, whatever its attributes say.
        let nameless = sealed_as(r#"{"attributes":{"name":"ok"}}"#, &key);
        assert!(matches!(metadata_open(metadata_ctx(), key.clone(), nameless), Err(CoreError::Sealed(_))));
        let planted = sealed_as(r#"{"name":"real","size":5,"attributes":{"name":"fake","size":"7"}}"#, &key);
        let opened = metadata_open(metadata_ctx(), key, planted).unwrap();
        assert_eq!((opened.name.as_str(), opened.size), ("real", Some(5)));
    }

    #[test]
    fn attributes_out_of_bounds_are_refused_sealing_and_opening_never_trimmed() {
        let key = random(32);
        let bad_keys = [
            "",
            "Colour",
            "1colour",
            "-colour",
            "_colour",
            "__proto__",
            "col our",
            "colör",
            &"a".repeat(33),
            "colour\n",
        ];
        for bad in bad_keys {
            let refused =
                metadata_seal(metadata_ctx(), key.clone(), attributed(attributes_of(&[(bad, "x")])));
            assert_eq!(refused, Err(input("Invalid attribute name.")), "{bad:?}");
            let planted =
                sealed_as(&serde_json::json!({ "name": "P", "attributes": { bad: "x" } }).to_string(), &key);
            assert!(
                matches!(metadata_open(metadata_ctx(), key.clone(), planted), Err(CoreError::Sealed(_))),
                "{bad:?}"
            );
        }
        // At the bounds: 32 characters, and 32 keys.
        let most: HashMap<String, String> = (0..32).map(|i| (format!("k{i}"), "v".to_string())).collect();
        let longest = attributes_of(&[(&"a".repeat(32), "x"), ("z", "y")]);
        for attributes in [most.clone(), longest] {
            let metadata = attributed(attributes);
            let envelope = metadata_seal(metadata_ctx(), key.clone(), metadata.clone()).unwrap();
            assert_eq!(metadata_open(metadata_ctx(), key.clone(), envelope).unwrap(), metadata);
        }
        let mut too_many = most;
        too_many.insert("k99".into(), "v".into());
        assert_eq!(
            metadata_seal(metadata_ctx(), key.clone(), attributed(too_many.clone())),
            Err(input("An item can have at most 32 attributes."))
        );
        let planted =
            sealed_as(&serde_json::json!({ "name": "P", "attributes": too_many }).to_string(), &key);
        assert!(matches!(metadata_open(metadata_ctx(), key.clone(), planted), Err(CoreError::Sealed(_))));
        // Values are strings, and the map is an object: anything else is damage, not "none".
        for value in ["1", "true", "null", r#"["x"]"#, r#"{"x":"y"}"#, r#""\ud800""#] {
            let planted = sealed_as(&format!(r#"{{"name":"P","attributes":{{"colour":{value}}}}}"#), &key);
            assert!(
                matches!(metadata_open(metadata_ctx(), key.clone(), planted), Err(CoreError::Sealed(_))),
                "{value}"
            );
        }
        for value in ["null", r#"["x"]"#, r#""blue""#, "0"] {
            let planted = sealed_as(&format!(r#"{{"name":"P","attributes":{value}}}"#), &key);
            assert!(
                matches!(metadata_open(metadata_ctx(), key.clone(), planted), Err(CoreError::Sealed(_))),
                "{value}"
            );
        }
    }

    /* The same cases as drive.test.ts ("a key named twice anywhere is refused"): refused alike. */
    const DOUBLED: [&str; 7] = [
        r#"{"name":"P","attributes":{"colour":1,"colour":"blue"}}"#,
        r#"{"name":"P","attributes":{"colour":"red","colour":"blue"}}"#,
        r#"{"name":"P","attributes":{"colour":"red","\u0063olour":"blue"}}"#,
        r#"{"name":"P","attributes":{"colour":"red"},"attributes":{"colour":"blue"}}"#,
        r#"{"name":"a/b","name":"P"}"#,
        r#"{"name":"P","x":1,"x":2}"#,
        r#"{"name":"P","x":{"a":1,"a":2}}"#,
    ];
    const SINGLE: [&str; 3] = [
        r#"{"name":"P","x":{"name":"y"},"attributes":{"name":"z"}}"#,
        r#"{"name":"P","x":[{"a":1},{"a":2}]}"#,
        r#"{"name":"P","attributes":{"a":"\"b\":1,\"b\"","b":"x"}}"#,
    ];

    #[test]
    fn metadata_open_refuses_what_serde_or_the_web_would_read_twice() {
        let key = random(32);
        for text in DOUBLED {
            let opened = metadata_open(metadata_ctx(), key.clone(), sealed_as(text, &key));
            assert!(matches!(opened, Err(CoreError::Sealed(_))), "{text}");
        }
        for text in SINGLE {
            assert_eq!(
                metadata_open(metadata_ctx(), key.clone(), sealed_as(text, &key)).unwrap().name,
                "P",
                "{text}"
            );
        }
        // Each layer on its own: serde refuses a struct field named twice, and the attributes reader a key named twice.
        assert!(serde_json::from_str::<NodeMetadata>(r#"{"name":"a","name":"b"}"#).is_err());
        assert!(
            serde_json::from_str::<NodeMetadata>(r#"{"name":"P","attributes":{"c":"x","c":"y"}}"#).is_err()
        );
        assert!(
            serde_json::from_str::<NodeMetadata>(r#"{"name":"P","attributes":{"c":"x","d":"y"}}"#).is_ok()
        );
        assert!(has_duplicate_key(r#"{"a":{"b":1,"\u0062":2}}"#));
        assert!(!has_duplicate_key(r#"{"a":"{\"b\":1,\"b\":2}"}"#));
    }

    #[test]
    fn bytes_that_are_not_utf_8_or_start_with_a_byte_order_mark_are_refused() {
        let key = random(32);
        let aad = metadata_context(&metadata_ctx()).unwrap();
        let cases: [&[u8]; 3] = [
            b"{\"name\":\"P\",\"attributes\":{\"colour\":\"\xff\"}}",
            b"{\"name\":\"P\xc3\"}",
            b"\xef\xbb\xbf{\"name\":\"P\"}",
        ];
        for plaintext in cases {
            let envelope = seal(&key, plaintext, &aad).unwrap();
            assert!(matches!(
                metadata_open(metadata_ctx(), key.clone(), envelope),
                Err(CoreError::Sealed(_))
            ));
        }
    }

    #[test]
    fn the_whole_record_stays_within_4096_bytes_one_over_is_refused_not_cut() {
        let key = random(32);
        let base = serde_json::to_vec(&attributed(attributes_of(&[("colour", "")]))).unwrap().len();
        let fits = attributed(attributes_of(&[("colour", &"x".repeat(METADATA_MAX_BYTES - base))]));
        let envelope = metadata_seal(metadata_ctx(), key.clone(), fits.clone()).unwrap();
        assert_eq!(envelope.len(), NONCE_BYTES + METADATA_MAX_BYTES + TAG_BYTES);
        assert_eq!(metadata_open(metadata_ctx(), key.clone(), envelope).unwrap(), fits);
        let over = attributed(attributes_of(&[("colour", &"x".repeat(METADATA_MAX_BYTES - base + 1))]));
        assert_eq!(
            metadata_seal(metadata_ctx(), key.clone(), over),
            Err(input("This name and its attributes are too long to save."))
        );
        // Counted in UTF-8 bytes, not characters.
        let wide = attributed(attributes_of(&[("colour", &"\u{e9}".repeat(2100))]));
        assert!(matches!(metadata_seal(metadata_ctx(), key, wide), Err(CoreError::Input(_))));
    }

    #[test]
    fn a_tampered_envelope_with_attributes_still_fails() {
        let key = random(32);
        let envelope =
            metadata_seal(metadata_ctx(), key.clone(), attributed(attributes_of(&[("colour", "blue")])))
                .unwrap();
        for at in [0, 30, envelope.len() - 1] {
            let mut flipped = envelope.clone();
            flipped[at] ^= 1;
            assert!(matches!(metadata_open(metadata_ctx(), key.clone(), flipped), Err(CoreError::Sealed(_))));
        }
        let mut later = metadata_ctx();
        later.metadata_version = 3;
        assert!(metadata_open(later, key, envelope.clone()).is_err());
        assert!(metadata_open(metadata_ctx(), random(32), envelope).is_err());
    }

    #[test]
    fn a_rekey_keeps_every_attribute_unknown_keys_included() {
        let (old, fresh) = (random(32), random(32));
        let metadata = attributed(attributes_of(&[("colour", "red"), ("later-feature", r#"{"x":1}"#)]));
        let origin = metadata_seal(metadata_ctx(), old.clone(), metadata.clone()).unwrap();
        let rekeyed = metadata_rekey(metadata_ctx(), old, fresh.clone(), origin).unwrap();
        assert_eq!(metadata_open(metadata_ctx(), fresh, rekeyed).unwrap(), metadata);
    }

    #[test]
    fn documents_pad_in_growing_steps_and_bind_kind_and_version() {
        let key = random(32);
        let ctx = DocumentContext {
            workspace_id: "11111111-1111-4111-8111-111111111111".into(),
            kind: "tags".into(),
            version: 3,
        };
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
                DocumentContext {
                    workspace_id: "11111111-1111-4111-8111-111111111111".into(),
                    kind: "tags".into(),
                    version: 1
                },
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
        // 20,003,016 bytes of file and trailer pad to the 20,447,232 bucket.
        assert_eq!(
            sealed.layout,
            ContentLayout {
                chunk_count: 3,
                chunk_bytes: CHUNK_BYTES,
                tag_bytes: 16,
                ciphertext_size: 20_447_232 + 48,
                content_length: 20_447_232 - 3016,
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
        other.version_id = "55555555-5555-4555-8555-555555555555".into();
        assert!(matches!(
            version_open(other, CONTENT_SUITE, node_key.clone(), sealed.envelope.clone(), None),
            Err(CoreError::Sealed(_))
        ));
        // The same record under suite 2 would be read unpadded: the suite is in the context.
        assert!(matches!(
            version_open(
                version_ctx(),
                UNPADDED_CONTENT_SUITE,
                node_key.clone(),
                sealed.envelope.clone(),
                None
            ),
            Err(CoreError::Sealed(_))
        ));
        // A suite 3 envelope is 84 bytes, never a suite 1 one.
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
        let content = ContentKey { key: random(32).into(), plaintext_size: 77, thumbnail_bytes: 0 };
        let envelope =
            version_reseal(version_ctx(), LEGACY_CONTENT_SUITE, node_key.clone(), content.clone()).unwrap();
        assert_eq!(envelope.len(), KEY_ENVELOPE_BYTES);
        let opened = version_open(version_ctx(), LEGACY_CONTENT_SUITE, node_key, envelope, Some(77)).unwrap();
        assert_eq!(opened.key, content.key);
        assert!(matches!(version_reseal(version_ctx(), 4, random(32), content), Err(CoreError::Input(_))));
    }

    #[test]
    fn a_legacy_version_needs_the_row_size_and_has_no_thumbnail() {
        let node_key = random(32);
        let content_key = random(32);
        let envelope =
            seal(&node_key, &content_key, &version_context(&version_ctx(), LEGACY_CONTENT_SUITE).unwrap())
                .unwrap();
        let opened =
            version_open(version_ctx(), LEGACY_CONTENT_SUITE, node_key.clone(), envelope.clone(), Some(77))
                .unwrap();
        assert_eq!(
            (opened.key.to_vec(), opened.plaintext_size, opened.thumbnail_bytes),
            (content_key, 77, 0)
        );
        assert!(matches!(
            version_open(version_ctx(), LEGACY_CONTENT_SUITE, node_key.clone(), envelope.clone(), None),
            Err(CoreError::Input(_))
        ));
        assert!(matches!(version_open(version_ctx(), 4, node_key, envelope, None), Err(CoreError::Input(_))));
    }

    fn unpadded(plaintext_size: u64, thumbnail_bytes: u32) -> Content {
        Content { suite: UNPADDED_CONTENT_SUITE, ..content(plaintext_size, thumbnail_bytes) }
    }

    #[test]
    fn chunks_are_bound_to_their_index_and_count() {
        let content = unpadded(CHUNK_BYTES + 3, 0);
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
    fn an_empty_file_is_one_tagged_chunk() {
        let bare = unpadded(0, 0);
        let sealed = chunk_encrypt(bare.clone(), 0, vec![]).unwrap();
        assert_eq!(sealed.len(), TAG_BYTES);
        assert_eq!(chunk_range(UNPADDED_CONTENT_SUITE, 0, 0, 0).unwrap(), ByteRange { start: 0, end: 15 });
        assert_eq!(chunk_decrypt(bare, 0, sealed).unwrap(), Vec::<u8>::new());
        // Under suite 3 it is the smallest bucket of zeros, and still opens to nothing.
        let padded = content(0, 0);
        let sealed = chunk_encrypt(padded.clone(), 0, vec![]).unwrap();
        assert_eq!(sealed.len(), 256 + TAG_BYTES);
        assert_eq!(chunk_decrypt(padded, 0, sealed).unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn the_last_chunk_opens_from_a_range_that_runs_on_through_the_trailer() {
        for content in [unpadded(100, 2000), content(100, 2000)] {
            let sealed = chunk_encrypt(content.clone(), 0, vec![3; 100]).unwrap();
            // What chunk_range asks for: the chunk and the trailer behind it, to the object's end.
            let range = chunk_range(content.suite, 100, 2000, 0).unwrap();
            assert_eq!(range, ByteRange { start: 0, end: sealed.len() as u64 + 2016 - 1 });
            let mut fetched = sealed.clone();
            fetched.extend_from_slice(&[0u8; 2016]);
            assert_eq!(chunk_decrypt(content.clone(), 0, fetched).unwrap(), vec![3; 100]);
            assert!(matches!(chunk_decrypt(content, 0, sealed[1..].to_vec()), Err(CoreError::Sealed(_))));
        }
    }

    #[test]
    fn padded_length_is_padme_never_smaller_idempotent_monotonic_and_bounded() {
        let known = [
            (0, 256),
            (256, 256),
            (257, 272),
            (1000, 1024),
            (65_537, 67_584),
            ((1 << 20) + 1, 1_081_344),
            ((1 << 32) + 1, 4_362_076_160),
            (10_000_000_000, 10_066_329_600),
            (1 << 40, 1 << 40),
        ];
        for (length, bucket) in known {
            assert_eq!(padded_length(length).unwrap(), bucket, "{length}");
        }
        let mut previous = 0;
        for length in
            (250..5000).chain([CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, MAX_SAFE_INTEGER / 16])
        {
            let bucket = padded_length(length).unwrap();
            assert!(bucket >= length && bucket >= previous, "{length}");
            assert_eq!(padded_length(bucket).unwrap(), bucket);
            if length > 256 {
                let e = 63 - length.leading_zeros() as u64;
                let s = 64 - e.leading_zeros() as u64;
                assert!((bucket - length) << s < length, "{length}: padding past 2^-{s}");
            }
            previous = bucket;
        }
        assert!(padded_length(MAX_SAFE_INTEGER + 1).is_err());
    }

    #[test]
    fn a_suite_3_object_is_a_bucket_with_or_without_a_thumbnail() {
        for size in [0, 1, 255, 257, 4000, 70_000, CHUNK_BYTES - 300, CHUNK_BYTES, 500_000_000] {
            for thumbnail in [0, 1, 2000, THUMBNAIL_MAX_BYTES] {
                let layout = content_layout(CONTENT_SUITE, size, thumbnail).unwrap();
                let seen = layout.ciphertext_size - TAG_BYTES as u64 * layout.chunk_count;
                let trailer = if thumbnail > 0 { thumbnail as u64 + 16 } else { 0 };
                assert_eq!(seen, padded_length(size + trailer).unwrap(), "{size} {thumbnail}");
                assert_eq!(layout.content_length + trailer, seen);
                assert!(layout.content_length >= size);
                assert_eq!(layout.chunk_count, layout.content_length.div_ceil(CHUNK_BYTES).max(1));
            }
        }
    }

    #[test]
    fn suite_3_chunks_carry_the_file_then_zeros_and_open_to_the_file_alone() {
        let size = CHUNK_BYTES + 3;
        let content = content(size, 500);
        let layout = content_layout(CONTENT_SUITE, size, 500).unwrap();
        assert_eq!(layout.chunk_count, 2);
        let first = chunk_encrypt(content.clone(), 0, vec![1u8; CHUNK_BYTES as usize]).unwrap();
        let last = chunk_encrypt(content.clone(), 1, vec![2, 3, 4]).unwrap();
        let trailer = thumbnail_encrypt(content.clone(), vec![9; 500]).unwrap();
        assert_eq!((first.len() + last.len() + trailer.len()) as u64, layout.ciphertext_size);
        // Under the raw cipher the last chunk is the file's three bytes, then zeros.
        let raw = open_with_nonce(
            &content.key,
            &chunk_nonce(&content, 1).unwrap(),
            &last,
            &chunk_context(&content, 1, 2),
        )
        .unwrap();
        assert_eq!(&raw[..3], &[2, 3, 4]);
        assert!(raw.len() > 3 && raw[3..].iter().all(|b| *b == 0));
        // The reader gets the file back and nothing more, from the range chunk_range names.
        let mut object = first.clone();
        object.extend_from_slice(&last);
        object.extend_from_slice(&trailer);
        let range = chunk_range(CONTENT_SUITE, size, 500, 1).unwrap();
        assert_eq!(range.end + 1, object.len() as u64);
        let tail = object[range.start as usize..].to_vec();
        assert_eq!(chunk_decrypt(content.clone(), 1, tail.clone()).unwrap(), vec![2, 3, 4]);
        let window = thumbnail_range(CONTENT_SUITE, size, 500).unwrap();
        assert_eq!(
            thumbnail_decrypt(content.clone(), object[window.start as usize..].to_vec()).unwrap(),
            vec![9; 500]
        );
        // Opened as suite 2, as another thumbnail length (another padding), or another size: refused.
        for wrong in [
            Content { suite: UNPADDED_CONTENT_SUITE, ..content.clone() },
            Content { thumbnail_bytes: 0, ..content.clone() },
            Content { plaintext_size: size + 1, ..content.clone() },
        ] {
            assert!(chunk_decrypt(wrong, 1, tail.clone()).is_err());
        }
        // The app hands over the file's bytes only; padding it itself is refused.
        assert!(matches!(chunk_encrypt(content.clone(), 1, raw), Err(CoreError::Input(_))));
        assert!(matches!(chunk_encrypt(content, 2, vec![]), Err(CoreError::Input(_))));
    }

    #[test]
    fn a_chunk_of_padding_alone_opens_to_nothing() {
        // 8 MiB exactly plus a trailer pads past the chunk boundary into a second chunk of zeros.
        let content = content(CHUNK_BYTES, 60_000);
        let layout = content_layout(CONTENT_SUITE, CHUNK_BYTES, 60_000).unwrap();
        assert_eq!(layout.chunk_count, 2);
        assert_eq!(chunk_length(CHUNK_BYTES, 1), 0);
        let sealed = chunk_encrypt(content.clone(), 1, vec![]).unwrap();
        assert!(sealed.len() > TAG_BYTES);
        assert_eq!(chunk_decrypt(content, 1, sealed).unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn the_thumbnail_uses_its_own_derived_key_after_the_last_chunk() {
        let content = content(100, 5);
        let sealed = thumbnail_encrypt(content.clone(), vec![9; 5]).unwrap();
        assert_eq!(sealed.len(), 5 + TAG_BYTES);
        assert_eq!(thumbnail_decrypt(content.clone(), sealed.clone()).unwrap(), vec![9; 5]);
        // What thumbnail_range fetches: the object's tail, the last chunk's bytes before the trailer.
        let mut window = vec![7u8; 116];
        window.extend_from_slice(&sealed);
        assert_eq!(thumbnail_decrypt(content.clone(), window).unwrap(), vec![9; 5]);
        // A window cut short of the trailer must not open.
        assert!(matches!(
            thumbnail_decrypt(content.clone(), sealed[1..].to_vec()),
            Err(CoreError::Sealed(_))
        ));
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
        assert!(matches!(thumbnail_decrypt(legacy, sealed.clone()), Err(CoreError::Input(_))));
        // A suite 3 trailer is not a suite 2 one: the suite is in its context.
        let mut unpadded = content.clone();
        unpadded.suite = UNPADDED_CONTENT_SUITE;
        assert!(matches!(thumbnail_decrypt(unpadded, sealed), Err(CoreError::Sealed(_))));
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

    fn origin_ctx(origin: &[u8], key_epoch: u64) -> OriginKeyContext {
        OriginKeyContext {
            workspace_id: "11111111-1111-4111-8111-111111111111".into(),
            node_id: "22222222-2222-4222-8222-222222222222".into(),
            key_epoch,
            record: OriginRecord::Metadata { metadata_version: 4 },
            origin_envelope: origin.to_vec(),
        }
    }

    #[test]
    fn the_origin_key_context_is_the_web_s_array_under_its_own_label() {
        let origin = b"origin".to_vec();
        let digest = crate::signatures::digest(&origin);
        assert_eq!(
            String::from_utf8(origin_key_context(&origin_ctx(&origin, 3)).unwrap()).unwrap(),
            format!(
                r#"["hushos/drive/origin-key",1,"11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222","metadata",4,3,"{digest}"]"#
            )
        );
        let version = OriginKeyContext {
            record: OriginRecord::Version { version_id: "44444444-4444-4444-8444-444444444444".into() },
            ..origin_ctx(&origin, 3)
        };
        assert_eq!(
            String::from_utf8(origin_key_context(&version).unwrap()).unwrap(),
            format!(
                r#"["hushos/drive/origin-key",1,"11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222","version","44444444-4444-4444-8444-444444444444",3,"{digest}"]"#
            )
        );
    }

    #[test]
    fn a_wrapped_origin_key_never_opens_as_a_node_or_content_key_and_neither_opens_as_it() {
        let node_key = random(32);
        let origin = random(296);
        let origin_key = random(32);
        let wrapped = origin_key_wrap(origin_ctx(&origin, 3), node_key.clone(), origin_key.clone()).unwrap();
        assert_eq!(wrapped.len(), KEY_ENVELOPE_BYTES);
        assert_eq!(
            origin_key_open(origin_ctx(&origin, 3), node_key.clone(), wrapped.clone()).unwrap(),
            origin_key
        );
        let as_node = NodeKeyContext {
            node_id: "22222222-2222-4222-8222-222222222222".into(),
            key_epoch: 3,
            parent_key_epoch: 3,
            ..node_ctx()
        };
        assert!(matches!(
            node_open(as_node.clone(), node_key.clone(), wrapped.clone()),
            Err(CoreError::Sealed(_))
        ));
        assert!(matches!(
            version_open(version_ctx(), LEGACY_CONTENT_SUITE, node_key.clone(), wrapped.clone(), Some(1)),
            Err(CoreError::Sealed(_))
        ));
        let content = ContentKey { key: origin_key.clone().into(), plaintext_size: 0, thumbnail_bytes: 0 };
        for other in [
            node_wrap(as_node, node_key.clone(), origin_key.clone()).unwrap(),
            version_reseal(version_ctx(), LEGACY_CONTENT_SUITE, node_key.clone(), content).unwrap(),
        ] {
            assert!(matches!(
                origin_key_open(origin_ctx(&origin, 3), node_key.clone(), other),
                Err(CoreError::Sealed(_))
            ));
        }
        // Bound to the epoch, the record and the origin's bytes.
        assert!(origin_key_open(origin_ctx(&origin, 4), node_key.clone(), wrapped.clone()).is_err());
        let as_version = OriginKeyContext {
            record: OriginRecord::Version { version_id: "99999999-9999-4999-8999-999999999999".into() },
            ..origin_ctx(&origin, 3)
        };
        assert!(origin_key_open(as_version, node_key.clone(), wrapped.clone()).is_err());
        let mut flipped = origin.clone();
        flipped[40] ^= 1;
        assert!(origin_key_open(origin_ctx(&flipped, 3), node_key, wrapped).is_err());
    }

    #[test]
    fn a_second_rotation_carries_the_origin_byte_for_byte_and_rewraps_only_its_key() {
        let (first, second, third) = (random(32), random(32), random(32));
        let ctx = MetadataContext {
            workspace_id: "11111111-1111-4111-8111-111111111111".into(),
            node_id: "22222222-2222-4222-8222-222222222222".into(),
            metadata_version: 4,
        };
        let metadata = NodeMetadata {
            name: "Sam's notes".into(),
            mime: None,
            size: Some(3),
            modified: None,
            attributes: Default::default(),
        };
        let origin = metadata_seal(ctx.clone(), first.clone(), metadata.clone()).unwrap();
        let at_two = origin_key_wrap(
            origin_ctx(&origin, 2),
            second.clone(),
            origin_opening_key(origin.clone(), first.clone()).unwrap(),
        )
        .unwrap();
        let current_two = metadata_rekey(ctx.clone(), first, second.clone(), origin.clone()).unwrap();
        // The next rotation takes the key out of its wrap, never from a node key.
        let carried = origin_key_open(origin_ctx(&origin, 2), second.clone(), at_two.clone()).unwrap();
        let at_three = origin_key_wrap(origin_ctx(&origin, 3), third.clone(), carried).unwrap();
        let current_three = metadata_rekey(ctx.clone(), second, third.clone(), current_two).unwrap();
        let opened = origin_key_open(origin_ctx(&origin, 3), third.clone(), at_three).unwrap();
        let aad = metadata_context(&ctx).unwrap();
        assert_eq!(
            crate::envelope::open_with_opening_key(&opened, &origin, &aad).unwrap(),
            open(&third, &current_three, &aad).unwrap()
        );
        assert_eq!(metadata_open(ctx, third.clone(), current_three).unwrap(), metadata);
        assert!(
            origin_key_open(origin_ctx(&origin, 3), third, at_two).is_err(),
            "the old wrap is not the new epoch's"
        );
    }

    #[test]
    fn a_rekey_refuses_envelopes_of_the_wrong_length_for_their_record() {
        let (old, new) = (random(32), random(32));
        let sealed = version_seal(version_ctx(), old.clone(), random(32), 10, 0).unwrap().envelope;
        let rekeyed =
            version_rekey(version_ctx(), CONTENT_SUITE, old.clone(), new.clone(), sealed.clone()).unwrap();
        assert_eq!(
            version_open(version_ctx(), CONTENT_SUITE, new.clone(), rekeyed, None).unwrap().plaintext_size,
            10
        );
        assert!(matches!(
            version_rekey(version_ctx(), LEGACY_CONTENT_SUITE, old.clone(), new.clone(), sealed.clone()),
            Err(CoreError::Input(_))
        ));
        assert!(matches!(
            version_rekey(version_ctx(), 4, old.clone(), new.clone(), sealed),
            Err(CoreError::Input(_))
        ));
        let ctx = MetadataContext {
            workspace_id: "11111111-1111-4111-8111-111111111111".into(),
            node_id: "22222222-2222-4222-8222-222222222222".into(),
            metadata_version: 1,
        };
        assert!(metadata_rekey(ctx, old, new, vec![0; METADATA_ENVELOPE_MAX_BYTES + 1]).is_err());
    }

    #[test]
    fn contexts_take_what_the_web_takes_lowercase_uuids_and_epochs_from_1_to_2_53_minus_1() {
        let key = random(32);
        let origin = random(296);
        let ws = "11111111-1111-4111-8111-111111111111";
        let n1 = "22222222-2222-4222-8222-222222222222";
        // The origin key's context: epoch 0, an epoch past the web's integers, ids that are no lowercase UUID.
        for ctx in [
            origin_ctx(&origin, 0),
            origin_ctx(&origin, MAX_SAFE_INTEGER + 1),
            OriginKeyContext {
                workspace_id: "0B6F0E1C-6A52-4F37-9D0E-5F1F2A3B4C5D".into(),
                ..origin_ctx(&origin, 3)
            },
            OriginKeyContext { node_id: "n1".into(), ..origin_ctx(&origin, 3) },
            OriginKeyContext {
                record: OriginRecord::Metadata { metadata_version: 0 },
                ..origin_ctx(&origin, 3)
            },
            OriginKeyContext {
                record: OriginRecord::Version { version_id: "v1".into() },
                ..origin_ctx(&origin, 3)
            },
        ] {
            assert!(
                matches!(origin_key_wrap(ctx.clone(), key.clone(), random(32)), Err(CoreError::Input(_))),
                "{ctx:?}"
            );
        }
        assert!(origin_key_wrap(origin_ctx(&origin, MAX_SAFE_INTEGER), key.clone(), random(32)).is_ok());
        // Metadata and version envelopes alike.
        let metadata = NodeMetadata {
            name: "a".into(),
            mime: None,
            size: None,
            modified: None,
            attributes: Default::default(),
        };
        for ctx in [
            MetadataContext { workspace_id: "ws".into(), node_id: n1.into(), metadata_version: 1 },
            MetadataContext {
                workspace_id: ws.into(),
                node_id: "0B6F0E1C-6A52-4F37-9D0E-5F1F2A3B4C5D".into(),
                metadata_version: 1,
            },
            MetadataContext { workspace_id: ws.into(), node_id: n1.into(), metadata_version: 0 },
        ] {
            assert!(matches!(metadata_seal(ctx, key.clone(), metadata.clone()), Err(CoreError::Input(_))));
        }
        let bad = VersionContext { object_id: "obj".into(), ..version_ctx() };
        assert!(matches!(version_seal(bad, key.clone(), random(32), 1, 0), Err(CoreError::Input(_))));
    }

    #[test]
    fn a_previous_root_key_opens_only_under_its_own_label_and_only_for_a_root() {
        let ws = "aaaaaaaa-1111-4111-8111-111111111111".to_string();
        let ctx = NodeKeyContext {
            workspace_id: ws.clone(),
            node_id: "22222222-2222-4222-8222-222222222222".into(),
            parent_id: ws.clone(),
            parent_key_epoch: 2,
            key_epoch: 1,
        };
        let (root_key, area_key) = (random(32), random(32));
        let previous = previous_root_key_wrap(ctx.clone(), area_key.clone(), root_key.clone()).unwrap();
        // Never a node key, nor a node key envelope a previous root key.
        assert!(node_open(ctx.clone(), area_key.clone(), previous.clone()).is_err());
        let as_node = node_wrap(ctx.clone(), area_key.clone(), root_key.clone()).unwrap();
        assert!(previous_root_key_open(ctx.clone(), area_key.clone(), as_node).is_err());
        // Bound to its epochs: the same envelope at another key epoch opens nothing.
        assert!(previous_root_key_open(
            NodeKeyContext { key_epoch: 2, ..ctx.clone() },
            area_key.clone(),
            previous
        )
        .is_err());
        // Only a root has one, and only over lowercase ids and real epochs, as the web refuses them.
        let child =
            NodeKeyContext { parent_id: "33333333-3333-4333-8333-333333333333".into(), ..ctx.clone() };
        assert!(previous_root_key_wrap(child, area_key.clone(), root_key.clone()).is_err());
        let upper =
            NodeKeyContext { workspace_id: ws.to_uppercase(), parent_id: ws.to_uppercase(), ..ctx.clone() };
        assert!(previous_root_key_wrap(upper, area_key.clone(), root_key.clone()).is_err());
        assert!(previous_root_key_wrap(NodeKeyContext { key_epoch: 0, ..ctx }, area_key, root_key).is_err());
    }
}
