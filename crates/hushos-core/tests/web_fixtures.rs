//! Records sealed by the web app (`packages/crypto`) must open here byte for
//! byte. The fixture is written by `bun run --cwd packages/crypto fixtures:core`.

#[path = "common/rekeyed.rs"]
mod rekeyed;

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

fn grant_of(grant: &Value) -> WorkspaceGrant {
    WorkspaceGrant {
        version: n(grant, "version") as u32,
        workspace_id: s(grant, "workspaceId"),
        key_version: n(grant, "keyVersion"),
        workspace_key_version: n(grant, "workspaceKeyVersion"),
        wrapping_salt: s(grant, "wrappingSalt"),
        wrapping_nonce: s(grant, "wrappingNonce"),
        encrypted_key: s(grant, "encryptedKey"),
    }
}

#[test]
fn a_family_self_grant_the_web_rewrapped_for_a_rotation_opens_as_the_family_s_under_the_new_root() {
    let fixture = fixture();
    let area = &fixture["areaSelfGrant"];
    let (user, group) = (s(area, "userId"), s(area, "groupId"));
    let (old_root, new_root) = (b(area, "accountKey"), b(area, "newRoot"));
    let (grant, rewrapped) = (grant_of(&area["grant"]), grant_of(&area["rewrapped"]));
    assert_eq!(
        area_self_grant_open(user.clone(), group.clone(), old_root.clone(), grant.clone()).unwrap(),
        b(area, "areaKey")
    );
    assert_eq!(
        (rewrapped.key_version, rewrapped.workspace_key_version, &rewrapped.workspace_id),
        (3, grant.workspace_key_version, &grant.workspace_id)
    );
    assert_eq!(
        area_self_grant_open(user.clone(), group.clone(), new_root.clone(), rewrapped.clone()).unwrap(),
        b(area, "areaKey")
    );
    // Still bound to the family: neither the personal opener nor the old root opens it.
    assert!(workspace_open(user.clone(), new_root.clone(), rewrapped.clone()).is_err());
    assert!(area_self_grant_open(user.clone(), group, old_root.clone(), rewrapped).is_err());
    // The core's personal rewrap refuses the web's self-grant rather than rewrapping it wrongly.
    assert!(workspace_grant_rewrap(user, old_root, new_root, grant, 3).is_err());
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

/* Opens one version the web sealed, its kept chunk to the file's bytes, and its thumbnail if any. */
fn open_version(node: &Value, version: &Value) {
    let ctx = &version["ctx"];
    let suite = n(ctx, "suite") as u32;
    let opened =
        version_open(version_ctx(ctx), suite, b(node, "nodeKey"), b(version, "envelope"), None).unwrap();
    assert_eq!(opened.key, b(version, "contentKey"));
    assert_eq!(opened.plaintext_size, n(version, "plaintextSize"));
    assert_eq!(opened.thumbnail_bytes as u64, n(version, "thumbnailBytes"));
    if suite == 3 {
        assert!(
            version_open(version_ctx(ctx), 2, b(node, "nodeKey"), b(version, "envelope"), None).is_err(),
            "a suite 3 record is not a suite 2 one"
        );
    }
    let content = Content {
        workspace_id: s(ctx, "workspaceId"),
        object_id: s(ctx, "objectId"),
        suite,
        key: opened.key,
        nonce: b(version, "contentNonce"),
        plaintext_size: opened.plaintext_size,
        thumbnail_bytes: opened.thumbnail_bytes,
    };
    let chunk = &version["chunk"];
    let layout = content_layout(suite, content.plaintext_size, content.thumbnail_bytes).unwrap();
    assert_eq!(layout.chunk_count, n(chunk, "chunkCount"));
    let index = n(chunk, "index");
    assert_eq!(chunk_decrypt(content.clone(), index, b(chunk, "ciphertext")).unwrap(), b(chunk, "plaintext"));
    if layout.chunk_count > 1 {
        assert!(
            chunk_decrypt(content.clone(), index ^ 1, b(chunk, "ciphertext")).is_err(),
            "the index is bound"
        );
    }
    if version["thumbnail"].is_object() {
        let thumbnail = &version["thumbnail"];
        assert_eq!(
            thumbnail_decrypt(content, b(thumbnail, "ciphertext")).unwrap(),
            b(thumbnail, "plaintext")
        );
    }
}

#[test]
fn suite_3_versions_with_and_without_a_thumbnail_open_to_the_file() {
    let node = &fixture()["node"];
    for key in ["version", "bareVersion", "emptyVersion"] {
        assert_eq!(n(&node[key]["ctx"], "suite"), 3, "{key}");
        open_version(node, &node[key]);
    }
}

#[test]
fn a_suite_2_version_its_last_chunk_and_its_thumbnail_still_open() {
    let node = &fixture()["node"];
    assert_eq!(n(&node["unpaddedVersion"]["ctx"], "suite"), 2);
    open_version(node, &node["unpaddedVersion"]);
}

#[test]
fn the_layout_arithmetic_agrees_with_the_web() {
    let layouts = fixture()["layouts"].as_array().unwrap().clone();
    assert!(layouts.len() > 20);
    for row in layouts {
        let layout = content_layout(
            n(&row, "suite") as u32,
            n(&row, "plaintextSize"),
            n(&row, "thumbnailBytes") as u32,
        )
        .unwrap();
        assert_eq!(layout.content_length, n(&row, "contentLength"), "{row}");
        assert_eq!(layout.chunk_count, n(&row, "chunkCount"), "{row}");
        assert_eq!(layout.ciphertext_size, n(&row, "ciphertextSize"), "{row}");
    }
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
            signature: kem.get("signature").and_then(Value::as_str).map(Into::into),
        }),
        ml_dsa: value["mlDsa"].as_object().map(|ml_dsa| IdentityMlDsa {
            public_key: ml_dsa["publicKey"].as_str().unwrap().into(),
            seed_nonce: ml_dsa["seedNonce"].as_str().unwrap().into(),
            encrypted_seed: ml_dsa["encryptedSeed"].as_str().unwrap().into(),
        }),
        keys_signature: value["keysSignature"].as_str().map(Into::into),
    }
}

