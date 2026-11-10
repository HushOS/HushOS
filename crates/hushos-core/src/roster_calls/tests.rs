use super::*;
use crate::contacts::{identity_fingerprint_of_keys, key_digest};
use crate::device_record::{FamilyGuard, ServedAcceptance, ServedChain};
use crate::group_trust::{
    accept_rosters, pin_after, roster_check_next, GroupAnchor, GroupPin, RosterChain, VerifiedPin,
};
use crate::groups::tests::{
    accepted_of, area_key_at, group_seed_at, ml_dsa_keys, reader, History, Person, AREA, AREA_KEY, AREA_SEED,
    GROUP,
};
use crate::groups::{area_grant_open, area_key_commitment, area_root_commitment, MemberStatus, RosterArea};
use crate::identity::identity_create;
use crate::ids::{derive_id, IdKind};
use crate::join::code_at;
use crate::rotation_records::RotatingNode;

const CHECKED: &str = "2026-10-18T00:00:00.000Z";
/* A second family folder on roster 1, deleted (its tombstone) on roster 2: granted to nobody after. */
const SECOND: &str = "b0558a81-8dfc-4914-8447-0417b55e2ec5";
/* A third, live, derived under GROUP from this seed, rotated to key version 2 on roster 2. */
const THIRD_SEED: &str = "AAECAwQFBgcICQoLDA0ODw";

fn third() -> String {
    derive_id(IdKind::Workspace, GROUP.into(), THIRD_SEED.into()).unwrap()
}
fn third_key(version: u64) -> Vec<u8> {
    vec![140 + version as u8; 32]
}

/*
 * The family every test here manages: person 1 organizes it (billing,
 * members), person 2 is a member, person 3 holds members (or not, for the
 * last-holder case), persons 4 and 5 are waiting to be let in. Roster 1 has
 * AREA, SECOND and THIRD (format 2); roster 2 lets 2 and 3 in, deletes SECOND
 * and rotates THIRD to key version 2. `extra` adds rosters after it (each a
 * list of entries, signed by person 1).
 */
struct Family {
    p: Vec<Person>,
    h: History,
}

fn key_row(workspace_id: &str, version: u64, key: &[u8], root: &[u8]) -> RosterArea {
    RosterArea {
        workspace_id: workspace_id.into(),
        workspace_key_version: version,
        commitment: area_key_commitment(key).unwrap(),
        root_commitment: Some(area_root_commitment(root).unwrap()),
        retired: false,
        area_kind: None,
        list_digest: None,
    }
}

/* A later roster's entries, from the family's people. */
type Entries = fn(&[Person]) -> Vec<RosterMember>;

fn family_with(p3_roles: &[GroupRole], extra: &[Entries]) -> Family {
    let p: Vec<Person> = (1..=5).map(Person::new).collect();
    let mut h = History { format: 2, ..History::new() };
    let owner = p[0].entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active);
    h.roster_with(
        &p[0],
        vec![owner.clone()],
        None,
        Some(vec![
            key_row(AREA, 1, &AREA_KEY, &[61; 32]),
            key_row(SECOND, 1, &area_key_at(SECOND, 1), &[62; 32]),
            key_row(&third(), 1, &third_key(1), &[63; 32]),
        ]),
    );
    h.roster_with(
        &p[0],
        vec![owner, p[1].entry(&[], 1, MemberStatus::Active), p[2].entry(p3_roles, 1, MemberStatus::Active)],
        None,
        Some(vec![
            RosterArea {
                workspace_id: SECOND.into(),
                workspace_key_version: 2,
                commitment: String::new(),
                root_commitment: None,
                retired: true,
                area_kind: None,
                list_digest: None,
            },
            key_row(&third(), 2, &third_key(2), &[64; 32]),
        ]),
    );
    for members in extra {
        h.roster_with(&p[0], members(&p), None, Some(vec![]));
    }
    Family { p, h }
}

fn family() -> Family {
    family_with(&[GroupRole::Members], &[])
}

impl Family {
    fn people(&self) -> Vec<&Person> {
        self.p.iter().collect()
    }
    fn chain(&self) -> Arc<AcceptedRosters> {
        accepted_of(&self.h, &self.people())
    }
    fn me_of(&self, who: usize) -> OwnIdentities {
        OwnIdentities {
            user_id: self.p[who - 1].user_id.clone(),
            identities: vec![self.p[who - 1].served_keys()],
        }
    }
    fn me(&self) -> OwnIdentities {
        self.me_of(1)
    }
    fn served(&self, rosters: Vec<SignedGroupStatement>) -> ServedChain {
        ServedChain {
            after: 0,
            first_keys: self.h.key(1),
            rosters,
            successions: self.h.successions.clone(),
            signer_keys: ml_dsa_keys(&self.people()),
        }
    }
    fn pin(&self) -> GroupPin {
        pin_after(vec![], self.chain(), CHECKED.into()).unwrap()
    }
    /* Person 1's contact pins: everyone else's words checked. */
    fn contacts(&self) -> HashMap<String, VerifiedPin> {
        self.p[1..].iter().map(|p| (p.user_id.clone(), pin_of(p))).collect()
    }

    /*
     * Person `who`'s ledger: the account open under their root, the settings (the group pin at the
     * head, `contacts`), the served chain accepted and committed; with `seed`, the group key opened
     * from person 1's seal to them (holders only); with `area`, AREA and THIRD opened.
     */
    fn ledger_of(
        &self,
        who: usize,
        contacts: HashMap<String, VerifiedPin>,
        seed: bool,
        area: bool,
    ) -> Arc<AreaLedger> {
        let ledger = AreaLedger::new();
        let p = &self.p[who - 1];
        let signing = decode("k", &p.keys.signing_public_key, None).unwrap();
        ledger.open_account(p.user_id.clone(), signing, p.root.clone()).unwrap();
        let pins = [(GROUP.to_string(), self.pin())].into();
        ledger.use_settings(p.user_id.clone(), Some(pins), contacts).unwrap();
        let accepted = ledger.accept_served(
            self.me_of(who),
            GROUP.into(),
            None,
            self.served(self.h.rosters.clone()),
            FamilyGuard::Absent,
            CHECKED.into(),
        );
        assert!(matches!(accepted, Ok(ServedAcceptance::Accepted { .. })), "{accepted:?}");
        if seed {
            ledger
                .open_group_key(
                    self.me_of(who),
                    GROUP.into(),
                    self.seal_to(who),
                    self.p[0].ml_dsa(),
                    None,
                    p.envelope.clone(),
                )
                .unwrap();
        }
        if area {
            ledger.open_area(GROUP.into(), AREA.into(), AREA_SEED.into(), 1, AREA_KEY.to_vec(), 1).unwrap();
            ledger.open_area(GROUP.into(), third(), THIRD_SEED.into(), 2, third_key(2), 2).unwrap();
        }
        ledger
    }

    fn ledger(&self, seed: bool, area: bool) -> Arc<AreaLedger> {
        self.ledger_of(1, self.contacts(), seed, area)
    }

    /* Person 1's seal of the current group key to person `who`, at the head. */
    fn seal_to(&self, who: usize) -> ServedKeySeal {
        let chain = self.chain();
        let (p1, holder) = (&self.p[0], &self.p[who - 1]);
        let version = chain.group_key_version;
        let ctx = GroupKeySealContext {
            group_id: GROUP.into(),
            group_key_version: version,
            holder_user_id: holder.user_id.clone(),
            holder_key_version: 1,
            sealer_user_id: p1.user_id.clone(),
            roster_version: chain.roster.roster_version,
            roster_digest: chain.roster_digest.clone(),
        };
        let envelope = group_key_seal(
            group_seed_at(version),
            ctx.clone(),
            Arc::clone(&chain),
            holder.kem(),
            p1.keys.clone(),
        )
        .unwrap();
        ServedKeySeal {
            group_key_version: version,
            holder_key_version: 1,
            sealer_user_id: ctx.sealer_user_id,
            roster_version: ctx.roster_version,
            roster_digest: ctx.roster_digest,
            envelope,
        }
    }

    fn own_seal(&self) -> ServedKeySeal {
        self.seal_to(1)
    }

    fn kems(&self) -> HashMap<String, String> {
        self.p.iter().map(|p| (p.user_id.clone(), p.keys.kem_public_key.clone().unwrap())).collect()
    }

    fn admit(&self, ledger: &AreaLedger, who: usize, roles: Vec<GroupRole>) -> CoreResult<RosterCall> {
        let newcomer = &self.p[who - 1];
        ledger.admit_body(
            self.me(),
            self.p[0].envelope.clone(),
            GROUP.into(),
            7,
            newcomer.user_id.clone(),
            newcomer.served(),
            roles,
            HashMap::new(),
        )
    }

    fn roles_as(
        &self,
        by: usize,
        ledger: &AreaLedger,
        who: usize,
        change: MembersRole,
    ) -> CoreResult<RosterCall> {
        let user = self.p[who - 1].user_id.clone();
        ledger.roles_body(
            self.me_of(by),
            self.p[by - 1].envelope.clone(),
            GROUP.into(),
            7,
            user,
            change,
            self.kems(),
        )
    }

    fn roles(&self, ledger: &AreaLedger, who: usize, change: MembersRole) -> CoreResult<RosterCall> {
        self.roles_as(1, ledger, who, change)
    }

    fn handover_as(&self, by: usize, ledger: &AreaLedger, step: Handover) -> CoreResult<RosterCall> {
        ledger.handover_body(
            self.me_of(by),
            self.p[by - 1].envelope.clone(),
            GROUP.into(),
            7,
            step,
            self.kems(),
        )
    }

    fn handover(&self, ledger: &AreaLedger, step: Handover) -> CoreResult<RosterCall> {
        self.handover_as(1, ledger, step)
    }

    fn open(&self, ledger: &AreaLedger, call: &StagedCall) -> CoreResult<OutboxCall> {
        ledger.outbox_open(
            GROUP.into(),
            call.outbox_id.clone(),
            self.p[0].user_id.clone(),
            call.entry.clone(),
        )
    }
}

