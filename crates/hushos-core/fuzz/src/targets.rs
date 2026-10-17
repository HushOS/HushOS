//! Every target as one function from the input bytes to a verdict, the same
//! verdict `packages/crypto/fuzz/verdicts.ts` gives for the same bytes:
//! `{"ok":true,"out":..}` when the core accepts (with what it produced),
//! `{"ok":false}` when it refuses, `{"skip":true}` when the input is not the
//! target's shape. The invariants are asserted inside, so a fuzz target is
//! just a call: any panic is a finding.
//!
//! The invariants, wherever they apply:
//! - no panic or abort, whatever the bytes;
//! - what a parser accepts re-encodes to exactly its bytes;
//! - a verify (or an open) that returns true implies its statement parses or builds.

use crate::fixtures;
use crate::groups::{case_from, judge};
use crate::rekeyed;
use crate::shape::{self, encoded, number, text};
use hushos_core::fuzzing::{self, encode_statement, parse_statement};
use hushos_core::*;
use serde_json::{json, Value};

/// Every target, by the name both twins and the scripts use.
pub const TARGETS: &[&str] = &[
    "canonical",
    "roster",
    "group_succession",
    "roster_build",
    "statements",
    "identity",
    "succession",
    "share_open",
    "key_seal_open",
    "area_grant_open",
    "key_seal_context",
    "pins",
    "accept",
    "record_integrity",
    "origin_open",
    "area_ledger",
];

/// The verdict of `target` on `data`; `None` for a target this crate does not have.
pub fn verdict(target: &str, data: &[u8]) -> Option<Value> {
    Some(match target {
        "canonical" => canonical(data),
        "roster" => roster(data),
        "group_succession" => group_succession(data),
        "roster_build" => with_json(data, roster_build),
        "statements" => with_json(data, statements),
        "identity" => with_json(data, identity),
        "succession" => with_json(data, succession),
        "share_open" => share(data),
        "key_seal_open" => key_seal(data),
        "area_grant_open" => area_grant(data),
        "key_seal_context" => with_json(data, key_seal_context),
        "pins" => with_json(data, pins),
        "accept" => with_json(data, accept),
        "record_integrity" => with_json(data, record_integrity),
        "origin_open" => origin_open(data),
        "area_ledger" => with_json(data, area_ledger),
        _ => return None,
    })
}

pub fn ok(out: Value) -> Value {
    json!({ "ok": true, "out": out })
}

pub fn refused() -> Value {
    json!({ "ok": false })
}

pub fn skip() -> Value {
    json!({ "skip": true })
}

fn either<T>(result: CoreResult<T>, out: impl FnOnce(T) -> Value) -> Value {
    match result {
        Ok(value) => ok(out(value)),
        Err(_) => refused(),
    }
}

/* A JSON target: bytes that are not JSON, or not its shape, are skipped. */
fn with_json(data: &[u8], target: fn(&Value) -> Option<Value>) -> Value {
    serde_json::from_slice::<Value>(data).ok().and_then(|value| target(&value)).unwrap_or_else(skip)
}

/* The statement grammar: what it accepts re-encodes to its own bytes, and the public check agrees. */
pub fn canonical(data: &[u8]) -> Value {
    let parsed = parse_statement(data);
    assert_eq!(
        group_statement_is_canonical(data.to_vec()),
        parsed.is_some(),
        "group_statement_is_canonical and the parser disagree"
    );
    match parsed {
        Some(parts) => {
            let again = encode_statement(&parts).expect("the encoder takes what the parser took");
            assert_eq!(again, data, "an accepted statement re-encodes to its own bytes");
            ok(Value::Null)
        }
        None => refused(),
    }
}

pub fn roster(data: &[u8]) -> Value {
    match roster_parse(data.to_vec()) {
        Ok(parsed) => {
            assert!(parse_statement(data).is_some(), "a roster keeps the statement grammar");
            let again = roster_statement(parsed.clone()).expect("a parsed roster encodes");
            assert_eq!(again, data, "a roster re-encodes to its own bytes");
            assert_eq!(roster_parse(again).expect("parses again"), parsed);
            ok(shape::roster_json(&parsed))
        }
        Err(_) => refused(),
    }
}

