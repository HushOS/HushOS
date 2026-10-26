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
    match value.get("kind").map(Value::as_str) {
        Some(Some("consent_due")) => return consent_due(value),
        Some(Some("consent_sign")) => return consent_sign(value),
        Some(Some(_)) => return None,
        _ => {}
    }
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

/* Key versions both twins read exactly: JavaScript's numbers are exact only to 2^53 - 1. */
const MAX_SAFE: u64 = (1 << 53) - 1;

fn links_of(value: &Value) -> Option<Vec<SuccessionLink>> {
    let links = value.get("links")?.as_array()?.iter().map(shape::link).collect::<Option<Vec<_>>>()?;
    links.iter().all(|l| l.old_key_version <= MAX_SAFE && l.new_key_version <= MAX_SAFE).then_some(links)
}

fn envelopes_of(value: &Value) -> Option<Vec<IdentityEnvelope>> {
    let envelopes =
        value.get("identities")?.as_array()?.iter().map(shape::envelope).collect::<Option<Vec<_>>>()?;
    envelopes.iter().all(|e| e.key_version <= MAX_SAFE).then_some(envelopes)
}

/*
 * The links among `links` that need consent, with `identities` as the
 * account's (served shapes): each offered link's old key version and the
 * places of its two identities, which the web's linksNeedingConsent must
 * give. Invariant: an offered link has no consent and joins two version 2
 * identities at its own key versions.
 */
fn consent_due(value: &Value) -> Option<Value> {
    let links = links_of(value)?;
    let identities = envelopes_of(value)?;
    let place = |envelope: &IdentityEnvelope| identities.iter().position(|e| e == envelope).unwrap();
    let due = links_needing_consent(links, identities.clone());
    for d in &due {
        assert!(d.link.consent.as_deref().is_none_or(str::is_empty), "a link with consent offered");
        assert!(d.old_identity.version == 2 && d.next_identity.version == 2, "a version 1 identity offered");
        assert_eq!(d.old_identity.key_version, d.link.old_key_version, "the old identity at its key version");
        assert_eq!(
            d.next_identity.key_version, d.link.new_key_version,
            "the next identity at its key version"
        );
    }
    Some(ok(Value::Array(
        due.iter()
            .map(|d| json!({ "oldKeyVersion": d.link.old_key_version, "old": place(&d.old_identity), "next": place(&d.next_identity) }))
            .collect(),
    )))
}

/*
 * Consent for `link` from `old` to `next` (served envelopes) by the join
 * fixtures' consent account, unlocked with the first of `me` open and the
 * rest its history: signed or refused, as the worker's identityConsent
 * decides. Invariant: what is signed holds for the link between the two
 * envelopes, and the link is one the old identity signed.
 */
fn consent_sign(value: &Value) -> Option<Value> {
    use crate::join::{consent_root, link_between, CONSENT_USER};
    let old = shape::envelope(value.get("old")?)?;
    let next = shape::envelope(value.get("next")?)?;
    let link = shape::link(value.get("link")?)?;
    let me = value.get("me")?.as_array()?.iter().map(shape::served).collect::<Option<Vec<_>>>()?;
    // An app always holds at least its current identity, the one the account opened.
    if me.is_empty()
        || old.key_version > MAX_SAFE
        || next.key_version > MAX_SAFE
        || link.old_key_version > MAX_SAFE
        || link.new_key_version > MAX_SAFE
        || me.iter().any(|k| k.key_version > MAX_SAFE)
    {
        return None;
    }
    let signing = base64url_decode(me[0].signing_public_key.clone()).ok().filter(|key| key.len() == 32)?;
    let ledger = AreaLedger::new();
    ledger.open_account(CONSENT_USER.into(), signing, consent_root()).ok()?;
    let me = OwnIdentities { user_id: CONSENT_USER.into(), identities: me };
    Some(match ledger.succession_consent_sign(me, link.clone(), old.clone(), next.clone()) {
        Ok(consent) => {
            assert!(
                succession_consent_verify(CONSENT_USER.into(), link_between(&old, &next, "", Some(&consent))),
                "a consent signed that does not hold"
            );
            let signer = SuccessionSigner {
                signing_public_key: old.signing_public_key.clone(),
                ml_dsa_public_key: old.ml_dsa.as_ref().map(|k| k.public_key.clone()).unwrap_or_default(),
            };
            assert!(
                succession_verify(CONSENT_USER.into(), link, signer),
                "a consent for a link the account never made"
            );
            ok(json!("signed"))
        }
        Err(_) => refused(),
    })
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
        "device_record" => return device_record(value),
        "join_check" => return join_check_kind(value),
        "join_preview" => return join_preview_kind(value),
        "join_draws" => return join_draws_kind(value),
        "join_session" => return join_session_kind(value),
        "outbox_entry" => return outbox_entry_kind(value),
        "member_join_code" => return member_join_code_kind(value),
        "roster_call" => return roster_call_kind(value),
        "roster_call_session" => return roster_call_session_kind(value),
        "settings" => return settings_kind(value),
        "area_open" => return area_open_kind(value),
        "pair_code" => return pair_code_kind(value),
        "joins_record" => return joins_record_kind(value),
        _ => return None,
    })
}

/* A list of strings; anything else does not fit. */
fn strings_of(value: &Value, key: &str) -> Option<Vec<String>> {
    value.get(key)?.as_array()?.iter().map(|v| v.as_str().map(str::to_string)).collect()
}

/*
 * The typed words of a join code (`code`, `hidden`, `typed`, any values the
 * types hold): the bare rule's answer, which the web's joinCheck must give.
 * Invariant: a match depends on the order of the two words, unless the code
 * has the same word at both positions.
 */
