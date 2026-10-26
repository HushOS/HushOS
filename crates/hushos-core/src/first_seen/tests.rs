//! First-seen pins and the device's guard (docs/optional-verification.md 2.2,
//! 2.5, 2.6, 2.8), as packages/crypto's `pins.test.ts` and `first-seen.test.ts`
//! and packages/drive's `trust.test.ts` hold the web twin. Every case is one a
//! server that keeps the settings could try: pass a first-seen pin off as a
//! check, carry a legacy pin into trust on keys the person never pinned,
//! replay an older or forked copy of the settings over the one a device acted
//! on, or hand a device a succession that starts from keys it never held.

use super::*;
use crate::bytes::{encode, random};
use crate::contacts::{identity_fingerprint, pin_verified, settings_seal};
use crate::identity::{identity_create, identity_open, identity_succeed, public_identity, IdentityEnvelope};
use crate::identity::{succession_chain_verify, PinnedKeys};
use crate::signatures::{
    keys_statement, metadata_integrity, metadata_sign, sign_hybrid, signing_public_key, succession_statement,
    Integrity, MetadataStatement, NodeKind, TrustedKeys,
};
use serde_json::json;

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "33333333-3333-4333-8333-333333333333";

fn fill(byte: u8, len: usize) -> String {
    encode(&vec![byte; len])
}
fn hex(byte: u8) -> String {
    format!("{byte:02x}").repeat(32)
}
/* A pin over keys made of four fill bytes: verified (the version 3 fingerprint) or first-seen (""). */
fn pin(x: u8, ed: u8, ml_dsa: u8, kem: u8, verified: bool) -> PinKeys {
    let fingerprint = if verified {
        identity_fingerprint(vec![x; 32], vec![ed; 32], vec![ml_dsa; 32], vec![kem; 32]).unwrap()
    } else {
        String::new()
    };
    PinKeys {
        key_version: Some(1),
        encryption_public_key: fill(x, 32),
        signing_public_key: fill(ed, 32),
        ml_dsa_public_key_hash: Some(hex(ml_dsa)),
        kem_public_key_hash: Some(hex(kem)),
        fingerprint,
    }
}
fn verified(pin: &PinKeys) -> bool {
    pin_verified(
        pin.encryption_public_key.clone(),
        pin.signing_public_key.clone(),
        pin.ml_dsa_public_key_hash.clone(),
        pin.kem_public_key_hash.clone(),
        pin.fingerprint.clone(),
    )
}

#[test]
fn a_first_seen_pin_never_passes_pin_verified_nor_with_a_fingerprint_over_other_keys_written_in() {
    let first_seen = pin(1, 2, 3, 0xab, false);
    assert!(!verified(&first_seen));
    assert_eq!(pin_trust(first_seen.clone()), PinTrust::Seen);
    for other in
        [pin(9, 2, 3, 0xab, true), pin(1, 9, 3, 0xab, true), pin(1, 2, 9, 0xab, true), pin(1, 2, 3, 9, true)]
    {
        let forged = PinKeys { fingerprint: other.fingerprint, ..first_seen.clone() };
        assert!(!verified(&forged));
        assert_eq!(pin_trust(forged), PinTrust::Invalid);
    }
    assert_eq!(pin_trust(pin(1, 2, 3, 0xab, true)), PinTrust::Verified);
    // "" exactly, every key field well formed; without an ML-DSA digest, legacy.
    let with = |change: &dyn Fn(&mut PinKeys)| {
        let mut changed = first_seen.clone();
        change(&mut changed);
        pin_trust(changed)
    };
    assert_eq!(with(&|p| p.fingerprint = " ".into()), PinTrust::Invalid);
    assert_eq!(with(&|p| p.kem_public_key_hash = None), PinTrust::Invalid);
    assert_eq!(with(&|p| p.kem_public_key_hash = Some(hex(0xab).to_uppercase())), PinTrust::Invalid);
    assert_eq!(with(&|p| p.signing_public_key.push('=')), PinTrust::Invalid);
    assert_eq!(with(&|p| p.encryption_public_key = fill(1, 31)), PinTrust::Invalid);
    assert_eq!(with(&|p| p.ml_dsa_public_key_hash = None), PinTrust::Legacy);
    assert_eq!(with(&|p| p.ml_dsa_public_key_hash = Some(String::new())), PinTrust::Legacy);
}