/* A version 3 pin of the person, as comparing their words writes it. */
fn pin_of(p: &Person) -> VerifiedPin {
    let ml_dsa = key_digest(p.ml_dsa());
    let kem = key_digest(p.kem());
    VerifiedPin {
        user_id: p.user_id.clone(),
        key_version: p.keys.key_version,
        encryption_public_key: p.keys.encryption_public_key.clone(),
        signing_public_key: p.keys.signing_public_key.clone(),
        fingerprint: identity_fingerprint_of_keys(
            decode("k", &p.keys.encryption_public_key, None).unwrap(),
            decode("k", &p.keys.signing_public_key, None).unwrap(),
            p.ml_dsa(),
            p.kem(),
        )
        .unwrap(),
        ml_dsa_public_key_hash: ml_dsa,
        kem_public_key_hash: kem,
        trusted_via: None,
    }
}

fn signed_of(wire: &Value) -> SignedGroupStatement {
    let d = |key: &Value| decode("k", key.as_str().unwrap(), None).unwrap();
    SignedGroupStatement {
        statement: d(&wire["statement"]),
        signature: crate::groups::GroupSignature {
            ed25519: d(&wire["signature"]["ed25519"]),
            ml_dsa: d(&wire["signature"]["mlDsa"]),
        },
        signer_signature: d(&wire["signerSignature"]),
        kit_signature: None,
    }
}

/* The chain after the body: its roster (and succession) accepted from version 1, as every member does. */
fn after_body(f: &Family, body: &Value) -> Arc<AcceptedRosters> {
    let mut rosters = f.h.rosters.clone();
    rosters.push(signed_of(&body["roster"]));
    let mut successions = f.h.successions.clone();
    if !body["succession"].is_null() {
        successions.push(signed_of(&body["succession"]));
    }
    match accept_rosters(
        GROUP.into(),
        f.h.key(1),
        Some(GroupAnchor::Created),
        vec![],
        rosters,
        successions,
        ml_dsa_keys(&f.people()),
        reader(),
        None,
    )
    .unwrap()
    {
        RosterChain::Accepted { chain } => chain,
        fork => panic!("{fork:?}"),
    }
}

/* What a seal in the body opens to, with the holder's own keys. */
fn open_seal(f: &Family, chain: &Arc<AcceptedRosters>, seal: &Value, holder: usize) -> CoreResult<Vec<u8>> {
    let p = &f.p[holder - 1];
    let ctx = GroupKeySealContext {
        group_id: GROUP.into(),
        group_key_version: seal["groupKeyVersion"].as_u64().unwrap(),
        holder_user_id: seal["holderUserId"].as_str().unwrap().into(),
        holder_key_version: seal["holderKeyVersion"].as_u64().unwrap(),
        sealer_user_id: f.p[0].user_id.clone(),
        roster_version: seal["rosterVersion"].as_u64().unwrap(),
        roster_digest: seal["rosterDigest"].as_str().unwrap().into(),
    };
    let envelope = decode("k", seal["envelope"].as_str().unwrap(), None).unwrap();
    group_key_open(
        envelope,
        ctx,
        Arc::clone(chain),
        f.p[0].ml_dsa(),
        None,
        p.user_id.clone(),
        1,
        p.keys.clone(),
    )
    .map(|seed| seed.to_vec())
}

/* Each grant in `grants` opened by its grantee: (grantee, folder, version, key). */
fn open_grants(
    f: &Family,
    chain: &Arc<AcceptedRosters>,
    grants: &Value,
) -> Vec<(String, String, u64, Vec<u8>)> {
    grants
        .as_array()
        .unwrap()
        .iter()
        .map(|grant| {
            let grantee = f.p.iter().find(|p| grant["granteeUserId"] == json!(p.user_id)).unwrap();
            let workspace_id = grant["workspaceId"].as_str().unwrap().to_string();
            let version = grant["workspaceKeyVersion"].as_u64().unwrap();
            let seed = if workspace_id == AREA { AREA_SEED } else { THIRD_SEED };
            let key = area_grant_open(
                decode("k", grant["envelope"].as_str().unwrap(), None).unwrap(),
                AreaGrantContext {
                    group_id: GROUP.into(),
                    workspace_id: workspace_id.clone(),
                    workspace_key_version: version,
                    grantee_user_id: grantee.user_id.clone(),
                    grantee_key_version: 1,
                    granter_user_id: grant_granter(grant, f),
                    roster_version: grant["rosterVersion"].as_u64().unwrap(),
                    roster_digest: grant["rosterDigest"].as_str().unwrap().into(),
                },
                Arc::clone(chain),
                seed.into(),
                f.p[0].ml_dsa(),
                None,
                grantee.user_id.clone(),
                1,
                grantee.keys.clone(),
            )
            .unwrap();
            (grantee.user_id.clone(), workspace_id, version, key.to_vec())
        })
        .collect()
}

/* Every grant here is person 1's. */
fn grant_granter(_: &Value, f: &Family) -> String {
    f.p[0].user_id.clone()
}

fn body_of(call: &StagedCall) -> Value {
    serde_json::from_str(&call.body).unwrap()
}

/* The signed call of a builder's answer. */
fn staged(result: CoreResult<RosterCall>) -> CoreResult<StagedCall> {
    match result? {
        RosterCall::Staged { call } => Ok(call),
        other => panic!("not staged: {other:?}"),
    }
}

fn message(result: CoreResult<RosterCall>) -> String {
    result.unwrap_err().to_string()
}

#[test]
fn an_admission_grants_exactly_each_live_folder_at_its_key_and_is_a_roster_every_member_takes() {
    let f = family();
    let ledger = f.ledger(true, true);
    let call = staged(f.admit(&ledger, 4, vec![])).unwrap();
    assert_eq!(call.route, ChainRoute::Admit { user_id: f.p[3].user_id.clone() });
    let body = body_of(&call);
    assert_eq!(body["expectedRevision"], json!(7));
    // As the server checks it: the next roster on the chain, and the newcomer's entry their keys.
    let identities = [(f.p[3].user_id.clone(), vec![f.p[3].served()])].into();
    roster_check_next(f.chain(), signed_of(&body["roster"]), ml_dsa_keys(&f.people()), Some(identities))
        .unwrap();
    let after = after_body(&f, &body);
    assert_eq!(after.roster.roster_version, 3);
    let entry = after.roster.entry(&f.p[3].user_id).unwrap();
    assert!(entry.active_with(None) && entry.roles.is_empty() && entry.since_version == 3);
    // Exactly AREA at 1 and THIRD at its current 2, each opening to that version's key; the deleted folder
    // is granted to nobody (the web asked for its key, and threw, before this release).
    let mut opened = open_grants(&f, &after, &body["grants"]);
    opened.sort();
    let mut expected = vec![
        (f.p[3].user_id.clone(), AREA.to_string(), 1, AREA_KEY.to_vec()),
        (f.p[3].user_id.clone(), third(), 2, third_key(2)),
    ];
    expected.sort();
    assert_eq!(opened, expected);
    // No `members`: no seal, no succession.
    assert!(body.get("keySeal").is_none() && body.get("seals").is_none() && body.get("succession").is_none());
}

#[test]
fn an_admission_never_carries_a_role_whatever_the_invitation_says() {
    let f = family();
    let ledger = f.ledger(true, true);
    // Every role an invitation can carry, over a checked pin: refused before anything is signed.
    for role in [GroupRole::Members, GroupRole::Billing, GroupRole::Guardian] {
        assert_eq!(message(f.admit(&ledger, 5, vec![role])), ADMIT_AS_MEMBER);
    }
    // As a plain member it goes, with no group key sealed to them.
    let body = body_of(&staged(f.admit(&ledger, 5, vec![])).unwrap());
    assert_eq!(body["keySeal"], Value::Null);
}

#[test]
fn an_admission_takes_the_pin_only_from_the_settings_and_refuses_a_member_unchecked_keys_and_closed_folders()
{
    let f = family();
    let ledger = f.ledger(true, true);
    assert_eq!(message(f.admit(&ledger, 2, vec![])), ALREADY_IN);
    // No contact pin of person 4 in the settings opened: nobody is added, whatever the app has.
    let unchecked = f.ledger_of(1, HashMap::new(), true, true);
    assert_eq!(message(f.admit(&unchecked, 4, vec![])), NOT_CHECKED);
    // A pin filed for person 4 that holds person 5's keys, or one trusted through a group: nobody is added.
    let wrong = VerifiedPin { user_id: f.p[3].user_id.clone(), ..pin_of(&f.p[4]) };
    let planted = f.ledger_of(1, [(f.p[3].user_id.clone(), wrong)].into(), true, true);
    assert_eq!(message(f.admit(&planted, 4, vec![])), "These are not the keys whose words were checked.");
    let via = VerifiedPin { trusted_via: Some(GROUP.into()), ..pin_of(&f.p[3]) };
    let trusted = f.ledger_of(1, [(f.p[3].user_id.clone(), via)].into(), true, true);
    assert_eq!(message(f.admit(&trusted, 4, vec![])), "These are not the keys whose words were checked.");
    // A first-seen pin of the newcomer's very keys (no words compared): let in over it as over a
    // verified one (design 3.2, the worker since #231), as a plain member.
    let seen = VerifiedPin { fingerprint: String::new(), ..pin_of(&f.p[3]) };
    let first_seen = f.ledger_of(1, [(f.p[3].user_id.clone(), seen)].into(), true, true);
    assert!(matches!(f.admit(&first_seen, 4, vec![]).unwrap(), RosterCall::Staged { .. }));
    // A first-seen pin filed for them over someone else's keys still admits nobody.
    let other_seen =
        VerifiedPin { user_id: f.p[3].user_id.clone(), fingerprint: String::new(), ..pin_of(&f.p[4]) };
    let other_first_seen = f.ledger_of(1, [(f.p[3].user_id.clone(), other_seen)].into(), true, true);
    assert_eq!(
        message(f.admit(&other_first_seen, 4, vec![])),
        "These are not the keys whose words were checked."
    );
    // A live folder not opened here: answered before anything is signed.
    assert_eq!(f.admit(&f.ledger(true, false), 4, vec![]).unwrap(), RosterCall::OpenFoldersFirst);
    // Settings that file a pin under another person are refused outright.
    let misfiled = AreaLedger::new();
    let p1 = &f.p[0];
    misfiled
        .open_account(
            p1.user_id.clone(),
            decode("k", &p1.keys.signing_public_key, None).unwrap(),
            p1.root.clone(),
        )
        .unwrap();
    let filed = [(f.p[3].user_id.clone(), pin_of(&f.p[4]))].into();
    assert!(misfiled.use_settings(p1.user_id.clone(), Some(HashMap::new()), filed).is_err());
}

