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
    let chunk_bytes = content_layout(3, 0, 0).unwrap().chunk_bytes;
    // One version of `size` bytes in `suite`, keeping chunk `index` and the thumbnail trailer if any.
    let version = |suite: u32, size: u64, thumbnail: Option<Vec<u8>>, index: u64| {
        let ctx = VersionContext {
            workspace_id: workspace_id.clone(),
            node_id: node_id.clone(),
            version_id: uuid(),
            object_id: uuid(),
        };
        let thumbnail_bytes = thumbnail.as_ref().map_or(0, |t| t.len() as u32);
        let opened = ContentKey { key: content_key.clone(), plaintext_size: size, thumbnail_bytes };
        let envelope = version_reseal(ctx.clone(), suite, node_key.clone(), opened).unwrap();
        let content = Content {
            workspace_id: workspace_id.clone(),
            object_id: ctx.object_id.clone(),
            suite,
            key: content_key.clone(),
            nonce: content_nonce.clone(),
            plaintext_size: size,
            thumbnail_bytes,
        };
        let file = pattern(chunk_length(size, index) as usize, 9);
        let layout = content_layout(suite, size, thumbnail_bytes).unwrap();
        json!({
            "ctx": { "workspaceId": ctx.workspace_id, "nodeId": ctx.node_id, "versionId": ctx.version_id, "objectId": ctx.object_id, "suite": suite },
            "contentKey": e(&content_key),
            "contentNonce": e(&content_nonce),
            "plaintextSize": size,
            "thumbnailBytes": thumbnail_bytes,
            "envelope": e(&envelope),
            "chunk": { "index": index, "chunkCount": layout.chunk_count, "plaintext": e(&file), "ciphertext": e(&chunk_encrypt(content.clone(), index, file.clone()).unwrap()) },
            "thumbnail": thumbnail.map(|t| json!({ "plaintext": e(&t), "ciphertext": e(&thumbnail_encrypt(content, t).unwrap()) })),
        })
    };
    let layouts: Vec<serde_json::Value> = [0, 1, 256, 257, 1000, chunk_bytes - 20, chunk_bytes, chunk_bytes + 1, 3_000_000_000, 1 << 40]
        .into_iter()
        .flat_map(|size| [0u32, 300, 65_536].into_iter().map(move |thumbnail| (size, thumbnail)))
        .flat_map(|(size, thumbnail)| {
            [2u32, 3].into_iter().map(move |suite| {
                let layout = content_layout(suite, size, thumbnail).unwrap();
                json!({ "suite": suite, "plaintextSize": size, "thumbnailBytes": thumbnail, "contentLength": layout.content_length, "chunkCount": layout.chunk_count, "ciphertextSize": layout.ciphertext_size })
            })
        })
        .collect();

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
        "hybrid": e(&report_seal_key(report_ctx, node_key.clone(), operator.clone()).unwrap()),
    });
    // A node key shared to the web's identity in suite 3 by a granter minted here; settings sealed as
    // version 2 under the web's settings key; and the web's identity succeeded here.
    let granter_root = random_bytes(32).unwrap();
    let granter_user = uuid();
    let granter_envelope = identity_create(granter_user.clone(), granter_root.clone(), 1).unwrap();
    let granter = identity_open(granter_user.clone(), granter_root, granter_envelope).unwrap();
    let share_ctx = ShareContext {
        workspace_id: workspace_id.clone(),
        node_id: node_id.clone(),
        key_epoch: 9,
        grantee_user_id: web_user.clone(),
        granter_user_id: granter_user,
    };
    let grantee_public = base64url_decode(str_of(web_identity, "encryptionPublicKey")).unwrap();
    let grantee_kem = base64url_decode(str_of(&web_identity["kem"], "publicKey")).unwrap();
    let share = json!({
        "ctx": { "workspaceId": share_ctx.workspace_id, "nodeId": share_ctx.node_id, "keyEpoch": share_ctx.key_epoch, "granteeUserId": share_ctx.grantee_user_id, "granterUserId": share_ctx.granter_user_id },
        "nodeKey": e(&node_key),
        "granterSigningPublicKey": granter.signing_public_key,
        "signed": e(&share_seal(share_ctx, node_key.clone(), granter.clone(), grantee_public, grantee_kem).unwrap()),
    });
    let web_settings = &web["settings"];
    let settings_json = r#"{"version":1,"contacts":{}}"#;
    let sealed_settings = settings_seal(
        web_user.clone(),
        base64url_decode(str_of(web_settings, "settingsKeyRaw")).unwrap(),
        5,
        settings_json.into(),
    )
    .unwrap();
    let made_key = settings_key_create(web_user.clone(), web_root.clone()).unwrap();
    let settings = json!({
        "userId": web_user,
        "json": settings_json,
        "envelope": { "version": sealed_settings.version, "settingsVersion": sealed_settings.settings_version, "nonce": sealed_settings.nonce, "ciphertext": sealed_settings.ciphertext },
        // A settings key made here under the web's root.
        "settingsKey": { "nonce": made_key.envelope.nonce, "ciphertext": made_key.envelope.ciphertext },
        "settingsKeyRaw": e(&made_key.key),
    });

    // Writer signatures by the granter's identity, over the node's metadata and its suite 3 version.
    let signed_metadata = MetadataStatement {
        workspace_id: workspace_id.clone(),
        node_id: node_id.clone(),
        kind: NodeKind::File,
        metadata_version: 3,
    };
    let signed_version = VersionStatement {
        workspace_id: workspace_id.clone(),
        node_id: node_id.clone(),
        version_id: uuid(),
        object_id: uuid(),
        content_suite: content_suite(),
    };
    let signed_version_envelope = version_seal(
        VersionContext {
            workspace_id: workspace_id.clone(),
            node_id: node_id.clone(),
            version_id: signed_version.version_id.clone(),
            object_id: signed_version.object_id.clone(),
        },
        node_key.clone(),
        content_key.clone(),
        1000,
        0,
    )
    .unwrap()
    .envelope;
    let signatures = json!({
        "signingPublicKey": granter.signing_public_key,
        "metadata": {
            "statement": { "workspaceId": signed_metadata.workspace_id, "nodeId": signed_metadata.node_id, "kind": "file", "metadataVersion": 3 },
            "envelope": e(&metadata_envelope),
            "signature": e(&metadata_sign(granter.signing_seed.clone(), signed_metadata, metadata_envelope.clone()).unwrap()),
        },
        "version": {
            "statement": { "workspaceId": signed_version.workspace_id, "nodeId": signed_version.node_id, "versionId": signed_version.version_id, "objectId": signed_version.object_id, "contentSuite": signed_version.content_suite },
            "envelope": e(&signed_version_envelope),
            "signature": e(&version_sign(granter.signing_seed.clone(), signed_version.clone(), signed_version_envelope.clone()).unwrap()),
        },
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
    let web_envelope = IdentityEnvelope {
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
    };
    let rewrapped_identity =
        identity_rewrap(web_user.clone(), web_root.clone(), new_root.clone(), web_envelope.clone()).unwrap();
    // The web's identity succeeded here: a successor under the web's root, signed by its key.
    let next = identity_succeed(web_user.clone(), web_root.clone(), web_envelope.clone()).unwrap();
    let n = &next.identity;
    let succession = json!({
        "userId": web_user,
        "identity": {
            "version": n.version, "keyVersion": n.key_version, "wrappingSalt": n.wrapping_salt,
            "encryptionPublicKey": n.encryption_public_key, "encryptionPrivateKeyNonce": n.encryption_private_key_nonce,
            "encryptedEncryptionPrivateKey": n.encrypted_encryption_private_key,
            "signingPublicKey": n.signing_public_key, "signingSeedNonce": n.signing_seed_nonce, "encryptedSigningSeed": n.encrypted_signing_seed,
            "kem": n.kem.as_ref().map(|k| json!({ "publicKey": k.public_key, "seedNonce": k.seed_nonce, "encryptedSeed": k.encrypted_seed, "signature": k.signature })),
        },
        "link": {
            "oldKeyVersion": web_envelope.key_version, "newKeyVersion": n.key_version,
            "oldEncryptionPublicKey": web_envelope.encryption_public_key, "oldSigningPublicKey": web_envelope.signing_public_key,
            "newEncryptionPublicKey": n.encryption_public_key, "newSigningPublicKey": n.signing_public_key,
            "newKemPublicKey": n.kem.as_ref().unwrap().public_key, "signature": next.signature,
        },
    });
    let rewrapped_settings_key = settings_key_rewrap(
        web_user.clone(),
        web_root.clone(),
        new_root.clone(),
        SettingsKeyEnvelope {
            nonce: str_of(&web_settings["settingsKey"], "nonce"),
            ciphertext: str_of(&web_settings["settingsKey"], "ciphertext"),
        },
    )
    .unwrap();
    let g = &rewrapped_grant;
    let i = &rewrapped_identity;
    let rotation = json!({
        "userId": web_user,
        "newRoot": e(&new_root),
        "workspaceKey": web["workspace"]["workspaceKey"],
        "settingsKey": { "nonce": rewrapped_settings_key.nonce, "ciphertext": rewrapped_settings_key.ciphertext },
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
        "signatures": signatures,
        "succession": succession,
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
            // Suite 3 with and without a thumbnail, an empty file, and suite 2's last chunk of two.
            "version": version(3, 1000, Some(pattern(300, 5)), 0),
            "bareVersion": version(3, 5, None, 0),
            "emptyVersion": version(3, 0, None, 0),
            "unpaddedVersion": version(2, chunk_bytes + 5, Some(pattern(300, 5)), 1),
        },
        "layouts": layouts,
    });
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/crypto/src/__fixtures__/core.json");
    fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&out).unwrap()))
        .expect("write the fixture");
    println!("wrote packages/crypto/src/__fixtures__/core.json");
}
