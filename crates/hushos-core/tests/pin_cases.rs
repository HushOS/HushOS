//! The shared pin cases (`fixtures/pin-cases.json`, written by
//! `packages/crypto/scripts/pin-cases.ts` with every outcome stated by hand),
//! as this core decides them; `packages/drive/src/pin-cases.test.ts` holds the
//! web to the same. A case the twins decide otherwise is a pin the web and the
//! phones would trust differently.

use hushos_core::*;
use serde_json::Value;

fn cases() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/pin-cases.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("JSON")
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

/* A pin's key fields as the settings document holds them; a pin without a fingerprint string is not one here. */
fn pin_keys(pin: &Value) -> PinKeys {
    PinKeys {
        key_version: pin.get("keyVersion").and_then(Value::as_u64),
        encryption_public_key: text(pin, "encryptionPublicKey").unwrap(),
        signing_public_key: text(pin, "signingPublicKey").unwrap(),
        ml_dsa_public_key_hash: text(pin, "mlDsaPublicKeyHash"),
        kem_public_key_hash: text(pin, "kemPublicKeyHash"),
        fingerprint: text(pin, "fingerprint").unwrap(),
    }
}

fn pin_json(pin: &PinKeys) -> Value {
    serde_json::json!({
        "encryptionPublicKey": pin.encryption_public_key,
        "signingPublicKey": pin.signing_public_key,
        "mlDsaPublicKeyHash": pin.ml_dsa_public_key_hash,
        "kemPublicKeyHash": pin.kem_public_key_hash,
        "keyVersion": pin.key_version,
        "fingerprint": pin.fingerprint,
    })
}

#[test]
fn trust_and_key_commitment_are_the_shared_ones() {
    for case in cases()["trust"].as_array().unwrap() {
        let pin = pin_keys(&case["pin"]);
        let trust = match pin_trust(pin.clone()) {
            PinTrust::Verified => "verified",
            PinTrust::Seen => "seen",
            PinTrust::Legacy => "legacy",
            PinTrust::Invalid => "invalid",
        };
        assert_eq!(trust, case["trust"].as_str().unwrap(), "{}", case["name"]);
        assert_eq!(key_commitment(pin), text(case, "commitment"), "{}", case["name"]);
    }
}

#[test]
fn comparisons_are_the_shared_ones() {
    for case in cases()["comparisons"].as_array().unwrap() {
        let served = &case["served"];
        let served = ServedContactKeys {
            key_version: served["keyVersion"].as_u64().unwrap(),
            encryption_public_key: text(served, "encryptionPublicKey").unwrap(),
            signing_public_key: text(served, "signingPublicKey").unwrap(),
            ml_dsa_public_key: text(served, "mlDsaPublicKey"),
            kem_public_key: text(served, "kemPublicKey"),
        };
        let comparison = match compare_pin(pin_keys(&case["pin"]), served) {
            PinComparison::Same => "same",
            PinComparison::Recheck => "recheck",
            PinComparison::Succession => "succession",
            PinComparison::Changed => "changed",
        };
        assert_eq!(comparison, case["expected"].as_str().unwrap(), "{}", case["name"]);
    }
}

#[test]
fn pins_of_served_keys_are_the_shared_ones() {
    for case in cases()["servedPins"].as_array().unwrap() {
        let served = &case["served"];
        let served = ServedKeys {
            key_version: served["keyVersion"].as_u64().unwrap(),
            encryption_public_key: text(served, "encryptionPublicKey").unwrap(),
            signing_public_key: text(served, "signingPublicKey").unwrap(),
            ml_dsa_public_key: text(served, "mlDsaPublicKey").unwrap(),
            kem_public_key: text(served, "kemPublicKey").unwrap(),
        };
        let made = pin_of_served(served, case["form"] == "verified");
        match &case["expected"] {
            Value::Null => assert!(made.is_err(), "{}", case["name"]),
            expected => assert_eq!(&pin_json(&made.unwrap()), expected, "{}", case["name"]),
        }
    }
}