#[test]
fn a_call_needs_the_account_the_committed_chain_members_the_seed_and_the_open_identity_in_that_order() {
    let f = family();
    // Locked.
    assert_eq!(message(f.admit(&AreaLedger::new(), 4, vec![])), NO_ACCOUNT);
    // Another account than the one unlocked.
    let ledger = f.ledger(true, true);
    let refused = ledger.roles_body(
        f.me_of(2),
        f.p[1].envelope.clone(),
        GROUP.into(),
        7,
        f.p[1].user_id.clone(),
        MembersRole::Grant,
        f.kems(),
    );
    assert_eq!(message(refused), NO_ACCOUNT);
    // No chain committed for the family (a refusal or a fork uncommitted it): sync first.
    let uncommitted = f.ledger(true, true);
    uncommitted.uncommit(GROUP.into(), true);
    assert_eq!(f.roles(&uncommitted, 2, MembersRole::Grant).unwrap(), RosterCall::SyncFirst);
    // Someone without `members` (person 2): refused before any key is asked for.
    let member = f.ledger_of(2, HashMap::new(), false, true);
    assert_eq!(message(f.roles_as(2, &member, 3, MembersRole::Take)), NOT_MANAGER);
    let as_two = member.admit_body(
        f.me_of(2),
        f.p[1].envelope.clone(),
        GROUP.into(),
        7,
        f.p[3].user_id.clone(),
        f.p[3].served(),
        vec![],
        HashMap::new(),
    );
    assert_eq!(message(as_two), NOT_MANAGER);
    // The family's key not opened here.
    assert_eq!(f.roles(&f.ledger(false, true), 2, MembersRole::Grant).unwrap(), RosterCall::OpenKeyFirst);
    // Another identity than the account's open one, or the right one under another root.
    let wrong = ledger.roles_body(
        f.me(),
        f.p[1].envelope.clone(),
        GROUP.into(),
        7,
        f.p[1].user_id.clone(),
        MembersRole::Grant,
        f.kems(),
    );
    assert_eq!(message(wrong), OPEN_IDENTITY);
    let elsewhere = identity_create(f.p[0].user_id.clone(), vec![3; 32], 1).unwrap();
    let foreign = ledger.roles_body(
        f.me(),
        elsewhere,
        GROUP.into(),
        7,
        f.p[1].user_id.clone(),
        MembersRole::Grant,
        f.kems(),
    );
    assert_eq!(message(foreign), OPEN_IDENTITY);
    // A user id in capitals is the same person; one that is no id is refused before anything.
    let upper = f.p[1].user_id.to_uppercase();
    let call = staged(ledger.roles_body(
        f.me(),
        f.p[0].envelope.clone(),
        GROUP.into(),
        7,
        upper,
        MembersRole::Grant,
        f.kems(),
    ))
    .unwrap();
    assert_eq!(call.route, ChainRoute::Member { user_id: f.p[1].user_id.clone() });
    assert!(ledger
        .roles_body(
            f.me(),
            f.p[0].envelope.clone(),
            GROUP.into(),
            7,
            "nobody".into(),
            MembersRole::Grant,
            f.kems()
        )
        .is_err());
}

#[test]
fn granting_members_seals_the_current_key_to_them_and_nothing_else_changes() {
    let f = family();
    let ledger = f.ledger(true, true);
    let call = staged(f.roles(&ledger, 2, MembersRole::Grant)).unwrap();
    assert_eq!(call.route, ChainRoute::Member { user_id: f.p[1].user_id.clone() });
    let body = body_of(&call);
    let after = after_body(&f, &body);
    assert_eq!(after.group_key_version, 1);
    assert_eq!(after.roster.entry(&f.p[1].user_id).unwrap().roles, vec![GroupRole::Members]);
    assert_eq!(open_seal(&f, &after, &body["keySeal"], 2).unwrap(), group_seed_at(1));
    assert!(body.get("grants").is_none() && body.get("succession").is_none());
    // Their KEM key as route 6 served it is needed to seal to them.
    let refused = ledger.roles_body(
        f.me(),
        f.p[0].envelope.clone(),
        GROUP.into(),
        7,
        f.p[1].user_id.clone(),
        MembersRole::Grant,
        HashMap::new(),
    );
    assert_eq!(message(refused), KEYS_MISSING);
}

#[test]
fn members_is_given_only_over_this_accounts_own_verified_pin_of_the_keys_their_entry_names() {
    // The manager rule (docs/optional-verification.md 3.6), the worker's CHECK_MANAGER_FIRST twin.
    let f = family();
    let two = f.p[1].user_id.clone();
    let with = |pin: Option<VerifiedPin>| {
        let mut contacts = f.contacts();
        match pin {
            Some(pin) => contacts.insert(two.clone(), pin),
            None => contacts.remove(&two),
        };
        f.ledger_of(1, contacts, true, true)
    };
    // No pin of them, a first-seen one (no words compared), one trusted via the family, and a
    // verified pin filed for them over someone else's keys: none gives the role.
    assert_eq!(message(f.roles(&with(None), 2, MembersRole::Grant)), CHECK_MANAGER_FIRST);
    let seen = VerifiedPin { fingerprint: String::new(), ..pin_of(&f.p[1]) };
    assert_eq!(message(f.roles(&with(Some(seen.clone())), 2, MembersRole::Grant)), CHECK_MANAGER_FIRST);
    let via = VerifiedPin { trusted_via: Some(GROUP.into()), ..pin_of(&f.p[1]) };
    assert_eq!(message(f.roles(&with(Some(via)), 2, MembersRole::Grant)), CHECK_MANAGER_FIRST);
    let other = VerifiedPin { user_id: two.clone(), ..pin_of(&f.p[3]) };
    assert_eq!(message(f.roles(&with(Some(other)), 2, MembersRole::Grant)), CHECK_MANAGER_FIRST);
    // Their own words compared, over the keys their entry names: given.
    assert!(staged(f.roles(&with(Some(pin_of(&f.p[1]))), 2, MembersRole::Grant)).is_ok());
    // Taking it away, and billing, ask for no check: a first-seen pin is enough.
    let first_seen = with(Some(seen));
    assert!(staged(f.roles(&first_seen, 3, MembersRole::Take)).is_ok());
    assert!(staged(f.handover(&first_seen, Handover::To { user_id: two })).is_ok());
}

#[test]
fn taking_members_away_replaces_the_group_key_and_seals_it_only_to_those_who_keep_it() {
    let f = family();
    let ledger = f.ledger(true, true);
    let body = body_of(&staged(f.roles(&ledger, 3, MembersRole::Take)).unwrap());
    let after = after_body(&f, &body);
    assert_eq!(after.group_key_version, 2);
    assert!(!after.succession_due);
    let seals = body["seals"].as_array().unwrap();
    // Person 1 alone holds it now: person 3 gets no seal of the new key.
    assert_eq!(seals.len(), 1);
    assert_eq!(seals[0]["holderUserId"], json!(f.p[0].user_id));
    assert_eq!(seals[0]["groupKeyVersion"], json!(2));
    let seed = open_seal(&f, &after, &seals[0], 1).unwrap();
    assert_eq!(group_public_key(seed).unwrap(), after.group_key);
    assert!(body.get("keySeal").is_none());
}

#[test]
fn a_role_change_that_changes_nothing_or_takes_members_from_oneself_is_refused_before_signing() {
    let f = family();
    let ledger = f.ledger(true, true);
    // A grant to a holder, a take from someone without it, billing to the organizer.
    assert_eq!(message(f.roles(&ledger, 3, MembersRole::Grant)), UNCHANGED);
    assert_eq!(message(f.roles(&ledger, 2, MembersRole::Take)), UNCHANGED);
    assert_eq!(message(f.handover(&ledger, Handover::To { user_id: f.p[0].user_id.clone() })), UNCHANGED);
    // A manager who is not the organizer stepping down from billing they do not hold.
    let three = f.ledger_of(3, HashMap::new(), true, true);
    assert_eq!(message(f.handover_as(3, &three, Handover::StepDown)), UNCHANGED);
    // Taking `members` from oneself: another holder must sign the succession.
    assert_eq!(message(f.roles(&ledger, 1, MembersRole::Take)), SELF_TAKE);
}

#[test]
fn the_last_holder_is_never_let_go_of_and_someone_not_in_is_refused() {
    let f = family_with(&[], &[]);
    let ledger = f.ledger(true, true);
    assert!(f.roles(&ledger, 1, MembersRole::Take).is_err());
    let outsider = ledger.roles_body(
        f.me(),
        f.p[0].envelope.clone(),
        GROUP.into(),
        7,
        f.p[3].user_id.clone(),
        MembersRole::Grant,
        f.kems(),
    );
    assert_eq!(message(outsider), NOT_IN);
}

#[test]
fn the_handover_gives_billing_first_and_the_organizer_steps_down_only_once_someone_else_holds_it() {
    let f = family();
    let ledger = f.ledger(true, true);
    assert_eq!(message(f.handover(&ledger, Handover::StepDown)), ORGANIZER_FIRST);
    let body =
        body_of(&staged(f.handover(&ledger, Handover::To { user_id: f.p[1].user_id.clone() })).unwrap());
    let after = after_body(&f, &body);
    assert_eq!(after.roster.entry(&f.p[1].user_id).unwrap().roles, vec![GroupRole::Billing]);
    // Once that landed: person 2 bills, and person 1 lets go of it, keeping members.
    let handed = family_with(
        &[GroupRole::Members],
        &[|p| {
            vec![
                p[0].entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active),
                p[1].entry(&[GroupRole::Billing], 1, MemberStatus::Active),
                p[2].entry(&[GroupRole::Members], 1, MemberStatus::Active),
            ]
        }],
    );
    let ledger = handed.ledger(true, true);
    let body = body_of(&staged(handed.handover(&ledger, Handover::StepDown)).unwrap());
    let after = after_body(&handed, &body);
    assert_eq!(after.roster.entry(&handed.p[0].user_id).unwrap().roles, vec![GroupRole::Members]);
    assert_eq!(after.group_key_version, 1);
}

