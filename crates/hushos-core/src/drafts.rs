//! An editor's unsaved text, sealed on the device it was typed on
//! (docs/editing-design.md 3, "Draft"): the twin of `packages/crypto/src/account/drafts.ts`,
//! held to it by `fixtures/drafts.json`.
//!
//! Key: HKDF-SHA-256 of the account root, salt 32 zero bytes, info the compact
//! JSON `["hushos/drafts/v1",userId,workspaceId,nodeId]`, so each file has its own
//! key and only an unlocked session of the account derives it. The workspace is
//! in it as well as the node: a share's node named like one of the account's own
//! files must never be offered that file's text. Under the root, not the
//! settings key: a master-key rotation makes older drafts unreadable, and the
//! apps drop them.
//!
//! Slot: where the record is kept, the first 16 bytes of the same HKDF under
//! `["hushos/drafts/slot/v1",userId,workspaceId,nodeId]`, base64url, so the
//! store says which files have a draft to no one without the unlocked account.
//!
//! Record: compact JSON `{v, savedAt, sealed}`, the time alone in the clear (the
//! caps read it), bound by the associated data
//! `["hushos/drafts",1,userId,workspaceId,nodeId,savedAt]`: a record moved to
//! another file or account, or given another time, does not open. Everything
//! else is sealed, so a locked device sees how many drafts there are, when each
//! was written and how large it is, and nothing that names a file: no node or
//! version id.
//!
//! Envelope: `[1][24-byte nonce][XChaCha20-Poly1305]`, base64url. Plaintext: a
//! 32-bit big-endian length, then that many bytes of header, the compact JSON
//! `[base,encoding,lineEnding,mixed,from,to,source]` (the version the text
//! started from, the session's save format, the selection's ends as UTF-16
//! offsets with `0xFFFFFFFF` for none, and the version the session first read its
//! text from, `""` for none), then the text in UTF-8.

use crate::bytes::{decode, encode, random, NONCE_BYTES, TAG_BYTES};
use crate::canonical::{encode_statement, parse_statement, uuid};
use crate::contacts::hkdf;
use crate::envelope::{open_with_nonce, seal_with_nonce};
use crate::error::{input, CoreError, CoreResult};
use crate::text_edit::{LineEnding, TextEncoding, TextFormat};
use serde_json::{json, Value};
use zeroize::Zeroizing;

const LABEL: &str = "hushos/drafts/v1";
const SLOT_LABEL: &str = "hushos/drafts/slot/v1";
const WORKSPACE_LABEL: &str = "hushos/drafts/workspace/v1";
const DOMAIN: &str = "hushos/drafts";
const VERSION: u8 = 1;
const NO_OFFSET: u32 = u32::MAX;
const UNREADABLE: &str = "This draft could not be opened.";
/* The largest integer a JavaScript reader keeps exactly: the web's times are numbers. */
const MAX_SAFE: u64 = (1 << 53) - 1;

/// The most text a draft holds, in UTF-8 bytes: the editor's own limit.
pub const DRAFT_TEXT_LIMIT: u64 = 8 * 1024 * 1024;
/// Drafts kept per account on one device; the oldest go first.
pub const DRAFTS_PER_ACCOUNT: u32 = 50;
/// A draft older than this (milliseconds) is dropped, never offered.
pub const DRAFT_MAX_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1000;

/// The bounds every client keeps drafts to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct DraftLimits {
    pub text_bytes: u64,
    pub per_account: u32,
    pub max_age_ms: u64,
}

/// The drafts' bounds.
///
/// ```
/// let limits = hushos_core::draft_limits();
/// assert_eq!((limits.text_bytes, limits.per_account), (8 * 1024 * 1024, 50));
/// assert_eq!(limits.max_age_ms, 30 * 24 * 60 * 60 * 1000);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn draft_limits() -> DraftLimits {
    DraftLimits {
        text_bytes: DRAFT_TEXT_LIMIT,
        per_account: DRAFTS_PER_ACCOUNT,
        max_age_ms: DRAFT_MAX_AGE_MS,
    }
}