fn join_check_kind(value: &Value) -> Option<Value> {
    let code = strings_of(value, "code")?;
    let typed = strings_of(value, "typed")?;
    let hidden = value
        .get("hidden")?
        .as_array()?
        .iter()
        .map(|v| shape::unsigned(v).and_then(|n| u32::try_from(n).ok()))
        .collect::<Option<Vec<u32>>>()?;
    Some(match join_words(code.clone(), hidden.clone(), typed.clone()) {
        Ok(JoinWords::Match) => {
            if code[hidden[0] as usize] != code[hidden[1] as usize] {
                let swapped = vec![typed[1].clone(), typed[0].clone()];
                assert_eq!(
                    join_words(code, hidden, swapped),
                    Ok(JoinWords::NoMatch),
                    "the order of the two words"
                );
            }
            ok(json!("match"))
        }
        Ok(JoinWords::NoMatch) => ok(json!("no-match")),
        Ok(JoinWords::Incomplete) => ok(json!("incomplete")),
        Err(_) => refused(),
    })
}

/* A showing is twelve words at a roster no later than the head served, with two ascending positions in 0..=11. */
fn shown_well(outcome: &Value, through: u64) {
    if outcome["status"] != "code" && outcome["status"] != "changed" {
        return;
    }
    let code: Vec<String> = serde_json::from_value(outcome["code"].clone()).unwrap();
    let hidden: Vec<u32> = serde_json::from_value(outcome["hidden"].clone()).unwrap();
    let ends = vec![code[0].clone(), code[11].clone()];
    assert_eq!(join_words(code, vec![0, 11], ends), Ok(JoinWords::Match), "a code is twelve words");
    assert!(hidden.len() == 2 && hidden[0] < hidden[1] && hidden[1] <= 11, "hidden positions");
    assert!(outcome["rosterVersion"].as_u64().unwrap() <= through, "a code past the head served");
}

/*
 * A join preview by person 2 of the join fixtures over one of the core's
 * histories (`history`, rosters `after` to `through`), with the settings
 * `settings` (`none`, `pin-main-2`, `not-open`), a chain or a fork this
 * session holds (`held`), a served roster cut (`cut`: `beside` or
 * `bad-signature`) and `record` (any JSON, sealed as person 2's chain
 * record), positions from the fixtures' draws; with `words` ("right",
 * "misheard", "blank") "They match" on the same served chain and record, and
 * with `join` the join: the full outcome, which the worker must match.
 * Invariants: every showing is twelve words and two positions at a roster no
 * later than the head served; a join commits only a code the check matched.
 */
fn join_preview_kind(value: &Value) -> Option<Value> {
    use crate::join;
    let base = &fixtures::core_join()["joinPreviews"];
    let history = text(value, "history")?;
    if !["main", "other", "succ", "madeUp"].contains(&history.as_str()) {
        return None;
    }
    let length = base["histories"][&history]["rosters"].as_array()?.len() as u64;
    let through = number(value, "through")?;
    let after = shape::optional_number(value, "after")?.unwrap_or(0);
    let settings = text(value, "settings")?;
    let held = shape::optional_text(value, "held")?;
    let cut = shape::optional_text(value, "cut")?;
    let words = shape::optional_text(value, "words")?;
    let join_too = match value.get("join") {
        None | Some(Value::Null) => false,
        Some(flag) => flag.as_bool()?,
    };
    let fits = (1..=length).contains(&through)
        && after <= through
        && ["none", "pin-main-2", "not-open"].contains(&settings.as_str())
        && held.as_deref().is_none_or(|held| ["chain", "fork"].contains(&held))
        && match cut.as_deref() {
            None => true,
            Some("beside") => after <= 2 && through >= 2,
            Some("bad-signature") => through > after,
            Some(_) => false,
        }
        && words
            .as_deref()
            .is_none_or(|words| ["right", "misheard", "blank"].contains(&words) && held.is_none())
        && (!join_too || words.is_some());
    if !fits {
        return None;
    }
    let mut doc = base.clone();
    let record = value.get("record").map(|record| {
        let f = join::family();
        chain_record_seal_value(&crate::device_records::root(), &f.p2.user_id, crate::groups::GROUP, record)
            .unwrap()
    });
    doc["records"]["fuzz"] = json!(record);
    let case = json!({
        "name": "fuzz",
        "settings": settings,
        "record": record.as_ref().map(|_| "fuzz"),
        "held": held,
        "served": { "history": history, "after": after, "through": through, "cut": cut },
        "words": words,
        "join": join_too,
    });
    if words.is_none() {
        let outcome = join::run_preview(&doc, &case);
        shown_well(&outcome, through);
        return Some(ok(outcome));
    }
    let flow = join::run_preview_flow(&doc, &case);
    shown_well(&flow["preview"], through);
    if flow["check"]["status"] == "changed" {
        shown_well(&flow["check"], through);
    }
    // A join commits only a code the check matched, and never below the roster that let them in.
    if flow["join"]["status"] == "accepted" {
        assert_eq!(flow["check"]["status"], "matched", "a join without a match");
        assert!(flow["join"]["rosterVersion"].as_u64() >= flow["preview"]["rosterVersion"].as_u64());
    }
    Some(ok(flow))
}

/*
 * Hidden positions from `draws` (up to 64 values a u32 holds), as a ledger
 * drawing them would take them: the two positions, or none when the draws
 * ran out first. Invariant: two ascending positions in 0..=11, and only draws
 * below the last whole run of twelve count.
 */
fn join_draws_kind(value: &Value) -> Option<Value> {
    let draws = value
        .get("draws")?
        .as_array()?
        .iter()
        .map(|v| shape::unsigned(v).and_then(|n| u32::try_from(n).ok()))
        .collect::<Option<Vec<u32>>>()?;
    if draws.len() > 64 {
        return None;
    }
    let positions = join_draw_positions(draws.clone());
    if let Some(p) = &positions {
        assert!(p.len() == 2 && p[0] < p[1] && p[1] <= 11, "hidden positions");
        // Only draws below the last whole run of twelve count: dropping the others changes nothing.
        let fair: Vec<u32> = draws.iter().copied().filter(|d| *d < u32::MAX - 3).collect();
        assert_eq!(join_draw_positions(fair).as_ref(), Some(p), "a draw past the last whole run counted");
    }
    Some(ok(json!(positions)))
}