fn public_identity_of(value: &Value) -> PublicIdentity {
    PublicIdentity {
        key_version: n(value, "keyVersion"),
        encryption_public_key: s(value, "encryptionPublicKey"),
        signing_public_key: s(value, "signingPublicKey"),
        ml_dsa_public_key: s(value, "mlDsaPublicKey"),
        kem_public_key: s(value, "kemPublicKey"),
        keys_signature: s(value, "keysSignature"),
    }
}

#[test]
fn the_web_s_version_2_identity_opens_here_with_all_four_keys() {
    let fixture = fixture();
    let account = &fixture["account"];
    let envelope = identity(&fixture["share"]["identity"]);
    assert_eq!(envelope.version, 2);
    let keys = identity_open(s(account, "userId"), b(account, "accountKey"), envelope.clone()).unwrap();
    assert_eq!((keys.identity_version, keys.kem_seed.len(), keys.ml_dsa_seed.len()), (2, 64, 32));
    assert_eq!(keys.ml_dsa_public_key, envelope.ml_dsa.clone().map(|k| k.public_key));
    // Its keys statement is the one this core builds, and verifies here.
    assert!(identity_verify_keys(s(account, "userId"), public_identity(envelope.clone()).unwrap()));
    // Under another account's id it is not the web's identity.
    assert!(identity_open("someone-else".into(), b(account, "accountKey"), envelope).is_err());
}

fn share_ctx(ctx: &Value) -> ShareContext {
    ShareContext {
        workspace_id: s(ctx, "workspaceId"),
        node_id: s(ctx, "nodeId"),
        key_epoch: n(ctx, "keyEpoch"),
        grantee_user_id: s(ctx, "granteeUserId"),
        granter_user_id: s(ctx, "granterUserId"),
    }
}

