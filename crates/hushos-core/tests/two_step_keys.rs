//! A passkey or security key as the second step, held to the fixture the web is held to
//! (`fixtures/two-step-keys.json`, read too by
//! `apps/web/src/lib/api/two-step-keys-fixture.test.ts`): what a phone asks a key, and
//! what it sends the server, are what a browser asks and sends for the same reply and
//! the same key, and the server's schemas take it whole.

use hushos_core::*;
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/two-step-keys.json")).expect("the fixture is JSON")
}

fn text(value: &Value) -> String {
    value.as_str().expect("a string").to_string()
}

#[test]
fn the_step_is_read_in_the_servers_order_and_the_key_is_asked_what_the_web_asks_it() {
    let fixture = fixture();
    let reply = serde_json::json!({ "twoStep": fixture["step"] }).to_string();
    let StepReply::Step { challenge } = sign_in_reply_read(200, reply) else { panic!("a step") };
    let names: Vec<&str> = challenge
        .methods
        .iter()
        .map(|method| match method {
            StepMethod::Webauthn => "webauthn",
            StepMethod::Totp => "totp",
            StepMethod::Backup => "backup",
            StepMethod::Phrase => "phrase",
        })
        .collect();
    let expected: Vec<&str> =
        fixture["methods"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert_eq!(names, expected);
    assert!(!challenge.default_unavailable && !challenge.withheld);
    let asked: Value = serde_json::from_str(&key_request_json(challenge.key_request.expect("a key request")))
        .expect("the request is JSON");
    assert_eq!(asked, fixture["request"]);
}

#[test]
fn the_keys_answer_is_sent_as_the_web_sends_it() {
    let fixture = fixture();
    let assertion = key_assertion_read(fixture["handedAssertion"].to_string()).expect("an assertion");
    let sent: Value =
        serde_json::from_str(&step_answer_json(text(&fixture["token"]), StepProof::Webauthn { assertion }))
            .expect("the answer is JSON");
    assert_eq!(sent, fixture["answer"]);
}

#[test]
fn a_key_is_added_with_what_the_server_asked_and_its_registration_goes_as_the_web_sends_it() {
    let fixture = fixture();
    let KeyOptionsReply::Options { creation } = key_options_reply_read(200, fixture["options"].to_string())
    else {
        panic!("options")
    };
    let registration_token = creation.registration_token.clone();
    let asked: Value = serde_json::from_str(&key_creation_json(creation)).expect("the options are JSON");
    // What the server sent is what the key is asked, field for field (key order aside).
    assert_eq!(asked, fixture["options"]["options"]);
    let registration =
        key_registration_read(fixture["handedRegistration"].to_string()).expect("a registration");
    let body: Value = serde_json::from_str(&key_registration_json(
        registration_token,
        Some(text(&fixture["registrationName"])),
        registration,
    ))
    .expect("the body is JSON");
    assert_eq!(body, fixture["registrationBody"]);
}
