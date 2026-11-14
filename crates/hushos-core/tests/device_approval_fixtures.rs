//! Approving on another device, held to the web's construction
//! (`fixtures/web-device-approval.json`, made by
//! `packages/crypto/scripts/device-approval-fixtures.ts`): from the same inputs this core
//! must make the same commitment, show the same code, build the same statement and read
//! the same QR text, and the web's signature must verify here. A phone that asks and a
//! browser that approves (or the other way round) only ever agree if these do.

use hushos_core::*;
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/web-device-approval.json")).expect("the fixture is JSON")
}

fn s(case: &Value, key: &str) -> String {
    case[key].as_str().unwrap_or_else(|| panic!("{key} is a string")).to_string()
}

fn step_of(case: &Value) -> DeviceStep {
    DeviceStep {
        user_id: s(case, "userId"),
        request_id: s(case, "requestId"),
        purpose: s(case, "purpose"),
        token_digest: s(case, "tokenDigest"),
        device_signing_key: s(case, "deviceSigningKey"),
    }
}

#[test]
fn the_core_builds_what_the_web_built() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().expect("cases");
    assert!(cases.len() >= 7, "a case for each purpose");
    for case in cases {
        let purpose = s(case, "purpose");
        assert_eq!(step_token_digest(s(case, "stepToken")), s(case, "tokenDigest"), "{purpose}");
        assert_eq!(
            device_step_commitment(
                purpose.clone(),
                s(case, "tokenDigest"),
                s(case, "deviceSigningKey"),
                s(case, "nonce"),
            )
            .unwrap(),
            s(case, "commitment"),
            "{purpose}"
        );
        assert_eq!(
            device_step_code(step_of(case), s(case, "approverKey"), s(case, "nonce")).unwrap(),
            s(case, "code"),
            "{purpose}"
        );
        assert_eq!(
            base64url_encode(device_step_statement(step_of(case)).unwrap()),
            s(case, "statement"),
            "{purpose}"
        );
        assert_eq!(
            approval_qr(s(case, "requestId"), s(case, "commitment")).unwrap(),
            s(case, "qr"),
            "{purpose}"
        );
        let read = approval_qr_read(s(case, "qr")).expect("a QR text");
        assert_eq!((read.request_id, read.commitment), (s(case, "requestId"), s(case, "commitment")));
    }
}

#[test]
fn the_webs_approval_verifies_here_for_its_own_request_only() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().expect("cases");
    for (index, case) in cases.iter().enumerate() {
        let approver = &case["approver"];
        let key = base64url_decode(s(approver, "publicKey")).unwrap();
        let signature = base64url_decode(s(approver, "signature")).unwrap();
        assert!(device_step_verify(key.clone(), step_of(case), signature.clone()), "{}", s(case, "purpose"));
        // The same signature over the next case's request (another purpose, token and device).
        let other = &cases[(index + 1) % cases.len()];
        assert!(!device_step_verify(key.clone(), step_of(other), signature.clone()));
        // And over this request with only its purpose changed.
        let mut repurposed = step_of(case);
        repurposed.purpose = s(other, "purpose");
        assert!(!device_step_verify(key, repurposed, signature));
    }
}

#[test]
fn a_commitment_binds_the_purpose_the_token_the_key_and_the_nonce() {
    let fixture = fixture();
    let case = &fixture["cases"][0];
    let made = |purpose: String, digest: String, key: String, nonce: String| {
        device_step_commitment(purpose, digest, key, nonce).unwrap()
    };
    let (purpose, digest, key, nonce) =
        (s(case, "purpose"), s(case, "tokenDigest"), s(case, "deviceSigningKey"), s(case, "nonce"));
    let other = &fixture["cases"][1];
    let committed = s(case, "commitment");
    assert_ne!(made(s(other, "purpose"), digest.clone(), key.clone(), nonce.clone()), committed);
    assert_ne!(made(purpose.clone(), s(other, "tokenDigest"), key.clone(), nonce.clone()), committed);
    assert_ne!(made(purpose.clone(), digest.clone(), s(other, "deviceSigningKey"), nonce.clone()), committed);
    assert_ne!(made(purpose, digest, key, s(other, "nonce")), committed);
}
