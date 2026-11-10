//! A company for the shared company fixtures (docs/companies-design.md 2.1,
//! 2.2), the Rust twin of the web's `company-testkit.ts`: what this core says
//! of a sealed item, and the history and seals it makes for the web to judge.
//! Every key comes from the seeds the web uses (`groups.rs` beside this).
#![allow(dead_code)]

use super::groups::*;
use hushos_core::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

/* The served ML-DSA keys of the testkit's kits at `versions`, by digest, as acceptance takes them beside members'. */
pub fn kit_ml_dsa_keys(versions: &[u8]) -> HashMap<String, String> {
    versions
        .iter()
        .map(|version| {
            let kit = kit_public_keys(kit_secret_at(*version), GROUP.into()).unwrap();
            (roster_digest(base64url_decode(kit.ml_dsa_public_key.clone()).unwrap()), kit.ml_dsa_public_key)
        })
        .collect()
}

fn outcome(result: CoreResult<SealCheck>) -> String {
    match result {
        Ok(SealCheck::Opened { value }) => format!("opened:{}", e(&value)),
        Ok(SealCheck::Unattributed { value }) => format!("unattributed:{}", e(&value)),
        Ok(SealCheck::Bad { sealer_user_id }) => format!("bad:{}", sealer_user_id.unwrap_or_default()),
        Err(_) => "refused".into(),
    }
}

fn custody_seal_ctx(ctx: &Value) -> CustodySealContext {
    CustodySealContext {
        group_id: s(ctx, "groupId"),
        workspace_id: s(ctx, "workspaceId"),
        workspace_key_version: n(ctx, "workspaceKeyVersion"),
        custody_key_version: n(ctx, "custodyKeyVersion"),
        sealer_user_id: s(ctx, "sealerUserId"),
        roster_version: n(ctx, "rosterVersion"),
        roster_digest: s(ctx, "rosterDigest"),
    }
}

fn kit_seal_ctx(ctx: &Value) -> KitSealContext {
    KitSealContext {
        group_id: s(ctx, "groupId"),
        custody_key_version: n(ctx, "custodyKeyVersion"),
        kit_version: n(ctx, "kitVersion"),
        sealer_user_id: s(ctx, "sealerUserId"),
        roster_version: n(ctx, "rosterVersion"),
        roster_digest: s(ctx, "rosterDigest"),
    }
}

/*
 * What this core says of a sealed item (the web's sealItemVerdict), on the
 * chain accepted through `item.through`: `opened:<base64url>`, `bad:<sealer
 * id>`, `holds`, `verified` or `refused`; a kit seal has its check and its
 * opening.
 */
