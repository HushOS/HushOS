//! Records sealed by the Rust core for the web's code to open, the mirror of
//! `packages/crypto/scripts/core-fixtures.ts`. Writes
//! `packages/crypto/src/__fixtures__/core.json`; `bun run fixtures` at the
//! repository root runs both directions.

#[path = "../tests/common/rekeyed.rs"]
mod rekeyed;

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

/* An identity envelope as the API and the web write it. */
fn envelope_json(envelope: &IdentityEnvelope) -> serde_json::Value {
    json!({
        "version": envelope.version, "keyVersion": envelope.key_version, "wrappingSalt": envelope.wrapping_salt,
        "encryptionPublicKey": envelope.encryption_public_key, "encryptionPrivateKeyNonce": envelope.encryption_private_key_nonce,
        "encryptedEncryptionPrivateKey": envelope.encrypted_encryption_private_key,
        "signingPublicKey": envelope.signing_public_key, "signingSeedNonce": envelope.signing_seed_nonce, "encryptedSigningSeed": envelope.encrypted_signing_seed,
        "kem": envelope.kem.as_ref().map(|k| {
            let mut kem = json!({ "publicKey": k.public_key, "seedNonce": k.seed_nonce, "encryptedSeed": k.encrypted_seed });
            if let Some(signature) = &k.signature {
                kem["signature"] = json!(signature);
            }
            kem
        }),
        "mlDsa": envelope.ml_dsa.as_ref().map(|k| json!({ "publicKey": k.public_key, "seedNonce": k.seed_nonce, "encryptedSeed": k.encrypted_seed })),
        "keysSignature": envelope.keys_signature,
    })
}

fn envelope_of(value: &serde_json::Value) -> IdentityEnvelope {
    let text = |v: &serde_json::Value, k: &str| v[k].as_str().unwrap_or_else(|| panic!("{k}")).to_string();
    IdentityEnvelope {
        version: value["version"].as_u64().unwrap() as u32,
        key_version: value["keyVersion"].as_u64().unwrap(),
        wrapping_salt: text(value, "wrappingSalt"),
        encryption_public_key: text(value, "encryptionPublicKey"),
        encryption_private_key_nonce: text(value, "encryptionPrivateKeyNonce"),
        encrypted_encryption_private_key: text(value, "encryptedEncryptionPrivateKey"),
        signing_public_key: text(value, "signingPublicKey"),
        signing_seed_nonce: text(value, "signingSeedNonce"),
        encrypted_signing_seed: text(value, "encryptedSigningSeed"),
        kem: value["kem"].as_object().map(|_| IdentityKem {
            public_key: text(&value["kem"], "publicKey"),
            seed_nonce: text(&value["kem"], "seedNonce"),
            encrypted_seed: text(&value["kem"], "encryptedSeed"),
            signature: value["kem"]["signature"].as_str().map(Into::into),
        }),
        ml_dsa: value["mlDsa"].as_object().map(|_| IdentityMlDsa {
            public_key: text(&value["mlDsa"], "publicKey"),
            seed_nonce: text(&value["mlDsa"], "seedNonce"),
            encrypted_seed: text(&value["mlDsa"], "encryptedSeed"),
        }),
        keys_signature: value["keysSignature"].as_str().map(Into::into),
    }
}

fn link_json(link: &SuccessionLink) -> serde_json::Value {
    json!({
        "oldKeyVersion": link.old_key_version, "newKeyVersion": link.new_key_version,
        "oldEncryptionPublicKey": link.old_encryption_public_key, "oldSigningPublicKey": link.old_signing_public_key,
        "oldMlDsaPublicKey": link.old_ml_dsa_public_key,
        "newEncryptionPublicKey": link.new_encryption_public_key, "newSigningPublicKey": link.new_signing_public_key,
        "newMlDsaPublicKey": link.new_ml_dsa_public_key, "newKemPublicKey": link.new_kem_public_key,
        "signature": link.signature,
    })
}

/* The link the server would serve for a succession from `old` to `next`. */
fn link_of(old: &IdentityEnvelope, next: &IdentitySuccession) -> SuccessionLink {
    let n = &next.identity;
    SuccessionLink {
        old_key_version: old.key_version,
        new_key_version: n.key_version,
        old_encryption_public_key: old.encryption_public_key.clone(),
        old_signing_public_key: old.signing_public_key.clone(),
        old_ml_dsa_public_key: old.ml_dsa.as_ref().unwrap().public_key.clone(),
        new_encryption_public_key: n.encryption_public_key.clone(),
        new_signing_public_key: n.signing_public_key.clone(),
        new_ml_dsa_public_key: n.ml_dsa.as_ref().unwrap().public_key.clone(),
        new_kem_public_key: n.kem.as_ref().unwrap().public_key.clone(),
        signature: next.signature.clone(),
        consent: None,
    }
}