/// What a restore needs before the text: the version the text started from, the
/// session's save format (kept for the whole session, never found again from what
/// was saved), and when it was written, in milliseconds since the epoch.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct DraftFrame {
    pub base_version_id: String,
    pub format: TextFormat,
    pub saved_at: u64,
}

/// A selection in UTF-16 offsets, as `UITextView` and `EditText` count them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct DraftSelection {
    pub from: u32,
    pub to: u32,
}

/// An editor's unsaved text with its frame.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct Draft {
    pub frame: DraftFrame,
    pub text: String,
    pub selection: Option<DraftSelection>,
    /// The version the session first read its text from: what a copy is signed
    /// from. `None` when it couldn't be told.
    pub source_version_id: Option<String>,
}

struct Place {
    user: String,
    workspace: String,
    node: String,
}

fn place(user_id: &str, workspace_id: &str, node_id: &str) -> CoreResult<Place> {
    let lower = |value: &str, what: &str| -> CoreResult<String> {
        let lowered = value.to_lowercase();
        uuid(&lowered, what)?;
        Ok(lowered)
    };
    Ok(Place {
        user: lower(user_id, "user id")?,
        workspace: lower(workspace_id, "workspace id")?,
        node: lower(node_id, "node id")?,
    })
}

fn encoding_name(encoding: TextEncoding) -> &'static str {
    match encoding {
        TextEncoding::Utf8 => "utf-8",
        TextEncoding::Utf8Bom => "utf-8-bom",
        TextEncoding::Utf16Le => "utf-16le",
        TextEncoding::Utf16Be => "utf-16be",
    }
}

fn encoding_of(name: &str) -> Option<TextEncoding> {
    Some(match name {
        "utf-8" => TextEncoding::Utf8,
        "utf-8-bom" => TextEncoding::Utf8Bom,
        "utf-16le" => TextEncoding::Utf16Le,
        "utf-16be" => TextEncoding::Utf16Be,
        _ => return None,
    })
}

fn line_ending_name(line_ending: LineEnding) -> &'static str {
    match line_ending {
        LineEnding::Lf => "lf",
        LineEnding::Crlf => "crlf",
    }
}

fn line_ending_of(name: &str) -> Option<LineEnding> {
    Some(match name {
        "lf" => LineEnding::Lf,
        "crlf" => LineEnding::Crlf,
        _ => return None,
    })
}

fn derive(account_key: &[u8], label: &str, at: &Place) -> CoreResult<Zeroizing<[u8; 32]>> {
    if account_key.len() != 32 {
        return Err(input("Invalid account key."));
    }
    let info = encode_statement(&[json!(label), json!(at.user), json!(at.workspace), json!(at.node)])?;
    hkdf(account_key, &info)
}

/* The frame checked, its version id lowercased. */
fn checked(frame: &DraftFrame) -> CoreResult<DraftFrame> {
    let base = frame.base_version_id.to_lowercase();
    uuid(&base, "version id")?;
    if frame.saved_at > MAX_SAFE {
        return Err(input("Invalid draft time."));
    }
    Ok(DraftFrame { base_version_id: base, format: frame.format, saved_at: frame.saved_at })
}

/* The associated data: the record's time, bound to its account and file. */
fn context(at: &Place, saved_at: u64) -> CoreResult<Vec<u8>> {
    encode_statement(&[
        json!(DOMAIN),
        json!(VERSION),
        json!(at.user),
        json!(at.workspace),
        json!(at.node),
        json!(saved_at),
    ])
}

fn refused() -> CoreError {
    CoreError::Sealed(UNREADABLE.into())
}

