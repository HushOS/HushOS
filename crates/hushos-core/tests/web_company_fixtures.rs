//! A company's rosters, seals and verdicts as the web makes them
//! (`fixtures/web-company.json`, from
//! `packages/crypto/scripts/company-fixtures.ts`), judged and opened here: the
//! histories that keep or break each acceptance rule of
//! docs/companies-design.md 2.1, with the web's full verdict; the company
//! key, the kit and a folder's notice keys from the web's seeds; and every
//! seal of a company's life, with a few a hostile client made.

mod common;

use common::company::*;
use common::groups::*;
use hushos_core::*;
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/web-company.json")).expect("the fixture is JSON")
}

#[test]
fn the_web_s_company_histories_are_judged_here_as_the_web_judged_them() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().unwrap();
    // Every rule has a history it passes and one it refuses, and both twins say the same of each:
    // the whole verdict for an accepted one (the chain, its cache and its company record).
    assert!(cases.len() > 100);
    let mut refused = 0;
    for case in cases {
        let (name, input, expected) = case_from(case);
        assert_eq!(judge(&input), expected, "{name}");
        if expected["status"] == json!("refused") {
            refused += 1;
        }
    }
    assert!(refused > 50 && cases.len() - refused > 30);
}

#[test]
fn each_refused_history_is_refused_here_by_the_rule_the_web_named() {
    let fixture = fixture();
    for case in fixture["cases"].as_array().unwrap() {
        let Some(refusal) = case["refusal"].as_str() else {
            continue;
        };
        let (name, input, _) = case_from(case);
        let error = accept_rosters(
            GROUP.into(),
            input.first_keys.clone(),
            input.anchor,
            input.pins.clone(),
            input.rosters.clone(),
            input.successions.clone(),
            input.ml_dsa_keys.clone(),
            input.me.clone(),
            None,
        )
        .expect_err(&name);
        assert_eq!(error.to_string(), refusal, "{name}");
    }
}

#[test]
fn the_company_key_the_kit_and_the_notice_keys_derive_here_as_on_the_web() {
    let fixture = fixture();
    let (theirs, ours) = (&fixture["keys"], company_keys());
    assert_eq!(theirs["custody"], ours["custody"]);
    assert_eq!(theirs["kits"], ours["kits"]);
    for field in ["areaKey", "workspaceId", "seed", "publicKey", "next", "ctx"] {
        assert_eq!(theirs["notice"][field], ours["notice"][field], "{field}");
    }
    // The web's wrapped previous notice seed (its own nonce) opens here to the seed before, and
    // under nothing else.
    let notice = &theirs["notice"];
    let ctx = PreviousNoticeSeedContext {
        group_id: GROUP.into(),
        workspace_id: AREA.into(),
        to_version: 2,
        from_version: 1,
    };
    let opened = previous_notice_seed_open(b(notice, "wrapped"), b(notice, "next"), ctx.clone()).unwrap();
    assert_eq!(opened, b(notice, "seed"));
    assert!(previous_notice_seed_open(b(notice, "wrapped"), b(notice, "seed"), ctx.clone()).is_err());
    let other = PreviousNoticeSeedContext { workspace_id: SECOND_AREA.into(), ..ctx };
    assert!(previous_notice_seed_open(b(notice, "wrapped"), b(notice, "next"), other).is_err());
}

#[test]
fn the_web_s_company_seals_open_or_are_refused_here_as_on_the_web() {
    let fixture = fixture();
    let (_, input, _) =
        case_from(&json!({ "name": "seals", "input": fixture["seals"]["history"], "expected": null }));
    let chain_at = |through: u64| chain_through(&input, through);
    let items = fixture["seals"]["items"].as_array().unwrap();
    assert!(items.len() >= 18);
    for item in items {
        assert_eq!(seal_item_verdict(item, &chain_at), item["expected"], "{}", s(item, "name"));
    }
    // A kit seal the web made checks here only because both twins make the same bytes from the
    // same coins: one byte of it moved, and the same proof no longer proves it.
    let kit = items.iter().find(|item| s(item, "name") == "kit-seal-at-creation").unwrap();
    let mut moved = kit.clone();
    let mut envelope = b(kit, "envelope");
    envelope[200] ^= 1;
    moved["envelope"] = json!(e(&envelope));
    assert_eq!(seal_item_verdict(&moved, &chain_at)["check"], json!("refused"));
}