#[test]
fn the_identity_opens_a_suite_4_share_from_its_signer_only_and_refuses_suites_1_2_and_3() {
    let fixture = fixture();
    let account = &fixture["account"];
    let share = &fixture["share"];
    let keys =
        identity_open(s(account, "userId"), b(account, "accountKey"), identity(&share["identity"])).unwrap();
    let ctx = share_ctx(&share["ctx"]);
    let granter = HybridPublicKey {
        signing_public_key: b(share, "granterSigningPublicKey"),
        ml_dsa_public_key: b(share, "granterMlDsaPublicKey"),
    };
    let signed = b(share, "signed");
    assert_eq!(signed.len(), 4565);
    assert_eq!(
        share_open(signed.clone(), granter.clone(), keys.clone(), ctx.clone()).unwrap(),
        b(share, "nodeKey")
    );
    // The web's hybrid signature over the share statement this core builds, both halves.
    let statement = share_statement(ctx.clone(), signed[..signed.len() - 3373].to_vec()).unwrap();
    assert!(hybrid_verify(granter.clone(), statement, signed[signed.len() - 3373..].to_vec()));
    // Only from its signer: the grantee's own keys, or either half swapped, open nothing.
    let own = HybridPublicKey {
        signing_public_key: base64url_decode(keys.signing_public_key.clone()).unwrap(),
        ml_dsa_public_key: base64url_decode(keys.ml_dsa_public_key.clone().unwrap()).unwrap(),
    };
    for other in [
        own.clone(),
        HybridPublicKey { signing_public_key: own.signing_public_key.clone(), ..granter.clone() },
        HybridPublicKey { ml_dsa_public_key: own.ml_dsa_public_key.clone(), ..granter.clone() },
    ] {
        assert!(matches!(
            share_open(signed.clone(), other, keys.clone(), ctx.clone()),
            Err(CoreError::Sealed(message)) if message.contains("not signed")
        ));
    }
    assert!(share_open(
        signed.clone(),
        granter.clone(),
        keys.clone(),
        ShareContext { key_epoch: 6, ..ctx.clone() }
    )
    .is_err());
    // Cut to suite 3's length, it opens nothing.
    assert!(share_open(signed[..1256].to_vec(), granter.clone(), keys.clone(), ctx.clone()).is_err());
    // Genuine suite 1, 2 and 3 shares the web made: refused, whatever key is offered.
    assert_eq!(b(share, "suite3").len(), 1256);
    for suite in ["classic", "hybrid", "suite3"] {
        assert!(
            matches!(
                share_open(b(share, suite), granter.clone(), keys.clone(), ctx.clone()),
                Err(CoreError::Input(message)) if message.contains("Invalid share envelope")
            ),
            "{suite}"
        );
    }
}

#[test]
fn the_web_s_writer_signatures_verify_and_nothing_near_them_does() {
    let signatures = &fixture()["signatures"];
    let public = b(signatures, "signingPublicKey");
    let metadata = &signatures["metadata"];
    let statement = MetadataStatement {
        workspace_id: s(&metadata["statement"], "workspaceId"),
        node_id: s(&metadata["statement"], "nodeId"),
        kind: NodeKind::File,
        metadata_version: n(&metadata["statement"], "metadataVersion"),
    };
    assert!(metadata_verify(
        public.clone(),
        statement.clone(),
        b(metadata, "envelope"),
        b(metadata, "signature")
    ));
    assert!(!metadata_verify(
        public.clone(),
        MetadataStatement { kind: NodeKind::Folder, ..statement.clone() },
        b(metadata, "envelope"),
        b(metadata, "signature")
    ));
    let current = TrustedKeys { current: public.clone(), retired: vec![] };
    // The web's successor key as current, the signer's key only as retired.
    let replaced = TrustedKeys {
        current: base64url_decode(s(&fixture()["succession"]["identity"], "signingPublicKey")).unwrap(),
        retired: vec![public.clone()],
    };
    let verdict = |trusted: &TrustedKeys, signature: &str| {
        metadata_integrity(
            Some(trusted.clone()),
            statement.clone(),
            b(metadata, "envelope"),
            Some(b(metadata, signature)),
        )
    };
    assert_eq!(verdict(&current, "signature"), Integrity::Verified);
    assert_eq!(verdict(&current, "resealed"), Integrity::Resealed);
    assert_eq!(verdict(&replaced, "signature"), Integrity::RetiredKey);
    assert_eq!(verdict(&replaced, "resealed"), Integrity::RetiredKey);
    assert!(!metadata_verify(
        public.clone(),
        statement.clone(),
        b(metadata, "envelope"),
        b(metadata, "resealed")
    ));
    assert!(metadata_resealed_verify(
        public.clone(),
        statement.clone(),
        b(metadata, "envelope"),
        b(metadata, "resealed")
    ));
    let version = &signatures["version"];
    let statement = VersionStatement {
        workspace_id: s(&version["statement"], "workspaceId"),
        node_id: s(&version["statement"], "nodeId"),
        version_id: s(&version["statement"], "versionId"),
        object_id: s(&version["statement"], "objectId"),
        content_suite: n(&version["statement"], "contentSuite") as u32,
    };
    assert!(version_verify(
        public.clone(),
        statement.clone(),
        b(version, "envelope"),
        b(version, "signature")
    ));
    assert!(!version_verify(
        public.clone(),
        VersionStatement { content_suite: 2, ..statement.clone() },
        b(version, "envelope"),
        b(version, "signature")
    ));
    let current = TrustedKeys { current: public, retired: vec![] };
    assert_eq!(
        version_integrity(
            Some(current.clone()),
            statement.clone(),
            b(version, "envelope"),
            Some(b(version, "resealed"))
        ),
        Integrity::Resealed
    );
    assert_eq!(
        version_integrity(Some(current), statement, b(version, "envelope"), Some(b(version, "signature"))),
        Integrity::Verified
    );
}