/// Where a file's draft is kept on the device: a name only the unlocked account
/// works out.
///
/// ```
/// let key = vec![7u8; 32];
/// let user = "6b1a3f0e-2c4d-4e5f-8a9b-0c1d2e3f4a5b";
/// let workspace = "0d4f2a1b-9c8e-4f7a-b6d5-e4c3b2a1f0e9";
/// let node = "5f0c1d2e-3a4b-4c5d-9e6f-7a8b9c0d1e2f";
/// let slot = hushos_core::draft_slot(key.clone(), user.into(), workspace.into(), node.into())?;
/// assert_eq!(slot.len(), 22);
/// assert_ne!(slot, hushos_core::draft_slot(vec![8u8; 32], user.into(), workspace.into(), node.into())?);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn draft_slot(
    account_key: Vec<u8>,
    user_id: String,
    workspace_id: String,
    node_id: String,
) -> CoreResult<String> {
    let account_key = Zeroizing::new(account_key);
    let at = place(&user_id, &workspace_id, &node_id)?;
    let derived = derive(&account_key, SLOT_LABEL, &at)?;
    Ok(encode(&derived[..16]))
}

/// A workspace's tag: what a phone files its drafts under, so a family's removal
/// deletes that family's drafts without opening any, and without naming the
/// workspace to anyone but the unlocked account.
///
/// ```
/// let key = vec![7u8; 32];
/// let user = "6b1a3f0e-2c4d-4e5f-8a9b-0c1d2e3f4a5b";
/// let tag = hushos_core::draft_workspace_tag(key.clone(), user.into(), "0d4f2a1b-9c8e-4f7a-b6d5-e4c3b2a1f0e9".into())?;
/// assert_eq!(tag.len(), 22);
/// assert_ne!(tag, hushos_core::draft_workspace_tag(key, user.into(), "1d4f2a1b-9c8e-4f7a-b6d5-e4c3b2a1f0e9".into())?);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn draft_workspace_tag(
    account_key: Vec<u8>,
    user_id: String,
    workspace_id: String,
) -> CoreResult<String> {
    let account_key = Zeroizing::new(account_key);
    if account_key.len() != 32 {
        return Err(input("Invalid account key."));
    }
    let lower = |value: &str, what: &str| -> CoreResult<String> {
        let lowered = value.to_lowercase();
        uuid(&lowered, what)?;
        Ok(lowered)
    };
    let info = encode_statement(&[
        json!(WORKSPACE_LABEL),
        json!(lower(&user_id, "user id")?),
        json!(lower(&workspace_id, "workspace id")?),
    ])?;
    Ok(encode(&hkdf(&account_key, &info)?[..16]))
}

/* The sealed header: base, encoding, line ending, mixed, selection's ends, source ("" for none). */
fn header(draft: &Draft, frame: &DraftFrame) -> CoreResult<Vec<u8>> {
    let (from, to) = match draft.selection {
        Some(selection) if selection.from != NO_OFFSET && selection.to != NO_OFFSET => {
            (selection.from, selection.to)
        }
        Some(_) => return Err(input("Invalid selection.")),
        None => (NO_OFFSET, NO_OFFSET),
    };
    let source = match &draft.source_version_id {
        Some(source) => {
            let lowered = source.to_lowercase();
            uuid(&lowered, "version id")?;
            lowered
        }
        None => String::new(),
    };
    encode_statement(&[
        json!(frame.base_version_id),
        json!(encoding_name(frame.format.encoding)),
        json!(line_ending_name(frame.format.line_ending)),
        json!(u8::from(frame.format.mixed)),
        json!(from),
        json!(to),
        json!(source),
    ])
}

fn plaintext(draft: &Draft, frame: &DraftFrame) -> CoreResult<Zeroizing<Vec<u8>>> {
    if draft.text.len() as u64 > DRAFT_TEXT_LIMIT {
        return Err(input("This text is too large to keep."));
    }
    let head = header(draft, frame)?;
    let mut out = Zeroizing::new(Vec::with_capacity(4 + head.len() + draft.text.len()));
    out.extend_from_slice(&(head.len() as u32).to_be_bytes());
    out.extend_from_slice(&head);
    out.extend_from_slice(draft.text.as_bytes());
    Ok(out)
}