#[test]
fn a_staged_chain_is_never_committed_cached_or_a_mark() {
    let f = family();
    let ledger = f.ledger(true, true);
    let before = f.chain();
    let own = staged(f.admit(&ledger, 4, vec![])).unwrap();
    // Nothing moved: the committed chain is still roster 2, and so is the floor a later run is held to.
    assert_eq!(ledger.call_state(GROUP).chain.unwrap().roster_digest, before.roster_digest);
    assert_eq!(ledger.floor(GROUP).unwrap().roster_digest, before.roster_digest);
    // Another manager's roster 3 wins: it is taken as the family's, never a fork with this device's own
    // signed, unsent one.
    let mut won = f.h.clone();
    won.roster_with(
        &f.p[0],
        vec![
            f.p[0].entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active),
            f.p[1].entry(&[], 1, MemberStatus::Active),
            f.p[2].entry(&[GroupRole::Members], 1, MemberStatus::Active),
            f.p[4].entry(&[], 3, MemberStatus::Active),
        ],
        None,
        Some(vec![]),
    );
    let served = f.served(won.rosters.clone());
    match ledger
        .accept_served(f.me(), GROUP.into(), None, served, FamilyGuard::Absent, CHECKED.into())
        .unwrap()
    {
        ServedAcceptance::Accepted { chain, pin, .. } => {
            assert_eq!(chain.roster.roster_version, 3);
            assert_eq!(pin.roster_digest, chain.roster_digest);
            assert_ne!(chain.roster_digest, roster_digest(signed_of(&body_of(&own)["roster"]).statement));
        }
        other => panic!("{other:?}"),
    }
    // And this device's own call, read back now, can never land: superseded, nothing sent.
    assert_eq!(
        f.open(&ledger, &own).unwrap(),
        OutboxCall::Superseded { outbox_id: own.outbox_id.clone(), route: own.route.clone() }
    );
    // The served chain without either is still the family's (no mark of roster 3 to fall short of).
    let fresh = f.ledger(true, true);
    let _ = staged(f.admit(&fresh, 4, vec![])).unwrap();
    let again = fresh.accept_served(
        f.me(),
        GROUP.into(),
        None,
        f.served(f.h.rosters.clone()),
        FamilyGuard::Absent,
        CHECKED.into(),
    );
    match again.unwrap() {
        ServedAcceptance::Accepted { chain, .. } => assert_eq!(chain.roster_digest, before.roster_digest),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_kept_call_whose_roster_the_family_now_holds_reads_as_landed() {
    let f = family();
    let ledger = f.ledger(true, true);
    let call = staged(f.roles(&ledger, 2, MembersRole::Grant)).unwrap();
    // The server stored it (this send, or a resend another device answered) and the family synced.
    let mut rosters = f.h.rosters.clone();
    rosters.push(signed_of(&body_of(&call)["roster"]));
    assert!(matches!(
        ledger
            .accept_served(f.me(), GROUP.into(), None, f.served(rosters), FamilyGuard::Absent, CHECKED.into())
            .unwrap(),
        ServedAcceptance::Accepted { .. }
    ));
    assert_eq!(
        f.open(&ledger, &call).unwrap(),
        OutboxCall::Landed { outbox_id: call.outbox_id.clone(), route: call.route.clone() }
    );
}

#[test]
fn a_lock_another_account_or_a_commit_while_signing_keeps_nothing() {
    let set = |hook: LedgerHook| AFTER_SIGNING.with(|cell| *cell.borrow_mut() = hook);
    let f = Arc::new(family());
    // A lock and an unlock of the same account while the call was signed.
    let ledger = f.ledger(true, true);
    let ff = Arc::clone(&f);
    set(Some(Box::new(move |ledger: &AreaLedger| {
        ledger.clear();
        let p1 = &ff.p[0];
        let signing = decode("k", &p1.keys.signing_public_key, None).unwrap();
        ledger.open_account(p1.user_id.clone(), signing, p1.root.clone()).unwrap();
    })));
    let locked = f.admit(&ledger, 4, vec![]);
    set(None);
    assert_eq!(message(locked), NOT_THIS_ACCOUNT);
    // A later chain committed meanwhile (a background sync): built on a head that is gone.
    let ledger = f.ledger(true, true);
    let ff = Arc::clone(&f);
    set(Some(Box::new(move |ledger: &AreaLedger| {
        let mut later = ff.h.clone();
        later.roster_with(
            &ff.p[0],
            vec![
                ff.p[0].entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active),
                ff.p[1].entry(&[GroupRole::Billing], 1, MemberStatus::Active),
                ff.p[2].entry(&[GroupRole::Members], 1, MemberStatus::Active),
            ],
            None,
            Some(vec![]),
        );
        ledger.commit(accepted_of(&later, &ff.people())).unwrap();
    })));
    let moved = f.admit(&ledger, 4, vec![]);
    set(None);
    assert_eq!(moved.unwrap(), RosterCall::SyncFirst);
}

#[test]
fn the_seed_is_kept_for_the_key_the_family_is_under_whatever_roster_and_never_across_a_lock() {
    let set = |hook: LedgerHook| AFTER_OPENING.with(|cell| *cell.borrow_mut() = hook);
    let f = Arc::new(family());
    // A later roster under the same key committed while the seal was opened: still that key's seed.
    let ledger = f.ledger(false, false);
    let ff = Arc::clone(&f);
    set(Some(Box::new(move |ledger: &AreaLedger| {
        let mut later = ff.h.clone();
        later.roster_with(
            &ff.p[0],
            vec![
                ff.p[0].entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active),
                ff.p[1].entry(&[GroupRole::Billing], 1, MemberStatus::Active),
                ff.p[2].entry(&[GroupRole::Members], 1, MemberStatus::Active),
            ],
            None,
            Some(vec![]),
        );
        ledger.commit(accepted_of(&later, &ff.people())).unwrap();
    })));
    let opened = ledger.open_group_key(
        f.me(),
        GROUP.into(),
        f.own_seal(),
        f.p[0].ml_dsa(),
        None,
        f.p[0].envelope.clone(),
    );
    set(None);
    assert_eq!(opened.unwrap(), 1);
    assert_eq!(ledger.held_seed_versions(GROUP), vec![1]);
    // A lock and an unlock while it was opened: refused, nothing kept.
    let ledger = f.ledger(false, false);
    let ff = Arc::clone(&f);
    set(Some(Box::new(move |ledger: &AreaLedger| {
        ledger.clear();
        let p1 = &ff.p[0];
        ledger
            .open_account(
                p1.user_id.clone(),
                decode("k", &p1.keys.signing_public_key, None).unwrap(),
                p1.root.clone(),
            )
            .unwrap();
    })));
    let locked = ledger.open_group_key(
        f.me(),
        GROUP.into(),
        f.own_seal(),
        f.p[0].ml_dsa(),
        None,
        f.p[0].envelope.clone(),
    );
    set(None);
    assert_eq!(locked.unwrap_err().to_string(), NOT_THIS_ACCOUNT);
    assert!(ledger.held_seed_versions(GROUP).is_empty());
}

#[test]
fn the_outbox_entry_reads_back_as_the_same_bytes_after_a_relaunch_and_only_as_kept() {
    let f = family();
    let ledger = f.ledger(true, true);
    let call = staged(f.admit(&ledger, 4, vec![])).unwrap();
    let expected = OutboxCall::Send {
        outbox_id: call.outbox_id.clone(),
        route: call.route.clone(),
        body: call.body.clone(),
    };
    assert_eq!(f.open(&ledger, &call).unwrap(), expected);
    // A relaunch: a fresh ledger of the same account and settings reads the very same bytes, whatever
    // the family's chain (none committed yet: nothing to answer locally).
    let relaunched = AreaLedger::new();
    let p1 = &f.p[0];
    let signing = decode("k", &p1.keys.signing_public_key, None).unwrap();
    relaunched.open_account(p1.user_id.clone(), signing.clone(), p1.root.clone()).unwrap();
    relaunched.use_settings(p1.user_id.clone(), Some(HashMap::new()), f.contacts()).unwrap();
    assert_eq!(f.open(&relaunched, &call).unwrap(), expected);
    // The admin's pin of them changed (re-checked keys), or there is none: held, never sent.
    let changed = VerifiedPin { user_id: f.p[3].user_id.clone(), ..pin_of(&f.p[4]) };
    let rechecked = f.ledger_of(1, [(f.p[3].user_id.clone(), changed)].into(), true, true);
    let held = OutboxCall::Hold {
        outbox_id: call.outbox_id.clone(),
        route: call.route.clone(),
        reason: OutboxHold::OtherKeys,
    };
    assert_eq!(f.open(&rechecked, &call).unwrap(), held);
    assert_eq!(f.open(&f.ledger_of(1, HashMap::new(), true, true), &call).unwrap(), held);
    // Kept under another id: not this entry, deleted.
    let other_id = ledger.outbox_open(
        GROUP.into(),
        "f0f0f0f0-0000-4000-8000-000000000001".into(),
        p1.user_id.clone(),
        call.entry.clone(),
    );
    assert!(matches!(other_id, Err(CoreError::Sealed(_))));
    // Another family, another root (a master-key rotation): unreadable, deleted.
    let elsewhere = ledger.outbox_open(
        "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b".into(),
        call.outbox_id.clone(),
        p1.user_id.clone(),
        call.entry.clone(),
    );
    assert!(matches!(elsewhere, Err(CoreError::Sealed(_))));
    let rotated = AreaLedger::new();
    rotated.open_account(p1.user_id.clone(), signing, vec![4; 32]).unwrap();
    assert!(matches!(f.open(&rotated, &call), Err(CoreError::Sealed(_))));
    // Asked for another account (an app's mistake), or locked: an input error, and the entry stays.
    let theirs =
        ledger.outbox_open(GROUP.into(), call.outbox_id.clone(), f.p[1].user_id.clone(), call.entry.clone());
    assert!(matches!(theirs, Err(CoreError::Input(_))));
    assert!(matches!(f.open(&AreaLedger::new(), &call), Err(CoreError::Input(_))));
}

