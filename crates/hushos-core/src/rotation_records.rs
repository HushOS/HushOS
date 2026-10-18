//! The record half of a walk in a family folder (docs/integrity-design.md,
//! "Re-keyed records"), the twin of `rekeyRecord` and `rekeyNode` in
//! `packages/crypto/src/rotation-records.ts`, which the web worker runs.
//! [`crate::AreaLedger::rotate_node`] calls it between making a node's fresh
//! key and marking it pending, so a node whose records do not re-key leaves
//! nothing behind.
//!
//! Every record is sealed again raw under the fresh key, nothing parsed, and
//! signed so that it never claims anyone's authorship:
//!
//! - a record that already carries an origin carries it on, after the same
//!   bound check a reader makes (`*_origin_carry`), or drops it
//!   (`drop_origin`) and is re-sealed when it does not bind, its writer is
//!   gone, or it names a writer with no signature;
//! - a signed record with a named writer becomes its own origin;
//! - anything else is re-sealed as the walker's (decision D6): readers show it
//!   "Re-locked by" the walker, never as written by them. A server and a
//!   removed member can plant unsigned content a walk re-seals so
//!   (docs/integrity-design.md, "What the check does not stop").
//!
//! A family folder's rotation writes no legacy signature beside a re-keyed
//! record (decision D3). The web's personal path (`legacyRecord`, and the
//! legacy signature beside a re-key that `judge` gives) is not here: personal
//! rotations stay with the apps' own re-sealing until the re-keyed form
//! reaches personal folders (W1 in docs/groups-mobile-plan.md).

use crate::drive::{
    metadata_rekey_with, origin_key_wrap_with, origin_opening_key_with, version_rekey_with, MetadataContext,
    OriginKeyContext, OriginRecord, VersionContext,
};
use crate::error::CoreResult;
use crate::signatures::{
    metadata_origin_carry_with, metadata_rekey_sign_with, metadata_resealed_sign_with,
    version_origin_carry_with, version_rekey_sign_with, version_resealed_sign_with, MetadataStatement,
    NodeKind, RecordOrigin, RekeyedMetadata, RekeyedVersion, ServedOrigin, VersionStatement,
};

/// A re-keyed record's origin as the server serves it (`RekeyView`): the
/// envelope its writer signed, that writer (`None` once their account is
/// gone) and their signature, the key that opens it alone wrapped under the
/// node key at the node's epoch, and the re-keyer's signature.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ServedRekey {
    pub origin: ServedOrigin,
    pub signature: Vec<u8>,
}

/// One version of a node as the rotation work serves it: its envelope, who
/// signed it and how, and any origin an earlier rotation kept.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RotatingVersion {
    pub version_id: String,
    pub object_id: String,
    pub content_suite: u32,
    pub envelope: Vec<u8>,
    pub signer: Option<String>,
    pub signature: Option<Vec<u8>>,
    pub rekey: Option<ServedRekey>,
}

/// A node as the rotation work serves it (the web's `RotateNodeInput`): its
/// key envelope as [`crate::RotatingNodeKey`] has it, its metadata and
/// versions with who signed them and any origins kept, and the ids of its
/// shares and links (a family folder has none: such a node is refused).
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RotatingNode {
    pub node_id: String,
    pub parent_id: String,
    /// The parent's key epoch the fresh key is wrapped under: the walk's target for a rotated parent.
    pub parent_key_epoch: u64,
    /// The node's key epoch now, and the parent epoch its envelope was wrapped under.
    pub key_epoch: u64,
    pub wrapped_parent_key_epoch: u64,
    pub key_envelope: Vec<u8>,
    pub kind: NodeKind,
    pub metadata_version: u64,
    pub metadata_envelope: Vec<u8>,
    pub metadata_signer: Option<String>,
    pub metadata_signature: Option<Vec<u8>>,
    pub metadata_rekey: Option<ServedRekey>,
    pub versions: Vec<RotatingVersion>,
    pub share_ids: Vec<String>,
    pub link_ids: Vec<String>,
}

/// A re-keyed record's part of a rotation: the origin's opening key under the
/// fresh node key (`originKeyEnvelope`), and the rekeyed statement's signature.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RekeyOut {
    pub origin_key_envelope: Vec<u8>,
    pub signature: Vec<u8>,
}