pub fn group_succession(data: &[u8]) -> Value {
    match group_succession_parse(data.to_vec()) {
        Ok(parsed) => {
            assert!(parse_statement(data).is_some(), "a succession keeps the statement grammar");
            let again = group_succession_statement(parsed.clone()).expect("a parsed succession encodes");
            assert_eq!(again, data, "a succession re-encodes to its own bytes");
            assert_eq!(parsed.new_version, parsed.old_version + 1, "a succession steps one key version");
            ok(shape::succession_json(&parsed))
        }
        Err(_) => refused(),
    }
}

/* A roster as a client builds it: what encodes parses back to the same roster. */
pub fn roster_build(value: &Value) -> Option<Value> {
    let built = shape::roster(value)?;
    Some(either(roster_statement(built.clone()), |statement| {
        let parsed = roster_parse(statement.clone()).expect("an encoded roster parses");
        assert_eq!(parsed, built, "a roster parses back to what was encoded");
        ok_bytes(&statement)
    }))
}

fn ok_bytes(bytes: &[u8]) -> Value {
    json!(encoded(bytes))
}

/* The statements every signature in the protocol covers, built from their fields. */
pub fn statements(value: &Value) -> Option<Value> {
    let kind = text(value, "kind")?;
    Some(match kind.as_str() {
        "share" => {
            let ctx = shape::share_context(value.get("ctx")?)?;
            either(share_statement(ctx, shape::bytes(value, "sealed")?), |s| ok_bytes(&s))
        }
        "keys" => either(
            keys_statement(
                text(value, "userId")?,
                number(value, "keyVersion")?,
                text(value, "encryptionPublicKey")?,
                text(value, "signingPublicKey")?,
                text(value, "mlDsaPublicKey")?,
                text(value, "kemPublicKey")?,
            ),
            |s| ok_bytes(&s),
        ),
        "succession" => {
            let link = shape::link(value.get("link")?)?;
            either(succession_statement(text(value, "userId")?, link), |s| ok_bytes(&s))
        }
        "consent" => {
            let link = shape::link(value.get("link")?)?;
            // Every field read before the role is judged, so a misshapen one is skipped as the web skips it.
            let user = text(value, "userId")?;
            let role = match text(value, "role")?.as_str() {
                "old" => ConsentRole::Old,
                "new" => ConsentRole::New,
                // The web refuses any other role by name; Rust cannot hold one.
                _ => return Some(refused()),
            };
            either(succession_consent_statement(user, link, role), |s| ok_bytes(&s))
        }
        "device" => {
            let (user, device, attempt) =
                (text(value, "userId")?, text(value, "deviceId")?, text(value, "attemptToken")?);
            let statement = device_session_statement(user.clone(), device.clone(), attempt.clone());
            if let (Some(key), Some(signature)) =
                (shape::bytes(value, "publicKey"), shape::bytes(value, "signature"))
            {
                if device_session_verify(key, user, device, attempt, signature) {
                    assert!(
                        statement.is_ok(),
                        "a device proof verified over a statement that does not build"
                    );
                }
            }
            either(statement, |s| ok_bytes(&s))
        }
        "keySeal" => {
            let ctx = shape::key_seal_context(value.get("ctx")?)?;
            either(group_key_seal_statement(ctx, shape::bytes(value, "sealed")?), |s| ok_bytes(&s))
        }
        "areaGrant" => {
            let ctx = shape::area_grant_context(value.get("ctx")?)?;
            either(area_grant_statement(ctx, shape::bytes(value, "sealed")?), |s| ok_bytes(&s))
        }
        "metadata" | "version" => return record_statement(&kind, value),
        _ => return None,
    })
}

/*
 * A drive record statement in any of its four forms: the writer's three
 * (ordinary, saved, re-sealed) and the rekeyed one, which also reads
 * `keyEpoch` and `origin`. Every field is read before the form is judged, so a
 * misshapen one is skipped as the web skips it; an unknown form is refused,
 * as the web refuses it by name. Given `publicKey` and `signature`, a
 * signature that verifies implies its statement builds.
 */