fn link(value: &Value) -> SuccessionLink {
    SuccessionLink {
        old_key_version: n(value, "oldKeyVersion"),
        new_key_version: n(value, "newKeyVersion"),
        old_encryption_public_key: s(value, "oldEncryptionPublicKey"),
        old_signing_public_key: s(value, "oldSigningPublicKey"),
        old_ml_dsa_public_key: s(value, "oldMlDsaPublicKey"),
        new_encryption_public_key: s(value, "newEncryptionPublicKey"),
        new_signing_public_key: s(value, "newSigningPublicKey"),
        new_ml_dsa_public_key: s(value, "newMlDsaPublicKey"),
        new_kem_public_key: s(value, "newKemPublicKey"),
        signature: s(value, "signature"),
        consent: None,
    }
}

fn old_signer(link: &SuccessionLink) -> SuccessionSigner {
    SuccessionSigner {
        signing_public_key: link.old_signing_public_key.clone(),
        ml_dsa_public_key: link.old_ml_dsa_public_key.clone(),
    }
}

#[test]
fn the_web_s_hybrid_succession_holds_here_and_its_new_identity_opens() {
    let succession = &fixture()["succession"];
    let user = s(succession, "userId");
    let link = link(&succession["link"]);
    // The statement bytes are the web's, byte for byte.
    assert_eq!(succession_statement(user.clone(), link.clone()).unwrap(), b(succession, "statement"));
    assert_eq!(base64url_decode(link.signature.clone()).unwrap().len(), 3373);
    assert!(succession_verify(user.clone(), link.clone(), old_signer(&link)));
    assert!(!succession_verify("someone-else".into(), link.clone(), old_signer(&link)));
    // Only under the old keys: never under the keys the link brings in.
    let new_signer = SuccessionSigner {
        signing_public_key: link.new_signing_public_key.clone(),
        ml_dsa_public_key: link.new_ml_dsa_public_key.clone(),
    };
    assert!(!succession_verify(user.clone(), link.clone(), new_signer));
    // Its Ed25519 half alone, or either half broken: not a succession.
    let signature = base64url_decode(link.signature.clone()).unwrap();
    let stripped = SuccessionLink { signature: base64url_encode(signature[..64].to_vec()), ..link.clone() };
    assert!(!succession_verify(user.clone(), stripped, old_signer(&link)));
    for at in [7, 64 + 7] {
        let mut broken = signature.clone();
        broken[at] ^= 1;
        let broken = SuccessionLink { signature: base64url_encode(broken), ..link.clone() };
        assert!(!succession_verify(user.clone(), broken, old_signer(&link)), "byte {at}");
    }
    let next = identity(&succession["identity"]);
    let keys = identity_open(user, b(succession, "accountKey"), next).unwrap();
    assert_eq!((keys.key_version, keys.identity_version), (link.new_key_version, 2));
}

