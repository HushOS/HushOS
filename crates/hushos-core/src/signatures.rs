//! Writer signatures, as `packages/crypto/signatures.ts` makes them and
//! `docs/integrity-design.md` fixes them: every statement is the compact JSON
//! array the web builds, with lowercase ids and SHA-256 digests (base64url) of
//! the sealed bytes it vouches for, signed detached with the identity's
//! Ed25519 key and verified strictly.
//!
//! Each record has two statement forms: the ordinary one ("I wrote this") and
//! the re-sealed one ("I re-locked this; I don't vouch for who wrote it"),
//! which a rotation or copy signs over a record it could not verify. Their
//! domains differ, so neither signature passes for the other.

use crate::bytes::{encode, expect_len};
use crate::envelope::context;
use crate::error::{input, CoreResult};
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use serde_json::json;
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

/// What a reader can say about who wrote a record. Only `Verified` is
/// clean; every other verdict is shown as Unverified.
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

/* [domain, 1, workspaceId, nodeId, kind, metadataVersion, sha256(metadataEnvelope)] */
fn metadata_parts(domain: &str, statement: &MetadataStatement, envelope: &[u8]) -> CoreResult<Vec<u8>> {
    Ok(context(&[
        json!(domain),
        json!(1),
        json!(statement.workspace_id.to_lowercase()),
        json!(statement.node_id.to_lowercase()),
        json!(statement.kind.as_str()),
        json!(positive(statement.metadata_version, "metadata version")?),
        json!(digest(envelope)),
    ]))
}

/* [domain, 1, workspaceId, nodeId, versionId, objectId, contentSuite, sha256(contentKeyEnvelope)] */
fn version_parts(domain: &str, statement: &VersionStatement, envelope: &[u8]) -> CoreResult<Vec<u8>> {
    Ok(context(&[
        json!(domain),
        json!(1),
        json!(statement.workspace_id.to_lowercase()),
        json!(statement.node_id.to_lowercase()),
        json!(statement.version_id.to_lowercase()),
        json!(statement.object_id.to_lowercase()),
        json!(positive(statement.content_suite as u64, "content suite")?),
        json!(digest(envelope)),
    ]))
}

fn metadata_message(statement: &MetadataStatement, envelope: &[u8]) -> CoreResult<Vec<u8>> {
    metadata_parts(METADATA_DOMAIN, statement, envelope)
}

fn version_message(statement: &VersionStatement, envelope: &[u8]) -> CoreResult<Vec<u8>> {
    version_parts(VERSION_DOMAIN, statement, envelope)
}

fn metadata_resealed_message(statement: &MetadataStatement, envelope: &[u8]) -> CoreResult<Vec<u8>> {
    metadata_parts(METADATA_RESEALED_DOMAIN, statement, envelope)
}

fn version_resealed_message(statement: &VersionStatement, envelope: &[u8]) -> CoreResult<Vec<u8>> {
    version_parts(VERSION_RESEALED_DOMAIN, statement, envelope)
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

/*
 * The verdict, as packages/crypto's integrityOf gives it: no signature is
 * Unsigned; no trusted keys for the signer is UnknownSigner; then the
 * ordinary statement and the re-sealed one under the current key (Verified,
 * Resealed); then either under a replaced key (RetiredKey); else BadSignature,
 * a record no statement can be built over included.
 */
fn integrity(
    trusted: Option<&TrustedKeys>,
    messages: CoreResult<(Vec<u8>, Vec<u8>)>,
    signature: Option<Vec<u8>>,
) -> Integrity {
    let Some(signature) = signature else {
        return Integrity::Unsigned;
    };
    let Some(trusted) = trusted else {
        return Integrity::UnknownSigner;
    };
    let Ok((ordinary, resealed)) = messages else {
        return Integrity::BadSignature;
    };
    if verify(&trusted.current, &ordinary, &signature) {
        return Integrity::Verified;
    }
    if verify(&trusted.current, &resealed, &signature) {
        return Integrity::Resealed;
    }
    if trusted
        .retired
        .iter()
        .any(|key| verify(key, &ordinary, &signature) || verify(key, &resealed, &signature))
    {
        return Integrity::RetiredKey;
    }
    Integrity::BadSignature
}

fn metadata_messages(statement: &MetadataStatement, envelope: &[u8]) -> CoreResult<(Vec<u8>, Vec<u8>)> {
    Ok((metadata_message(statement, envelope)?, metadata_resealed_message(statement, envelope)?))
}

fn version_messages(statement: &VersionStatement, envelope: &[u8]) -> CoreResult<(Vec<u8>, Vec<u8>)> {
    Ok((version_message(statement, envelope)?, version_resealed_message(statement, envelope)?))
}

/*
 * Whether a record a rotation or copy re-sealed is signed re-sealed: anything
 * but Verified is; an Unchecked record is not signed at all.
 */
fn resealed_unless_verified(prior: Integrity) -> CoreResult<bool> {
    match prior {
        Integrity::Verified => Ok(false),
        Integrity::Unchecked => {
            Err(input("HushOS couldn't check who wrote this, so it was not locked again."))
        }
        _ => Ok(true),
    }
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

/// How a rotation or a copy signs metadata it sealed again: `prior` is the
/// record's verdict as it was (from [`metadata_integrity`] over the old
/// envelope). Only a `Verified` record is signed with the ordinary statement;
/// anything else gets the re-sealed one, so re-locking never launders a
/// record into one this person vouches for. An `Unchecked` record is refused:
/// load the trust set and retry rather than re-seal blind.
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
    if resealed_unless_verified(prior)? {
        metadata_resealed_sign(signing_seed, statement, metadata_envelope)
    } else {
        metadata_sign(signing_seed, statement, metadata_envelope)
    }
}

/// How a rotation or a copy signs a content-key envelope it sealed again;
/// see [`metadata_reseal_sign`]. `prior` is the old version's verdict.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_reseal_sign(
    signing_seed: Vec<u8>,
    prior: Integrity,
    statement: VersionStatement,
    content_key_envelope: Vec<u8>,
) -> CoreResult<Vec<u8>> {
    if resealed_unless_verified(prior)? {
        version_resealed_sign(signing_seed, statement, content_key_envelope)
    } else {
        version_sign(signing_seed, statement, content_key_envelope)
    }
}

/// What a reader shows for a node's metadata. `trusted` holds the signing
/// keys the reader trusts for the account the server names as the writer:
/// its own (its current key, and its earlier ones as retired), or a verified
/// contact's (their current key, and as retired the earlier ones their
/// succession chain vouches for); `None` for anyone else. Only the current
/// key can verify; a match under a retired key is `RetiredKey`, and a valid
/// re-sealed signature is `Resealed`.
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
}
