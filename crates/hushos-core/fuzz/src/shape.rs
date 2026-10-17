//! Reading a target's JSON input into the core's types. The inputs are the
//! web's JSON shapes (camelCase, bytes as base64url), so the TypeScript twin
//! reads the same document. A value the Rust types cannot hold (a negative or
//! fractional number where a `u64` goes, a missing field) is `None`: the
//! target skips it, and the differential does not compare it, since the
//! bindings refuse such a value before the core sees it.

use hushos_core::*;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

pub fn object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

pub fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

/* A missing or null field is `Some(None)`; a string is `Some(Some(..))`; anything else does not fit. */
pub fn optional_text(value: &Value, key: &str) -> Option<Option<String>> {
    match value.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(text)) => Some(Some(text.clone())),
        Some(_) => None,
    }
}

/* A JSON number a u64 holds exactly: `1`, `1.0` and `1e0` alike, as JSON.parse reads them. */
pub fn unsigned(value: &Value) -> Option<u64> {
    if let Some(n) = value.as_u64() {
        return Some(n);
    }
    let f = value.as_f64()?;
    // 2^64 itself is out of range; every f64 below it with no fraction is a u64.
    (f.fract() == 0.0 && (0.0..18_446_744_073_709_551_616.0).contains(&f)).then_some(f as u64)
}

pub fn number(value: &Value, key: &str) -> Option<u64> {
    unsigned(value.get(key)?)
}

pub fn small(value: &Value, key: &str) -> Option<u32> {
    number(value, key).and_then(|n| u32::try_from(n).ok())
}

pub fn optional_number(value: &Value, key: &str) -> Option<Option<u64>> {
    match value.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(n) => unsigned(n).map(Some),
    }
}

/* Bytes a harness carries as base64url ("" for none); not canonical base64url does not fit. */
pub fn bytes(value: &Value, key: &str) -> Option<Vec<u8>> {
    let text = text(value, key)?;
    if text.is_empty() {
        return Some(vec![]);
    }
    base64url_decode(text).ok()
}

pub fn encoded(bytes: &[u8]) -> String {
    base64url_encode(bytes.to_vec())
}

fn kind(name: &str) -> Option<GroupKind> {
    match name {
        "family" => Some(GroupKind::Family),
        "org" => Some(GroupKind::Org),
        _ => None,
    }
}

fn kind_name(kind: GroupKind) -> &'static str {
    match kind {
        GroupKind::Family => "family",
        GroupKind::Org => "org",
    }
}

fn role(name: &str) -> Option<GroupRole> {
    Some(match name {
        "billing" => GroupRole::Billing,
        "data_admin" => GroupRole::DataAdmin,
        "guardian" => GroupRole::Guardian,
        "members" => GroupRole::Members,
        "recovery" => GroupRole::Recovery,
        _ => return None,
    })
}

fn role_name(role: GroupRole) -> &'static str {
    match role {
        GroupRole::Billing => "billing",
        GroupRole::DataAdmin => "data_admin",
        GroupRole::Guardian => "guardian",
        GroupRole::Members => "members",
        GroupRole::Recovery => "recovery",
    }
}

/*
 * A roster object as the web types it, or None. A kind, role or status
 * outside the enums also does not fit: the web refuses those as it encodes
 * (oneOf), and Rust cannot even hold them.
 */