#[test]
fn the_web_s_chain_holds_from_the_version_3_pin_to_the_served_keys_and_a_forged_one_does_not() {
    let succession = &fixture()["succession"];
    let user = s(succession, "userId");
    let chain = &succession["chain"];
    let links: Vec<SuccessionLink> = chain["links"].as_array().unwrap().iter().map(link).collect();
    let pin = &chain["pinned"];
    let pinned = PinnedKeys {
        key_version: Some(n(pin, "keyVersion")),
        encryption_public_key: s(pin, "encryptionPublicKey"),
        signing_public_key: s(pin, "signingPublicKey"),
        ml_dsa_public_key_hash: s(pin, "mlDsaPublicKeyHash"),
    };
    assert_eq!(
        pinned.ml_dsa_public_key_hash,
        key_digest(base64url_decode(links[0].old_ml_dsa_public_key.clone()).unwrap())
    );
    let now = &chain["served"];
    let served = ServedKeys {
        key_version: n(now, "keyVersion"),
        encryption_public_key: s(now, "encryptionPublicKey"),
        signing_public_key: s(now, "signingPublicKey"),
        ml_dsa_public_key: s(now, "mlDsaPublicKey"),
        kem_public_key: s(now, "kemPublicKey"),
    };
    assert!(succession_chain_verify(user.clone(), pinned.clone(), served.clone(), links.clone()));
    // A gap, a served key beside the chain's, a pin whose ML-DSA digest is another key's.
    assert!(!succession_chain_verify(user.clone(), pinned.clone(), served.clone(), links[1..].to_vec()));
    let beside = ServedKeys { ml_dsa_public_key: links[0].old_ml_dsa_public_key.clone(), ..served.clone() };
    assert!(!succession_chain_verify(user.clone(), pinned.clone(), beside, links.clone()));
    let other_pin = PinnedKeys {
        ml_dsa_public_key_hash: key_digest(base64url_decode(links[1].new_ml_dsa_public_key.clone()).unwrap()),
        ..pinned.clone()
    };
    assert!(!succession_chain_verify(user.clone(), other_pin, served.clone(), links.clone()));
    // The second link with its old ML-DSA key swapped for another: the chain breaks there.
    let mut forged = links.clone();
    forged[1].old_ml_dsa_public_key = links[1].new_ml_dsa_public_key.clone();
    assert!(!succession_chain_verify(user, pinned, served, forged));
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
    assert_eq!((owned.secret.to_vec(), owned.token), (b(link, "secret"), b(link, "token")));
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
fn the_web_s_keys_statement_is_this_core_s_byte_for_byte_and_its_signature_verifies() {
    let keys = &fixture()["keys"];
    let user = s(keys, "userId");
    let public = public_identity_of(&keys["identity"]);
    let statement = keys_statement(
        user.clone(),
        public.key_version,
        public.encryption_public_key.clone(),
        public.signing_public_key.clone(),
        public.ml_dsa_public_key.clone(),
        public.kem_public_key.clone(),
    )
    .unwrap();
    assert_eq!(statement, b(keys, "statement"));
    assert!(identity_verify_keys(user.clone(), public.clone()));
    assert!(!identity_verify_keys("someone-else".into(), public.clone()));
    let mut signature = base64url_decode(public.keys_signature.clone()).unwrap();
    signature[64 + 9] ^= 1;
    assert!(!identity_verify_keys(
        user,
        PublicIdentity { keys_signature: base64url_encode(signature), ..public }
    ));
}

#[test]
fn the_web_s_upgrades_keep_the_version_1_keys_and_open_here() {
    let upgrade = &fixture()["upgrade"];
    let (user, root) = (s(upgrade, "userId"), b(upgrade, "accountKey"));
    for (from, to) in [("legacy", "upgraded"), ("legacyNoKem", "upgradedNoKem")] {
        let legacy = identity(&upgrade[from]);
        let upgraded = identity(&upgrade[to]);
        assert_eq!((legacy.version, upgraded.version), (1, 2));
        assert_eq!(upgraded.key_version, legacy.key_version);
        assert_eq!(upgraded.encryption_public_key, legacy.encryption_public_key);
        assert_eq!(upgraded.signing_public_key, legacy.signing_public_key);
        if let Some(kem) = &legacy.kem {
            assert!(kem.signature.is_some(), "a genuine version 1 binding");
            assert_eq!(upgraded.kem.as_ref().unwrap().public_key, kem.public_key);
        }
        assert_eq!(upgraded.kem.as_ref().unwrap().signature, None, "the binding is dropped");
        let before = identity_open(user.clone(), root.clone(), legacy.clone()).unwrap();
        let after = identity_open(user.clone(), root.clone(), upgraded.clone()).unwrap();
        assert_eq!(before.identity_version, 1);
        assert_eq!(after.encryption_private_key.to_vec(), before.encryption_private_key.to_vec());
        assert_eq!(after.signing_seed.to_vec(), before.signing_seed.to_vec());
        assert!(identity_verify_keys(user.clone(), public_identity(upgraded.clone()).unwrap()));
        // Already version 2: no second ML-DSA key here either.
        assert!(identity_upgrade(user.clone(), root.clone(), upgraded).is_err());
    }
}

#[test]
fn the_fingerprint_is_the_web_s_version_3() {
    let fixture = fixture();
    let prints = &fixture["fingerprints"];
    assert_eq!(
        identity_fingerprint(vec![1; 32], vec![2; 32], vec![3; 32], vec![4; 32]).unwrap(),
        s(prints, "vector")
    );
    let envelope = identity(&fixture["share"]["identity"]);
    let print = identity_fingerprint_of_keys(
        base64url_decode(envelope.encryption_public_key.clone()).unwrap(),
        base64url_decode(envelope.signing_public_key.clone()).unwrap(),
        base64url_decode(envelope.ml_dsa.clone().unwrap().public_key).unwrap(),
        base64url_decode(envelope.kem.clone().unwrap().public_key).unwrap(),
    )
    .unwrap();
    assert_eq!(print, s(prints, "identity"));
    // The web's version 3 pin in its settings verifies here.
    let settings: Value = serde_json::from_str(&s(&fixture["settings"], "json")).unwrap();
    let (_, pin) = settings["contacts"].as_object().unwrap().iter().next().unwrap();
    assert!(pin_verified(
        s(pin, "encryptionPublicKey"),
        s(pin, "signingPublicKey"),
        pin["mlDsaPublicKeyHash"].as_str().map(Into::into),
        pin["kemPublicKeyHash"].as_str().map(Into::into),
        s(pin, "fingerprint"),
    ));
}

#[test]
fn the_web_s_settings_open_as_version_2_under_its_settings_key_and_version_1_reads_as_none() {
    let settings = &fixture()["settings"];
    let user = s(settings, "userId");
    let envelope = |value: &Value| SettingsEnvelope {
        version: n(value, "version") as u32,
        settings_version: n(value, "settingsVersion"),
        nonce: s(value, "nonce"),
        ciphertext: s(value, "ciphertext"),
    };
    let wrapped = SettingsKeyEnvelope {
        nonce: s(&settings["settingsKey"], "nonce"),
        ciphertext: s(&settings["settingsKey"], "ciphertext"),
    };
    let key = settings_key_open(user.clone(), b(settings, "accountKey"), wrapped).unwrap();
    assert_eq!(key, b(settings, "settingsKeyRaw"));
    let v2 = envelope(&settings["v2"]);
    assert_eq!(v2.version, 2);
    // The web read the document as version 1 and sealed it as version 2, as both must.
    let opened = settings_open(user.clone(), Some(key.clone()), v2.clone()).unwrap();
    assert_eq!(opened, Some(s(settings, "json")));
    let read: Value = serde_json::from_str(&s(settings, "readJson")).unwrap();
    let written: Value = serde_json::from_str(&opened.unwrap()).unwrap();
    assert_eq!((read["version"].clone(), written["version"].clone()), (Value::from(1), Value::from(2)));
    assert_eq!(read["contacts"], written["contacts"]);
    // The identity's private key is no settings key.
    assert!(settings_open(user.clone(), Some(b(settings, "identityPrivateKey")), v2).is_err());
    // A genuine version 1 document the web sealed under the identity's key: never opened.
    let v1 = envelope(&settings["envelope"]);
    assert_eq!(v1.version, 1);
    assert_eq!(settings_open(user.clone(), Some(key), v1.clone()).unwrap(), None);
    assert_eq!(settings_open(user, Some(b(settings, "identityPrivateKey")), v1).unwrap(), None);
}

#[test]
fn the_web_s_scoped_ids_derive_here_from_the_same_seed_and_scope() {
    let ids = fixture()["ids"].as_array().expect("ids").clone();
    assert_eq!(ids.len(), 15);
    for entry in ids {
        let kind = match s(&entry, "kind").as_str() {
            "node" => IdKind::Node,
            "version" => IdKind::Version,
            "object" => IdKind::Object,
            "link" => IdKind::Link,
            "report" => IdKind::Report,
            other => panic!("unknown kind {other}"),
        };
        assert_eq!(
            derive_id(kind, s(&entry, "scopeId"), s(&entry, "seed")).unwrap(),
            s(&entry, "id"),
            "{entry}"
        );
    }
}

#[test]
fn the_web_s_saved_signatures_read_as_saved_and_as_nothing_else() {
    let signatures = &fixture()["signatures"];
    let public = b(signatures, "signingPublicKey");
    let me = TrustedKeys { current: public.clone(), retired: vec![] };
    let metadata = &signatures["metadata"];
    let statement = MetadataStatement {
        workspace_id: s(&metadata["statement"], "workspaceId"),
        node_id: s(&metadata["statement"], "nodeId"),
        kind: NodeKind::File,
        metadata_version: n(&metadata["statement"], "metadataVersion"),
    };
    let saved = b(metadata, "saved");
    assert!(metadata_saved_verify(public.clone(), statement.clone(), b(metadata, "envelope"), saved.clone()));
    assert!(!metadata_verify(public.clone(), statement.clone(), b(metadata, "envelope"), saved.clone()));
    assert!(!metadata_resealed_verify(
        public.clone(),
        statement.clone(),
        b(metadata, "envelope"),
        saved.clone()
    ));
    assert!(!metadata_saved_verify(
        public.clone(),
        statement.clone(),
        b(metadata, "envelope"),
        b(metadata, "resealed")
    ));
    assert_eq!(
        metadata_integrity(Some(me.clone()), statement, b(metadata, "envelope"), Some(saved)),
        Integrity::SavedFromLink
    );
    let version = &signatures["version"];
    let statement = VersionStatement {
        workspace_id: s(&version["statement"], "workspaceId"),
        node_id: s(&version["statement"], "nodeId"),
        version_id: s(&version["statement"], "versionId"),
        object_id: s(&version["statement"], "objectId"),
        content_suite: n(&version["statement"], "contentSuite") as u32,
    };
    let saved = b(version, "saved");
    assert!(version_saved_verify(public.clone(), statement.clone(), b(version, "envelope"), saved.clone()));
    assert!(!version_verify(public.clone(), statement.clone(), b(version, "envelope"), saved.clone()));
    assert!(!version_saved_verify(
        public,
        statement.clone(),
        b(version, "envelope"),
        b(version, "signature")
    ));
    assert_eq!(
        version_integrity(Some(me), statement, b(version, "envelope"), Some(saved)),
        Integrity::SavedFromLink
    );
}

#[test]
fn the_web_s_device_session_proof_is_this_core_s_byte_for_byte() {
    let session = &fixture()["deviceSession"];
    let (user, device, attempt) = (s(session, "userId"), s(session, "deviceId"), s(session, "attemptToken"));
    // The statement both sides sign, and the digest of the attempt it names.
    let statement = device_session_statement(user.clone(), device.clone(), attempt.clone()).unwrap();
    assert_eq!(statement, b(session, "statement"));
    assert!(String::from_utf8(statement)
        .unwrap()
        .ends_with(&format!("\"{}\"]", s(session, "attemptDigest"))));
    // Ed25519 is deterministic: the same seed signs the same bytes here as libsodium did there.
    let seed = b(session, "seed");
    assert_eq!(device_signing_public_key(seed.clone()).unwrap(), b(session, "publicKey"));
    assert_eq!(
        device_session_sign(seed, user.clone(), device.clone(), attempt.clone()).unwrap(),
        s(session, "signature")
    );
    assert!(device_session_verify(
        b(session, "publicKey"),
        user.clone(),
        device.clone(),
        attempt.clone(),
        b(session, "signature")
    ));
    assert!(!device_session_verify(
        b(session, "publicKey"),
        user,
        device,
        format!("{attempt}x"),
        b(session, "signature")
    ));
    assert_eq!(device_email_hash(s(session, "email")), s(session, "emailDigest"));
}

/* A record of the web's rekeyed fixture as the core reads it. */
fn rekeyed_record(value: &Value) -> rekeyed::Input {
    let mut input = value.clone();
    input["nodeKey"] = Value::Null;
    input["trust"] = Value::Null;
    rekeyed::read(&input).expect("the web's rekeyed record reads")
}

#[test]
fn the_web_s_rekeyed_records_read_here_as_the_web_declared_every_case() {
    let fixture = &fixture()["rekeyed"];
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 40, "the cases are there");
    for case in cases {
        let name = s(case, "name");
        let input = rekeyed::read(&case["input"]).unwrap_or_else(|| panic!("{name} reads"));
        assert_eq!(rekeyed::judge(&input), case["expected"], "{name}");
        // The next rotation carries the origin exactly when the web said it would.
        assert_eq!(rekeyed::carried(&input), case["carried"].as_bool(), "{name}: carried");
    }
}