#[test]
fn an_outbox_entry_is_held_or_lost_as_the_web_s_outbox_reads_it() {
    let f = family();
    let ledger = f.ledger(true, true);
    let call = staged(f.roles(&ledger, 2, MembersRole::Grant)).unwrap();
    let p1 = &f.p[0];
    let open = |value: &Value| {
        let sealed = outbox_entry_seal(&p1.root, &p1.user_id, GROUP, value).unwrap();
        ledger.outbox_open(GROUP.into(), call.outbox_id.clone(), p1.user_id.clone(), sealed)
    };
    let entry =
        crate::device_record::device_store_open_value(&p1.root, &p1.user_id, GROUP, OUTBOX, &call.entry)
            .unwrap();
    let with = |key: &str, value: Value| {
        let mut out = entry.clone();
        out[key] = value;
        out
    };
    // The exact text is kept and given back; a web entry's object body reads too.
    assert_eq!(entry["body"], json!(call.body));
    assert!(matches!(open(&entry), Ok(OutboxCall::Send { .. })));
    let object = with("body", serde_json::from_str::<Value>(&call.body).unwrap());
    assert!(matches!(open(&object), Ok(OutboxCall::Send { .. })));
    let id = call.outbox_id.clone();
    let route = call.route.clone();
    assert_eq!(
        open(&with("state", json!("awaiting-check"))).unwrap(),
        OutboxCall::Hold { outbox_id: id.clone(), route: route.clone(), reason: OutboxHold::AwaitingCheck }
    );
    assert_eq!(
        open(&with("state", json!("committed"))).unwrap(),
        OutboxCall::Hold { outbox_id: id, route, reason: OutboxHold::Committed }
    );
    // Not an entry: another version, id or family, no body, a body that is no object, an unknown route.
    for broken in [
        with("v", json!(2)),
        with("id", json!("")),
        with("id", json!(7)),
        with("groupId", json!("0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b")),
        with("state", json!("sent")),
        with("body", json!(null)),
        with("body", json!("[1]")),
        with("stagedEnvelope", json!(null)),
        with("route", json!({ "kind": "join", "userId": f.p[1].user_id })),
        with("route", json!({ "kind": "member", "userId": "Not-An-Id" })),
    ] {
        assert!(matches!(open(&broken), Err(CoreError::Sealed(_))), "{broken}");
    }
}

#[test]
fn the_answer_table_moves_an_entry_only_on_a_definite_answer() {
    let at = |status, code: Option<&str>| outbox_step(status, code.map(str::to_string));
    assert_eq!(at(200, None), OutboxStep::Landed);
    assert_eq!(at(299, None), OutboxStep::Landed);
    assert_eq!(at(300, None), OutboxStep::Resend);
    assert_eq!(at(400, None), OutboxStep::Resend);
    assert_eq!(at(401, Some("signed-out")), OutboxStep::Resend);
    assert_eq!(at(429, Some("rate-limited")), OutboxStep::Resend);
    assert_eq!(at(499, Some("held")), OutboxStep::Refused);
    assert_eq!(at(500, Some("invalid")), OutboxStep::Resend);
    assert_eq!(at(409, Some("members-changed")), OutboxStep::MembershipMoved);
    assert_eq!(at(409, Some("left-due")), OutboxStep::MembershipMoved);
    assert_eq!(at(409, Some("rotating")), OutboxStep::Rebuild);
    assert_eq!(at(403, Some("forbidden")), OutboxStep::Refused);
    assert_eq!(at(404, Some("not-member")), OutboxStep::Wiped);
    assert_eq!(at(410, Some("not-member")), OutboxStep::Refused);
}

#[test]
fn the_admin_s_join_code_is_the_admitting_roster_s_and_only_for_the_keys_they_checked() {
    let f = family();
    let ledger = f.ledger(false, false);
    let chain = f.chain();
    let code = |ledger: &AreaLedger, who: usize, rosters: Vec<SignedGroupStatement>| {
        ledger.member_join_code(GROUP.into(), f.p[who - 1].user_id.clone(), rosters)
    };
    let all = f.h.rosters.clone();
    assert_eq!(
        code(&ledger, 2, all.clone()).unwrap(),
        MemberJoinCode::Code { roster_version: 2, code: code_at(&chain, 2).unwrap() }
    );
    // Never checked here: no code.
    assert_eq!(
        code(&f.ledger_of(1, HashMap::new(), false, false), 2, all.clone()).unwrap(),
        MemberJoinCode::NotPinned
    );
    // A pin of person 2 that holds person 3's keys: no code.
    let wrong = VerifiedPin { user_id: f.p[1].user_id.clone(), ..pin_of(&f.p[2]) };
    let other = f.ledger_of(1, [(f.p[1].user_id.clone(), wrong)].into(), false, false);
    assert_eq!(code(&other, 2, all.clone()).unwrap(), MemberJoinCode::OtherKeys { roster_version: 2 });
    assert_eq!(code(&ledger, 4, all.clone()).unwrap(), MemberJoinCode::NotAdmitted);
    // A roster beside the chain changes nothing; one of the run left out is refused.
    let mut beside = all.clone();
    let mut fork = f.h.clone();
    fork.statements.pop();
    fork.rosters.pop();
    fork.roster_with(
        &f.p[0],
        vec![
            f.p[0].entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active),
            f.p[1].entry(&[GroupRole::Billing], 1, MemberStatus::Active),
        ],
        None,
        Some(vec![]),
    );
    beside.push(fork.rosters[1].clone());
    assert_eq!(
        code(&ledger, 2, beside).unwrap(),
        MemberJoinCode::Code { roster_version: 2, code: code_at(&chain, 2).unwrap() }
    );
    assert!(code(&ledger, 2, vec![all[0].clone()]).is_err());
    // Nothing committed: sync first, no code.
    let uncommitted = f.ledger(false, false);
    uncommitted.uncommit(GROUP.into(), false);
    assert_eq!(code(&uncommitted, 2, all).unwrap(), MemberJoinCode::SyncFirst);
}

#[test]
fn owed_grants_are_each_folder_s_current_key_from_any_active_member() {
    let f = family();
    // Person 2, a plain member, owes person 3 both live folders (route 3's due.grants).
    let ledger = f.ledger_of(2, HashMap::new(), false, true);
    let owed = |workspace_id: &str, who: usize| OwedGrant {
        workspace_id: workspace_id.into(),
        user_id: f.p[who - 1].user_id.clone(),
        kem_public_key: f.p[who - 1].keys.kem_public_key.clone().unwrap(),
    };
    let grants = |ledger: &AreaLedger, missing| {
        ledger.grants_body(f.me_of(2), f.p[1].envelope.clone(), GROUP.into(), missing)
    };
    let GrantsCall::Grants { requests } = grants(&ledger, vec![owed(AREA, 3), owed(&third(), 3)]).unwrap()
    else {
        panic!("granted");
    };
    assert_eq!(
        requests.iter().map(|r| r.workspace_id.clone()).collect::<Vec<_>>(),
        vec![AREA.to_string(), third()]
    );
    let chain = f.chain();
    let mut opened = vec![];
    for request in &requests {
        let body: Value = serde_json::from_str(&request.body).unwrap();
        for grant in body["grants"].as_array().unwrap() {
            assert_eq!(grant["workspaceId"], json!(request.workspace_id));
        }
        // Granted by person 2: opened under their keys.
        for grant in body["grants"].as_array().unwrap() {
            let grantee = &f.p[2];
            let ws = grant["workspaceId"].as_str().unwrap().to_string();
            let key = area_grant_open(
                decode("k", grant["envelope"].as_str().unwrap(), None).unwrap(),
                AreaGrantContext {
                    group_id: GROUP.into(),
                    workspace_id: ws.clone(),
                    workspace_key_version: grant["workspaceKeyVersion"].as_u64().unwrap(),
                    grantee_user_id: grantee.user_id.clone(),
                    grantee_key_version: 1,
                    granter_user_id: f.p[1].user_id.clone(),
                    roster_version: 2,
                    roster_digest: chain.roster_digest.clone(),
                },
                Arc::clone(&chain),
                if ws == AREA { AREA_SEED.into() } else { THIRD_SEED.into() },
                f.p[1].ml_dsa(),
                None,
                grantee.user_id.clone(),
                1,
                grantee.keys.clone(),
            )
            .unwrap();
            opened.push((ws, grant["workspaceKeyVersion"].as_u64().unwrap(), key.to_vec()));
        }
    }
    opened.sort();
    let mut expected = vec![(AREA.to_string(), 1, AREA_KEY.to_vec()), (third(), 2, third_key(2))];
    expected.sort();
    assert_eq!(opened, expected);
    // A folder this device has not opened, beside one it has: open it first, never another folder's key.
    let only_area = f.ledger_of(2, HashMap::new(), false, false);
    only_area.open_area(GROUP.into(), AREA.into(), AREA_SEED.into(), 1, AREA_KEY.to_vec(), 1).unwrap();
    assert_eq!(grants(&only_area, vec![owed(&third(), 3)]).unwrap(), GrantsCall::OpenFoldersFirst);
    // Someone not in the family now: refused; a folder not opened here: open it first; no chain: sync.
    assert!(grants(&ledger, vec![owed(AREA, 4)]).is_err());
    assert_eq!(
        grants(&f.ledger_of(2, HashMap::new(), false, false), vec![owed(AREA, 3)]).unwrap(),
        GrantsCall::OpenFoldersFirst
    );
    let uncommitted = f.ledger_of(2, HashMap::new(), false, true);
    uncommitted.uncommit(GROUP.into(), false);
    assert_eq!(grants(&uncommitted, vec![owed(AREA, 3)]).unwrap(), GrantsCall::SyncFirst);
}

#[test]
fn only_the_current_group_key_s_seed_is_kept_and_a_later_key_or_a_forget_drops_it() {
    let f = family();
    let ledger = f.ledger(true, false);
    assert_eq!(ledger.held_seed_versions(GROUP), vec![1]);
    // Sealed to another identity than the one given: refused, nothing kept.
    let fresh = f.ledger(false, false);
    let refused = fresh.open_group_key(
        f.me(),
        GROUP.into(),
        f.own_seal(),
        f.p[0].ml_dsa(),
        None,
        f.p[1].envelope.clone(),
    );
    assert!(refused.is_err());
    assert!(fresh.held_seed_versions(GROUP).is_empty());
    // A commit that replaces the key drops the seed of the old one.
    let mut later = f.h.clone();
    later.roster_with(
        &f.p[0],
        vec![
            f.p[0].entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active),
            f.p[1].entry(&[], 1, MemberStatus::Active),
            f.p[2].entry(&[], 1, MemberStatus::Active),
        ],
        None,
        Some(vec![]),
    );
    later.succession(&f.p[0]);
    ledger.commit(accepted_of(&later, &f.people())).unwrap();
    assert!(ledger.held_seed_versions(GROUP).is_empty());
    // A seal of a key the family has replaced opens, but its seed is not kept: it signs nothing now.
    let at_two = AreaLedger::new();
    let p1 = &f.p[0];
    at_two
        .open_account(
            p1.user_id.clone(),
            decode("k", &p1.keys.signing_public_key, None).unwrap(),
            p1.root.clone(),
        )
        .unwrap();
    at_two.commit(accepted_of(&later, &f.people())).unwrap();
    assert_eq!(
        at_two
            .open_group_key(f.me(), GROUP.into(), f.own_seal(), p1.ml_dsa(), None, p1.envelope.clone())
            .unwrap(),
        1
    );
    assert!(at_two.held_seed_versions(GROUP).is_empty());
    let kept = f.ledger(true, false);
    crate::area_ledger::forget_fully(&kept, GROUP);
    assert!(kept.held_seed_versions(GROUP).is_empty());
    let cleared = f.ledger(true, false);
    cleared.clear();
    assert!(cleared.held_seed_versions(GROUP).is_empty());
}

