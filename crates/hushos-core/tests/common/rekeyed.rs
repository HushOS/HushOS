//! Re-keyed records as JSON, shared by `tests/web_fixtures.rs`,
//! `examples/fixtures.rs` and the fuzz crate's `record_integrity` target (both
//! include this file by path). The twin is
//! `packages/crypto/src/rekeyed-testkit.ts`: both read the same document the
//! same way (a field that does not fit is a skip) and give the same verdict,
//! and both build the same cases, in the same order, with the same
//! expectations, from their own keys.
#![allow(dead_code)]

use hushos_core::*;
use serde_json::{json, Map, Value};

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

/* A JSON number a u64 holds exactly: `1`, `1.0` and `1e0` alike, as JSON.parse reads them. */
fn unsigned(value: &Value) -> Option<u64> {
    if let Some(n) = value.as_u64() {
        return Some(n);
    }
    let f = value.as_f64()?;
    (f.fract() == 0.0 && (0.0..18_446_744_073_709_551_616.0).contains(&f)).then_some(f as u64)
}

fn number(value: &Value, key: &str) -> Option<u64> {
    unsigned(value.get(key)?)
}

fn small(value: &Value, key: &str) -> Option<u32> {
    number(value, key).and_then(|n| u32::try_from(n).ok())
}

fn bytes_of(value: &Value) -> Option<Vec<u8>> {
    let text = value.as_str()?;
    if text.is_empty() {
        return Some(vec![]);
    }
    base64url_decode(text.into()).ok()
}

fn bytes(value: &Value, key: &str) -> Option<Vec<u8>> {
    bytes_of(value.get(key)?)
}

/* Absent or null is `Some(None)`; present and not fitting is `None`. */
fn nullable<T>(value: &Value, key: &str, read: impl Fn(&Value) -> Option<T>) -> Option<Option<T>> {
    match value.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(inner) => read(inner).map(Some),
    }
}

fn signer_of(value: &Value) -> Option<TrustedKeys> {
    let current = bytes(value, "current")?;
    let retired = value.get("retired")?.as_array()?.iter().map(bytes_of).collect::<Option<Vec<_>>>()?;
    Some(TrustedKeys { current, retired })
}

fn group_trust_of(value: &Value) -> Option<GroupWriterTrust> {
    let trust = text(value, "trust")?;
    match trust.as_str() {
        "outside" => return Some(GroupWriterTrust::Outside),
        "unchecked" => return Some(GroupWriterTrust::Unchecked),
        "key-conflict" => return Some(GroupWriterTrust::KeyConflict),
        _ => {}
    }
    let signer = signer_of(value.get("signer")?)?;
    let links_loaded = value.get("linksLoaded")?.as_bool()?;
    match trust.as_str() {
        "former-member" => Some(GroupWriterTrust::FormerMember { signer, links_loaded }),
        "roster" => {
            let via = nullable(value, "via", |v| v.as_str().map(str::to_string))?;
            Some(GroupWriterTrust::Roster { signer, via, followed: None, links_loaded })
        }
        _ => None,
    }
}

pub enum Record {
    Metadata(RekeyedMetadata),
    Version(RekeyedVersion),
}

pub enum Trust {
    Personal(Option<RekeyedTrust>),
    Group(Box<GroupRekeyedTrust>),
}

pub struct Input {
    pub record: Record,
    pub node_key: Option<Vec<u8>>,
    pub trust: Trust,
}