const SESSION_HISTORIES: [&str; 7] =
    ["main", "other", "succ", "madeUp", "removal", "removalFork", "succOther"];
const SESSION_SETTINGS: [&str; 5] = ["none", "pin-main-2", "not-open", "checked-before", "checked-malformed"];
const GUARDS: [&str; 4] = ["none", "pin-main-2", "unreadable", "held"];
const FORGED: [&str; 4] = ["outbox", "other-family", "earlier-version", "newer-version"];

/* One step of a `join_session` input, with only the fields its op reads; None when it does not fit. */
fn session_step(step: &Value, at: usize, lengths: &[u64; 7]) -> Option<Value> {
    let served = |step: &Value| -> Option<Value> {
        let served = step.get("served")?;
        let history = text(served, "history")?;
        let length = lengths[SESSION_HISTORIES.iter().position(|h| *h == history)?];
        let through = number(served, "through")?;
        let cut = shape::optional_text(served, "cut")?;
        let fits = (1..=length).contains(&through)
            && match cut.as_deref() {
                None => true,
                Some("bad-signature") => true,
                Some("beside") => through >= 2,
                Some(_) => false,
            };
        fits.then(|| json!({ "history": history, "through": through, "cut": cut }))
    };
    let earlier = |key: &str| number(step, key).filter(|i| (*i as usize) < at);
    // The family guard a step hands the core (none when absent); one of GUARDS, else no fit.
    let guarded = |mut out: Value| -> Option<Value> {
        match step.get("guard") {
            None => {}
            Some(Value::String(guard)) if GUARDS.contains(&guard.as_str()) => {
                out["guard"] = json!(guard);
            }
            Some(_) => return None,
        }
        Some(out)
    };
    let op = text(step, "op")?;
    Some(match op.as_str() {
        "show" => json!({ "op": op, "served": served(step)? }),
        "sync" | "first-use" => guarded(json!({ "op": op, "served": served(step)? }))?,
        "check" => {
            let words =
                text(step, "words").filter(|w| ["right", "misheard", "blank"].contains(&w.as_str()))?;
            json!({ "op": op, "session": earlier("session")?, "words": words, "served": served(step)? })
        }
        "accept" => match (step.get("matched"), text(step, "record")) {
            (Some(_), None) => {
                guarded(json!({ "op": op, "matched": earlier("matched")?, "served": served(step)? }))?
            }
            (None, Some(record)) => {
                let fits = match record.strip_prefix("own:") {
                    Some(i) => i.parse::<usize>().is_ok_and(|i| i < at && i.to_string() == record[4..]),
                    None => FORGED.contains(&record.as_str()),
                };
                if !fits {
                    return None;
                }
                guarded(json!({ "op": op, "record": record, "served": served(step)? }))?
            }
            _ => return None,
        },
        // No `restore` restores nothing, as the shared scenarios write it.
        "relaunch" | "lock" => {
            json!({ "op": op, "restore": step.get("restore").map_or(Some(false), Value::as_bool)? })
        }
        "restore" => json!({ "op": op, "from": earlier("from")? }),
        "holds" | "forget" | "guard" => json!({ "op": op }),
        _ => return None,
    })
}

/*
 * A session of joining as an app drives it: `settings` (SESSION_SETTINGS)
 * and up to sixteen `steps` (the shared session scenarios' ops: show, check,
 * first-use, accept, sync, holds, guard, lock, relaunch, restore, forget; a
 * `guard` on each sync, first use and accept) over the core's join
 * histories, positions from the fixtures' draws: every step's outcome, which
 * the worker must match. Invariants (session_rules): held positions never
 * move until a match, after a restore too, which only ever holds more; the
 * first wrong pair is calm and every later one the alarm until a match; a
 * check of a showing from before a lock is refused; the escalation is kept
 * exactly while something is held; nothing joins without a match or a first
 * use, and each joins once per unlock; a first use only with no mark at all;
 * an unreadable guard never accepts; a first use commits only through its
 * record's rosters; the guard handed back never falls below the one held.
 */
fn join_session_kind(value: &Value) -> Option<Value> {
    use crate::join;
    let base = &fixtures::core_join()["joinPreviews"];
    let settings = text(value, "settings").filter(|s| SESSION_SETTINGS.contains(&s.as_str()))?;
    let lengths =
        SESSION_HISTORIES.map(|h| base["histories"][h]["rosters"].as_array().map_or(0, Vec::len) as u64);
    let steps = value.get("steps")?.as_array()?;
    if steps.is_empty() || steps.len() > 16 {
        return None;
    }
    let steps = steps
        .iter()
        .enumerate()
        .map(|(at, step)| session_step(step, at, &lengths))
        .collect::<Option<Vec<_>>>()?;
    let scenario = json!({ "name": "fuzz", "settings": settings, "steps": steps });
    let run = join::run_session(base, &scenario);
    session_rules(base, &settings, &steps, &run.outcomes);
    Some(ok(json!(run.outcomes)))
}

/* Whether guard `next` holds at least what `held` holds: roster, group key, every folder's floor. */
fn guard_covers(next: &Value, held: &Value) -> bool {
    let at = |guard: &Value, key: &str| guard[key].as_u64().unwrap_or(0);
    at(next, "rosterVersion") >= at(held, "rosterVersion")
        && at(next, "keyVersion") >= at(held, "keyVersion")
        && held["areas"].as_object().is_none_or(|areas| {
            areas.iter().all(|(area, floor)| next["areas"][area].as_u64() >= floor.as_u64())
        })
}

/*
 * The rules every join session keeps, checked over its steps and their
 * outcomes (join_session_kind). `book` is what the ledger holds now, `kept`
 * what the app last stored (each check's escalation), which a lock or a
 * relaunch restores, and `after` what was stored after each step.
 */