pub fn seal_item_verdict(item: &Value, chain_at: &dyn Fn(u64) -> Arc<AcceptedRosters>) -> Value {
    let chain = chain_at(n(item, "through"));
    // The sealer's identity the opener is served (1 unless said): the keys their entry named, or did not.
    let sealer = person_at(n(item, "sealer") as u8, item["sealerKeyVersion"].as_u64().unwrap_or(1) as u8);
    let sealer_key = base64url_decode(sealer.served.ml_dsa_public_key.clone()).unwrap();
    let envelope = if s(item, "kind") == "sealing" { vec![] } else { b(item, "envelope") };
    let kem = |version: u64| {
        base64url_decode(custody_public_key(custody_seed_at(version as u8)).unwrap().kem_public_key).unwrap()
    };
    let ctx = &item["ctx"];
    let custody_seed = || custody_seed_at(n(ctx, "custodyKeyVersion") as u8);
    match s(item, "kind").as_str() {
        "custody-seal" => {
            json!(outcome(custody_seal_open(
                envelope,
                custody_seal_ctx(ctx),
                chain,
                sealer_key,
                custody_seed(),
            )))
        }
        "custody-key-seal" => {
            let reader = person(n(item, "reader") as u8);
            let opened = custody_key_open(
                envelope,
                CustodyKeySealContext {
                    group_id: s(ctx, "groupId"),
                    custody_key_version: n(ctx, "custodyKeyVersion"),
                    holder_user_id: s(ctx, "holderUserId"),
                    holder_key_version: n(ctx, "holderKeyVersion"),
                    sealer_user_id: s(ctx, "sealerUserId"),
                    roster_version: n(ctx, "rosterVersion"),
                    roster_digest: s(ctx, "rosterDigest"),
                },
                chain,
                sealer_key,
                None,
                reader.user_id.clone(),
                1,
                reader.keys.clone(),
            );
            json!(opened.map_or("refused".to_string(), |seed| format!("opened:{}", e(&seed))))
        }
        "kit-seal" => {
            let ctx = kit_seal_ctx(ctx);
            let kit_version = ctx.kit_version as u8;
            let kit = kit_public_keys(kit_secret_at(kit_version), ctx.group_id.clone()).unwrap();
            let check = kit_seal_check(
                envelope.clone(),
                b(item, "proof"),
                ctx.clone(),
                chain.clone(),
                base64url_decode(kit.kem_public_key).unwrap(),
                sealer_key.clone(),
                custody_seed_at(ctx.custody_key_version as u8),
            );
            let opened = kit_seal_open(envelope, ctx, chain, sealer_key, kit_secret_at(kit_version));
            json!({
                "check": match check {
                    Ok(KitSealCheck::Holds) => "holds".to_string(),
                    Ok(KitSealCheck::Unattributed) => "holds-unattributed".into(),
                    Ok(KitSealCheck::Bad { sealer_user_id }) => format!("bad:{}", sealer_user_id.unwrap_or_default()),
                    Err(_) => "refused".into(),
                },
                "opened": opened.map_or("refused".to_string(), |seed| format!("opened:{}", e(&seed))),
            })
        }
        "key-escrow" => json!(outcome(key_escrow_open(
            envelope,
            KeyEscrowContext {
                group_id: s(ctx, "groupId"),
                group_key_version: n(ctx, "groupKeyVersion"),
                custody_key_version: n(ctx, "custodyKeyVersion"),
                sealer_user_id: s(ctx, "sealerUserId"),
                roster_version: n(ctx, "rosterVersion"),
                roster_digest: s(ctx, "rosterDigest"),
            },
            chain,
            sealer_key,
            custody_seed(),
        ))),
        "custody-previous" => json!(outcome(custody_previous_open(
            envelope,
            CustodyPreviousContext {
                group_id: s(ctx, "groupId"),
                custody_key_version: n(ctx, "custodyKeyVersion"),
                previous_version: n(ctx, "previousVersion"),
                sealer_user_id: s(ctx, "sealerUserId"),
                roster_version: n(ctx, "rosterVersion"),
                roster_digest: s(ctx, "rosterDigest"),
            },
            chain,
            sealer_key,
            custody_seed(),
        ))),
        "recovery-request" => {
            let verified = recovery_request_verify(envelope, b(item, "proof"), chain, sealer_key);
            json!(if verified.is_ok() { "verified" } else { "refused" })
        }
        // The sealing side: what this core's own sealers make, or refuse to.
        "sealing" => {
            let payload = b(item, "payload");
            let made = if s(item, "op") == "custody-seal" {
                let ctx = custody_seal_ctx(ctx);
                let to = kem(ctx.custody_key_version);
                custody_seal(payload, ctx, chain, to, sealer.keys.clone()).map(|_| ())
            } else {
                let ctx = kit_seal_ctx(ctx);
                let kit =
                    kit_public_keys(kit_secret_at(ctx.kit_version as u8), ctx.group_id.clone()).unwrap();
                let to = kem(ctx.custody_key_version);
                kit_seal(
                    payload,
                    ctx,
                    chain,
                    base64url_decode(kit.kem_public_key).unwrap(),
                    to,
                    sealer.keys.clone(),
                )
                .map(|_| ())
            };
            json!(if made.is_ok() { "sealed" } else { "refused" })
        }
        other => panic!("seal kind {other}"),
    }
}