/* A verified pin of a testkit person's keys, as comparing words with them writes it. */
fn verified_pin(who: &Person) -> VerifiedPin {
    let key = |text: &str| base64url_decode(text.to_string()).unwrap();
    VerifiedPin {
        user_id: who.user_id.clone(),
        key_version: who.served.key_version,
        encryption_public_key: who.served.encryption_public_key.clone(),
        signing_public_key: who.served.signing_public_key.clone(),
        ml_dsa_public_key_hash: key_digest(who.ml_dsa()),
        kem_public_key_hash: key_digest(who.kem()),
        fingerprint: identity_fingerprint_of_keys(
            key(&who.served.encryption_public_key),
            key(&who.served.signing_public_key),
            who.ml_dsa(),
            who.kem(),
        )
        .unwrap(),
        trusted_via: None,
    }
}

/* The company of the seal fixtures after roster 2: two Owners, two Admins, a Member, a kit holder, a Billing holder. */
fn company_of_seven() -> std::sync::Arc<AcceptedRosters> {
    let fixture = fixture();
    let (_, input, _) =
        case_from(&json!({ "name": "seals", "input": fixture["seals"]["history"], "expected": null }));
    chain_through(&input, 2)
}

fn heads(
    custody_key: Option<CustodyPublicKey>,
    kit: Option<KitPublicKeys>,
    checked: Vec<VerifiedPin>,
) -> NextOrgRoster {
    NextOrgRoster { custody_key, kit, rules: None, auto_utc_day: None, heads_digest: heads_digest(), checked }
}

#[test]
fn company_roster_next_refuses_what_acceptance_refuses_before_anyone_signs() {
    let chain = company_of_seven();
    let (owner, admin, admin2, keeper) = (person(1), person(3), person(8), person(5));
    let with = |user_id: &str, change: &dyn Fn(&mut RosterMember)| -> Vec<RosterMember> {
        let mut members = chain.roster().members;
        change(members.iter_mut().find(|entry| entry.user_id == user_id).unwrap());
        members
    };
    let next = |members: Vec<RosterMember>, signer: &Person, org: NextOrgRoster| {
        company_roster_next(chain.clone(), members, signer.user_id.clone(), None, None, org)
    };
    let refusal = |result: CoreResult<Roster>| result.expect_err("refused").to_string();
    let key = custody_public_key(custody_seed_at(2)).unwrap();
    let kit = kit_public_keys(kit_secret_at(2), GROUP.into()).unwrap();
    // No entry changed: `same`, the key and kit kept, the folder counted.
    let same = next(chain.roster().members, &admin, heads(None, None, vec![])).unwrap();
    let fields = same.org.unwrap();
    assert_eq!(fields.members_same, Some(roster_members_digest(chain.roster()).unwrap()));
    assert_eq!((fields.custody, fields.heads.area_count), (chain.roster().org.unwrap().custody, 1));
    // Dropping a data admin needs a new company key (rule 2), and that key an Owner (rule 12).
    let demoted = with(&admin2.user_id, &|entry| entry.roles = vec![]);
    assert_eq!(
        refusal(next(demoted.clone(), &owner, heads(None, None, vec![]))),
        "A roster that removes a data admin replaces the company key."
    );
    assert_eq!(
        refusal(next(demoted.clone(), &admin, heads(Some(key.clone()), None, vec![]))),
        "Only an owner can replace the company’s keys."
    );
    let replaced = next(demoted, &owner, heads(Some(key.clone()), None, vec![])).unwrap();
    assert_eq!(replaced.org.unwrap().custody.custody_key_version, 2);
    // Taking `recovery` needs a new kit, and a new kit a new company key (rule 7); an Admin signs neither (rule 8).
    let taken = with(&keeper.user_id, &|entry| entry.roles = vec![]);
    assert_eq!(
        refusal(next(taken.clone(), &owner, heads(None, None, vec![]))),
        "A roster that takes the recovery kit from someone replaces the kit."
    );
    assert_eq!(
        refusal(next(taken.clone(), &owner, heads(None, Some(kit.clone()), vec![]))),
        "A new recovery kit needs a new company key."
    );
    assert_eq!(
        refusal(next(taken.clone(), &admin, heads(Some(key.clone()), Some(kit.clone()), vec![]))),
        "Only an owner can change an owner, the recovery kit or its holders."
    );
    assert!(next(taken, &owner, heads(Some(key), Some(kit), vec![])).is_ok());
    // A family's builder builds no company roster, and a company's chain takes no family format.
    assert!(
        roster_next(chain.clone(), chain.roster().members, admin.user_id.clone(), None, None, None).is_err()
    );
    assert!(roster_next(chain.clone(), chain.roster().members, admin.user_id, None, None, Some(2)).is_err());
    // An automatic admission where the rules are off.
    let mut admitted = chain.roster().members;
    admitted.push(person(7).entry(&[], 3, MemberStatus::Active));
    let auto = NextOrgRoster { auto_utc_day: Some("2026-11-10".into()), ..heads(None, None, vec![]) };
    assert_eq!(
        refusal(next(admitted, &person(3), auto)),
        "This is not an automatic admission the company’s rules allow."
    );
}