/// A re-keyed record and what the reader holds, from JSON; `None` when it does not fit.
pub fn read(value: &Value) -> Option<Input> {
    let kind = text(value, "record")?;
    let s = value.get("statement")?;
    if !s.is_object() {
        return None;
    }
    let o = value.get("origin")?;
    if !o.is_object() {
        return None;
    }
    enum Statement {
        Metadata(MetadataStatement),
        Version(VersionStatement),
    }
    let statement = match kind.as_str() {
        "metadata" => {
            let (workspace_id, node_id, metadata_version) =
                (text(s, "workspaceId")?, text(s, "nodeId")?, number(s, "metadataVersion")?);
            let kind = match text(s, "kind").as_deref() {
                Some("folder") => NodeKind::Folder,
                Some("file") => NodeKind::File,
                _ => return None,
            };
            Statement::Metadata(MetadataStatement { workspace_id, node_id, kind, metadata_version })
        }
        "version" => Statement::Version(VersionStatement {
            workspace_id: text(s, "workspaceId")?,
            node_id: text(s, "nodeId")?,
            version_id: text(s, "versionId")?,
            object_id: text(s, "objectId")?,
            content_suite: small(s, "contentSuite")?,
        }),
        _ => return None,
    };
    let origin = ServedOrigin {
        envelope: bytes(o, "envelope")?,
        signer_id: nullable(o, "signerId", |v| v.as_str().map(str::to_string))?,
        signature: nullable(o, "signature", bytes_of)?,
        key_envelope: bytes(o, "keyEnvelope")?,
    };
    let key_epoch = number(value, "keyEpoch")?;
    let envelope = bytes(value, "envelope")?;
    let rekey_signature = nullable(value, "rekeySignature", bytes_of)?;
    let node_key = nullable(value, "nodeKey", bytes_of)?;
    let record = match statement {
        Statement::Metadata(statement) => {
            Record::Metadata(RekeyedMetadata { statement, key_epoch, envelope, origin, rekey_signature })
        }
        Statement::Version(statement) => {
            Record::Version(RekeyedVersion { statement, key_epoch, envelope, origin, rekey_signature })
        }
    };
    let trust = match value.get("group") {
        Some(g) if !g.is_null() => {
            if !g.is_object() {
                return None;
            }
            Trust::Group(Box::new(GroupRekeyedTrust {
                origin: group_trust_of(g.get("origin")?)?,
                origin_personal: nullable(g, "originPersonal", signer_of)?,
                rekeyer: group_trust_of(g.get("rekeyer")?)?,
                rekeyer_personal: nullable(g, "rekeyerPersonal", signer_of)?,
            }))
        }
        _ => Trust::Personal(nullable(value, "trust", |t| {
            if !t.is_object() {
                return None;
            }
            Some(RekeyedTrust {
                origin: nullable(t, "origin", signer_of)?,
                rekeyer: nullable(t, "rekeyer", signer_of)?,
            })
        })?),
    };
    Some(Input { record, node_key, trust })
}

/// A verdict's name as the web writes it.
pub fn integrity_name(integrity: Integrity) -> &'static str {
    match integrity {
        Integrity::Verified => "verified",
        Integrity::SavedFromLink => "saved-from-link",
        Integrity::Resealed => "resealed",
        Integrity::RetiredKey => "retired-key",
        Integrity::UnknownSigner => "unknown-signer",
        Integrity::BadSignature => "bad-signature",
        Integrity::Unsigned => "unsigned",
        Integrity::Unchecked => "unchecked",
    }
}

pub fn group_verdict_name(verdict: GroupVerdict) -> &'static str {
    match verdict {
        GroupVerdict::Verified => "verified",
        GroupVerdict::SavedFromLink => "saved-from-link",
        GroupVerdict::Resealed => "resealed",
        GroupVerdict::RetiredKey => "retired-key",
        GroupVerdict::UnknownSigner => "unknown-signer",
        GroupVerdict::BadSignature => "bad-signature",
        GroupVerdict::Unsigned => "unsigned",
        GroupVerdict::Unchecked => "unchecked",
        GroupVerdict::KeyConflict => "key-conflict",
        GroupVerdict::FormerMember => "former-member",
    }
}

fn group_side(integrity: &GroupIntegrity) -> Value {
    json!({ "integrity": group_verdict_name(integrity.verdict), "via": integrity.via })
}

/// The verdict as JSON: `{ origin, rekeyer, mismatch }`, each side `{ integrity, via }` in a group's area.
pub fn judge(input: &Input) -> Value {
    match (&input.trust, &input.record) {
        (Trust::Personal(trust), record) => {
            let verdict = match record {
                Record::Metadata(r) => {
                    metadata_rekeyed_integrity(input.node_key.clone(), trust.clone(), r.clone())
                }
                Record::Version(r) => {
                    version_rekeyed_integrity(input.node_key.clone(), trust.clone(), r.clone())
                }
            };
            json!({
                "origin": integrity_name(verdict.origin),
                "rekeyer": integrity_name(verdict.rekeyer),
                "mismatch": verdict.mismatch,
            })
        }
        (Trust::Group(trust), record) => {
            let verdict = match record {
                Record::Metadata(r) => {
                    group_metadata_rekeyed_integrity(input.node_key.clone(), (**trust).clone(), r.clone())
                }
                Record::Version(r) => {
                    group_version_rekeyed_integrity(input.node_key.clone(), (**trust).clone(), r.clone())
                }
            };
            json!({
                "origin": group_side(&verdict.origin),
                "rekeyer": group_side(&verdict.rekeyer),
                "mismatch": verdict.mismatch,
            })
        }
    }
}