fn record_statement(kind: &str, value: &Value) -> Option<Value> {
    let metadata =
        if kind == "metadata" { Some(shape::metadata_statement(value.get("statement")?)?) } else { None };
    let version =
        if kind == "version" { Some(shape::version_statement(value.get("statement")?)?) } else { None };
    let envelope = shape::bytes(value, "envelope")?;
    let form = text(value, "form")?;
    let check = match (shape::bytes(value, "publicKey"), shape::bytes(value, "signature")) {
        (Some(key), Some(signature)) => Some((key, signature)),
        _ => None,
    };
    if form == "rekeyed" {
        let key_epoch = number(value, "keyEpoch")?;
        let origin = shape::record_origin(value.get("origin")?)?;
        let (statement, verified) = match (metadata, version) {
            (Some(m), _) => (
                metadata_rekeyed_statement(m.clone(), key_epoch, envelope.clone(), origin.clone()),
                check.map(|(k, s)| metadata_rekeyed_verify(k, m, key_epoch, envelope, origin, s)),
            ),
            (_, Some(v)) => (
                version_rekeyed_statement(v.clone(), key_epoch, envelope.clone(), origin.clone()),
                check.map(|(k, s)| version_rekeyed_verify(k, v, key_epoch, envelope, origin, s)),
            ),
            _ => unreachable!("one of the two"),
        };
        if verified == Some(true) {
            assert!(statement.is_ok(), "a rekey signature verified over a statement that does not build");
        }
        return Some(either(statement, |s| ok_bytes(&s)));
    }
    if !["ordinary", "saved", "resealed"].contains(&form.as_str()) {
        return Some(refused());
    }
    let (statement, verified) = match (metadata, version) {
        (Some(m), _) => {
            let verify = |k: Vec<u8>, s: Vec<u8>| match form.as_str() {
                "ordinary" => metadata_verify(k, m.clone(), envelope.clone(), s),
                "saved" => metadata_saved_verify(k, m.clone(), envelope.clone(), s),
                _ => metadata_resealed_verify(k, m.clone(), envelope.clone(), s),
            };
            (fuzzing::metadata_statement_as(&form, &m, &envelope), check.map(|(k, s)| verify(k, s)))
        }
        (_, Some(v)) => {
            let verify = |k: Vec<u8>, s: Vec<u8>| match form.as_str() {
                "ordinary" => version_verify(k, v.clone(), envelope.clone(), s),
                "saved" => version_saved_verify(k, v.clone(), envelope.clone(), s),
                _ => version_resealed_verify(k, v.clone(), envelope.clone(), s),
            };
            (fuzzing::version_statement_as(&form, &v, &envelope), check.map(|(k, s)| verify(k, s)))
        }
        _ => unreachable!("one of the two"),
    };
    if verified == Some(true) {
        assert!(statement.is_some(), "a record signature verified over a statement that does not build");
    }
    Some(match statement {
        Some(s) => ok(json!(encoded(&s))),
        None => refused(),
    })
}

/*
 * An identity envelope: its public keys, whether its keys statement holds,
 * and whether it opens under the account key (the fixture's when none is
 * given). Or, given `public`, whether a served identity's keys statement holds.
 */
pub fn identity(value: &Value) -> Option<Value> {
    let user = text(value, "userId")?;
    if let Some(public) = value.get("public") {
        let public = shape::public_identity(public)?;
        let holds = identity_verify_keys(user.clone(), public.clone());
        if holds {
            assert!(keys_of(&user, &public).is_ok(), "a keys statement held that does not build");
        }
        return Some(ok(json!({ "keysHold": holds })));
    }
    let envelope = shape::envelope(value.get("envelope")?)?;
    let account_key = match value.get("accountKey") {
        None | Some(Value::Null) => {
            base64url_decode(fixtures::core()["identity"]["accountKey"].as_str()?.into()).ok()?
        }
        Some(_) => shape::bytes(value, "accountKey")?,
    };
    let public = public_identity(envelope.clone()).ok();
    let holds = public.as_ref().is_some_and(|p| identity_verify_keys(user.clone(), p.clone()));
    if holds {
        assert!(
            keys_of(&user, public.as_ref().unwrap()).is_ok(),
            "a keys statement held that does not build"
        );
    }
    let opened = identity_open(user, account_key, envelope.clone());
    if let Ok(keys) = &opened {
        assert_eq!(keys.encryption_public_key, envelope.encryption_public_key);
        assert_eq!(keys.signing_public_key, envelope.signing_public_key);
        if envelope.version == 2 {
            assert!(holds, "a version 2 identity opened whose keys statement does not hold");
        }
    }
    Some(ok(json!({
        "public": public.as_ref().map(shape::public_identity_json),
        "keysHold": holds,
        "opened": opened.is_ok(),
    })))
}