#[test]
fn a_member_whose_entry_still_names_their_earlier_keys_folds_them_in_before_any_other_call() {
    let f = family();
    let (next, _) = f.p[0].succeed();
    // The account unlocked with its new identity; the family's entry still names the earlier one.
    let ledger = AreaLedger::new();
    let signing = decode("k", &next.keys.signing_public_key, None).unwrap();
    ledger.open_account(next.user_id.clone(), signing, next.root.clone()).unwrap();
    ledger
        .use_settings(next.user_id.clone(), Some([(GROUP.to_string(), f.pin())].into()), f.contacts())
        .unwrap();
    let me = OwnIdentities {
        user_id: next.user_id.clone(),
        identities: vec![f.p[0].served_keys(), next.served_keys()],
    };
    let accepted = ledger.accept_served(
        me.clone(),
        GROUP.into(),
        None,
        f.served(f.h.rosters.clone()),
        FamilyGuard::Absent,
        CHECKED.into(),
    );
    assert!(matches!(accepted, Ok(ServedAcceptance::Accepted { .. })), "{accepted:?}");
    ledger
        .open_group_key(
            me.clone(),
            GROUP.into(),
            f.own_seal(),
            f.p[0].ml_dsa(),
            None,
            f.p[0].envelope.clone(),
        )
        .unwrap();
    let refused = ledger.roles_body(
        me,
        next.envelope.clone(),
        GROUP.into(),
        7,
        f.p[1].user_id.clone(),
        MembersRole::Grant,
        f.kems(),
    );
    assert_eq!(message(refused), STALE_ENTRY);
}

#[test]
fn an_entry_is_superseded_only_by_a_head_that_passed_through_its_own_and_its_id_compares_without_case() {
    let f = family();
    let ledger = f.ledger(true, true);
    let call = staged(f.roles(&ledger, 2, MembersRole::Grant)).unwrap();
    let p1 = &f.p[0];
    let entry =
        crate::device_record::device_store_open_value(&p1.root, &p1.user_id, GROUP, OUTBOX, &call.entry)
            .unwrap();
    let previous = entry["previousRosterDigest"].as_str().unwrap().to_string();
    let read = |id: &str, head: Vec<String>| outbox_entry_read(&entry, GROUP, Some(id), None, Some(&head));
    // A head that never held the call's own head (another history, a cut): no local answer, the bytes go.
    assert!(matches!(read(&call.outbox_id, vec!["elsewhere".into()]), Some(OutboxCall::Send { .. })));
    // One that passed through it and moved on: superseded.
    assert!(matches!(
        read(&call.outbox_id, vec![previous.clone(), "later".into()]),
        Some(OutboxCall::Superseded { .. })
    ));
    // The kept id in capitals is the same entry.
    assert!(matches!(read(&call.outbox_id.to_uppercase(), vec![previous]), Some(OutboxCall::Send { .. })));
}

#[test]
fn owed_grants_are_made_once_whatever_the_case_of_their_ids() {
    let f = family();
    let ledger = f.ledger_of(2, HashMap::new(), false, true);
    let owed = OwedGrant {
        workspace_id: AREA.to_uppercase(),
        user_id: f.p[2].user_id.to_uppercase(),
        kem_public_key: f.p[2].keys.kem_public_key.clone().unwrap(),
    };
    let GrantsCall::Grants { requests } = ledger
        .grants_body(f.me_of(2), f.p[1].envelope.clone(), GROUP.into(), vec![owed.clone(), owed])
        .unwrap()
    else {
        panic!("granted");
    };
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].workspace_id, AREA);
    let body: Value = serde_json::from_str(&requests[0].body).unwrap();
    assert_eq!(body["grants"].as_array().unwrap().len(), 1);
}

/*
 * First-seen pins all hold "" as their fingerprint, so an admission is told by
 * the key commitment it was staged over (docs/optional-verification.md 2.2):
 * a Continue between staging and sending moves the pin to other keys, and the
 * grants sealed to the old ones must never go, here or after a relaunch.
 */
#[test]
fn a_kept_admission_goes_only_to_the_keys_it_was_staged_over_by_their_commitment() {
    let f = family();
    let ledger = f.ledger(true, true);
    let call = staged(f.admit(&ledger, 4, vec![])).unwrap();
    let p1 = &f.p[0];
    let staged_pin = pin_of(&f.p[3]);
    let commitment = |pin: &VerifiedPin| {
        crate::key_commitment(crate::PinKeys {
            key_version: Some(pin.key_version),
            encryption_public_key: pin.encryption_public_key.clone(),
            signing_public_key: pin.signing_public_key.clone(),
            ml_dsa_public_key_hash: Some(pin.ml_dsa_public_key_hash.clone()),
            kem_public_key_hash: Some(pin.kem_public_key_hash.clone()),
            fingerprint: String::new(),
        })
        .unwrap()
    };
    // The entry names the keys by their commitment, and not by the pin's fingerprint.
    let entry =
        crate::device_record::device_store_open_value(&p1.root, &p1.user_id, GROUP, OUTBOX, &call.entry)
            .unwrap();
    assert_eq!(entry["admits"], json!({ "userId": f.p[3].user_id, "keys": commitment(&staged_pin) }));
    let send = OutboxCall::Send {
        outbox_id: call.outbox_id.clone(),
        route: call.route.clone(),
        body: call.body.clone(),
    };
    let held = OutboxCall::Hold {
        outbox_id: call.outbox_id.clone(),
        route: call.route.clone(),
        reason: OutboxHold::OtherKeys,
    };
    // After a relaunch with the admin's pin of them first-seen over other keys: held, never sent.
    let other = pin_of(&f.p[4]);
    let first_seen = VerifiedPin { fingerprint: String::new(), ..staged_pin.clone() };
    let moved = [
        (
            "their X25519 and Ed25519 keys",
            VerifiedPin {
                encryption_public_key: other.encryption_public_key.clone(),
                signing_public_key: other.signing_public_key.clone(),
                ..first_seen.clone()
            },
        ),
        (
            "only their ML-DSA and ML-KEM keys",
            VerifiedPin {
                ml_dsa_public_key_hash: other.ml_dsa_public_key_hash.clone(),
                kem_public_key_hash: other.kem_public_key_hash.clone(),
                ..first_seen.clone()
            },
        ),
        (
            "only their ML-KEM key",
            VerifiedPin { kem_public_key_hash: other.kem_public_key_hash.clone(), ..first_seen.clone() },
        ),
    ];
    for (what, pin) in moved {
        let relaunched = f.ledger_of(1, [(f.p[3].user_id.clone(), pin)].into(), true, true);
        assert_eq!(f.open(&relaunched, &call).unwrap(), held, "{what}");
    }
    // The same keys, first-seen now: still the keys it was staged over.
    let same = f.ledger_of(1, [(f.p[3].user_id.clone(), first_seen)].into(), true, true);
    assert_eq!(f.open(&same, &call).unwrap(), send);

    // Entries as other versions kept them, read with the admin's pin by its commitment.
    let user = f.p[3].user_id.as_str();
    let read = |admits: Value, keys: &str| {
        let mut kept = entry.clone();
        kept["admits"] = admits;
        outbox_entry_read(&kept, GROUP, Some(&call.outbox_id), Some((user, keys)), None)
    };
    let (theirs, others) = (commitment(&staged_pin), commitment(&other));
    // From before: only `fingerprint`, sent exactly when the pin's key commitment is it.
    let older = json!({ "userId": user, "fingerprint": staged_pin.fingerprint });
    assert_eq!(read(older.clone(), &theirs), Some(send.clone()));
    assert_eq!(read(older, &others), Some(held.clone()));
    // A first-seen pin's "" matches nothing, not even another "".
    let blank = json!({ "userId": user, "fingerprint": "" });
    assert_eq!(read(blank.clone(), ""), Some(held.clone()));
    assert_eq!(read(blank, &theirs), Some(held.clone()));
    // Both fields: `keys` decides, `fingerprint` is ignored; `keys` not a string holds.
    let both = json!({ "userId": user, "keys": others, "fingerprint": staged_pin.fingerprint });
    assert_eq!(read(both.clone(), &theirs), Some(held.clone()));
    assert_eq!(read(both, &others), Some(send.clone()));
    let broken = json!({ "userId": user, "keys": null, "fingerprint": staged_pin.fingerprint });
    assert_eq!(read(broken, &theirs), Some(held));
}

/* Core 5b ------------------------------------------------------------------- */

const AREA_ROOT: &str = "0e0e0e0e-0000-4000-8000-0000000000a1";
const THIRD_ROOT: &str = "0e0e0e0e-0000-4000-8000-0000000000a3";
const AREA_ROOT_KEY: [u8; 32] = [61; 32];
const THIRD_ROOT_KEY: [u8; 32] = [64; 32];
/* Person 1's account key, rotated once: its self-grants name 2 while their identity is still at 1. */
const ACCOUNT_KEY: u64 = 2;
const TAGS: &str = r#"{"version":2,"tags":[{"id":"t1","name":"Recipes"}],"items":{}}"#;