// -------------------------------------------------------------------------------------------------
// The shared cases, built from this twin's keys with the expectations both twins declare.
// -------------------------------------------------------------------------------------------------

/// An Ed25519 signer: the 32-byte seed and the public key.
#[derive(Clone)]
pub struct CaseSigner {
    pub user_id: String,
    pub seed: Vec<u8>,
    pub public_key: Vec<u8>,
}

pub struct Written<S> {
    pub statement: S,
    pub envelope: Vec<u8>,
    pub signature: Vec<u8>,
}

pub struct CaseMaterial {
    pub old_node_key: Vec<u8>,
    pub node_key: Vec<u8>,
    /// The node key's epoch after the rotation.
    pub key_epoch: u64,
    pub parent_id: String,
    pub writer: CaseSigner,
    pub rekeyer: CaseSigner,
    pub stranger: Vec<u8>,
    pub group: String,
    pub metadata: Written<MetadataStatement>,
    pub plaintext: NodeMetadata,
    pub version: Written<VersionStatement>,
    /// The version's content key, size and thumbnail length.
    pub version_record: ContentKey,
    pub other_version: Written<VersionStatement>,
    pub other_version_record: ContentKey,
    /// The same metadata sealed under the old key for another node, and signed there.
    pub other_node: Written<MetadataStatement>,
}

pub struct Rekeyed {
    pub metadata: Value,
    pub version: Value,
    pub metadata_origin_key: String,
    pub version_origin_key: String,
    pub metadata_statement: String,
    pub version_statement: String,
    /// Every origin the cases carry, with the record it was sealed for: the fuzz targets' oracle.
    pub origins: Vec<Value>,
    pub cases: Vec<(String, Value, Value)>,
}

#[derive(Clone)]
struct Built {
    metadata: bool,
    statement: Value,
    key_epoch: u64,
    envelope: Vec<u8>,
    origin_envelope: Vec<u8>,
    signer_id: Option<String>,
    signature: Option<Vec<u8>>,
    key_envelope: Vec<u8>,
    rekey_signature: Option<Vec<u8>>,
}

fn e(bytes: &[u8]) -> String {
    base64url_encode(bytes.to_vec())
}

fn json_of(b: &Built) -> Map<String, Value> {
    let value = json!({
        "record": if b.metadata { "metadata" } else { "version" },
        "statement": b.statement,
        "keyEpoch": b.key_epoch,
        "envelope": e(&b.envelope),
        "origin": {
            "envelope": e(&b.origin_envelope),
            "signerId": b.signer_id,
            "signature": b.signature.as_deref().map(e),
            "keyEnvelope": e(&b.key_envelope),
        },
        "rekeySignature": b.rekey_signature.as_deref().map(e),
    });
    value.as_object().unwrap().clone()
}

fn metadata_json(s: &MetadataStatement) -> Value {
    json!({
        "workspaceId": s.workspace_id, "nodeId": s.node_id,
        "kind": match s.kind { NodeKind::Folder => "folder", NodeKind::File => "file" },
        "metadataVersion": s.metadata_version,
    })
}

fn version_json(s: &VersionStatement) -> Value {
    json!({
        "workspaceId": s.workspace_id, "nodeId": s.node_id, "versionId": s.version_id,
        "objectId": s.object_id, "contentSuite": s.content_suite,
    })
}

fn version_ctx(s: &VersionStatement) -> VersionContext {
    VersionContext {
        workspace_id: s.workspace_id.clone(),
        node_id: s.node_id.clone(),
        version_id: s.version_id.clone(),
        object_id: s.object_id.clone(),
    }
}