fn keys_of(user: &str, public: &PublicIdentity) -> CoreResult<Vec<u8>> {
    keys_statement(
        user.into(),
        public.key_version,
        public.encryption_public_key.clone(),
        public.signing_public_key.clone(),
        public.ml_dsa_public_key.clone(),
        public.kem_public_key.clone(),
    )
}

/* An optional field of a JSON shape: absent or null is none; present and unreadable does not fit. */
fn optional<T>(value: &Value, key: &str, read: impl Fn(&Value) -> Option<T>) -> Option<Option<T>> {
    match value.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(inner) => read(inner).map(Some),
    }
}

/*
 * A succession link: its statement, whether it verifies under `signer`,
 * whether it carries its successor's consent, and, given `pinned`, `served`
 * and `links`, whether that chain holds.
 */
pub fn succession(value: &Value) -> Option<Value> {
    let user = text(value, "userId")?;
    let link = shape::link(value.get("link")?)?;
    let signer = optional(value, "signer", shape::signer)?;
    let pinned = optional(value, "pinned", shape::pinned)?;
    let served = optional(value, "served", shape::served)?;
    let links = optional(value, "links", |links| {
        links.as_array()?.iter().map(shape::link).collect::<Option<Vec<_>>>()
    })?;
    let statement = succession_statement(user.clone(), link.clone()).ok();
    let verified = signer.map(|signer| succession_verify(user.clone(), link.clone(), signer));
    if verified == Some(true) {
        assert!(statement.is_some(), "a link verified whose statement does not build");
    }
    let consent = succession_consent_verify(user.clone(), link.clone());
    if consent {
        for role in [ConsentRole::Old, ConsentRole::New] {
            assert!(
                succession_consent_statement(user.clone(), link.clone(), role).is_ok(),
                "a consent verified whose statement does not build"
            );
        }
    }
    let chain = match (pinned, served, links) {
        (Some(pinned), Some(served), Some(links)) => {
            let holds = succession_chain_verify(user.clone(), pinned, served, links.clone());
            if holds {
                assert!(!links.is_empty(), "an empty chain held");
                assert!(
                    links.iter().any(|l| succession_statement(user.clone(), l.clone()).is_ok()),
                    "a chain held with no link whose statement builds"
                );
            }
            Some(holds)
        }
        _ => None,
    };
    Some(ok(json!({
        "statement": statement.as_deref().map(encoded),
        "verified": verified,
        "consent": consent,
        "chain": chain,
    })))
}

const HYBRID_SIGNATURE_BYTES: usize = 3373;

/* The share in core.json, opened by the web's identity: these bytes in place of its envelope. */
pub fn share(data: &[u8]) -> Value {
    let fixture = &fixtures::core()["share"];
    let ctx = shape::share_context(&fixture["ctx"]).expect("the fixture's share context");
    let granter = HybridPublicKey {
        signing_public_key: shape::bytes(fixture, "granterSigningPublicKey").unwrap(),
        ml_dsa_public_key: shape::bytes(fixture, "granterMlDsaPublicKey").unwrap(),
    };
    either(share_open(data.to_vec(), granter, fixtures::share_grantee().clone(), ctx.clone()), |key| {
        assert_eq!(key.len(), 32);
        let sealed = data[..data.len() - HYBRID_SIGNATURE_BYTES].to_vec();
        assert!(share_statement(ctx, sealed).is_ok(), "a share opened whose statement does not build");
        ok_bytes(&key)
    })
}

/* The key seal in core-groups.json, opened by the organizer on the fixture chain. */
pub fn key_seal(data: &[u8]) -> Value {
    let fixture = &fixtures::groups()["seals"]["keySeal"];
    let ctx = shape::key_seal_context(&fixture["ctx"]).expect("the fixture's key seal context");
    let organizer = &fixtures::people()[0];
    let opened = group_key_open(
        data.to_vec(),
        ctx.clone(),
        fixtures::chain(),
        organizer.ml_dsa(),
        None,
        organizer.user_id.clone(),
        organizer.keys.key_version,
        organizer.keys.clone(),
    );
    either(opened, |seed| {
        let sealed = data[..data.len() - HYBRID_SIGNATURE_BYTES].to_vec();
        assert!(
            group_key_seal_statement(ctx, sealed).is_ok(),
            "a key seal opened whose statement does not build"
        );
        let key = group_public_key(seed.to_vec()).expect("an opened seed is a group key");
        assert!(
            fixtures::chain().group_keys().contains(&key),
            "a key seal opened to a key the chain does not have"
        );
        ok_bytes(&seed)
    })
}