fn session_rules(base: &Value, settings: &str, steps: &[Value], outcomes: &[Value]) {
    use std::collections::{HashMap, HashSet};
    #[derive(Clone, Default)]
    struct Book {
        held: HashMap<String, Value>,
        tried: bool,
    }
    let key = |o: &Value| format!("{}:{}", o["rosterVersion"], o["code"]);
    let showing = |status: &Value| status == "code" || status == "changed";
    let mut book = Book::default();
    let mut kept = Book::default();
    let mut after: Vec<Book> = vec![];
    let mut pending: Option<Book> = None;
    let mut life = 0usize;
    let mut shown_in: HashMap<usize, usize> = HashMap::new();
    let mut joined = false;
    let mut used: HashSet<usize> = HashSet::new();
    // The marks with keys this device holds, each a history and the roster it reaches: the
    // settings pin, a guard handed (pin-main-2, or the held one from the step that handed it
    // back), the chain committed in this unlock, a first use's joins record.
    type Mark = (Value, u64);
    let main_2: Mark = (json!({ "history": "main", "cut": null }), 2);
    let mut guard: Option<Value> = None;
    let mut guard_from: Option<Mark> = None;
    let mut committed: Option<Mark> = None;
    // Whether a chain served holds a mark: through it, over its first keys and rosters (a cut chain is not compared).
    let holds_mark = |served: &Value, (from, version): &Mark| -> bool {
        if !served["cut"].is_null() || !from["cut"].is_null() {
            return true;
        }
        let here = &base["histories"][served["history"].as_str().unwrap()];
        let there = &base["histories"][from["history"].as_str().unwrap()];
        let first = |h: &Value| {
            h["rosters"].as_array().unwrap().iter().take(*version as usize).cloned().collect::<Vec<_>>()
        };
        served["through"].as_u64().unwrap() >= *version
            && here["firstKeys"] == there["firstKeys"]
            && first(here) == first(there)
    };
    for (at, (step, outcome)) in steps.iter().zip(outcomes).enumerate() {
        let status = &outcome["status"];
        let op = step["op"].as_str().unwrap();
        let handed = match step["guard"].as_str() {
            Some("held") => guard.is_some(),
            None | Some("none") => false,
            Some(_) => true,
        };
        let from = match (op, step["matched"].as_u64(), step["record"].as_str()) {
            ("accept", Some(i), _) => Some(i as usize),
            ("accept", None, Some(record)) => record.strip_prefix("own:").and_then(|i| i.parse().ok()),
            _ => None,
        };
        let mut marks: Vec<Mark> = vec![];
        if settings == "pin-main-2" {
            marks.push(main_2.clone());
        }
        if step["guard"] == "pin-main-2" {
            marks.push(main_2.clone());
        }
        if let (Some("held"), Some(mark)) = (step["guard"].as_str(), &guard_from) {
            marks.push(mark.clone());
        }
        if let Some(mark) = &committed {
            marks.push(mark.clone());
        }
        if let Some(i) = from.filter(|i| outcomes[*i]["status"] == "first-use") {
            marks.push((steps[i]["served"].clone(), outcomes[i]["rosterVersion"].as_u64().unwrap()));
        }
        if step["guard"] == "unreadable" {
            assert!(status != "accepted" && status != "first-use", "step {at}: an unreadable guard accepted");
        }
        if status == "accepted" || status == "first-use" {
            for mark in &marks {
                assert!(holds_mark(&step["served"], mark), "step {at}: accepted past a mark");
            }
        }
        if op == "first-use" && status == "first-use" {
            assert!(
                settings != "not-open" && settings != "checked-malformed",
                "step {at}: a first use without settings that hold"
            );
            // A family check fixes no keys: with nothing else, it leaves no first use either.
            if settings == "checked-before" {
                assert!(!marks.is_empty(), "step {at}: a first use over a family check");
            }
        }
        if outcome.get("guard").is_some_and(|next| !next.is_null()) {
            if let (Some("held"), Some(held)) = (step["guard"].as_str(), &guard) {
                assert!(guard_covers(&outcome["guard"], held), "step {at}: the guard went back");
            }
            guard = Some(outcome["guard"].clone());
            guard_from = Some((step["served"].clone(), outcome["guard"]["rosterVersion"].as_u64().unwrap()));
        }
        if (op == "accept" || op == "sync") && status == "accepted" {
            committed = Some((step["served"].clone(), outcome["rosterVersion"].as_u64().unwrap()));
        }
        // A restore folds in only what is not held here: only ever more held.
        if op == "show" || (op == "check" && status != "skipped") {
            if let Some(restored) = pending.take() {
                for (k, positions) in restored.held {
                    book.held.entry(k).or_insert(positions);
                }
                book.tried |= restored.tried;
            }
        }
        if showing(status) {
            if let Some(held) = book.held.get(&key(outcome)) {
                assert_eq!(&outcome["hidden"], held, "step {at}: held positions moved");
            }
            shown_in.insert(at, life);
        }
        match op {
            "check" if status != "skipped" => {
                let i = step["session"].as_u64().unwrap() as usize;
                let shown = &outcomes[i];
                if shown_in.get(&i) != Some(&life) {
                    assert_eq!(status, "refused", "step {at}: a showing from before a lock was checked");
                }
                match status.as_str().unwrap() {
                    "wrong-words" | "mismatch" => {
                        let alarm = book.tried || book.held.contains_key(&key(shown));
                        assert_eq!(status == "mismatch", alarm, "step {at}: the calm try and the alarm");
                        book.held.insert(key(shown), shown["hidden"].clone());
                        book.tried = true;
                    }
                    "matched" => {
                        book.held.remove(&key(shown));
                        book.tried = false;
                    }
                    _ => {}
                }
                if outcome.get("kept").is_some() {
                    assert_eq!(outcome["kept"] == true, !book.held.is_empty(), "step {at}: kept while held");
                    kept = book.clone();
                }
            }
            "accept" if status == "accepted" => {
                let from = from.unwrap_or_else(|| panic!("step {at}: a forged joins record joined"));
                let joined_from = &outcomes[from];
                assert!(
                    joined_from["status"] == "matched" || joined_from["status"] == "first-use",
                    "step {at}: a join without a match"
                );
                assert!(used.insert(from), "step {at}: a match joined twice in one unlock");
                joined = true;
            }
            // Without a settings pin or a guard, only a join gives this device a mark.
            "sync" if status == "accepted" && settings != "pin-main-2" && !handed => {
                assert!(joined, "step {at}: a family accepted before any join")
            }
            "relaunch" | "lock" => {
                life += 1;
                pending = (step["restore"] == true).then(|| kept.clone());
                book = Book::default();
                joined = false;
                committed = None;
                used.clear();
            }
            "restore" if status != "skipped" => {
                pending = Some(after[step["from"].as_u64().unwrap() as usize].clone());
            }
            "forget" => {
                joined = false;
                committed = None;
                used.clear();
            }
            _ => {}
        }
        after.push(kept.clone());
    }
}

