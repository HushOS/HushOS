//! Records sealed by the web app (`packages/crypto`) must open here byte for
//! byte. The fixture is written by `bun run --cwd packages/crypto fixtures:core`.

use hushos_core::*;
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/web.json")).expect("fixtures/web.json is JSON")
}

fn s(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_else(|| panic!("{key} is a string")).to_string()
}

fn b(value: &Value, key: &str) -> Vec<u8> {
    base64url_decode(s(value, key)).unwrap_or_else(|_| panic!("{key} is base64url"))
}

fn n(value: &Value, key: &str) -> u64 {
    value[key].as_u64().unwrap_or_else(|| panic!("{key} is a number"))
}

#[test]
fn the_account_key_opens_from_the_export_key_envelope() {
    let account = &fixture()["account"];
    let envelope = &account["envelope"];
    let opened = account_unlock(
        s(account, "userId"),
        b(account, "exportKey"),
        AccountKeyEnvelope {
            envelope_version: n(envelope, "envelopeVersion") as u32,
            key_version: n(envelope, "keyVersion"),
            credential_version: n(envelope, "credentialVersion"),
            wrapping_salt: s(envelope, "wrappingSalt"),
            wrapping_nonce: s(envelope, "wrappingNonce"),
            encrypted_key: s(envelope, "encryptedKey"),
        },
    )
    .expect("the web's account envelope opens");
    assert_eq!(opened, b(account, "accountKey"));
}

#[test]
fn the_remembered_device_bundle_opens_and_round_trips_through_json() {
    let device = &fixture()["device"];
    let bundle = remembered_device_from_json(device["bundle"].to_string()).expect("the web's bundle shape");
    assert_eq!(device_restore(bundle.clone(), b(device, "deviceKey")).unwrap(), b(device, "accountKey"));
    let again = remembered_device_from_json(remembered_device_to_json(bundle.clone())).unwrap();
    assert_eq!(again, bundle);
}

#[test]
fn the_workspace_grant_opens_to_the_key_the_web_read() {
    let workspace = &fixture()["workspace"];
    let grant = &workspace["grant"];
    let key = workspace_open(
        s(workspace, "userId"),
        b(workspace, "accountKey"),
        WorkspaceGrant {
            version: n(grant, "version") as u32,
            workspace_id: s(grant, "workspaceId"),
            key_version: n(grant, "keyVersion"),
            workspace_key_version: n(grant, "workspaceKeyVersion"),
            wrapping_salt: s(grant, "wrappingSalt"),
            wrapping_nonce: s(grant, "wrappingNonce"),
            encrypted_key: s(grant, "encryptedKey"),
        },
    )
    .unwrap();
    assert_eq!(key, b(workspace, "workspaceKey"));
}

fn node_ctx(ctx: &Value) -> NodeKeyContext {
    NodeKeyContext {
        workspace_id: s(ctx, "workspaceId"),
        node_id: s(ctx, "nodeId"),
        parent_id: s(ctx, "parentId"),
        parent_key_epoch: n(ctx, "parentKeyEpoch"),
        key_epoch: n(ctx, "keyEpoch"),
    }
}

#[test]
fn the_node_key_and_metadata_open_under_the_parent_key() {
    let node = &fixture()["node"];
    let key = node_open(node_ctx(&node["ctx"]), b(node, "parentKey"), b(node, "keyEnvelope")).unwrap();
    assert_eq!(key, b(node, "nodeKey"));
    let ctx = &node["metadataCtx"];
    let metadata = metadata_open(
        MetadataContext {
            workspace_id: s(ctx, "workspaceId"),
            node_id: s(ctx, "nodeId"),
            metadata_version: n(ctx, "metadataVersion"),
        },
        key,
        b(node, "metadataEnvelope"),
    )
    .unwrap();
    let expected = &node["metadata"];
    assert_eq!(metadata.name, s(expected, "name"));
    assert_eq!(metadata.mime.as_deref(), expected["mime"].as_str());
    assert_eq!(metadata.size, expected["size"].as_u64());
    assert_eq!(metadata.modified.as_deref(), expected["modified"].as_str());
}

fn version_ctx(ctx: &Value) -> VersionContext {
    VersionContext {
        workspace_id: s(ctx, "workspaceId"),
        node_id: s(ctx, "nodeId"),
        version_id: s(ctx, "versionId"),
        object_id: s(ctx, "objectId"),
    }
}

