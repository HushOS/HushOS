use super::*;
use crate::bytes::decode;
use crate::device_record::{ServedAcceptance, ServedChain};
use crate::drive::workspace_open;
use crate::group_trust::{pin_after, AcceptedRosters, OwnIdentities};
use crate::groups::tests::{
    accepted_of, ml_dsa_keys, History, Person, AREA, AREA_KEY, AREA_SEED, GROUP, OTHER_GROUP,
};
use crate::groups::{area_grant_seal, area_root_commitment, GroupRole, MemberStatus, RosterArea};
use crate::ids::derive_id;
use crate::NOT_THIS_ACCOUNT;

const CHECKED: &str = "2026-10-18T00:00:00.000Z";
/* A second folder, derived under GROUP from this seed: key 1 on roster 1, rotated to 2 on roster 2. */
const THIRD_SEED: &str = "AAECAwQFBgcICQoLDA0ODw";

fn third() -> String {
    derive_id(IdKind::Workspace, GROUP.into(), THIRD_SEED.into()).unwrap()
}
fn third_key(version: u64) -> Vec<u8> {
    vec![140 + version as u8; 32]
}
fn row(workspace_id: &str, version: u64, key: &[u8], root: u8) -> RosterArea {
    RosterArea {
        workspace_id: workspace_id.into(),
        workspace_key_version: version,
        commitment: area_key_commitment(key).unwrap(),
        root_commitment: Some(area_root_commitment(&[root; 32]).unwrap()),
        retired: false,
    }
}

/* Person 1 organizes; roster 2 lets person 2 in and rotates THIRD to key version 2. */
struct Family {
    p: Vec<Person>,
    h: History,
}

fn family() -> Family {
    let p: Vec<Person> = (1..=2).map(Person::new).collect();
    let mut h = History { format: 2, ..History::new() };
    let owner = p[0].entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active);
    h.roster_with(
        &p[0],
        vec![owner.clone()],
        None,
        Some(vec![row(AREA, 1, &AREA_KEY, 61), row(&third(), 1, &third_key(1), 62)]),
    );
    h.roster_with(
        &p[0],
        vec![owner, p[1].entry(&[], 1, MemberStatus::Active)],
        None,
        Some(vec![row(&third(), 2, &third_key(2), 63)]),
    );
    Family { p, h }
}

impl Family {
    fn chain(&self) -> Arc<AcceptedRosters> {
        accepted_of(&self.h, &self.p.iter().collect::<Vec<_>>())
    }
    fn p2(&self) -> &Person {
        &self.p[1]
    }

    /* Person 2's ledger: the account open, settings with the family's pin, the history accepted. */
    fn ledger(&self) -> Arc<AreaLedger> {
        let ledger = AreaLedger::new();
        let p = self.p2();
        let signing = decode("k", &p.keys.signing_public_key, None).unwrap();
        ledger.open_account(p.user_id.clone(), signing, p.root.clone()).unwrap();
        let pin = pin_after(vec![], self.chain(), CHECKED.into()).unwrap();
        ledger
            .use_settings(p.user_id.clone(), Some([(GROUP.to_string(), pin)].into()), Default::default())
            .unwrap();
        let me = OwnIdentities { user_id: p.user_id.clone(), identities: vec![p.served_keys()] };
        let served = ServedChain {
            after: 0,
            first_keys: self.h.key(1),
            rosters: self.h.rosters.clone(),
            successions: vec![],
            signer_keys: ml_dsa_keys(&self.p.iter().collect::<Vec<_>>()),
        };
        let accepted = ledger.accept_served(me, GROUP.into(), None, served, CHECKED.into());
        assert!(matches!(accepted, Ok(ServedAcceptance::Accepted { .. })), "{accepted:?}");
        ledger
    }