#[test]
fn keys_are_told_apart_by_their_commitment_never_by_the_fingerprint_field() {
    let (a, b) = (pin(1, 2, 3, 4, false), pin(1, 2, 3, 5, false));
    assert_eq!(a.fingerprint, b.fingerprint);
    assert_ne!(key_commitment(a.clone()), key_commitment(b));
    assert_eq!(key_commitment(a.clone()), Some(pin(1, 2, 3, 4, true).fingerprint));
    assert_eq!(key_commitment(PinKeys { ml_dsa_public_key_hash: None, ..a.clone() }), None);
    assert_eq!(key_commitment(PinKeys { encryption_public_key: "not a key".into(), ..a }), None);
}

fn served_contact(x: u8, ed: u8, ml_dsa: u8, kem: u8, version: u64) -> ServedContactKeys {
    ServedContactKeys {
        key_version: version,
        encryption_public_key: fill(x, 32),
        signing_public_key: fill(ed, 32),
        ml_dsa_public_key: Some(fill(ml_dsa, ML_DSA_PUBLIC_KEY_BYTES)),
        kem_public_key: Some(fill(kem, KEM_PUBLIC_KEY_BYTES)),
    }
}
fn full(served: &ServedContactKeys) -> ServedKeys {
    ServedKeys {
        key_version: served.key_version,
        encryption_public_key: served.encryption_public_key.clone(),
        signing_public_key: served.signing_public_key.clone(),
        ml_dsa_public_key: served.ml_dsa_public_key.clone().unwrap(),
        kem_public_key: served.kem_public_key.clone().unwrap(),
    }
}

#[test]
fn a_first_seen_pin_is_the_same_keys_only_while_every_served_key_matches() {
    let served = served_contact(1, 2, 3, 4, 1);
    let first_seen = pin_of_served(full(&served), false).unwrap();
    assert_eq!(first_seen.fingerprint, "");
    assert_eq!(pin_trust(first_seen.clone()), PinTrust::Seen);
    assert_eq!(compare_pin(first_seen.clone(), served.clone()), PinComparison::Same);
    let changed = |served: ServedContactKeys| compare_pin(first_seen.clone(), served);
    let other_ml_dsa = Some(fill(5, ML_DSA_PUBLIC_KEY_BYTES));
    let other_kem = Some(fill(6, KEM_PUBLIC_KEY_BYTES));
    assert_eq!(
        changed(ServedContactKeys { ml_dsa_public_key: other_ml_dsa, ..served.clone() }),
        PinComparison::Changed
    );
    assert_eq!(
        changed(ServedContactKeys { kem_public_key: other_kem, ..served.clone() }),
        PinComparison::Changed
    );
    assert_eq!(
        changed(ServedContactKeys { ml_dsa_public_key: None, ..served.clone() }),
        PinComparison::Changed
    );
    assert_eq!(changed(ServedContactKeys { kem_public_key: None, ..served.clone() }), PinComparison::Changed);
    assert_eq!(
        changed(ServedContactKeys { signing_public_key: fill(9, 32), ..served.clone() }),
        PinComparison::Changed
    );
    // A verified pin over the same keys compares alike; a legacy one asks to be pinned again.
    assert_eq!(compare_pin(pin_of_served(full(&served), true).unwrap(), served.clone()), PinComparison::Same);
    let legacy = PinKeys { ml_dsa_public_key_hash: None, ..first_seen.clone() };
    assert_eq!(compare_pin(legacy.clone(), served.clone()), PinComparison::Recheck);
    assert_eq!(compare_pin(legacy, served_contact(7, 8, 3, 4, 2)), PinComparison::Changed);
}

