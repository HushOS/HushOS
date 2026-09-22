//! Records sealed by the Rust core for the web's code to open, the mirror of
//! `packages/crypto/scripts/core-fixtures.ts`. Writes
//! `packages/crypto/src/__fixtures__/core.json`; `bun run fixtures` at the
//! repository root runs both directions.

use hushos_core::*;
use serde_json::json;
use std::fs;
use std::path::PathBuf;

fn pattern(length: usize, seed: u8) -> Vec<u8> {
    (0..length).map(|i| ((i * 31 + seed as usize * 7 + ((i * seed as usize) >> 3)) & 0xff) as u8).collect()
}

fn uuid() -> String {
    let b = random_bytes(16).unwrap();
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-4{:01x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6] & 0x0f, b[7], (b[8] & 0x3f) | 0x80, b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    )
}

fn main() {
    let e = |bytes: &[u8]| base64url_encode(bytes.to_vec());
    let user_id = uuid();
    let workspace_id = uuid();
    let account_key = random_bytes(32).unwrap();

    let memory = device_remember(user_id.clone(), account_key.clone(), 2, 3, uuid()).unwrap();
    let device = json!({
        "bundle": serde_json::from_str::<serde_json::Value>(&remembered_device_to_json(memory.bundle.clone())).unwrap(),
        "deviceKey": e(&memory.device_key),
        "accountKey": e(&account_key),
    });

    let node_id = uuid();
    let parent_key = random_bytes(32).unwrap();
    let node_key = random_bytes(32).unwrap();
    let node_ctx = NodeKeyContext {
        workspace_id: workspace_id.clone(),
        node_id: node_id.clone(),
        parent_id: uuid(),
        parent_key_epoch: 4,
        key_epoch: 9,
    };
    let key_envelope = node_wrap(node_ctx.clone(), parent_key.clone(), node_key.clone()).unwrap();
    let metadata = NodeMetadata {
        name: "Quarterly report — final.pdf".into(),
        mime: Some("application/pdf".into()),
        size: Some(8_388_613),
        modified: Some("2026-09-22T10:00:00.000Z".into()),
    };
    let metadata_ctx =
        MetadataContext { workspace_id: workspace_id.clone(), node_id: node_id.clone(), metadata_version: 3 };
    let metadata_envelope = metadata_seal(metadata_ctx.clone(), node_key.clone(), metadata.clone()).unwrap();

    let content_key = random_bytes(32).unwrap();
    let content_nonce = random_bytes(16).unwrap();
    let object_id = uuid();
    let version_id = uuid();
    let plaintext_size: u64 = 8 * 1024 * 1024 + 5;
    let thumbnail = pattern(300, 5);
    let version_ctx = VersionContext {
        workspace_id: workspace_id.clone(),
        node_id: node_id.clone(),
        version_id: version_id.clone(),
        object_id: object_id.clone(),
    };
    let sealed = version_seal(
        version_ctx.clone(),
        node_key.clone(),
        content_key.clone(),
        plaintext_size,
        thumbnail.len() as u32,
    )
    .unwrap();
    let content = Content {
        workspace_id: workspace_id.clone(),
        object_id: object_id.clone(),
        suite: 2,
        key: content_key.clone(),
        nonce: content_nonce.clone(),
        plaintext_size,
        thumbnail_bytes: thumbnail.len() as u32,
    };
    let last_chunk = pattern(5, 9);
    let empty_object_id = uuid();
    let empty = Content {
        object_id: empty_object_id.clone(),
        plaintext_size: 0,
        thumbnail_bytes: 0,
        ..content.clone()
    };

    let export_key = random_bytes(64).unwrap();
    let account_envelope =
        account_seal(user_id.clone(), export_key.clone(), account_key.clone(), 2, 3).unwrap();
    let account = json!({
        "userId": user_id,
        "exportKey": e(&export_key),
        "envelope": {
            "envelopeVersion": account_envelope.envelope_version, "keyVersion": account_envelope.key_version, "credentialVersion": account_envelope.credential_version,
            "wrappingSalt": account_envelope.wrapping_salt, "wrappingNonce": account_envelope.wrapping_nonce, "encryptedKey": account_envelope.encrypted_key,
        },
        "accountKey": e(&account_key),
    });

    let registry = format!(
        r#"{{"version":2,"tags":[{{"id":"{}","name":"Tax","colour":"blue"}}],"items":{{}}}}"#,
        uuid()
    );
    let document_ctx =
        DocumentContext { workspace_id: workspace_id.clone(), kind: "tags".into(), version: 3 };
    let document = json!({
        "ctx": { "workspaceId": workspace_id, "kind": "tags", "version": 3 },
        "workspaceKey": e(&parent_key),
        "json": registry,
        "envelope": e(&document_seal(document_ctx, parent_key.clone(), registry.clone()).unwrap()),
    });

    // A password link the web's visitor page and owner dialog must open.
    let link_ctx = LinkContext {
        workspace_id: workspace_id.clone(),
        node_id: node_id.clone(),
        key_epoch: 9,
        link_id: uuid(),
    };
    let created = link_create(link_ctx.clone(), node_key.clone(), Some("open sesame".into())).unwrap();
    let link = json!({
        "ctx": { "workspaceId": link_ctx.workspace_id, "nodeId": link_ctx.node_id, "keyEpoch": link_ctx.key_epoch, "linkId": link_ctx.link_id },
        "nodeKey": e(&node_key),
        "password": "open sesame",
        "token": created.token, "secret": created.secret, "salt": created.link_salt,
        "envelope": created.link_envelope, "secretEnvelope": created.secret_envelope,
    });

    // A recovery key the web's recover page must accept.
    let made = recovery_create(user_id.clone(), account_key.clone(), 3, 2).unwrap();
    let r = &made.envelope;
    let recovery = json!({
        "userId": user_id, "accountKey": e(&account_key), "phrase": made.phrase,
        "envelope": {
            "version": r.version, "keyVersion": r.key_version, "recoveryVersion": r.recovery_version,
            "wrappingSalt": r.wrapping_salt, "wrappingNonce": r.wrapping_nonce, "encryptedKey": r.encrypted_key,
            "backupNonce": r.backup_nonce, "encryptedRecoveryKey": r.encrypted_recovery_key, "publicKey": r.public_key,
        },
    });

    // Against the web's own fixture: its identity as the operator of a report, and its grant and identity rewrapped under a new root.
    let web: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/web.json")).expect("fixtures/web.json");
    let web_user = web["account"]["userId"].as_str().unwrap().to_string();
    let web_root = base64url_decode(web["account"]["accountKey"].as_str().unwrap().into()).unwrap();
    let web_identity = &web["share"]["identity"];
    let str_of = |v: &serde_json::Value, k: &str| v[k].as_str().unwrap().to_string();
    let operator = OperatorKeys {
        user_id: web_user.clone(),
        encryption_public_key: str_of(web_identity, "encryptionPublicKey"),
        signing_public_key: str_of(web_identity, "signingPublicKey"),
        kem: Some(OperatorKem {
            public_key: str_of(&web_identity["kem"], "publicKey"),
            signature: str_of(&web_identity["kem"], "signature"),
        }),
    };
    let report_ctx = ReportContext {
        workspace_id: workspace_id.clone(),
        node_id: node_id.clone(),
        key_epoch: 9,
        report_id: uuid(),
        operator_user_id: web_user.clone(),
    };
    let report = json!({
        "ctx": { "workspaceId": report_ctx.workspace_id, "nodeId": report_ctx.node_id, "keyEpoch": report_ctx.key_epoch, "reportId": report_ctx.report_id, "operatorUserId": report_ctx.operator_user_id },
        "nodeKey": e(&node_key),
        "hybrid": e(&report_seal_key(report_ctx.clone(), node_key.clone(), operator.clone()).unwrap()),
        "classic": e(&report_seal_key(report_ctx, node_key.clone(), OperatorKeys { kem: None, ..operator }).unwrap()),
    });
    // A node key shared to the web's identity from a granter minted here, in both suites; and its settings resealed.
    let granter_secret = random_bytes(32).unwrap();
    let granter_public = {
        let secret: [u8; 32] = granter_secret.clone().try_into().unwrap();
        x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(secret)).to_bytes().to_vec()
    };
    let share_ctx = ShareContext { workspace_id: workspace_id.clone(), node_id: node_id.clone(), key_epoch: 9, grantee_user_id: web_user.clone(), granter_user_id: uuid() };
    let grantee_public = base64url_decode(str_of(web_identity, "encryptionPublicKey")).unwrap();
    let grantee_kem = base64url_decode(str_of(&web_identity["kem"], "publicKey")).unwrap();
    let share = json!({
        "ctx": { "workspaceId": share_ctx.workspace_id, "nodeId": share_ctx.node_id, "keyEpoch": share_ctx.key_epoch, "granteeUserId": share_ctx.grantee_user_id, "granterUserId": share_ctx.granter_user_id },
        "nodeKey": e(&node_key),
        "granterPublicKey": e(&granter_public),
        "classic": e(&share_seal(share_ctx.clone(), node_key.clone(), granter_secret.clone(), grantee_public.clone(), None).unwrap()),
        "hybrid": e(&share_seal(share_ctx, node_key.clone(), granter_secret, grantee_public, Some(grantee_kem)).unwrap()),
    });
    let web_settings = &web["settings"];
    let settings_json = r#"{"version":1,"contacts":{}}"#;
    let sealed_settings = settings_seal(base64url_decode(str_of(web_settings, "identityPrivateKey")).unwrap(), web_user.clone(), 5, settings_json.into()).unwrap();
    let settings = json!({
        "userId": web_user,
        "json": settings_json,
        "envelope": { "version": sealed_settings.version, "settingsVersion": sealed_settings.settings_version, "nonce": sealed_settings.nonce, "ciphertext": sealed_settings.ciphertext },
    });
    let new_root = random_bytes(32).unwrap();
    let grant = &web["workspace"]["grant"];
    let rewrapped_grant = workspace_grant_rewrap(
        web_user.clone(),
        web_root.clone(),
        new_root.clone(),
        WorkspaceGrant {
            version: grant["version"].as_u64().unwrap() as u32,
            workspace_id: str_of(grant, "workspaceId"),
            key_version: grant["keyVersion"].as_u64().unwrap(),
            workspace_key_version: grant["workspaceKeyVersion"].as_u64().unwrap(),
            wrapping_salt: str_of(grant, "wrappingSalt"),
            wrapping_nonce: str_of(grant, "wrappingNonce"),
            encrypted_key: str_of(grant, "encryptedKey"),
        },
        7,
    )
    .unwrap();
    let kem = web_identity["kem"].as_object().map(|kem| IdentityKem {
        public_key: kem["publicKey"].as_str().unwrap().into(),
        seed_nonce: kem["seedNonce"].as_str().unwrap().into(),
        encrypted_seed: kem["encryptedSeed"].as_str().unwrap().into(),
        signature: kem["signature"].as_str().unwrap().into(),
    });
    let rewrapped_identity = identity_rewrap(
        web_user.clone(),
        web_root,
        new_root.clone(),
        IdentityEnvelope {
            version: web_identity["version"].as_u64().unwrap() as u32,
            key_version: web_identity["keyVersion"].as_u64().unwrap(),
            wrapping_salt: str_of(web_identity, "wrappingSalt"),
            encryption_public_key: str_of(web_identity, "encryptionPublicKey"),
            encryption_private_key_nonce: str_of(web_identity, "encryptionPrivateKeyNonce"),
            encrypted_encryption_private_key: str_of(web_identity, "encryptedEncryptionPrivateKey"),
            signing_public_key: str_of(web_identity, "signingPublicKey"),
            signing_seed_nonce: str_of(web_identity, "signingSeedNonce"),
            encrypted_signing_seed: str_of(web_identity, "encryptedSigningSeed"),
            kem,
        },
        7,
    )
    .unwrap();
    let g = &rewrapped_grant;
    let i = &rewrapped_identity;
    let rotation = json!({
        "userId": web_user,
        "newRoot": e(&new_root),
        "workspaceKey": web["workspace"]["workspaceKey"],
        "grant": {
            "version": g.version, "workspaceId": g.workspace_id, "keyVersion": g.key_version, "workspaceKeyVersion": g.workspace_key_version,
            "wrappingSalt": g.wrapping_salt, "wrappingNonce": g.wrapping_nonce, "encryptedKey": g.encrypted_key,
        },
        "identity": {
            "version": i.version, "keyVersion": i.key_version, "wrappingSalt": i.wrapping_salt,
            "encryptionPublicKey": i.encryption_public_key, "encryptionPrivateKeyNonce": i.encryption_private_key_nonce,
            "encryptedEncryptionPrivateKey": i.encrypted_encryption_private_key,
            "signingPublicKey": i.signing_public_key, "signingSeedNonce": i.signing_seed_nonce, "encryptedSigningSeed": i.encrypted_signing_seed,
            "kem": i.kem.as_ref().map(|k| json!({ "publicKey": k.public_key, "seedNonce": k.seed_nonce, "encryptedSeed": k.encrypted_seed, "signature": k.signature })),
        },
    });

    let out = json!({
        "generatedBy": "crates/hushos-core/examples/fixtures.rs",
        "link": link,
        "recovery": recovery,
        "report": report,
        "rotation": rotation,
        "share": share,
        "settings": settings,
        "document": document,
        "account": account,
        "device": device,
        "node": {
            "ctx": { "workspaceId": node_ctx.workspace_id, "nodeId": node_ctx.node_id, "parentId": node_ctx.parent_id, "parentKeyEpoch": node_ctx.parent_key_epoch, "keyEpoch": node_ctx.key_epoch },
            "parentKey": e(&parent_key),
            "nodeKey": e(&node_key),
            "keyEnvelope": e(&key_envelope),
            "metadata": { "name": metadata.name, "mime": metadata.mime, "size": metadata.size, "modified": metadata.modified },
            "metadataCtx": { "workspaceId": metadata_ctx.workspace_id, "nodeId": metadata_ctx.node_id, "metadataVersion": metadata_ctx.metadata_version },
            "metadataEnvelope": e(&metadata_envelope),
            "version": {
                "ctx": { "workspaceId": workspace_id, "nodeId": node_id, "versionId": version_id, "objectId": object_id, "suite": 2 },
                "contentKey": e(&content_key),
                "contentNonce": e(&content_nonce),
                "plaintextSize": plaintext_size,
                "thumbnailBytes": thumbnail.len(),
                "envelope": e(&sealed.envelope),
                "lastChunk": { "index": 1, "plaintext": e(&last_chunk), "ciphertext": e(&chunk_encrypt(content.clone(), 1, last_chunk.clone()).unwrap()) },
                "thumbnail": { "plaintext": e(&thumbnail), "ciphertext": e(&thumbnail_encrypt(content.clone(), thumbnail.clone()).unwrap()) },
            },
            "emptyFile": { "objectId": empty_object_id, "ciphertext": e(&chunk_encrypt(empty, 0, vec![]).unwrap()) },
        },
    });
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/crypto/src/__fixtures__/core.json");
    fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&out).unwrap()))
        .expect("write the fixture");
    println!("wrote packages/crypto/src/__fixtures__/core.json");
}
