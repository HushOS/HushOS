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
use crate::shape::{self, encoded, number, text};
use hushos_core::fuzzing::{encode_statement, parse_statement};
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
        _ => return None,
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