#[test]
fn a_first_seen_pin_may_be_followed_along_a_succession_and_stays_first_seen() {
    let before = pin_of_served(full(&served_contact(1, 2, 3, 4, 1)), false).unwrap();
    let next = served_contact(5, 6, 7, 8, 2);
    assert_eq!(compare_pin(before.clone(), next.clone()), PinComparison::Succession);
    // Not at the same or a lower version, nor without the lattice keys.
    assert_eq!(compare_pin(before.clone(), served_contact(5, 6, 7, 8, 1)), PinComparison::Changed);
    assert_eq!(
        compare_pin(before.clone(), ServedContactKeys { kem_public_key: None, ..next.clone() }),
        PinComparison::Changed
    );
    assert_eq!(
        compare_pin(before, ServedContactKeys { ml_dsa_public_key: Some(String::new()), ..next.clone() }),
        PinComparison::Changed
    );
    // The pin a client writes after the chain held: first-seen over the new keys, never verified.
    let after = pin_of_served(full(&next), false).unwrap();
    assert!(!verified(&after));
    assert_eq!(compare_pin(after, next), PinComparison::Same);
}

#[test]
fn a_pin_of_served_keys_is_refused_when_the_keys_would_not_make_one() {
    let served = full(&served_contact(1, 2, 3, 4, 1));
    let checked = pin_of_served(served.clone(), true).unwrap();
    assert_eq!(pin_trust(checked.clone()), PinTrust::Verified);
    assert_eq!(key_commitment(pin_of_served(served.clone(), false).unwrap()), Some(checked.fingerprint));
    let mut padded = served.clone();
    padded.signing_public_key.push('=');
    assert!(pin_of_served(padded, false).is_err());
    assert!(pin_of_served(ServedKeys { kem_public_key: fill(4, 1183), ..served.clone() }, false).is_err());
    assert!(pin_of_served(ServedKeys { key_version: 0, ..served }, false).is_err());
}

/* One account's identities: K0 → K1 → K2 along signed successions; K3 a sideways one, K4 its successor. */
struct Family {
    root: Vec<u8>,
    k: Vec<IdentityEnvelope>,
    k0k1: SuccessionLink,
    k1k2: SuccessionLink,
    k3k4: SuccessionLink,
}

fn link(old: &IdentityEnvelope, next: &IdentityEnvelope, signature: String) -> SuccessionLink {
    SuccessionLink {
        old_key_version: old.key_version,
        new_key_version: next.key_version,
        old_encryption_public_key: old.encryption_public_key.clone(),
        old_signing_public_key: old.signing_public_key.clone(),
        old_ml_dsa_public_key: old.ml_dsa.clone().unwrap().public_key,
        new_encryption_public_key: next.encryption_public_key.clone(),
        new_signing_public_key: next.signing_public_key.clone(),
        new_ml_dsa_public_key: next.ml_dsa.clone().unwrap().public_key,
        new_kem_public_key: next.kem.clone().unwrap().public_key,
        signature,
        consent: None,
    }
}

fn family() -> Family {
    let root = random(32);
    let k0 = identity_create(USER.into(), root.clone(), 1).unwrap();
    let one = identity_succeed(USER.into(), root.clone(), k0.clone()).unwrap();
    let two = identity_succeed(USER.into(), root.clone(), one.identity.clone()).unwrap();
    let k3 = identity_create(USER.into(), root.clone(), 2).unwrap();
    let four = identity_succeed(USER.into(), root.clone(), k3.clone()).unwrap();
    Family {
        k0k1: link(&k0, &one.identity, one.signature),
        k1k2: link(&one.identity, &two.identity, two.signature),
        k3k4: link(&k3, &four.identity, four.signature),
        k: vec![k0, one.identity, two.identity, k3, four.identity],
        root,
    }
}

impl Family {
    fn served(&self, n: usize) -> ServedKeys {
        let public = public_identity(self.k[n].clone()).unwrap();
        ServedKeys {
            key_version: public.key_version,
            encryption_public_key: public.encryption_public_key,
            signing_public_key: public.signing_public_key,
            ml_dsa_public_key: public.ml_dsa_public_key,
            kem_public_key: public.kem_public_key,
        }
    }
    fn pin(&self, n: usize, verified: bool) -> PinKeys {
        pin_of_served(self.served(n), verified).unwrap()
    }
    fn guard(&self, n: usize) -> GuardState {
        GuardState::Held { entry: guard_entry_next(None, self.pin(n, false)).unwrap() }
    }
}

