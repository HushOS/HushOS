//! Writer signatures, as `packages/crypto/signatures.ts` makes them and
//! `docs/integrity-design.md` fixes them: every statement is the compact JSON
//! array the web builds, with lowercase ids and SHA-256 digests (base64url) of
//! the sealed bytes it vouches for, signed detached with the identity's
//! Ed25519 key and verified strictly.

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

/// What a reader can say about who wrote a record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum Integrity {
    /// The signer is someone this person trusts, and the signature holds.
    Verified,
    /// There is a signature, but by nobody this person has verified.
    UnknownSigner,
    /// The signer is trusted, and the signature does not hold.
    BadSignature,
    /// There is no signature: written before signatures.
    Unsigned,
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

fn metadata_message(statement: &MetadataStatement, envelope: &[u8]) -> CoreResult<Vec<u8>> {
    Ok(context(&[
        json!("hushos/drive/sig/metadata"),
        json!(1),
        json!(statement.workspace_id.to_lowercase()),
        json!(statement.node_id.to_lowercase()),
        json!(statement.kind.as_str()),
        json!(positive(statement.metadata_version, "metadata version")?),
        json!(digest(envelope)),
    ]))
}

fn version_message(statement: &VersionStatement, envelope: &[u8]) -> CoreResult<Vec<u8>> {
    Ok(context(&[
        json!("hushos/drive/sig/version"),
        json!(1),
        json!(statement.workspace_id.to_lowercase()),
        json!(statement.node_id.to_lowercase()),
        json!(statement.version_id.to_lowercase()),
        json!(statement.object_id.to_lowercase()),
        json!(positive(statement.content_suite as u64, "content suite")?),
        json!(digest(envelope)),
    ]))
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

fn integrity(
    trusted_keys: &[Vec<u8>],
    message: CoreResult<Vec<u8>>,
    signature: Option<Vec<u8>>,
) -> Integrity {
    let Some(signature) = signature else {
        return Integrity::Unsigned;
    };
    if trusted_keys.is_empty() {
        return Integrity::UnknownSigner;
    }
    let Ok(message) = message else {
        return Integrity::BadSignature;
    };
    if trusted_keys.iter().any(|key| verify(key, &message, &signature)) {
        Integrity::Verified
    } else {
        Integrity::BadSignature
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

/// What a reader shows for a node's metadata. `trusted_keys` are the signing
/// keys the reader trusts for the account the server names as the writer: its
/// own (and its earlier ones), or a verified contact's (and the earlier ones
/// their succession chain vouches for); none at all for anyone else.
///
/// ```
/// use hushos_core::{metadata_integrity, metadata_sign, random_bytes, signing_public_key, Integrity, MetadataStatement, NodeKind};
/// let seed = random_bytes(32)?;
/// let statement = MetadataStatement { workspace_id: "ws".into(), node_id: "n1".into(), kind: NodeKind::Folder, metadata_version: 2 };
/// let signature = metadata_sign(seed.clone(), statement.clone(), b"sealed".to_vec())?;
/// let me = vec![signing_public_key(seed)?];
/// assert_eq!(metadata_integrity(me.clone(), statement.clone(), b"sealed".to_vec(), Some(signature.clone())), Integrity::Verified);
/// assert_eq!(metadata_integrity(vec![], statement.clone(), b"sealed".to_vec(), Some(signature.clone())), Integrity::UnknownSigner);
/// assert_eq!(metadata_integrity(me.clone(), statement.clone(), b"swapped".to_vec(), Some(signature)), Integrity::BadSignature);
/// assert_eq!(metadata_integrity(me, statement, b"sealed".to_vec(), None), Integrity::Unsigned);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn metadata_integrity(
    trusted_keys: Vec<Vec<u8>>,
    statement: MetadataStatement,
    metadata_envelope: Vec<u8>,
    signature: Option<Vec<u8>>,
) -> Integrity {
    integrity(&trusted_keys, metadata_message(&statement, &metadata_envelope), signature)
}

/// What a reader shows for a version; see [`metadata_integrity`].
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn version_integrity(
    trusted_keys: Vec<Vec<u8>>,
    statement: VersionStatement,
    content_key_envelope: Vec<u8>,
    signature: Option<Vec<u8>>,
) -> Integrity {
    integrity(&trusted_keys, version_message(&statement, &content_key_envelope), signature)
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

    #[test]
    fn a_record_signed_by_an_earlier_key_verifies_against_the_chain_s_keys() {
        let earlier = random(32);
        let current = random(32);
        let envelope = random(84);
        let version = VersionStatement {
            workspace_id: "ws".into(),
            node_id: "n1".into(),
            version_id: "v1".into(),
            object_id: "o1".into(),
            content_suite: 3,
        };
        let signature = version_sign(earlier.clone(), version.clone(), envelope.clone()).unwrap();
        let keys = |seeds: &[&Vec<u8>]| -> Vec<Vec<u8>> {
            seeds.iter().map(|seed| signing_public_key((*seed).clone()).unwrap()).collect()
        };
        assert_eq!(
            version_integrity(keys(&[&current]), version.clone(), envelope.clone(), Some(signature.clone())),
            Integrity::BadSignature
        );
        assert_eq!(
            version_integrity(
                keys(&[&current, &earlier]),
                version.clone(),
                envelope.clone(),
                Some(signature)
            ),
            Integrity::Verified
        );
        assert_eq!(version_integrity(keys(&[&current]), version, envelope, None), Integrity::Unsigned);
    }
}
