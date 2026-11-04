//! The group statements, signatures and seals the web made
//! (`packages/crypto/scripts/group-fixtures.ts`) must rebuild here byte for
//! byte, verify, and open. The other direction is
//! `packages/crypto/src/group-fixtures.test.ts`. Regenerate both with
//! `bun run fixtures`.

mod common;

use common::groups::*;
use hushos_core::*;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/web-groups.json"))
        .expect("fixtures/web-groups.json is JSON")
}

fn people() -> Vec<Person> {
    (1..=4).map(person).collect()
}

fn accepted(fixture: &Value) -> Arc<AcceptedRosters> {
    let people = people();
    let first = &fixture["groupKeys"][0];
    let chain = accept_rosters(
        GROUP.into(),
        GroupPublicKey {
            ed25519_public_key: s(first, "ed25519PublicKey"),
            ml_dsa_public_key: s(first, "mlDsaPublicKey"),
        },
        Some(GroupAnchor::Created),
        vec![],
        fixture["rosters"].as_array().unwrap().iter().map(signed_of).collect(),
        fixture["successions"].as_array().unwrap().iter().map(signed_of).collect(),
        served_ml_dsa(&people.iter().collect::<Vec<_>>()),
        reader(),
        None,
    )
    .expect("the web's history verifies here");
    match chain {
        RosterChain::Accepted { chain } => chain,
        fork => panic!("the web's history forked: {fork:?}"),
    }
}

#[test]
fn every_person_s_keys_derive_here_from_the_web_s_seeds_and_their_keys_statements_hold() {
    let fixture = fixture();
    let people = people();
    for (made, theirs) in people.iter().zip(fixture["people"].as_array().unwrap()) {
        assert_eq!(made.user_id, s(theirs, "userId"));
        let served = &theirs["served"];
        assert_eq!(made.served.encryption_public_key, s(served, "encryptionPublicKey"));
        assert_eq!(made.served.signing_public_key, s(served, "signingPublicKey"));
        assert_eq!(made.served.ml_dsa_public_key, s(served, "mlDsaPublicKey"));
        assert_eq!(made.served.kem_public_key, s(served, "kemPublicKey"));
        let web = PublicIdentity { keys_signature: s(served, "keysSignature"), ..made.served.clone() };
        assert!(
            identity_verify_keys(made.user_id.clone(), web.clone()),
            "the web's keys statement holds here"
        );
        assert!(!identity_verify_keys(people[(made.n as usize) % 4].user_id.clone(), web));
    }
}

#[test]
fn the_group_keys_and_the_fingerprint_are_the_web_s() {
    let fixture = fixture();
    for (version, key) in fixture["groupKeys"].as_array().unwrap().iter().enumerate() {
        assert_eq!(b(key, "seed"), group_seed(version as u8 + 1));
        let derived = group_public_key(b(key, "seed")).unwrap();
        assert_eq!(derived.ed25519_public_key, s(key, "ed25519PublicKey"));
        assert_eq!(derived.ml_dsa_public_key, s(key, "mlDsaPublicKey"));
    }
    let first = group_public_key(group_seed(1)).unwrap();
    assert_eq!(group_fingerprint(GROUP.into(), first).unwrap(), s(&fixture, "fingerprint"));
}

#[test]
fn every_roster_and_succession_rebuilds_to_the_web_s_bytes() {
    let fixture = fixture();
    let mut previous: Option<Vec<u8>> = None;
    for served in fixture["rosters"].as_array().unwrap() {
        let statement = b(served, "statement");
        let roster = roster_of(&served["roster"]);
        assert_eq!(roster_statement(roster.clone()).unwrap(), statement, "roster {}", roster.roster_version);
        assert_eq!(roster_parse(statement.clone()).unwrap(), roster);
        let expected_previous = previous.as_ref().map(|p| roster_digest(p.clone())).unwrap_or_default();
        assert_eq!(roster.previous_roster_digest, expected_previous);
        previous = Some(statement);
    }
    let keys: Vec<_> = (1..=2).map(|v| group_public_key(group_seed(v)).unwrap()).collect();
    for served in fixture["successions"].as_array().unwrap() {
        let statement = b(served, "statement");
        let succession = group_succession_parse(statement.clone()).unwrap();
        assert_eq!(group_succession_statement(succession.clone()).unwrap(), statement);
        let old = &keys[(succession.old_version - 1) as usize];
        let new = &keys[(succession.new_version - 1) as usize];
        assert_eq!(
            (&succession.old_ed25519_public_key, &succession.old_ml_dsa_public_key),
            (&old.ed25519_public_key, &old.ml_dsa_public_key)
        );
        assert_eq!(
            (&succession.new_ed25519_public_key, &succession.new_ml_dsa_public_key),
            (&new.ed25519_public_key, &new.ml_dsa_public_key)
        );
        assert!(group_verify(old.clone(), statement.clone(), signed_of(served).signature));
        assert!(!group_verify(new.clone(), statement, signed_of(served).signature));
    }
}