pub fn roster(value: &Value) -> Option<Roster> {
    object(value)?;
    let kind = kind(&text(value, "kind")?)?;
    let members = value
        .get("members")?
        .as_array()?
        .iter()
        .map(|m| {
            object(m)?;
            Some(RosterMember {
                user_id: text(m, "userId")?,
                key_version: number(m, "keyVersion")?,
                encryption_public_key: text(m, "encryptionPublicKey")?,
                signing_public_key: text(m, "signingPublicKey")?,
                ml_dsa_public_key_digest: text(m, "mlDsaPublicKeyDigest")?,
                kem_public_key_digest: text(m, "kemPublicKeyDigest")?,
                status: match text(m, "status")?.as_str() {
                    "active" => MemberStatus::Active,
                    "left" => MemberStatus::Left,
                    _ => return None,
                },
                roles: m
                    .get("roles")?
                    .as_array()?
                    .iter()
                    .map(|r| role(r.as_str()?))
                    .collect::<Option<Vec<_>>>()?,
                since_version: number(m, "sinceVersion")?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let areas = match value.get("areas") {
        None | Some(Value::Null) => vec![],
        Some(areas) => areas
            .as_array()?
            .iter()
            .map(|a| {
                object(a)?;
                Some(RosterArea {
                    workspace_id: text(a, "workspaceId")?,
                    workspace_key_version: number(a, "workspaceKeyVersion")?,
                    commitment: text(a, "commitment")?,
                })
            })
            .collect::<Option<Vec<_>>>()?,
    };
    Some(Roster {
        group_id: text(value, "groupId")?,
        kind,
        roster_version: number(value, "rosterVersion")?,
        previous_roster_digest: text(value, "previousRosterDigest")?,
        group_key_version: number(value, "groupKeyVersion")?,
        signer_user_id: text(value, "signerUserId")?,
        members,
        areas,
    })
}

pub fn roster_json(roster: &Roster) -> Value {
    json!({
        "groupId": roster.group_id,
        "kind": kind_name(roster.kind),
        "rosterVersion": roster.roster_version,
        "previousRosterDigest": roster.previous_roster_digest,
        "groupKeyVersion": roster.group_key_version,
        "signerUserId": roster.signer_user_id,
        "members": roster.members.iter().map(|m| json!({
            "userId": m.user_id,
            "keyVersion": m.key_version,
            "encryptionPublicKey": m.encryption_public_key,
            "signingPublicKey": m.signing_public_key,
            "mlDsaPublicKeyDigest": m.ml_dsa_public_key_digest,
            "kemPublicKeyDigest": m.kem_public_key_digest,
            "status": match m.status { MemberStatus::Active => "active", MemberStatus::Left => "left" },
            "roles": m.roles.iter().map(|r| role_name(*r)).collect::<Vec<_>>(),
            "sinceVersion": m.since_version,
        })).collect::<Vec<_>>(),
        "areas": roster.areas.iter().map(|a| json!({
            "workspaceId": a.workspace_id,
            "workspaceKeyVersion": a.workspace_key_version,
            "commitment": a.commitment,
        })).collect::<Vec<_>>(),
    })
}

pub fn succession_json(s: &GroupKeySuccession) -> Value {
    json!({
        "groupId": s.group_id,
        "oldVersion": s.old_version,
        "newVersion": s.new_version,
        "oldEd25519PublicKey": s.old_ed25519_public_key,
        "oldMlDsaPublicKey": s.old_ml_dsa_public_key,
        "newEd25519PublicKey": s.new_ed25519_public_key,
        "newMlDsaPublicKey": s.new_ml_dsa_public_key,
        "lastRosterVersion": s.last_roster_version,
        "lastRosterDigest": s.last_roster_digest,
        "signerUserId": s.signer_user_id,
    })
}

pub fn share_context(value: &Value) -> Option<ShareContext> {
    object(value)?;
    Some(ShareContext {
        workspace_id: text(value, "workspaceId")?,
        node_id: text(value, "nodeId")?,
        key_epoch: number(value, "keyEpoch")?,
        grantee_user_id: text(value, "granteeUserId")?,
        granter_user_id: text(value, "granterUserId")?,
    })
}

pub fn key_seal_context(value: &Value) -> Option<GroupKeySealContext> {
    object(value)?;
    Some(GroupKeySealContext {
        group_id: text(value, "groupId")?,
        group_key_version: number(value, "groupKeyVersion")?,
        holder_user_id: text(value, "holderUserId")?,
        holder_key_version: number(value, "holderKeyVersion")?,
        sealer_user_id: text(value, "sealerUserId")?,
        roster_version: number(value, "rosterVersion")?,
        roster_digest: text(value, "rosterDigest")?,
    })
}

pub fn area_grant_context(value: &Value) -> Option<AreaGrantContext> {
    object(value)?;
    Some(AreaGrantContext {
        group_id: text(value, "groupId")?,
        workspace_id: text(value, "workspaceId")?,
        workspace_key_version: number(value, "workspaceKeyVersion")?,
        grantee_user_id: text(value, "granteeUserId")?,
        grantee_key_version: number(value, "granteeKeyVersion")?,
        granter_user_id: text(value, "granterUserId")?,
        roster_version: number(value, "rosterVersion")?,
        roster_digest: text(value, "rosterDigest")?,
    })
}

pub fn link(value: &Value) -> Option<SuccessionLink> {
    object(value)?;
    Some(SuccessionLink {
        old_key_version: number(value, "oldKeyVersion")?,
        new_key_version: number(value, "newKeyVersion")?,
        old_encryption_public_key: text(value, "oldEncryptionPublicKey")?,
        old_signing_public_key: text(value, "oldSigningPublicKey")?,
        old_ml_dsa_public_key: text(value, "oldMlDsaPublicKey")?,
        new_encryption_public_key: text(value, "newEncryptionPublicKey")?,
        new_signing_public_key: text(value, "newSigningPublicKey")?,
        new_ml_dsa_public_key: text(value, "newMlDsaPublicKey")?,
        new_kem_public_key: text(value, "newKemPublicKey")?,
        signature: text(value, "signature")?,
        consent: optional_text(value, "consent")?,
    })
}

pub fn signer(value: &Value) -> Option<SuccessionSigner> {
    object(value)?;
    Some(SuccessionSigner {
        signing_public_key: text(value, "signingPublicKey")?,
        ml_dsa_public_key: text(value, "mlDsaPublicKey")?,
    })
}

pub fn pinned(value: &Value) -> Option<PinnedKeys> {
    object(value)?;
    Some(PinnedKeys {
        key_version: optional_number(value, "keyVersion")?,
        encryption_public_key: text(value, "encryptionPublicKey")?,
        signing_public_key: text(value, "signingPublicKey")?,
        ml_dsa_public_key_hash: text(value, "mlDsaPublicKeyHash")?,
    })
}

pub fn served(value: &Value) -> Option<ServedKeys> {
    object(value)?;
    Some(ServedKeys {
        key_version: number(value, "keyVersion")?,
        encryption_public_key: text(value, "encryptionPublicKey")?,
        signing_public_key: text(value, "signingPublicKey")?,
        ml_dsa_public_key: text(value, "mlDsaPublicKey")?,
        kem_public_key: text(value, "kemPublicKey")?,
    })
}

pub fn public_identity(value: &Value) -> Option<PublicIdentity> {
    object(value)?;
    Some(PublicIdentity {
        key_version: number(value, "keyVersion")?,
        encryption_public_key: text(value, "encryptionPublicKey")?,
        signing_public_key: text(value, "signingPublicKey")?,
        ml_dsa_public_key: text(value, "mlDsaPublicKey")?,
        kem_public_key: text(value, "kemPublicKey")?,
        keys_signature: text(value, "keysSignature")?,
    })
}

pub fn public_identity_json(identity: &PublicIdentity) -> Value {
    json!({
        "keyVersion": identity.key_version,
        "encryptionPublicKey": identity.encryption_public_key,
        "signingPublicKey": identity.signing_public_key,
        "mlDsaPublicKey": identity.ml_dsa_public_key,
        "kemPublicKey": identity.kem_public_key,
        "keysSignature": identity.keys_signature,
    })
}

fn nullable<T>(value: &Value, key: &str, read: impl Fn(&Value) -> Option<T>) -> Option<Option<T>> {
    match value.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(inner) => read(inner).map(Some),
    }
}

pub fn envelope(value: &Value) -> Option<IdentityEnvelope> {
    object(value)?;
    Some(IdentityEnvelope {
        version: small(value, "version")?,
        key_version: number(value, "keyVersion")?,
        wrapping_salt: text(value, "wrappingSalt")?,
        encryption_public_key: text(value, "encryptionPublicKey")?,
        encryption_private_key_nonce: text(value, "encryptionPrivateKeyNonce")?,
        encrypted_encryption_private_key: text(value, "encryptedEncryptionPrivateKey")?,
        signing_public_key: text(value, "signingPublicKey")?,
        signing_seed_nonce: text(value, "signingSeedNonce")?,
        encrypted_signing_seed: text(value, "encryptedSigningSeed")?,
        kem: nullable(value, "kem", |kem| {
            object(kem)?;
            Some(IdentityKem {
                public_key: text(kem, "publicKey")?,
                seed_nonce: text(kem, "seedNonce")?,
                encrypted_seed: text(kem, "encryptedSeed")?,
                signature: optional_text(kem, "signature")?,
            })
        })?,
        ml_dsa: nullable(value, "mlDsa", |ml_dsa| {
            object(ml_dsa)?;
            Some(IdentityMlDsa {
                public_key: text(ml_dsa, "publicKey")?,
                seed_nonce: text(ml_dsa, "seedNonce")?,
                encrypted_seed: text(ml_dsa, "encryptedSeed")?,
            })
        })?,
        keys_signature: optional_text(value, "keysSignature")?,
    })
}

pub fn group_pin(value: &Value) -> Option<GroupPin> {
    object(value)?;
    Some(GroupPin {
        first_ed25519_public_key: text(value, "firstEd25519PublicKey")?,
        first_ml_dsa_public_key_digest: text(value, "firstMlDsaPublicKeyDigest")?,
        checked_at: text(value, "checkedAt")?,
        key_version: number(value, "keyVersion")?,
        group_key_digest: text(value, "groupKeyDigest")?,
        roster_version: number(value, "rosterVersion")?,
        roster_digest: text(value, "rosterDigest")?,
        areas: object(value.get("areas")?)?
            .iter()
            .map(|(id, version)| Some((id.clone(), unsigned(version)?)))
            .collect::<Option<HashMap<_, _>>>()?,
    })
}

pub fn group_pin_json(pin: &GroupPin) -> Value {
    json!({
        "firstEd25519PublicKey": pin.first_ed25519_public_key,
        "firstMlDsaPublicKeyDigest": pin.first_ml_dsa_public_key_digest,
        "checkedAt": pin.checked_at,
        "keyVersion": pin.key_version,
        "groupKeyDigest": pin.group_key_digest,
        "rosterVersion": pin.roster_version,
        "rosterDigest": pin.roster_digest,
        "areas": pin.areas,
    })
}

pub fn group_key(value: &Value) -> Option<GroupPublicKey> {
    object(value)?;
    Some(GroupPublicKey {
        ed25519_public_key: text(value, "ed25519PublicKey")?,
        ml_dsa_public_key: text(value, "mlDsaPublicKey")?,
    })
}

/* A drive metadata statement's fields; a kind other than folder or file does not fit. */
pub fn metadata_statement(value: &Value) -> Option<MetadataStatement> {
    let (workspace_id, node_id, metadata_version) =
        (text(value, "workspaceId")?, text(value, "nodeId")?, number(value, "metadataVersion")?);
    let kind = match text(value, "kind")?.as_str() {
        "folder" => NodeKind::Folder,
        "file" => NodeKind::File,
        _ => return None,
    };
    Some(MetadataStatement { workspace_id, node_id, kind, metadata_version })
}

pub fn version_statement(value: &Value) -> Option<VersionStatement> {
    Some(VersionStatement {
        workspace_id: text(value, "workspaceId")?,
        node_id: text(value, "nodeId")?,
        version_id: text(value, "versionId")?,
        object_id: text(value, "objectId")?,
        content_suite: small(value, "contentSuite")?,
    })
}

/* The writer's record a rekeyed statement names. */
pub fn record_origin(value: &Value) -> Option<RecordOrigin> {
    Some(RecordOrigin {
        envelope: bytes(value, "envelope")?,
        signer_id: text(value, "signerId")?,
        signature: bytes(value, "signature")?,
        key_envelope: bytes(value, "keyEnvelope")?,
    })
}