/* The chain a history's first `through` rosters make, accepted as its creator's own device accepts it. */
pub fn chain_through(input: &CaseInput, through: u64) -> Arc<AcceptedRosters> {
    let Ok(RosterChain::Accepted { chain }) = accept_rosters(
        GROUP.into(),
        input.first_keys.clone(),
        input.anchor,
        vec![],
        input.rosters[..through as usize].to_vec(),
        input.successions.clone(),
        input.ml_dsa_keys.clone(),
        input.me.clone(),
        None,
    ) else {
        panic!("the company's chain is accepted through {through}");
    };
    chain
}

/* What both twins derive alike from fixed seeds (the web's companyKeys): this core's values for the same seeds. */
pub fn company_keys() -> Value {
    let custody: Vec<Value> = (1..=3u8)
        .map(|version| {
            let key = custody_public_key(custody_seed_at(version)).unwrap();
            json!({
                "version": version,
                "seed": e(&custody_seed_at(version)),
                "publicKey": { "encryptionPublicKey": key.encryption_public_key, "kemPublicKey": key.kem_public_key },
                "fingerprint": custody_fingerprint(GROUP.into(), version as u64, key).unwrap(),
            })
        })
        .collect();
    let kits: Vec<Value> = (1..=2u8)
        .map(|version| {
            let kit = kit_public_keys(kit_secret_at(version), GROUP.into()).unwrap();
            json!({
                "version": version,
                "secret": e(&kit_secret_at(version)),
                "publicKeys": {
                    "encryptionPublicKey": kit.encryption_public_key,
                    "kemPublicKey": kit.kem_public_key,
                    "signingPublicKey": kit.signing_public_key,
                    "mlDsaPublicKey": kit.ml_dsa_public_key,
                },
            })
        })
        .collect();
    let before = notice_seed(area_key_at(AREA, 1), GROUP.into(), AREA.into()).unwrap();
    let after = notice_seed(area_key_at(AREA, 2), GROUP.into(), AREA.into()).unwrap();
    let keys = notice_public_keys(before.to_vec()).unwrap();
    let ctx = PreviousNoticeSeedContext {
        group_id: GROUP.into(),
        workspace_id: AREA.into(),
        to_version: 2,
        from_version: 1,
    };
    json!({
        "custody": custody,
        "kits": kits,
        "notice": {
            "areaKey": e(&area_key_at(AREA, 1)),
            "workspaceId": AREA,
            "seed": e(&before),
            "publicKey": { "encryptionPublicKey": keys.encryption_public_key, "kemPublicKey": keys.kem_public_key },
            "next": e(&after),
            "ctx": { "groupId": GROUP, "workspaceId": AREA, "toVersion": 2, "fromVersion": 1 },
            "wrapped": e(&previous_notice_seed_wrap(before.to_vec(), after.to_vec(), ctx).unwrap()),
        },
    })
}

/* A company roster's entry for testkit person `n` with `roles`. */
fn entry(n: u8, roles: &[GroupRole]) -> RosterMember {
    person(n).entry(roles, 1, MemberStatus::Active)
}

/*
 * A company written with this core's own builders, for the web to judge
 * (`examples/company_fixtures.rs`): created by its Owner (roster 1), who lets
 * everyone in (2) and replaces the company key (3, which says `same`); then
 * the kit holder uses the kit to become an Owner (4). With the seals of that
 * life: the folder's key, the kit seal and its proof, the escrow, the seed to
 * an Admin, previousEnvelope, a re-seal, and the request to use the kit.
 * Returns the history as a case (its expected verdict this core's own) and
 * the seal items, each with this core's verdict.
 */