#[test]
fn the_web_s_history_is_accepted_here_as_the_web_accepted_it() {
    let fixture = fixture();
    let expected = &fixture["accepted"];
    let chain = accepted(&fixture);
    assert_eq!(chain.roster().roster_version, n(expected, "rosterVersion"));
    assert_eq!(chain.roster_digest(), s(expected, "rosterDigest"));
    assert_eq!(chain.group_key_version(), n(expected, "groupKeyVersion"));
    assert_eq!(chain.group_key_digest(), s(expected, "groupKeyDigest"));
    assert_eq!(chain.creator_user_id(), s(expected, "creatorUserId"));
    assert_eq!(chain.succession_due(), expected["successionDue"].as_bool().unwrap());
    // Each half of the web's group signature is needed here too.
    let mut rosters: Vec<_> = fixture["rosters"].as_array().unwrap().iter().map(signed_of).collect();
    rosters[1].signature.ml_dsa[7] ^= 1;
    let people = people();
    let refused = accept_rosters(
        GROUP.into(),
        group_public_key(group_seed(1)).unwrap(),
        Some(GroupAnchor::Created),
        vec![],
        rosters,
        fixture["successions"].as_array().unwrap().iter().map(signed_of).collect(),
        served_ml_dsa(&people.iter().collect::<Vec<_>>()),
        reader(),
        None,
    );
    assert!(refused.is_err());
}

#[test]
fn the_web_s_seals_open_here_and_their_associated_data_is_the_statement_without_its_digest() {
    let fixture = fixture();
    let people = people();
    let (organizer, adult) = (&people[0], &people[1]);
    let chain = accepted(&fixture);
    let seals = &fixture["seals"];

    let key_seal = &seals["keySeal"];
    let ctx = key_seal_ctx_of(&key_seal["ctx"]);
    let envelope = b(key_seal, "envelope");
    assert_eq!(envelope.len(), 4597);
    let signed_part = &envelope[..envelope.len() - 3373];
    let statement = group_key_seal_statement(ctx.clone(), signed_part.to_vec()).unwrap();
    assert_eq!(statement_without_digest(&statement), b(key_seal, "associatedData"));
    let seed = group_key_open(
        envelope.clone(),
        ctx.clone(),
        chain.clone(),
        organizer.ml_dsa(),
        None,
        organizer.user_id.clone(),
        organizer.keys.key_version,
        organizer.keys.clone(),
    )
    .expect("the web's key seal opens here");
    assert_eq!(seed.to_vec(), b(key_seal, "seed"));
    // Read as key version 1's seal (another context), it is not even signed for that.
    let v1 = GroupKeySealContext { group_key_version: 1, ..ctx };
    let refused = group_key_open(
        envelope,
        v1,
        chain.clone(),
        organizer.ml_dsa(),
        None,
        organizer.user_id.clone(),
        organizer.keys.key_version,
        organizer.keys.clone(),
    );
    assert_eq!(refused.unwrap_err().to_string(), "This group key was not sealed by a member who holds it.");

    let grant = &seals["areaGrant"];
    let ctx = grant_ctx_of(&grant["ctx"]);
    let envelope = b(grant, "envelope");
    let statement = area_grant_statement(ctx.clone(), envelope[..envelope.len() - 3373].to_vec()).unwrap();
    assert_eq!(statement_without_digest(&statement), b(grant, "associatedData"));
    let open = || {
        area_grant_open(
            envelope.clone(),
            ctx.clone(),
            chain.clone(),
            s(grant, "areaIdSeed"),
            organizer.ml_dsa(),
            None,
            adult.user_id.clone(),
            1,
            adult.keys.clone(),
        )
    };
    assert_eq!(open().unwrap(), b(grant, "workspaceKey"));
}

