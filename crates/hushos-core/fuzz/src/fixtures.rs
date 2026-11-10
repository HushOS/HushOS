//! The fixture documents both twins already share, read once per process:
//! the records the targets open (a share, two group seals, an identity) and
//! the histories the acceptance target mutates. Read from the repository at
//! run time, not built in, so the binaries stay small and the core keeps its
//! no-I/O rule.

use crate::groups::{person, reader, served_ml_dsa, signed_of, Person, GROUP};
use hushos_core::*;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

fn repository() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn read(relative: &str) -> Value {
    let path = repository().join(relative);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// `packages/crypto/src/__fixtures__/core.json`: records this crate sealed.
pub fn core() -> &'static Value {
    static CORE: OnceLock<Value> = OnceLock::new();
    CORE.get_or_init(|| read("packages/crypto/src/__fixtures__/core.json"))
}

/// `crates/hushos-core/fixtures/web.json`: records the web sealed.
pub fn web() -> &'static Value {
    static WEB: OnceLock<Value> = OnceLock::new();
    WEB.get_or_init(|| read("crates/hushos-core/fixtures/web.json"))
}

/// `packages/crypto/src/__fixtures__/core-groups.json`: the group history, seals and cases.
pub fn groups() -> &'static Value {
    static GROUPS: OnceLock<Value> = OnceLock::new();
    GROUPS.get_or_init(|| read("packages/crypto/src/__fixtures__/core-groups.json"))
}

/// `packages/crypto/src/__fixtures__/core-area-ledger.json`: the core's ledger runs, walks and device records.
pub fn core_ledger() -> &'static Value {
    static LEDGER: OnceLock<Value> = OnceLock::new();
    LEDGER.get_or_init(|| read("packages/crypto/src/__fixtures__/core-area-ledger.json"))
}

/// `packages/crypto/src/__fixtures__/core-join.json`: the core's join previews, checks and consents.
pub fn core_join() -> &'static Value {
    static JOIN: OnceLock<Value> = OnceLock::new();
    JOIN.get_or_init(|| read("packages/crypto/src/__fixtures__/core-join.json"))
}

/// `packages/crypto/src/__fixtures__/core-roster-calls.json`: the core's roster calls, join codes and outbox entries.
pub fn core_roster_calls() -> &'static Value {
    static CALLS: OnceLock<Value> = OnceLock::new();
    CALLS.get_or_init(|| read("packages/crypto/src/__fixtures__/core-roster-calls.json"))
}

/// The four people of the group fixtures, derived from the shared seeds.
pub fn people() -> &'static [Person] {
    static PEOPLE: OnceLock<Vec<Person>> = OnceLock::new();
    PEOPLE.get_or_init(|| (1..=4).map(person).collect())
}

/// The fixture history, accepted as the web's test accepts it.
pub fn chain() -> Arc<AcceptedRosters> {
    static CHAIN: OnceLock<Arc<AcceptedRosters>> = OnceLock::new();
    CHAIN
        .get_or_init(|| {
            let fixture = groups();
            let first = &fixture["groupKeys"][0];
            let people: Vec<&Person> = people().iter().collect();
            let accepted = accept_rosters(
                GROUP.into(),
                GroupPublicKey {
                    ed25519_public_key: first["ed25519PublicKey"].as_str().unwrap().into(),
                    ml_dsa_public_key: first["mlDsaPublicKey"].as_str().unwrap().into(),
                },
                Some(GroupAnchor::Created),
                vec![],
                fixture["rosters"].as_array().unwrap().iter().map(signed_of).collect(),
                fixture["successions"].as_array().unwrap().iter().map(signed_of).collect(),
                served_ml_dsa(&people),
                reader(),
                None,
            )
            .expect("the fixture history is accepted");
            match accepted {
                RosterChain::Accepted { chain } => chain,
                RosterChain::Fork { .. } => panic!("the fixture history forked"),
            }
        })
        .clone()
}

/// The grantee of `core.json`'s share: the web's identity opened under the web's account key.
pub fn share_grantee() -> &'static IdentityKeys {
    static GRANTEE: OnceLock<IdentityKeys> = OnceLock::new();
    GRANTEE.get_or_init(|| {
        let web = web();
        let envelope = crate::shape::envelope(&web["share"]["identity"]).expect("an identity envelope");
        identity_open(
            web["account"]["userId"].as_str().unwrap().into(),
            base64url_decode(web["account"]["accountKey"].as_str().unwrap().into()).unwrap(),
            envelope,
        )
        .expect("the web's identity opens")
    })
}

/// `packages/crypto/src/__fixtures__/core-company.json`: a company this crate made, with its seals.
pub fn company() -> &'static Value {
    static COMPANY: OnceLock<Value> = OnceLock::new();
    COMPANY.get_or_init(|| read("packages/crypto/src/__fixtures__/core-company.json"))
}

/// `crates/hushos-core/fixtures/web-company.json`: the web's company histories and seals.
pub fn web_company() -> &'static Value {
    static COMPANY: OnceLock<Value> = OnceLock::new();
    COMPANY.get_or_init(|| read("crates/hushos-core/fixtures/web-company.json"))
}

/// A fixture company's chain, accepted through its first `through` rosters:
/// `core` is the one this crate made, `web` the one whose seals the web made.
/// `None` when the fixture has no such roster. The web's `companyChain`
/// accepts the same.
pub fn company_chain(which: &str, through: u64) -> Option<Arc<AcceptedRosters>> {
    use std::collections::HashMap;
    use std::sync::Mutex;
    type Chains = Mutex<HashMap<(String, u64), Arc<AcceptedRosters>>>;
    static CHAINS: OnceLock<Chains> = OnceLock::new();
    let history = match which {
        "core" => &company()["history"]["input"],
        "web" => &web_company()["seals"]["history"],
        _ => return None,
    };
    let count = history["rosters"].as_array()?.len() as u64;
    if through < 1 || through > count {
        return None;
    }
    let chains = CHAINS.get_or_init(Default::default);
    let key = (which.to_string(), through);
    if let Some(chain) = chains.lock().expect("chains").get(&key) {
        return Some(chain.clone());
    }
    let (_, input, _) = crate::groups::case_from(&serde_json::json!({
        "name": "company", "input": history, "expected": null,
    }));
    let accepted = accept_rosters(
        GROUP.into(),
        input.first_keys.clone(),
        Some(GroupAnchor::Created),
        vec![],
        input.rosters[..through as usize].to_vec(),
        input.successions.clone(),
        input.ml_dsa_keys.clone(),
        input.me.clone(),
        None,
    )
    .expect("a fixture company is accepted");
    let RosterChain::Accepted { chain } = accepted else {
        panic!("a fixture company forked");
    };
    chains.lock().expect("chains").insert(key, chain.clone());
    Some(chain)
}