/*
 * The key seal in core-groups.json under another context, opened by one of the
 * four fixture people (`reader`, 0 to 3): it opens only under its own context
 * and only for its holder, the organizer, whatever else the context names.
 */
pub fn key_seal_context(value: &Value) -> Option<Value> {
    let ctx = shape::key_seal_context(value.get("ctx")?)?;
    let reader = shape::small(value, "reader").filter(|n| *n < 4)? as usize;
    let fixture = &fixtures::groups()["seals"]["keySeal"];
    let people = fixtures::people();
    let who = &people[reader];
    let opened = group_key_open(
        shape::bytes(fixture, "envelope").unwrap(),
        ctx.clone(),
        fixtures::chain(),
        people[0].ml_dsa(),
        None,
        who.user_id.clone(),
        who.keys.key_version,
        who.keys.clone(),
    );
    Some(either(opened, |seed| {
        let sealed_for = shape::key_seal_context(&fixture["ctx"]).unwrap();
        assert_eq!(ctx, sealed_for, "a key seal opened under a context it was not sealed for");
        assert_eq!(reader, 0, "a key seal opened for someone other than its holder");
        ok_bytes(&seed)
    }))
}

/* The area grant in core-groups.json, opened by the adult on the fixture chain. */
pub fn area_grant(data: &[u8]) -> Value {
    let fixture = &fixtures::groups()["seals"]["areaGrant"];
    let ctx = shape::area_grant_context(&fixture["ctx"]).expect("the fixture's grant context");
    let (organizer, adult) = (&fixtures::people()[0], &fixtures::people()[1]);
    let opened = area_grant_open(
        data.to_vec(),
        ctx.clone(),
        fixtures::chain(),
        text(fixture, "areaIdSeed").unwrap(),
        organizer.ml_dsa(),
        None,
        adult.user_id.clone(),
        1,
        adult.keys.clone(),
    );
    either(opened, |key| {
        let sealed = data[..data.len() - HYBRID_SIGNATURE_BYTES].to_vec();
        assert!(area_grant_statement(ctx, sealed).is_ok(), "a grant opened whose statement does not build");
        ok_bytes(&key)
    })
}

/* Contact pins, group pins, fingerprints and the hex/base64url digest conversions. */
pub fn pins(value: &Value) -> Option<Value> {
    let kind = text(value, "kind")?;
    Some(match kind.as_str() {
        "pin" => {
            let verified = pin_verified(
                text(value, "encryptionPublicKey")?,
                text(value, "signingPublicKey")?,
                shape::optional_text(value, "mlDsaPublicKeyHash")?,
                shape::optional_text(value, "kemPublicKeyHash")?,
                text(value, "fingerprint")?,
            );
            if verified {
                for key in ["mlDsaPublicKeyHash", "kemPublicKeyHash"] {
                    assert!(
                        digest_base64url(text(value, key).unwrap()).is_ok(),
                        "a pin verified with a digest that is not one"
                    );
                }
            }
            ok(json!(verified))
        }
        "groupPin" => {
            let pin = shape::group_pin(value.get("pin")?)?;
            either(group_pin_check(text(value, "groupId")?, pin), |pin| shape::group_pin_json(&pin))
        }
        "digestHex" => {
            let base64url = text(value, "value")?;
            either(digest_hex(base64url.clone()), |hex| {
                assert_eq!(
                    digest_base64url(hex.clone()).as_deref(),
                    Ok(base64url.as_str()),
                    "hex round trip"
                );
                json!(hex)
            })
        }
        "digestBase64url" => {
            let hex = text(value, "value")?;
            either(digest_base64url(hex.clone()), |base64url| {
                assert_eq!(
                    digest_hex(base64url.clone()).as_deref(),
                    Ok(hex.as_str()),
                    "base64url round trip"
                );
                json!(base64url)
            })
        }
        "sameKeyDigest" => {
            let hex = shape::optional_text(value, "hex")?;
            let base64url = text(value, "base64url")?;
            let same = same_key_digest(hex.clone(), base64url.clone());
            if same {
                assert_eq!(digest_hex(base64url).ok(), hex, "the same digest, read two ways");
            }
            ok(json!(same))
        }
        "fingerprint" | "fingerprintOfKeys" => {
            let keys = value.get("keys")?.as_array()?;
            let [a, b, c, d] = keys.as_slice() else { return None };
            let decoded = |v: &Value| -> Option<Vec<u8>> {
                let text = v.as_str()?;
                if text.is_empty() {
                    Some(vec![])
                } else {
                    base64url_decode(text.into()).ok()
                }
            };
            let (a, b, c, d) = (decoded(a)?, decoded(b)?, decoded(c)?, decoded(d)?);
            let print = if kind == "fingerprint" {
                identity_fingerprint(a, b, c, d)
            } else {
                identity_fingerprint_of_keys(a, b, c, d)
            };
            either(print, |print| {
                assert_eq!(print.len(), 49, "ten groups of four hex digits");
                json!(print)
            })
        }
        "groupFingerprint" => {
            let key = shape::group_key(value.get("key")?)?;
            either(group_fingerprint(text(value, "groupId")?, key), |print| json!(print))
        }
        _ => return None,
    })
}