/*
 * A chain record holding `record` (any JSON; none when absent), sealed for
 * person 1 of the device record fixtures and accepted in the core's order
 * (accept_served, following FetchFromVersionOne) against the fixture family's
 * served chain, from `start` (0 to 3), with the settings pin at roster 1 when
 * `settings`: the full outcome, which the web's order must match. Invariant:
 * an accepted chain's pin is at its roster version and is a pin.
 */
fn device_record(value: &Value) -> Option<Value> {
    use crate::device_records;
    let start = number(value, "start")?;
    let settings = value.get("settings")?.as_bool()?;
    // How far the server serves (1 to 3, all of it when absent) and the chain committed first (0 for none).
    let through = shape::optional_number(value, "through")?.unwrap_or(3);
    let held = shape::optional_number(value, "held")?.unwrap_or(0);
    if start > through || !(1..=3).contains(&through) || held > 3 {
        return None;
    }
    let cases = fixtures::core_ledger()["deviceRecords"]["cases"].as_array()?;
    let named = |name: &str| cases.iter().find(|c| c["name"] == name);
    let whole = named("continuation-refused-then-from-version-1")?["served"]
        .as_array()?
        .iter()
        .find(|s| s["after"] == 0)?
        .clone();
    let up_to = |n: u64| -> Option<Value> {
        let rosters: Vec<Value> = whole["rosters"].as_array()?.iter().take(n as usize).cloned().collect();
        Some(json!({ "after": 0, "rosters": rosters, "successions": [] }))
    };
    let full = up_to(through)?;
    let settings_at_1 = named("record-after-a-master-key-rotation")?["settingsPin"].clone();
    let f = device_records::family();
    let record = value.get("record").map(|record| {
        chain_record_seal_value(&device_records::root(), &f.p1.user_id, crate::groups::GROUP, record).unwrap()
    });
    let mut served = vec![full.clone()];
    if start > 0 {
        let rosters: Vec<Value> = full["rosters"].as_array()?.iter().skip(start as usize).cloned().collect();
        served.insert(0, json!({ "after": start, "rosters": rosters, "successions": [] }));
    }
    let case = json!({
        "name": "fuzz",
        "record": record,
        "settingsPin": if settings { settings_at_1.clone() } else { Value::Null },
        "held": if held > 0 { up_to(held)? } else { Value::Null },
        "heldSettingsPin": settings_at_1,
        "start": start,
        "served": served,
        "firstKeys": cases[0]["firstKeys"],
        "signerKeys": cases[0]["signerKeys"],
    });
    let (outcome, _) = device_records::run(&case);
    if outcome["status"] == "accepted" {
        assert_eq!(
            outcome["pin"]["rosterVersion"], outcome["rosterVersion"],
            "the pin is at the chain's roster"
        );
        let pin = crate::groups::pin_from(&outcome["pin"]);
        assert!(group_pin_check(crate::groups::GROUP.into(), pin).is_ok(), "an accepted pin is a pin");
        // The record's own pin, whenever it is a pin, is a mark the accepted chain reaches and passes through.
        let marked = value
            .get("record")
            .and_then(|record| record.get("pin"))
            .and_then(shape::group_pin)
            .and_then(|pin| group_pin_check(crate::groups::GROUP.into(), pin).ok());
        let version = outcome["rosterVersion"].as_u64().unwrap();
        // The chain committed first is a floor: never accepted below it.
        assert!(version >= held, "accepted below the chain this session committed");
        if let Some(pin) = marked {
            assert!(version >= pin.roster_version, "accepted below the record's pin");
            let statement =
                whole["rosters"][(pin.roster_version - 1) as usize]["statement"].as_str().unwrap();
            let digest = roster_digest(base64url_decode(statement.into()).unwrap());
            assert_eq!(digest, pin.roster_digest, "accepted through another roster than the record's pin");
        }
    }
    Some(ok(outcome))
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

/*
 * An outbox entry's JSON (`entry`, any value) read for the roster-call
 * family, kept under `id` (none: any), with the admin's pin of an admission's
 * person (`pin`: null or `{userId, fingerprint}`) and the committed head
 * (`head`: null, or 1 to 8 rosters of the family's history and calls):
 * sent, held and why, landed, superseded, or lost. Invariant: a sent body is
 * the entry's exact text when it keeps text (what F7's resend sends), and
 * reading the same entry again gives the very same bytes.
 */
fn outbox_entry_kind(value: &Value) -> Option<Value> {
    use crate::roster_calls::{hold_name, route_json};
    let entry = value.get("entry")?;
    let pin = match value.get("pin") {
        None | Some(Value::Null) => None,
        // The pin by its key commitment (`keys`); seeds from before name it `fingerprint`.
        Some(pin) => Some((text(pin, "userId")?, text(pin, "keys").or_else(|| text(pin, "fingerprint"))?)),
    };
    let id = shape::optional_text(value, "id")?;
    let head: Option<Vec<String>> = match value.get("head") {
        None | Some(Value::Null) => None,
        Some(list) => {
            Some(list.as_array()?.iter().map(|d| d.as_str().map(str::to_string)).collect::<Option<_>>()?)
        }
    };
    let group_id = text(&fixtures::core_roster_calls()["family"], "groupId")?;
    let read = |entry: &Value| {
        hushos_core::outbox_entry_read(
            entry,
            &group_id,
            id.as_deref(),
            pin.as_ref().map(|(u, f)| (u.as_str(), f.as_str())),
            head.as_deref(),
        )
    };
    Some(ok(match read(entry) {
        None => json!({ "status": "lost" }),
        Some(OutboxCall::Hold { route, reason, .. }) => {
            json!({ "status": "hold", "route": route_json(&route), "reason": hold_name(reason) })
        }
        Some(OutboxCall::Landed { route, .. }) => json!({ "status": "landed", "route": route_json(&route) }),
        Some(OutboxCall::Superseded { route, .. }) => {
            json!({ "status": "superseded", "route": route_json(&route) })
        }
        Some(OutboxCall::Send { route, body, .. }) => {
            assert!(
                serde_json::from_str::<Value>(&body).is_ok_and(|b| b.is_object()),
                "a body that is no object"
            );
            if let Some(kept) = entry["body"].as_str() {
                assert_eq!(body, kept, "a resend of other bytes than the ones kept");
            }
            match read(entry) {
                Some(OutboxCall::Send { body: again, .. }) => {
                    assert_eq!(body, again, "a resend of other bytes")
                }
                other => panic!("read again as {other:?}"),
            }
            json!({ "status": "send", "route": route_json(&route) })
        }
    }))
}

/*
 * The admin's join code over the core's roster-call family: person `who`
 * (1 to 5, or 6 for someone never in it), with a contact pin of them filed
 * holding person `keys`'s keys (1 to 5, or null for none), over the served
 * `rosters` (indices 0 to 6 into the family's history, 7 for a junk roster, at
 * most 16). Invariant: a code is the one of a roster on the chain, and only
 * for the keys pinned.
 */
fn member_join_code_kind(value: &Value) -> Option<Value> {
    use crate::roster_calls::{committed_ledger, join_code_with, junk_roster};
    let doc = fixtures::core_roster_calls();
    let who = number(value, "who").filter(|n| (1..=6).contains(n))? as usize;
    let keys = match value.get("keys") {
        None | Some(Value::Null) => None,
        Some(keys) => Some(shape::unsigned(keys).filter(|n| (1..=5).contains(n))? as usize),
    };
    let picks = value.get("rosters")?.as_array()?;
    if picks.len() > 16 {
        return None;
    }
    let history: Vec<SignedGroupStatement> =
        doc["family"]["rosters"].as_array()?.iter().map(crate::groups::signed_of).collect();
    let rosters = picks
        .iter()
        .map(|pick| match shape::unsigned(pick)? {
            7 => Some(junk_roster()),
            i if i < 7 => Some(history[i as usize].clone()),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    let filed = match (who, keys) {
        (who @ 1..=5, Some(keys)) => vec![(who, keys)],
        _ => vec![],
    };
    let ledger = committed_ledger(doc, filed, None);
    let outcome = join_code_with(&ledger, doc, who, rosters);
    if outcome["status"] == "code" {
        let version = outcome["rosterVersion"].as_u64().unwrap();
        assert!((1..=7).contains(&version), "a code past the head");
        assert_eq!(keys, Some(who), "a code for keys someone else pinned");
    }
    Some(match outcome["status"].as_str() {
        Some("refused") => refused(),
        _ => ok(outcome),
    })
}

/*
 * One roster call by person 1 of the core's roster-call family: `op` as the
 * shared fixtures write it (`kind` admit, grant, take, handover or stepDown;
 * `who` 1 to 5; `roles` among members, billing and guardian; an admission's
 * `served` identity with any of its fields replaced). The verdict is the body
 * as every member reads it, or a refusal. Invariant: a body that was built is
 * the next roster on the chain and every seal and grant in it opens to its
 * holder (the verdict asserts it).
 */
fn roster_call_kind(value: &Value) -> Option<Value> {
    use crate::roster_calls::{family_json, run, verdict};
    let op = value.get("op")?.as_object()?;
    let kind = op.get("kind")?.as_str()?;
    if !["admit", "grant", "take", "handover", "stepDown"].contains(&kind) {
        return None;
    }
    let person = |key: &str| op.get(key).and_then(shape::unsigned).filter(|n| (1..=5).contains(n));
    let mut clean = serde_json::Map::new();
    clean.insert("kind".into(), json!(kind));
    if kind != "stepDown" {
        clean.insert("who".into(), json!(person("who")?));
    }
    if kind == "admit" {
        let roles = op.get("roles")?.as_array()?;
        if roles.len() > 3
            || !roles
                .iter()
                .all(|r| r.as_str().is_some_and(|r| ["members", "billing", "guardian"].contains(&r)))
        {
            return None;
        }
        clean.insert("roles".into(), json!(roles));
        if let Some(served) = op.get("served").filter(|s| !s.is_null()) {
            let served = served.as_object()?;
            for (key, field) in served {
                let fits = match key.as_str() {
                    "keyVersion" => shape::unsigned(field).is_some(),
                    "encryptionPublicKey"
                    | "signingPublicKey"
                    | "mlDsaPublicKey"
                    | "kemPublicKey"
                    | "keysSignature" => field.is_string(),
                    _ => false,
                };
                if !fits {
                    return None;
                }
            }
            clean.insert("served".into(), json!(served));
        }
    }
    let op = Value::Object(clean);
    Some(match run(&op) {
        Err(_) => refused(),
        Ok(call) => {
            let body: Value = serde_json::from_str(&call.body).unwrap();
            let doc = json!({ "family": family_json() });
            let route = crate::roster_calls::route_json(&call.route);
            ok(verdict(&doc, &route, &body))
        }
    })
}

/*
 * A manager's device over time: up to 12 steps (sync, open the key or the
 * folders, build a call, lock, unlock, relaunch, another manager's roster,
 * send a kept entry with the server's answer), each as the shared session
 * scenarios write it. The verdict is every step's outcome. Invariants (the
 * interpreter asserts them): a sent body is the kept one, byte for byte; a
 * built call's expectedRevision is the head it was built on; nothing is built
 * while locked; a Hold carries no body (its type has none).
 */
fn roster_call_session_kind(value: &Value) -> Option<Value> {
    use crate::roster_calls::{session_run, session_step};
    let steps = value.get("steps")?.as_array()?;
    if steps.len() > 12 {
        return None;
    }
    let steps = steps.iter().map(session_step).collect::<Option<Vec<_>>>()?;
    Some(ok(Value::Array(session_run(&steps))))
}

/*
 * A settings document's plaintext (`text`, JSON text as a JSON string so both
 * twins read the same bytes), read as the ledger reads it, with each of
 * `users` (at most 8) and `groups` (at most 8) probed: the contact pin found
 * and the group pin's verdict (refusal words dropped). Skipped: text either
 * twin's JSON parser reads its own way (numbers past an f64, more than 64
 * brackets; escaped lone surrogates are repaired alike before parsing). Invariants: a pin found under a probe names
 * it in any case; one an admission takes holds every key part.
 */
pub fn settings_fits(text: &str) -> bool {
    // A number token both parsers read to the same f64: at most 200 digits, an exponent of at most two.
    let number_ok = |token: &str| {
        let (mantissa, exponent) = token.split_once(['e', 'E']).unwrap_or((token, ""));
        mantissa.bytes().filter(u8::is_ascii_digit).count() <= 200
            && exponent.bytes().filter(u8::is_ascii_digit).count() <= 2
    };
    let (mut in_string, mut escape, mut brackets, mut token) = (false, false, 0usize, String::new());
    for c in text.chars() {
        if in_string {
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        if c.is_ascii_digit() || "+-.eE".contains(c) {
            token.push(c);
            continue;
        }
        if !number_ok(&token) {
            return false;
        }
        token.clear();
        match c {
            '"' => in_string = true,
            '{' | '[' => brackets += 1,
            _ => {}
        }
    }
    number_ok(&token) && brackets <= 64
}

fn settings_kind(value: &Value) -> Option<Value> {
    let text = text(value, "text")?;
    let users = strings_of(value, "users")?;
    let groups = strings_of(value, "groups")?;
    if users.len() > 8 || groups.len() > 8 || text.len() > 65_536 || !settings_fits(&text) {
        return None;
    }
    let mut verdict = settings_document_verdict(text.as_bytes(), &users, &groups);
    if verdict["status"] == "refused" {
        return Some(refused());
    }
    for user in &users {
        let found = &verdict["contacts"][user];
        if found.is_null() {
            continue;
        }
        assert_eq!(
            found["userId"].as_str().unwrap().to_lowercase(),
            user.to_lowercase(),
            "a pin found under another person"
        );
        if found["checked"] == json!(true) {
            assert!(
                found["keys"].as_array().unwrap().iter().all(Value::is_string),
                "a checked pin short of a key"
            );
            assert!(found["fingerprint"].is_string(), "a checked pin with no fingerprint");
        }
    }
    for group in &groups {
        let at = &mut verdict["groups"][group];
        if at.get("refused").is_some() {
            *at = json!({ "refused": true });
        } else if let Some(pin) = at.get("pin") {
            let pin = crate::groups::pin_from(pin);
            assert!(group_pin_check(group.clone(), pin).is_ok(), "a pin read that does not check");
        }
    }
    Some(ok(verdict))
}

/*
 * A family folder of the roster-call family opened by person 2 (the core's
 * `areaOpens` cases' vocabulary: `area` A1, A2, A3 or foreign, `served` 1 to
 * 4, `grant` null or person 1's of `key` [0 or 2, 1 or 2] with `granterKey`,
 * and `selfGrant` null or any envelope of the personal grant's shape). The
 * verdict is what opened it (or a refusal). Invariants: a self-grant opens
 * only at or above the chain's latest version and the served one; a
 * self-grant to store comes only from a grant at the version both name.
 */
fn area_open_kind(value: &Value) -> Option<Value> {
    use crate::settings_areas::run_area;
    let area = text(value, "area")?;
    if !["A1", "A2", "A3", "foreign"].contains(&area.as_str()) {
        return None;
    }
    let served = number(value, "served").filter(|n| (1..=4).contains(n))?;
    let grant = match value.get("grant") {
        None | Some(Value::Null) => Value::Null,
        Some(grant) => {
            let key = grant.get("key")?.as_array()?;
            let index = shape::unsigned(key.first()?).filter(|n| *n == 0 || *n == 2)?;
            let version = shape::unsigned(key.get(1)?).filter(|n| (1..=2).contains(n))?;
            if key.len() != 2 || (index == 0 && version != 1) {
                return None;
            }
            let granter = match grant.get("granterKey") {
                None | Some(Value::Null) => true,
                Some(Value::Bool(b)) => *b,
                _ => return None,
            };
            json!({ "key": [index, version], "granterKey": granter })
        }
    };
    let self_grant = match value.get("selfGrant") {
        None | Some(Value::Null) => Value::Null,
        Some(own) => {
            let version = shape::number(own, "version").filter(|n| *n <= u32::MAX as u64)?;
            json!({
                "version": version,
                "workspaceId": text(own, "workspaceId")?,
                "keyVersion": shape::number(own, "keyVersion")?,
                "workspaceKeyVersion": shape::number(own, "workspaceKeyVersion")?,
                "wrappingSalt": text(own, "wrappingSalt")?,
                "wrappingNonce": text(own, "wrappingNonce")?,
                "encryptedKey": text(own, "encryptedKey")?,
            })
        }
    };
    let spec = json!({ "area": area, "served": served, "grant": grant, "selfGrant": {} });
    let (outcome, stored) = run_area(&spec, &self_grant);
    if outcome.get("refused").is_some() {
        return Some(refused());
    }
    let latest = if area == "A3" { 2 } else { 1 };
    if outcome["from"] == "self-grant" {
        let v = self_grant["workspaceKeyVersion"].as_u64().unwrap();
        assert!(v >= latest && v >= served && v <= latest, "a self-grant taken off the latest version");
    }
    if let Some(stored) = stored {
        assert_eq!(outcome["from"], "grant", "a self-grant made from a self-grant");
        assert!(
            stored.workspace_key_version == latest && served == latest,
            "a self-grant of a key not current"
        );
    }
    Some(ok(outcome))
}

/*
 * A pair code (docs/optional-verification.md 3.4): with `rosterDigest`, as
 * pair_code_of works it out over any `rosterDigest`, `groupKey`,
 * `groupKeyVersion`, `userId` and `otherUserId`; else as person `me` (1 to 5)
 * of the roster-call family works it out with person `other` over the
 * family's chain, holding the keys of person `as` (`me` when absent).
 * Invariants: two equal ids are refused; the code is the same with the ids
 * swapped (over the chain: the same code and roster when the other person
 * works it out); a device holding keys other than its own entry's gets no
 * code.
 */
fn pair_code_kind(value: &Value) -> Option<Value> {
    use crate::roster_calls::pair_run_over;
    if value.get("rosterDigest").is_some() {
        let roster_digest = text(value, "rosterDigest")?;
        let group_key = shape::group_key(value.get("groupKey")?)?;
        let version = number(value, "groupKeyVersion")?;
        let (user_id, other_user_id) = (text(value, "userId")?, text(value, "otherUserId")?);
        let code = pair_code_of(&roster_digest, &group_key, version, &user_id, &other_user_id);
        return Some(either(code, |code| {
            assert_ne!(user_id, other_user_id, "a pair code of one member with themselves");
            let swapped = pair_code_of(&roster_digest, &group_key, version, &other_user_id, &user_id);
            assert_eq!(swapped.ok().as_ref(), Some(&code), "a pair code that hangs on the order");
            json!(code)
        }));
    }
    let person = |key: &str| {
        let raw = if key == "as" && value.get("as").is_none() { value.get("me") } else { value.get(key) };
        shape::unsigned(raw?).filter(|n| (1..=5).contains(n))
    };
    let (me, other, holding) = (person("me")?, person("other")?, person("as")?);
    let doc = fixtures::core_roster_calls();
    let outcome = pair_run_over(doc, &json!({ "me": me, "other": other, "as": holding }));
    if outcome["status"] == "refused" {
        return Some(refused());
    }
    assert_ne!(me, other, "a pair code of one member with themselves");
    if holding != me {
        assert_ne!(outcome["status"], "code", "a pair code over keys this device does not hold");
    }
    if outcome["status"] == "code" && holding == me {
        let theirs = pair_run_over(doc, &json!({ "me": other, "other": me, "as": other }));
        assert!(
            theirs["status"] == "code"
                && theirs["rosterVersion"] == outcome["rosterVersion"]
                && theirs["code"] == outcome["code"],
            "two members shown different pair codes"
        );
    }
    Some(ok(outcome))
}

/*
 * Any JSON `record`, sealed as person 2's joins record of the join family
 * through the fixtures-only sealer and read back by an acceptance joining
 * over `served` (`history`, `through`), settings none, no guard: the
 * outcome, which the web must match. Invariants: only a record of this
 * family at version 3 or 4 joins, with a join mark or (at 4) a first-use pin;
 * a first use joins only over the roster and first keys its pin names, at or
 * above its roster, and is never reported checked; a join mark always is.
 */
fn joins_record_kind(value: &Value) -> Option<Value> {
    use crate::join;
    let base = &fixtures::core_join()["joinPreviews"];
    let record = value.get("record")?;
    let served = value.get("served").filter(|served| served.is_object())?;
    let history = text(served, "history").filter(|h| SESSION_HISTORIES.contains(&h.as_str()))?;
    let rosters = base["histories"][&history]["rosters"].as_array()?;
    let through = number(served, "through").filter(|n| (1..=rosters.len() as u64).contains(n))?;
    let step = json!({
        "op": "accept",
        "record": "value",
        "value": record,
        "served": { "history": history, "through": through, "cut": null },
    });
    let run = join::run_session(base, &json!({ "name": "fuzz", "settings": "none", "steps": [step] }));
    let outcome = &run.outcomes[0];
    if outcome["status"] == "refused" {
        return Some(refused());
    }
    if outcome["status"] == "accepted" {
        let version = record["v"].as_f64();
        assert!(
            record.is_object()
                && (version == Some(3.0) || version == Some(4.0))
                && record["groupId"] == crate::groups::GROUP,
            "a joins record of no version or family joined"
        );
        let first = record.get("firstUse").filter(|first| version == Some(4.0) && first.is_object());
        if let Some(first) = first {
            assert!(record.get("joinMark").is_none(), "a record with a join mark and a first use joined");
            assert!(outcome["checked"].is_null(), "a first use reported checked");
            let at = first["rosterVersion"].as_u64().unwrap();
            assert!(outcome["rosterVersion"].as_u64().unwrap() >= at, "a first use joined short of its pin");
            let statement =
                base64url_decode(rosters[at as usize - 1]["statement"].as_str().unwrap().into()).unwrap();
            assert!(
                json!(roster_digest(statement)) == first["rosterDigest"]
                    && base["histories"][&history]["firstKeys"]["ed25519PublicKey"]
                        == first["firstEd25519PublicKey"],
                "a first use joined over another history than its pin's"
            );
        } else {
            assert!(!outcome["checked"].is_null(), "a join mark joined unchecked");
        }
    }
    Some(ok(outcome.clone()))
}