/* A folder's root as the rotation work serves it: its key under the area key at `version`, its name under its key. */
fn root_at(
    workspace_id: &str,
    node_id: &str,
    version: u64,
    area_key: &[u8],
    root_key: &[u8],
) -> RotatingNode {
    let ctx = crate::drive::NodeKeyContext {
        workspace_id: workspace_id.into(),
        node_id: node_id.into(),
        parent_id: workspace_id.into(),
        parent_key_epoch: version,
        key_epoch: version,
    };
    let metadata = crate::drive::metadata_seal(
        crate::drive::MetadataContext {
            workspace_id: workspace_id.into(),
            node_id: node_id.into(),
            metadata_version: 1,
        },
        root_key.to_vec(),
        crate::drive::NodeMetadata {
            name: "Family".into(),
            mime: None,
            size: None,
            modified: None,
            attributes: Default::default(),
        },
    )
    .unwrap();
    RotatingNode {
        node_id: node_id.into(),
        parent_id: workspace_id.into(),
        parent_key_epoch: version + 1,
        key_epoch: version,
        wrapped_parent_key_epoch: version,
        key_envelope: crate::drive::node_wrap(ctx, area_key.to_vec(), root_key.to_vec()).unwrap(),
        kind: crate::NodeKind::Folder,
        metadata_version: 1,
        metadata_envelope: metadata,
        metadata_signer: None,
        metadata_signature: None,
        metadata_rekey: None,
        versions: vec![],
        share_ids: vec![],
        link_ids: vec![],
    }
}

fn document(workspace_id: &str, kind: &str, version: u64, key: &[u8], text: &str) -> ServedDocument {
    let ctx = crate::drive::DocumentContext { workspace_id: workspace_id.into(), kind: kind.into(), version };
    ServedDocument {
        kind: kind.into(),
        version,
        envelope: crate::drive::document_seal(ctx, key.to_vec(), text.into()).unwrap(),
    }
}

/* Every live folder's rotation: AREA (key 1) with its tags, THIRD (key 2) with tags nobody can open. */
fn rotations() -> Vec<AreaRotation> {
    vec![
        AreaRotation {
            workspace_id: AREA.into(),
            target_epoch: 9,
            root: root_at(AREA, AREA_ROOT, 1, &AREA_KEY, &AREA_ROOT_KEY),
            change_seq: 4,
            documents: vec![document(AREA, "tags", 3, &AREA_KEY, TAGS)],
        },
        AreaRotation {
            workspace_id: third(),
            target_epoch: 9,
            root: root_at(&third(), THIRD_ROOT, 2, &third_key(2), &THIRD_ROOT_KEY),
            change_seq: 5,
            documents: vec![ServedDocument { kind: "tags".into(), version: 1, envelope: vec![7; 80] }],
        },
    ]
}

impl Family {
    fn remove(
        &self,
        ledger: &AreaLedger,
        who: usize,
        rotations: Vec<AreaRotation>,
    ) -> CoreResult<RosterCall> {
        ledger.removal_body(
            self.me(),
            self.p[0].envelope.clone(),
            GROUP.into(),
            7,
            self.p[who - 1].user_id.clone(),
            rotations,
            vec![],
            ACCOUNT_KEY,
            self.kems(),
        )
    }
}

/* What a rotation wire opens to with the folder's new key: (new root key, previous root key, root name, documents). */
type OpenedRotation = (Vec<u8>, Vec<u8>, String, Vec<(String, u64, String)>);

fn opened_rotation(wire: &Value, area_key: &[u8]) -> OpenedRotation {
    let workspace_id = wire["workspaceId"].as_str().unwrap();
    let node_id = wire["root"]["id"].as_str().unwrap();
    let to_version = wire["toVersion"].as_u64().unwrap();
    let target = wire["targetEpoch"].as_u64().unwrap();
    let d = |value: &Value| decode("k", value.as_str().unwrap(), None).unwrap();
    let ctx = |key_epoch| crate::drive::NodeKeyContext {
        workspace_id: workspace_id.into(),
        node_id: node_id.into(),
        parent_id: workspace_id.into(),
        parent_key_epoch: to_version,
        key_epoch,
    };
    let root =
        crate::drive::node_open(ctx(target), area_key.to_vec(), d(&wire["root"]["keyEnvelope"])).unwrap();
    let previous_epoch = if workspace_id == AREA { 1 } else { 2 };
    let previous = crate::drive::previous_root_key_open(
        ctx(previous_epoch),
        area_key.to_vec(),
        d(&wire["previousRootKeyEnvelope"]),
    )
    .unwrap();
    let name = crate::drive::metadata_open(
        crate::drive::MetadataContext {
            workspace_id: workspace_id.into(),
            node_id: node_id.into(),
            metadata_version: 1,
        },
        root.clone(),
        d(&wire["root"]["rotated"]["metadataEnvelope"]),
    )
    .unwrap()
    .name;
    let documents = wire["documents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|doc| {
            let version = doc["version"].as_u64().unwrap() + 1;
            let kind = doc["kind"].as_str().unwrap().to_string();
            let ctx = crate::drive::DocumentContext {
                workspace_id: workspace_id.into(),
                kind: kind.clone(),
                version,
            };
            (kind, version, crate::drive::document_open(ctx, area_key.to_vec(), d(&doc["envelope"])).unwrap())
        })
        .collect();
    (root, previous, name, documents)
}