/*
 * A served history, as a shared case's `input` carries it: the full verdict
 * of acceptance (and of the record and next statement when the case asks).
 * An accepted chain's cached statement is a roster that parses.
 */
pub fn accept(value: &Value) -> Option<Value> {
    if !value.is_object() {
        return None;
    }
    let (_, input, _) = case_from(&json!({ "name": "fuzz", "input": value, "expected": null }));
    let verdict = judge(&input);
    if verdict["status"] == "accepted" {
        let statement = base64url_decode(verdict["cache"]["statement"].as_str()?.into()).ok()?;
        let roster = roster_parse(statement).expect("an accepted chain caches a roster that parses");
        assert_eq!(json!(roster.roster_version), verdict["rosterVersion"]);
    }
    Some(ok(verdict))
}

/* The current key the input names for the re-keyer: personal trust, or the group's (its personal one outside the roster). */
fn rekeyer_current(input: &rekeyed::Input) -> Option<Vec<u8>> {
    match &input.trust {
        rekeyed::Trust::Personal(trust) => trust.as_ref()?.rekeyer.as_ref().map(|k| k.current.clone()),
        rekeyed::Trust::Group(group) => match &group.rekeyer {
            GroupWriterTrust::Roster { signer, .. } | GroupWriterTrust::FormerMember { signer, .. } => {
                Some(signer.current.clone())
            }
            GroupWriterTrust::Outside => group.rekeyer_personal.as_ref().map(|k| k.current.clone()),
            GroupWriterTrust::Unchecked | GroupWriterTrust::KeyConflict => None,
        },
    }
}

/* Whether the re-key signature verifies under that key over the record as served. */
fn rekey_attested(input: &rekeyed::Input) -> bool {
    let Some(key) = rekeyer_current(input) else {
        return false;
    };
    let origin_of = |o: &ServedOrigin| -> Option<RecordOrigin> {
        Some(RecordOrigin {
            envelope: o.envelope.clone(),
            signer_id: o.signer_id.clone()?,
            signature: o.signature.clone()?,
            key_envelope: o.key_envelope.clone(),
        })
    };
    match &input.record {
        rekeyed::Record::Metadata(r) => match (origin_of(&r.origin), &r.rekey_signature) {
            (Some(origin), Some(signature)) => metadata_rekeyed_verify(
                key,
                r.statement.clone(),
                r.key_epoch,
                r.envelope.clone(),
                origin,
                signature.clone(),
            ),
            _ => false,
        },
        rekeyed::Record::Version(r) => match (origin_of(&r.origin), &r.rekey_signature) {
            (Some(origin), Some(signature)) => version_rekeyed_verify(
                key,
                r.statement.clone(),
                r.key_epoch,
                r.envelope.clone(),
                origin,
                signature.clone(),
            ),
            _ => false,
        },
    }
}

/* An origin the shared fixtures sealed, and the record it was sealed for. */
fn known_origin(envelope: &[u8]) -> Option<&'static Value> {
    let encoded = shape::encoded(envelope);
    [fixtures::core(), fixtures::web()]
        .into_iter()
        .flat_map(|f| f["rekeyed"]["origins"].as_array().into_iter().flatten())
        .find(|o| o["envelope"].as_str() == Some(encoded.as_str()))
}

