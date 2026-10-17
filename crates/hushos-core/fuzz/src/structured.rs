//! Structured inputs built with `arbitrary`, where random bytes would rarely
//! get past the first check: a history assembled from the fixture cases'
//! signed parts (so signatures still verify and acceptance runs deep), and a
//! roster drawn mostly from well-formed fields. Each becomes the same JSON
//! document the shared targets read, so a finding replays in the web's twin.

use crate::fixtures;
use arbitrary::{Arbitrary, Unstructured};
use hushos_core::{base64url_decode, base64url_encode};
use serde_json::{json, Value};

/// One change to a served history.
#[derive(Arbitrary, Debug)]
pub enum Op {
    DropRoster(u8),
    DuplicateRoster(u8),
    SwapRosters(u8, u8),
    RosterFrom { case: u8, index: u8 },
    DropSuccession(u8),
    DuplicateSuccession(u8),
    SuccessionFrom { case: u8, index: u8 },
    PinsFrom(u8),
    DropPins,
    PinVersion { index: u8, roster: bool, delta: i8 },
    CacheFrom(u8),
    DropCache,
    CacheDigests(u8),
    CacheDroppedHolder,
    CacheGroupKeys(u8),
    CacheSuccessions(u8),
    ToggleChecked,
    FirstKeysFrom(u8),
    MeFrom(u8),
    MlDsaKeysFrom(u8),
    DropMlDsaKey(u8),
    JoinMarkFrom(u8),
    DropJoinMark,
    Flip { part: Part, index: u8, at: u16, mask: u8 },
}

/// Which bytes of a signed roster or succession a flip lands in.
#[derive(Arbitrary, Debug, Clone, Copy)]
pub enum Part {
    RosterStatement,
    RosterGroupEd25519,
    RosterGroupMlDsa,
    RosterSigner,
    SuccessionStatement,
    SuccessionSigner,
}

/// A fixture case to start from and the changes made to it.
#[derive(Arbitrary, Debug)]
pub struct History {
    pub case: u8,
    pub ops: Vec<Op>,
}

fn cases() -> &'static Vec<Value> {
    fixtures::groups()["cases"].as_array().expect("the fixture's cases")
}

fn case_input(index: u8) -> Value {
    let cases = cases();
    cases[index as usize % cases.len()]["input"].clone()
}

fn list<'a>(input: &'a mut Value, key: &str) -> &'a mut Vec<Value> {
    input[key].as_array_mut().expect("a list")
}

fn pick(len: usize, index: u8) -> Option<usize> {
    (len > 0).then(|| index as usize % len)
}

fn flip(value: &mut Value, at: u16, mask: u8) {
    let Some(text) = value.as_str() else { return };
    let Ok(mut bytes) = base64url_decode(text.into()) else { return };
    if bytes.is_empty() || mask == 0 {
        return;
    }
    let at = at as usize % bytes.len();
    bytes[at] ^= mask;
    *value = json!(base64url_encode(bytes));
}

impl History {
    /// The history as a shared case's `input`: the `accept` target's document.
    pub fn input(&self) -> Value {
        let mut input = case_input(self.case);
        for op in self.ops.iter().take(16) {
            apply(&mut input, op);
        }
        input
    }
}