fn seal_draft_with_nonce(account_key: &[u8], at: &Place, draft: &Draft, nonce: &[u8]) -> CoreResult<String> {
    let frame = checked(&draft.frame)?;
    let aad = context(at, frame.saved_at)?;
    let body = plaintext(draft, &frame)?;
    let key = derive(account_key, LABEL, at)?;
    let sealed = seal_with_nonce(key.as_slice(), nonce, &body, &aad)?;
    let mut envelope = Vec::with_capacity(1 + NONCE_BYTES + sealed.len());
    envelope.push(VERSION);
    envelope.extend_from_slice(nonce);
    envelope.extend_from_slice(&sealed);
    // In the web's key order; nothing needs escaping, so both twins write the same bytes.
    Ok(format!(r#"{{"v":{VERSION},"savedAt":{},"sealed":"{}"}}"#, frame.saved_at, encode(&envelope)))
}

/// The record a phone keeps for this file's draft: its time beside the sealed
/// frame, source and text. Refused past 8 MiB of text.
///
/// ```
/// use hushos_core::*;
/// let key = vec![7u8; 32];
/// let (user, workspace, node) = (
///     "6b1a3f0e-2c4d-4e5f-8a9b-0c1d2e3f4a5b",
///     "0d4f2a1b-9c8e-4f7a-b6d5-e4c3b2a1f0e9",
///     "5f0c1d2e-3a4b-4c5d-9e6f-7a8b9c0d1e2f",
/// );
/// let draft = Draft {
///     frame: DraftFrame {
///         base_version_id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d".into(),
///         format: TextFormat { encoding: TextEncoding::Utf8, line_ending: LineEnding::Lf, mixed: false },
///         saved_at: 1_763_650_440_000,
///     },
///     text: "Unsaved words".into(),
///     selection: Some(DraftSelection { from: 3, to: 3 }),
///     source_version_id: Some("9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d".into()),
/// };
/// let record = draft_seal(key.clone(), user.into(), workspace.into(), node.into(), draft.clone())?;
/// assert!(!record.contains(node) && !record.contains("9a8b7c6d"));
/// assert_eq!(draft_open(key, user.into(), workspace.into(), node.into(), record)?, draft);
/// # Ok::<(), CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn draft_seal(
    account_key: Vec<u8>,
    user_id: String,
    workspace_id: String,
    node_id: String,
    draft: Draft,
) -> CoreResult<String> {
    let account_key = Zeroizing::new(account_key);
    let at = place(&user_id, &workspace_id, &node_id)?;
    seal_draft_with_nonce(&account_key, &at, &draft, &random(NONCE_BYTES))
}

struct Parsed {
    saved_at: u64,
    envelope: Vec<u8>,
}

fn parse(record: &str) -> CoreResult<Parsed> {
    let value: Value = serde_json::from_str(record).map_err(|_| refused())?;
    let field = |name: &str| value.get(name).ok_or_else(refused);
    if field("v")?.as_u64() != Some(u64::from(VERSION)) {
        return Err(refused());
    }
    let saved_at = field("savedAt")?.as_u64().filter(|at| *at <= MAX_SAFE).ok_or_else(refused)?;
    let envelope =
        decode("draft", field("sealed")?.as_str().ok_or_else(refused)?, None).map_err(|_| refused())?;
    if envelope.len() < 1 + NONCE_BYTES + TAG_BYTES + 4 || envelope[0] != VERSION {
        return Err(refused());
    }
    Ok(Parsed { saved_at, envelope })
}

/// When a record was written, read without a key and without decoding its
/// envelope; `None` for one that doesn't say.
///
/// ```
/// assert_eq!(hushos_core::draft_saved_at("not a draft".into()), None);
/// assert_eq!(hushos_core::draft_saved_at(r#"{"v":1,"savedAt":12,"sealed":"x"}"#.into()), Some(12));
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn draft_saved_at(record: String) -> Option<u64> {
    let value: Value = serde_json::from_str(&record).ok()?;
    let saved_at = value.get("savedAt")?.as_u64()?;
    (value.get("v")?.as_u64()? == u64::from(VERSION) && saved_at <= MAX_SAFE).then_some(saved_at)
}

fn text_field(parts: &[Value], at: usize) -> CoreResult<&str> {
    parts.get(at).and_then(Value::as_str).ok_or_else(refused)
}

fn int_field(parts: &[Value], at: usize) -> CoreResult<u64> {
    parts.get(at).and_then(Value::as_u64).ok_or_else(refused)
}

/// The draft a record holds for this account and file, or `Sealed` when it does
/// not open here: another account, file or time, a changed byte, or another
/// root. Never "none".
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn draft_open(
    account_key: Vec<u8>,
    user_id: String,
    workspace_id: String,
    node_id: String,
    record: String,
) -> CoreResult<Draft> {
    let account_key = Zeroizing::new(account_key);
    let at = place(&user_id, &workspace_id, &node_id)?;
    let Parsed { saved_at, envelope } = parse(&record)?;
    let aad = context(&at, saved_at)?;
    let key = derive(&account_key, LABEL, &at)?;
    let body = Zeroizing::new(
        open_with_nonce(key.as_slice(), &envelope[1..1 + NONCE_BYTES], &envelope[1 + NONCE_BYTES..], &aad)
            .map_err(|_| refused())?,
    );
    if body.len() < 4 {
        return Err(refused());
    }
    let length = u32::from_be_bytes([body[0], body[1], body[2], body[3]]) as usize;
    let head = body.get(4..4 + length).ok_or_else(refused)?;
    let parts = parse_statement(head, "draft").map_err(|_| refused())?;
    if parts.len() != 7 {
        return Err(refused());
    }
    let format = TextFormat {
        encoding: encoding_of(text_field(&parts, 1)?).ok_or_else(refused)?,
        line_ending: line_ending_of(text_field(&parts, 2)?).ok_or_else(refused)?,
        mixed: match int_field(&parts, 3)? {
            0 => false,
            1 => true,
            _ => return Err(refused()),
        },
    };
    let frame = checked(&DraftFrame { base_version_id: text_field(&parts, 0)?.to_owned(), format, saved_at })
        .map_err(|_| refused())?;
    let (from, to) = (int_field(&parts, 4)?, int_field(&parts, 5)?);
    if from > u64::from(NO_OFFSET)
        || to > u64::from(NO_OFFSET)
        || (from == u64::from(NO_OFFSET)) != (to == u64::from(NO_OFFSET))
    {
        return Err(refused());
    }
    let source = text_field(&parts, 6)?;
    let source_version_id = if source.is_empty() {
        None
    } else {
        uuid(source, "version id").map_err(|_| refused())?;
        Some(source.to_owned())
    };
    let text = String::from_utf8(body[4 + length..].to_vec()).map_err(|_| refused())?;
    Ok(Draft {
        frame,
        text,
        selection: (from != u64::from(NO_OFFSET))
            .then_some(DraftSelection { from: from as u32, to: to as u32 }),
        source_version_id,
    })
}

/// What reopening a file does with its draft.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum DraftOffer {
    /// The text is what the file holds now: the draft is dropped, nothing offered.
    Same,
    /// The file is still at the version the text started from: restored as an edit.
    Current,
    /// Someone saved since (or the version can't be told): restored only through
    /// the stale choices, never as an edit of their version.
    Stale,
}