/* The record a rekeyed input names, as the origin oracle writes it. */
fn named_record(record: &rekeyed::Record) -> Value {
    match record {
        rekeyed::Record::Metadata(r) => json!({
            "record": "metadata", "workspaceId": r.statement.workspace_id, "nodeId": r.statement.node_id,
            "metadataVersion": r.statement.metadata_version,
        }),
        rekeyed::Record::Version(r) => json!({
            "record": "version", "workspaceId": r.statement.workspace_id, "nodeId": r.statement.node_id,
            "versionId": r.statement.version_id,
        }),
    }
}

/* The origin's bytes under its wrapped key and the current envelope's under the node key, when both open. */
fn plaintexts(node_key: &[u8], record: &rekeyed::Record) -> Option<(Vec<u8>, Vec<u8>)> {
    let (ws, node, key_epoch, origin, current, position, aad) = match record {
        rekeyed::Record::Metadata(r) => {
            let s = &r.statement;
            let ctx = MetadataContext {
                workspace_id: s.workspace_id.clone(),
                node_id: s.node_id.clone(),
                metadata_version: s.metadata_version,
            };
            (
                &s.workspace_id,
                &s.node_id,
                r.key_epoch,
                &r.origin,
                &r.envelope,
                OriginRecord::Metadata { metadata_version: s.metadata_version },
                fuzzing::metadata_aad(&ctx)?,
            )
        }
        rekeyed::Record::Version(r) => {
            let s = &r.statement;
            let ctx = VersionContext {
                workspace_id: s.workspace_id.clone(),
                node_id: s.node_id.clone(),
                version_id: s.version_id.clone(),
                object_id: s.object_id.clone(),
            };
            (
                &s.workspace_id,
                &s.node_id,
                r.key_epoch,
                &r.origin,
                &r.envelope,
                OriginRecord::Version { version_id: s.version_id.clone() },
                fuzzing::version_aad(&ctx, s.content_suite)?,
            )
        }
    };
    let key = origin_key_open(
        OriginKeyContext {
            workspace_id: ws.clone(),
            node_id: node.clone(),
            key_epoch,
            record: position,
            origin_envelope: origin.envelope.clone(),
        },
        node_key.to_vec(),
        origin.key_envelope.clone(),
    )
    .ok()?;
    Some((
        fuzzing::origin_plaintext(&key, &origin.envelope, &aad)?,
        fuzzing::plaintext(node_key, current, &aad)?,
    ))
}

/*
 * A re-keyed record's verdict, personal or in a group's area, as the shared
 * cases' input carries it, and whether the next rotation carries its origin
 * (`*_origin_carry` with the input's node key as the old key). Invariants:
 * - bound true means the origin holds the current envelope's bytes, and an
 *   origin the fixtures sealed for another node or version never gets there;
 * - bound false means the reader opened both envelopes to different bytes,
 *   or the re-key signature verifies under the re-keyer's current key;
 * - the next rotation carries the origin exactly when both open to equal
 *   bytes, whatever the signatures say: a mismatch, or a wrapped old node
 *   key, is never carried on;
 * - an origin verdict that verified implies the origin's statement builds.
 */
pub fn record_integrity(value: &Value) -> Option<Value> {
    let input = rekeyed::read(value)?;
    let mut verdict = rekeyed::judge(&input);
    let carried = rekeyed::carried(&input);
    let equal = input
        .node_key
        .as_ref()
        .and_then(|key| plaintexts(key, &input.record))
        .is_some_and(|(written, current)| written == current);
    if verdict["bound"] == true {
        assert!(equal, "a bound record holds other bytes than its origin");
        let envelope = match &input.record {
            rekeyed::Record::Metadata(r) => &r.origin.envelope,
            rekeyed::Record::Version(r) => &r.origin.envelope,
        };
        if let Some(known) = known_origin(envelope) {
            let mut sealed_for = known.clone();
            sealed_for.as_object_mut().unwrap().remove("envelope");
            assert_eq!(sealed_for, named_record(&input.record), "an origin sealed for another record passed");
        }
    }
    if verdict["bound"] == false {
        // Not bound is the re-keyer's word or the reader's own sight: both envelopes opened to
        // different bytes, or the re-key signature verifies under the re-keyer's current key.
        let differ = input
            .node_key
            .as_ref()
            .and_then(|key| plaintexts(key, &input.record))
            .is_some_and(|(written, current)| written != current);
        assert!(
            differ || rekey_attested(&input),
            "a record read as not bound with neither different bytes nor the re-keyer's word"
        );
    }
    match &input.node_key {
        Some(_) => assert_eq!(
            carried,
            Some(equal),
            "the next rotation carried an origin it should not, or dropped a bound one"
        ),
        None => assert_eq!(carried, None, "a rotation without the node key carried something"),
    }
    // A missing or bad re-key signature no longer touches the origin's verdict (it is a mark of its
    // own), so only the origin's statement must build for it to verify.
    let verified = verdict["origin"] == "verified" || verdict["origin"]["integrity"] == "verified";
    if verified {
        let built = match &input.record {
            rekeyed::Record::Metadata(r) => {
                fuzzing::metadata_statement_as("ordinary", &r.statement, &r.origin.envelope).is_some()
            }
            rekeyed::Record::Version(r) => {
                fuzzing::version_statement_as("ordinary", &r.statement, &r.origin.envelope).is_some()
            }
        };
        assert!(built, "a verified re-keyed record whose origin statement does not build");
    }
    verdict["carried"] = json!(carried);
    Some(ok(verdict))
}