pub fn company_made_here() -> (Value, Vec<Value>) {
    let admin_roles = [GroupRole::DataAdmin, GroupRole::Members];
    let (owner, admin, keeper) = (person(1), person(3), person(5));
    let people: Vec<Person> = [1u8, 2, 3, 4, 5, 6, 8].into_iter().map(person).collect();
    let all = |keeper_roles: &[GroupRole]| {
        vec![
            entry(1, &OWNER_ROLES),
            entry(2, &OWNER_ROLES),
            entry(3, &admin_roles),
            entry(4, &[]),
            entry(5, keeper_roles),
            entry(6, &[GroupRole::Billing]),
            entry(8, &admin_roles),
        ]
    };
    let key_at = |version: u8| custody_public_key(custody_seed_at(version)).unwrap();
    let kem_at = |version: u8| base64url_decode(key_at(version).kem_public_key).unwrap();
    let kit = kit_public_keys(kit_secret_at(1), GROUP.into()).unwrap();
    let heads = |custody_key: Option<CustodyPublicKey>| NextOrgRoster {
        custody_key,
        kit: None,
        rules: None,
        auto_utc_day: None,
        heads_digest: heads_digest(),
        checked: vec![],
    };
    let mut ml_dsa_keys = served_ml_dsa(&people.iter().collect::<Vec<_>>());
    ml_dsa_keys.extend(kit_ml_dsa_keys(&[1]));
    let mut input = CaseInput {
        first_keys: group_public_key(group_seed(1)).unwrap(),
        anchor: Some(GroupAnchor::Created),
        pins: vec![],
        rosters: vec![],
        successions: vec![],
        ml_dsa_keys,
        me: reader(),
        cache: None,
        record: None,
        next: None,
        root: None,
        join_mark: None,
        pair_marks: vec![],
        raw_cache: None,
        raw_marks: None,
    };
    // Roster 1: the company, its first shared folder, its key and its kit.
    let first = company_roster_first(
        GROUP.into(),
        entry(1, &OWNER_ROLES),
        Some(vec![AreaKey {
            workspace_id: AREA.into(),
            workspace_key: area_key_at(AREA, 1),
            root_key: Some(root_key_at(AREA, 1)),
            area_kind: Some(AreaKind::Shared),
            list_digest: Some(list_digest_at(AREA, 1)),
        }]),
        FirstOrgRoster {
            custody_key: key_at(1),
            kit: kit.clone(),
            rules: None,
            heads_digest: heads_digest(),
        },
    )
    .unwrap();
    input.rosters.push(roster_sign(first, group_seed(1), owner.keys.clone()).unwrap());
    // Roster 2: everyone else, with their roles. Roster 3: a new company key, no entry changed.
    let next = |input: &CaseInput, members: Vec<RosterMember>, signer: &Person, org: NextOrgRoster| {
        let chain = chain_through(input, input.rosters.len() as u64);
        company_roster_next(chain, members, signer.user_id.clone(), None, None, org).unwrap()
    };
    let second = next(&input, all(&[GroupRole::Recovery]), &owner, heads(None));
    input.rosters.push(roster_sign(second, group_seed(1), owner.keys.clone()).unwrap());
    let third = next(&input, all(&[GroupRole::Recovery]), &owner, heads(Some(key_at(2))));
    assert!(third.org.as_ref().unwrap().members_same.is_some(), "a roster that changes no entry says `same`");
    input.rosters.push(roster_sign(third, group_seed(1), owner.keys.clone()).unwrap());
    // Roster 4: the kit holder's recovery roster, signed with the kit.
    let fourth = next(&input, all(&OWNER_ROLES), &keeper, heads(None));
    input
        .rosters
        .push(recovery_roster_sign(fourth, group_seed(1), keeper.keys.clone(), kit_secret_at(1)).unwrap());
    let chains: Vec<Arc<AcceptedRosters>> = (1..=4).map(|through| chain_through(&input, through)).collect();
    let at = |through: usize| (through as u64, chains[through - 1].roster_digest());
    let mut items: Vec<Value> = vec![];
    let mut add = |name: &str,
                   kind: &str,
                   through: u64,
                   ctx: Value,
                   sealer: u8,
                   reader: Option<u8>,
                   envelope: Vec<u8>,
                   proof: Option<Vec<u8>>| {
        let mut item = json!({
            "name": name, "kind": kind, "through": through, "ctx": ctx, "envelope": e(&envelope), "sealer": sealer,
        });
        if let Some(reader) = reader {
            item["reader"] = json!(reader);
        }
        if let Some(proof) = proof {
            item["proof"] = json!(e(&proof));
        }
        items.push(item);
    };
    // At creation: the folder's key, the seed to the kit with its proof, the escrow.
    let (version, digest) = at(1);
    let seal_ctx = CustodySealContext {
        group_id: GROUP.into(),
        workspace_id: AREA.into(),
        workspace_key_version: 1,
        custody_key_version: 1,
        sealer_user_id: owner.user_id.clone(),
        roster_version: version,
        roster_digest: digest.clone(),
    };
    let seal_json = |ctx: &CustodySealContext| {
        json!({
            "groupId": ctx.group_id, "workspaceId": ctx.workspace_id, "workspaceKeyVersion": ctx.workspace_key_version,
            "custodyKeyVersion": ctx.custody_key_version, "sealerUserId": ctx.sealer_user_id,
            "rosterVersion": ctx.roster_version, "rosterDigest": ctx.roster_digest,
        })
    };
    add(
        "folder-key-at-creation",
        "custody-seal",
        4,
        seal_json(&seal_ctx),
        1,
        None,
        custody_seal(
            area_key_at(AREA, 1),
            seal_ctx.clone(),
            chains[0].clone(),
            kem_at(1),
            owner.keys.clone(),
        )
        .unwrap(),
        None,
    );
    let kit_ctx = KitSealContext {
        group_id: GROUP.into(),
        custody_key_version: 1,
        kit_version: 1,
        sealer_user_id: owner.user_id.clone(),
        roster_version: version,
        roster_digest: digest.clone(),
    };
    let sealed = kit_seal(
        custody_seed_at(1),
        kit_ctx.clone(),
        chains[0].clone(),
        base64url_decode(kit.kem_public_key.clone()).unwrap(),
        kem_at(1),
        owner.keys.clone(),
    )
    .unwrap();
    add(
        "kit-seal-at-creation",
        "kit-seal",
        4,
        json!({
            "groupId": GROUP, "custodyKeyVersion": 1, "kitVersion": 1, "sealerUserId": owner.user_id,
            "rosterVersion": version, "rosterDigest": digest,
        }),
        1,
        None,
        sealed.kit_seal,
        Some(sealed.proof),
    );
    let escrow_ctx = KeyEscrowContext {
        group_id: GROUP.into(),
        group_key_version: 1,
        custody_key_version: 1,
        sealer_user_id: owner.user_id.clone(),
        roster_version: version,
        roster_digest: digest.clone(),
    };
    add(
        "escrow-at-creation",
        "key-escrow",
        4,
        json!({
            "groupId": GROUP, "groupKeyVersion": 1, "custodyKeyVersion": 1, "sealerUserId": owner.user_id,
            "rosterVersion": version, "rosterDigest": digest,
        }),
        1,
        None,
        key_escrow_seal(group_seed(1), escrow_ctx, chains[0].clone(), kem_at(1), owner.keys.clone()).unwrap(),
        None,
    );
    // With everyone in: the seed to an Admin, and the kit holder's request.
    let (version, digest) = at(2);
    let seed_ctx = CustodyKeySealContext {
        group_id: GROUP.into(),
        custody_key_version: 1,
        holder_user_id: admin.user_id.clone(),
        holder_key_version: 1,
        sealer_user_id: owner.user_id.clone(),
        roster_version: version,
        roster_digest: digest.clone(),
    };
    add(
        "seed-to-an-admin",
        "custody-key-seal",
        2,
        json!({
            "groupId": GROUP, "custodyKeyVersion": 1, "holderUserId": admin.user_id, "holderKeyVersion": 1,
            "sealerUserId": owner.user_id, "rosterVersion": version, "rosterDigest": digest,
        }),
        1,
        Some(3),
        custody_key_seal(
            custody_seed_at(1),
            seed_ctx,
            chains[1].clone(),
            base64url_decode(admin.served.kem_public_key.clone()).unwrap(),
            owner.keys.clone(),
        )
        .unwrap(),
        None,
    );
    let request = recovery_request_sign(
        RecoveryRequest {
            group_id: GROUP.into(),
            requester_user_id: keeper.user_id.clone(),
            requester_key_version: 1,
            kit_version: 1,
            custody_key_version: 1,
            roster_version: version,
            roster_digest: digest,
            requested_at: "2026-11-03T09:00:00.000Z".into(),
        },
        chains[1].clone(),
        keeper.keys.clone(),
    )
    .unwrap();
    add(
        "recovery-request",
        "recovery-request",
        2,
        json!({}),
        5,
        None,
        request.statement,
        Some(request.signature),
    );
    // The replacement (roster 3): previousEnvelope, and the folder re-sealed by an Admin.
    let (version, digest) = at(3);
    let previous_ctx = CustodyPreviousContext {
        group_id: GROUP.into(),
        custody_key_version: 2,
        previous_version: 1,
        sealer_user_id: owner.user_id.clone(),
        roster_version: version,
        roster_digest: digest.clone(),
    };
    add(
        "previous-envelope-2",
        "custody-previous",
        4,
        json!({
            "groupId": GROUP, "custodyKeyVersion": 2, "previousVersion": 1, "sealerUserId": owner.user_id,
            "rosterVersion": version, "rosterDigest": digest,
        }),
        1,
        None,
        custody_previous_seal(
            custody_seed_at(1),
            previous_ctx,
            chains[2].clone(),
            kem_at(2),
            owner.keys.clone(),
        )
        .unwrap(),
        None,
    );
    let reseal_ctx = CustodySealContext {
        custody_key_version: 2,
        sealer_user_id: admin.user_id.clone(),
        roster_version: version,
        roster_digest: digest,
        ..seal_ctx
    };
    add(
        "folder-key-resealed-by-an-admin",
        "custody-seal",
        4,
        seal_json(&reseal_ctx),
        3,
        None,
        custody_seal(
            area_key_at(AREA, 1),
            reseal_ctx.clone(),
            chains[2].clone(),
            kem_at(2),
            admin.keys.clone(),
        )
        .unwrap(),
        None,
    );
    // This core's own verdict on each: what it made opens as it should.
    let chain_at = |through: u64| chains[through as usize - 1].clone();
    let opened = |bytes: Vec<u8>| json!(format!("opened:{}", e(&bytes)));
    let expected: Vec<Value> = vec![
        opened(area_key_at(AREA, 1)),
        json!({ "check": "holds", "opened": format!("opened:{}", e(&custody_seed_at(1))) }),
        opened(group_seed(1)),
        opened(custody_seed_at(1)),
        json!("verified"),
        opened(custody_seed_at(1)),
        opened(area_key_at(AREA, 1)),
    ];
    for (item, expected) in items.iter_mut().zip(expected) {
        let verdict = seal_item_verdict(item, &chain_at);
        assert_eq!(verdict, expected, "{}: the core says {verdict}", s(item, "name"));
        item["expected"] = verdict;
    }
    let verdict = judge(&input);
    assert_eq!(verdict["status"], json!("accepted"), "the core accepts the company it made");
    assert_eq!(verdict["recoveries"], json!([{ "rosterVersion": 4, "signerUserId": keeper.user_id }]));
    (case_json("company-made-by-the-core", &input, &verdict), items)
}
