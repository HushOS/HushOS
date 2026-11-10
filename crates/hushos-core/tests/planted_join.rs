//! A real iOS 0.10.0 join over a planted entry (`fixtures/v0.10.0/planted-join.json`,
//! made by the 0.10.0 core itself: `fixtures/v0.10.0/planted_join.rs`), held
//! against this core (docs/optional-verification.md 3.4, "Older apps"). The
//! organizer let person 2 in at roster 2 under keys the server made; person
//! 2's 0.10.0 phone matched the join code over them and joined, finding its
//! entry wrong only afterwards. Here: that phone's device gets no pair code at
//! that roster, the organizer's pair code with it is not the code 0.10.0
//! compared, and the one-way path (the old join code read to the phone) gives
//! the organizer's device nothing to save. `packages/crypto/src/planted-join.test.ts`
//! holds the web to the same.

use hushos_core::*;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

fn fixture() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/v0.10.0/planted-join.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("JSON")
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_else(|| panic!("{key}")).to_string()
}

fn bytes(value: &Value, key: &str) -> Vec<u8> {
    base64url_decode(text(value, key)).unwrap()
}

fn keys_of(value: &Value) -> ServedKeys {
    ServedKeys {
        key_version: value["keyVersion"].as_u64().unwrap(),
        encryption_public_key: text(value, "encryptionPublicKey"),
        signing_public_key: text(value, "signingPublicKey"),
        ml_dsa_public_key: text(value, "mlDsaPublicKey"),
        kem_public_key: text(value, "kemPublicKey"),
    }
}

fn rosters(f: &Value) -> Vec<SignedGroupStatement> {
    f["rosters"]
        .as_array()
        .unwrap()
        .iter()
        .map(|at| SignedGroupStatement {
            statement: bytes(at, "statement"),
            signature: GroupSignature {
                ed25519: bytes(&at["signature"], "ed25519"),
                ml_dsa: bytes(&at["signature"], "mlDsa"),
            },
            signer_signature: bytes(at, "signerSignature"),
        })
        .collect()
}

fn first_keys(f: &Value) -> GroupPublicKey {
    GroupPublicKey {
        ed25519_public_key: text(&f["firstKeys"], "ed25519PublicKey"),
        ml_dsa_public_key: text(&f["firstKeys"], "mlDsaPublicKey"),
    }
}

fn signer_keys(f: &Value) -> HashMap<String, String> {
    f["signerKeys"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().into()))
        .collect()
}

fn me(f: &Value, who: &str) -> OwnIdentities {
    OwnIdentities { user_id: text(&f[who], "userId"), identities: vec![keys_of(&f[who]["identity"])] }
}

fn code(f: &Value) -> Vec<String> {
    f["preview"]["code"].as_array().unwrap().iter().map(|w| w.as_str().unwrap().to_string()).collect()
}

/* The served chain as `who` accepts it, with `anchor` and `join_mark`. */
fn chain_as(f: &Value, who: &str, anchor: GroupAnchor, join_mark: Option<JoinMark>) -> Arc<AcceptedRosters> {
    let RosterChain::Accepted { chain } = accept_rosters_joining(
        text(f, "groupId"),
        first_keys(f),
        Some(anchor),
        vec![],
        rosters(f),
        vec![],
        signer_keys(f),
        me(f, who),
        None,
        join_mark,
        vec![],
    )
    .unwrap() else {
        panic!("accepted");
    };
    chain
}

#[test]
fn this_core_takes_the_0_10_0_join_as_0_10_0_did_and_finds_the_entry_wrong_alike() {
    let f = fixture();
    let mark = JoinMark { roster_version: 2, code: code(&f) };
    let chain = chain_as(&f, "newcomer", GroupAnchor::Join, Some(mark));
    assert_eq!(serde_json::json!(chain.own_entry_wrong_at()), f["joined"]["ownEntryWrongAt"]);
    assert_eq!(serde_json::json!(chain.roster_digests()), f["joined"]["rosterDigests"]);
}