#[test]
fn a_suite_2_version_its_last_chunk_and_its_thumbnail_open() {
    let node = &fixture()["node"];
    let version = &node["version"];
    let ctx = &version["ctx"];
    let opened = version_open(
        version_ctx(ctx),
        n(ctx, "suite") as u32,
        b(node, "nodeKey"),
        b(version, "envelope"),
        None,
    )
    .unwrap();
    assert_eq!(opened.key, b(version, "contentKey"));
    assert_eq!(opened.plaintext_size, n(version, "plaintextSize"));
    assert_eq!(opened.thumbnail_bytes as u64, n(version, "thumbnailBytes"));
    let content = Content {
        workspace_id: s(ctx, "workspaceId"),
        object_id: s(ctx, "objectId"),
        suite: n(ctx, "suite") as u32,
        key: opened.key,
        nonce: b(version, "contentNonce"),
        plaintext_size: opened.plaintext_size,
        thumbnail_bytes: opened.thumbnail_bytes,
    };
    assert_eq!(content_layout(content.plaintext_size, content.thumbnail_bytes).chunk_count, 2);
    let chunk = &version["lastChunk"];
    assert_eq!(
        chunk_decrypt(content.clone(), n(chunk, "index"), b(chunk, "ciphertext")).unwrap(),
        b(chunk, "plaintext")
    );
    assert!(
        chunk_decrypt(content.clone(), 0, b(chunk, "ciphertext")).is_err(),
        "the index is in the context"
    );
    let thumbnail = &version["thumbnail"];
    assert_eq!(thumbnail_decrypt(content, b(thumbnail, "ciphertext")).unwrap(), b(thumbnail, "plaintext"));
}

#[test]
fn an_empty_file_sealed_by_the_web_opens() {
    let node = &fixture()["node"];
    let version = &node["version"];
    let empty = &node["emptyFile"];
    let content = Content {
        workspace_id: s(&version["ctx"], "workspaceId"),
        object_id: s(empty, "objectId"),
        suite: 2,
        key: b(version, "contentKey"),
        nonce: b(version, "contentNonce"),
        plaintext_size: 0,
        thumbnail_bytes: 0,
    };
    assert_eq!(chunk_decrypt(content, 0, b(empty, "ciphertext")).unwrap(), Vec::<u8>::new());
}

#[test]
fn a_legacy_suite_1_version_opens_with_the_row_size() {
    let node = &fixture()["node"];
    let legacy = &node["legacyVersion"];
    let ctx = &legacy["ctx"];
    let opened = version_open(
        version_ctx(ctx),
        n(ctx, "suite") as u32,
        b(node, "nodeKey"),
        b(legacy, "envelope"),
        Some(n(legacy, "rowSize")),
    )
    .unwrap();
    assert_eq!(opened.key, b(legacy, "contentKey"));
    assert_eq!(opened.plaintext_size, n(legacy, "rowSize"));
    assert_eq!(opened.thumbnail_bytes, 0);
}

#[test]
fn the_tags_registry_document_opens_under_the_workspace_key() {
    let document = &fixture()["document"];
    let ctx = &document["ctx"];
    let text = document_open(
        DocumentContext {
            workspace_id: s(ctx, "workspaceId"),
            kind: s(ctx, "kind"),
            version: n(ctx, "version"),
        },
        b(document, "workspaceKey"),
        b(document, "envelope"),
    )
    .unwrap();
    assert_eq!(text, s(document, "json"), "padding is trimmed and the JSON is byte for byte the web's");
}

fn identity(value: &Value) -> IdentityEnvelope {
    IdentityEnvelope {
        version: n(value, "version") as u32,
        key_version: n(value, "keyVersion"),
        wrapping_salt: s(value, "wrappingSalt"),
        encryption_public_key: s(value, "encryptionPublicKey"),
        encryption_private_key_nonce: s(value, "encryptionPrivateKeyNonce"),
        encrypted_encryption_private_key: s(value, "encryptedEncryptionPrivateKey"),
        signing_public_key: s(value, "signingPublicKey"),
        signing_seed_nonce: s(value, "signingSeedNonce"),
        encrypted_signing_seed: s(value, "encryptedSigningSeed"),
        kem: value["kem"].as_object().map(|kem| IdentityKem {
            public_key: kem["publicKey"].as_str().unwrap().into(),
            seed_nonce: kem["seedNonce"].as_str().unwrap().into(),
            encrypted_seed: kem["encryptedSeed"].as_str().unwrap().into(),
            signature: kem["signature"].as_str().unwrap().into(),
        }),
    }
}

#[test]
fn the_identity_opens_and_shares_in_both_suites_open_with_it() {
    let fixture = fixture();
    let account = &fixture["account"];
    let share = &fixture["share"];
    let keys =
        identity_open(s(account, "userId"), b(account, "accountKey"), identity(&share["identity"])).unwrap();
    assert_eq!(keys.kem_seed.len(), 64, "the web minted a KEM key");
    let ctx = &share["ctx"];
    let ctx = ShareContext {
        workspace_id: s(ctx, "workspaceId"),
        node_id: s(ctx, "nodeId"),
        key_epoch: n(ctx, "keyEpoch"),
        grantee_user_id: s(ctx, "granteeUserId"),
        granter_user_id: s(ctx, "granterUserId"),
    };
    assert_eq!(
        share_open(b(share, "classic"), b(share, "granterPublicKey"), keys.clone(), ctx.clone()).unwrap(),
        b(share, "nodeKey")
    );
    assert_eq!(
        share_open(b(share, "hybrid"), b(share, "granterPublicKey"), keys, ctx).unwrap(),
        b(share, "nodeKey")
    );
}