#[test]
fn a_guarded_fold_in_needs_the_signers_fresh_check_and_the_persons_own_roster_needs_none() {
    let chain = company_of_seven();
    let (owner, second, keeper, admin, admin2) = (person(1), person(2), person(5), person(3), person(8));
    // Each person's next identity, written into their entry as a fold-in would.
    let moved = |who: &Person| -> (Person, Vec<RosterMember>) {
        let next = person_at(who.n, 2);
        let mut members = chain.roster().members;
        let entry = members.iter_mut().find(|entry| entry.user_id == who.user_id).unwrap();
        let roles = entry.roles.clone();
        *entry = next.entry(&roles, 3, MemberStatus::Active);
        (next, members)
    };
    let build = |members: &[RosterMember], signer: &Person, checked: Vec<VerifiedPin>| {
        company_roster_next(
            chain.clone(),
            members.to_vec(),
            signer.user_id.clone(),
            None,
            None,
            heads(None, None, checked),
        )
    };
    let needs_check =
        "An owner’s or kit holder’s new keys need a fresh words check before they are folded in.";
    for who in [&second, &keeper] {
        let (next, members) = moved(who);
        // Another Owner's device does not follow new keys into the entry on a link alone.
        assert_eq!(build(&members, &owner, vec![]).expect_err("unchecked").to_string(), needs_check);
        // Nor with a check of the old keys, a first-seen pin, a pin through a group, or someone else's.
        let fresh = verified_pin(&next);
        for pin in [
            verified_pin(who),
            VerifiedPin { fingerprint: String::new(), ..fresh.clone() },
            VerifiedPin { trusted_via: Some(GROUP.into()), ..fresh.clone() },
            verified_pin(&owner),
            VerifiedPin { key_version: 1, ..fresh.clone() },
        ] {
            assert_eq!(
                build(&members, &owner, vec![pin]).expect_err("not this check").to_string(),
                needs_check
            );
        }
        // With the signer's verified pin of the new keys it is built.
        let built = build(&members, &owner, vec![fresh]).unwrap();
        assert_eq!(built.members.iter().find(|entry| entry.user_id == who.user_id).unwrap().key_version, 2);
    }
    // The person's own roster needs no check: they sign under the keys their entry named before.
    let (_, members) = moved(&second);
    assert!(build(&members, &second, vec![]).is_ok());
    // An Admin's entry is not guarded: any holder folds it in.
    let (_, members) = moved(&admin);
    assert!(build(&members, &admin2, vec![]).is_ok());
}
