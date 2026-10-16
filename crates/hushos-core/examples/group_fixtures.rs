//! The group statements, signatures and seals as the Rust core makes them, for
//! the web to rebuild byte for byte and open, the mirror of
//! `packages/crypto/scripts/group-fixtures.ts`. Writes
//! `packages/crypto/src/__fixtures__/core-groups.json`; `bun run fixtures` at
//! the repository root runs both directions. Keys come from the same fixed
//! seeds as the web's; signatures and seals differ on every run.

#[path = "../tests/common/groups.rs"]
mod groups;

use groups::*;
use hushos_core::*;
use serde_json::json;
use std::fs;
use std::path::PathBuf;

/* The history the web's fixture tells: created (1), a holder admitted (2) and gone (3), the key replaced, (4). */
fn main() {
    let people: Vec<Person> = (1..=4).map(person).collect();
    let (organizer, adult, holder, child) = (&people[0], &people[1], &people[2], &people[3]);
    let owner = organizer.entry(
        &[GroupRole::Billing, GroupRole::Guardian, GroupRole::Members],
        1,
        MemberStatus::Active,
    );
    let base =
        vec![owner, adult.entry(&[], 1, MemberStatus::Active), child.entry(&[], 1, MemberStatus::Active)];
    let gone = holder.entry(&[GroupRole::Members], 3, MemberStatus::Left);
    let mut rosters: Vec<(Roster, SignedGroupStatement)> = vec![];
    // Area rows as the web's history writes them: AREA created on roster 1, rotated to version 2 by
    // the holder's removal at 3 (a family's removal rotates every area), none otherwise.
    let mut sign_next = |members: Vec<RosterMember>, key_version: u64, areas: Vec<RosterArea>| {
        let previous =
            rosters.last().map(|(_, signed)| roster_digest(signed.statement.clone())).unwrap_or_default();
        let mut members = members;
        members.sort_by(|a, b| a.user_id.cmp(&b.user_id));
        let roster = Roster {
            group_id: GROUP.into(),
            kind: GroupKind::Family,
            roster_version: rosters.len() as u64 + 1,
            previous_roster_digest: previous,
            group_key_version: key_version,
            signer_user_id: organizer.user_id.clone(),
            members,
            areas,
        };
        let signed =
            roster_sign(roster.clone(), group_seed(key_version as u8), organizer.keys.clone()).unwrap();
        rosters.push((roster, signed));
        rosters.last().unwrap().1.statement.clone()
    };
    sign_next(base.clone(), 1, standard_areas());
    sign_next(
        [base.clone(), vec![holder.entry(&[GroupRole::Members], 2, MemberStatus::Active)]].concat(),
        1,
        vec![],
    );
    let third = sign_next([base.clone(), vec![gone.clone()]].concat(), 1, vec![area_row(AREA, 2)]);
    let (old, new) = (group_public_key(group_seed(1)).unwrap(), group_public_key(group_seed(2)).unwrap());
    let succession = group_succession_sign(
        GroupKeySuccession {
            group_id: GROUP.into(),
            old_version: 1,
            new_version: 2,
            old_ed25519_public_key: old.ed25519_public_key.clone(),
            old_ml_dsa_public_key: old.ml_dsa_public_key.clone(),
            new_ed25519_public_key: new.ed25519_public_key.clone(),
            new_ml_dsa_public_key: new.ml_dsa_public_key.clone(),
            last_roster_version: 3,
            last_roster_digest: roster_digest(third),
            signer_user_id: organizer.user_id.clone(),
        },
        group_seed(1),
        organizer.keys.clone(),
    )
    .unwrap();
    sign_next([base, vec![gone]].concat(), 2, vec![]);

    let RosterChain::Accepted { chain } = accept_rosters(
        GROUP.into(),
        old.clone(),
        true,
        vec![],
        rosters.iter().map(|(_, signed)| signed.clone()).collect(),
        vec![succession.clone()],
        served_ml_dsa(&people.iter().collect::<Vec<_>>()),
        reader(),
        None,
    )
    .unwrap() else {
        panic!("the core accepts its own history");
    };

    let key_seal_ctx = GroupKeySealContext {
        group_id: GROUP.into(),
        group_key_version: 2,
        holder_user_id: organizer.user_id.clone(),
        holder_key_version: 1,
        sealer_user_id: organizer.user_id.clone(),
        roster_version: chain.roster().roster_version,
        roster_digest: chain.roster_digest(),
    };
    let key_seal = group_key_seal(
        group_seed(2),
        key_seal_ctx.clone(),
        chain.clone(),
        organizer.kem(),
        organizer.keys.clone(),
    )
    .unwrap();
    let workspace_key = pattern(32, 77);
    let grant_ctx = AreaGrantContext {
        group_id: GROUP.into(),
        workspace_id: AREA.into(),
        // Version 1, which roster 1 lists: an earlier version still grants (the removal at 3
        // rotated the area to 2).
        workspace_key_version: 1,
        grantee_user_id: adult.user_id.clone(),
        grantee_key_version: 1,
        granter_user_id: organizer.user_id.clone(),
        roster_version: chain.roster().roster_version,
        roster_digest: chain.roster_digest(),
    };
    let grant = area_grant_seal(
        workspace_key.clone(),
        grant_ctx.clone(),
        chain.clone(),
        AREA_SEED.into(),
        adult.kem(),
        organizer.keys.clone(),
    )
    .unwrap();
    let associated = |statement: Vec<u8>| e(&statement_without_digest(&statement));
    let signed_part = |envelope: &[u8]| envelope[..envelope.len() - 3373].to_vec();

    let record = MetadataStatement {
        workspace_id: AREA.into(),
        node_id: NODE.into(),
        kind: NodeKind::File,
        metadata_version: 1,
    };
    let envelope = pattern(96, 5);
    let record_by = |who: &Person, verdict: &str| {
        json!({
            "writerUserId": who.user_id,
            "signature": e(&metadata_sign(who.keys.signing_seed.to_vec(), record.clone(), envelope.clone()).unwrap()),
            "verdict": verdict,
        })
    };

    let mut ids = vec![];
    for (k, (name, kind)) in [("group", IdKind::Group), ("workspace", IdKind::Workspace)].iter().enumerate() {
        for (scope_index, scope_id) in [organizer.user_id.as_str(), GROUP].iter().enumerate() {
            let seed = e(&pattern(16, 40 + (k * 2 + scope_index) as u8));
            let id = derive_id(*kind, scope_id.to_string(), seed.clone()).unwrap();
            ids.push(json!({ "kind": name, "scopeId": scope_id, "seed": seed, "id": id }));
        }
    }

    let group_keys: Vec<_> = [1u8, 2]
        .iter()
        .map(|v| {
            let key = group_public_key(group_seed(*v)).unwrap();
            json!({ "seed": e(&group_seed(*v)), "ed25519PublicKey": key.ed25519_public_key, "mlDsaPublicKey": key.ml_dsa_public_key })
        })
        .collect();
    // Histories the web must judge as the core does: the core's own verdict first.
    let cases: Vec<_> = group_cases()
        .into_iter()
        .map(|(name, input, expected)| {
            // The full verdict (history, cache, own entry, key digest, the record's and the rest) is
            // what the web must match.
            let verdict = judge(&input);
            assert!(says(&verdict, &expected), "{name}: the core says {verdict}");
            case_json(name, &input, &verdict)
        })
        .collect();
    // Which entries fold in: a forged link changes nothing; a genuine one on its version 2 signature
    // alone does (r9: fold-in walks from the entry's keys, where consent buys nothing).
    let folds =
        [("two-ahead", true), ("forged-link", false), ("one-sided-link", true), ("inflated-version", true)];
    let fold_ins: Vec<_> = fold_in_cases()
        .iter()
        .map(|c| {
            let verdict = fold_in_verdict(c);
            let wanted = folds.iter().find(|(name, _)| *name == c.name).map(|(_, f)| *f);
            assert_eq!(verdict["changed"].as_bool(), wanted, "{}: the core folds it wrongly", c.name);
            fold_in_json(c, &verdict)
        })
        .collect();
    // A key seal the adult made while a holder, before their next identity was folded in.
    let folded = {
        let owner = organizer.entry(
            &[GroupRole::Billing, GroupRole::Guardian, GroupRole::Members],
            1,
            MemberStatus::Active,
        );
        let (adult2, link) = succeed(adult);
        let mut h = History::new();
        h.roster(
            organizer,
            vec![owner.clone(), adult.entry(&[GroupRole::Members], 1, MemberStatus::Active)],
            None,
        );
        let before = accepted_of(&h, &[organizer, adult]);
        let ctx = GroupKeySealContext {
            group_id: GROUP.into(),
            group_key_version: 1,
            holder_user_id: organizer.user_id.clone(),
            holder_key_version: 1,
            sealer_user_id: adult.user_id.clone(),
            roster_version: before.roster().roster_version,
            roster_digest: before.roster_digest(),
        };
        let envelope =
            group_key_seal(group_seed(1), ctx.clone(), before, organizer.kem(), adult.keys.clone()).unwrap();
        h.roster(organizer, vec![owner, adult2.entry(&[GroupRole::Members], 2, MemberStatus::Active)], None);
        json!({
            "rosters": h.rosters.iter().map(signed_json).collect::<Vec<_>>(),
            "ctx": key_seal_ctx_json(&ctx),
            "seed": e(&group_seed(1)),
            "envelope": e(&envelope),
            "links": [link_json(&link)],
        })
    };
    let out = json!({
        "generatedBy": "crates/hushos-core/examples/group_fixtures.rs",
        "groupId": GROUP,
        "people": people.iter().map(|p| json!({
            "n": p.n,
            "userId": p.user_id,
            "served": {
                "keyVersion": p.served.key_version, "encryptionPublicKey": p.served.encryption_public_key,
                "signingPublicKey": p.served.signing_public_key, "mlDsaPublicKey": p.served.ml_dsa_public_key,
                "kemPublicKey": p.served.kem_public_key, "keysSignature": p.served.keys_signature,
            },
        })).collect::<Vec<_>>(),
        "groupKeys": group_keys,
        "fingerprint": group_fingerprint(GROUP.into(), old).unwrap(),
        "rosters": rosters.iter().map(|(roster, signed)| {
            let mut value = signed_json(signed);
            value["roster"] = roster_json(roster);
            value
        }).collect::<Vec<_>>(),
        "successions": [signed_json(&succession)],
        "accepted": {
            "rosterVersion": chain.roster().roster_version,
            "rosterDigest": chain.roster_digest(),
            "groupKeyVersion": chain.group_key_version(),
            "groupKeyDigest": chain.group_key_digest(),
            "creatorUserId": chain.creator_user_id(),
            "successionDue": chain.succession_due(),
        },
        "seals": {
            "keySeal": {
                "ctx": key_seal_ctx_json(&key_seal_ctx),
                "seed": e(&group_seed(2)),
                "associatedData": associated(group_key_seal_statement(key_seal_ctx.clone(), signed_part(&key_seal)).unwrap()),
                "envelope": e(&key_seal),
            },
            "areaGrant": {
                "ctx": grant_ctx_json(&grant_ctx),
                "areaIdSeed": AREA_SEED,
                "workspaceKey": e(&workspace_key),
                "associatedData": associated(area_grant_statement(grant_ctx.clone(), signed_part(&grant)).unwrap()),
                "envelope": e(&grant),
            },
        },
        "verdicts": {
            "statement": { "workspaceId": AREA, "nodeId": NODE, "kind": "file", "metadataVersion": 1 },
            "envelope": e(&envelope),
            "records": [record_by(adult, "verified"), record_by(holder, "former-member")],
        },
        "ids": ids,
        "cases": cases,
        "foldIns": fold_ins,
        "foldedSealer": folded,
        "sealerCases": sealer_cases()
            .iter()
            .map(|c| {
                let verdict = sealer_verdict(c);
                assert_eq!(verdict, c.expected, "{}: the core says {verdict}", c.name);
                sealer_case_json(c)
            })
            .collect::<Vec<_>>(),
        "statementCases": statement_cases()
            .iter()
            .map(|(name, bytes, expected)| {
                assert_eq!(group_statement_is_canonical(bytes.clone()), *expected, "{name}: the core disagrees");
                json!({ "name": name, "statement": e(bytes), "expected": expected })
            })
            .collect::<Vec<_>>(),
        "chainCases": chain_cases()
            .iter()
            .map(|c| {
                let verdict = chain_verdict(c);
                assert_eq!(verdict, c.expected, "{}: the core says {verdict}", c.name);
                chain_case_json(c)
            })
            .collect::<Vec<_>>(),
        "sealCases": seal_cases()
            .iter()
            .map(|c| {
                let verdict = seal_verdict(c);
                assert_eq!(verdict, c.expected, "{}: the core says {verdict}", c.name);
                seal_case_json(c)
            })
            .collect::<Vec<_>>(),
    });
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/crypto/src/__fixtures__/core-groups.json");
    fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&out).unwrap()))
        .expect("write the fixture");
    println!("wrote packages/crypto/src/__fixtures__/core-groups.json");
}