fn agrees(
    guard: &GuardState,
    pin: Option<PinKeys>,
    chain: Option<(ServedKeys, Vec<SuccessionLink>)>,
) -> GuardVerdict {
    let (served, links) = chain.map_or((None, vec![]), |(served, links)| (Some(served), links));
    guard_agrees(USER.into(), guard.clone(), pin, served, links)
}

#[test]
fn a_legacy_pin_becomes_first_seen_only_over_its_own_classical_keys_with_a_keys_statement_that_holds() {
    let f = family();
    let k0 = public_identity(f.k[0].clone()).unwrap();
    let legacy = PinKeys {
        key_version: None,
        encryption_public_key: k0.encryption_public_key.clone(),
        signing_public_key: k0.signing_public_key.clone(),
        ml_dsa_public_key_hash: None,
        kem_public_key_hash: None,
        fingerprint: "0000 0000 0000 0000 0000 0000 0000 0000 0000 0000".into(),
    };
    assert_eq!(pin_trust(legacy.clone()), PinTrust::Legacy);
    let upgraded = pin_first_seen_of_legacy(USER.into(), legacy.clone(), k0.clone()).unwrap();
    assert_eq!(pin_trust(upgraded.clone()), PinTrust::Seen);
    assert_eq!(key_commitment(upgraded), Some(f.pin(0, true).fingerprint));
    // A malformed version 3 pin over the same classical keys too.
    let invalid = PinKeys { fingerprint: "not a fingerprint".into(), ..f.pin(0, false) };
    assert_eq!(pin_trust(invalid.clone()), PinTrust::Invalid);
    assert!(pin_first_seen_of_legacy(USER.into(), invalid, k0.clone()).is_some());
    // The pinned classical keys beside the server's lattice keys, with a keys statement over them
    // signed by another Ed25519 key (and the server's own ML-DSA key).
    let planted = public_identity(f.k[3].clone()).unwrap();
    let theirs = identity_open(USER.into(), f.root.clone(), f.k[3].clone()).unwrap();
    let statement = keys_statement(
        USER.into(),
        k0.key_version,
        k0.encryption_public_key.clone(),
        k0.signing_public_key.clone(),
        planted.ml_dsa_public_key.clone(),
        planted.kem_public_key.clone(),
    )
    .unwrap();
    let signature = sign_hybrid(&theirs.signing_seed, &theirs.ml_dsa_seed, &statement).unwrap();
    let forged = PublicIdentity {
        ml_dsa_public_key: planted.ml_dsa_public_key.clone(),
        kem_public_key: planted.kem_public_key.clone(),
        keys_signature: encode(&signature),
        ..k0.clone()
    };
    assert_eq!(pin_first_seen_of_legacy(USER.into(), legacy.clone(), forged), None);
    // The real statement for another account, another identity's statement, other classical keys.
    assert_eq!(pin_first_seen_of_legacy(OTHER.into(), legacy.clone(), k0.clone()), None);
    let swapped = PublicIdentity { keys_signature: planted.keys_signature.clone(), ..k0.clone() };
    assert_eq!(pin_first_seen_of_legacy(USER.into(), legacy.clone(), swapped), None);
    assert_eq!(pin_first_seen_of_legacy(USER.into(), legacy.clone(), planted.clone()), None);
    let moved = PinKeys { signing_public_key: planted.signing_public_key, ..legacy };
    assert_eq!(pin_first_seen_of_legacy(USER.into(), moved, k0.clone()), None);
    // A verified or first-seen pin is left as it is.
    assert_eq!(pin_first_seen_of_legacy(USER.into(), f.pin(0, true), k0.clone()), None);
    assert_eq!(pin_first_seen_of_legacy(USER.into(), f.pin(0, false), k0), None);
}