#[test]
fn the_web_s_rekeyed_statements_origin_keys_and_raw_reseals_are_this_core_s() {
    let fixture = &fixture()["rekeyed"];
    let (old, fresh) = (b(fixture, "oldNodeKey"), b(fixture, "nodeKey"));
    let rekeyer = b(&fixture["rekeyer"], "signingPublicKey");
    for (which, statement_key, origin_key) in [
        ("metadata", "metadataStatement", "metadataOriginKey"),
        ("version", "versionStatement", "versionOriginKey"),
    ] {
        let record = &fixture[which];
        let origin = &record["origin"];
        let (envelope, origin_envelope) = (b(record, "envelope"), b(origin, "envelope"));
        let named = RecordOrigin {
            envelope: origin_envelope.clone(),
            signer_id: s(origin, "signerId"),
            signature: b(origin, "signature"),
            key_envelope: b(origin, "keyEnvelope"),
        };
        let key_epoch = n(record, "keyEpoch");
        // The statement bytes, built here from the same fields, and the web's signature over them.
        let (statement, holds) = match rekeyed_record(record).record {
            rekeyed::Record::Metadata(r) => (
                metadata_rekeyed_statement(r.statement.clone(), key_epoch, envelope.clone(), named.clone())
                    .unwrap(),
                metadata_rekeyed_verify(
                    rekeyer.clone(),
                    r.statement,
                    key_epoch,
                    envelope.clone(),
                    named.clone(),
                    r.rekey_signature.unwrap(),
                ),
            ),
            rekeyed::Record::Version(r) => (
                version_rekeyed_statement(r.statement.clone(), key_epoch, envelope.clone(), named.clone())
                    .unwrap(),
                version_rekeyed_verify(
                    rekeyer.clone(),
                    r.statement,
                    key_epoch,
                    envelope.clone(),
                    named.clone(),
                    r.rekey_signature.unwrap(),
                ),
            ),
        };
        assert_eq!(base64url_encode(statement), s(fixture, statement_key), "{which}");
        assert!(holds, "{which}: the web's rekey signature verifies here");
        // The origin key: HChaCha20 of the old node key and the origin's nonce, as the web derived it.
        assert_eq!(
            base64url_encode(origin_opening_key(origin_envelope.clone(), old.clone()).unwrap()),
            s(fixture, origin_key)
        );
        let ctx = |position: OriginRecord| OriginKeyContext {
            workspace_id: s(&record["statement"], "workspaceId"),
            node_id: s(&record["statement"], "nodeId"),
            key_epoch,
            record: position,
            origin_envelope: origin_envelope.clone(),
        };
        let position = if which == "metadata" {
            OriginRecord::Metadata { metadata_version: n(&record["statement"], "metadataVersion") }
        } else {
            OriginRecord::Version { version_id: s(&record["statement"], "versionId") }
        };
        let opened = origin_key_open(ctx(position), fresh.clone(), b(origin, "keyEnvelope")).unwrap();
        assert_eq!(base64url_encode(opened), s(fixture, origin_key));
        // The web's wrapped origin key is no node key and no content key under the fresh key.
        let node_ctx = NodeKeyContext {
            workspace_id: s(&record["statement"], "workspaceId"),
            node_id: s(&record["statement"], "nodeId"),
            parent_id: s(&record["statement"], "nodeId"),
            parent_key_epoch: key_epoch,
            key_epoch,
        };
        assert!(node_open(node_ctx, fresh.clone(), b(origin, "keyEnvelope")).is_err());
        // And the core's own re-seal of the web's origin holds the same bytes as the web's re-seal.
        let mine = match rekeyed_record(record).record {
            rekeyed::Record::Metadata(r) => {
                let ctx = MetadataContext {
                    workspace_id: r.statement.workspace_id.clone(),
                    node_id: r.statement.node_id.clone(),
                    metadata_version: r.statement.metadata_version,
                };
                let mine =
                    metadata_rekey(ctx.clone(), old.clone(), fresh.clone(), origin_envelope.clone()).unwrap();
                assert_eq!(
                    metadata_open(ctx.clone(), fresh.clone(), mine.clone()).unwrap(),
                    metadata_open(ctx, fresh.clone(), envelope.clone()).unwrap()
                );
                mine
            }
            rekeyed::Record::Version(r) => {
                let ctx = VersionContext {
                    workspace_id: r.statement.workspace_id.clone(),
                    node_id: r.statement.node_id.clone(),
                    version_id: r.statement.version_id.clone(),
                    object_id: r.statement.object_id.clone(),
                };
                let suite = r.statement.content_suite;
                let mine =
                    version_rekey(ctx.clone(), suite, old.clone(), fresh.clone(), origin_envelope.clone())
                        .unwrap();
                let (a, b) = (
                    version_open(ctx.clone(), suite, fresh.clone(), mine.clone(), None).unwrap(),
                    version_open(ctx, suite, fresh.clone(), envelope.clone(), None).unwrap(),
                );
                assert_eq!(
                    (a.key, a.plaintext_size, a.thumbnail_bytes),
                    (b.key, b.plaintext_size, b.thumbnail_bytes)
                );
                mine
            }
        };
        assert_ne!(mine[..24], envelope[..24], "{which}: a fresh nonce");
        assert_eq!(mine.len(), envelope.len());
    }
}