fn apply(input: &mut Value, op: &Op) {
    match *op {
        Op::DropRoster(i) => {
            let rosters = list(input, "rosters");
            if let Some(i) = pick(rosters.len(), i) {
                rosters.remove(i);
            }
        }
        Op::DuplicateRoster(i) => {
            let rosters = list(input, "rosters");
            if let Some(i) = pick(rosters.len(), i) {
                let copy = rosters[i].clone();
                rosters.insert(i, copy);
            }
        }
        Op::SwapRosters(a, b) => {
            let rosters = list(input, "rosters");
            if let (Some(a), Some(b)) = (pick(rosters.len(), a), pick(rosters.len(), b)) {
                rosters.swap(a, b);
            }
        }
        Op::RosterFrom { case, index } => {
            let other = case_input(case);
            let theirs = other["rosters"].as_array().unwrap();
            if let Some(i) = pick(theirs.len(), index) {
                list(input, "rosters").push(theirs[i].clone());
            }
        }
        Op::DropSuccession(i) => {
            let successions = list(input, "successions");
            if let Some(i) = pick(successions.len(), i) {
                successions.remove(i);
            }
        }
        Op::DuplicateSuccession(i) => {
            let successions = list(input, "successions");
            if let Some(i) = pick(successions.len(), i) {
                let copy = successions[i].clone();
                successions.push(copy);
            }
        }
        Op::SuccessionFrom { case, index } => {
            let other = case_input(case);
            let theirs = other["successions"].as_array().unwrap();
            if let Some(i) = pick(theirs.len(), index) {
                list(input, "successions").push(theirs[i].clone());
            }
        }
        Op::PinsFrom(case) => input["pins"] = case_input(case)["pins"].clone(),
        Op::DropPins => input["pins"] = json!([]),
        Op::PinVersion { index, roster, delta } => {
            let pins = list(input, "pins");
            if let Some(i) = pick(pins.len(), index) {
                let key = if roster { "rosterVersion" } else { "keyVersion" };
                let at = pins[i][key].as_u64().unwrap_or(1);
                pins[i][key] = json!(at.saturating_add_signed(i64::from(delta)));
            }
        }
        Op::CacheFrom(case) => input["cache"] = case_input(case)["cache"].clone(),
        Op::DropCache => input["cache"] = Value::Null,
        Op::CacheDigests(keep) => {
            if let Some(digests) = input["cache"]["rosterDigests"].as_array_mut() {
                digests.truncate(keep as usize % (digests.len() + 1));
            }
        }
        Op::CacheDroppedHolder => {
            if let Some(dropped) = input["cache"]["droppedHolder"].as_bool() {
                input["cache"]["droppedHolder"] = json!(!dropped);
            }
        }
        Op::CacheGroupKeys(keep) => {
            if let Some(keys) = input["cache"]["groupKeys"].as_array_mut() {
                keys.truncate(keep as usize % (keys.len() + 1));
            }
        }
        Op::CacheSuccessions(keep) => {
            if let Some(successions) = input["cache"]["successions"].as_array_mut() {
                successions.truncate(keep as usize % (successions.len() + 1));
            }
        }
        Op::ToggleChecked => {
            let checked = input["firstKeysChecked"].as_bool().unwrap_or(false);
            input["firstKeysChecked"] = json!(!checked);
        }
        Op::FirstKeysFrom(case) => input["firstKeys"] = case_input(case)["firstKeys"].clone(),
        Op::MeFrom(case) => input["me"] = case_input(case)["me"].clone(),
        Op::MlDsaKeysFrom(case) => input["mlDsaKeys"] = case_input(case)["mlDsaKeys"].clone(),
        Op::DropMlDsaKey(i) => {
            if let Some(keys) = input["mlDsaKeys"].as_object_mut() {
                if let Some(i) = pick(keys.len(), i) {
                    let key = keys.keys().nth(i).unwrap().clone();
                    keys.remove(&key);
                }
            }
        }
        Op::JoinMarkFrom(case) => input["joinMark"] = case_input(case)["joinMark"].clone(),
        Op::DropJoinMark => input["joinMark"] = Value::Null,
        Op::Flip { part, index, at, mask } => {
            let (key, field): (&str, &[&str]) = match part {
                Part::RosterStatement => ("rosters", &["statement"]),
                Part::RosterGroupEd25519 => ("rosters", &["signature", "ed25519"]),
                Part::RosterGroupMlDsa => ("rosters", &["signature", "mlDsa"]),
                Part::RosterSigner => ("rosters", &["signerSignature"]),
                Part::SuccessionStatement => ("successions", &["statement"]),
                Part::SuccessionSigner => ("successions", &["signerSignature"]),
            };
            let items = list(input, key);
            if let Some(i) = pick(items.len(), index) {
                let mut target = &mut items[i];
                for name in field {
                    target = &mut target[*name];
                }
                flip(target, at, mask);
            }
        }
    }
}