    /* Person 1's grant of `key` (THIRD's at `version` unless said) to person 2, at the head. */
    fn grant(&self, workspace_id: &str, version: u64, key: &[u8]) -> ServedAreaGrant {
        let chain = self.chain();
        let (p1, p2) = (&self.p[0], self.p2());
        let seed = if workspace_id == AREA { AREA_SEED } else { THIRD_SEED };
        let ctx = AreaGrantContext {
            group_id: GROUP.into(),
            workspace_id: workspace_id.into(),
            workspace_key_version: version,
            grantee_user_id: p2.user_id.clone(),
            grantee_key_version: 1,
            granter_user_id: p1.user_id.clone(),
            roster_version: chain.roster.roster_version,
            roster_digest: chain.roster_digest.clone(),
        };
        let envelope = area_grant_seal(
            key.to_vec(),
            ctx.clone(),
            Arc::clone(&chain),
            seed.into(),
            p2.kem(),
            p1.keys.clone(),
        )
        .unwrap();
        ServedAreaGrant {
            envelope,
            workspace_key_version: version,
            grantee_key_version: 1,
            granter_user_id: p1.user_id.clone(),
            roster_version: ctx.roster_version,
            roster_digest: ctx.roster_digest,
            granter_ml_dsa_public_key: Some(p1.ml_dsa()),
            granter_history: None,
            holder: p2.envelope.clone(),
        }
    }

    /* Person 2's self-grant of `key` for `group`'s `workspace_id` at `version`, under `root`. */
    fn own(&self, group: &str, workspace_id: &str, version: u64, key: &[u8], root: &[u8]) -> WorkspaceGrant {
        self_grant_seal(key, root, &self.p2().user_id, group, workspace_id, 1, version).unwrap()
    }
    fn own_third(&self, version: u64) -> WorkspaceGrant {
        self.own(GROUP, &third(), version, &third_key(version), &self.p2().root)
    }
}

/* Whether the ledger holds a key of THIRD (read_version refuses a listed folder it has not opened). */
fn held(ledger: &AreaLedger) -> bool {
    matches!(ledger.read_version(third()), Ok(Some(_)))
}

fn served(grant: Option<ServedAreaGrant>, self_grant: Option<WorkspaceGrant>) -> ServedArea {
    ServedArea { workspace_id: third(), id_seed: THIRD_SEED.into(), served_version: 2, grant, self_grant }
}

#[test]
fn a_current_self_grant_opens_the_folder_with_no_grant_and_no_granter() {
    let f = family();
    let ledger = f.ledger();
    let opened = ledger.open_family_area(GROUP.into(), served(None, Some(f.own_third(2))), 1).unwrap();
    assert_eq!(
        (opened.from, opened.opened.version, opened.self_grant_to_store.is_none()),
        (AreaKeyFrom::SelfGrant, 2, true)
    );
    assert_eq!(ledger.read_version(third()).unwrap(), Some(2));
    // The granter's identity gone (no key served): the self-grant still opens it.
    let mut gone = f.grant(&third(), 2, &third_key(2));
    gone.granter_ml_dsa_public_key = None;
    let ledger = f.ledger();
    let opened =
        ledger.open_family_area(GROUP.into(), served(Some(gone.clone()), Some(f.own_third(2))), 1).unwrap();
    assert_eq!(opened.from, AreaKeyFrom::SelfGrant);
    // Break-check: without the self-grant that grant cannot be checked, and nothing opens.
    let ledger = f.ledger();
    let refused = ledger.open_family_area(GROUP.into(), served(Some(gone), None), 1).unwrap_err();
    assert_eq!(refused.to_string(), GRANTER_KEY_NEEDED);
    assert!(!held(&ledger), "nothing held");
    let refused = ledger.open_family_area(GROUP.into(), served(None, None), 1).unwrap_err();
    assert_eq!(refused.to_string(), NOT_CHECKED_KEYS);
}

