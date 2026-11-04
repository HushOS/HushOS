//! A real iOS 0.10.0 join over a planted entry (docs/optional-verification.md
//! 3.4, "Older apps"), for `fixtures/v0.10.0/planted-join.json`. This file is
//! the generator, kept beside its output; it builds only against the core at
//! the tag `v0.10.0`, the core iOS 0.10.0 shipped:
//!
//! ```sh
//! git worktree add --detach "$TMP/v0.10.0" v0.10.0
//! cp crates/hushos-core/fixtures/v0.10.0/planted_join.rs "$TMP/v0.10.0/crates/hushos-core/examples/"
//! (cd "$TMP/v0.10.0" && cargo run -q -p hushos-core --example planted_join) > crates/hushos-core/fixtures/v0.10.0/planted-join.json
//! ```
//!
//! The family's organizer (person 1) lets person 2 in at roster 2, but the
//! entry names keys the server made (person 9's keys under person 2's id).
//! Person 2's real device, on the 0.10.0 core, previews the join code, types
//! its two hidden words and joins: 0.10.0 works the code out before any check
//! of its own entry, so it matches over keys it does not hold, and only then
//! reports the entry wrong. Everything the newer core needs is written out:
//! the served chain, both people's identities, the code 0.10.0 returned and
//! what its acceptance found.

#[path = "../tests/common/groups.rs"]
mod groups;

use groups::*;
use hushos_core::*;
use serde_json::json;

const NOW: &str = "2026-10-18T12:00:00.000Z";

fn served_keys_value(keys: &ServedKeys) -> serde_json::Value {
    json!({
        "keyVersion": keys.key_version,
        "encryptionPublicKey": keys.encryption_public_key,
        "signingPublicKey": keys.signing_public_key,
        "mlDsaPublicKey": keys.ml_dsa_public_key,
        "kemPublicKey": keys.kem_public_key,
    })
}

fn main() {
    let (organizer, newcomer, server) = (person(1), person(2), person(9));
    let owner = organizer.entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active);
    // The server's keys, planted as the newcomer's entry.
    let mut planted = server.entry(&[], 2, MemberStatus::Active);
    planted.user_id = newcomer.user_id.clone();
    let mut h = History::new();
    h.roster(&organizer, vec![owner.clone()], None);
    h.roster(&organizer, vec![owner, planted.clone()], None);
    let served = ServedChain {
        after: 0,
        first_keys: h.key(1),
        rosters: h.rosters.clone(),
        successions: vec![],
        signer_keys: served_ml_dsa(&[&organizer]),
    };
    // The newcomer's real device: its own account and identity, settings with no family yet.
    let root = pattern(32, 77);
    let ledger = AreaLedger::new();
    ledger
        .open_account(
            newcomer.user_id.clone(),
            base64url_decode(newcomer.served.signing_public_key.clone()).unwrap(),
            root,
        )
        .unwrap();
    ledger.use_settings_envelope(newcomer.user_id.clone(), None, None).unwrap();
    let me = OwnIdentities { user_id: newcomer.user_id.clone(), identities: vec![served_keys(&newcomer)] };
    let JoinPreview::Code { roster_version, code, session } =
        ledger.group_join_preview(me.clone(), GROUP.into(), None, served.clone(), None).unwrap()
    else {
        panic!("0.10.0 shows a code");
    };
    let typed: Vec<String> = session.hidden().iter().map(|at| code[*at as usize].clone()).collect();
    let JoinCheck::Matched { matched, .. } = ledger
        .join_check(me.clone(), GROUP.into(), None, served.clone(), session, typed, NOW.into(), None)
        .unwrap()
    else {
        panic!("0.10.0 takes the words");
    };
    let JoinAcceptance::Accepted { chain, .. } =
        ledger.accept_joining(me, GROUP.into(), None, served, matched).unwrap()
    else {
        panic!("0.10.0 joins");
    };
    let document = json!({
        "generatedBy": "crates/hushos-core/fixtures/v0.10.0/planted_join.rs, against the core at v0.10.0 (936f8a6e)",
        "groupId": GROUP,
        "firstKeys": { "ed25519PublicKey": h.key(1).ed25519_public_key, "mlDsaPublicKey": h.key(1).ml_dsa_public_key },
        "rosters": h.rosters.iter().map(signed_json).collect::<Vec<_>>(),
        "signerKeys": served_ml_dsa(&[&organizer]),
        "manager": { "userId": organizer.user_id, "identity": served_keys_value(&served_keys(&organizer)) },
        "newcomer": { "userId": newcomer.user_id, "identity": served_keys_value(&served_keys(&newcomer)) },
        "planted": served_keys_value(&served_keys(&server)),
        "preview": { "rosterVersion": roster_version, "code": code },
        "joined": {
            "rosterVersion": chain.roster().roster_version,
            "rosterDigests": chain.roster_digests(),
            "ownEntryWrongAt": chain.own_entry_wrong_at(),
        },
    });
    println!("{}", serde_json::to_string_pretty(&document).unwrap());
}