#[test]
fn the_web_s_seal_from_before_the_sealer_s_identity_was_folded_in_opens_here_through_their_chain() {
    let fixture = fixture();
    let folded = &fixture["foldedSealer"];
    let people = people();
    let (organizer, adult) = (&people[0], &people[1]);
    let (adult2, _) = succeed(adult);
    let RosterChain::Accepted { chain } = accept_rosters(
        GROUP.into(),
        group_public_key(group_seed(1)).unwrap(),
        Some(GroupAnchor::Created),
        vec![],
        folded["rosters"].as_array().unwrap().iter().map(signed_of).collect(),
        vec![],
        served_ml_dsa(&[organizer, adult]),
        reader(),
        None,
    )
    .expect("the web's history verifies here") else {
        panic!("the web's history forked");
    };
    let ctx = key_seal_ctx_of(&folded["ctx"]);
    let history = SignerHistory {
        served: served_keys(&adult2),
        links: folded["links"].as_array().unwrap().iter().map(link_of).collect(),
    };
    let open = |history: Option<SignerHistory>| {
        group_key_open(
            b(folded, "envelope"),
            ctx.clone(),
            chain.clone(),
            adult2.ml_dsa(),
            history,
            organizer.user_id.clone(),
            organizer.keys.key_version,
            organizer.keys.clone(),
        )
    };
    assert_eq!(open(Some(history)).unwrap().to_vec(), b(folded, "seed"));
    assert!(open(None).is_err());
}

#[test]
fn records_in_the_area_read_here_as_the_web_read_them() {
    let fixture = fixture();
    let verdicts = &fixture["verdicts"];
    let reading = GroupReading::Accepted { chain: accepted(&fixture) };
    let record = &verdicts["statement"];
    let statement = MetadataStatement {
        workspace_id: s(record, "workspaceId"),
        node_id: s(record, "nodeId"),
        kind: NodeKind::File,
        metadata_version: n(record, "metadataVersion"),
    };
    for written in verdicts["records"].as_array().unwrap() {
        let trust = group_writer_trust(
            GROUP.into(),
            HashMap::from([(AREA.to_string(), 1)]),
            reading.clone(),
            AREA.into(),
            s(written, "writerUserId"),
            None,
            None,
            Some(vec![]),
            None,
        );
        let verdict = group_metadata_integrity(
            trust,
            None,
            statement.clone(),
            b(verdicts, "envelope"),
            Some(b(written, "signature")),
        );
        let expected = match s(written, "verdict").as_str() {
            "verified" => GroupIntegrity { verdict: GroupVerdict::Verified, via: Some(GROUP.into()) },
            "former-member" => GroupIntegrity { verdict: GroupVerdict::FormerMember, via: None },
            other => panic!("verdict {other}"),
        };
        assert_eq!(verdict, expected);
    }
}

#[test]
fn group_and_area_ids_derive_the_web_s_known_answers() {
    let fixture = fixture();
    let ids = fixture["ids"].as_array().unwrap();
    assert_eq!(ids.len(), 4);
    for entry in ids {
        let kind = match s(entry, "kind").as_str() {
            "group" => IdKind::Group,
            "workspace" => IdKind::Workspace,
            other => panic!("kind {other}"),
        };
        assert_eq!(derive_id(kind, s(entry, "scopeId"), s(entry, "seed")).unwrap(), s(entry, "id"));
        assert!(check_id(kind, s(entry, "scopeId"), s(entry, "seed"), s(entry, "id")).is_ok());
    }
}

#[test]
fn the_web_s_histories_are_judged_here_as_the_web_judged_them() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().unwrap();
    let names: Vec<String> = cases.iter().map(|case| s(case, "name")).collect();
    let ours: Vec<String> = group_cases().into_iter().map(|(name, ..)| name.to_string()).collect();
    assert_eq!(names, ours);
    for case in cases {
        let (name, input, expected) = case_from(case);
        assert_eq!(judge(&input), expected, "{name}");
    }
}

