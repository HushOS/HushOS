//! A record's verdict in a family folder, and how a copy out of one signs it
//! (docs/groups-design.md 2.8): the twin of `recordVerdicts` and `judgeWith`
//! in `packages/crypto/src/group-verdicts.ts`, which the web worker's group
//! session runs. [`crate::AreaLedger::record_verdict`] and
//! [`crate::AreaLedger::copy_form`] call it with the ledger's committed chain,
//! the areas the family opened and the node key at a re-keyed record's epoch.
//!
//! - This account's own records are judged by its own keys, as without groups.
//! - Everyone else's are judged as the roster says ([`crate::group_writer_trust`]),
//!   with their personal keys where the roster does not speak.
//! - A re-keyed record's origin is judged as its writer's trust says and the
//!   re-keyer as theirs does ([`crate::group_metadata_rekeyed_integrity`]), so
//!   a removed member's file reads `FormerMember`, named after them, whoever
//!   walked it.

use crate::error::{input, CoreResult};
use crate::group_trust::{
    group_metadata_integrity, group_metadata_rekeyed_integrity, group_version_integrity,
    group_version_rekeyed_integrity, group_writer_trust, GroupIntegrity, GroupReading, GroupRekeyedTrust,
    GroupRekeyedVerdict, GroupVerdict, GroupWriterTrust, SuccessionCache, WriterPin,
};
use crate::identity::{ServedKeys, SuccessionLink};
use crate::rotation_records::ServedRekey;
use crate::signatures::{
    metadata_integrity, version_integrity, Integrity, MetadataStatement, RekeyedMetadata, RekeyedVersion,
    TrustedKeys, VersionStatement,
};
use std::collections::HashMap;
use std::sync::Arc;

/// A writer as a family verdict takes them: the reader's pin of them (with
/// its origin), their identity and links as served (`None` when they did not
/// load), and the personal keys the reader trusts for them, used where the
/// roster does not speak.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct GroupWriter {
    pub user_id: String,
    pub pinned: Option<WriterPin>,
    pub served: Option<ServedKeys>,
    pub links: Option<Vec<SuccessionLink>>,
    pub personal: Option<TrustedKeys>,
}

/// The account reading: its user id and its own signing keys (the current
/// one, and its earlier ones as retired), as its open identity proves them.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RecordReader {
    pub user_id: String,
    pub keys: TrustedKeys,
}

/// Which record of a node: its metadata or one version, as its signature names it.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum RecordStatement {
    Metadata { statement: MetadataStatement },
    Version { statement: VersionStatement },
}

/// One record as a listing serves it: its envelope, who signed it and how,
/// any origin a rotation kept (`rekey`, the signer then being the re-keyer),
/// and the node's key epoch (`None` when not served: a re-keyed record then
/// reads unchecked).
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ServedRecord {
    pub statement: RecordStatement,
    pub key_epoch: Option<u64>,
    pub envelope: Vec<u8>,
    pub signer: Option<String>,
    pub signature: Option<Vec<u8>>,
    pub rekey: Option<ServedRekey>,
}

/// What a reader shows for one record in a family folder: a signed record's
/// verdict, or a re-keyed record's (its origin's, the re-keyer's, and whether
/// the origin binds).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum RecordVerdict {
    Signed { verdict: GroupIntegrity },
    Rekeyed { verdict: GroupRekeyedVerdict },
}

/* What a verdict is judged against: the family's reading and areas, the reader, the writers. */
pub(crate) struct Judge {
    pub group_id: String,
    pub workspace_id: String,
    pub reading: GroupReading,
    pub areas: HashMap<String, u64>,
    me: String,
    writers: HashMap<String, GroupWriter>,
    trusted: HashMap<String, TrustedKeys>,
    cache: Option<Arc<SuccessionCache>>,
    trust: std::cell::RefCell<HashMap<String, GroupWriterTrust>>,
}

impl Judge {
    pub(crate) fn new(
        group_id: String,
        workspace_id: String,
        reading: GroupReading,
        areas: HashMap<String, u64>,
        reader: RecordReader,
        writers: Vec<GroupWriter>,
        cache: Option<Arc<SuccessionCache>>,
    ) -> Judge {
        let me = reader.user_id.to_lowercase();
        let mut trusted = HashMap::new();
        for writer in &writers {
            if let Some(personal) = &writer.personal {
                trusted.insert(writer.user_id.to_lowercase(), personal.clone());
            }
        }
        // This account's own keys, whatever a writer entry says for it.
        trusted.insert(me.clone(), reader.keys);
        let writers = writers.into_iter().map(|writer| (writer.user_id.to_lowercase(), writer)).collect();
        Judge {
            group_id,
            workspace_id,
            reading,
            areas,
            me,
            writers,
            trusted,
            cache,
            trust: Default::default(),
        }
    }