#[test]
fn with_no_guard_entry_it_is_first_use_and_an_unreadable_guard_is_never_first_use() {
    let pin = pin(1, 2, 3, 4, false);
    assert_eq!(agrees(&GuardState::Absent, Some(pin.clone()), None), GuardVerdict::FirstUse);
    assert_eq!(agrees(&GuardState::Absent, None, None), GuardVerdict::FirstUse);
    assert_eq!(agrees(&GuardState::Unreadable, Some(pin), None), GuardVerdict::Unchecked);
    assert_eq!(agrees(&GuardState::Unreadable, None, None), GuardVerdict::Unchecked);
}

#[test]
fn a_newer_copy_carrying_a_stale_verified_pin_of_k1_while_the_guard_holds_k2_pauses() {
    let f = family();
    let guard = f.guard(2);
    let stale = f.pin(1, true);
    assert!(verified(&stale));
    assert_eq!(agrees(&guard, Some(stale.clone()), None), GuardVerdict::Changed);
    assert_eq!(agrees(&guard, Some(stale), Some((f.served(1), vec![f.k0k1.clone()]))), GuardVerdict::Changed);
    assert_eq!(agrees(&guard, Some(f.pin(2, true)), None), GuardVerdict::Agrees);
    assert_eq!(agrees(&guard, Some(f.pin(2, false)), None), GuardVerdict::Agrees);
}

#[test]
fn a_copy_that_drops_the_pin_pauses_rather_than_starting_over() {
    let f = family();
    let guard = f.guard(0);
    // The settings no longer hold them (the Contacts list follows the settings); the guard does.
    assert_eq!(agrees(&guard, None, None), GuardVerdict::Changed);
    assert_eq!(agrees(&guard, Some(f.pin(3, false)), None), GuardVerdict::Changed);
}

#[test]
fn a_continue_on_another_device_shows_the_notice_here_once() {
    let f = family();
    let GuardState::Held { entry } = f.guard(0) else { unreachable!() };
    // What another device's Continue saved: first-seen over new keys (its previous keys, kept in
    // the settings, are not an input at all: nothing there stands in for a chain).
    let moved = f.pin(3, false);
    let guard = GuardState::Held { entry: entry.clone() };
    assert_eq!(agrees(&guard, Some(moved.clone()), None), GuardVerdict::Changed);
    let after = guard_entry_next(Some(entry.clone()), moved.clone()).unwrap();
    assert_eq!(after.revision, entry.revision + 1);
    assert_eq!(after.previous_signing_keys, vec![entry.signing_public_key]);
    assert!(!after.verified);
    assert_eq!(agrees(&GuardState::Held { entry: after }, Some(moved), None), GuardVerdict::Agrees);
}

#[test]
fn a_continue_then_a_check_back_then_the_stale_branch_arriving_shows_the_notice() {
    let f = family();
    let GuardState::Held { entry } = f.guard(0) else { unreachable!() };
    let continued = f.pin(3, false);
    let entry = guard_entry_next(Some(entry), continued.clone()).unwrap();
    let entry = guard_entry_next(Some(entry), f.pin(0, true)).unwrap();
    assert!(entry.verified);
    let guard = GuardState::Held { entry };
    assert_eq!(agrees(&guard, Some(f.pin(0, true)), None), GuardVerdict::Agrees);
    assert_eq!(agrees(&guard, Some(continued.clone()), None), GuardVerdict::Changed);
    assert_eq!(agrees(&guard, Some(continued), Some((f.served(3), vec![]))), GuardVerdict::Changed);
}

#[test]
fn a_sideways_pin_pauses_even_with_a_chain_that_holds_from_keys_the_guard_never_held() {
    let f = family();
    let guard = f.guard(0);
    let sideways = f.pin(4, false);
    assert_eq!(
        agrees(&guard, Some(sideways.clone()), Some((f.served(4), vec![f.k3k4.clone()]))),
        GuardVerdict::Changed
    );
    assert_eq!(
        agrees(&guard, Some(sideways), Some((f.served(4), vec![f.k0k1.clone(), f.k3k4.clone()]))),
        GuardVerdict::Changed
    );
}