#[test]
fn the_newcomer_s_device_shows_no_pair_code_over_the_planted_entry() {
    let f = fixture();
    let chain =
        chain_as(&f, "newcomer", GroupAnchor::Join, Some(JoinMark { roster_version: 2, code: code(&f) }));
    let shown = pair_code(chain, me(&f, "newcomer"), text(&f["manager"], "userId"), rosters(&f)).unwrap();
    assert_eq!(shown, PairCode::OwnEntryWrong { roster_version: 2 });
}

#[test]
fn the_organizer_s_pair_code_with_the_newcomer_is_not_the_code_0_10_0_compared() {
    let f = fixture();
    let chain = chain_as(&f, "manager", GroupAnchor::Created, None);
    let PairCode::Code { roster_version, code: words } =
        pair_code(chain, me(&f, "manager"), text(&f["newcomer"], "userId"), rosters(&f)).unwrap()
    else {
        panic!("the organizer's device has a code");
    };
    assert_eq!(roster_version, 2);
    assert_ne!(words, code(&f));
}

#[test]
fn the_one_way_path_gives_the_old_phone_its_code_and_the_organizer_s_device_nothing_to_save() {
    let f = fixture();
    let manager = me(&f, "manager");
    let group = text(&f, "groupId");
    // The organizer's device: the chain committed against its settings pin, and its first-seen
    // pin of the keys the server served as the newcomer's (how the entry was planted).
    let ledger = AreaLedger::new();
    let identity = keys_of(&f["manager"]["identity"]);
    ledger
        .open_account(
            manager.user_id.clone(),
            base64url_decode(identity.signing_public_key.clone()).unwrap(),
            vec![1; 32],
        )
        .unwrap();
    let pin = pin_after(
        vec![],
        chain_as(&f, "manager", GroupAnchor::Created, None),
        "2026-10-18T12:00:00.000Z".into(),
    )
    .unwrap();
    let planted = pin_of_served(keys_of(&f["planted"]), false).unwrap();
    let newcomer = text(&f["newcomer"], "userId");
    let contact = VerifiedPin {
        user_id: newcomer.clone(),
        key_version: planted.key_version.unwrap(),
        encryption_public_key: planted.encryption_public_key,
        signing_public_key: planted.signing_public_key,
        ml_dsa_public_key_hash: planted.ml_dsa_public_key_hash.unwrap(),
        kem_public_key_hash: planted.kem_public_key_hash.unwrap(),
        fingerprint: planted.fingerprint,
        trusted_via: None,
    };
    ledger
        .use_settings(
            manager.user_id.clone(),
            Some([(group.clone(), pin)].into()),
            [(newcomer.clone(), contact)].into(),
        )
        .unwrap();
    let served = ServedChain {
        after: 0,
        first_keys: first_keys(&f),
        rosters: rosters(&f),
        successions: vec![],
        signer_keys: signer_keys(&f),
    };
    let ServedAcceptance::Accepted { .. } = ledger
        .accept_served(
            manager.clone(),
            group.clone(),
            None,
            served,
            FamilyGuard::Absent,
            "2026-10-18T12:00:00.000Z".into(),
        )
        .unwrap()
    else {
        panic!("committed");
    };
    // The old join code, for the 0.10.0 phone: the very code it compared.
    assert_eq!(
        ledger.member_join_code(group.clone(), newcomer.clone(), rosters(&f)).unwrap(),
        MemberJoinCode::Code { roster_version: 2, code: code(&f) }
    );
    // Taken as a family check's "They match", it is no pair code: no check record, no pin.
    let matched = ledger
        .pair_match(
            manager,
            group,
            newcomer,
            rosters(&f),
            2,
            code(&f),
            GuardState::Absent,
            "2026-10-18T12:00:00.000Z".into(),
        )
        .unwrap();
    assert_eq!(matched, PairMatch { check: None, pin: None });
}