/// One record a rotation sealed again, and how it is signed: re-keyed
/// (`rekey`, no legacy `signature` in a family folder), or re-sealed with the
/// re-keyer's re-sealed signature alone, `drop_origin` when it dropped an
/// origin that did not bind or names nobody.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RotatedRecord {
    pub envelope: Vec<u8>,
    pub signature: Option<Vec<u8>>,
    pub rekey: Option<RekeyOut>,
    pub drop_origin: bool,
}

/// A version a rotation sealed again.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RotatedVersion {
    pub version_id: String,
    pub record: RotatedRecord,
}

/// One node of a walk, as the rotation call sends it: the key envelope under
/// the parent's key at the target, and the node's records sealed again under
/// the fresh key; or, for a node already at the target (`rewrap`), only its
/// key wrapped again under its re-keyed parent, its records untouched.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RotatedNode {
    pub node_id: String,
    pub key_envelope: Vec<u8>,
    pub rewrap: bool,
    pub metadata: Option<RotatedRecord>,
    pub versions: Vec<RotatedVersion>,
}

/* Which record of the node: its metadata, or one version. */
enum Statement<'a> {
    Metadata(&'a MetadataStatement),
    Version(&'a VersionStatement),
}

/* One record as served, with the node key epoch it is under now. */
struct Served<'a> {
    statement: Statement<'a>,
    envelope: &'a [u8],
    signer: Option<&'a str>,
    signature: Option<&'a [u8]>,
    rekey: Option<&'a ServedRekey>,
    key_epoch: u64,
}

/*
 * One record re-sealed raw under `fresh` and signed (module docs): the twin of
 * rekeyRecord with a family folder's judge, which writes no legacy signature
 * beside a re-key.
 */
fn rekey_record(
    served: Served,
    old: &[u8],
    fresh: &[u8],
    target_epoch: u64,
    signing_seed: &[u8],
) -> CoreResult<RotatedRecord> {
    let next = match served.statement {
        Statement::Metadata(s) => metadata_rekey_with(
            &MetadataContext {
                workspace_id: s.workspace_id.clone(),
                node_id: s.node_id.clone(),
                metadata_version: s.metadata_version,
            },
            old,
            fresh,
            served.envelope,
        )?,
        Statement::Version(s) => version_rekey_with(
            &VersionContext {
                workspace_id: s.workspace_id.clone(),
                node_id: s.node_id.clone(),
                version_id: s.version_id.clone(),
                object_id: s.object_id.clone(),
            },
            s.content_suite,
            old,
            fresh,
            served.envelope,
        )?,
    };
    let resealed = |drop_origin: bool| -> CoreResult<RotatedRecord> {
        let signature = match served.statement {
            Statement::Metadata(s) => metadata_resealed_sign_with(signing_seed, s, &next)?,
            Statement::Version(s) => version_resealed_sign_with(signing_seed, s, &next)?,
        };
        Ok(RotatedRecord { envelope: next.clone(), signature: Some(signature), rekey: None, drop_origin })
    };
    let origin = if let Some(rekey) = served.rekey {
        // The rekeyed statement names the writer: an origin whose writer is gone, or that names a
        // writer with no signature (no state an honest server serves), is dropped.
        let (Some(signer_id), Some(signature)) = (
            rekey.origin.signer_id.clone().filter(|id| !id.is_empty()),
            rekey.origin.signature.clone().filter(|signature| !signature.is_empty()),
        ) else {
            return resealed(true);
        };
        let carried = match served.statement {
            Statement::Metadata(s) => metadata_origin_carry_with(
                old,
                fresh,
                target_epoch,
                &RekeyedMetadata {
                    statement: s.clone(),
                    key_epoch: served.key_epoch,
                    envelope: served.envelope.to_vec(),
                    origin: rekey.origin.clone(),
                    rekey_signature: Some(rekey.signature.clone()),
                },
            )?,
            Statement::Version(s) => version_origin_carry_with(
                old,
                fresh,
                target_epoch,
                &RekeyedVersion {
                    statement: s.clone(),
                    key_epoch: served.key_epoch,
                    envelope: served.envelope.to_vec(),
                    origin: rekey.origin.clone(),
                    rekey_signature: Some(rekey.signature.clone()),
                },
            )?,
        };
        // Not bound: an honest rotation never signs its name under someone else's mismatch.
        let Some(key_envelope) = carried else {
            return resealed(true);
        };
        RecordOrigin { envelope: rekey.origin.envelope.clone(), signer_id, signature, key_envelope }
    } else if let (Some(signer_id), Some(signature)) = (
        served.signer.filter(|id| !id.is_empty()),
        served.signature.filter(|signature| !signature.is_empty()),
    ) {
        // The writer's own record becomes the origin: its opening key, wrapped under the fresh key.
        let (workspace_id, node_id, record) = match served.statement {
            Statement::Metadata(s) => {
                (&s.workspace_id, &s.node_id, OriginRecord::Metadata { metadata_version: s.metadata_version })
            }
            Statement::Version(s) => {
                (&s.workspace_id, &s.node_id, OriginRecord::Version { version_id: s.version_id.clone() })
            }
        };
        let opening = origin_opening_key_with(served.envelope, old)?;
        let key_envelope = origin_key_wrap_with(
            &OriginKeyContext {
                workspace_id: workspace_id.clone(),
                node_id: node_id.clone(),
                key_epoch: target_epoch,
                record,
                origin_envelope: served.envelope.to_vec(),
            },
            fresh,
            &opening[..],
        )?;
        RecordOrigin {
            envelope: served.envelope.to_vec(),
            signer_id: signer_id.to_string(),
            signature: signature.to_vec(),
            key_envelope,
        }
    } else {
        return resealed(false);
    };
    let signature = match served.statement {
        Statement::Metadata(s) => metadata_rekey_sign_with(signing_seed, s, target_epoch, &next, &origin)?,
        Statement::Version(s) => version_rekey_sign_with(signing_seed, s, target_epoch, &next, &origin)?,
    };
    Ok(RotatedRecord {
        envelope: next,
        signature: None,
        rekey: Some(RekeyOut { origin_key_envelope: origin.key_envelope, signature }),
        drop_origin: false,
    })
}