#[test]
fn a_self_grant_is_taken_only_at_the_latest_listed_version_of_the_committed_key() {
    let f = family();
    let p2 = f.p2();
    let ignored: Vec<(&str, ServedArea)> = vec![
        // From before the rotation: a removed member holds that key.
        ("stale", served(None, Some(f.own_third(1)))),
        // The server says the folder moved past it.
        ("served ahead", ServedArea { served_version: 3, ..served(None, Some(f.own_third(2))) }),
        // A version the chain does not list.
        ("beyond listed", served(None, Some(f.own(GROUP, &third(), 3, &third_key(2), &p2.root)))),
        // Another family's self-grant of the same folder id, another folder's, another root's.
        ("other family", served(None, Some(f.own(OTHER_GROUP, &third(), 2, &third_key(2), &p2.root)))),
        ("other folder", served(None, Some(f.own(GROUP, AREA, 2, &third_key(2), &p2.root)))),
        ("other root", served(None, Some(f.own(GROUP, &third(), 2, &third_key(2), &[9u8; 32])))),
        // Sealed right, but not the key the chain committed to at that version.
        ("other key", served(None, Some(f.own(GROUP, &third(), 2, &third_key(1), &p2.root)))),
        ("damaged", served(None, Some(WorkspaceGrant { version: 2, ..f.own_third(2) }))),
    ];
    for (name, area) in ignored {
        let ledger = f.ledger();
        let refused = ledger.open_family_area(GROUP.into(), area, 1).unwrap_err();
        assert_eq!(refused.to_string(), NOT_CHECKED_KEYS, "{name}: ignored, so nothing opens");
        assert!(!held(&ledger), "{name}: nothing held");
    }
}

#[test]
fn an_ignored_self_grant_gives_way_to_the_grant_which_is_wrapped_again_for_the_server() {
    let f = family();
    let ledger = f.ledger();
    let area = served(Some(f.grant(&third(), 2, &third_key(2))), Some(f.own_third(1)));
    let opened = ledger.open_family_area(GROUP.into(), area, 4).unwrap();
    assert_eq!(opened.from, AreaKeyFrom::Grant);
    let stored = opened.self_grant_to_store.expect("a self-grant at the current version");
    assert_eq!(
        (stored.workspace_id.as_str(), stored.workspace_key_version, stored.key_version),
        (third().as_str(), 2, 4)
    );
    // It opens to the folder's key as this family's only, and never as a personal workspace grant.
    let p2 = f.p2();
    assert_eq!(self_grant_open(&p2.root, &p2.user_id, GROUP, &stored).unwrap().to_vec(), third_key(2));
    assert!(self_grant_open(&p2.root, &p2.user_id, OTHER_GROUP, &stored).is_err());
    assert!(workspace_open(p2.user_id.clone(), p2.root.clone(), stored.clone()).is_err());
    // And on the next open it is the self-grant that opens the folder.
    let again = f.ledger().open_family_area(GROUP.into(), served(None, Some(stored)), 4).unwrap();
    assert_eq!(again.from, AreaKeyFrom::SelfGrant);
}

#[test]
fn a_self_grant_is_made_only_for_the_key_both_the_chain_and_the_server_call_current() {
    let f = family();
    // A grant of the older key: it opens (reads), and no self-grant is made of it.
    let old = f.grant(&third(), 1, &third_key(1));
    let opened = f.ledger().open_family_area(GROUP.into(), served(Some(old), None), 1).unwrap();
    assert_eq!((opened.opened.version, opened.self_grant_to_store.is_none()), (1, true));
    // The current key, but the server behind: none either.
    let behind = ServedArea { served_version: 1, ..served(Some(f.grant(&third(), 2, &third_key(2))), None) };
    let opened = f.ledger().open_family_area(GROUP.into(), behind, 1).unwrap();
    assert!(opened.self_grant_to_store.is_none());
    // A folder never rotated, at its only key: made.
    let area = ServedArea {
        workspace_id: AREA.into(),
        id_seed: AREA_SEED.into(),
        served_version: 1,
        grant: Some(f.grant(AREA, 1, &AREA_KEY)),
        self_grant: None,
    };
    let opened = f.ledger().open_family_area(GROUP.into(), area, 1).unwrap();
    assert_eq!(opened.self_grant_to_store.map(|own| own.workspace_key_version), Some(1));
    assert!(f.ledger().open_family_area(GROUP.into(), served(None, None), 0).is_err(), "no key version 0");
}