/// Whether a draft is offered, and how, against the file as it opened now.
///
/// ```
/// use hushos_core::{draft_offer, DraftOffer};
/// let base = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d".to_string();
/// let other = "1a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d".to_string();
/// assert_eq!(draft_offer(base.clone(), "mine".into(), Some(base.clone()), "theirs".into()), DraftOffer::Current);
/// assert_eq!(draft_offer(base.clone(), "mine".into(), Some(other), "theirs".into()), DraftOffer::Stale);
/// assert_eq!(draft_offer(base, "same".into(), None, "same".into()), DraftOffer::Same);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn draft_offer(
    draft_base_version_id: String,
    draft_text: String,
    opened_version_id: Option<String>,
    opened_text: String,
) -> DraftOffer {
    if draft_text == opened_text {
        return DraftOffer::Same;
    }
    match opened_version_id {
        Some(opened) if opened.to_lowercase() == draft_base_version_id.to_lowercase() => DraftOffer::Current,
        _ => DraftOffer::Stale,
    }
}

/// One stored draft: its slot, and when it was written (`None`: unreadable).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct DraftEntry {
    pub slot: String,
    pub saved_at: Option<u64>,
}

/// The slots to delete so what is left keeps the caps: anything unreadable,
/// anything older than 30 days, then the oldest past 50. `keep` (the draft being
/// written) is never dropped, and counts.
///
/// ```
/// use hushos_core::{drafts_to_drop, DraftEntry};
/// let day = 24 * 60 * 60 * 1000;
/// let now = 100 * day;
/// let entries = vec![
///     DraftEntry { slot: "a".into(), saved_at: Some(now - 31 * day) },
///     DraftEntry { slot: "b".into(), saved_at: Some(now - day) },
///     DraftEntry { slot: "c".into(), saved_at: None },
/// ];
/// assert_eq!(drafts_to_drop(entries, now, None), vec!["a".to_string(), "c".to_string()]);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn drafts_to_drop(entries: Vec<DraftEntry>, now: u64, keep: Option<String>) -> Vec<String> {
    let mut drop = std::collections::BTreeSet::new();
    let mut kept: Vec<(String, u64)> = Vec::new();
    for entry in entries {
        if Some(&entry.slot) == keep.as_ref() {
            continue;
        }
        match entry.saved_at {
            Some(at) if now.saturating_sub(at) <= DRAFT_MAX_AGE_MS => kept.push((entry.slot, at)),
            _ => {
                drop.insert(entry.slot);
            }
        }
    }
    let room = DRAFTS_PER_ACCOUNT as usize - usize::from(keep.is_some());
    // Newest first; ties by slot, so every client drops the same ones.
    kept.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    for (slot, _) in kept.into_iter().skip(room) {
        drop.insert(slot);
    }
    drop.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "6B1A3F0E-2C4D-4E5F-8A9B-0C1D2E3F4A5B";
    const WORKSPACE: &str = "0d4f2a1b-9c8e-4f7a-b6d5-e4c3b2a1f0e9";
    const NODE: &str = "5f0c1d2e-3a4b-4c5d-9e6f-7a8b9c0d1e2f";

    fn draft(text: &str) -> Draft {
        Draft {
            frame: DraftFrame {
                base_version_id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d".into(),
                format: TextFormat {
                    encoding: TextEncoding::Utf16Le,
                    line_ending: LineEnding::Crlf,
                    mixed: true,
                },
                saved_at: 1_763_650_440_000,
            },
            text: text.into(),
            selection: None,
            source_version_id: Some("9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d".into()),
        }
    }

    fn fixture() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/drafts.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn s(value: &Value, name: &str) -> String {
        value[name].as_str().unwrap().to_owned()
    }

    fn fixture_draft(value: &Value) -> Draft {
        let frame = &value["frame"];
        Draft {
            frame: DraftFrame {
                base_version_id: s(frame, "baseVersionId"),
                format: TextFormat {
                    encoding: encoding_of(frame["encoding"].as_str().unwrap()).unwrap(),
                    line_ending: line_ending_of(frame["lineEnding"].as_str().unwrap()).unwrap(),
                    mixed: frame["mixed"].as_bool().unwrap(),
                },
                saved_at: frame["savedAt"].as_u64().unwrap(),
            },
            text: s(value, "text"),
            selection: value["selection"].as_object().map(|selection| DraftSelection {
                from: selection["from"].as_u64().unwrap() as u32,
                to: selection["to"].as_u64().unwrap() as u32,
            }),
            source_version_id: value["sourceVersionId"].as_str().map(str::to_owned),
        }
    }

    #[test]
    fn the_key_is_hkdf_of_the_root_under_exactly_hushos_drafts_v1_and_the_file() {
        let f = fixture();
        let root = decode("key", &s(&f, "accountKey"), Some(32)).unwrap();
        // Built here from the literal label, never from the module's constant: a renamed label fails.
        let info = format!(
            r#"["hushos/drafts/v1","{}","{}","{}"]"#,
            s(&f, "userId"),
            s(&f, "workspaceId"),
            s(&f, "nodeId")
        );
        assert_eq!(info, s(&f, "keyInfo"));
        let mut expected = [0u8; 32];
        hkdf::Hkdf::<sha2::Sha256>::new(Some(&[0u8; 32]), &root)
            .expand(info.as_bytes(), &mut expected)
            .unwrap();
        assert_eq!(encode(&expected), s(&f, "key"));
        let at = place(&s(&f, "userId"), &s(&f, "workspaceId"), &s(&f, "nodeId")).unwrap();
        assert_eq!(encode(derive(&root, LABEL, &at).unwrap().as_slice()), s(&f, "key"));
        assert_eq!(
            draft_slot(root.clone(), s(&f, "userId"), s(&f, "workspaceId"), s(&f, "nodeId")).unwrap(),
            s(&f, "slot")
        );
        assert_eq!(
            draft_workspace_tag(root, s(&f, "userId"), s(&f, "workspaceId")).unwrap(),
            s(&f, "workspaceTag")
        );
    }

    #[test]
    fn the_core_seals_the_webs_record_byte_for_byte_and_opens_it() {
        let f = fixture();
        let root = decode("key", &s(&f, "accountKey"), Some(32)).unwrap();
        let nonce = decode("nonce", &s(&f, "nonce"), Some(NONCE_BYTES)).unwrap();
        let draft = fixture_draft(&f["draft"]);
        let at = place(&s(&f, "userId"), &s(&f, "workspaceId"), &s(&f, "nodeId")).unwrap();
        assert_eq!(
            String::from_utf8(context(&at, draft.frame.saved_at).unwrap()).unwrap(),
            s(&f, "associatedData")
        );
        assert!(
            !s(&f, "record").contains(&s(&f, "nodeId"))
                && !s(&f, "record").contains(&draft.frame.base_version_id)
        );
        assert_eq!(seal_draft_with_nonce(&root, &at, &draft, &nonce).unwrap(), s(&f, "record"));
        let opened =
            draft_open(root, s(&f, "userId"), s(&f, "workspaceId"), s(&f, "nodeId"), s(&f, "record"))
                .unwrap();
        assert_eq!(opened, draft);
        assert_eq!(draft_saved_at(s(&f, "record")), Some(draft.frame.saved_at));
    }

    #[test]
    fn a_draft_moved_to_another_account_file_base_format_or_time_or_changed_does_not_open() {
        let f = fixture();
        let refusals = f["refusals"].as_array().unwrap();
        assert!(refusals.len() >= 10);
        for case in refusals {
            let pick = |name: &str| {
                case.get(name).and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| s(&f, name))
            };
            let root = decode("key", &pick("accountKey"), Some(32)).unwrap();
            let result =
                draft_open(root, pick("userId"), pick("workspaceId"), pick("nodeId"), pick("record"));
            assert_eq!(result, Err(refused()), "{}", s(case, "name"));
        }
    }

    #[test]
    fn a_record_names_no_file_and_its_time_is_bound() {
        let key = vec![3u8; 32];
        let record =
            draft_seal(key.clone(), USER.into(), WORKSPACE.into(), NODE.into(), draft("mine")).unwrap();
        // Neither the node nor a version id (base or source) is in what a locked device holds.
        assert!(!record.contains(NODE) && !record.contains("9a8b7c6d"), "{record}");
        let opened =
            draft_open(key.clone(), USER.into(), WORKSPACE.into(), NODE.into(), record.clone()).unwrap();
        assert_eq!(opened, draft("mine"));
        let mut swapped: Value = serde_json::from_str(&record).unwrap();
        swapped["savedAt"] = json!(1_763_650_439_999u64);
        let opened = draft_open(key, USER.into(), WORKSPACE.into(), NODE.into(), swapped.to_string());
        assert_eq!(opened, Err(refused()));
    }

    #[test]
    fn the_restore_decision_matches_the_webs() {
        let f = fixture();
        for case in f["offers"].as_array().unwrap() {
            let offer = draft_offer(
                s(case, "draftBase"),
                s(case, "draftText"),
                case["openedVersion"].as_str().map(str::to_owned),
                s(case, "openedText"),
            );
            let expected = match case["offer"].as_str().unwrap() {
                "same" => DraftOffer::Same,
                "current" => DraftOffer::Current,
                _ => DraftOffer::Stale,
            };
            assert_eq!(offer, expected, "{}", s(case, "name"));
        }
    }

    #[test]
    fn a_draft_past_the_editors_limit_is_refused_and_one_at_it_is_kept() {
        let key = vec![3u8; 32];
        let at = DRAFT_TEXT_LIMIT as usize;
        assert!(draft_seal(
            key.clone(),
            USER.into(),
            WORKSPACE.into(),
            NODE.into(),
            draft(&"a".repeat(at + 1))
        )
        .is_err());
        let record =
            draft_seal(key.clone(), USER.into(), WORKSPACE.into(), NODE.into(), draft(&"a".repeat(at)))
                .unwrap();
        assert_eq!(
            draft_open(key, USER.into(), WORKSPACE.into(), NODE.into(), record).unwrap().text.len(),
            at
        );
    }

    #[test]
    fn a_selection_that_says_none_in_one_half_only_is_refused() {
        let key = vec![3u8; 32];
        let mut half = draft("text");
        half.selection = Some(DraftSelection { from: NO_OFFSET, to: 2 });
        assert!(draft_seal(key, USER.into(), WORKSPACE.into(), NODE.into(), half).is_err());
    }

    #[test]
    fn the_user_id_is_lowercased_so_either_spelling_opens() {
        let key = vec![3u8; 32];
        let record = draft_seal(key.clone(), USER.into(), WORKSPACE.into(), NODE.into(), draft("x")).unwrap();
        assert!(draft_open(key, USER.to_lowercase(), WORKSPACE.into(), NODE.into(), record).is_ok());
    }

    #[test]
    fn caps_drop_the_oldest_past_fifty_and_keep_the_one_being_written() {
        let now = 40 * 24 * 60 * 60 * 1000;
        let entries: Vec<DraftEntry> = (0..55u64)
            .map(|n| DraftEntry { slot: format!("s{n:02}"), saved_at: Some(now - n * 1000) })
            .collect();
        // Fifty kept: the newest, s00 to s49.
        let dropped = drafts_to_drop(entries.clone(), now, None);
        assert_eq!(dropped, (50..55).map(|n| format!("s{n:02}")).collect::<Vec<_>>());
        // Writing the oldest one again keeps it, and makes room for it.
        let dropped = drafts_to_drop(entries, now, Some("s54".into()));
        assert_eq!(dropped, (49..54).map(|n| format!("s{n:02}")).collect::<Vec<_>>());
    }

    #[test]
    fn a_draft_exactly_thirty_days_old_is_kept_and_one_a_millisecond_older_is_dropped() {
        let now = 100 * 24 * 60 * 60 * 1000;
        let entries = vec![
            DraftEntry { slot: "edge".into(), saved_at: Some(now - DRAFT_MAX_AGE_MS) },
            DraftEntry { slot: "past".into(), saved_at: Some(now - DRAFT_MAX_AGE_MS - 1) },
        ];
        assert_eq!(drafts_to_drop(entries, now, None), vec!["past".to_string()]);
    }
}