#[test]
fn the_web_s_fold_ins_are_judged_here_as_the_web_judged_them() {
    let fixture = fixture();
    let fold_ins = fixture["foldIns"].as_array().unwrap();
    assert_eq!(
        fold_ins.iter().map(|c| s(c, "name")).collect::<Vec<_>>(),
        ["two-ahead", "forged-link", "one-sided-link", "inflated-version"]
    );
    for value in fold_ins {
        let (case, expected) = fold_in_from(value);
        assert_eq!(fold_in_verdict(&case), expected, "{}", case.name);
    }
}

#[test]
fn the_web_s_seal_cases_open_or_are_refused_here_as_the_web_judged_them() {
    let fixture = fixture();
    let cases = fixture["sealCases"].as_array().unwrap();
    let names: Vec<String> = cases.iter().map(|c| s(c, "name")).collect();
    let ours: Vec<String> = seal_cases().into_iter().map(|c| c.name).collect();
    assert_eq!(names, ours);
    for value in cases {
        let case = seal_case_from(value);
        assert_eq!(seal_verdict(&case), case.expected, "{}", case.name);
    }
}

#[test]
fn the_web_s_sealer_cases_seal_or_are_refused_here_as_the_web_judged_them() {
    let fixture = fixture();
    let cases = fixture["sealerCases"].as_array().unwrap();
    let names: Vec<String> = cases.iter().map(|c| s(c, "name")).collect();
    let ours: Vec<String> = sealer_cases().into_iter().map(|c| c.name).collect();
    assert_eq!(names, ours);
    for value in cases {
        let case = sealer_case_from(value);
        assert_eq!(sealer_verdict(&case), case.expected, "{}", case.name);
    }
}

#[test]
fn the_web_s_personal_pin_chains_hold_or_not_here_as_the_web_judged_them() {
    let fixture = fixture();
    let cases = fixture["chainCases"].as_array().unwrap();
    let names: Vec<String> = cases.iter().map(|c| s(c, "name")).collect();
    let ours: Vec<String> = chain_cases().into_iter().map(|c| c.name).collect();
    assert_eq!(names, ours);
    for value in cases {
        let case = chain_case_from(value);
        assert_eq!(chain_verdict(&case), case.expected, "{}", case.name);
    }
}

#[test]
fn the_web_s_raw_statements_parse_or_are_refused_here_as_the_web_judged_them() {
    let fixture = fixture();
    let cases = fixture["statementCases"].as_array().unwrap();
    let names: Vec<String> = cases.iter().map(|c| s(c, "name")).collect();
    let ours: Vec<String> = statement_cases().into_iter().map(|(name, _, _)| name).collect();
    assert_eq!(names, ours);
    for value in cases {
        let expected = value["expected"].as_bool().unwrap();
        assert_eq!(group_statement_is_canonical(b(value, "statement")), expected, "{}", s(value, "name"));
    }
}

#[test]
fn the_web_s_first_rosters_build_here_to_the_same_bytes_or_are_refused_as_the_web_judged_them() {
    let fixture = fixture();
    let cases = fixture["firstRosterCases"].as_array().unwrap();
    let names: Vec<String> = cases.iter().map(|c| s(c, "name")).collect();
    let ours: Vec<String> = first_roster_cases().into_iter().map(|c| c.name).collect();
    assert_eq!(names, ours);
    for value in cases {
        let (case, expected) = first_roster_case_from(value);
        assert_eq!(first_roster_verdict(&case), expected, "{}", case.name);
    }
}

#[test]
fn the_web_s_own_entries_are_made_here_or_refused_as_the_web_judged_them() {
    let fixture = fixture();
    let cases = fixture["ownEntryCases"].as_array().unwrap();
    let names: Vec<String> = cases.iter().map(|c| s(c, "name")).collect();
    let ours: Vec<String> = own_entry_cases().into_iter().map(|c| c.name).collect();
    assert_eq!(names, ours);
    for value in cases {
        let (case, expected) = own_entry_case_from(value);
        assert_eq!(own_entry_verdict(&case), expected, "{}", case.name);
    }
}