#[test]
fn guards_are_the_shared_ones() {
    for case in cases()["guards"].as_array().unwrap() {
        let guard = match &case["guard"] {
            Value::Null => GuardState::Absent,
            Value::String(state) if state == "unreadable" => GuardState::Unreadable,
            entry => GuardState::Held {
                entry: GuardEntry {
                    revision: entry["revision"].as_u64().unwrap(),
                    key_version: entry["keyVersion"].as_u64(),
                    encryption_public_key: text(entry, "encryptionPublicKey").unwrap(),
                    signing_public_key: text(entry, "signingPublicKey").unwrap(),
                    ml_dsa_public_key_hash: text(entry, "mlDsaPublicKeyHash").unwrap(),
                    kem_public_key_hash: text(entry, "kemPublicKeyHash").unwrap(),
                    previous_signing_keys: vec![],
                    verified: entry["verified"].as_bool().unwrap(),
                },
            },
        };
        let pin = (!case["pin"].is_null()).then(|| pin_keys(&case["pin"]));
        let verdict = match guard_agrees("user".into(), guard, pin, None, vec![]) {
            GuardVerdict::FirstUse => "first-use",
            GuardVerdict::Agrees => "agrees",
            GuardVerdict::Follows => "follows",
            GuardVerdict::Changed => "changed",
            GuardVerdict::Unchecked => "unchecked",
        };
        assert_eq!(verdict, case["expected"].as_str().unwrap(), "{}", case["name"]);
    }
}

#[test]
fn kept_admissions_are_sent_as_the_shared_cases_say() {
    let doc = cases();
    let group_id = doc["groupId"].as_str().unwrap();
    for case in doc["admissions"].as_array().unwrap() {
        let pin = (!case["pin"].is_null())
            .then(|| (text(&case["pin"], "userId").unwrap(), text(&case["pin"], "keys").unwrap()));
        let read = outbox_entry_read(
            &case["entry"],
            group_id,
            None,
            pin.as_ref().map(|(user, keys)| (user.as_str(), keys.as_str())),
            None,
        );
        let outcome = match read {
            Some(OutboxCall::Send { .. }) => "send",
            Some(OutboxCall::Hold { reason: OutboxHold::OtherKeys, .. }) => "hold",
            other => panic!("{}: {other:?}", case["name"]),
        };
        assert_eq!(outcome, case["expected"].as_str().unwrap(), "{}", case["name"]);
    }
}

/* Whether a value has the type a 0.10.0 reader decodes it as. */
fn type_holds(kind: &str, value: &Value) -> bool {
    match kind {
        "string" => value.is_string(),
        "bool" => value.is_boolean(),
        "u64" => value.as_u64().is_some(),
        "string[]" => value.as_array().is_some_and(|all| all.iter().all(Value::is_string)),
        "present" => true,
        other => panic!("{other}"),
    }
}

fn decodes(shape: &Value, pin: &Value) -> bool {
    let fields = |key: &str| shape[key].as_object().unwrap().clone();
    fields("required").iter().all(|(key, kind)| {
        let kind = kind.as_str().unwrap();
        pin.get(key).is_some_and(|value| (kind == "present" || !value.is_null()) && type_holds(kind, value))
    }) && fields("optional").iter().all(|(key, kind)| match pin.get(key) {
        None | Some(Value::Null) => true,
        Some(value) => type_holds(kind.as_str().unwrap(), value),
    })
}

#[test]
fn the_0_10_0_apps_decode_a_first_seen_pin_and_read_it_unverified() {
    let doc = cases();
    let readers = &doc["readers"];
    let optional = |pin: &Value, key: &str| text(pin, key).filter(|value| !value.is_empty());
    for case in readers["cases"].as_array().unwrap() {
        let pin = &case["pin"];
        let ios = decodes(&readers["shapes"]["ios-0.10.0"], pin);
        assert_eq!(ios, case["ios"]["decodes"].as_bool().unwrap(), "{}", case["name"]);
        if ios {
            let verified = pin_verified(
                text(pin, "encryptionPublicKey").unwrap(),
                text(pin, "signingPublicKey").unwrap(),
                text(pin, "mlDsaPublicKeyHash"),
                text(pin, "kemPublicKeyHash"),
                text(pin, "fingerprint").unwrap(),
            );
            assert_eq!(verified, case["ios"]["verified"].as_bool().unwrap(), "{}", case["name"]);
        }
        let android = decodes(&readers["shapes"]["android-0.10.0"], pin);
        assert_eq!(android, case["android"]["decodes"].as_bool().unwrap(), "{}", case["name"]);
        let verified = pin_verified(
            text(pin, "encryptionPublicKey").unwrap(),
            text(pin, "signingPublicKey").unwrap_or_default(),
            optional(pin, "mlDsaPublicKeyHash"),
            optional(pin, "kemPublicKeyHash"),
            text(pin, "fingerprint").unwrap_or_default(),
        );
        assert_eq!(verified, case["android"]["verified"].as_bool().unwrap(), "{}", case["name"]);
    }
}