fn metadata_ctx(s: &MetadataStatement) -> MetadataContext {
    MetadataContext {
        workspace_id: s.workspace_id.clone(),
        node_id: s.node_id.clone(),
        metadata_version: s.metadata_version,
    }
}

fn verdict(origin: &str, rekeyer: &str, mismatch: bool) -> Value {
    json!({ "origin": origin, "rekeyer": rekeyer, "mismatch": mismatch })
}

fn side(integrity: &str, via: Option<&str>) -> Value {
    json!({ "integrity": integrity, "via": via })
}

fn signer(current: &[u8], retired: &[&[u8]]) -> Value {
    json!({ "current": e(current), "retired": retired.iter().map(|k| e(k)).collect::<Vec<_>>() })
}

/// The writer's metadata and version re-keyed to `key_epoch` by the re-keyer, and the cases.
pub fn rekeyed_cases(m: &CaseMaterial) -> Rekeyed {
    let ms = &m.metadata.statement;
    let vs = &m.version.statement;
    let key_ctx = |metadata: bool, origin: &[u8]| OriginKeyContext {
        workspace_id: if metadata { ms.workspace_id.clone() } else { vs.workspace_id.clone() },
        node_id: if metadata { ms.node_id.clone() } else { vs.node_id.clone() },
        key_epoch: m.key_epoch,
        record: if metadata {
            OriginRecord::Metadata { metadata_version: ms.metadata_version }
        } else {
            OriginRecord::Version { version_id: vs.version_id.clone() }
        },
        origin_envelope: origin.to_vec(),
    };
    let sign_as = |b: &Built, by: &CaseSigner| -> Built {
        let origin = RecordOrigin {
            envelope: b.origin_envelope.clone(),
            signer_id: b.signer_id.clone().unwrap(),
            signature: b.signature.clone().unwrap(),
        };
        let signature = if b.metadata {
            metadata_rekey_sign(by.seed.clone(), ms.clone(), b.key_epoch, b.envelope.clone(), origin)
        } else {
            version_rekey_sign(by.seed.clone(), vs.clone(), b.key_epoch, b.envelope.clone(), origin)
        }
        .unwrap();
        Built { rekey_signature: Some(signature), ..b.clone() }
    };
    let metadata_origin_key =
        origin_opening_key(m.metadata.envelope.clone(), m.old_node_key.clone()).unwrap();
    let version_origin_key = origin_opening_key(m.version.envelope.clone(), m.old_node_key.clone()).unwrap();
    let metadata = sign_as(
        &Built {
            metadata: true,
            statement: metadata_json(ms),
            key_epoch: m.key_epoch,
            envelope: metadata_rekey(
                metadata_ctx(ms),
                m.old_node_key.clone(),
                m.node_key.clone(),
                m.metadata.envelope.clone(),
            )
            .unwrap(),
            origin_envelope: m.metadata.envelope.clone(),
            signer_id: Some(m.writer.user_id.clone()),
            signature: Some(m.metadata.signature.clone()),
            key_envelope: origin_key_wrap(
                key_ctx(true, &m.metadata.envelope),
                m.node_key.clone(),
                metadata_origin_key.clone(),
            )
            .unwrap(),
            rekey_signature: None,
        },
        &m.rekeyer,
    );
    let version = sign_as(
        &Built {
            metadata: false,
            statement: version_json(vs),
            key_epoch: m.key_epoch,
            envelope: version_rekey(
                version_ctx(vs),
                vs.content_suite,
                m.old_node_key.clone(),
                m.node_key.clone(),
                m.version.envelope.clone(),
            )
            .unwrap(),
            origin_envelope: m.version.envelope.clone(),
            signer_id: Some(m.writer.user_id.clone()),
            signature: Some(m.version.signature.clone()),
            key_envelope: origin_key_wrap(
                key_ctx(false, &m.version.envelope),
                m.node_key.clone(),
                version_origin_key.clone(),
            )
            .unwrap(),
            rekey_signature: None,
        },
        &m.rekeyer,
    );

    let w = signer(&m.writer.public_key, &[]);
    let r = signer(&m.rekeyer.public_key, &[]);
    let both = json!({ "origin": w, "rekeyer": r });
    let node_key = json!(e(&m.node_key));
    let mut cases = Vec::new();
    let mut personal = |name: &str, b: &Built, trust: Value, expected: Value, key: Value| {
        let mut input = json_of(b);
        input.insert("nodeKey".into(), key);
        input.insert("trust".into(), trust);
        cases.push((name.to_string(), Value::Object(input), expected));
    };
    let roster = |key: &[u8], links_loaded: bool| json!({ "trust": "roster", "signer": signer(key, &[]), "via": m.group, "linksLoaded": links_loaded });
    let k = || node_key.clone();

    personal("metadata", &metadata, both.clone(), verdict("verified", "verified", false), k());
    personal("version", &version, both.clone(), verdict("verified", "verified", false), k());
    personal(
        "rekeyer not checked",
        &metadata,
        json!({ "origin": w, "rekeyer": null }),
        verdict("verified", "unknown-signer", false),
        k(),
    );
    personal(
        "writer not checked",
        &metadata,
        json!({ "origin": null, "rekeyer": r }),
        verdict("unknown-signer", "verified", false),
        k(),
    );
    personal(
        "writer key replaced",
        &metadata,
        json!({ "origin": signer(&m.stranger, &[&m.writer.public_key]), "rekeyer": r }),
        verdict("retired-key", "verified", false),
        k(),
    );
    personal(
        "rekeyer key replaced",
        &version,
        json!({ "origin": w, "rekeyer": signer(&m.stranger, &[&m.rekeyer.public_key]) }),
        verdict("verified", "retired-key", false),
        k(),
    );
    personal(
        "writer signature over another record",
        &sign_as(&Built { signature: Some(m.version.signature.clone()), ..metadata.clone() }, &m.rekeyer),
        both.clone(),
        verdict("bad-signature", "verified", false),
        k(),
    );
    let other_name = metadata_seal(
        metadata_ctx(ms),
        m.node_key.clone(),
        NodeMetadata { name: format!("{} (swapped)", m.plaintext.name), ..m.plaintext.clone() },
    )
    .unwrap();
    let swapped = sign_as(&Built { envelope: other_name, ..metadata.clone() }, &m.rekeyer);
    personal("swapped metadata", &swapped, both.clone(), verdict("bad-signature", "verified", true), k());
    let other_content = version_reseal(
        version_ctx(vs),
        vs.content_suite,
        m.node_key.clone(),
        ContentKey { key: vec![9u8; 32].into(), ..m.version_record.clone() },
    )
    .unwrap();
    personal(
        "swapped version",
        &sign_as(&Built { envelope: other_content, ..version.clone() }, &m.rekeyer),
        both.clone(),
        verdict("bad-signature", "verified", true),
        k(),
    );
    let foreign = &m.other_version;
    personal(
        "origin from another version",
        &sign_as(
            &Built {
                envelope: version_reseal(
                    version_ctx(vs),
                    vs.content_suite,
                    m.node_key.clone(),
                    m.other_version_record.clone(),
                )
                .unwrap(),
                origin_envelope: foreign.envelope.clone(),
                signature: Some(foreign.signature.clone()),
                key_envelope: origin_key_wrap(
                    key_ctx(false, &foreign.envelope),
                    m.node_key.clone(),
                    origin_opening_key(foreign.envelope.clone(), m.old_node_key.clone()).unwrap(),
                )
                .unwrap(),
                ..version.clone()
            },
            &m.rekeyer,
        ),
        both.clone(),
        verdict("bad-signature", "verified", true),
        k(),
    );
    personal(
        "origin from another node",
        &sign_as(
            &Built {
                origin_envelope: m.other_node.envelope.clone(),
                signature: Some(m.other_node.signature.clone()),
                key_envelope: origin_key_wrap(
                    key_ctx(true, &m.other_node.envelope),
                    m.node_key.clone(),
                    origin_opening_key(m.other_node.envelope.clone(), m.old_node_key.clone()).unwrap(),
                )
                .unwrap(),
                ..metadata.clone()
            },
            &m.rekeyer,
        ),
        both.clone(),
        verdict("bad-signature", "verified", true),
        k(),
    );
    personal("no node key", &metadata, both.clone(), verdict("unchecked", "unchecked", false), Value::Null);
    personal("trust did not load", &metadata, Value::Null, verdict("unchecked", "unchecked", false), k());
    personal(
        "old node key",
        &metadata,
        both.clone(),
        verdict("bad-signature", "verified", true),
        json!(e(&m.old_node_key)),
    );
    let mut flipped = metadata.rekey_signature.clone().unwrap();
    flipped[5] ^= 1;
    personal(
        "rekey signature flipped",
        &Built { rekey_signature: Some(flipped), ..metadata.clone() },
        both.clone(),
        verdict("bad-signature", "bad-signature", true),
        k(),
    );
    personal(
        "rekey signature in a writer form",
        &Built {
            rekey_signature: Some(
                metadata_sign(m.rekeyer.seed.clone(), ms.clone(), metadata.envelope.clone()).unwrap(),
            ),
            ..metadata.clone()
        },
        both.clone(),
        verdict("bad-signature", "bad-signature", true),
        k(),
    );
    personal(
        "rekey signature missing",
        &Built { rekey_signature: None, ..metadata.clone() },
        both.clone(),
        verdict("bad-signature", "unsigned", true),
        k(),
    );
    personal(
        "rekey signature missing, rekeyer not checked",
        &Built { rekey_signature: None, ..version.clone() },
        json!({ "origin": w, "rekeyer": null }),
        verdict("bad-signature", "unsigned", true),
        k(),
    );
    personal(
        "writer account gone",
        &Built { signer_id: None, ..metadata.clone() },
        json!({ "origin": null, "rekeyer": r }),
        verdict("unknown-signer", "unchecked", false),
        k(),
    );
    personal(
        "origin unsigned",
        &Built { signature: None, ..metadata.clone() },
        both.clone(),
        verdict("bad-signature", "bad-signature", true),
        k(),
    );
    personal(
        "origin key as a content key",
        &Built {
            key_envelope: version_reseal(
                version_ctx(vs),
                1,
                m.node_key.clone(),
                ContentKey { key: version_origin_key.clone().into(), plaintext_size: 0, thumbnail_bytes: 0 },
            )
            .unwrap(),
            ..version.clone()
        },
        both.clone(),
        verdict("bad-signature", "verified", true),
        k(),
    );
    personal(
        "origin key as a node key",
        &Built {
            key_envelope: node_wrap(
                NodeKeyContext {
                    workspace_id: ms.workspace_id.clone(),
                    node_id: ms.node_id.clone(),
                    parent_id: m.parent_id.clone(),
                    parent_key_epoch: m.key_epoch,
                    key_epoch: m.key_epoch,
                },
                m.node_key.clone(),
                metadata_origin_key.clone(),
            )
            .unwrap(),
            ..metadata.clone()
        },
        both.clone(),
        verdict("bad-signature", "verified", true),
        k(),
    );
    personal(
        "stale epoch",
        &Built { key_epoch: m.key_epoch - 1, ..metadata.clone() },
        both.clone(),
        verdict("bad-signature", "bad-signature", true),
        k(),
    );
    personal(
        "rekeyed by the writer",
        &sign_as(&metadata, &m.writer),
        json!({ "origin": w, "rekeyer": w }),
        verdict("verified", "verified", false),
        k(),
    );

    let mut family = |name: &str, b: &Built, group: Value, expected: Value, key: Value| {
        let mut input = json_of(b);
        input.insert("nodeKey".into(), key);
        input.insert("group".into(), group);
        cases.push((name.to_string(), Value::Object(input), expected));
    };
    let g = Some(m.group.as_str());
    let both_roster = || json!({ "origin": roster(&m.writer.public_key, true), "originPersonal": null, "rekeyer": roster(&m.rekeyer.public_key, true), "rekeyerPersonal": null });
    family(
        "family writer left",
        &metadata,
        json!({ "origin": { "trust": "former-member", "signer": w, "linksLoaded": true }, "originPersonal": null, "rekeyer": roster(&m.rekeyer.public_key, true), "rekeyerPersonal": null }),
        json!({ "origin": side("former-member", None), "rekeyer": side("verified", g), "mismatch": false }),
        k(),
    );
    family(
        "family writer on the roster",
        &version,
        both_roster(),
        json!({ "origin": side("verified", g), "rekeyer": side("verified", g), "mismatch": false }),
        k(),
    );
    family(
        "family roster unavailable",
        &metadata,
        json!({ "origin": { "trust": "unchecked" }, "originPersonal": w, "rekeyer": { "trust": "unchecked" }, "rekeyerPersonal": r }),
        json!({ "origin": side("unchecked", None), "rekeyer": side("unchecked", None), "mismatch": false }),
        k(),
    );
    family(
        "family swapped metadata",
        &swapped,
        both_roster(),
        json!({ "origin": side("bad-signature", None), "rekeyer": side("verified", g), "mismatch": true }),
        k(),
    );
    family(
        "family rekeyer left",
        &metadata,
        json!({ "origin": roster(&m.writer.public_key, true), "originPersonal": null, "rekeyer": { "trust": "former-member", "signer": r, "linksLoaded": true }, "rekeyerPersonal": null }),
        json!({ "origin": side("verified", g), "rekeyer": side("former-member", None), "mismatch": false }),
        k(),
    );
    family(
        "family rekeyer unknown key, links not loaded",
        &metadata,
        json!({ "origin": roster(&m.writer.public_key, true), "originPersonal": null, "rekeyer": roster(&m.stranger, false), "rekeyerPersonal": null }),
        json!({ "origin": side("verified", g), "rekeyer": side("unchecked", None), "mismatch": false }),
        k(),
    );
    family(
        "family rekeyer unknown key, links loaded",
        &metadata,
        json!({ "origin": roster(&m.writer.public_key, true), "originPersonal": null, "rekeyer": roster(&m.stranger, true), "rekeyerPersonal": null }),
        json!({ "origin": side("bad-signature", None), "rekeyer": side("bad-signature", None), "mismatch": true }),
        k(),
    );
    family(
        "family writer outside the roster",
        &metadata,
        json!({ "origin": { "trust": "outside" }, "originPersonal": w, "rekeyer": roster(&m.rekeyer.public_key, true), "rekeyerPersonal": null }),
        json!({ "origin": side("verified", None), "rekeyer": side("verified", g), "mismatch": false }),
        k(),
    );
    family(
        "family writer key conflict",
        &metadata,
        json!({ "origin": { "trust": "key-conflict" }, "originPersonal": w, "rekeyer": roster(&m.rekeyer.public_key, true), "rekeyerPersonal": null }),
        json!({ "origin": side("key-conflict", None), "rekeyer": side("verified", g), "mismatch": false }),
        k(),
    );
    family(
        "family no node key",
        &metadata,
        both_roster(),
        json!({ "origin": side("unchecked", None), "rekeyer": side("unchecked", None), "mismatch": false }),
        Value::Null,
    );

    let statement_of = |b: &Built| {
        let origin = RecordOrigin {
            envelope: b.origin_envelope.clone(),
            signer_id: b.signer_id.clone().unwrap(),
            signature: b.signature.clone().unwrap(),
        };
        e(&if b.metadata {
            metadata_rekeyed_statement(ms.clone(), b.key_epoch, b.envelope.clone(), origin)
        } else {
            version_rekeyed_statement(vs.clone(), b.key_epoch, b.envelope.clone(), origin)
        }
        .unwrap())
    };
    Rekeyed {
        metadata: Value::Object(json_of(&metadata)),
        version: Value::Object(json_of(&version)),
        metadata_origin_key: e(&metadata_origin_key),
        version_origin_key: e(&version_origin_key),
        metadata_statement: statement_of(&metadata),
        version_statement: statement_of(&version),
        origins: vec![
            json!({ "envelope": e(&m.metadata.envelope), "record": "metadata", "workspaceId": ms.workspace_id, "nodeId": ms.node_id, "metadataVersion": ms.metadata_version }),
            json!({ "envelope": e(&m.other_node.envelope), "record": "metadata", "workspaceId": m.other_node.statement.workspace_id, "nodeId": m.other_node.statement.node_id, "metadataVersion": m.other_node.statement.metadata_version }),
            json!({ "envelope": e(&m.version.envelope), "record": "version", "workspaceId": vs.workspace_id, "nodeId": vs.node_id, "versionId": vs.version_id }),
            json!({ "envelope": e(&foreign.envelope), "record": "version", "workspaceId": foreign.statement.workspace_id, "nodeId": foreign.statement.node_id, "versionId": foreign.statement.version_id }),
        ],
        cases,
    }
}
