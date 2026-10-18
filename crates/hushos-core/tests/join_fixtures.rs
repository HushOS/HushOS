//! Joining and consent (groups 1d, Core 4) against the web's run of them
//! (`fixtures/web-join.json`, written by `packages/crypto/scripts/join-fixtures.ts`):
//! every join preview the web ran, over the histories it signed and the
//! records its worker sealed, reaches here the outcome it reached there; the
//! typed-words checks agree with the shared cases; the links the web offered
//! for consent are the ones offered here, its consent signs and refuses here
//! as there, and every consent the web signed holds here. The other direction
//! is `packages/crypto/src/join-fixtures.test.ts`. Regenerate both with
//! `bun run fixtures:groups`.

mod common;

use common::join::*;
use serde_json::{json, Value};

fn web() -> Value {
    serde_json::from_str(include_str!("../fixtures/web-join.json")).expect("fixtures/web-join.json is JSON")
}

#[test]
fn every_join_preview_the_web_ran_reaches_here_what_it_reached_there() {
    let web = web();
    let theirs = &web["joinPreviews"];
    let ours = preview_doc();
    let cases = theirs["cases"].as_array().unwrap();
    assert_eq!(cases.len(), ours["cases"].as_array().unwrap().len(), "the web ran every case");
    let mut codes = 0;
    for (c, mine) in cases.iter().zip(ours["cases"].as_array().unwrap()) {
        assert_eq!(c["name"], mine["name"], "the same cases in the same order");
        assert_eq!(c["expected"], mine["expected"], "{}: declared alike", c["name"]);
        let outcome = run_preview(theirs, c);
        assert_eq!(outcome, c["outcome"], "{}", c["name"]);
        assert!(preview_says(&outcome, &c["expected"]), "{}: {outcome}", c["name"]);
        codes += usize::from(outcome["status"] == "code");
    }
    assert!(codes >= 8, "only {codes} codes were compared");
}

#[test]
fn every_join_session_the_web_ran_gives_here_step_by_step_what_it_gave_there() {
    let web = web();
    let file = session_scenarios();
    let runs = web["joinSessions"]["runs"].as_array().unwrap();
    let scenarios = file["scenarios"].as_array().unwrap();
    assert_eq!(runs.len(), scenarios.len(), "the web ran every scenario");
    let mut steps = 0;
    for (scenario, theirs) in scenarios.iter().zip(runs) {
        assert_eq!(scenario["name"], theirs["name"]);
        let ours = run_session(&web["joinPreviews"], scenario);
        assert_eq!(Value::Array(ours.outcomes.clone()), theirs["outcomes"], "{}", scenario["name"]);
        for (at, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            assert!(step_says(&ours.outcomes, at, &step["expect"]), "{} step {at}", scenario["name"]);
            steps += 1;
        }
    }
    assert!(steps >= 40, "only {steps} steps were compared");
}

#[test]
fn the_web_s_joins_record_joins_here_and_its_kept_escalation_holds_here() {
    let web = web();
    let cross = &web["joinSessions"]["cross"];
    let (joined, hidden) = open_cross(&web["joinPreviews"], cross);
    assert_eq!((joined["status"].as_str(), joined["rosterVersion"].as_u64()), (Some("accepted"), Some(3)));
    assert_eq!(hidden, cross["heldHidden"]);
}

#[test]
fn every_typed_words_check_agrees_with_the_web_and_the_shared_cases() {
    let web = web();
    let file = check_cases();
    let cases = file["cases"].as_array().unwrap();
    let theirs = web["joinChecks"].as_array().unwrap();
    assert_eq!(theirs.len(), cases.len());
    for (c, result) in cases.iter().zip(theirs) {
        assert_eq!(result["name"], c["name"]);
        assert_eq!(run_check(&file, c), c["expected"], "{}", c["name"]);
        assert_eq!(result["result"], c["expected"], "{}: on the web", c["name"]);
    }
}

#[test]
fn the_web_s_links_needing_consent_are_offered_here_and_its_consent_holds_here() {
    let web = web();
    let theirs = &web["consents"];
    for c in theirs["due"].as_array().unwrap() {
        let outcome = run_due(theirs, c);
        assert_eq!(outcome, c["outcome"], "{}", c["name"]);
        assert_eq!(outcome, c["expected"], "{}", c["name"]);
    }
    let mut held = 0;
    for c in theirs["signs"].as_array().unwrap() {
        let outcome = run_sign(theirs, c);
        assert!(sign_says(&outcome, &c["outcome"]), "{}: {outcome} here, {} there", c["name"], c["outcome"]);
        assert!(sign_says(&outcome, &c["expected"]), "{}: {outcome}", c["name"]);
        if let Some(consent) = c["outcome"]["consent"].as_str() {
            // The web's consent over the web's identities, and this core's over the same.
            assert!(consent_holds(theirs, c, consent), "{}: the web's consent holds here", c["name"]);
            assert!(consent_holds(theirs, c, outcome["consent"].as_str().unwrap()), "{}", c["name"]);
            let mut flipped = hushos_core::base64url_decode(consent.into()).unwrap();
            flipped[4000] ^= 1;
            assert!(!consent_holds(theirs, c, &hushos_core::base64url_encode(flipped)), "{}", c["name"]);
            held += 1;
        }
    }
    assert!(held >= 2, "only {held} consents were checked");
    assert_eq!(theirs["userId"], json!(CONSENT_USER));
}