/*
 * A node's metadata and versions re-keyed from `old` to `fresh` at
 * `target_epoch` in a family folder (rekeyNode's records, the family judge).
 * Nothing is held; the caller owns both keys.
 */
pub(crate) fn rekey_node_records(
    workspace_id: &str,
    node: &RotatingNode,
    old: &[u8],
    fresh: &[u8],
    target_epoch: u64,
    signing_seed: &[u8],
) -> CoreResult<(RotatedRecord, Vec<RotatedVersion>)> {
    let metadata_statement = MetadataStatement {
        workspace_id: workspace_id.to_string(),
        node_id: node.node_id.clone(),
        kind: node.kind,
        metadata_version: node.metadata_version,
    };
    let metadata = rekey_record(
        Served {
            statement: Statement::Metadata(&metadata_statement),
            envelope: &node.metadata_envelope,
            signer: node.metadata_signer.as_deref(),
            signature: node.metadata_signature.as_deref(),
            rekey: node.metadata_rekey.as_ref(),
            key_epoch: node.key_epoch,
        },
        old,
        fresh,
        target_epoch,
        signing_seed,
    )?;
    let mut versions = Vec::with_capacity(node.versions.len());
    for version in &node.versions {
        let statement = VersionStatement {
            workspace_id: workspace_id.to_string(),
            node_id: node.node_id.clone(),
            version_id: version.version_id.clone(),
            object_id: version.object_id.clone(),
            content_suite: version.content_suite,
        };
        let record = rekey_record(
            Served {
                statement: Statement::Version(&statement),
                envelope: &version.envelope,
                signer: version.signer.as_deref(),
                signature: version.signature.as_deref(),
                rekey: version.rekey.as_ref(),
                key_epoch: node.key_epoch,
            },
            old,
            fresh,
            target_epoch,
            signing_seed,
        )?;
        versions.push(RotatedVersion { version_id: version.version_id.clone(), record });
    }
    Ok((metadata, versions))
}