fn version_ctx_of(s: &VersionStatement) -> VersionContext {
    VersionContext {
        workspace_id: s.workspace_id.clone(),
        node_id: s.node_id.clone(),
        version_id: s.version_id.clone(),
        object_id: s.object_id.clone(),
    }
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
        let opened = ContentKey { key: content_key.clone().into(), plaintext_size: size, thumbnail_bytes };
        let envelope = version_reseal(ctx.clone(), suite, node_key.clone(), opened).unwrap();
        let content = Content {
            workspace_id: workspace_id.clone(),
            object_id: ctx.object_id.clone(),
            suite,
            key: content_key.clone().into(),
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
    let web_envelope = envelope_of(web_identity);
    let str_of = |v: &serde_json::Value, k: &str| v[k].as_str().unwrap().to_string();
    // The web's version 2 identity as an operator: its KEM key is used once its keys statement holds.
    let operator = OperatorKeys {
        user_id: web_user.clone(),
        key_version: web_envelope.key_version,
        encryption_public_key: web_envelope.encryption_public_key.clone(),
        signing_public_key: web_envelope.signing_public_key.clone(),
        ml_dsa_public_key: web_envelope.ml_dsa.as_ref().map(|k| k.public_key.clone()),
        kem_public_key: web_envelope.kem.as_ref().map(|k| k.public_key.clone()),
        keys_signature: web_envelope.keys_signature.clone(),
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
        // The web's version 1 identity as an operator: sealed to its served KEM key, unchecked.
        "legacyHybrid": e(&report_seal_key(report_ctx, node_key.clone(), {
            let legacy = envelope_of(&web["upgrade"]["legacy"]);
            OperatorKeys {
                user_id: web_user.clone(),
                key_version: legacy.key_version,
                encryption_public_key: legacy.encryption_public_key.clone(),
                signing_public_key: legacy.signing_public_key.clone(),
                ml_dsa_public_key: None,
                kem_public_key: legacy.kem.map(|k| k.public_key),
                keys_signature: None,
            }
        }).unwrap()),
    });
    // A version 2 identity minted here, which the web opens; a node key it shares to the web's identity
    // in suite 4; settings sealed as version 2 under the web's settings key; and the web's identity
    // succeeded and upgraded here.
    let granter_root = random_bytes(32).unwrap();
    let granter_user = uuid();
    let granter_envelope = identity_create(granter_user.clone(), granter_root.clone(), 1).unwrap();
    let granter =
        identity_open(granter_user.clone(), granter_root.clone(), granter_envelope.clone()).unwrap();
    let granter_public = public_identity(granter_envelope.clone()).unwrap();
    let identity_made_here = json!({
        "userId": granter_user,
        "accountKey": e(&granter_root),
        "envelope": envelope_json(&granter_envelope),
    });
    let keys = json!({
        "userId": granter_user,
        "identity": {
            "keyVersion": granter_public.key_version, "encryptionPublicKey": granter_public.encryption_public_key,
            "signingPublicKey": granter_public.signing_public_key, "mlDsaPublicKey": granter_public.ml_dsa_public_key,
            "kemPublicKey": granter_public.kem_public_key, "keysSignature": granter_public.keys_signature,
        },
        "statement": e(&keys_statement(
            granter_user.clone(),
            granter_public.key_version,
            granter_public.encryption_public_key.clone(),
            granter_public.signing_public_key.clone(),
            granter_public.ml_dsa_public_key.clone(),
            granter_public.kem_public_key.clone(),
        ).unwrap()),
    });
    let b = |value: &str| base64url_decode(value.to_string()).unwrap();
    let fingerprints = json!({
        "vector": identity_fingerprint(vec![1; 32], vec![2; 32], vec![3; 32], vec![4; 32]).unwrap(),
        "identity": identity_fingerprint_of_keys(
            b(&granter_public.encryption_public_key),
            b(&granter_public.signing_public_key),
            b(&granter_public.ml_dsa_public_key),
            b(&granter_public.kem_public_key),
        ).unwrap(),
    });
    let share_ctx = ShareContext {
        workspace_id: workspace_id.clone(),
        node_id: node_id.clone(),
        key_epoch: 9,
        grantee_user_id: web_user.clone(),
        granter_user_id: granter_user.clone(),
    };
    let grantee_public = base64url_decode(str_of(web_identity, "encryptionPublicKey")).unwrap();
    let grantee_kem = base64url_decode(str_of(&web_identity["kem"], "publicKey")).unwrap();
    let share = json!({
        "ctx": { "workspaceId": share_ctx.workspace_id, "nodeId": share_ctx.node_id, "keyEpoch": share_ctx.key_epoch, "granteeUserId": share_ctx.grantee_user_id, "granterUserId": share_ctx.granter_user_id },
        "nodeKey": e(&node_key),
        "granterSigningPublicKey": granter.signing_public_key,
        "granterMlDsaPublicKey": granter.ml_dsa_public_key,
        "signed": e(&share_seal(share_ctx, node_key.clone(), granter.clone(), grantee_public, grantee_kem).unwrap()),
    });
    let web_settings = &web["settings"];
    // A version 3 pin, in a document read as version 1: sealed here as version 2.
    let (pin_x, pin_ed, pin_ml_dsa, pin_kem) =
        (random_bytes(32).unwrap(), random_bytes(32).unwrap(), pattern(1952, 3), pattern(1184, 4));
    let pin = json!({
        "userId": uuid(), "email": "friend@example.com", "name": "Friend",
        "encryptionPublicKey": e(&pin_x), "signingPublicKey": e(&pin_ed),
        "mlDsaPublicKeyHash": key_digest(pin_ml_dsa.clone()), "kemPublicKeyHash": key_digest(pin_kem.clone()),
        "fingerprint": identity_fingerprint_of_keys(pin_x, pin_ed, pin_ml_dsa, pin_kem).unwrap(),
        "pinnedAt": "2026-10-15T00:00:00.000Z", "keyVersion": 1,
    });
    let settings_json = json!({ "version": 1, "contacts": { uuid(): pin } }).to_string();
    let settings_json = settings_json.as_str();
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
        // What was sealed, a document read as version 1; it opens as version 2.
        "readJson": settings_json,
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
    let signed_metadata_rekeyed = signed_metadata.clone();
    let signatures = json!({
        "signingPublicKey": granter.signing_public_key,
        "metadata": {
            "statement": { "workspaceId": signed_metadata.workspace_id, "nodeId": signed_metadata.node_id, "kind": "file", "metadataVersion": 3 },
            "envelope": e(&metadata_envelope),
            "signature": e(&metadata_sign(granter.signing_seed.to_vec(), signed_metadata.clone(), metadata_envelope.clone()).unwrap()),
            "resealed": e(&metadata_resealed_sign(granter.signing_seed.to_vec(), signed_metadata.clone(), metadata_envelope.clone()).unwrap()),
            "saved": e(&metadata_saved_sign(granter.signing_seed.to_vec(), signed_metadata, metadata_envelope.clone()).unwrap()),
        },
        "version": {
            "statement": { "workspaceId": signed_version.workspace_id, "nodeId": signed_version.node_id, "versionId": signed_version.version_id, "objectId": signed_version.object_id, "contentSuite": signed_version.content_suite },
            "envelope": e(&signed_version_envelope),
            "signature": e(&version_sign(granter.signing_seed.to_vec(), signed_version.clone(), signed_version_envelope.clone()).unwrap()),
            "resealed": e(&version_resealed_sign(granter.signing_seed.to_vec(), signed_version.clone(), signed_version_envelope.clone()).unwrap()),
            "saved": e(&version_saved_sign(granter.signing_seed.to_vec(), signed_version.clone(), signed_version_envelope.clone()).unwrap()),
        },
    });

    // Re-keyed records (docs/integrity-design.md): the granter's metadata and version above, re-keyed to
    // the next epoch by another account keeping them as origins, and the cases both twins judge alike.
    let rekeyer_seed = random_bytes(32).unwrap();
    let rekeyer = rekeyed::CaseSigner {
        user_id: uuid(),
        seed: rekeyer_seed.clone(),
        public_key: signing_public_key(rekeyer_seed).unwrap(),
    };
    let writer = rekeyed::CaseSigner {
        user_id: granter_user.to_uppercase(),
        seed: granter.signing_seed.to_vec(),
        public_key: base64url_decode(granter.signing_public_key.clone()).unwrap(),
    };
    let other_version = VersionStatement { version_id: uuid(), object_id: uuid(), ..signed_version.clone() };
    let other_version_envelope =
        version_seal(version_ctx_of(&other_version), node_key.clone(), content_key.clone(), 5, 0)
            .unwrap()
            .envelope;
    let other_node = MetadataStatement { node_id: uuid(), ..signed_metadata_rekeyed.clone() };
    let other_node_envelope = metadata_seal(
        MetadataContext {
            workspace_id: workspace_id.clone(),
            node_id: other_node.node_id.clone(),
            metadata_version: 3,
        },
        node_key.clone(),
        metadata.clone(),
    )
    .unwrap();
    let fresh_node_key = random_bytes(32).unwrap();
    let made = rekeyed::rekeyed_cases(&rekeyed::CaseMaterial {
        old_node_key: node_key.clone(),
        node_key: fresh_node_key.clone(),
        key_epoch: node_ctx.key_epoch + 1,
        parent_id: node_ctx.parent_id.clone(),
        writer: writer.clone(),
        rekeyer: rekeyer.clone(),
        stranger: signing_public_key(random_bytes(32).unwrap()).unwrap(),
        group: uuid(),
        metadata: rekeyed::Written {
            statement: signed_metadata_rekeyed.clone(),
            envelope: metadata_envelope.clone(),
            signature: metadata_sign(
                granter.signing_seed.to_vec(),
                signed_metadata_rekeyed.clone(),
                metadata_envelope.clone(),
            )
            .unwrap(),
        },
        plaintext: metadata.clone(),
        version: rekeyed::Written {
            statement: signed_version.clone(),
            envelope: signed_version_envelope.clone(),
            signature: version_sign(
                granter.signing_seed.to_vec(),
                signed_version.clone(),
                signed_version_envelope.clone(),
            )
            .unwrap(),
        },
        version_record: ContentKey {
            key: content_key.clone().into(),
            plaintext_size: 1000,
            thumbnail_bytes: 0,
        },
        other_version: rekeyed::Written {
            statement: other_version.clone(),
            envelope: other_version_envelope.clone(),
            signature: version_sign(granter.signing_seed.to_vec(), other_version, other_version_envelope)
                .unwrap(),
        },
        other_version_record: ContentKey {
            key: content_key.clone().into(),
            plaintext_size: 5,
            thumbnail_bytes: 0,
        },
        other_node: rekeyed::Written {
            statement: other_node.clone(),
            envelope: other_node_envelope.clone(),
            signature: metadata_sign(granter.signing_seed.to_vec(), other_node, other_node_envelope).unwrap(),
        },
    });
    // The declared verdicts must be this twin's own before the other twin is held to them.
    for (name, input, expected) in &made.cases {
        let read = rekeyed::read(input).unwrap_or_else(|| panic!("rekeyed case {name} does not read"));
        assert_eq!(&rekeyed::judge(&read), expected, "rekeyed case {name}");
    }
    let rekeyed = json!({
        "oldNodeKey": e(&node_key),
        "nodeKey": e(&fresh_node_key),
        "keyEpoch": node_ctx.key_epoch + 1,
        "writer": { "userId": writer.user_id, "signingPublicKey": granter.signing_public_key },
        "rekeyer": { "userId": rekeyer.user_id, "signingPublicKey": e(&rekeyer.public_key) },
        "metadata": made.metadata,
        "version": made.version,
        "metadataOriginKey": made.metadata_origin_key,
        "versionOriginKey": made.version_origin_key,
        "metadataStatement": made.metadata_statement,
        "versionStatement": made.version_statement,
        "origins": made.origins,
        "cases": made.cases.iter().map(|(name, input, expected)| json!({ "name": name, "input": input, "expected": expected })).collect::<Vec<_>>(),
    });

    // Scoped ids: the same fixed seeds and scopes as the web's fixture, so both carry known answers.
    let id_scopes = [
        "0b6f0e1c-6a52-4f37-9d0e-5f1f2a3b4c5d",
        "0B6F0E1C-6A52-4F37-9D0E-5F1F2A3B4C5D",
        "f4a7c2d9-1e3b-4c5a-8f6e-7d8c9b0a1e2f",
    ];
    let id_kinds = [
        ("node", IdKind::Node),
        ("version", IdKind::Version),
        ("object", IdKind::Object),
        ("link", IdKind::Link),
        ("report", IdKind::Report),
    ];
    let mut ids = vec![];
    for (s, scope_id) in id_scopes.iter().enumerate() {
        for (k, (name, kind)) in id_kinds.iter().enumerate() {
            let seed = e(&pattern(16, (1 + s * id_kinds.len() + k) as u8));
            let id = derive_id(*kind, scope_id.to_string(), seed.clone()).unwrap();
            ids.push(json!({ "kind": name, "scopeId": scope_id, "seed": seed, "id": id }));
        }
    }

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
    let rewrapped_identity =
        identity_rewrap(web_user.clone(), web_root.clone(), new_root.clone(), web_envelope.clone()).unwrap();
    // A version 1 identity in the history moves with the root too.
    let web_legacy = envelope_of(&web["upgrade"]["legacy"]);
    let rewrapped_legacy =
        identity_rewrap(web_user.clone(), web_root.clone(), new_root.clone(), web_legacy.clone()).unwrap();
    // The web's identity succeeded here twice, each link signed with the old identity's hybrid signature.
    let next = identity_succeed(web_user.clone(), web_root.clone(), web_envelope.clone()).unwrap();
    let third = identity_succeed(web_user.clone(), web_root.clone(), next.identity.clone()).unwrap();
    let first_link = link_of(&web_envelope, &next);
    let second_link = link_of(&next.identity, &third);
    let t = &third.identity;
    let succession = json!({
        "userId": web_user,
        "identity": envelope_json(&next.identity),
        "link": link_json(&first_link),
        "statement": e(&succession_statement(web_user.clone(), first_link.clone()).unwrap()),
        "chain": {
            "links": [link_json(&first_link), link_json(&second_link)],
            "pinned": {
                "keyVersion": web_envelope.key_version,
                "encryptionPublicKey": web_envelope.encryption_public_key,
                "signingPublicKey": web_envelope.signing_public_key,
                "mlDsaPublicKeyHash": key_digest(b(&web_envelope.ml_dsa.as_ref().unwrap().public_key)),
            },
            "served": {
                "keyVersion": t.key_version, "encryptionPublicKey": t.encryption_public_key, "signingPublicKey": t.signing_public_key,
                "mlDsaPublicKey": t.ml_dsa.as_ref().unwrap().public_key, "kemPublicKey": t.kem.as_ref().unwrap().public_key,
            },
        },
    });
    // The web's version 1 identities upgraded here: the same keys and key version, and an ML-DSA key.
    let web_legacy_no_kem = envelope_of(&web["upgrade"]["legacyNoKem"]);
    let upgrade = json!({
        "userId": web_user,
        "legacy": envelope_json(&web_legacy),
        "upgraded": envelope_json(&identity_upgrade(web_user.clone(), web_root.clone(), web_legacy.clone()).unwrap()),
        "legacyNoKem": envelope_json(&web_legacy_no_kem),
        "upgradedNoKem": envelope_json(&identity_upgrade(web_user.clone(), web_root.clone(), web_legacy_no_kem).unwrap()),
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
        "identity": envelope_json(i),
        "legacyIdentity": envelope_json(&rewrapped_legacy),
    });

    // A device key's sign-in proof, made here: the web must build the same statement and accept the signature.
    let device_key = device_signing_create().unwrap();
    let (device_user, device_id, attempt_token) =
        (user_id.to_uppercase(), uuid(), e(&random_bytes(32).unwrap()));
    let device_email = " Sam.Example@HushOS.TEST\t".to_string();
    let device_session = json!({
        "userId": device_user,
        "deviceId": device_id,
        "attemptToken": attempt_token,
        "publicKey": e(&device_key.public_key),
        "statement": e(&device_session_statement(device_user.clone(), device_id.clone(), attempt_token.clone()).unwrap()),
        "signature": device_session_sign(device_key.seed.to_vec(), device_user.clone(), device_id.clone(), attempt_token.clone()).unwrap(),
        "email": device_email,
        "emailHash": device_email_hash(device_email.clone()),
    });

    let out = json!({
        "generatedBy": "crates/hushos-core/examples/fixtures.rs",
        "deviceSession": device_session,
        "link": link,
        "recovery": recovery,
        "report": report,
        "rotation": rotation,
        "share": share,
        "settings": settings,
        "signatures": signatures,
        "rekeyed": rekeyed,
        "succession": succession,
        "identity": identity_made_here,
        "keys": keys,
        "upgrade": upgrade,
        "fingerprints": fingerprints,
        "ids": ids,
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