#[test]
fn a_succession_from_the_guard_s_keys_that_this_device_verifies_is_taken_silently() {
    let f = family();
    let guard = f.guard(0);
    let followed = f.pin(2, false);
    let chain = (f.served(2), vec![f.k0k1.clone(), f.k1k2.clone()]);
    assert_eq!(agrees(&guard, Some(followed.clone()), Some(chain)), GuardVerdict::Follows);
    assert_eq!(agrees(&guard, Some(followed.clone()), None), GuardVerdict::Changed);
    assert_eq!(
        agrees(&guard, Some(followed.clone()), Some((f.served(1), vec![f.k0k1.clone()]))),
        GuardVerdict::Changed
    );
    let GuardState::Held { entry } = guard else { unreachable!() };
    let after = GuardState::Held { entry: guard_entry_next(Some(entry), followed.clone()).unwrap() };
    assert_eq!(agrees(&after, Some(followed), None), GuardVerdict::Agrees);
}

#[test]
fn a_succession_is_followed_from_the_guard_s_own_keys_and_a_link_with_another_old_ml_dsa_key_is_refused() {
    let f = family();
    let guard = f.guard(0);
    // Another device followed them to K1 and saved; this device's guard still holds K0.
    assert_eq!(
        agrees(&guard, Some(f.pin(1, false)), Some((f.served(1), vec![f.k0k1.clone()]))),
        GuardVerdict::Follows
    );
    // The guard's X25519 and Ed25519 keys as the link's old keys, signed by the guard's Ed25519 key,
    // beside another old ML-DSA key (whose digest is not the guard's).
    let planted = identity_open(USER.into(), f.root.clone(), f.k[3].clone()).unwrap();
    let k0 = identity_open(USER.into(), f.root.clone(), f.k[0].clone()).unwrap();
    let mut forged = link(&f.k[0], &f.k[4], String::new());
    forged.old_ml_dsa_public_key = f.k[3].ml_dsa.clone().unwrap().public_key;
    let statement = succession_statement(USER.into(), forged.clone()).unwrap();
    forged.signature = encode(&sign_hybrid(&k0.signing_seed, &planted.ml_dsa_seed, &statement).unwrap());
    assert_eq!(
        agrees(&guard, Some(f.pin(4, false)), Some((f.served(4), vec![forged]))),
        GuardVerdict::Changed
    );
}

#[test]
fn adding_someone_again_over_the_same_keys_is_silent_and_over_other_keys_is_the_notice() {
    let f = family();
    let guard = f.guard(0);
    assert_eq!(agrees(&guard, Some(f.pin(0, false)), None), GuardVerdict::Agrees);
    assert_eq!(agrees(&guard, Some(f.pin(3, false)), None), GuardVerdict::Changed);
}

#[test]
fn a_guard_holds_only_keys_a_verified_or_first_seen_pin_names_and_whether_it_saw_them_verified() {
    let legacy = PinKeys { ml_dsa_public_key_hash: None, ..pin(1, 2, 3, 4, false) };
    assert!(guard_entry_next(None, legacy).is_err());
    let first = guard_entry_next(None, pin(1, 2, 3, 4, false)).unwrap();
    assert_eq!((first.revision, first.verified, first.previous_signing_keys.len()), (1, false, 0));
    let checked = guard_entry_next(Some(first), pin(1, 2, 3, 4, true)).unwrap();
    assert_eq!((checked.revision, checked.verified), (2, true));
    assert!(guard_entry_next(Some(checked.clone()), pin(1, 2, 3, 4, false)).unwrap().verified);
    assert!(!guard_entry_next(Some(checked), pin(5, 6, 3, 4, false)).unwrap().verified);
}

#[test]
fn a_record_signed_under_a_first_seen_key_reads_seen_under_a_verified_pin_s_verified_under_neither_unknown() {
    let seed = random(32);
    let public = signing_public_key(seed.clone()).unwrap();
    let statement = MetadataStatement {
        workspace_id: "22222222-2222-4222-8222-222222222222".into(),
        node_id: "33333333-3333-4333-8333-333333333333".into(),
        kind: NodeKind::File,
        metadata_version: 1,
    };
    let envelope = b"sealed".to_vec();
    let signature = metadata_sign(seed, statement.clone(), envelope.clone()).unwrap();
    let read = |trusted: Option<TrustedKeys>| {
        metadata_integrity(trusted, statement.clone(), envelope.clone(), Some(signature.clone()))
    };
    let keys = |seen| TrustedKeys { current: public.clone(), retired: vec![], seen };
    assert_eq!(read(Some(keys(true))), Integrity::Seen);
    assert_eq!(read(Some(keys(false))), Integrity::Verified);
    assert_eq!(read(None), Integrity::UnknownSigner);
    // Seen never covers a retired key or a bad signature.
    let retired = TrustedKeys { current: random(32), retired: vec![public.clone()], seen: true };
    assert_eq!(read(Some(retired)), Integrity::RetiredKey);
    let other = TrustedKeys { current: signing_public_key(random(32)).unwrap(), retired: vec![], seen: true };
    assert_eq!(read(Some(other)), Integrity::BadSignature);
}