#[test]
fn a_removal_rotates_every_live_folder_and_grants_the_new_keys_only_to_those_who_stay() {
    let f = family();
    let ledger = f.ledger(true, true);
    let call = staged(f.remove(&ledger, 2, rotations())).unwrap();
    assert_eq!(call.route, ChainRoute::Remove { user_id: f.p[1].user_id.clone(), ends_lapsed: vec![] });
    // THIRD's tags never opened: carried on empty, and said.
    assert_eq!(call.replaced, vec![ReplacedDocument { workspace_id: third(), kind: "tags".into() }]);
    let body = body_of(&call);
    let after = after_body(&f, &body);
    assert_eq!(after.roster.entry(&f.p[1].user_id).unwrap().status, MemberStatus::Left);
    // Person 2 held no `members`: no succession, the family key stays.
    assert!(body.get("succession").is_none() && body.get("seals").is_none());
    // Each new key to persons 1 and 3 (everyone active after), never to person 2.
    let grants = open_grants(&f, &after, &body["grants"]);
    let mut to: Vec<(String, String, u64)> =
        grants.iter().map(|(who, at, version, _)| (who.clone(), at.clone(), *version)).collect();
    to.sort();
    let mut expected = vec![
        (f.p[0].user_id.clone(), AREA.to_string(), 2),
        (f.p[2].user_id.clone(), AREA.to_string(), 2),
        (f.p[0].user_id.clone(), third(), 3),
        (f.p[2].user_id.clone(), third(), 3),
    ];
    expected.sort();
    assert_eq!(to, expected);
    let key_of = |at: &str| grants.iter().find(|(_, ws, _, _)| ws == at).unwrap().3.clone();
    assert!(grants.iter().all(|(_, ws, _, key)| *key == key_of(ws)));
    for wire in body["rotations"].as_array().unwrap() {
        let workspace_id = wire["workspaceId"].as_str().unwrap();
        let (root, previous, name, documents) = opened_rotation(wire, &key_of(workspace_id));
        // The root under its new key (the roster's root commitment), the old one wrapped as its previous.
        assert_eq!(
            after.area_roots.get(workspace_id).unwrap().last(),
            Some(&Some(area_root_commitment(&root).unwrap()))
        );
        let old = if workspace_id == AREA { AREA_ROOT_KEY.to_vec() } else { THIRD_ROOT_KEY.to_vec() };
        assert_eq!(previous, old);
        assert_eq!(name, "Family");
        if workspace_id == AREA {
            assert_eq!(documents, vec![("tags".to_string(), 4, TAGS.to_string())]);
        } else {
            assert_eq!(
                documents,
                vec![("tags".to_string(), 2, r#"{"version":2,"tags":[],"items":{}}"#.to_string())]
            );
        }
        // The self-grant names the account key (2), never the identity's key version (1).
        assert_eq!(wire["selfGrant"]["keyVersion"], json!(ACCOUNT_KEY));
        assert!(wire["selfGrant"]["encryptedKey"].is_string());
    }
    assert!(body["grants"].as_array().unwrap().iter().all(|grant| grant["granteeKeyVersion"] == json!(1)));
    // An account key version no self-grant can name is refused before anything is built.
    for version in [0, 1 << 53] {
        let refused = ledger.removal_body(
            f.me(),
            f.p[0].envelope.clone(),
            GROUP.into(),
            7,
            f.p[1].user_id.clone(),
            rotations(),
            vec![],
            version,
            f.kems(),
        );
        assert_eq!(message(refused), "Invalid account key version.");
    }
}

/*
 * A document the web reads goes on as written, whatever a serde_json::Value would refuse (a tag
 * named by a lone surrogate, a number past an f64); one JSON.parse refuses (a trailing no-break
 * space is no JSON whitespace) goes on empty, as the worker carries it.
 */
#[test]
fn a_rotation_carries_every_document_the_web_reads_as_written() {
    const ODD: &str = r#"{"version":2,"tags":[{"id":"t1","name":"\ud800"}],"items":{},"n":1e400}"#;
    let f = family();
    let ledger = f.ledger(true, true);
    let mut all = rotations();
    all[0].documents = vec![document(AREA, "tags", 3, &AREA_KEY, ODD)];
    all[1].documents = vec![document(&third(), "tags", 1, &third_key(2), "{\"version\":2}\u{a0}")];
    let call = staged(f.remove(&ledger, 2, all)).unwrap();
    assert_eq!(call.replaced, vec![ReplacedDocument { workspace_id: third(), kind: "tags".into() }]);
    let body = body_of(&call);
    let after = after_body(&f, &body);
    let grants = open_grants(&f, &after, &body["grants"]);
    let key_of = |at: &str| grants.iter().find(|(_, ws, _, _)| ws == at).unwrap().3.clone();
    let wire =
        body["rotations"].as_array().unwrap().iter().find(|w| w["workspaceId"] == json!(AREA)).unwrap();
    let (_, _, _, documents) = opened_rotation(wire, &key_of(AREA));
    assert_eq!(documents, vec![("tags".to_string(), 4, ODD.to_string())]);
}

#[test]
fn a_removal_that_leaves_a_live_folder_unrotated_is_refused_before_anything_is_signed() {
    let f = family();
    let ledger = f.ledger(true, true);
    let all = rotations();
    // THIRD left out, AREA twice, and none at all: refused alike.
    assert_eq!(message(f.remove(&ledger, 2, vec![all[0].clone()])), EVERY_FOLDER);
    assert_eq!(message(f.remove(&ledger, 2, vec![all[0].clone(), all[0].clone()])), EVERY_FOLDER);
    assert_eq!(message(f.remove(&ledger, 2, vec![])), EVERY_FOLDER);
    // The deleted folder named in THIRD's place.
    let mut deleted = all[1].clone();
    deleted.workspace_id = SECOND.into();
    assert_eq!(message(f.remove(&ledger, 2, vec![all[0].clone(), deleted])), EVERY_FOLDER);
    // Someone not in the family now.
    assert_eq!(message(f.remove(&ledger, 4, rotations())), NOT_IN);
    // A folder not open here: asked for first, before anything is signed.
    assert_eq!(f.remove(&f.ledger(true, false), 2, rotations()).unwrap(), RosterCall::OpenFoldersFirst);
}

#[test]
fn removing_a_manager_replaces_the_family_key_and_seals_it_only_to_those_who_keep_it() {
    let f = family();
    let ledger = f.ledger(true, true);
    let body = body_of(&staged(f.remove(&ledger, 3, rotations())).unwrap());
    let after = after_body(&f, &body);
    assert_eq!(after.group_key_version, 2);
    let seals = body["seals"].as_array().unwrap();
    assert_eq!(seals.len(), 1);
    assert_eq!(seals[0]["holderUserId"], json!(f.p[0].user_id));
}

#[test]
fn a_deletion_carries_exactly_one_tombstone_and_nothing_else() {
    let f = family();
    let ledger = f.ledger(true, true);
    let call = staged(ledger.area_delete_body(
        f.me(),
        f.p[0].envelope.clone(),
        GROUP.into(),
        7,
        AREA.into(),
        f.kems(),
    ))
    .unwrap();
    assert_eq!(call.route, ChainRoute::Delete { workspace_id: AREA.into() });
    let body = body_of(&call);
    let mut keys: Vec<&String> = body.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, vec!["expectedRevision", "roster"]);
    let roster = parse_roster(&signed_of(&body["roster"]).statement).unwrap();
    assert_eq!(roster.areas.len(), 1);
    assert!(roster.areas[0].retired && roster.areas[0].workspace_id == AREA);
    assert!(after_body(&f, &body).retired_areas.contains(&AREA.to_string()));
    // A folder already deleted, or never the family's: refused before signing.
    let delete = |workspace_id: &str| {
        message(ledger.area_delete_body(
            f.me(),
            f.p[0].envelope.clone(),
            GROUP.into(),
            7,
            workspace_id.into(),
            f.kems(),
        ))
    };
    assert_eq!(delete(SECOND), NOT_ON_LIST);
    assert_eq!(delete("f0f0f0f0-0000-4000-8000-00000000000f"), NOT_ON_LIST);
}

/*
 * After `document-stale` (or `root-moved`, `epoch-stale`) the folder is gathered again and only its
 * rotation is made again: the same signed roster, grants and self-grants, the same new keys, its
 * documents at their new versions; the kept entry becomes the rebuilt call.
 */
#[test]
fn a_rebuild_reseals_what_was_gathered_again_under_the_same_keys_and_roster() {
    const NEWER: &str = r#"{"version":2,"tags":[{"id":"t2","name":"Trips"}],"items":{}}"#;
    let f = family();
    let ledger = f.ledger(true, true);
    let call = staged(f.remove(&ledger, 2, rotations())).unwrap();
    let body = body_of(&call);
    let after = after_body(&f, &body);
    let grants = open_grants(&f, &after, &body["grants"]);
    let key_of = |at: &str| grants.iter().find(|(_, ws, _, _)| ws == at).unwrap().3.clone();
    let rebuild = |outbox_id: &str, entry: &str, rotations: Vec<AreaRotation>| {
        ledger.outbox_rebuild(
            f.me(),
            f.p[0].envelope.clone(),
            GROUP.into(),
            outbox_id.into(),
            entry.into(),
            rotations,
        )
    };
    // A member wrote AREA's tags after the call was built: gathered again at version 4.
    let mut again = rotations().remove(0);
    again.documents = vec![document(AREA, "tags", 4, &AREA_KEY, NEWER)];
    let rebuilt = rebuild(&call.outbox_id, &call.entry, vec![again.clone()]).unwrap();
    assert_eq!((&rebuilt.outbox_id, &rebuilt.route), (&call.outbox_id, &call.route));
    assert!(rebuilt.replaced.is_empty());
    let next = body_of(&rebuilt);
    let wire_of = |b: &Value, ws: &str| {
        b["rotations"].as_array().unwrap().iter().find(|w| w["workspaceId"] == json!(ws)).unwrap().clone()
    };
    // Only AREA's rotation is made again: the roster, grants, THIRD and the self-grant byte for byte.
    assert_eq!((&next["roster"], &next["grants"]), (&body["roster"], &body["grants"]));
    assert_eq!(wire_of(&next, &third()), wire_of(&body, &third()));
    assert_eq!(wire_of(&next, AREA)["selfGrant"], wire_of(&body, AREA)["selfGrant"]);
    // Under the new key the grants hand out: the root key the roster commits to, the tags at 5.
    let (root, previous, _, documents) = opened_rotation(&wire_of(&next, AREA), &key_of(AREA));
    assert_eq!(after.area_roots.get(AREA).unwrap().last(), Some(&Some(area_root_commitment(&root).unwrap())));
    assert_eq!(previous, AREA_ROOT_KEY.to_vec());
    assert_eq!(documents, vec![("tags".to_string(), 5, NEWER.to_string())]);
    // The rebuilt entry sends the rebuilt body.
    match ledger
        .outbox_open(GROUP.into(), call.outbox_id.clone(), f.p[0].user_id.clone(), rebuilt.entry.clone())
        .unwrap()
    {
        OutboxCall::Send { body, .. } => assert_eq!(body, rebuilt.body),
        other => panic!("{other:?}"),
    }
    // Kept under another id: no entry. A folder the call does not rotate: refused.
    assert!(matches!(
        rebuild("f0f0f0f0-0000-4000-8000-000000000001", &call.entry, vec![again.clone()]),
        Err(CoreError::Sealed(_))
    ));
    let one = staged(ledger.area_rotation_body(
        f.me(),
        f.p[0].envelope.clone(),
        GROUP.into(),
        7,
        rotations().remove(1),
        ACCOUNT_KEY,
        f.kems(),
    ))
    .unwrap();
    assert_eq!(rebuild(&one.outbox_id, &one.entry, vec![again]).unwrap_err().to_string(), NOT_ROTATED_HERE);
}

#[test]
fn a_key_replacement_rotates_the_one_folder_it_names() {
    let f = family();
    let ledger = f.ledger(true, true);
    let rotation = rotations().remove(0);
    let call = staged(ledger.area_rotation_body(
        f.me(),
        f.p[0].envelope.clone(),
        GROUP.into(),
        7,
        rotation,
        ACCOUNT_KEY,
        f.kems(),
    ))
    .unwrap();
    assert_eq!(call.route, ChainRoute::Rotation { workspace_id: AREA.into() });
    let body = body_of(&call);
    assert!(body.get("rotations").is_none() && body["rotation"]["workspaceId"] == json!(AREA));
    let after = after_body(&f, &body);
    assert_eq!(after.area_keys.get(AREA).map(Vec::len), Some(2));
    assert_eq!(after.area_keys.get(&third()).map(Vec::len), Some(2), "THIRD untouched");
    // Every member active, the remover included, gets the new key.
    assert_eq!(open_grants(&f, &after, &body["grants"]).len(), 3);
}

#[test]
fn a_repair_never_uses_a_served_previous_envelope_s_key() {
    let f = family();
    let ledger = f.ledger(true, true);
    let ctx = crate::drive::NodeKeyContext {
        workspace_id: AREA.into(),
        node_id: AREA_ROOT.into(),
        parent_id: AREA.into(),
        parent_key_epoch: 1,
        key_epoch: 4,
    };
    let wrapped = |key: &[u8]| {
        crate::drive::previous_root_key_wrap(ctx.clone(), AREA_KEY.to_vec(), key.to_vec()).unwrap()
    };
    let root = |envelope: Option<Vec<u8>>| PreviousRoot {
        node_id: AREA_ROOT.into(),
        parent_key_epoch: 1,
        prev_key_envelope: envelope,
        prev_key_epoch: Some(4),
        prev_parent_key_epoch: Some(1),
    };
    let check = |envelope| ledger.previous_root_repair(GROUP.into(), AREA.into(), root(envelope)).unwrap();
    let own = vec![70u8; 32];
    let other = vec![71u8; 32];
    // This device never held the old key: an envelope that opens is taken as it is, one that does not can't be fixed.
    assert_eq!(check(Some(wrapped(&other))), PreviousRootRepair::Opens);
    assert_eq!(check(Some(vec![1; 72])), PreviousRootRepair::Cannot);
    // A key a served envelope gave (not this device's own) repairs nothing.
    ledger.hold_previous_node_key(AREA, AREA_ROOT, other.clone(), 4, false);
    assert_eq!(check(Some(vec![1; 72])), PreviousRootRepair::Cannot);
    // Its own key: the envelope that opens to it is fine; one that opens to another key, or not at all, is wrapped
    // again from its own key, never from the served one.
    ledger.hold_previous_node_key(AREA, AREA_ROOT, own.clone(), 4, true);
    assert_eq!(check(Some(wrapped(&own))), PreviousRootRepair::Opens);
    for served in [Some(wrapped(&other)), Some(vec![1; 72])] {
        let PreviousRootRepair::Repair { previous_root_key_envelope } = check(served) else {
            panic!("no repair")
        };
        assert_eq!(
            crate::drive::previous_root_key_open(ctx.clone(), AREA_KEY.to_vec(), previous_root_key_envelope)
                .unwrap(),
            own
        );
    }
    // No envelope (an empty one is none, as the worker reads ""), or one not under the current key:
    // nothing to check.
    assert_eq!(check(None), PreviousRootRepair::None);
    assert_eq!(check(Some(vec![])), PreviousRootRepair::None);
    let stale = PreviousRoot { prev_parent_key_epoch: Some(0), ..root(Some(wrapped(&own))) };
    assert_eq!(
        ledger.previous_root_repair(GROUP.into(), AREA.into(), stale).unwrap(),
        PreviousRootRepair::None
    );
}