#[test]
fn nothing_opens_without_the_committed_chain_the_folder_s_family_or_this_account() {
    let f = family();
    let ledger = f.ledger();
    // A fork or a refusal holds the family back: nothing opens, a self-grant included.
    ledger.uncommit(GROUP.into(), true);
    let refused = ledger.open_family_area(GROUP.into(), served(None, Some(f.own_third(2))), 1).unwrap_err();
    assert_eq!(refused.to_string(), NO_CHAIN);
    let ledger = f.ledger();
    let foreign = ServedArea { id_seed: AREA_SEED.into(), ..served(None, Some(f.own_third(2))) };
    assert_eq!(ledger.open_family_area(GROUP.into(), foreign, 1).unwrap_err().to_string(), NOT_THE_FAMILYS);
    // The grant opened only with this account's own identity at its key version.
    let mut grant = f.grant(&third(), 2, &third_key(2));
    grant.holder = f.p[0].envelope.clone();
    let refused = ledger.open_family_area(GROUP.into(), served(Some(grant), None), 1).unwrap_err();
    assert_eq!(refused.to_string(), NOT_OWN_IDENTITY);
    // Locked: nothing.
    ledger.clear();
    assert!(ledger.open_family_area(GROUP.into(), served(None, Some(f.own_third(2))), 1).is_err());
}

#[test]
fn a_lock_or_another_root_while_the_key_opened_holds_nothing() {
    let f = family();
    for (name, change) in [
        ("lock", Box::new(|ledger: &AreaLedger| ledger.clear()) as Box<dyn Fn(&AreaLedger)>),
        (
            "rotated root",
            Box::new(|ledger: &AreaLedger| {
                let state = ledger.unlocked().unwrap();
                let account = ledger.served_account().unwrap();
                ledger.open_account(state.0, account.signing_public_key, vec![5u8; 32]).unwrap();
            }),
        ),
    ] {
        let ledger = f.ledger();
        AFTER_OPENING_AREA.with(|hook| *hook.borrow_mut() = Some(change));
        let refused =
            ledger.open_family_area(GROUP.into(), served(Some(f.grant(&third(), 2, &third_key(2))), None), 1);
        AFTER_OPENING_AREA.with(|hook| *hook.borrow_mut() = None);
        assert_eq!(refused.unwrap_err().to_string(), NOT_THIS_ACCOUNT, "{name}");
        assert!(!held(&ledger), "{name}: nothing held");
    }
}

#[test]
fn a_self_grant_below_the_chain_is_ignored_even_when_the_server_serves_its_version() {
    let f = family();
    // The server behind (serving key 1) and the self-grant at 1: the chain's 2 decides.
    let behind = ServedArea { served_version: 1, ..served(None, Some(f.own_third(1))) };
    let ledger = f.ledger();
    assert_eq!(ledger.open_family_area(GROUP.into(), behind, 1).unwrap_err().to_string(), NOT_CHECKED_KEYS);
    assert!(!held(&ledger));
}

#[test]
fn a_self_grant_of_another_key_gives_way_to_the_grant_never_to_a_refusal() {
    let f = family();
    // Wrapped right by this account, but of the key the chain lists at 1, claimed at 2.
    let other_key = f.own(GROUP, &third(), 2, &third_key(1), &f.p2().root);
    let area = served(Some(f.grant(&third(), 2, &third_key(2))), Some(other_key));
    let opened = f.ledger().open_family_area(GROUP.into(), area, 1).unwrap();
    assert_eq!((opened.from, opened.opened.version), (AreaKeyFrom::Grant, 2));
}