/* A field drawn from well-formed values most of the time, anything otherwise. */
fn plausible(u: &mut Unstructured, good: &[&str]) -> arbitrary::Result<String> {
    if u.ratio(7, 8)? {
        Ok(u.choose(good)?.to_string())
    } else {
        String::arbitrary(u)
    }
}

const USERS: &[&str] = &[
    "00000001-abcd-4abc-8abc-abcdefabcdef",
    "00000002-abcd-4abc-8abc-abcdefabcdef",
    "00000003-abcd-4abc-8abc-abcdefabcdef",
    "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a",
    "80558a81-8dfc-8914-8447-0417b55e2ec5",
    "a0558a81-8dfc-4914-8447-0417b55e2ec5",
    "A0558A81-8DFC-4914-8447-0417B55E2EC5",
];
const KEYS: &[&str] = &[
    "Jp8gVe3K0szz_dTbudu0BbceayT1uO8PysP6bjviOlA",
    "Il2SxfIo1S4PS06zLGBCauJ8YSWSafkxQzIRzFlKTK8",
    "Il2SxfIo1S4PS06zLGBCauJ8YSWSafkxQzIRzFlKTK9",
    "Il2SxfIo1S4PS06zLGBCauJ8YSWSafkxQzIRzFlKTK8=",
    "",
];
const KINDS: &[&str] = &["family", "org", "Family"];
const ROLES: &[&str] = &["billing", "data_admin", "guardian", "members", "recovery", "owner"];
const STATUSES: &[&str] = &["active", "left", "gone"];

fn version(u: &mut Unstructured) -> arbitrary::Result<Value> {
    Ok(match u.int_in_range(0..=5u8)? {
        0 => json!(0),
        1 => json!(9_007_199_254_740_991u64),
        2 => json!(9_007_199_254_740_992u64),
        _ => json!(u.int_in_range(1..=6u64)?),
    })
}

/// A roster object for the `roster_build` target: mostly well-formed fields, so the encoder's
/// later checks (order, roles per kind, versions, area rows) are reached.
pub fn roster(u: &mut Unstructured) -> arbitrary::Result<Value> {
    let kind = plausible(u, KINDS)?;
    let members = (0..u.int_in_range(0..=4u8)?)
        .map(|_| {
            Ok(json!({
                "userId": plausible(u, USERS)?,
                "keyVersion": version(u)?,
                "encryptionPublicKey": plausible(u, KEYS)?,
                "signingPublicKey": plausible(u, KEYS)?,
                "mlDsaPublicKeyDigest": plausible(u, KEYS)?,
                "kemPublicKeyDigest": plausible(u, KEYS)?,
                "status": plausible(u, STATUSES)?,
                "roles": (0..u.int_in_range(0..=3u8)?).map(|_| plausible(u, ROLES)).collect::<arbitrary::Result<Vec<_>>>()?,
                "sinceVersion": version(u)?,
            }))
        })
        .collect::<arbitrary::Result<Vec<_>>>()?;
    let areas = (0..u.int_in_range(0..=3u8)?)
        .map(|_| {
            Ok(json!({
                "workspaceId": plausible(u, USERS)?,
                "workspaceKeyVersion": version(u)?,
                "commitment": plausible(u, KEYS)?,
            }))
        })
        .collect::<arbitrary::Result<Vec<_>>>()?;
    let roster_version = version(u)?;
    let previous = if u.ratio(1, 2)? { String::new() } else { plausible(u, KEYS)? };
    Ok(json!({
        "groupId": plausible(u, USERS)?,
        "kind": kind,
        "rosterVersion": roster_version,
        "previousRosterDigest": previous,
        "groupKeyVersion": version(u)?,
        "signerUserId": plausible(u, USERS)?,
        "members": members,
        "areas": areas,
    }))
}