#[test]
fn a_settings_document_one_first_seen_pin_over_the_cap_is_refused() {
    let key = random(32);
    let first_seen = |i: usize| {
        json!({
            "userId": format!("{i:08x}-1111-4111-8111-111111111111"),
            "email": format!("person.number{i}@example.com"),
            "name": format!("Person Number {i}"),
            "encryptionPublicKey": fill((i % 251) as u8, 32),
            "signingPublicKey": fill(((i + 1) % 251) as u8, 32),
            "mlDsaPublicKeyHash": hex((i % 256) as u8),
            "kemPublicKeyHash": hex(((i + 7) % 256) as u8),
            "fingerprint": "",
            "pinnedAt": "2026-10-26T10:00:00.000Z",
            "keyVersion": 1,
            "firstSeen": "added",
        })
    };
    let document = |count: usize| {
        let contacts: serde_json::Map<String, serde_json::Value> =
            (0..count).map(|i| (format!("{i:08x}-1111-4111-8111-111111111111"), first_seen(i))).collect();
        json!({ "version": 2, "contacts": contacts, "sharing": { "shares": {}, "links": {} } }).to_string()
    };
    // About a hundred people fit, as the design says; the first count that does not is refused.
    let fits = (1..400).take_while(|n| document(*n).len() <= 64 * 1024).last().unwrap();
    assert!(fits >= 100, "{fits}");
    assert!(settings_seal(USER.into(), key.clone(), 1, document(fits)).is_ok());
    assert!(settings_seal(USER.into(), key, 1, document(fits + 1)).is_err());
}

#[test]
fn a_succession_signed_by_first_seen_keys_is_followed_and_stays_first_seen_and_one_signed_by_other_keys_is_not(
) {
    let f = family();
    let before = f.pin(0, false);
    assert_eq!(pin_trust(before.clone()), PinTrust::Seen);
    let pinned = PinnedKeys {
        key_version: before.key_version,
        encryption_public_key: before.encryption_public_key.clone(),
        signing_public_key: before.signing_public_key.clone(),
        ml_dsa_public_key_hash: before.ml_dsa_public_key_hash.clone().unwrap(),
    };
    let contact = |n: usize| {
        let served = f.served(n);
        ServedContactKeys {
            key_version: served.key_version,
            encryption_public_key: served.encryption_public_key,
            signing_public_key: served.signing_public_key,
            ml_dsa_public_key: Some(served.ml_dsa_public_key),
            kem_public_key: Some(served.kem_public_key),
        }
    };
    assert_eq!(compare_pin(before.clone(), contact(1)), PinComparison::Succession);
    assert!(succession_chain_verify(USER.into(), pinned.clone(), f.served(1), vec![f.k0k1.clone()]));
    assert!(succession_chain_verify(
        USER.into(),
        pinned.clone(),
        f.served(2),
        vec![f.k0k1.clone(), f.k1k2.clone()]
    ));
    let after = f.pin(1, false);
    assert_eq!(pin_trust(after.clone()), PinTrust::Seen);
    assert!(!verified(&after));
    assert_eq!(compare_pin(after, contact(1)), PinComparison::Same);
    // Signed by any other key: never followed from these keys.
    assert!(!succession_chain_verify(USER.into(), pinned.clone(), f.served(4), vec![f.k3k4.clone()]));
    assert!(!succession_chain_verify(USER.into(), pinned, f.served(2), vec![f.k1k2.clone()]));
}