    /* The roster's trust in a writer, once per writer per judge. */
    fn trust_of(&self, user_id: &str) -> GroupWriterTrust {
        if let Some(held) = self.trust.borrow().get(user_id) {
            return held.clone();
        }
        let writer = self.writers.get(user_id);
        let trust = group_writer_trust(
            self.group_id.clone(),
            self.areas.clone(),
            self.reading.clone(),
            self.workspace_id.clone(),
            user_id.to_string(),
            writer.and_then(|w| w.pinned.clone()),
            writer.and_then(|w| w.served.clone()),
            writer.and_then(|w| w.links.clone()),
            self.cache.clone(),
        );
        self.trust.borrow_mut().insert(user_id.to_string(), trust.clone());
        trust
    }

    /* Whose keys a re-keyed record's signer is judged under: their roster trust, or this account's own. */
    fn rekeyed_trust_of(&self, user_id: Option<&str>) -> (GroupWriterTrust, Option<TrustedKeys>) {
        let Some(id) = user_id.map(str::to_lowercase).filter(|id| !id.is_empty()) else {
            return (GroupWriterTrust::Outside, None);
        };
        if id == self.me {
            return (GroupWriterTrust::Outside, self.trusted.get(&id).cloned());
        }
        (self.trust_of(&id), self.trusted.get(&id).cloned())
    }

    /*
     * A signed record's verdict: unsigned before any trust is looked up (a
     * lookup that reads unchecked must not hide a stripped signature), this
     * account's own and an unnamed signer's under personal keys, anyone
     * else's as the roster says.
     */
    pub(crate) fn signed(
        &self,
        statement: &RecordStatement,
        envelope: &[u8],
        signer: Option<&str>,
        signature: Option<&[u8]>,
    ) -> GroupIntegrity {
        let Some(signature) = signature.filter(|signature| !signature.is_empty()) else {
            return GroupIntegrity { verdict: GroupVerdict::Unsigned, via: None };
        };
        let id = signer.map(str::to_lowercase).filter(|id| !id.is_empty());
        let personal = id.as_ref().and_then(|id| self.trusted.get(id).cloned());
        let signature = Some(signature.to_vec());
        match id {
            Some(id) if id != self.me => {
                let trust = self.trust_of(&id);
                match statement {
                    RecordStatement::Metadata { statement } => group_metadata_integrity(
                        trust,
                        personal,
                        statement.clone(),
                        envelope.to_vec(),
                        signature,
                    ),
                    RecordStatement::Version { statement } => group_version_integrity(
                        trust,
                        personal,
                        statement.clone(),
                        envelope.to_vec(),
                        signature,
                    ),
                }
            }
            _ => {
                let integrity = match statement {
                    RecordStatement::Metadata { statement } => {
                        metadata_integrity(personal, statement.clone(), envelope.to_vec(), signature)
                    }
                    RecordStatement::Version { statement } => {
                        version_integrity(personal, statement.clone(), envelope.to_vec(), signature)
                    }
                };
                GroupIntegrity { verdict: integrity.into(), via: None }
            }
        }
    }

    /*
     * A re-keyed record's verdicts: its origin's as its writer's trust says,
     * the re-keyer's (the record's signer) as theirs does; `node_key` the
     * node's key at `key_epoch`, none when not held (unchecked).
     */
    pub(crate) fn rekeyed(
        &self,
        statement: &RecordStatement,
        key_epoch: u64,
        envelope: &[u8],
        rekey: &ServedRekey,
        rekeyer: Option<&str>,
        node_key: Option<Vec<u8>>,
    ) -> GroupRekeyedVerdict {
        let (origin, origin_personal) = self.rekeyed_trust_of(rekey.origin.signer_id.as_deref());
        let (by, rekeyer_personal) = self.rekeyed_trust_of(rekeyer);
        let trust = GroupRekeyedTrust { origin, origin_personal, rekeyer: by, rekeyer_personal };
        match statement {
            RecordStatement::Metadata { statement } => group_metadata_rekeyed_integrity(
                node_key,
                trust,
                RekeyedMetadata {
                    statement: statement.clone(),
                    key_epoch,
                    envelope: envelope.to_vec(),
                    origin: rekey.origin.clone(),
                    rekey_signature: Some(rekey.signature.clone()),
                },
            ),
            RecordStatement::Version { statement } => group_version_rekeyed_integrity(
                node_key,
                trust,
                RekeyedVersion {
                    statement: statement.clone(),
                    key_epoch,
                    envelope: envelope.to_vec(),
                    origin: rekey.origin.clone(),
                    rekey_signature: Some(rekey.signature.clone()),
                },
            ),
        }
    }
}

/// How a copy signs, from the verdict of what it copies, as the prior a
/// `*_copy_sign` call takes with `from_link` false: `Verified` (ordinary) and
/// `SavedFromLink` (saved) stay so; a former member's record, a key
/// conflict's, a re-keyed record whose origin does not bind, and anything
/// else are `Resealed`; an unchecked one is refused.
pub(crate) fn copy_prior(verdict: GroupVerdict) -> CoreResult<Integrity> {
    match verdict {
        GroupVerdict::Verified => Ok(Integrity::Verified),
        GroupVerdict::SavedFromLink => Ok(Integrity::SavedFromLink),
        GroupVerdict::Unchecked => {
            Err(input("HushOS couldn't check who wrote this, so it was not locked again."))
        }
        _ => Ok(Integrity::Resealed),
    }
}