#[test]
fn a_password_link_opens_for_the_visitor_and_its_owner_copy_for_the_owner() {
    let link = &fixture()["link"];
    let ctx = &link["ctx"];
    let ctx = LinkContext {
        workspace_id: s(ctx, "workspaceId"),
        node_id: s(ctx, "nodeId"),
        key_epoch: n(ctx, "keyEpoch"),
        link_id: s(ctx, "linkId"),
    };
    let opened = link_open(
        ctx.clone(),
        b(link, "envelope"),
        b(link, "secret"),
        Some(s(link, "password")),
        b(link, "salt"),
    )
    .unwrap();
    assert_eq!(opened, b(link, "nodeKey"));
    assert!(link_open(ctx.clone(), b(link, "envelope"), b(link, "secret"), None, b(link, "salt")).is_err());
    let owned = link_secret_open(ctx.clone(), b(link, "nodeKey"), b(link, "secretEnvelope")).unwrap();
    assert_eq!((owned.secret, owned.token), (b(link, "secret"), b(link, "token")));
    let stretched = owned.from_password.expect("the web keeps the password key");
    assert_eq!(
        stretched,
        link_password_key(Some(s(link, "password")), b(link, "salt")).unwrap(),
        "argon2id matches hash-wasm"
    );
    // The owner re-seals without knowing the password; the visitor's URL still works.
    let resealed =
        link_reseal(ctx.clone(), b(link, "nodeKey"), b(link, "secretEnvelope"), Some("new password".into()))
            .unwrap();
    assert_eq!(resealed.token, s(link, "token"));
    assert_eq!(
        link_open(
            ctx,
            base64url_decode(resealed.link_envelope).unwrap(),
            b(link, "secret"),
            Some("new password".into()),
            base64url_decode(resealed.link_salt).unwrap()
        )
        .unwrap(),
        b(link, "nodeKey")
    );
}

fn recovery(value: &Value) -> RecoveryEnvelope {
    RecoveryEnvelope {
        version: n(value, "version") as u32,
        key_version: n(value, "keyVersion"),
        recovery_version: n(value, "recoveryVersion"),
        wrapping_salt: s(value, "wrappingSalt"),
        wrapping_nonce: s(value, "wrappingNonce"),
        encrypted_key: s(value, "encryptedKey"),
        backup_nonce: s(value, "backupNonce"),
        encrypted_recovery_key: s(value, "encryptedRecoveryKey"),
        public_key: s(value, "publicKey"),
    }
}

#[test]
fn the_recovery_phrase_the_web_made_opens_the_account_key_and_reads_back() {
    let fixture = fixture();
    let rec = &fixture["recovery"];
    let envelope = recovery(&rec["envelope"]);
    assert_eq!(
        recovery_open(s(rec, "userId"), s(rec, "phrase"), envelope.clone()).unwrap(),
        b(rec, "accountKey")
    );
    assert_eq!(
        recovery_phrase(s(rec, "userId"), b(rec, "accountKey"), envelope.clone()).unwrap(),
        s(rec, "phrase")
    );
    let mut words: Vec<&str> = rec["phrase"].as_str().unwrap().split(' ').collect();
    words.swap(0, 1);
    assert!(recovery_open(s(rec, "userId"), words.join(" "), envelope).is_err());
}

#[test]
fn the_identity_kem_binding_the_web_signed_verifies_and_a_swapped_key_does_not() {
    let fixture = fixture();
    let account = &fixture["account"];
    let identity = &fixture["share"]["identity"];
    let kem = &identity["kem"];
    assert!(kem_binding_verify(
        s(account, "userId"),
        s(identity, "encryptionPublicKey"),
        s(identity, "signingPublicKey"),
        s(kem, "publicKey"),
        s(kem, "signature")
    ));
    assert!(!kem_binding_verify(
        "someone-else".into(),
        s(identity, "encryptionPublicKey"),
        s(identity, "signingPublicKey"),
        s(kem, "publicKey"),
        s(kem, "signature")
    ));
    let mut other = base64url_decode(s(kem, "publicKey")).unwrap();
    other[0] ^= 1;
    assert!(!kem_binding_verify(
        s(account, "userId"),
        s(identity, "encryptionPublicKey"),
        s(identity, "signingPublicKey"),
        base64url_encode(other),
        s(kem, "signature")
    ));
}

#[test]
fn the_settings_document_the_web_sealed_opens_under_the_identity_key() {
    let settings = &fixture()["settings"];
    let env = &settings["envelope"];
    let envelope = SettingsEnvelope {
        version: n(env, "version") as u32,
        settings_version: n(env, "settingsVersion"),
        nonce: s(env, "nonce"),
        ciphertext: s(env, "ciphertext"),
    };
    assert_eq!(settings_open(b(settings, "identityPrivateKey"), s(settings, "userId"), envelope.clone()).unwrap(), s(settings, "json"));
    assert!(settings_open(base64url_decode(base64url_encode(vec![0u8; 32])).unwrap(), s(settings, "userId"), envelope).is_err());
}