const KEY_ENVELOPE_BYTES: usize = 72;

/*
 * The rekeyed metadata in core.json, its wrapped origin key and its origin
 * replaced by these bytes (the first 72, then the rest), opened by the
 * fixture's node key: the origin's plaintext, which can only be the bytes the
 * current envelope holds, under the very key the core derived.
 */
pub fn origin_open(data: &[u8]) -> Value {
    let fixture = &fixtures::core()["rekeyed"];
    let record = &fixture["metadata"];
    let statement = shape::metadata_statement(&record["statement"]).expect("the fixture's statement");
    let node_key = shape::bytes(fixture, "nodeKey").unwrap();
    let (key_envelope, origin) = (data.get(..KEY_ENVELOPE_BYTES), data.get(KEY_ENVELOPE_BYTES..));
    let (Some(key_envelope), Some(origin)) = (key_envelope, origin) else {
        return refused();
    };
    let ctx = MetadataContext {
        workspace_id: statement.workspace_id.clone(),
        node_id: statement.node_id.clone(),
        metadata_version: statement.metadata_version,
    };
    let opened = origin_key_open(
        OriginKeyContext {
            workspace_id: statement.workspace_id.clone(),
            node_id: statement.node_id.clone(),
            key_epoch: number(record, "keyEpoch").unwrap(),
            record: OriginRecord::Metadata { metadata_version: statement.metadata_version },
            origin_envelope: origin.to_vec(),
        },
        node_key.clone(),
        key_envelope.to_vec(),
    );
    let Ok(key) = opened else {
        return refused();
    };
    assert_eq!(
        shape::encoded(&key),
        fixture["metadataOriginKey"].as_str().unwrap(),
        "an origin key opened that was not sealed"
    );
    let aad = fuzzing::metadata_aad(&ctx).expect("the fixture's context");
    if origin.len() > 24 + 4096 + 16 {
        return refused();
    }
    match fuzzing::origin_plaintext(&key, origin, &aad) {
        Some(plaintext) => {
            let current =
                fuzzing::plaintext(&node_key, &shape::bytes(record, "envelope").unwrap(), &aad).unwrap();
            assert_eq!(plaintext, current, "an origin opened to other bytes than the record holds");
            ok(ok_bytes(&plaintext))
        }
        None => refused(),
    }
}

/// The family write rules on any sequence of steps (`tests/common/area_ledger.rs`):
/// every step's outcome, which the web's ledger must match. Invariant: every
/// key envelope the ledger made opens, under the key its parent holds, to the
/// key the ledger handed back.
pub fn area_ledger(value: &Value) -> Option<Value> {
    let steps = crate::area_ledger::read_steps(value.get("steps")?)?;
    let run = crate::area_ledger::run_steps(&steps);
    assert!(run.violations.is_empty(), "a family write rule oracle failed: {:?}", run.violations);
    for made in &run.made {
        if made["parentKey"].as_str().is_some_and(|key| !key.is_empty()) {
            assert!(
                crate::area_ledger::opens_as_made(made),
                "a key envelope the ledger made opens to its key"
            );
        }
    }
    Some(ok(json!({ "outcomes": run.outcomes })))
}
