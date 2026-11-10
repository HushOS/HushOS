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
        // A cache the bindings cannot even hold is refused at the boundary, before any rule.
        if input.raw_cache.is_some() {
            continue;
        }
        let error = accept_rosters(
            GROUP.into(),
            input.first_keys.clone(),
            input.anchor,
            input.pins.clone(),
            input.rosters.clone(),
            input.successions.clone(),
            input.ml_dsa_keys.clone(),
            input.me.clone(),
            input.cache.clone(),
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
    assert!(items.len() >= 45);
    // Among them: seals whose sealer has since moved to keys with no link to the ones that
    // signed them still open, as nobody's word; and the sealing side refuses a personal key.
    for (name, said) in [
        ("folder-key-at-creation-after-the-sealers-keys-changed", "unattributed:"),
        ("previous-envelope-2-after-the-sealers-keys-changed", "unattributed:"),
        ("folder-key-signed-under-keys-the-entry-took-later", "refused"),
        ("sealing-a-personal-workspaces-key", "refused"),
        ("sealing-a-folders-key", "sealed"),
    ] {
        let item = items.iter().find(|item| s(item, "name") == name).unwrap_or_else(|| panic!("{name}"));
        assert!(item["expected"].as_str().unwrap().starts_with(said), "{name}");
    }
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
    assert_eq!((fields.custody, fields.heads.area_count), (chain.roster().org.unwrap().custody, 2));
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
    // An Admin's keys change on their own roster or an Owner's (rule 8); a fellow Admin's roster
    // cannot carry it.
    let (_, members) = moved(&admin);
    assert_eq!(
        build(&members, &admin2, vec![]).expect_err("a fellow Admin").to_string(),
        "Only an owner, or the member themselves, changes the keys of someone who signs member lists."
    );
    assert!(build(&members, &admin, vec![]).is_ok());
    assert!(build(&members, &owner, vec![]).is_ok());
}

#[test]
fn giving_members_or_recovery_to_someone_on_the_list_needs_a_check_of_the_keys_their_entry_names() {
    let chain = company_of_seven();
    let (owner, admin, member, biller) = (person(1), person(3), person(4), person(6));
    let with_roles = |roles: &[GroupRole]| -> Vec<RosterMember> {
        let mut members = chain.roster().members;
        members.iter_mut().find(|entry| entry.user_id == member.user_id).unwrap().roles = roles.to_vec();
        members
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
        "Giving someone the member list or the recovery kit needs a fresh words check of their keys.";
    let refused = |result: CoreResult<Roster>| result.expect_err("unchecked").to_string();
    let as_admin = with_roles(&[GroupRole::DataAdmin, GroupRole::Members]);
    let as_holder = with_roles(&[GroupRole::Recovery]);
    let pin = verified_pin(&member);
    // Making a Member an Admin, or a kit holder: refused without the signer's verified pin of them.
    assert_eq!(refused(build(&as_admin, &admin, vec![])), needs_check);
    assert_eq!(refused(build(&as_holder, &owner, vec![])), needs_check);
    for other in [
        verified_pin(&biller),
        VerifiedPin { fingerprint: String::new(), ..pin.clone() },
        VerifiedPin { trusted_via: Some(GROUP.into()), ..pin.clone() },
    ] {
        assert_eq!(refused(build(&as_admin, &admin, vec![other])), needs_check);
    }
    assert!(build(&as_admin, &admin, vec![pin.clone()]).is_ok());
    assert!(build(&as_holder, &owner, vec![pin.clone()]).is_ok());
    // A role that opens nothing needs none.
    assert!(build(&with_roles(&[GroupRole::Billing]), &admin, vec![]).is_ok());
    // Plant, then promote, on one roster the chain itself refuses (rule 8); the device's check
    // refuses first, since a check of the real person does not cover the keys now in the entry.
    let mut planted = as_admin.clone();
    let entry = planted.iter_mut().find(|entry| entry.user_id == member.user_id).unwrap();
    let other = person(7).entry(&[], 3, MemberStatus::Active);
    entry.encryption_public_key = other.encryption_public_key;
    entry.signing_public_key = other.signing_public_key;
    entry.ml_dsa_public_key_digest = other.ml_dsa_public_key_digest;
    entry.kem_public_key_digest = other.kem_public_key_digest;
    assert_eq!(refused(build(&planted, &owner, vec![pin])), needs_check);
}
