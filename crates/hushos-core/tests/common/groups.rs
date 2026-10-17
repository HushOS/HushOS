//! People, group keys and JSON shapes for the group fixtures, shared by
//! `tests/web_group_fixtures.rs` and `examples/group_fixtures.rs` (which
//! includes this file by path). Every key comes from the same fixed seeds as
//! `packages/crypto/src/group-testkit.ts`, so both twins derive the same people
//! and group keys, and each checks the other's derivation.
#![allow(dead_code)]

use hushos_core::*;
use ml_kem::array::Array;
use ml_kem::{ml_kem_768, KeyExport, Seed};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use x25519_dalek::{PublicKey, StaticSecret};

pub const GROUP: &str = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
/* The family's area: a workspace id derived under GROUP from AREA_SEED (pattern(16, 60)). */
pub const AREA: &str = "80558a81-8dfc-8914-8447-0417b55e2ec5";
pub const AREA_SEED: &str = "pMrxFz5ki7HY_iVLcpi_5Q";
pub const OTHER_GROUP: &str = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
/* Another group's area: derived under OTHER_GROUP from OTHER_AREA_SEED (pattern(16, 61)). */
pub const OTHER_AREA: &str = "8479e412-cae8-8d7c-8357-63caa0c518a9";
pub const NODE: &str = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";

/* The same bytes as the web's `pattern`. */
pub fn pattern(length: usize, seed: u8) -> Vec<u8> {
    (0..length).map(|i| ((i * 31 + seed as usize * 7 + ((i * seed as usize) >> 3)) & 0xff) as u8).collect()
}

pub fn e(bytes: &[u8]) -> String {
    base64url_encode(bytes.to_vec())
}

pub fn s(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_else(|| panic!("{key} is a string")).to_string()
}

pub fn b(value: &Value, key: &str) -> Vec<u8> {
    base64url_decode(s(value, key)).unwrap_or_else(|_| panic!("{key} is base64url"))
}

pub fn n(value: &Value, key: &str) -> u64 {
    value[key].as_u64().unwrap_or_else(|| panic!("{key} is a number"))
}

/* A person's identity at key version 1, every key from the seeds the web uses for person `n`. */
#[derive(Clone)]
pub struct Person {
    pub n: u8,
    pub user_id: String,
    pub keys: IdentityKeys,
    pub served: PublicIdentity,
}

pub fn person(n: u8) -> Person {
    person_at(n, 1)
}

/* Person `n`'s identity at `key_version`, from the seeds the web uses for it. */
pub fn person_at(n: u8, key_version: u8) -> Person {
    let user_id = format!("{n:08x}-abcd-4abc-8abc-abcdefabcdef");
    let base = n * 4 + key_version * 50;
    let x25519 = pattern(32, base);
    let ed25519 = pattern(32, base + 1);
    let ml_dsa = pattern(32, base + 2);
    let kem = pattern(64, base + 3);
    let x25519_public =
        PublicKey::from(&StaticSecret::from(<[u8; 32]>::try_from(x25519.as_slice()).unwrap()));
    // A group key's halves are the same Ed25519 and ML-DSA-65 derivations from two 32-byte seeds.
    let signing = group_public_key([ed25519.clone(), ml_dsa.clone()].concat()).unwrap();
    let kem_seed: Seed = Array::try_from(kem.as_slice()).unwrap();
    let kem_public =
        ml_kem_768::DecapsulationKey::from_seed(kem_seed).encapsulation_key().to_bytes().to_vec();
    let keys = IdentityKeys {
        identity_version: 2,
        key_version: key_version as u64,
        encryption_public_key: e(x25519_public.as_bytes()),
        encryption_private_key: x25519.into(),
        signing_public_key: signing.ed25519_public_key.clone(),
        signing_seed: ed25519.clone().into(),
        kem_seed: kem.into(),
        kem_public_key: Some(e(&kem_public)),
        ml_dsa_seed: ml_dsa.clone().into(),
        ml_dsa_public_key: Some(signing.ml_dsa_public_key.clone()),
    };
    let statement = keys_statement(
        user_id.clone(),
        key_version as u64,
        keys.encryption_public_key.clone(),
        signing.ed25519_public_key.clone(),
        signing.ml_dsa_public_key.clone(),
        e(&kem_public),
    )
    .unwrap();
    let served = PublicIdentity {
        key_version: key_version as u64,
        encryption_public_key: keys.encryption_public_key.clone(),
        signing_public_key: signing.ed25519_public_key,
        ml_dsa_public_key: signing.ml_dsa_public_key,
        kem_public_key: e(&kem_public),
        keys_signature: e(&hybrid_sign(ed25519, ml_dsa, statement).unwrap()),
    };
    Person { n, user_id, keys, served }
}

impl Person {
    pub fn ml_dsa(&self) -> Vec<u8> {
        base64url_decode(self.served.ml_dsa_public_key.clone()).unwrap()
    }

    pub fn kem(&self) -> Vec<u8> {
        base64url_decode(self.served.kem_public_key.clone()).unwrap()
    }

    pub fn entry(&self, roles: &[GroupRole], since: u64, status: MemberStatus) -> RosterMember {
        let mut roles = roles.to_vec();
        roles.sort();
        RosterMember {
            user_id: self.user_id.clone(),
            key_version: self.served.key_version,
            encryption_public_key: self.served.encryption_public_key.clone(),
            signing_public_key: self.served.signing_public_key.clone(),
            ml_dsa_public_key_digest: e(&sha256(&self.ml_dsa())),
            kem_public_key_digest: e(&sha256(&self.kem())),
            status,
            roles,
            since_version: since,
        }
    }
}

pub fn sha256(bytes: &[u8]) -> Vec<u8> {
    use sha2::Digest as _;
    sha2::Sha256::digest(bytes).to_vec()
}

/* The group key at `version`, from the web's seed for it. */
pub fn group_seed(version: u8) -> Vec<u8> {
    pattern(64, 90 + version)
}

/* A reader outside the group, with no entry of its own to check. */
pub fn reader() -> OwnIdentities {
    OwnIdentities { user_id: "ffffffff-ffff-4fff-8fff-ffffffffffff".into(), identities: vec![] }
}

/* The served ML-DSA keys of everyone named, by their SHA-256, as accept_rosters takes them. */
pub fn served_ml_dsa(people: &[&Person]) -> HashMap<String, String> {
    people.iter().map(|p| (e(&sha256(&p.ml_dsa())), p.served.ml_dsa_public_key.clone())).collect()
}

/*
 * The area key every history's rosters list unless told otherwise: AREA at
 * version 1, the key the seal cases grant (pattern(32, 77)), as the web's
 * standardAreas.
 */
pub const AREA_KEY_SEED: u8 = 77;
pub fn standard_areas() -> Vec<RosterArea> {
    vec![RosterArea {
        workspace_id: AREA.into(),
        workspace_key_version: 1,
        commitment: area_key_commitment(&pattern(32, AREA_KEY_SEED)).unwrap(),
        root_commitment: None,
        retired: false,
    }]
}

/* The node key the testkit gives an area's root at an area version (design 2.10), as the web's. */
pub fn root_key_at(workspace_id: &str, version: u64) -> Vec<u8> {
    pattern(32, ((if workspace_id == AREA { 150 } else { 170 }) + version) as u8)
}

/* A format 2 key row: the testkit's area key and root key at `version`. */
pub fn key_row_at(workspace_id: &str, version: u64) -> RosterArea {
    RosterArea {
        root_commitment: Some(area_root_commitment(&root_key_at(workspace_id, version)).unwrap()),
        ..area_row(workspace_id, version)
    }
}

/* A format 2 tombstone at `version`. */
pub fn tombstone_at(workspace_id: &str, version: u64) -> RosterArea {
    RosterArea {
        workspace_id: workspace_id.into(),
        workspace_key_version: version,
        commitment: String::new(),
        root_commitment: None,
        retired: true,
    }
}

/* The key the testkit's rotations give an area at a version: AREA's are pattern(32, 77 + v - 1). */
pub fn area_key_at(workspace_id: &str, version: u64) -> Vec<u8> {
    let seed = if workspace_id == AREA { AREA_KEY_SEED as u64 + version - 1 } else { 100 + version };
    pattern(32, seed as u8)
}

/* An area row at `version` with the testkit's key for it. */
pub fn area_row(workspace_id: &str, version: u64) -> RosterArea {
    RosterArea {
        workspace_id: workspace_id.into(),
        workspace_key_version: version,
        commitment: area_key_commitment(&area_key_at(workspace_id, version)).unwrap(),
        root_commitment: None,
        retired: false,
    }
}

/* Another workspace id, sorting after AREA: a roster's second area (not derived under the group). */
pub const SECOND_AREA: &str = "a0558a81-8dfc-4914-8447-0417b55e2ec5";
pub const THIRD_AREA: &str = "b0558a81-8dfc-4914-8447-0417b55e2ec5";

/* A link of short junk: cheap to serve in bulk, and verifies under nothing. */
pub fn junk_link(old_key_version: u64) -> SuccessionLink {
    SuccessionLink {
        old_key_version,
        new_key_version: old_key_version + 1,
        old_encryption_public_key: "AA".into(),
        old_signing_public_key: "AA".into(),
        old_ml_dsa_public_key: "AA".into(),
        new_encryption_public_key: "AA".into(),
        new_signing_public_key: "AA".into(),
        new_ml_dsa_public_key: "AA".into(),
        new_kem_public_key: "AA".into(),
        signature: "AA".into(),
        consent: None,
    }
}

/* A group's history being written with the web's fixed group seeds, as a holder's client signs it. */
pub struct History {
    pub rosters: Vec<SignedGroupStatement>,
    pub statements: Vec<Roster>,
    pub successions: Vec<SignedGroupStatement>,
    pub key_count: u8,
    pub kind: GroupKind,
    /* Each area's latest key version on the history so far, and the areas it retired. */
    pub area_versions: std::collections::BTreeMap<String, u64>,
    pub retired: std::collections::BTreeSet<String>,
    /* The format the next roster is signed in (design 2.10); a case may switch it. */
    pub format: u8,
}

fn same_entry(a: &RosterMember, b: &RosterMember) -> bool {
    a.key_version == b.key_version
        && a.encryption_public_key == b.encryption_public_key
        && a.signing_public_key == b.signing_public_key
        && a.ml_dsa_public_key_digest == b.ml_dsa_public_key_digest
        && a.kem_public_key_digest == b.kem_public_key_digest
        && a.status == b.status
        && a.roles == b.roles
}

impl History {
    pub fn new() -> History {
        History::of(GroupKind::Family)
    }

    pub fn of(kind: GroupKind) -> History {
        History {
            rosters: vec![],
            statements: vec![],
            successions: vec![],
            key_count: 1,
            kind,
            area_versions: Default::default(),
            retired: Default::default(),
            format: 1,
        }
    }

    /* A history signing format 2 rosters from the first. */
    pub fn format_2() -> History {
        History { format: 2, ..History::new() }
    }

    pub fn key(&self, version: u8) -> GroupPublicKey {
        group_public_key(group_seed(version)).unwrap()
    }

    /*
     * Signs the next roster with `members` under `key_version` (each since-version as
     * roster_next sets it), without roster_next's checks, so a case can write what a server or
     * a removed holder might serve.
     */
    pub fn roster(&mut self, signer: &Person, members: Vec<RosterMember>, key_version: Option<u8>) {
        self.roster_with(signer, members, key_version, None);
    }

    /*
     * The same, carrying the area rows `areas`. By default the first roster creates
     * standard_areas(), and in a family a roster that marks anyone left rotates every area to its
     * next key (area_key_at), as the rules ask; any other roster carries none.
     */
    pub fn roster_with(
        &mut self,
        signer: &Person,
        members: Vec<RosterMember>,
        key_version: Option<u8>,
        areas: Option<Vec<RosterArea>>,
    ) {
        let key_version = key_version.unwrap_or(self.key_count);
        let version = self.statements.len() as u64 + 1;
        let previous = self.statements.last();
        let leaving = previous.is_some_and(|previous| {
            members.iter().any(|member| {
                member.status == MemberStatus::Left
                    && previous
                        .members
                        .iter()
                        .find(|m| m.user_id == member.user_id)
                        .is_some_and(|before| before.status == MemberStatus::Active)
            })
        });
        let format = self.format;
        let row_at = |workspace_id: &str, version: u64| {
            if format == 2 {
                key_row_at(workspace_id, version)
            } else {
                area_row(workspace_id, version)
            }
        };
        let areas = areas.unwrap_or_else(|| match previous {
            None => vec![row_at(AREA, 1)],
            Some(_) if self.kind == GroupKind::Family && leaving => self
                .area_versions
                .iter()
                .filter(|(workspace_id, _)| !self.retired.contains(*workspace_id))
                .map(|(workspace_id, at)| row_at(workspace_id, at + 1))
                .collect(),
            Some(_) => vec![],
        });
        for row in &areas {
            self.area_versions.insert(row.workspace_id.clone(), row.workspace_key_version);
            if row.retired {
                self.retired.insert(row.workspace_id.clone());
            }
        }
        let previous = self.statements.last();
        let mut members: Vec<RosterMember> = members
            .into_iter()
            .map(|mut member| {
                member.roles.sort();
                member.since_version = match previous {
                    None => 1,
                    Some(previous) => match previous.members.iter().find(|m| m.user_id == member.user_id) {
                        Some(before) if same_entry(before, &member) => before.since_version,
                        _ => version,
                    },
                };
                member
            })
            .collect();
        members.sort_by(|a, b| a.user_id.cmp(&b.user_id));
        let roster = Roster {
            group_id: GROUP.into(),
            kind: self.kind,
            roster_version: version,
            previous_roster_digest: self
                .rosters
                .last()
                .map(|r| roster_digest(r.statement.clone()))
                .unwrap_or_default(),
            group_key_version: key_version as u64,
            signer_user_id: signer.user_id.clone(),
            members,
            areas,
            format,
        };
        self.rosters.push(roster_sign(roster.clone(), group_seed(key_version), signer.keys.clone()).unwrap());
        self.statements.push(roster);
    }

    /* Replaces the latest group key, tied to the latest roster. */
    pub fn succession(&mut self, signer: &Person) {
        let from = self.key_count;
        let (old, new) = (self.key(from), self.key(from + 1));
        let succession = GroupKeySuccession {
            group_id: GROUP.into(),
            old_version: from as u64,
            new_version: from as u64 + 1,
            old_ed25519_public_key: old.ed25519_public_key,
            old_ml_dsa_public_key: old.ml_dsa_public_key,
            new_ed25519_public_key: new.ed25519_public_key,
            new_ml_dsa_public_key: new.ml_dsa_public_key,
            last_roster_version: self.rosters.len() as u64,
            last_roster_digest: roster_digest(self.rosters.last().unwrap().statement.clone()),
            signer_user_id: signer.user_id.clone(),
        };
        self.successions
            .push(group_succession_sign(succession, group_seed(from), signer.keys.clone()).unwrap());
        self.key_count += 1;
    }
}

impl Default for History {
    fn default() -> Self {
        History::new()
    }
}

/* Person `who`'s next identity and the version 2 succession link their current one signs. */
pub fn succeed(who: &Person) -> (Person, SuccessionLink) {
    let next = person_at(who.n, who.served.key_version as u8 + 1);
    let link = link_between(who, &next);
    (next, link)
}

/* A version 2 succession link from `who`'s keys to `next`'s, signed by `who`. */
pub fn link_between(who: &Person, next: &Person) -> SuccessionLink {
    link_between_with(who, next, |_| {})
}

/* As link_between, with `change` applied to the fields before `who` signs them. */
pub fn link_between_with(
    who: &Person,
    next: &Person,
    change: impl Fn(&mut SuccessionLink),
) -> SuccessionLink {
    let mut link = SuccessionLink {
        old_key_version: who.served.key_version,
        new_key_version: next.served.key_version,
        old_encryption_public_key: who.served.encryption_public_key.clone(),
        old_signing_public_key: who.served.signing_public_key.clone(),
        old_ml_dsa_public_key: who.served.ml_dsa_public_key.clone(),
        new_encryption_public_key: next.served.encryption_public_key.clone(),
        new_signing_public_key: next.served.signing_public_key.clone(),
        new_ml_dsa_public_key: next.served.ml_dsa_public_key.clone(),
        new_kem_public_key: next.served.kem_public_key.clone(),
        signature: String::new(),
        consent: None,
    };
    change(&mut link);
    let statement = succession_statement(who.user_id.clone(), link.clone()).unwrap();
    link.signature =
        e(&hybrid_sign(who.keys.signing_seed.to_vec(), who.keys.ml_dsa_seed.to_vec(), statement).unwrap());
    link.consent = Some(consent_of(&link, &who.user_id, &who.keys, &next.keys));
    link
}

/*
 * A link's consent (version 3): the statement signed by `old`'s keys then by
 * `fresh`'s, as a member's own client makes it. A test may sign either half
 * with keys the member never held, to model a forgery.
 */
pub fn consent_of(link: &SuccessionLink, user_id: &str, old: &IdentityKeys, fresh: &IdentityKeys) -> String {
    consent_halves(link, user_id, Some(old), Some(fresh))
}

/* A consent with either half signed by the given keys or left zeros (None), to model a forgery. */
pub fn consent_halves(
    link: &SuccessionLink,
    user_id: &str,
    old: Option<&IdentityKeys>,
    fresh: Option<&IdentityKeys>,
) -> String {
    let half = |keys: Option<&IdentityKeys>, role| match keys {
        Some(keys) => {
            let statement = succession_consent_statement(user_id.into(), link.clone(), role).unwrap();
            hybrid_sign(keys.signing_seed.to_vec(), keys.ml_dsa_seed.to_vec(), statement).unwrap()
        }
        None => vec![0u8; SUCCESSION_CONSENT_BYTES / 2],
    };
    let mut consent = half(old, ConsentRole::Old);
    consent.extend(half(fresh, ConsentRole::New));
    e(&consent)
}

/* The same link without the successor's consent: what clients made before round 8. */
pub fn one_sided(link: &SuccessionLink) -> SuccessionLink {
    SuccessionLink { consent: None, ..link.clone() }
}

/* A link from `who`'s X25519 and Ed25519 keys, naming `to`'s ML-DSA key as the old one, to `to`'s keys. */
pub fn other_ml_dsa_link(who: &Person, to: &Person) -> SuccessionLink {
    let mut link = SuccessionLink {
        old_key_version: 1,
        new_key_version: 2,
        old_encryption_public_key: who.served.encryption_public_key.clone(),
        old_signing_public_key: who.served.signing_public_key.clone(),
        old_ml_dsa_public_key: to.served.ml_dsa_public_key.clone(),
        new_encryption_public_key: to.served.encryption_public_key.clone(),
        new_signing_public_key: to.served.signing_public_key.clone(),
        new_ml_dsa_public_key: to.served.ml_dsa_public_key.clone(),
        new_kem_public_key: to.served.kem_public_key.clone(),
        signature: String::new(),
        consent: None,
    };
    let statement = succession_statement(who.user_id.clone(), link.clone()).unwrap();
    link.signature =
        e(&hybrid_sign(who.keys.signing_seed.to_vec(), to.keys.ml_dsa_seed.to_vec(), statement).unwrap());
    link
}

pub fn served_keys(p: &Person) -> ServedKeys {
    ServedKeys {
        key_version: p.served.key_version,
        encryption_public_key: p.served.encryption_public_key.clone(),
        signing_public_key: p.served.signing_public_key.clone(),
        ml_dsa_public_key: p.served.ml_dsa_public_key.clone(),
        kem_public_key: p.served.kem_public_key.clone(),
    }
}

/* What a version 3 pin of `p` keeps, as the web's `pinned()` writes it. */
pub fn pinned(p: &Person) -> PinnedKeys {
    PinnedKeys {
        key_version: Some(p.served.key_version),
        encryption_public_key: p.served.encryption_public_key.clone(),
        signing_public_key: p.served.signing_public_key.clone(),
        ml_dsa_public_key_hash: key_digest(p.ml_dsa()),
    }
}

/* The record every record probe reads: a file's metadata in the family's area. */
pub fn record_statement() -> MetadataStatement {
    MetadataStatement {
        workspace_id: AREA.into(),
        node_id: NODE.into(),
        kind: NodeKind::File,
        metadata_version: 1,
    }
}

pub fn record_envelope() -> Vec<u8> {
    vec![5u8; 96]
}

pub fn record_signature(p: &Person) -> String {
    e(&metadata_sign(p.keys.signing_seed.to_vec(), record_statement(), record_envelope()).unwrap())
}

/* How a reader of the accepted chain is asked about one record in the area. */
#[derive(Clone)]
pub struct RecordProbe {
    pub writer_user_id: String,
    pub signature: String,
    pub pinned: Option<PinnedKeys>,
    /* The pin's trustedVia: the group it was trusted through, when not a words check (r11). */
    pub pinned_via: Option<String>,
    pub served: Option<ServedKeys>,
    pub links: Option<Vec<SuccessionLink>>,
    /* The workspace the record is in, when not the family's area (which alone is in the areas). */
    pub workspace_id: Option<String>,
}

fn verdict_name(verdict: GroupVerdict) -> &'static str {
    match verdict {
        GroupVerdict::Verified => "verified",
        GroupVerdict::SavedFromLink => "saved-from-link",
        GroupVerdict::Resealed => "resealed",
        GroupVerdict::RetiredKey => "retired-key",
        GroupVerdict::UnknownSigner => "unknown-signer",
        GroupVerdict::BadSignature => "bad-signature",
        GroupVerdict::Unsigned => "unsigned",
        GroupVerdict::Unchecked => "unchecked",
        GroupVerdict::KeyConflict => "key-conflict",
        GroupVerdict::FormerMember => "former-member",
    }
}

pub fn record_verdict(chain: Arc<AcceptedRosters>, probe: &RecordProbe) -> Value {
    let statement = MetadataStatement {
        workspace_id: probe.workspace_id.clone().unwrap_or_else(|| AREA.into()),
        ..record_statement()
    };
    let trust = group_writer_trust(
        GROUP.into(),
        HashMap::from([(AREA.to_string(), 1)]),
        GroupReading::Accepted { chain },
        statement.workspace_id.clone(),
        probe.writer_user_id.clone(),
        probe.pinned.clone().map(|keys| WriterPin::of(keys, probe.pinned_via.clone())),
        probe.served.clone(),
        probe.links.clone(),
        None,
    );
    let integrity = group_metadata_integrity(
        trust,
        None,
        statement,
        record_envelope(),
        Some(base64url_decode(probe.signature.clone()).unwrap()),
    );
    json!({ "integrity": verdict_name(integrity.verdict), "via": integrity.via })
}

/* What a holder or the server checks next on the accepted chain: one roster or one succession. */
#[derive(Clone)]
pub struct NextProbe {
    pub roster: Option<SignedGroupStatement>,
    pub succession: Option<SignedGroupStatement>,
    pub identities: Option<HashMap<String, Vec<PublicIdentity>>>,
}

pub fn next_verdict(
    chain: Arc<AcceptedRosters>,
    probe: &NextProbe,
    ml_dsa_keys: &HashMap<String, String>,
) -> Value {
    let roster = match &probe.roster {
        Some(roster) => {
            roster_check_next(chain.clone(), roster.clone(), ml_dsa_keys.clone(), probe.identities.clone())
                .is_ok()
        }
        None => true,
    };
    let succession = match &probe.succession {
        Some(succession) => {
            group_succession_check_next(chain, succession.clone(), ml_dsa_keys.clone()).is_ok()
        }
        None => true,
    };
    json!(if roster && succession { "accepted" } else { "refused" })
}

/*
 * An area root's key a reader opened, asked against the accepted chain
 * (area_root_check, design 2.10), as the web's RootProbe.
 */
#[derive(Clone)]
pub struct RootProbe {
    pub workspace_id: String,
    pub workspace_key_version: u64,
    pub root_key: Vec<u8>,
}

pub fn root_verdict(chain: Arc<AcceptedRosters>, probe: &RootProbe) -> Value {
    json!(match area_root_check(
        chain,
        probe.workspace_id.clone(),
        probe.workspace_key_version,
        probe.root_key.clone()
    ) {
        Ok(true) => "current",
        Ok(false) => "uncommitted",
        Err(_) => "refused",
    })
}

fn root_json(probe: &RootProbe) -> Value {
    json!({
        "workspaceId": probe.workspace_id,
        "workspaceKeyVersion": probe.workspace_key_version,
        "rootKey": e(&probe.root_key),
    })
}

/* A case's root probe, or none for one that is not the shape the web writes (as the fuzzer may make it). */
fn root_of(v: &Value) -> Option<RootProbe> {
    let root_key = v.get("rootKey")?.as_str().filter(|key| !key.is_empty())?;
    Some(RootProbe {
        workspace_id: v.get("workspaceId")?.as_str()?.to_string(),
        workspace_key_version: v.get("workspaceKeyVersion")?.as_u64()?,
        root_key: base64url_decode(root_key.to_string()).ok()?,
    })
}

/* What accept_rosters takes, as the shared cases carry it. */
#[derive(Clone)]
pub struct CaseInput {
    pub first_keys: GroupPublicKey,
    pub first_keys_checked: bool,
    pub pins: Vec<GroupPin>,
    pub rosters: Vec<SignedGroupStatement>,
    pub successions: Vec<SignedGroupStatement>,
    pub ml_dsa_keys: HashMap<String, String>,
    pub me: OwnIdentities,
    pub cache: Option<GroupChainCache>,
    /* When given, the record the accepted chain is asked about. */
    pub record: Option<RecordProbe>,
    /* When given, the next roster or succession checked on the accepted chain. */
    pub next: Option<NextProbe>,
    /* When given, an area root's key checked against the accepted chain (design 2.10). */
    pub root: Option<RootProbe>,
    /* The newcomer's join mark, when the case has one. */
    pub join_mark: Option<JoinMark>,
    /*
     * A cache the core cannot even hold (a field of the wrong shape), written as given: the
     * bindings refuse it at the boundary, so the case is refused (r11).
     */
    pub raw_cache: Option<Value>,
}

fn key_set_json(set: &KeySet) -> Value {
    json!({
        "encryptionPublicKey": set.encryption_public_key,
        "signingPublicKey": set.signing_public_key,
        "mlDsaPublicKeyDigest": set.ml_dsa_public_key_digest,
    })
}

fn key_history_json(history: &HashMap<String, Vec<KeySet>>) -> Value {
    history
        .iter()
        .map(|(user, sets)| (user.clone(), json!(sets.iter().map(key_set_json).collect::<Vec<_>>())))
        .collect::<serde_json::Map<_, _>>()
        .into()
}

pub fn cache_json(cache: &GroupChainCache) -> Value {
    json!({
        "groupId": cache.group_id,
        "rosterDigests": cache.roster_digests,
        "statement": cache.statement,
        "droppedHolder": cache.dropped_holder,
        "groupKeys": cache.group_keys.iter().map(|k| json!({ "ed25519PublicKey": k.ed25519_public_key, "mlDsaPublicKey": k.ml_dsa_public_key })).collect::<Vec<_>>(),
        "successions": cache.successions.iter().map(|s| json!({ "lastRosterVersion": s.last_roster_version, "digest": s.digest, "signerUserId": s.signer_user_id })).collect::<Vec<_>>(),
        "creatorUserId": cache.creator_user_id,
        "keyHistory": key_history_json(&cache.key_history),
        "areaKeys": cache.area_keys,
        "areaRoots": cache.area_roots,
        "retiredAreas": cache.retired_areas,
        "cacheVersion": cache.cache_version,
        "ownEntryWrongAt": cache.own_entry_wrong_at,
    })
}

/*
 * A cache as the web wrote it, or an error for one the core cannot even hold (a field of the
 * wrong shape): the bindings refuse such a value at the boundary, so a case carrying it is
 * judged refused (judge, raw_cache) rather than repaired or panicked on. None for no cache.
 */
pub fn cache_of(value: &Value) -> Result<Option<GroupChainCache>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let bad = |what: &str| format!("a cache's {what} is not the shape the web writes");
    let text = |v: &Value, what: &str| v.as_str().map(str::to_string).ok_or_else(|| bad(what));
    let field = |v: &Value, key: &str| text(&v[key], key);
    let list = |v: &Value, what: &str| v.as_array().cloned().ok_or_else(|| bad(what));
    let strings = |v: &Value, what: &str| -> Result<Vec<String>, String> {
        list(v, what)?.iter().map(|x| text(x, what)).collect()
    };
    let object = |v: &Value, what: &str| v.as_object().cloned().ok_or_else(|| bad(what));
    object(value, "value")?;
    Ok(Some(GroupChainCache {
        group_id: field(value, "groupId")?,
        roster_digests: strings(&value["rosterDigests"], "rosterDigests")?,
        statement: field(value, "statement")?,
        dropped_holder: value["droppedHolder"].as_bool().ok_or_else(|| bad("droppedHolder"))?,
        group_keys: list(&value["groupKeys"], "groupKeys")?
            .iter()
            .map(|k| {
                Ok(GroupPublicKey {
                    ed25519_public_key: field(k, "ed25519PublicKey")?,
                    ml_dsa_public_key: field(k, "mlDsaPublicKey")?,
                })
            })
            .collect::<Result<_, String>>()?,
        successions: list(&value["successions"], "successions")?
            .iter()
            .map(|at| {
                Ok(CachedSuccession {
                    last_roster_version: at["lastRosterVersion"]
                        .as_u64()
                        .ok_or_else(|| bad("lastRosterVersion"))?,
                    digest: field(at, "digest")?,
                    signer_user_id: field(at, "signerUserId")?,
                })
            })
            .collect::<Result<_, String>>()?,
        creator_user_id: field(value, "creatorUserId")?,
        key_history: object(&value["keyHistory"], "keyHistory")?
            .iter()
            .map(|(user, sets)| {
                let sets = list(sets, "keyHistory")?
                    .iter()
                    .map(|set| {
                        Ok(KeySet {
                            encryption_public_key: field(set, "encryptionPublicKey")?,
                            signing_public_key: field(set, "signingPublicKey")?,
                            ml_dsa_public_key_digest: field(set, "mlDsaPublicKeyDigest")?,
                        })
                    })
                    .collect::<Result<_, String>>()?;
                Ok((user.clone(), sets))
            })
            .collect::<Result<_, String>>()?,
        // A cache's areaKeys is an object of lists of strings: anything else is no cache the web
        // made, and the adapter refuses it rather than repairing it.
        area_keys: object(&value["areaKeys"], "areaKeys")?
            .iter()
            .map(|(id, commitments)| Ok((id.clone(), strings(commitments, "areaKeys")?)))
            .collect::<Result<_, String>>()?,
        own_entry_wrong_at: list(&value["ownEntryWrongAt"], "ownEntryWrongAt")?
            .iter()
            .map(|x| x.as_u64().ok_or_else(|| bad("ownEntryWrongAt")))
            .collect::<Result<_, String>>()?,
        // Root commitments (a string or null each) and retired areas: a cache from before format
        // 2 has neither (design 2.10), which the core reads as none.
        area_roots: match &value["areaRoots"] {
            Value::Null => HashMap::new(),
            roots => object(roots, "areaRoots")?
                .iter()
                .map(|(id, list_of)| {
                    let roots = list(list_of, "areaRoots")?
                        .iter()
                        .map(|at| if at.is_null() { Ok(None) } else { text(at, "areaRoots").map(Some) })
                        .collect::<Result<_, String>>()?;
                    Ok((id.clone(), roots))
                })
                .collect::<Result<_, String>>()?,
        },
        retired_areas: match &value["retiredAreas"] {
            Value::Null => vec![],
            retired => strings(retired, "retiredAreas")?,
        },
        // Absent: a cache written before format 2. Anything but a small number is no cache.
        cache_version: match &value["cacheVersion"] {
            Value::Null => 1,
            version => {
                version.as_u64().and_then(|v| u8::try_from(v).ok()).ok_or_else(|| bad("cacheVersion"))?
            }
        },
    }))
}

fn side_json(side: &MarkSide) -> Value {
    json!({
        "digest": side.digest,
        "from": side.from.iter().map(|from| match from {
            MarkSource::Pin => "pin",
            MarkSource::Cache => "cache",
            MarkSource::Join => "join",
            MarkSource::Served => "served",
        }).collect::<Vec<_>>(),
        "signerUserId": side.signer_user_id,
    })
}

/*
 * What accept_rosters says of a case, in full (the web's `verdictOf`): for an
 * accepted chain every field the twins must agree on (the latest roster,
 * whether it dropped a holder and a succession is due, the group key's
 * digest, the creator, the reader's wrong entries, every member's key
 * history, the dead branches, the cache to keep, and when asked the record's
 * verdict and the next statement's), a fork with every side, or refused.
 */
pub fn judge(input: &CaseInput) -> Value {
    if input.raw_cache.is_some() {
        return json!({ "status": "refused" });
    }
    match accept_rosters_joining(
        GROUP.into(),
        input.first_keys.clone(),
        input.first_keys_checked,
        input.pins.clone(),
        input.rosters.clone(),
        input.successions.clone(),
        input.ml_dsa_keys.clone(),
        input.me.clone(),
        input.cache.clone(),
        input.join_mark.clone(),
    ) {
        Ok(RosterChain::Accepted { chain }) => {
            let mut verdict = json!({
                "status": "accepted",
                "rosterVersion": chain.roster().roster_version,
                "droppedHolder": chain.dropped_holder(),
                "successionDue": chain.succession_due(),
                "groupKeyDigest": chain.group_key_digest(),
                "creatorUserId": chain.creator_user_id(),
                "ownEntryWrongAt": chain.own_entry_wrong_at(),
                "ownEntryBehindAt": chain.own_entry_behind_at(),
                "keyHistory": key_history_json(&chain.key_history()),
                "deadBranches": chain.dead_branches().iter().map(|d| json!({ "version": d.version, "signerUserId": d.signer_user_id })).collect::<Vec<_>>(),
                "cache": cache_json(&chain.cache()),
            });
            if let Some(probe) = &input.record {
                verdict["record"] = record_verdict(chain.clone(), probe);
            }
            if let Some(probe) = &input.root {
                verdict["root"] = root_verdict(chain.clone(), probe);
            }
            if let Some(probe) = &input.next {
                verdict["next"] = next_verdict(chain, probe, &input.ml_dsa_keys);
            }
            verdict
        }
        Ok(RosterChain::Fork { of, version, sides }) => json!({
            "status": "fork",
            "of": match of { ForkOf::Roster => "roster", ForkOf::GroupKey => "group-key" },
            "version": version,
            "sides": sides.iter().map(side_json).collect::<Vec<_>>(),
        }),
        Err(_) => json!({ "status": "refused" }),
    }
}

/* Whether a full verdict says what a case declares (for a fork, its kind, version and number of sides). */
pub fn says(verdict: &Value, expected: &Value) -> bool {
    expected.as_object().unwrap().iter().all(|(key, value)| {
        if key == "sides" {
            verdict["sides"].as_array().map(|sides| sides.len() as u64) == value.as_u64()
        } else {
            &verdict[key] == value
        }
    })
}

pub const CHECKED: &str = "2026-10-15T00:00:00.000Z";

/* The chain of `h` up to roster `version`, with the successions tied before it. */
pub fn accepted_to(h: &History, version: u64, people: &[&Person]) -> Arc<AcceptedRosters> {
    let successions = h
        .successions
        .iter()
        .filter(|s| group_succession_parse(s.statement.clone()).unwrap().last_roster_version < version)
        .cloned()
        .collect();
    let Ok(RosterChain::Accepted { chain }) = accept_rosters(
        GROUP.into(),
        h.key(1),
        true,
        vec![],
        h.rosters[..version as usize].to_vec(),
        successions,
        served_ml_dsa(people),
        reader(),
        None,
    ) else {
        panic!("the chain up to {version} is accepted");
    };
    chain
}

/* The accepted chain of all of `h`'s rosters and successions. */
pub fn accepted_of(h: &History, people: &[&Person]) -> Arc<AcceptedRosters> {
    let Ok(RosterChain::Accepted { chain }) = accept_rosters(
        GROUP.into(),
        h.key(1),
        true,
        vec![],
        h.rosters.clone(),
        h.successions.clone(),
        served_ml_dsa(people),
        reader(),
        None,
    ) else {
        panic!("the chain is accepted");
    };
    chain
}

/* A pin at roster `version` of `h`, as the device that accepted the chain up to there writes it. */
pub fn pin_of(h: &History, version: u64, people: &[&Person]) -> GroupPin {
    pin_after(vec![], accepted_to(h, version, people), CHECKED.into()).unwrap()
}

fn sorted(mut members: Vec<RosterMember>) -> Vec<RosterMember> {
    members.sort_by(|a, b| a.user_id.cmp(&b.user_id));
    members
}

/* A statement signed with group key seed `seed` and by `by` (all zeros without), whatever its signer field names. */
fn signed_by(statement: Vec<u8>, seed: Vec<u8>, by: Option<&Person>) -> SignedGroupStatement {
    SignedGroupStatement {
        signature: group_sign(seed, statement.clone()).unwrap(),
        signer_signature: match by {
            Some(by) => {
                hybrid_sign(by.keys.signing_seed.to_vec(), by.keys.ml_dsa_seed.to_vec(), statement.clone())
                    .unwrap()
            }
            None => vec![0; 3373],
        },
        statement,
    }
}

/* `p`'s entry with another person's keys in it (or any change), as a holder may write it. */
fn with(entry: RosterMember, change: impl Fn(&mut RosterMember)) -> RosterMember {
    let mut entry = entry;
    change(&mut entry);
    entry
}

/* Whether two entries say the same, their since-versions aside. */
fn same_but_since(a: &RosterMember, b: &RosterMember) -> bool {
    a == &RosterMember { since_version: a.since_version, ..b.clone() }
}

/*
 * The histories both twins build from the same seeds and must judge alike
 * (the web's `groupCases`, in its order). Each declares only what it is
 * about; the fixture carries the full verdict.
 */
pub fn group_cases() -> Vec<(&'static str, CaseInput, Value)> {
    let (organizer, adult, holder, child, outsider) = (person(1), person(2), person(3), person(4), person(5));
    let everyone = [&organizer, &adult, &holder, &child, &outsider];
    let roles_all = [GroupRole::Billing, GroupRole::Guardian, GroupRole::Members];
    let owner = organizer.entry(&roles_all, 1, MemberStatus::Active);
    let active = |p: &Person, roles: &[GroupRole]| p.entry(roles, 1, MemberStatus::Active);
    let from_with = |h: &History, people: &[&Person]| CaseInput {
        first_keys: h.key(1),
        first_keys_checked: true,
        pins: vec![],
        rosters: h.rosters.clone(),
        successions: h.successions.clone(),
        ml_dsa_keys: served_ml_dsa(people),
        me: reader(),
        cache: None,
        record: None,
        next: None,
        root: None,
        join_mark: None,
        raw_cache: None,
    };
    let from_one = |h: &History| from_with(h, &everyone);
    let fork = |of: &str, version: u64| json!({ "status": "fork", "of": of, "version": version, "sides": 2 });
    let accepted = |version: u64| json!({ "status": "accepted", "rosterVersion": version });
    let dead = |version: u64, signer: &Person| json!({ "status": "accepted", "rosterVersion": null, "deadBranches": [{ "version": version, "signerUserId": signer.user_id }] });
    let with_dead = |at: u64, version: u64, signer: &Person| {
        let mut value = dead(version, signer);
        value["rosterVersion"] = json!(at);
        value
    };
    let reads = |integrity: &str, via: Option<&str>, version: u64| json!({ "status": "accepted", "rosterVersion": version, "record": { "integrity": integrity, "via": via } });
    let next_says =
        |version: u64, next: &str| json!({ "status": "accepted", "rosterVersion": version, "next": next });
    let refused = json!({ "status": "refused" });
    let junk = e(&[7u8; 32]);
    let other_key = group_public_key(pattern(64, 98)).unwrap();
    let mut cases = vec![];

    // Rosters 1-3, then: another 2 beside them (dead), two 3s (ambiguous), a broken link.
    {
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[GroupRole::Billing])], None);
        h.roster(
            &organizer,
            vec![owner.clone(), active(&adult, &[GroupRole::Billing]), active(&outsider, &[])],
            None,
        );
        let mut other2 = h.statements[1].clone();
        other2.members =
            sorted(vec![owner.clone(), active(&adult, &[]), outsider.entry(&[], 2, MemberStatus::Active)]);
        let other2 = roster_sign(other2, group_seed(1), organizer.keys.clone()).unwrap();
        let mut rosters = h.rosters.clone();
        rosters.push(other2.clone());
        cases.push(("dead-branch", CaseInput { rosters, ..from_one(&h) }, with_dead(3, 2, &organizer)));
        let mut other3 = h.statements[2].clone();
        other3.members = sorted(vec![
            owner.clone(),
            active(&adult, &[GroupRole::Billing]),
            child.entry(&[], 3, MemberStatus::Active),
        ]);
        let other3 = roster_sign(other3, group_seed(1), organizer.keys.clone()).unwrap();
        let mut rosters = h.rosters.clone();
        rosters.push(other3);
        cases.push(("two-latest", CaseInput { rosters, ..from_one(&h) }, refused.clone()));
        let mut branch = h.statements[2].clone();
        branch.previous_roster_digest = junk.clone();
        let branch = roster_sign(branch, group_seed(1), organizer.keys.clone()).unwrap();
        cases.push((
            "broken-link",
            CaseInput {
                rosters: vec![h.rosters[0].clone(), h.rosters[1].clone(), branch.clone()],
                ..from_one(&h)
            },
            refused.clone(),
        ));
        cases.push((
            "unchecked-first-keys",
            CaseInput { first_keys_checked: false, ..from_one(&h) },
            refused.clone(),
        ));
        // The person's marks: a pin naming another roster 2; two pins at 2 that disagree; a group
        // key mark that is not the chain's; a pin the chain does not reach; first keys not the pin's.
        let pin2 = pin_of(&h, 2, &everyone);
        let pin3 = pin_of(&h, 3, &everyone);
        let marked = GroupPin { roster_digest: roster_digest(other2.statement.clone()), ..pin2.clone() };
        cases.push((
            "mark-mismatch",
            CaseInput { pins: vec![marked.clone()], ..from_one(&h) },
            fork("roster", 2),
        ));
        cases.push((
            "pins-disagree",
            CaseInput { pins: vec![pin3.clone(), pin2.clone(), marked.clone()], ..from_one(&h) },
            fork("roster", 2),
        ));
        cases.push((
            "pin-key-digest",
            CaseInput {
                pins: vec![GroupPin {
                    group_key_digest: group_key_digest(other_key.clone()).unwrap(),
                    ..pin3.clone()
                }],
                ..from_one(&h)
            },
            fork("group-key", 1),
        ));
        cases.push((
            "rollback",
            CaseInput { pins: vec![pin3.clone()], rosters: h.rosters[..2].to_vec(), ..from_one(&h) },
            refused.clone(),
        ));
        cases.push((
            "first-keys-half",
            CaseInput {
                pins: vec![pin2.clone()],
                first_keys: GroupPublicKey {
                    ml_dsa_public_key: other_key.ml_dsa_public_key.clone(),
                    ..h.key(1)
                },
                ..from_one(&h)
            },
            refused.clone(),
        ));
        // The cache: extended, extended by another branch, a pin it disagrees with, out of form,
        // bound to another roster, and a cache of another roster 2 with the chain served from 1.
        let two = accepted_to(&h, 2, &everyone);
        cases.push((
            "cache-extends",
            CaseInput {
                cache: Some(two.cache()),
                rosters: vec![h.rosters[2].clone()],
                pins: vec![pin2.clone()],
                ..from_one(&h)
            },
            accepted(3),
        ));
        cases.push((
            "cache-branch",
            CaseInput { cache: Some(two.cache()), rosters: vec![branch], ..from_one(&h) },
            refused.clone(),
        ));
        cases.push((
            "cache-pin-disagrees",
            CaseInput {
                cache: Some(two.cache()),
                rosters: vec![h.rosters[2].clone()],
                pins: vec![marked],
                ..from_one(&h)
            },
            fork("roster", 2),
        ));
        let mut garbage = two.cache();
        let adult_entry = active(&adult, &[]);
        garbage.key_history = HashMap::from([(
            adult.user_id.clone(),
            vec![KeySet {
                encryption_public_key: adult_entry.encryption_public_key.clone(),
                signing_public_key: "nope".into(),
                ml_dsa_public_key_digest: adult_entry.ml_dsa_public_key_digest.clone(),
            }],
        )]);
        cases.push((
            "cache-garbage",
            CaseInput { cache: Some(garbage), rosters: vec![h.rosters[2].clone()], ..from_one(&h) },
            refused.clone(),
        ));
        let bound = GroupChainCache { statement: e(&h.rosters[0].statement), ..two.cache() };
        cases.push((
            "cache-bound",
            CaseInput { cache: Some(bound), rosters: vec![h.rosters[2].clone()], ..from_one(&h) },
            refused.clone(),
        ));
        // r9, r10: the cache's last roster's rows must be its areas' latest commitments, and at
        // roster 1 they are every area there is: a cache carrying another key for an area, or
        // an area the first roster never created, is refused. (Earlier commitments are the
        // device's own record, trusted as stored.)
        let one = accepted_to(&h, 1, &everyone);
        let tampered = GroupChainCache {
            area_keys: HashMap::from([(AREA.to_string(), vec![e(&[3u8; 32])])]),
            ..one.cache()
        };
        cases.push((
            "cache-area-keys-tampered",
            CaseInput { cache: Some(tampered), rosters: h.rosters[1..].to_vec(), ..from_one(&h) },
            refused.clone(),
        ));
        let mut extra = one.cache();
        extra.area_keys.insert(SECOND_AREA.to_string(), vec![e(&[3u8; 32])]);
        cases.push((
            "cache-area-keys-extra",
            CaseInput { cache: Some(extra), rosters: h.rosters[1..].to_vec(), ..from_one(&h) },
            refused.clone(),
        ));
        // r11 (Opus 8), r12: a cache whose area key commitment is not a digest is no cache, in either
        // core (a value both twins can hold, so the refusal is each core's own).
        let malformed = GroupChainCache {
            area_keys: HashMap::from([(AREA.to_string(), vec!["nope".to_string()])]),
            ..one.cache()
        };
        cases.push((
            "cache-area-keys-malformed",
            CaseInput { cache: Some(malformed), rosters: h.rosters[1..].to_vec(), ..from_one(&h) },
            refused.clone(),
        ));
        let mut sibling = History::new();
        sibling.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        sibling.roster(
            &organizer,
            vec![owner.clone(), active(&adult, &[]), outsider.entry(&[], 2, MemberStatus::Active)],
            None,
        );
        cases.push((
            "cache-as-marks",
            CaseInput { cache: Some(accepted_to(&sibling, 2, &everyone).cache()), ..from_one(&h) },
            fork("roster", 2),
        ));
        // The next roster and the next succession, as a holder and the server check them.
        let chain = accepted_of(&h, &everyone);
        let next_of = |members: Vec<RosterMember>, signer: &Person| {
            let base = &h.statements[2];
            let members = members
                .into_iter()
                .map(|m| {
                    let before = base.members.iter().find(|b| b.user_id == m.user_id);
                    let since = match before {
                        Some(before) if same_but_since(before, &m) => before.since_version,
                        _ => 4,
                    };
                    RosterMember { since_version: since, ..m }
                })
                .collect();
            let roster = Roster {
                roster_version: 4,
                previous_roster_digest: chain.roster_digest(),
                signer_user_id: signer.user_id.clone(),
                members: sorted(members),
                ..base.clone()
            };
            roster_sign(roster, group_seed(1), signer.keys.clone()).unwrap()
        };
        let next = |roster: Option<SignedGroupStatement>,
                    succession: Option<SignedGroupStatement>,
                    identities: Option<HashMap<String, Vec<PublicIdentity>>>| {
            Some(NextProbe { roster, succession, identities })
        };
        let adding = vec![
            owner.clone(),
            active(&adult, &[GroupRole::Billing]),
            active(&outsider, &[]),
            active(&child, &[]),
        ];
        let identities: HashMap<String, Vec<PublicIdentity>> = [&organizer, &adult, &outsider, &child]
            .iter()
            .map(|p| (p.user_id.clone(), vec![p.served.clone()]))
            .collect();
        cases.push((
            "next-roster",
            CaseInput {
                next: next(Some(next_of(adding.clone(), &organizer)), None, Some(identities.clone())),
                ..from_one(&h)
            },
            next_says(3, "accepted"),
        ));
        cases.push((
            "next-roster-not-holder",
            CaseInput { next: next(Some(next_of(adding, &adult)), None, None), ..from_one(&h) },
            next_says(3, "refused"),
        ));
        cases.push((
            "next-roster-drops-entry",
            CaseInput {
                next: next(
                    Some(next_of(vec![owner.clone(), active(&adult, &[GroupRole::Billing])], &organizer)),
                    None,
                    None,
                ),
                ..from_one(&h)
            },
            next_says(3, "refused"),
        ));
        let planted = next_of(
            vec![
                owner.clone(),
                with(active(&outsider, &[]), |m| {
                    m.user_id = adult.user_id.clone();
                    m.key_version = 1000;
                }),
                active(&outsider, &[]),
            ],
            &organizer,
        );
        cases.push((
            "next-roster-planted",
            CaseInput { next: next(Some(planted.clone()), None, Some(identities)), ..from_one(&h) },
            next_says(3, "refused"),
        ));
        cases.push((
            "next-roster-planted-unchecked",
            CaseInput { next: next(Some(planted), None, None), ..from_one(&h) },
            next_says(3, "accepted"),
        ));
        let succeed_from = |tie: usize| {
            let (old, new) = (h.key(1), h.key(2));
            group_succession_sign(
                GroupKeySuccession {
                    group_id: GROUP.into(),
                    old_version: 1,
                    new_version: 2,
                    old_ed25519_public_key: old.ed25519_public_key,
                    old_ml_dsa_public_key: old.ml_dsa_public_key,
                    new_ed25519_public_key: new.ed25519_public_key,
                    new_ml_dsa_public_key: new.ml_dsa_public_key,
                    last_roster_version: tie as u64,
                    last_roster_digest: roster_digest(h.rosters[tie - 1].statement.clone()),
                    signer_user_id: organizer.user_id.clone(),
                },
                group_seed(1),
                organizer.keys.clone(),
            )
            .unwrap()
        };
        cases.push((
            "next-succession",
            CaseInput { next: next(None, Some(succeed_from(3)), None), ..from_one(&h) },
            next_says(3, "accepted"),
        ));
        cases.push((
            "next-succession-tied-early",
            CaseInput { next: next(None, Some(succeed_from(2)), None), ..from_one(&h) },
            next_says(3, "refused"),
        ));
    }
    // A holder removed at 2 (key replaced, tied to 2), then 3 under key 2; the removed holder
    // forges another 3 under key 1: two latest rosters, refused.
    {
        let left2 = holder.entry(&[GroupRole::Members], 2, MemberStatus::Left);
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&holder, &[GroupRole::Members])], None);
        h.roster(&organizer, vec![owner.clone(), left2.clone()], None);
        h.succession(&organizer);
        h.roster(&organizer, vec![owner.clone(), left2, active(&adult, &[])], Some(2));
        let mut forged = h.statements[2].clone();
        forged.group_key_version = 1;
        forged.signer_user_id = holder.user_id.clone();
        forged.members = sorted(vec![owner.clone(), active(&holder, &[GroupRole::Members])]);
        let forged = signed_by(roster_statement(forged).unwrap(), group_seed(1), Some(&holder));
        let mut rosters = h.rosters.clone();
        rosters.push(forged);
        cases.push(("forged-latest", CaseInput { rosters, ..from_one(&h) }, refused.clone()));
    }
    // A succession tied to 2, then 3 still under key 1; a removal at 2 with no succession.
    {
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone()], None);
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        h.succession(&organizer);
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[]), active(&outsider, &[])], Some(1));
        cases.push(("key-window", from_one(&h), refused.clone()));
        let left2 = holder.entry(&[GroupRole::Members], 2, MemberStatus::Left);
        let mut g = History::new();
        g.roster(&organizer, vec![owner.clone(), active(&holder, &[GroupRole::Members])], None);
        g.roster(&organizer, vec![owner.clone(), left2.clone()], None);
        g.roster(&organizer, vec![owner.clone(), left2, active(&adult, &[])], None);
        cases.push(("succession-due", from_one(&g), refused.clone()));
    }
    // Two successions from key 1 that both hold: refused, unless a group key mark chooses.
    {
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        h.succession(&organizer);
        let mut rival = group_succession_parse(h.successions[0].statement.clone()).unwrap();
        rival.new_ed25519_public_key = other_key.ed25519_public_key.clone();
        rival.new_ml_dsa_public_key = other_key.ml_dsa_public_key.clone();
        let rival = signed_by(group_succession_statement(rival).unwrap(), group_seed(1), Some(&organizer));
        let mut successions = h.successions.clone();
        successions.push(rival);
        let both = CaseInput { successions, ..from_one(&h) };
        cases.push(("two-successions", both.clone(), refused.clone()));
        let pin = pin_after(vec![], accepted_of(&h, &everyone), CHECKED.into()).unwrap();
        cases.push(("two-successions-marked", CaseInput { pins: vec![pin.clone()], ..both }, accepted(1)));
        // F6: two pins naming different group keys at one key version.
        let rival_pin =
            GroupPin { group_key_digest: group_key_digest(other_key.clone()).unwrap(), ..pin.clone() };
        cases.push((
            "pins-other-group-key",
            CaseInput { pins: vec![pin, rival_pin], ..from_one(&h) },
            fork("group-key", 2),
        ));
    }
    // The organizer replaces their identity; the holder folds it in at 3; the organizer signs 4 with it.
    {
        let (organizer2, _) = succeed(&organizer);
        let owner2 = organizer2.entry(&roles_all, 1, MemberStatus::Active);
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&holder, &[GroupRole::Members])], None);
        h.roster(
            &organizer,
            vec![owner.clone(), active(&holder, &[GroupRole::Members]), active(&adult, &[])],
            None,
        );
        h.roster(
            &holder,
            vec![owner2.clone(), active(&holder, &[GroupRole::Members]), active(&adult, &[])],
            None,
        );
        h.roster(
            &organizer2,
            vec![owner2, active(&holder, &[GroupRole::Members]), active(&adult, &[GroupRole::Billing])],
            None,
        );
        let three = [&organizer, &organizer2, &holder];
        cases.push(("identity-change", from_with(&h, &three), accepted(4)));
        // An Ed25519 forger signing as the organizer with their own ML-DSA key, served under the organizer's digest.
        let forge = |signed: &SignedGroupStatement| SignedGroupStatement {
            signer_signature: hybrid_sign(
                organizer.keys.signing_seed.to_vec(),
                outsider.keys.ml_dsa_seed.to_vec(),
                signed.statement.clone(),
            )
            .unwrap(),
            ..signed.clone()
        };
        let mut keys = served_ml_dsa(&[&organizer2, &holder]);
        keys.insert(e(&sha256(&organizer.ml_dsa())), outsider.served.ml_dsa_public_key.clone());
        cases.push((
            "signer-ml-dsa-substituted",
            CaseInput {
                rosters: h.rosters.iter().map(forge).collect(),
                ml_dsa_keys: keys,
                ..from_with(&h, &three)
            },
            refused.clone(),
        ));
    }
    // The entry rules: an entry dropped, a sinceVersion not the version it changed at.
    {
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        let second = |members: Vec<RosterMember>| {
            let roster = Roster {
                roster_version: 2,
                previous_roster_digest: roster_digest(h.rosters[0].statement.clone()),
                members: sorted(members),
                ..h.statements[0].clone()
            };
            roster_sign(roster, group_seed(1), organizer.keys.clone()).unwrap()
        };
        let dropped = second(vec![owner.clone()]);
        cases.push((
            "entry-dropped",
            CaseInput { rosters: vec![h.rosters[0].clone(), dropped], ..from_one(&h) },
            refused.clone(),
        ));
        let stale = second(vec![owner.clone(), active(&adult, &[GroupRole::Billing])]);
        cases.push((
            "since-version-wrong",
            CaseInput { rosters: vec![h.rosters[0].clone(), stale], ..from_one(&h) },
            refused.clone(),
        ));
    }
    // The adult's entry swapped for the outsider's keys at 2, then their own third identity at 3.
    {
        let (adult2, _) = succeed(&adult);
        let (adult3, _) = succeed(&adult2);
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        h.roster(
            &organizer,
            vec![
                owner.clone(),
                with(active(&outsider, &[]), |m| {
                    m.user_id = adult.user_id.clone();
                    m.key_version = 2;
                }),
            ],
            None,
        );
        h.roster(&organizer, vec![owner.clone(), active(&adult3, &[])], None);
        let me = OwnIdentities {
            user_id: adult.user_id.clone(),
            identities: vec![served_keys(&adult), served_keys(&adult2), served_keys(&adult3)],
        };
        cases.push(("wrong-own-entry", CaseInput { me: me.clone(), ..from_one(&h) }, accepted(3)));
        // r8: the adult's entry moved to their own second identity while they hold a third: a
        // replaced identity of theirs, a soft note at each roster it changed to one (1 and 2).
        let mut behind = History::new();
        behind.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        behind.roster(&organizer, vec![owner.clone(), active(&adult2, &[])], None);
        let mut expected = accepted(2);
        expected["ownEntryBehindAt"] = json!([1, 2]);
        cases.push(("own-entry-behind", CaseInput { me, ..from_one(&behind) }, expected));
    }
    // Probes 1, 1b, 1c, F2, F3: a roster's keys are a holder's claim; versions are free.
    {
        let restarted = person_at(2, 2);
        let (adult3, _) = succeed(&restarted);
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        h.roster(&organizer, vec![owner.clone(), active(&adult3, &[])], None);
        cases.push(("entry-several-versions-ahead", from_one(&h), accepted(2)));
        let (adult2, link) = succeed(&adult);
        let mut base = History::new();
        base.roster(
            &organizer,
            vec![owner.clone(), active(&adult, &[]), active(&holder, &[GroupRole::Members])],
            None,
        );
        base.roster(
            &holder,
            vec![
                owner.clone(),
                with(active(&outsider, &[]), |m| {
                    m.user_id = adult.user_id.clone();
                    m.key_version = 2;
                }),
                active(&holder, &[GroupRole::Members]),
            ],
            None,
        );
        base.roster(
            &organizer,
            vec![owner.clone(), active(&adult, &[]), active(&holder, &[GroupRole::Members])],
            None,
        );
        cases.push(("wrong-entry-restored-back", from_one(&base), accepted(3)));
        // F3: the outsider's key planted at 2 and taken out at 3 never vouches, even as retired.
        cases.push((
            "f3-planted-key",
            CaseInput {
                record: Some(RecordProbe {
                    writer_user_id: adult.user_id.clone(),
                    signature: record_signature(&outsider),
                    pinned: None,
                    served: Some(served_keys(&adult)),
                    links: Some(vec![]),
                    pinned_via: None,
                    workspace_id: None,
                }),
                ..from_one(&base)
            },
            reads("bad-signature", None, 3),
        ));
        // F2: the adult's own keys written at key version 1000 (and another KEM key); their real
        // succession is still followed from the entry's keys.
        let mut f2 = History::new();
        f2.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        f2.roster(
            &organizer,
            vec![
                owner.clone(),
                with(active(&adult, &[]), |m| {
                    m.kem_public_key_digest = active(&outsider, &[]).kem_public_key_digest;
                    m.key_version = 1000;
                }),
            ],
            None,
        );
        cases.push((
            "f2-inflated-version",
            CaseInput {
                record: Some(RecordProbe {
                    writer_user_id: adult.user_id.clone(),
                    signature: record_signature(&adult2),
                    pinned: None,
                    served: Some(served_keys(&adult2)),
                    links: Some(vec![link]),
                    pinned_via: None,
                    workspace_id: None,
                }),
                ..from_one(&f2)
            },
            reads("verified", Some(GROUP), 2),
        ));
    }
    // P2, P3: the holder is removed at 3 and the key replaced; the outsider poses as the holder.
    {
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&holder, &[GroupRole::Members])], None);
        h.roster(
            &organizer,
            vec![owner.clone(), active(&holder, &[GroupRole::Members]), active(&outsider, &[])],
            None,
        );
        h.roster(
            &organizer,
            vec![
                owner.clone(),
                holder.entry(&[GroupRole::Members], 3, MemberStatus::Left),
                active(&outsider, &[]),
            ],
            None,
        );
        h.succession(&organizer);
        let posing = with(outsider.entry(&[GroupRole::Members], 2, MemberStatus::Active), |m| {
            m.user_id = holder.user_id.clone()
        });
        let rival2 = Roster {
            signer_user_id: holder.user_id.clone(),
            members: sorted(vec![owner.clone(), posing]),
            ..h.statements[1].clone()
        };
        let rival2 = signed_by(roster_statement(rival2).unwrap(), group_seed(1), Some(&outsider));
        let mut rosters = h.rosters.clone();
        rosters.push(rival2);
        cases.push(("p3-self-listed-rival", CaseInput { rosters, ..from_one(&h) }, with_dead(3, 2, &holder)));
        let alt = Roster {
            signer_user_id: holder.user_id.clone(),
            members: h.statements[1]
                .members
                .iter()
                .map(|m| {
                    if m.user_id == outsider.user_id {
                        RosterMember { roles: vec![GroupRole::Members], since_version: 3, ..m.clone() }
                    } else {
                        m.clone()
                    }
                })
                .collect(),
            ..h.statements[2].clone()
        };
        let alt = roster_sign(alt, group_seed(1), holder.keys.clone()).unwrap();
        let withheld = CaseInput {
            rosters: vec![h.rosters[0].clone(), h.rosters[1].clone(), alt],
            successions: vec![],
            ..from_one(&h)
        };
        cases.push(("p2b-missed-removal", withheld.clone(), accepted(3)));
        cases.push((
            "p2b-caught-by-pin",
            CaseInput { pins: vec![pin_of(&h, 3, &everyone)], ..withheld },
            fork("roster", 3),
        ));
    }
    // F1, P4, p4b: a former holder of key 1 at a chain of nine rosters, six under key 2.
    {
        let gone = holder.entry(&[GroupRole::Members], 3, MemberStatus::Left);
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&holder, &[GroupRole::Members])], None);
        h.roster(
            &organizer,
            vec![
                owner.clone(),
                active(&holder, &[GroupRole::Members]),
                adult.entry(&[], 2, MemberStatus::Active),
            ],
            None,
        );
        h.roster(
            &organizer,
            vec![owner.clone(), gone.clone(), adult.entry(&[], 2, MemberStatus::Active)],
            None,
        );
        h.succession(&organizer);
        for i in 0..6 {
            let roles: &[GroupRole] = if i % 2 == 1 { &[GroupRole::Billing] } else { &[] };
            h.roster(&organizer, vec![owner.clone(), gone.clone(), active(&adult, roles)], Some(2));
        }
        let pin9 = pin_of(&h, 9, &everyone);
        // F1: long after their removal, the holder signs another roster 2 under key 1.
        let back = Roster {
            signer_user_id: holder.user_id.clone(),
            members: sorted(vec![
                owner.clone(),
                active(&holder, &[GroupRole::Members]),
                outsider.entry(&[], 2, MemberStatus::Active),
            ]),
            ..h.statements[1].clone()
        };
        let back = roster_sign(back, group_seed(1), holder.keys.clone()).unwrap();
        let mut rosters = h.rosters.clone();
        rosters.push(back);
        cases.push((
            "f1-former-holder-rival",
            CaseInput { pins: vec![pin9.clone()], rosters: rosters.clone(), ..from_one(&h) },
            with_dead(9, 2, &holder),
        ));
        let full = accepted_of(&h, &everyone);
        cases.push((
            "f1-with-cache",
            CaseInput { pins: vec![pin9.clone()], rosters, cache: Some(full.cache()), ..from_one(&h) },
            with_dead(9, 2, &holder),
        ));
        // F1: an orphaned roster 5 of the organizer's (one the server never stored).
        let mut members = h.statements[4].members.clone();
        members.push(child.entry(&[], 5, MemberStatus::Active));
        let orphan = Roster { members: sorted(members), ..h.statements[4].clone() };
        let orphan = roster_sign(orphan, group_seed(2), organizer.keys.clone()).unwrap();
        let mut rosters = h.rosters.clone();
        rosters.push(orphan);
        cases.push((
            "f1-orphan",
            CaseInput { pins: vec![pin9], rosters, ..from_one(&h) },
            with_dead(9, 5, &organizer),
        ));
        let real = group_succession_parse(h.successions[0].statement.clone()).unwrap();
        let far = GroupKeySuccession {
            last_roster_version: 100,
            signer_user_id: holder.user_id.clone(),
            ..real.clone()
        };
        let far = signed_by(group_succession_statement(far).unwrap(), group_seed(1), None);
        let mut successions = h.successions.clone();
        successions.push(far);
        cases.push(("p4-far-succession", CaseInput { successions, ..from_one(&h) }, accepted(9)));
        let own = group_public_key(pattern(64, 200)).unwrap();
        let in_order = GroupKeySuccession {
            new_ed25519_public_key: own.ed25519_public_key,
            new_ml_dsa_public_key: own.ml_dsa_public_key,
            signer_user_id: holder.user_id.clone(),
            ..real
        };
        let in_order = signed_by(group_succession_statement(in_order).unwrap(), group_seed(1), Some(&holder));
        let mut successions = h.successions.clone();
        successions.push(in_order.clone());
        cases.push(("p4b-in-order-rival", CaseInput { successions, ..from_one(&h) }, accepted(9)));
        // A cache through 9, then the rival succession served alone: it is off the cache's chain.
        cases.push((
            "cache-ignores-other-succession",
            CaseInput {
                cache: Some(full.cache()),
                rosters: vec![],
                successions: vec![in_order],
                ..from_one(&h)
            },
            accepted(9),
        ));
    }
    // A succession tied before the one into its key; a roster served twice; a copy with a bad signature.
    {
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[GroupRole::Billing])], None);
        h.succession(&organizer);
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[])], Some(2));
        h.succession(&organizer);
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[GroupRole::Billing])], Some(3));
        let early = GroupKeySuccession {
            last_roster_version: 1,
            last_roster_digest: roster_digest(h.rosters[0].statement.clone()),
            ..group_succession_parse(h.successions[1].statement.clone()).unwrap()
        };
        let early = signed_by(group_succession_statement(early).unwrap(), group_seed(2), Some(&organizer));
        cases.push((
            "succession-out-of-order",
            CaseInput { successions: vec![h.successions[0].clone(), early], ..from_one(&h) },
            refused.clone(),
        ));
        let again = roster_sign(h.statements[1].clone(), group_seed(1), organizer.keys.clone()).unwrap();
        let mut rosters = h.rosters.clone();
        rosters.push(again.clone());
        cases.push(("same-statement-twice", CaseInput { rosters, ..from_one(&h) }, accepted(4)));
        let mut flipped = again;
        flipped.signature.ml_dsa[9] ^= 1;
        let mut rosters = h.rosters.clone();
        rosters.push(flipped.clone());
        cases.push(("bad-copy-beside-good", CaseInput { rosters, ..from_one(&h) }, accepted(4)));
        let mut rosters = h.rosters.clone();
        rosters[1] = flipped;
        cases.push(("only-bad-copy", CaseInput { rosters, ..from_one(&h) }, refused.clone()));
    }
    // Records read through the chain: the adult replaced their identity (folded in at 3 in the
    // second history), and writes before and after.
    {
        let (adult2, link) = succeed(&adult);
        let (adult3, second) = succeed(&adult2);
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[GroupRole::Billing])], None);
        let lagging = from_one(&h);
        let by_new = record_signature(&adult2);
        let by_old = record_signature(&adult);
        let lag = RecordProbe {
            writer_user_id: adult.user_id.clone(),
            signature: by_new,
            pinned: None,
            served: Some(served_keys(&adult2)),
            links: Some(vec![link.clone()]),
            pinned_via: None,
            workspace_id: None,
        };
        let probe = |record: RecordProbe| CaseInput { record: Some(record), ..lagging.clone() };
        cases.push(("record-roster-lag", probe(lag.clone()), reads("verified", Some(GROUP), 2)));
        cases.push((
            "record-roster-lag-pinned",
            probe(RecordProbe { pinned: Some(pinned(&adult2)), ..lag.clone() }),
            reads("verified", None, 2),
        ));
        cases.push((
            "record-two-link-lag",
            probe(RecordProbe {
                served: Some(served_keys(&adult3)),
                links: Some(vec![link, second]),
                ..lag.clone()
            }),
            reads("retired-key", None, 2),
        ));
        let unloaded = RecordProbe { served: None, links: None, ..lag.clone() };
        cases.push(("record-lag-unloaded", probe(unloaded.clone()), reads("unchecked", None, 2)));
        let mut flipped = base64url_decode(by_old.clone()).unwrap();
        flipped[0] ^= 1;
        let flipped = e(&flipped);
        let loaded_old =
            RecordProbe { served: Some(served_keys(&adult)), links: Some(vec![]), ..lag.clone() };
        cases.push((
            "record-tampered",
            probe(RecordProbe { signature: flipped.clone(), ..loaded_old.clone() }),
            reads("bad-signature", None, 2),
        ));
        cases.push((
            "record-tampered-unloaded",
            probe(RecordProbe { signature: flipped, ..unloaded }),
            reads("unchecked", None, 2),
        ));
        cases.push((
            "record-forged",
            probe(RecordProbe { signature: record_signature(&outsider), ..loaded_old }),
            reads("bad-signature", None, 2),
        ));
        h.roster(&organizer, vec![owner.clone(), active(&adult2, &[GroupRole::Billing])], None);
        cases.push((
            "record-retired-key",
            CaseInput { record: Some(RecordProbe { signature: by_old, ..lag }), ..from_one(&h) },
            reads("retired-key", None, 3),
        ));
    }
    // The fifth review's probes. p4: an unsigned chain naming the child as signer, against a pin;
    // p7: an unsigned roster after the cache that does not continue it. Neither is a warning.
    {
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[GroupRole::Members])], None);
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[GroupRole::Members])], None);
        let unsigned = |statement: Vec<u8>| SignedGroupStatement {
            statement,
            signature: GroupSignature { ed25519: vec![0; 64], ml_dsa: vec![0; 3309] },
            signer_signature: vec![0; 3373],
        };
        let mut fabricated = vec![];
        let mut previous = String::new();
        for version in 1..=3u64 {
            let statement = roster_statement(Roster {
                roster_version: version,
                previous_roster_digest: previous.clone(),
                signer_user_id: child.user_id.clone(),
                members: vec![active(&child, &[GroupRole::Members])],
                ..h.statements[0].clone()
            })
            .unwrap();
            previous = roster_digest(statement.clone());
            fabricated.push(unsigned(statement));
        }
        let pin2 = pin_of(&h, 2, &everyone);
        cases.push((
            "unsigned-chain-vs-pin",
            CaseInput {
                pins: vec![pin2.clone()],
                first_keys_checked: false,
                rosters: fabricated,
                ..from_one(&h)
            },
            refused.clone(),
        ));
        let two = accepted_to(&h, 2, &everyone);
        let off = roster_statement(Roster {
            previous_roster_digest: junk.clone(),
            signer_user_id: child.user_id.clone(),
            ..h.statements[2].clone()
        })
        .unwrap();
        cases.push((
            "cache-junk-extension",
            CaseInput {
                cache: Some(two.cache()),
                first_keys_checked: false,
                rosters: vec![unsigned(off)],
                ..from_one(&h)
            },
            refused.clone(),
        ));
        // The same chain verifying under other version 1 keys than the pin's: the warning.
        let elsewhere = h.statements[..2]
            .iter()
            .map(|roster| roster_sign(roster.clone(), group_seed(7), organizer.keys.clone()).unwrap())
            .collect();
        cases.push((
            "first-keys-elsewhere",
            CaseInput {
                pins: vec![pin2],
                first_keys: group_public_key(group_seed(7)).unwrap(),
                rosters: elsewhere,
                successions: vec![],
                ..from_one(&h)
            },
            refused.clone(),
        ));
    }
    // p3: a removed holder's rival succession tied before the real one, against group key marks.
    {
        let gone = holder.entry(&[GroupRole::Members], 1, MemberStatus::Left);
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&holder, &[GroupRole::Members])], None);
        h.roster(&organizer, vec![owner.clone(), gone.clone()], None);
        h.succession(&organizer);
        h.roster(&organizer, vec![owner.clone(), gone], Some(2));
        let rival_key = group_public_key(group_seed(7)).unwrap();
        let early = GroupKeySuccession {
            new_ed25519_public_key: rival_key.ed25519_public_key,
            new_ml_dsa_public_key: rival_key.ml_dsa_public_key,
            last_roster_version: 1,
            last_roster_digest: roster_digest(h.rosters[0].statement.clone()),
            signer_user_id: holder.user_id.clone(),
            ..group_succession_parse(h.successions[0].statement.clone()).unwrap()
        };
        let early = signed_by(group_succession_statement(early).unwrap(), group_seed(1), Some(&holder));
        let mut both = h.successions.clone();
        both.push(early.clone());
        cases.push((
            "rival-succession-waits",
            CaseInput {
                pins: vec![pin_of(&h, 3, &everyone)],
                first_keys_checked: false,
                successions: both,
                ..from_one(&h)
            },
            accepted(3),
        ));
        let RosterChain::Accepted { chain: at_two } = accept_rosters(
            GROUP.into(),
            h.key(1),
            true,
            vec![],
            h.rosters[..2].to_vec(),
            h.successions.clone(),
            served_ml_dsa(&everyone),
            reader(),
            None,
        )
        .unwrap() else {
            panic!("the chain at 2 is accepted");
        };
        let at_two = pin_after(vec![], at_two, CHECKED.into()).unwrap();
        cases.push((
            "rival-succession-mark-unmet",
            CaseInput {
                pins: vec![at_two],
                first_keys_checked: false,
                rosters: h.rosters[..2].to_vec(),
                successions: vec![early.clone()],
                ..from_one(&h)
            },
            refused.clone(),
        ));
        // Roster 3 under the real key 2 while only the rival is served: missing, refused.
        cases.push((
            "rival-succession-real-withheld",
            CaseInput {
                pins: vec![pin_of(&h, 3, &everyone)],
                first_keys_checked: false,
                successions: vec![early.clone()],
                ..from_one(&h)
            },
            refused.clone(),
        ));
        // Roster 3 signed by a holder under the rival key: a real other history, the warning.
        let mut rivalled = h.rosters[..2].to_vec();
        rivalled.push(roster_sign(h.statements[2].clone(), group_seed(7), organizer.keys.clone()).unwrap());
        cases.push((
            "rival-key-signed-roster",
            CaseInput {
                pins: vec![pin_of(&h, 3, &everyone)],
                first_keys_checked: false,
                rosters: rivalled,
                successions: vec![early.clone()],
                ..from_one(&h)
            },
            fork("group-key", 2),
        ));
        // Under the rival key but signed by the removed holder: nothing a holder signed, refused.
        let mut by_removed = h.rosters[..2].to_vec();
        by_removed.push(
            roster_sign(
                Roster { signer_user_id: holder.user_id.clone(), ..h.statements[2].clone() },
                group_seed(7),
                holder.keys.clone(),
            )
            .unwrap(),
        );
        cases.push((
            "rival-key-roster-by-removed-holder",
            CaseInput {
                pins: vec![pin_of(&h, 3, &everyone)],
                first_keys_checked: false,
                rosters: by_removed,
                successions: vec![early.clone()],
                ..from_one(&h)
            },
            refused.clone(),
        ));
        // r12: under the rival key, signed by a holder, but breaking the departure rules (the signer
        // leaves on it, and no holder is left): refused, never the warning.
        let mut leaving = h.rosters[..2].to_vec();
        let all_left = Roster {
            members: h.statements[2]
                .members
                .iter()
                .map(|entry| RosterMember { status: MemberStatus::Left, ..entry.clone() })
                .collect(),
            ..h.statements[2].clone()
        };
        leaving.push(roster_sign(all_left, group_seed(7), organizer.keys.clone()).unwrap());
        cases.push((
            "rival-key-roster-signer-leaves",
            CaseInput {
                pins: vec![pin_of(&h, 3, &everyone)],
                first_keys_checked: false,
                rosters: leaving,
                successions: vec![early.clone()],
                ..from_one(&h)
            },
            refused.clone(),
        ));
        // A succession whose "new" key is the key it replaces, and roster 3 signed under that key:
        // taken, it would let the replaced key go on signing.
        let first = h.key(1);
        let same = GroupKeySuccession {
            new_ed25519_public_key: first.ed25519_public_key,
            new_ml_dsa_public_key: first.ml_dsa_public_key,
            ..group_succession_parse(h.successions[0].statement.clone()).unwrap()
        };
        let mut under_old = h.rosters[..2].to_vec();
        under_old.push(roster_sign(h.statements[2].clone(), group_seed(1), organizer.keys.clone()).unwrap());
        cases.push((
            "succession-to-the-old-key",
            CaseInput {
                rosters: under_old,
                successions: vec![signed_by(
                    group_succession_statement(same).unwrap(),
                    group_seed(1),
                    Some(&organizer),
                )],
                ..from_one(&h)
            },
            refused.clone(),
        ));
    }
    // r8 (Fable F3), r10: the join mark, the roster that admitted the child (2, signed by the
    // adult) by its twelve-word code over the roster's digest, its group key and key version: met;
    // another roster, key or key version is the warning; a chain short of it is a rollback; a
    // shorter code is no mark.
    {
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[GroupRole::Members])], None);
        h.roster(
            &adult,
            vec![owner.clone(), active(&adult, &[GroupRole::Members]), active(&child, &[])],
            None,
        );
        let at_two = roster_digest(h.rosters[1].statement.clone());
        let mark = JoinMark { roster_version: 2, code: join_code(at_two.clone(), h.key(1), 1).unwrap() };
        let joining = |mark: JoinMark| CaseInput { join_mark: Some(mark), ..from_one(&h) };
        cases.push(("join-mark-holds", joining(mark.clone()), accepted(2)));
        cases.push((
            "join-mark-other-roster",
            joining(JoinMark {
                code: join_code(roster_digest(h.rosters[0].statement.clone()), h.key(1), 1).unwrap(),
                ..mark.clone()
            }),
            fork("roster", 2),
        ));
        cases.push((
            "join-mark-other-group-key",
            joining(JoinMark { code: join_code(at_two.clone(), h.key(2), 1).unwrap(), ..mark.clone() }),
            fork("roster", 2),
        ));
        cases.push((
            "join-mark-other-group-key-version",
            joining(JoinMark { code: join_code(at_two, h.key(1), 2).unwrap(), ..mark.clone() }),
            fork("roster", 2),
        ));
        cases.push((
            "join-mark-beyond-chain",
            joining(JoinMark { roster_version: 3, ..mark.clone() }),
            refused.clone(),
        ));
        cases.push((
            "join-mark-short-code",
            joining(JoinMark { code: mark.code[..11].to_vec(), ..mark }),
            refused.clone(),
        ));
        // After a succession: roster 3 is under key 2, and the code names key 2.
        let mut after = History::new();
        after.roster(&organizer, vec![owner.clone(), active(&adult, &[GroupRole::Members])], None);
        after.roster(
            &organizer,
            vec![owner.clone(), active(&adult, &[GroupRole::Members]), active(&holder, &[])],
            None,
        );
        after.succession(&organizer);
        after.roster(
            &adult,
            vec![
                owner.clone(),
                active(&adult, &[GroupRole::Members]),
                active(&holder, &[]),
                active(&child, &[]),
            ],
            Some(2),
        );
        let at_three = roster_digest(after.rosters[2].statement.clone());
        cases.push((
            "join-mark-after-succession",
            CaseInput {
                join_mark: Some(JoinMark {
                    roster_version: 3,
                    code: join_code(at_three.clone(), after.key(2), 2).unwrap(),
                }),
                ..from_one(&after)
            },
            accepted(3),
        ));
        cases.push((
            "join-mark-after-succession-first-key",
            CaseInput {
                join_mark: Some(JoinMark {
                    roster_version: 3,
                    code: join_code(at_three, after.key(1), 1).unwrap(),
                }),
                ..from_one(&after)
            },
            fork("roster", 3),
        ));
        // The roster a succession is tied to is the last under the old key: a mark there names key 1.
        cases.push((
            "join-mark-at-succession-tie",
            CaseInput {
                join_mark: Some(JoinMark {
                    roster_version: 2,
                    code: join_code(roster_digest(after.rosters[1].statement.clone()), after.key(1), 1)
                        .unwrap(),
                }),
                ..from_one(&after)
            },
            accepted(3),
        ));
        // Version 1 keys the server made, under the honest code: the same roster bytes with their
        // signers' signatures, group-signed again by the server's key. The roster statements name
        // no group key, so only the code holds the first keys: with the join roster under key 1
        // the code names key 1, and the chain's is the server's, the warning.
        let made = pattern(64, 150);
        let made_key = group_public_key(made.clone()).unwrap();
        let remade = |at: &SignedGroupStatement| SignedGroupStatement {
            signature: group_sign(made.clone(), at.statement.clone()).unwrap(),
            ..at.clone()
        };
        cases.push((
            "join-mark-made-up-first-keys",
            CaseInput {
                first_keys: made_key.clone(),
                rosters: h.rosters.iter().map(remade).collect(),
                join_mark: Some(JoinMark {
                    roster_version: 2,
                    code: join_code(roster_digest(h.rosters[1].statement.clone()), h.key(1), 1).unwrap(),
                }),
                ..from_one(&h)
            },
            fork("roster", 2),
        ));
        // After a succession the code names key 2: the server's key 1 reaches it only through a
        // succession from its key, which a holder must sign. Without one it is refused. (A holder
        // who signs one can serve such a history: see the threat model.)
        let mut forged = group_succession_parse(after.successions[0].statement.clone()).unwrap();
        forged.old_ed25519_public_key = made_key.ed25519_public_key.clone();
        forged.old_ml_dsa_public_key = made_key.ml_dsa_public_key.clone();
        cases.push((
            "join-mark-made-up-first-keys-succession",
            CaseInput {
                first_keys: made_key,
                rosters: vec![remade(&after.rosters[0]), remade(&after.rosters[1]), after.rosters[2].clone()],
                successions: vec![signed_by(group_succession_statement(forged).unwrap(), made.clone(), None)],
                join_mark: Some(JoinMark {
                    roster_version: 3,
                    code: join_code(roster_digest(after.rosters[2].statement.clone()), after.key(2), 2)
                        .unwrap(),
                }),
                ..from_one(&after)
            },
            refused.clone(),
        ));
    }
    // r8: key 1, then key 2, then a succession from 2 back to key 1, roster 3 signed under it.
    {
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&holder, &[GroupRole::Members])], None);
        h.succession(&organizer);
        h.roster(&organizer, vec![owner.clone(), active(&holder, &[GroupRole::Members])], Some(2));
        let (first, second) = (h.key(1), h.key(2));
        let back = GroupKeySuccession {
            group_id: GROUP.into(),
            old_version: 2,
            new_version: 3,
            old_ed25519_public_key: second.ed25519_public_key,
            old_ml_dsa_public_key: second.ml_dsa_public_key,
            new_ed25519_public_key: first.ed25519_public_key,
            new_ml_dsa_public_key: first.ml_dsa_public_key,
            last_roster_version: 2,
            last_roster_digest: roster_digest(h.rosters[1].statement.clone()),
            signer_user_id: organizer.user_id.clone(),
        };
        let under_first = roster_sign(
            Roster {
                roster_version: 3,
                previous_roster_digest: roster_digest(h.rosters[1].statement.clone()),
                group_key_version: 3,
                ..h.statements[1].clone()
            },
            group_seed(1),
            organizer.keys.clone(),
        )
        .unwrap();
        let mut rosters = h.rosters.clone();
        rosters.push(under_first);
        let mut successions = h.successions.clone();
        successions.push(signed_by(
            group_succession_statement(back).unwrap(),
            group_seed(2),
            Some(&organizer),
        ));
        cases.push((
            "succession-back-to-an-earlier-key",
            CaseInput { rosters, successions, ..from_one(&h) },
            refused.clone(),
        ));
    }
    // p1, p2: records under keys a fake link or a planted entry would retire; an own entry rolled back.
    {
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        let (adult2, link) = succeed(&adult);
        let fake = SuccessionLink {
            old_ml_dsa_public_key: outsider.served.ml_dsa_public_key.clone(),
            new_signing_public_key: outsider.served.signing_public_key.clone(),
            signature: e(&[0u8; 3373]),
            ..link.clone()
        };
        let probe = RecordProbe {
            writer_user_id: adult.user_id.clone(),
            signature: record_signature(&outsider),
            pinned: None,
            served: Some(served_keys(&adult2)),
            links: Some(vec![fake, link.clone()]),
            pinned_via: None,
            workspace_id: None,
        };
        cases.push((
            "fake-link-first",
            CaseInput { record: Some(probe.clone()), ..from_one(&h) },
            reads("bad-signature", None, 1),
        ));
        cases.push((
            "fake-link-first-pinned",
            CaseInput { record: Some(RecordProbe { pinned: Some(pinned(&adult)), ..probe }), ..from_one(&h) },
            reads("bad-signature", None, 1),
        ));
        let restarted = person_at(2, 2);
        let planted = person(9);
        let (adult3, real) = succeed(&restarted);
        let mut p = History::new();
        p.roster(
            &organizer,
            vec![owner.clone(), active(&restarted, &[]), active(&holder, &[GroupRole::Members])],
            None,
        );
        p.roster(
            &holder,
            vec![
                owner.clone(),
                RosterMember { user_id: adult.user_id.clone(), ..active(&planted, &[]) },
                active(&holder, &[GroupRole::Members]),
            ],
            None,
        );
        p.roster(
            &organizer,
            vec![owner.clone(), active(&adult3, &[]), active(&holder, &[GroupRole::Members])],
            None,
        );
        let mut forged = SuccessionLink {
            old_key_version: 1,
            new_key_version: 2,
            old_encryption_public_key: planted.served.encryption_public_key.clone(),
            old_signing_public_key: planted.served.signing_public_key.clone(),
            old_ml_dsa_public_key: planted.served.ml_dsa_public_key.clone(),
            new_encryption_public_key: restarted.served.encryption_public_key.clone(),
            new_signing_public_key: restarted.served.signing_public_key.clone(),
            new_ml_dsa_public_key: restarted.served.ml_dsa_public_key.clone(),
            new_kem_public_key: restarted.served.kem_public_key.clone(),
            signature: String::new(),
            consent: None,
        };
        let statement = succession_statement(adult.user_id.clone(), forged.clone()).unwrap();
        forged.signature =
            e(&hybrid_sign(planted.keys.signing_seed.to_vec(), planted.keys.ml_dsa_seed.to_vec(), statement)
                .unwrap());
        // Given the member's consent as well (a test can sign it), so these cases pin the rule
        // that chains start only at the first keys, apart from the consent rule.
        forged.consent = Some(consent_of(&forged, &adult.user_id, &planted.keys, &restarted.keys));
        let planted_probe = RecordProbe {
            writer_user_id: adult.user_id.clone(),
            signature: record_signature(&planted),
            pinned: None,
            served: Some(served_keys(&adult3)),
            links: Some(vec![forged, real]),
            pinned_via: None,
            workspace_id: None,
        };
        cases.push((
            "planted-forged-link",
            CaseInput { record: Some(planted_probe.clone()), ..from_one(&p) },
            reads("bad-signature", None, 3),
        ));
        cases.push((
            "planted-forged-link-pinned",
            CaseInput {
                record: Some(RecordProbe { pinned: Some(pinned(&adult3)), ..planted_probe.clone() }),
                ..from_one(&p)
            },
            reads("bad-signature", None, 3),
        ));
        // F1: the planted keys are the adult's FIRST entry, so the walk starts at them; the real
        // keys follow at 2. A planter can sign the link from the planted keys but not the new
        // key's consent: one-sided or with junk consent, the link bridges nothing, and a record
        // under the planted keys reads bad-signature, never retired-key. With the real keys'
        // consent (a test can sign it) the same link does bridge.
        let mut pf = History::new();
        pf.roster(
            &organizer,
            vec![
                owner.clone(),
                RosterMember { user_id: adult.user_id.clone(), ..active(&planted, &[]) },
                active(&holder, &[GroupRole::Members]),
            ],
            None,
        );
        pf.roster(
            &organizer,
            vec![owner.clone(), active(&restarted, &[]), active(&holder, &[GroupRole::Members])],
            None,
        );
        let forged_link = planted_probe.links.as_ref().unwrap()[0].clone();
        let first_probe = RecordProbe {
            writer_user_id: adult.user_id.clone(),
            signature: record_signature(&planted),
            pinned: None,
            served: Some(served_keys(&restarted)),
            links: Some(vec![one_sided(&forged_link)]),
            pinned_via: None,
            workspace_id: None,
        };
        cases.push((
            "planted-first-one-sided-link",
            CaseInput { record: Some(first_probe.clone()), ..from_one(&pf) },
            reads("bad-signature", None, 2),
        ));
        // All a planter can make: the planted keys' half of the consent, valid, beside junk; and the
        // new keys' half alone: both keys must agree to the link.
        for (name, old, fresh) in [
            ("planted-first-planter-consent", Some(&planted.keys), None),
            ("planted-first-new-half-only", None, Some(&restarted.keys)),
        ] {
            cases.push((
                name,
                CaseInput {
                    record: Some(RecordProbe {
                        links: Some(vec![SuccessionLink {
                            consent: Some(consent_halves(&forged_link, &adult.user_id, old, fresh)),
                            ..forged_link.clone()
                        }]),
                        ..first_probe.clone()
                    }),
                    ..from_one(&pf)
                },
                reads("bad-signature", None, 2),
            ));
        }
        cases.push((
            "planted-first-consented",
            CaseInput {
                record: Some(RecordProbe { links: Some(vec![forged_link.clone()]), ..first_probe.clone() }),
                ..from_one(&pf)
            },
            reads("retired-key", None, 2),
        ));
        // r9 (Opus 2): the planter makes his own Q, consents to P→Q himself (he holds both), and the
        // server serves Q as the adult's identity. The first keys' chain counts only up to the
        // entry's keys, which P→Q never reaches: a record under P reads bad-signature.
        let (self_x, self_y) = (person(10), person(11));
        let self_link = |to: &Person| {
            let mut link = SuccessionLink {
                new_encryption_public_key: to.served.encryption_public_key.clone(),
                new_signing_public_key: to.served.signing_public_key.clone(),
                new_ml_dsa_public_key: to.served.ml_dsa_public_key.clone(),
                new_kem_public_key: to.served.kem_public_key.clone(),
                consent: None,
                ..forged_link.clone()
            };
            let statement = succession_statement(adult.user_id.clone(), link.clone()).unwrap();
            link.signature = e(&hybrid_sign(
                planted.keys.signing_seed.to_vec(),
                planted.keys.ml_dsa_seed.to_vec(),
                statement,
            )
            .unwrap());
            link.consent = Some(consent_of(&link, &adult.user_id, &planted.keys, &to.keys));
            link
        };
        cases.push((
            "planted-first-self-consented",
            CaseInput {
                record: Some(RecordProbe {
                    served: Some(served_keys(&self_x)),
                    links: Some(vec![self_link(&self_x)]),
                    ..first_probe.clone()
                }),
                ..from_one(&pf)
            },
            reads("bad-signature", None, 2),
        ));
        // r9 (Fable C): two self-consented links leaving P fork only the first keys' walk: the
        // adult's own records still read verified, and a forgery still reads bad-signature.
        let fork_at_first = vec![self_link(&self_x), self_link(&self_y)];
        cases.push((
            "planted-first-fork-verified",
            CaseInput {
                record: Some(RecordProbe {
                    signature: record_signature(&restarted),
                    links: Some(fork_at_first.clone()),
                    ..first_probe.clone()
                }),
                ..from_one(&pf)
            },
            reads("verified", Some(GROUP), 2),
        ));
        cases.push((
            "planted-first-fork-forgery",
            CaseInput {
                record: Some(RecordProbe {
                    signature: record_signature(&outsider),
                    links: Some(fork_at_first),
                    ..first_probe.clone()
                }),
                ..from_one(&pf)
            },
            reads("bad-signature", None, 2),
        ));
        // r9 (Opus 3): a genuine succession the new key never co-signed (the version 2 signature
        // alone, what every shipped client signs): the roster-lag walk takes it, since keys a
        // holder planted never start there, so the new key's record reads verified.
        let new_probe = RecordProbe {
            writer_user_id: adult.user_id.clone(),
            signature: record_signature(&adult2),
            pinned: None,
            served: Some(served_keys(&adult2)),
            links: Some(vec![one_sided(&link)]),
            pinned_via: None,
            workspace_id: None,
        };
        cases.push((
            "one-sided-link-on-the-lag",
            CaseInput { record: Some(new_probe.clone()), ..from_one(&h) },
            reads("verified", Some(GROUP), 1),
        ));
        // r9 (Opus 5): the server serves the entry's own keys while a link the member signed leaves
        // them: a rollback to the entry, unchecked, never verified under the replaced key.
        cases.push((
            "served-rolled-back-to-entry",
            CaseInput {
                record: Some(RecordProbe {
                    signature: record_signature(&adult),
                    served: Some(served_keys(&adult)),
                    links: Some(vec![one_sided(&link)]),
                    ..new_probe.clone()
                }),
                ..from_one(&h)
            },
            reads("unchecked", None, 1),
        ));
        // r9 (Opus 8), r10 (Fable 6), r11: more than 64 links that could join the adult's chain
        // (here, links from the entry's keys with junk signatures) are checked no further. The
        // entry's keys are public, so the server can always serve them: the overflow reads as links
        // that did not load, never as a verdict on the adult. A record under the entry's key still
        // verifies; one under the new key reads unchecked. Links with any other old keys are free
        // and never counted.
        let from_entry = SuccessionLink { signature: e(&[0u8; 3373]), ..one_sided(&link) };
        let mut many = vec![link.clone()];
        many.extend((0..64u64).map(|i| SuccessionLink { new_key_version: i + 2, ..from_entry.clone() }));
        cases.push((
            "too-many-links",
            CaseInput {
                record: Some(RecordProbe {
                    signature: record_signature(&adult),
                    links: Some(many.clone()),
                    ..new_probe.clone()
                }),
                ..from_one(&h)
            },
            reads("verified", Some(GROUP), 1),
        ));
        cases.push((
            "too-many-links-new-key",
            CaseInput {
                record: Some(RecordProbe { links: Some(many), ..new_probe.clone() }),
                ..from_one(&h)
            },
            reads("unchecked", None, 1),
        ));
        let mut junk_links = vec![link.clone()];
        junk_links.extend((1..=65).map(junk_link));
        cases.push((
            "junk-links-ignored",
            CaseInput {
                record: Some(RecordProbe { links: Some(junk_links), ..new_probe.clone() }),
                ..from_one(&h)
            },
            reads("verified", Some(GROUP), 1),
        ));
        cases.push((
            "one-sided-link-consented",
            CaseInput {
                record: Some(RecordProbe { links: Some(vec![link.clone()]), ..new_probe }),
                ..from_one(&h)
            },
            reads("verified", Some(GROUP), 1),
        ));
        // r10 (Opus 2), r11: a reader who pinned the planted keys through "Trust as Acme does"
        // (trustedVia: the group) while the planted entry was the latest; the entry is put right. A
        // link from the planted keys on their version 2 signature alone is no edge from a pin the
        // group vouched for: key-conflict, never the planted keys retired as the adult's.
        let real_link = planted_probe.links.as_ref().unwrap()[1].clone();
        cases.push((
            "planted-pin-one-sided-link",
            CaseInput {
                record: Some(RecordProbe {
                    pinned: Some(pinned(&planted)),
                    pinned_via: Some(GROUP.into()),
                    links: Some(vec![one_sided(&forged_link), real_link]),
                    ..planted_probe.clone()
                }),
                ..from_one(&p)
            },
            reads("key-conflict", None, 3),
        ));
        // The same through a planted FIRST entry (where the keys sit first in the history): the
        // pin's origin, not its place, asks consent.
        cases.push((
            "planted-first-pin-one-sided-link",
            CaseInput {
                record: Some(RecordProbe {
                    pinned: Some(pinned(&planted)),
                    pinned_via: Some(GROUP.into()),
                    ..first_probe.clone()
                }),
                ..from_one(&pf)
            },
            reads("key-conflict", None, 2),
        ));
        // r11 (Opus 2): no false conflict for an honest member. The reader checked words over the
        // adult's second identity (a personal pin); the adult rotates again with a one-sided link,
        // folded in. The pin's walk takes the version 2 signature: the roster's verdict.
        let (second, to_second) = succeed(&adult);
        let (third, to_third) = succeed(&second);
        let mut folded = History::new();
        folded.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        folded.roster(&organizer, vec![owner.clone(), active(&second, &[])], None);
        folded.roster(&organizer, vec![owner.clone(), active(&third, &[])], None);
        cases.push((
            "pin-at-folded-identity-one-sided",
            CaseInput {
                record: Some(RecordProbe {
                    writer_user_id: adult.user_id.clone(),
                    signature: record_signature(&third),
                    pinned: Some(pinned(&second)),
                    pinned_via: None,
                    served: Some(served_keys(&third)),
                    links: Some(vec![one_sided(&to_second), one_sided(&to_third)]),
                    workspace_id: None,
                }),
                ..from_one(&folded)
            },
            reads("verified", Some(GROUP), 3),
        ));
        // A pin at a newer identity: the earlier keys on the verified chain up to it are retired.
        cases.push((
            "pin-newer-than-key",
            CaseInput {
                record: Some(RecordProbe {
                    signature: record_signature(&restarted),
                    pinned: Some(pinned(&adult3)),
                    ..planted_probe
                }),
                ..from_one(&p)
            },
            reads("retired-key", None, 3),
        ));
        let mut back = History::new();
        back.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        back.roster(&organizer, vec![owner.clone(), active(&adult2, &[])], None);
        back.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        cases.push((
            "own-entry-rolled-back",
            CaseInput {
                me: OwnIdentities {
                    user_id: adult.user_id.clone(),
                    identities: vec![served_keys(&adult), served_keys(&adult2)],
                },
                ..from_one(&back)
            },
            accepted(3),
        ));
    }
    // The sixth review: the person's own marks before anything served; version 1 keys a server
    // made up; and what the local tests alone used to cover (tie digest, succession order, the
    // extending first keys, the cache's binding, the group's kind).
    {
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[GroupRole::Billing])], None);
        h.succession(&organizer);
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[])], Some(2));
        let pin2 = pin_of(&h, 2, &everyone);
        let elsewhere = GroupPin { roster_digest: junk.clone(), ..pin2.clone() };
        let unsigned_head = SignedGroupStatement {
            signature: GroupSignature { ed25519: vec![0; 64], ml_dsa: vec![0; 3309] },
            signer_signature: vec![0; 3373],
            ..roster_sign(
                Roster { previous_roster_digest: junk.clone(), ..h.statements[2].clone() },
                group_seed(2),
                organizer.keys.clone(),
            )
            .unwrap()
        };
        cases.push((
            "pins-disagree-junk-served",
            CaseInput {
                pins: vec![pin2.clone(), elsewhere.clone()],
                rosters: vec![unsigned_head.clone()],
                ..from_one(&h)
            },
            fork("roster", 2),
        ));
        // Bytes that are not even a roster or a succession, or a roster of another group: the
        // marks are compared before anything served is parsed, so the warning still shows.
        let malformed = SignedGroupStatement { statement: b"[".to_vec(), ..unsigned_head.clone() };
        let mut with_malformed = h.rosters.clone();
        with_malformed.push(malformed.clone());
        let mut successions_malformed = h.successions.clone();
        successions_malformed.push(malformed);
        cases.push((
            "pins-disagree-malformed-served",
            CaseInput {
                pins: vec![pin2.clone(), elsewhere.clone()],
                rosters: with_malformed,
                successions: successions_malformed,
                ..from_one(&h)
            },
            fork("roster", 2),
        ));
        // r8: a pin whose check time is not the canonical ISO form is no pin.
        cases.push((
            "pin-check-time-not-canonical",
            CaseInput {
                pins: vec![GroupPin { checked_at: "2026-10-15 00:00:00".into(), ..pin2.clone() }],
                ..from_one(&h)
            },
            refused.clone(),
        ));
        cases.push((
            "pin-check-time-month-13",
            CaseInput {
                pins: vec![GroupPin { checked_at: "2026-13-15T00:00:00.000Z".into(), ..pin2.clone() }],
                ..from_one(&h)
            },
            refused.clone(),
        ));
        let mut with_other = h.rosters.clone();
        with_other.push(
            roster_sign(
                Roster { group_id: OTHER_GROUP.into(), ..h.statements[0].clone() },
                group_seed(1),
                organizer.keys.clone(),
            )
            .unwrap(),
        );
        cases.push((
            "pins-disagree-other-group-served",
            CaseInput { pins: vec![pin2.clone(), elsewhere], rosters: with_other, ..from_one(&h) },
            fork("roster", 2),
        ));
        let server_key = group_public_key(group_seed(42)).unwrap();
        let made_up = roster_sign(
            Roster {
                signer_user_id: outsider.user_id.clone(),
                members: vec![active(
                    &outsider,
                    &[GroupRole::Billing, GroupRole::Guardian, GroupRole::Members],
                )],
                ..h.statements[0].clone()
            },
            group_seed(42),
            outsider.keys.clone(),
        )
        .unwrap();
        cases.push((
            "server-made-first-keys",
            CaseInput {
                pins: vec![pin2.clone()],
                first_keys_checked: false,
                first_keys: server_key.clone(),
                rosters: vec![made_up],
                successions: vec![],
                ..from_one(&h)
            },
            refused.clone(),
        ));
        // The real succession, its tie naming roster 2's version but another roster's digest.
        let real = group_succession_parse(h.successions[0].statement.clone()).unwrap();
        let mis_tied = GroupKeySuccession {
            last_roster_digest: roster_digest(h.rosters[0].statement.clone()),
            ..real.clone()
        };
        let mis_tied =
            signed_by(group_succession_statement(mis_tied).unwrap(), group_seed(1), Some(&organizer));
        cases.push((
            "succession-tie-digest",
            CaseInput { successions: vec![mis_tied], ..from_one(&h) },
            refused.clone(),
        ));
        // A succession out of key 2 tied before the one into it: ignored, the chain stays at key 2.
        let (two_key, three) = (h.key(2), group_public_key(group_seed(3)).unwrap());
        let early = GroupKeySuccession {
            old_version: 2,
            new_version: 3,
            old_ed25519_public_key: two_key.ed25519_public_key,
            old_ml_dsa_public_key: two_key.ml_dsa_public_key,
            new_ed25519_public_key: three.ed25519_public_key,
            new_ml_dsa_public_key: three.ml_dsa_public_key,
            last_roster_version: 1,
            last_roster_digest: roster_digest(h.rosters[0].statement.clone()),
            ..real
        };
        let early = signed_by(group_succession_statement(early).unwrap(), group_seed(2), Some(&organizer));
        let mut with_early = h.successions.clone();
        with_early.push(early);
        cases.push((
            "succession-tied-before-its-key",
            CaseInput { rosters: h.rosters[..2].to_vec(), successions: with_early, ..from_one(&h) },
            accepted(2),
        ));
        let two = accepted_to(&h, 2, &everyone);
        cases.push((
            "cache-other-first-keys",
            CaseInput {
                cache: Some(two.cache()),
                rosters: vec![h.rosters[2].clone()],
                first_keys: server_key,
                ..from_one(&h)
            },
            refused.clone(),
        ));
        let other2 = roster_sign(
            Roster {
                members: sorted(vec![
                    owner.clone(),
                    active(&adult, &[]),
                    outsider.entry(&[], 2, MemberStatus::Active),
                ]),
                ..h.statements[1].clone()
            },
            group_seed(1),
            organizer.keys.clone(),
        )
        .unwrap();
        cases.push((
            "cache-other-statement",
            CaseInput {
                cache: Some(GroupChainCache { statement: e(&other2.statement), ..two.cache() }),
                rosters: vec![],
                ..from_one(&h)
            },
            refused.clone(),
        ));
        let as_org = roster_sign(
            Roster { kind: GroupKind::Org, ..h.statements[1].clone() },
            group_seed(1),
            organizer.keys.clone(),
        )
        .unwrap();
        cases.push((
            "kind-changes",
            CaseInput { rosters: vec![h.rosters[0].clone(), as_org], successions: vec![], ..from_one(&h) },
            refused.clone(),
        ));
        // The real succession, naming another key as the one it replaces.
        let other = group_public_key(group_seed(42)).unwrap();
        let misnamed = GroupKeySuccession {
            old_ed25519_public_key: other.ed25519_public_key.clone(),
            old_ml_dsa_public_key: other.ml_dsa_public_key.clone(),
            ..group_succession_parse(h.successions[0].statement.clone()).unwrap()
        };
        let misnamed =
            signed_by(group_succession_statement(misnamed).unwrap(), group_seed(1), Some(&organizer));
        cases.push((
            "succession-names-other-old-key",
            CaseInput { successions: vec![misnamed], ..from_one(&h) },
            refused.clone(),
        ));
        // The real succession, signed by this group's key and holder, but for another group.
        let elsewhere_group = GroupKeySuccession {
            group_id: OTHER_GROUP.into(),
            ..group_succession_parse(h.successions[0].statement.clone()).unwrap()
        };
        let elsewhere_group =
            signed_by(group_succession_statement(elsewhere_group).unwrap(), group_seed(1), Some(&organizer));
        cases.push((
            "succession-for-other-group",
            CaseInput { successions: vec![elsewhere_group], ..from_one(&h) },
            refused.clone(),
        ));
        // Two of the person's pins naming other version 1 keys: the warning, marks only.
        let other_first = GroupPin {
            first_ed25519_public_key: other.ed25519_public_key.clone(),
            first_ml_dsa_public_key_digest: e(&sha256(
                &base64url_decode(other.ml_dsa_public_key.clone()).unwrap(),
            )),
            ..pin2.clone()
        };
        cases.push((
            "pins-other-first-keys",
            CaseInput { pins: vec![pin2.clone(), other_first], ..from_one(&h) },
            fork("group-key", 1),
        ));
        // A pin past a succession the server now leaves out: the group key rolled back.
        let RosterChain::Accepted { chain: at_two } = accept_rosters(
            GROUP.into(),
            h.key(1),
            true,
            vec![],
            h.rosters[..2].to_vec(),
            h.successions.clone(),
            served_ml_dsa(&everyone),
            reader(),
            None,
        )
        .unwrap() else {
            panic!("the chain at 2 is accepted");
        };
        let held = pin_after(vec![], at_two, CHECKED.into()).unwrap();
        cases.push((
            "group-key-rollback",
            CaseInput {
                pins: vec![held],
                first_keys_checked: false,
                rosters: h.rosters[..2].to_vec(),
                successions: vec![],
                ..from_one(&h)
            },
            refused.clone(),
        ));
    }
    // The sole signer's Ed25519 key beside someone else's ML-DSA key, served as theirs; and a
    // "succession" signed the same way, from the adult's keys with another ML-DSA key.
    {
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[GroupRole::Billing])], None);
        let forged = h
            .rosters
            .iter()
            .map(|r| SignedGroupStatement {
                signer_signature: hybrid_sign(
                    organizer.keys.signing_seed.to_vec(),
                    outsider.keys.ml_dsa_seed.to_vec(),
                    r.statement.clone(),
                )
                .unwrap(),
                ..r.clone()
            })
            .collect();
        let keys =
            HashMap::from([(e(&sha256(&organizer.ml_dsa())), outsider.served.ml_dsa_public_key.clone())]);
        cases.push((
            "signer-ml-dsa-substituted-sole",
            CaseInput { rosters: forged, ml_dsa_keys: keys, ..from_one(&h) },
            refused.clone(),
        ));
        let mut half_forged = SuccessionLink {
            old_key_version: 1,
            new_key_version: 2,
            old_encryption_public_key: adult.served.encryption_public_key.clone(),
            old_signing_public_key: adult.served.signing_public_key.clone(),
            old_ml_dsa_public_key: outsider.served.ml_dsa_public_key.clone(),
            new_encryption_public_key: outsider.served.encryption_public_key.clone(),
            new_signing_public_key: outsider.served.signing_public_key.clone(),
            new_ml_dsa_public_key: outsider.served.ml_dsa_public_key.clone(),
            new_kem_public_key: outsider.served.kem_public_key.clone(),
            signature: String::new(),
            consent: None,
        };
        let statement = succession_statement(adult.user_id.clone(), half_forged.clone()).unwrap();
        half_forged.signature =
            e(&hybrid_sign(adult.keys.signing_seed.to_vec(), outsider.keys.ml_dsa_seed.to_vec(), statement)
                .unwrap());
        cases.push((
            "chain-start-ml-dsa-substituted",
            CaseInput {
                record: Some(RecordProbe {
                    writer_user_id: adult.user_id.clone(),
                    signature: record_signature(&outsider),
                    pinned: None,
                    served: Some(ServedKeys { key_version: 2, ..served_keys(&outsider) }),
                    links: Some(vec![half_forged]),
                    pinned_via: None,
                    workspace_id: None,
                }),
                ..from_one(&h)
            },
            reads("bad-signature", None, 2),
        ));
        // A record of the adult's in a workspace that is not one of the group's areas: the roster
        // says nothing there.
        let outside = MetadataStatement { workspace_id: OTHER_AREA.into(), ..record_statement() };
        cases.push((
            "record-outside-areas",
            CaseInput {
                record: Some(RecordProbe {
                    writer_user_id: adult.user_id.clone(),
                    signature: e(&metadata_sign(
                        adult.keys.signing_seed.to_vec(),
                        outside,
                        record_envelope(),
                    )
                    .unwrap()),
                    pinned: None,
                    pinned_via: None,
                    served: Some(served_keys(&adult)),
                    links: Some(vec![]),
                    workspace_id: Some(OTHER_AREA.into()),
                }),
                ..from_one(&h)
            },
            reads("unknown-signer", None, 2),
        ));
    }
    // r7: a member's identity forked (two successions they signed from one key), and a pin at
    // their newer identity.
    {
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&child, &[])], None);
        let (child2, link) = succeed(&child);
        let dangling = link_between(&child, &person_at(4, 4));
        let probe = RecordProbe {
            writer_user_id: child.user_id.clone(),
            signature: record_signature(&child2),
            pinned: None,
            served: Some(served_keys(&child2)),
            links: Some(vec![dangling.clone(), link.clone()]),
            pinned_via: None,
            workspace_id: None,
        };
        cases.push((
            "identity-fork",
            CaseInput { record: Some(probe.clone()), ..from_one(&h) },
            reads("unchecked", None, 1),
        ));
        cases.push((
            "identity-fork-pinned",
            CaseInput {
                record: Some(RecordProbe {
                    pinned: Some(pinned(&child)),
                    links: Some(vec![link.clone(), dangling]),
                    ..probe.clone()
                }),
                ..from_one(&h)
            },
            reads("unchecked", None, 1),
        ));
        cases.push((
            "pinned-newer-identity",
            CaseInput {
                record: Some(RecordProbe {
                    signature: record_signature(&child),
                    pinned: Some(pinned(&child2)),
                    links: Some(vec![link]),
                    ..probe
                }),
                ..from_one(&h)
            },
            reads("retired-key", None, 1),
        ));
    }
    // r10 (Opus 6, Fable 4): a roster carries only the areas it creates or rotates: a new area at
    // version 1, a rotation one above the area's latest version on the chain. A rotation and a new
    // area are accepted; a row at a version already listed, a version skipped, or a new area (or a
    // first roster's area) above 1 is refused.
    {
        let standard = standard_areas();
        let row = |id: &str, version: u64, seed: u8| RosterArea {
            workspace_id: id.into(),
            workspace_key_version: version,
            commitment: area_key_commitment(&pattern(32, seed)).unwrap(),
            root_commitment: None,
            retired: false,
        };
        let members = || vec![owner.clone(), active(&adult, &[GroupRole::Members])];
        let mut after = |name: &'static str, areas: Vec<RosterArea>, expected: Value| {
            let mut h = History::new();
            h.roster_with(
                &organizer,
                members(),
                Some(1),
                Some(vec![standard[0].clone(), row(SECOND_AREA, 1, 79)]),
            );
            h.roster_with(&adult, members(), Some(1), Some(areas));
            cases.push((name, from_one(&h), expected));
        };
        after("areas-added", vec![row(AREA, 2, 78), row(THIRD_AREA, 1, 81)], accepted(2));
        after("areas-row-repeated", standard.clone(), refused.clone());
        after("areas-version-skipped", vec![row(AREA, 3, 78)], refused.clone());
        after("areas-new-above-one", vec![row(THIRD_AREA, 2, 81)], refused.clone());
        // r12: a commitment depends on the key alone, so acceptance refuses a key used before, from
        // any client: a rotation to the area's own key (a no-op), to another area's key, or one key
        // for two areas.
        after("areas-noop-rotation", vec![row(AREA, 2, AREA_KEY_SEED)], refused.clone());
        after("areas-key-from-another-area", vec![row(AREA, 2, 79)], refused.clone());
        after("areas-same-key-twice", vec![row(AREA, 2, 90), row(THIRD_AREA, 1, 90)], refused.clone());
        let mut first = History::new();
        first.roster_with(&organizer, members(), Some(1), Some(vec![row(AREA, 2, 78)]));
        cases.push(("areas-first-roster-above-one", from_one(&first), refused.clone()));
    }
    // r10 (Fable 1 = Opus 5): in a family a roster that marks anyone left rotates every area in the
    // same statement (the history rotates them by default); without, or with some areas unrotated,
    // it is refused. A company's removal is not held to it (its rosters do not say who opens what).
    // And no roster both removes a members holder and admits anyone.
    {
        let mut removal =
            |name: &'static str, kind: GroupKind, areas: Option<Vec<RosterArea>>, expected: Value| {
                let mut h = History::of(kind);
                let mut created = standard_areas();
                created.push(area_row(SECOND_AREA, 1));
                h.roster_with(
                    &organizer,
                    vec![owner.clone(), active(&adult, &[]), active(&child, &[])],
                    Some(1),
                    Some(created),
                );
                h.roster_with(
                    &organizer,
                    vec![owner.clone(), adult.entry(&[], 1, MemberStatus::Left), active(&child, &[])],
                    Some(1),
                    areas,
                );
                cases.push((name, from_one(&h), expected));
            };
        removal("removal-rotates-every-area", GroupKind::Family, None, accepted(2));
        removal("removal-without-rotation", GroupKind::Family, Some(vec![]), refused.clone());
        removal(
            "removal-rotates-some-areas",
            GroupKind::Family,
            Some(vec![area_row(AREA, 2)]),
            refused.clone(),
        );
        removal("org-removal-without-rotation", GroupKind::Org, Some(vec![]), accepted(2));
        let mut both = History::new();
        both.roster(&organizer, vec![owner.clone(), active(&holder, &[GroupRole::Members])], None);
        both.roster(
            &organizer,
            vec![
                owner.clone(),
                holder.entry(&[GroupRole::Members], 1, MemberStatus::Left),
                active(&child, &[]),
            ],
            None,
        );
        cases.push(("admission-on-holder-removal", from_one(&both), refused.clone()));
    }
    // r11 (Fable 1): the signer stays active on the roster they sign (a holder's departure, with
    // its rotations, is another holder's to sign), and a roster keeps an active members holder.
    {
        let mut own_departure = History::new();
        own_departure.roster(
            &organizer,
            vec![owner.clone(), active(&adult, &[GroupRole::Members]), active(&child, &[])],
            None,
        );
        own_departure.roster(
            &adult,
            vec![
                owner.clone(),
                adult.entry(&[GroupRole::Members], 1, MemberStatus::Left),
                active(&child, &[]),
            ],
            None,
        );
        cases.push(("signer-left-on-own-roster", from_one(&own_departure), refused.clone()));
        let mut last = History::new();
        last.roster(&organizer, vec![owner.clone(), active(&adult, &[GroupRole::Members])], None);
        last.roster(
            &adult,
            vec![
                organizer.entry(
                    &[GroupRole::Billing, GroupRole::Guardian, GroupRole::Members],
                    1,
                    MemberStatus::Left,
                ),
                active(&adult, &[]),
            ],
            None,
        );
        cases.push(("last-holder-leaves", from_one(&last), refused.clone()));
    }
    // r9: a reader who pinned the adult's first keys, the adult's entry now their next identity, and
    // the one link between them on its version 2 signature alone. The first keys' walk asks consent
    // of it (and refuses it); the pin's walk takes the version 2 signature: the verdict is the
    // roster's, never a key conflict. One cache serves both walks, keyed by the proof.
    {
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        let (adult2, link) = succeed(&adult);
        h.roster(&organizer, vec![owner.clone(), active(&adult2, &[])], None);
        let probe = RecordProbe {
            writer_user_id: adult.user_id.clone(),
            signature: record_signature(&adult2),
            pinned: Some(pinned(&adult)),
            served: Some(served_keys(&adult2)),
            links: Some(vec![one_sided(&link)]),
            pinned_via: None,
            workspace_id: None,
        };
        cases.push((
            "one-sided-first-link-pinned",
            CaseInput { record: Some(probe), ..from_one(&h) },
            reads("verified", Some(GROUP), 2),
        ));
    }
    // r9 (Codex 2): two links whose fields, joined with "|", would read alike (the first's
    // signature "x|y", the second's KEM key ending "|x" with signature "y"), both carrying the
    // first's consent. Only the first holds, so the walk from the first keys reaches the entry and
    // the adult's first key reads retired; a verification cache that confused the two would see a
    // fork there instead.
    {
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&adult, &[])], None);
        let (adult2, link) = succeed(&adult);
        h.roster(&organizer, vec![owner.clone(), active(&adult2, &[])], None);
        let probe = RecordProbe {
            writer_user_id: adult.user_id.clone(),
            signature: record_signature(&adult),
            pinned: None,
            served: Some(served_keys(&adult2)),
            links: Some(vec![
                SuccessionLink { signature: "x|y".into(), ..link.clone() },
                SuccessionLink {
                    new_kem_public_key: format!("{}|x", link.new_kem_public_key),
                    signature: "y".into(),
                    ..link
                },
            ]),
            pinned_via: None,
            workspace_id: None,
        };
        cases.push((
            "cache-key-collision",
            CaseInput { record: Some(probe), ..from_one(&h) },
            reads("retired-key", None, 2),
        ));
    }
    // r7: the group walk keeps the strict verifier's rules on versions and served keys, passes
    // over unsigned links, and retires from a pin older than the member's first keys.
    {
        let mut h = History::new();
        h.roster(&organizer, vec![owner.clone(), active(&child, &[])], None);
        let (child2, link) = succeed(&child);
        let (child3, link23) = succeed(&child2);
        let probe = RecordProbe {
            writer_user_id: child.user_id.clone(),
            signature: record_signature(&child2),
            pinned: None,
            served: Some(served_keys(&child2)),
            links: Some(vec![link.clone()]),
            pinned_via: None,
            workspace_id: None,
        };
        cases.push((
            "served-kem-substituted",
            CaseInput {
                record: Some(RecordProbe {
                    served: Some(ServedKeys {
                        kem_public_key: outsider.served.kem_public_key.clone(),
                        ..served_keys(&child2)
                    }),
                    ..probe.clone()
                }),
                ..from_one(&h)
            },
            reads("bad-signature", None, 1),
        ));
        cases.push((
            "served-version-below-path",
            CaseInput {
                record: Some(RecordProbe {
                    // r8: the served version is not signed, so it decides nothing.
                    served: Some(ServedKeys { key_version: 1, ..served_keys(&child2) }),
                    ..probe.clone()
                }),
                ..from_one(&h)
            },
            reads("verified", Some(GROUP), 1),
        ));
        // r8: served as child2 while the child's own link to child3 is served too: the server
        // rolled the identity back. Unchecked, never verified under child2 nor bad under child3.
        cases.push((
            "served-rolled-back",
            CaseInput {
                record: Some(RecordProbe {
                    links: Some(vec![link.clone(), link23.clone()]),
                    ..probe.clone()
                }),
                ..from_one(&h)
            },
            reads("unchecked", None, 1),
        ));
        cases.push((
            "served-rolled-back-newer-record",
            CaseInput {
                record: Some(RecordProbe {
                    signature: record_signature(&child3),
                    links: Some(vec![link.clone(), link23.clone()]),
                    ..probe.clone()
                }),
                ..from_one(&h)
            },
            reads("unchecked", None, 1),
        ));
        cases.push((
            "link-version-falls",
            CaseInput {
                record: Some(RecordProbe {
                    signature: record_signature(&child3),
                    served: Some(served_keys(&child3)),
                    links: Some(vec![
                        link.clone(),
                        link_between_with(&child2, &child3, |l| l.old_key_version = 1),
                    ]),
                    ..probe.clone()
                }),
                ..from_one(&h)
            },
            reads("bad-signature", None, 1),
        ));
        let unsigned = SuccessionLink {
            new_encryption_public_key: outsider.served.encryption_public_key.clone(),
            new_signing_public_key: outsider.served.signing_public_key.clone(),
            new_ml_dsa_public_key: outsider.served.ml_dsa_public_key.clone(),
            new_kem_public_key: outsider.served.kem_public_key.clone(),
            signature: e(&[0u8; 3373]),
            ..link.clone()
        };
        cases.push((
            "unsigned-continuing-link-first",
            CaseInput {
                record: Some(RecordProbe { links: Some(vec![unsigned, link.clone()]), ..probe.clone() }),
                ..from_one(&h)
            },
            reads("verified", Some(GROUP), 1),
        ));
        let mut later = History::new();
        later.roster(&organizer, vec![owner.clone(), active(&child2, &[])], None);
        cases.push((
            "pin-older-than-first-keys",
            CaseInput {
                record: Some(RecordProbe {
                    signature: record_signature(&child),
                    pinned: Some(pinned(&child)),
                    served: Some(served_keys(&child3)),
                    links: Some(vec![link.clone(), link23]),
                    ..probe.clone()
                }),
                ..from_one(&later)
            },
            reads("retired-key", None, 1),
        ));
        // r8: a reader pinned at the child's first identity, the entry already their second, the
        // second served at a version the server made up: the pin follows the chain, no conflict.
        cases.push((
            "unsigned-version-no-conflict",
            CaseInput {
                record: Some(RecordProbe {
                    pinned: Some(pinned(&child)),
                    served: Some(ServedKeys { key_version: 3, ..served_keys(&child2) }),
                    links: Some(vec![link]),
                    ..probe
                }),
                ..from_one(&later)
            },
            reads("verified", Some(GROUP), 1),
        ));
    }
    // Roster format 2 (design 2.10): each area version commits to its root's key under its own
    // label, and an area is retired by a tombstone at its next version. Old format 1 chains still
    // verify; a chain switches up at a roster boundary and never back.
    {
        let members = vec![owner.clone(), active(&adult, &[GroupRole::Members])];
        let root = |workspace_id: &str, version: u64, key: Option<Vec<u8>>| RootProbe {
            workspace_id: workspace_id.into(),
            workspace_key_version: version,
            root_key: key.unwrap_or_else(|| root_key_at(workspace_id, version)),
        };
        let accepting = |version: u64, root: &str| json!({ "status": "accepted", "rosterVersion": version, "root": root });
        let mut v2 = History::format_2();
        v2.roster(&organizer, members.clone(), None);
        cases.push((
            "v2-first-roster",
            CaseInput { root: Some(root(AREA, 1, None)), ..from_one(&v2) },
            accepting(1, "current"),
        ));
        cases.push((
            "v2-root-mismatch",
            CaseInput { root: Some(root(AREA, 1, Some(root_key_at(AREA, 2)))), ..from_one(&v2) },
            accepting(1, "refused"),
        ));
        cases.push((
            "v2-root-unlisted-version",
            CaseInput { root: Some(root(AREA, 2, None)), ..from_one(&v2) },
            accepting(1, "refused"),
        ));
        let mut v1 = History::new();
        v1.roster(&organizer, members.clone(), None);
        cases.push((
            "v1-root-uncommitted",
            CaseInput { root: Some(root(AREA, 1, None)), ..from_one(&v1) },
            accepting(1, "uncommitted"),
        ));
        // Up from format 1 at a roster boundary: the rotation's root is committed, the earlier
        // version's is not.
        v1.format = 2;
        v1.roster_with(&organizer, members.clone(), Some(1), Some(vec![key_row_at(AREA, 2)]));
        cases.push((
            "v2-switch",
            CaseInput { root: Some(root(AREA, 2, None)), ..from_one(&v1) },
            accepting(2, "current"),
        ));
        cases.push((
            "v2-switch-earlier-uncommitted",
            CaseInput { root: Some(root(AREA, 1, None)), ..from_one(&v1) },
            accepting(2, "uncommitted"),
        ));
        // Never back down: a format 1 roster after a format 2 one.
        let mut down = History::format_2();
        down.roster(&organizer, members.clone(), None);
        down.format = 1;
        down.roster(
            &organizer,
            vec![owner.clone(), active(&adult, &[GroupRole::Billing, GroupRole::Members])],
            None,
        );
        cases.push(("v2-downgrade", from_one(&down), refused.clone()));
        // A rotation that keeps the root's key (a fresh area key, the old root commitment).
        let mut hollow = History::format_2();
        hollow.roster(&organizer, members.clone(), None);
        hollow.roster_with(
            &organizer,
            members.clone(),
            Some(1),
            Some(vec![RosterArea {
                root_commitment: key_row_at(AREA, 1).root_commitment,
                ..key_row_at(AREA, 2)
            }]),
        );
        cases.push(("v2-root-reused", from_one(&hollow), refused.clone()));
        // Tombstones: two areas, the second retired at its next version.
        let plain = vec![owner.clone(), active(&adult, &[])];
        let two = || {
            let mut h = History::format_2();
            h.roster_with(
                &organizer,
                plain.clone(),
                Some(1),
                Some(vec![key_row_at(AREA, 1), key_row_at(SECOND_AREA, 1)]),
            );
            h
        };
        let mut retire = two();
        retire.roster_with(&organizer, plain.clone(), Some(1), Some(vec![tombstone_at(SECOND_AREA, 2)]));
        cases.push((
            "retire-area",
            CaseInput { root: Some(root(SECOND_AREA, 1, None)), ..from_one(&retire) },
            accepting(2, "refused"),
        ));
        for (name, rows) in [
            ("retire-unknown-area", vec![tombstone_at(THIRD_AREA, 1)]),
            ("retire-wrong-version", vec![tombstone_at(SECOND_AREA, 3)]),
        ] {
            let mut h = two();
            h.roster_with(&organizer, plain.clone(), Some(1), Some(rows));
            cases.push((name, from_one(&h), refused.clone()));
        }
        let retired_then = |rows: Vec<RosterArea>| {
            let mut h = two();
            h.roster_with(&organizer, plain.clone(), Some(1), Some(vec![tombstone_at(SECOND_AREA, 2)]));
            h.roster_with(&organizer, plain.clone(), Some(1), Some(rows));
            h
        };
        cases.push((
            "retire-twice",
            from_one(&retired_then(vec![tombstone_at(SECOND_AREA, 3)])),
            refused.clone(),
        ));
        cases.push((
            "retired-area-revived",
            from_one(&retired_then(vec![key_row_at(SECOND_AREA, 3)])),
            refused.clone(),
        ));
        // At the tombstone's own version too: the area's key list never grew, so only the
        // retirement itself refuses these.
        cases.push((
            "retire-twice-at-its-version",
            from_one(&retired_then(vec![tombstone_at(SECOND_AREA, 2)])),
            refused.clone(),
        ));
        cases.push((
            "retired-area-revived-at-its-version",
            from_one(&retired_then(vec![key_row_at(SECOND_AREA, 2)])),
            refused.clone(),
        ));
        // A removal after the retirement rotates only the live area (the history's default skips
        // the retired one); rotating the retired one too is refused; retiring an area in the
        // removal's own roster counts as handling it.
        let left = vec![owner.clone(), adult.entry(&[], 1, MemberStatus::Left)];
        let mut skips = two();
        skips.roster_with(&organizer, plain.clone(), Some(1), Some(vec![tombstone_at(SECOND_AREA, 2)]));
        skips.roster(&organizer, left.clone(), None);
        cases.push(("removal-skips-retired-area", from_one(&skips), accepted(3)));
        cases.push((
            "removal-rotates-retired-area",
            from_one(&retired_then(vec![key_row_at(AREA, 2), key_row_at(SECOND_AREA, 3)])),
            refused.clone(),
        ));
        let mut both = two();
        both.roster_with(
            &organizer,
            left,
            Some(1),
            Some(vec![key_row_at(AREA, 2), tombstone_at(SECOND_AREA, 2)]),
        );
        cases.push(("removal-retires-instead", from_one(&both), accepted(2)));
        // The cache through a tombstone continues; one that forgot the retirement, or changed the
        // last root commitment, is refused; one from before format 2 (no roots, no retired
        // areas) is read as what it described.
        let cached = accepted_to(&skips, 2, &everyone).cache();
        cases.push((
            "cache-through-retirement",
            CaseInput {
                cache: Some(cached.clone()),
                rosters: skips.rosters[2..].to_vec(),
                ..from_one(&skips)
            },
            accepted(3),
        ));
        // Nothing served after it: only the cache's own check can refuse it.
        cases.push((
            "cache-retirement-dropped",
            CaseInput {
                cache: Some(GroupChainCache { retired_areas: vec![], ..cached }),
                rosters: vec![],
                ..from_one(&skips)
            },
            refused.clone(),
        ));
        let first = accepted_to(&v2, 1, &everyone).cache();
        cases.push((
            "cache-area-roots-tampered",
            CaseInput {
                cache: Some(GroupChainCache {
                    area_roots: HashMap::from([(AREA.to_string(), vec![Some(junk.clone())])]),
                    ..first
                }),
                rosters: vec![],
                ..from_one(&v2)
            },
            refused.clone(),
        ));
        let mut old = History::new();
        old.roster(&organizer, members.clone(), None);
        old.roster(
            &organizer,
            vec![owner.clone(), active(&adult, &[GroupRole::Billing, GroupRole::Members])],
            None,
        );
        let before = GroupChainCache {
            area_roots: HashMap::new(),
            retired_areas: vec![],
            cache_version: 1,
            ..accepted_to(&old, 1, &everyone).cache()
        };
        cases.push((
            "cache-before-format-2",
            CaseInput { cache: Some(before), rosters: old.rosters[1..].to_vec(), ..from_one(&old) },
            accepted(2),
        ));
        // A version 2 cache whose root commitments were emptied is no cache from before format
        // 2: its own version says it carries them, so it is refused, not read as uncommitted.
        // Through a roster that lists no area, so only the cache's version can refuse it.
        let mut quiet = History::format_2();
        quiet.roster(&organizer, members.clone(), None);
        quiet.roster(
            &organizer,
            vec![owner.clone(), active(&adult, &[GroupRole::Billing, GroupRole::Members])],
            None,
        );
        cases.push((
            "cache-v2-roots-emptied",
            CaseInput {
                cache: Some(GroupChainCache {
                    area_roots: HashMap::new(),
                    ..accepted_to(&quiet, 2, &everyone).cache()
                }),
                rosters: vec![],
                ..from_one(&quiet)
            },
            refused.clone(),
        ));
    }
    cases
}

/*
 * The shipped strict verifier both twins keep for personal pins
 * (succession_chain_verify): the chain is every link from the first one at
 * the pinned keys to the end of the list, in the order served. Junk before it
 * is skipped; junk after it, or the links out of order, and it does not hold.
 */
pub struct ChainCase {
    pub name: String,
    pub user_id: String,
    pub pinned: PinnedKeys,
    pub served: ServedKeys,
    pub links: Vec<SuccessionLink>,
    pub expected: bool,
}

pub fn chain_cases() -> Vec<ChainCase> {
    let member = person(4);
    let (second, first) = succeed(&member);
    let (third, next) = succeed(&second);
    let junk = SuccessionLink {
        old_signing_public_key: person(5).served.signing_public_key.clone(),
        ..next.clone()
    };
    let case = |name: &str, links: Vec<SuccessionLink>, expected: bool| ChainCase {
        name: name.into(),
        user_id: member.user_id.clone(),
        pinned: pinned(&member),
        served: served_keys(&third),
        links,
        expected,
    };
    vec![
        case("chain-holds", vec![first.clone(), next.clone()], true),
        case("chain-junk-before", vec![junk.clone(), first.clone(), next.clone()], true),
        case("chain-junk-after", vec![first.clone(), next.clone(), junk], false),
        // F1: personal shares keep the one-sided links every shipped client signed: links with
        // no consent hold on the personal chain the group walk refuses them on.
        case("chain-one-sided", vec![one_sided(&first), one_sided(&next)], true),
        case("chain-out-of-order", vec![next, first], false),
        // The pin's X25519 and Ed25519 keys with another ML-DSA key, signed with that key's half.
        ChainCase {
            served: ServedKeys { key_version: 2, ..served_keys(&person(5)) },
            ..case("chain-start-other-ml-dsa", vec![other_ml_dsa_link(&member, &person(5))], false)
        },
        // r8: a link signed over a statement whose new version is 2^53, beyond the safe integers
        // both twins bound key versions to (signed by hand: no builder makes such a statement).
        ChainCase {
            served: ServedKeys { key_version: 1 << 53, ..served_keys(&second) },
            ..case("chain-version-beyond-safe", vec![beyond_safe_link(&member, &second)], false)
        },
    ]
}

/*
 * Raw bytes against the statement grammar (design 2.1), the same list in both
 * twins: each judges the other's with its own parser.
 */
pub fn statement_cases() -> Vec<(String, Vec<u8>, bool)> {
    let text = |s: &str| s.as_bytes().to_vec();
    let mut bom = vec![0xef, 0xbb, 0xbf];
    bom.extend(b"[]");
    vec![
        ("plain", text(r#"["a",1,[2,["b"]]]"#), true),
        ("largest-safe-integer", text("[9007199254740991]"), true),
        ("four-deep", text(r#"[[[["a"]]]]"#), true),
        ("five-deep", text(r#"[[[[["a"]]]]]"#), false),
        ("byte-order-mark", bom, false),
        ("lone-surrogate", text(r#"["\ud800"]"#), false),
        ("escape", text(r#"["a\"b"]"#), false),
        ("non-ascii", text("[\"\u{e9}\"]"), false),
        ("beyond-safe-integer", text("[9007199254740993]"), false),
        ("float", text("[1.0]"), false),
        ("negative-zero", text("[-0]"), false),
        ("negative", text("[-1]"), false),
        ("exponent", text("[1e0]"), false),
        ("object", text("[{}]"), false),
        ("boolean", text("[true]"), false),
        ("null", text("[null]"), false),
        ("whitespace", text("[ 1]"), false),
        ("not-an-array", text(r#""a""#), false),
    ]
    .into_iter()
    .map(|(name, bytes, expected)| (name.to_string(), bytes, expected))
    .collect()
}

/* A link from `who` to `next` at new key version 2^53, signed over the raw statement by `who`. */
pub fn beyond_safe_link(who: &Person, next: &Person) -> SuccessionLink {
    let mut link = SuccessionLink {
        old_key_version: who.served.key_version,
        new_key_version: 1 << 53,
        old_encryption_public_key: who.served.encryption_public_key.clone(),
        old_signing_public_key: who.served.signing_public_key.clone(),
        old_ml_dsa_public_key: who.served.ml_dsa_public_key.clone(),
        new_encryption_public_key: next.served.encryption_public_key.clone(),
        new_signing_public_key: next.served.signing_public_key.clone(),
        new_ml_dsa_public_key: next.served.ml_dsa_public_key.clone(),
        new_kem_public_key: next.served.kem_public_key.clone(),
        signature: String::new(),
        consent: None,
    };
    let statement = json!([
        "hushos/identity/succession",
        2,
        who.user_id,
        link.old_key_version,
        link.new_key_version,
        link.old_encryption_public_key,
        link.old_signing_public_key,
        link.old_ml_dsa_public_key,
        link.new_encryption_public_key,
        link.new_signing_public_key,
        link.new_ml_dsa_public_key,
        e(&sha256(&next.kem())),
    ])
    .to_string()
    .into_bytes();
    link.signature =
        e(&hybrid_sign(who.keys.signing_seed.to_vec(), who.keys.ml_dsa_seed.to_vec(), statement).unwrap());
    link
}

pub fn chain_verdict(c: &ChainCase) -> bool {
    succession_chain_verify(c.user_id.clone(), c.pinned.clone(), c.served.clone(), c.links.clone())
}

pub fn chain_case_json(c: &ChainCase) -> Value {
    json!({
        "name": c.name,
        "userId": c.user_id,
        "pinned": {
            "keyVersion": c.pinned.key_version,
            "encryptionPublicKey": c.pinned.encryption_public_key,
            "signingPublicKey": c.pinned.signing_public_key,
            "mlDsaPublicKeyHash": c.pinned.ml_dsa_public_key_hash,
        },
        "served": {
            "keyVersion": c.served.key_version,
            "encryptionPublicKey": c.served.encryption_public_key,
            "signingPublicKey": c.served.signing_public_key,
            "mlDsaPublicKey": c.served.ml_dsa_public_key,
            "kemPublicKey": c.served.kem_public_key,
        },
        "links": c.links.iter().map(link_json).collect::<Vec<_>>(),
        "expected": c.expected,
    })
}

pub fn chain_case_from(v: &Value) -> ChainCase {
    let p = &v["pinned"];
    let sv = &v["served"];
    ChainCase {
        name: s(v, "name"),
        user_id: s(v, "userId"),
        pinned: PinnedKeys {
            key_version: p["keyVersion"].as_u64(),
            encryption_public_key: s(p, "encryptionPublicKey"),
            signing_public_key: s(p, "signingPublicKey"),
            ml_dsa_public_key_hash: s(p, "mlDsaPublicKeyHash"),
        },
        served: ServedKeys {
            key_version: n(sv, "keyVersion"),
            encryption_public_key: s(sv, "encryptionPublicKey"),
            signing_public_key: s(sv, "signingPublicKey"),
            ml_dsa_public_key: s(sv, "mlDsaPublicKey"),
            kem_public_key: s(sv, "kemPublicKey"),
        },
        links: v["links"].as_array().unwrap().iter().map(link_of).collect(),
        expected: v["expected"].as_bool().unwrap(),
    }
}

/*
 * The fold-ins both twins judge alike: a member two successions ahead is
 * folded straight to their served identity; a link not signed by them moves
 * nothing; an entry at an inflated key version still follows the member's
 * chain from its keys.
 */
pub struct FoldInCase {
    pub name: String,
    pub entry: RosterMember,
    pub served: PublicIdentity,
    pub links: Vec<SuccessionLink>,
    pub roster_version: u64,
}

pub fn fold_in_cases() -> Vec<FoldInCase> {
    let adult = person(2);
    let (adult2, first) = succeed(&adult);
    let (adult3, second) = succeed(&adult2);
    let forged = SuccessionLink {
        signature: e(&vec![0u8; base64url_decode(first.signature.clone()).unwrap().len()]),
        consent: Some(e(&vec![0u8; SUCCESSION_CONSENT_BYTES])),
        ..first.clone()
    };
    // r9: a genuine link the new key never co-signed folds in on its version 2 signature.
    let one_sided = one_sided(&first);
    let entry = adult.entry(&[], 1, MemberStatus::Active);
    vec![
        FoldInCase {
            name: "two-ahead".into(),
            entry: entry.clone(),
            served: adult3.served.clone(),
            links: vec![first.clone(), second],
            roster_version: 5,
        },
        FoldInCase {
            name: "forged-link".into(),
            entry: entry.clone(),
            served: adult2.served.clone(),
            links: vec![forged],
            roster_version: 5,
        },
        FoldInCase {
            name: "one-sided-link".into(),
            entry: entry.clone(),
            served: adult2.served.clone(),
            links: vec![one_sided],
            roster_version: 5,
        },
        FoldInCase {
            name: "inflated-version".into(),
            entry: RosterMember { key_version: 1000, ..entry },
            served: adult2.served.clone(),
            links: vec![first],
            roster_version: 5,
        },
    ]
}

pub fn fold_in_verdict(c: &FoldInCase) -> Value {
    let folded =
        roster_entry_fold_in(c.entry.clone(), c.served.clone(), c.links.clone(), c.roster_version).unwrap();
    json!({ "entry": member_json(&folded.entry), "changed": folded.changed, "needsCheck": folded.needs_check })
}

pub fn served_identity_json(p: &PublicIdentity) -> Value {
    json!({
        "keyVersion": p.key_version, "encryptionPublicKey": p.encryption_public_key,
        "signingPublicKey": p.signing_public_key, "mlDsaPublicKey": p.ml_dsa_public_key,
        "kemPublicKey": p.kem_public_key, "keysSignature": p.keys_signature,
    })
}

pub fn served_identity_of(v: &Value) -> PublicIdentity {
    PublicIdentity {
        key_version: n(v, "keyVersion"),
        encryption_public_key: s(v, "encryptionPublicKey"),
        signing_public_key: s(v, "signingPublicKey"),
        ml_dsa_public_key: s(v, "mlDsaPublicKey"),
        kem_public_key: s(v, "kemPublicKey"),
        keys_signature: s(v, "keysSignature"),
    }
}

pub fn link_json(l: &SuccessionLink) -> Value {
    json!({
        "oldKeyVersion": l.old_key_version, "newKeyVersion": l.new_key_version,
        "oldEncryptionPublicKey": l.old_encryption_public_key, "oldSigningPublicKey": l.old_signing_public_key,
        "oldMlDsaPublicKey": l.old_ml_dsa_public_key, "newEncryptionPublicKey": l.new_encryption_public_key,
        "newSigningPublicKey": l.new_signing_public_key, "newMlDsaPublicKey": l.new_ml_dsa_public_key,
        "newKemPublicKey": l.new_kem_public_key, "signature": l.signature, "consent": l.consent,
    })
}

pub fn link_of(v: &Value) -> SuccessionLink {
    SuccessionLink {
        old_key_version: n(v, "oldKeyVersion"),
        new_key_version: n(v, "newKeyVersion"),
        old_encryption_public_key: s(v, "oldEncryptionPublicKey"),
        old_signing_public_key: s(v, "oldSigningPublicKey"),
        old_ml_dsa_public_key: s(v, "oldMlDsaPublicKey"),
        new_encryption_public_key: s(v, "newEncryptionPublicKey"),
        new_signing_public_key: s(v, "newSigningPublicKey"),
        new_ml_dsa_public_key: s(v, "newMlDsaPublicKey"),
        new_kem_public_key: s(v, "newKemPublicKey"),
        signature: s(v, "signature"),
        consent: v["consent"].as_str().map(String::from),
    }
}

pub fn fold_in_json(c: &FoldInCase, expected: &Value) -> Value {
    json!({
        "name": c.name,
        "entry": member_json(&c.entry),
        "served": served_identity_json(&c.served),
        "links": c.links.iter().map(link_json).collect::<Vec<_>>(),
        "rosterVersion": c.roster_version,
        "expected": expected,
    })
}

pub fn fold_in_from(v: &Value) -> (FoldInCase, Value) {
    (
        FoldInCase {
            name: s(v, "name"),
            entry: member_of(&v["entry"]),
            served: served_identity_of(&v["served"]),
            links: v["links"].as_array().unwrap().iter().map(link_of).collect(),
            roster_version: n(v, "rosterVersion"),
        },
        v["expected"].clone(),
    )
}

pub fn pin_json(pin: &GroupPin) -> Value {
    json!({
        "firstEd25519PublicKey": pin.first_ed25519_public_key,
        "firstMlDsaPublicKeyDigest": pin.first_ml_dsa_public_key_digest,
        "checkedAt": pin.checked_at,
        "keyVersion": pin.key_version,
        "groupKeyDigest": pin.group_key_digest,
        "rosterVersion": pin.roster_version,
        "rosterDigest": pin.roster_digest,
        "areas": pin.areas,
    })
}

pub fn pin_from(value: &Value) -> GroupPin {
    GroupPin {
        first_ed25519_public_key: s(value, "firstEd25519PublicKey"),
        first_ml_dsa_public_key_digest: s(value, "firstMlDsaPublicKeyDigest"),
        checked_at: s(value, "checkedAt"),
        key_version: n(value, "keyVersion"),
        group_key_digest: s(value, "groupKeyDigest"),
        roster_version: n(value, "rosterVersion"),
        roster_digest: s(value, "rosterDigest"),
        areas: value["areas"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_u64().unwrap()))
            .collect(),
    }
}

fn served_keys_json(keys: &ServedKeys) -> Value {
    json!({
        "keyVersion": keys.key_version,
        "encryptionPublicKey": keys.encryption_public_key,
        "signingPublicKey": keys.signing_public_key,
        "mlDsaPublicKey": keys.ml_dsa_public_key,
        "kemPublicKey": keys.kem_public_key,
    })
}

fn served_keys_of(value: &Value) -> ServedKeys {
    ServedKeys {
        key_version: n(value, "keyVersion"),
        encryption_public_key: s(value, "encryptionPublicKey"),
        signing_public_key: s(value, "signingPublicKey"),
        ml_dsa_public_key: s(value, "mlDsaPublicKey"),
        kem_public_key: s(value, "kemPublicKey"),
    }
}

fn pinned_json(p: &PinnedKeys) -> Value {
    json!({
        "keyVersion": p.key_version,
        "encryptionPublicKey": p.encryption_public_key,
        "signingPublicKey": p.signing_public_key,
        "mlDsaPublicKeyHash": p.ml_dsa_public_key_hash,
    })
}

fn pinned_of(v: &Value) -> PinnedKeys {
    PinnedKeys {
        key_version: v["keyVersion"].as_u64(),
        encryption_public_key: s(v, "encryptionPublicKey"),
        signing_public_key: s(v, "signingPublicKey"),
        ml_dsa_public_key_hash: s(v, "mlDsaPublicKeyHash"),
    }
}

fn record_json(r: &RecordProbe) -> Value {
    json!({
        "writerUserId": r.writer_user_id,
        "signature": r.signature,
        "pinned": r.pinned.as_ref().map(pinned_json),
        "pinnedVia": r.pinned_via,
        "served": r.served.as_ref().map(served_keys_json),
        "links": r.links.as_ref().map(|links| links.iter().map(link_json).collect::<Vec<_>>()),
        "workspaceId": r.workspace_id,
    })
}

fn record_of(v: &Value) -> Option<RecordProbe> {
    v.as_object()?;
    Some(RecordProbe {
        writer_user_id: s(v, "writerUserId"),
        signature: s(v, "signature"),
        pinned: v["pinned"].as_object().map(|_| pinned_of(&v["pinned"])),
        pinned_via: v["pinnedVia"].as_str().map(String::from),
        served: v["served"].as_object().map(|_| served_keys_of(&v["served"])),
        links: v["links"].as_array().map(|links| links.iter().map(link_of).collect()),
        workspace_id: v["workspaceId"].as_str().map(String::from),
    })
}

fn next_json(probe: &NextProbe) -> Value {
    json!({
        "roster": probe.roster.as_ref().map(signed_json),
        "succession": probe.succession.as_ref().map(signed_json),
        "identities": probe.identities.as_ref().map(|identities| identities
            .iter()
            .map(|(user, served)| (user.clone(), json!(served.iter().map(served_identity_json).collect::<Vec<_>>())))
            .collect::<serde_json::Map<_, _>>()),
    })
}

fn next_of(v: &Value) -> Option<NextProbe> {
    v.as_object()?;
    Some(NextProbe {
        roster: v["roster"].as_object().map(|_| signed_of(&v["roster"])),
        succession: v["succession"].as_object().map(|_| signed_of(&v["succession"])),
        identities: v["identities"].as_object().map(|identities| {
            identities
                .iter()
                .map(|(user, served)| {
                    (user.clone(), served.as_array().unwrap().iter().map(served_identity_of).collect())
                })
                .collect()
        }),
    })
}

pub fn case_json(name: &str, input: &CaseInput, expected: &Value) -> Value {
    json!({
        "name": name,
        "input": {
            "firstKeys": { "ed25519PublicKey": input.first_keys.ed25519_public_key, "mlDsaPublicKey": input.first_keys.ml_dsa_public_key },
            "firstKeysChecked": input.first_keys_checked,
            "pins": input.pins.iter().map(pin_json).collect::<Vec<_>>(),
            "rosters": input.rosters.iter().map(signed_json).collect::<Vec<_>>(),
            "successions": input.successions.iter().map(signed_json).collect::<Vec<_>>(),
            "mlDsaKeys": input.ml_dsa_keys,
            "me": {
                "userId": input.me.user_id,
                "identities": input.me.identities.iter().map(served_keys_json).collect::<Vec<_>>(),
            },
            "cache": input.raw_cache.clone().or_else(|| input.cache.as_ref().map(cache_json)),
            "record": input.record.as_ref().map(record_json),
            "root": input.root.as_ref().map(root_json),
            "next": input.next.as_ref().map(next_json),
            "joinMark": input.join_mark.as_ref().map(|m| json!({
                "rosterVersion": m.roster_version,
                "code": m.code,
            })),
        },
        "expected": expected,
    })
}

pub fn case_from(value: &Value) -> (String, CaseInput, Value) {
    let input = &value["input"];
    let first = &input["firstKeys"];
    let me = &input["me"];
    (
        s(value, "name"),
        CaseInput {
            first_keys: GroupPublicKey {
                ed25519_public_key: s(first, "ed25519PublicKey"),
                ml_dsa_public_key: s(first, "mlDsaPublicKey"),
            },
            first_keys_checked: input["firstKeysChecked"].as_bool().unwrap(),
            pins: input["pins"].as_array().unwrap().iter().map(pin_from).collect(),
            rosters: input["rosters"].as_array().unwrap().iter().map(signed_of).collect(),
            successions: input["successions"].as_array().unwrap().iter().map(signed_of).collect(),
            ml_dsa_keys: input["mlDsaKeys"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
                .collect(),
            me: OwnIdentities {
                user_id: s(me, "userId"),
                identities: me["identities"].as_array().unwrap().iter().map(served_keys_of).collect(),
            },
            cache: cache_of(&input["cache"]).unwrap_or(None),
            raw_cache: cache_of(&input["cache"]).err().map(|_| input["cache"].clone()),
            record: record_of(&input["record"]),
            root: root_of(&input["root"]),
            next: next_of(&input["next"]),
            join_mark: input["joinMark"].as_object().map(|_| JoinMark {
                roster_version: n(&input["joinMark"], "rosterVersion"),
                code: input["joinMark"]["code"]
                    .as_array()
                    .expect("join mark code")
                    .iter()
                    .map(|word| word.as_str().expect("join mark word").to_string())
                    .collect(),
            }),
        },
        value["expected"].clone(),
    )
}

/* JSON shapes, as the web writes them. */

fn role_name(role: GroupRole) -> &'static str {
    match role {
        GroupRole::Billing => "billing",
        GroupRole::DataAdmin => "data_admin",
        GroupRole::Guardian => "guardian",
        GroupRole::Members => "members",
        GroupRole::Recovery => "recovery",
    }
}

pub fn member_json(m: &RosterMember) -> Value {
    json!({
        "userId": m.user_id, "keyVersion": m.key_version,
        "encryptionPublicKey": m.encryption_public_key, "signingPublicKey": m.signing_public_key,
        "mlDsaPublicKeyDigest": m.ml_dsa_public_key_digest, "kemPublicKeyDigest": m.kem_public_key_digest,
        "status": match m.status { MemberStatus::Active => "active", MemberStatus::Left => "left" },
        "roles": m.roles.iter().map(|r| role_name(*r)).collect::<Vec<_>>(),
        "sinceVersion": m.since_version,
    })
}

fn role_of(name: &str) -> GroupRole {
    match name {
        "billing" => GroupRole::Billing,
        "data_admin" => GroupRole::DataAdmin,
        "guardian" => GroupRole::Guardian,
        "members" => GroupRole::Members,
        "recovery" => GroupRole::Recovery,
        other => panic!("role {other}"),
    }
}

pub fn member_of(m: &Value) -> RosterMember {
    let role = role_of;
    RosterMember {
        user_id: s(m, "userId"),
        key_version: n(m, "keyVersion"),
        encryption_public_key: s(m, "encryptionPublicKey"),
        signing_public_key: s(m, "signingPublicKey"),
        ml_dsa_public_key_digest: s(m, "mlDsaPublicKeyDigest"),
        kem_public_key_digest: s(m, "kemPublicKeyDigest"),
        status: if s(m, "status") == "active" { MemberStatus::Active } else { MemberStatus::Left },
        roles: m["roles"].as_array().unwrap().iter().map(|r| role(r.as_str().unwrap())).collect(),
        since_version: n(m, "sinceVersion"),
    }
}

pub fn roster_json(roster: &Roster) -> Value {
    json!({
        "groupId": roster.group_id,
        "kind": match roster.kind { GroupKind::Family => "family", GroupKind::Org => "org" },
        "rosterVersion": roster.roster_version,
        "previousRosterDigest": roster.previous_roster_digest,
        "groupKeyVersion": roster.group_key_version,
        "signerUserId": roster.signer_user_id,
        "members": roster.members.iter().map(|m| json!({
            "userId": m.user_id, "keyVersion": m.key_version,
            "encryptionPublicKey": m.encryption_public_key, "signingPublicKey": m.signing_public_key,
            "mlDsaPublicKeyDigest": m.ml_dsa_public_key_digest, "kemPublicKeyDigest": m.kem_public_key_digest,
            "status": match m.status { MemberStatus::Active => "active", MemberStatus::Left => "left" },
            "roles": m.roles.iter().map(|r| role_name(*r)).collect::<Vec<_>>(),
            "sinceVersion": m.since_version,
        })).collect::<Vec<_>>(),
        "areas": roster.areas.iter().map(|a| json!({
            "workspaceId": a.workspace_id,
            "workspaceKeyVersion": a.workspace_key_version,
            "commitment": a.commitment,
        })).collect::<Vec<_>>(),
    })
}

pub fn roster_of(value: &Value) -> Roster {
    let role = |name: &str| match name {
        "billing" => GroupRole::Billing,
        "data_admin" => GroupRole::DataAdmin,
        "guardian" => GroupRole::Guardian,
        "members" => GroupRole::Members,
        "recovery" => GroupRole::Recovery,
        other => panic!("role {other}"),
    };
    Roster {
        group_id: s(value, "groupId"),
        kind: if s(value, "kind") == "family" { GroupKind::Family } else { GroupKind::Org },
        roster_version: n(value, "rosterVersion"),
        previous_roster_digest: s(value, "previousRosterDigest"),
        group_key_version: n(value, "groupKeyVersion"),
        signer_user_id: s(value, "signerUserId"),
        members: value["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| RosterMember {
                user_id: s(m, "userId"),
                key_version: n(m, "keyVersion"),
                encryption_public_key: s(m, "encryptionPublicKey"),
                signing_public_key: s(m, "signingPublicKey"),
                ml_dsa_public_key_digest: s(m, "mlDsaPublicKeyDigest"),
                kem_public_key_digest: s(m, "kemPublicKeyDigest"),
                status: if s(m, "status") == "active" { MemberStatus::Active } else { MemberStatus::Left },
                roles: m["roles"].as_array().unwrap().iter().map(|r| role(r.as_str().unwrap())).collect(),
                since_version: n(m, "sinceVersion"),
            })
            .collect(),
        areas: value["areas"]
            .as_array()
            .map(|areas| {
                areas
                    .iter()
                    .map(|a| RosterArea {
                        workspace_id: s(a, "workspaceId"),
                        workspace_key_version: n(a, "workspaceKeyVersion"),
                        commitment: s(a, "commitment"),
                        root_commitment: a["rootCommitment"].as_str().map(String::from),
                        retired: a["retired"] == json!(true),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        format: value["format"].as_u64().map_or(1, |format| format as u8),
    }
}

pub fn signed_json(signed: &SignedGroupStatement) -> Value {
    json!({
        "statement": e(&signed.statement),
        "signature": { "ed25519": e(&signed.signature.ed25519), "mlDsa": e(&signed.signature.ml_dsa) },
        "signerSignature": e(&signed.signer_signature),
    })
}

pub fn signed_of(value: &Value) -> SignedGroupStatement {
    SignedGroupStatement {
        statement: b(value, "statement"),
        signature: GroupSignature {
            ed25519: b(&value["signature"], "ed25519"),
            ml_dsa: b(&value["signature"], "mlDsa"),
        },
        signer_signature: b(value, "signerSignature"),
    }
}

pub fn key_seal_ctx_json(ctx: &GroupKeySealContext) -> Value {
    json!({ "groupId": ctx.group_id, "groupKeyVersion": ctx.group_key_version, "holderUserId": ctx.holder_user_id,
        "holderKeyVersion": ctx.holder_key_version, "sealerUserId": ctx.sealer_user_id,
        "rosterVersion": ctx.roster_version, "rosterDigest": ctx.roster_digest })
}

pub fn key_seal_ctx_of(value: &Value) -> GroupKeySealContext {
    GroupKeySealContext {
        group_id: s(value, "groupId"),
        group_key_version: n(value, "groupKeyVersion"),
        holder_user_id: s(value, "holderUserId"),
        holder_key_version: n(value, "holderKeyVersion"),
        sealer_user_id: s(value, "sealerUserId"),
        // A sealer case's context leaves its roster out: the sealer seals at its own latest.
        roster_version: value["rosterVersion"].as_u64().unwrap_or(0),
        roster_digest: value["rosterDigest"].as_str().unwrap_or("").into(),
    }
}

pub fn grant_ctx_json(ctx: &AreaGrantContext) -> Value {
    json!({ "groupId": ctx.group_id, "workspaceId": ctx.workspace_id, "workspaceKeyVersion": ctx.workspace_key_version,
        "granteeUserId": ctx.grantee_user_id, "granteeKeyVersion": ctx.grantee_key_version, "granterUserId": ctx.granter_user_id,
        "rosterVersion": ctx.roster_version, "rosterDigest": ctx.roster_digest })
}

pub fn grant_ctx_of(value: &Value) -> AreaGrantContext {
    AreaGrantContext {
        group_id: s(value, "groupId"),
        workspace_id: s(value, "workspaceId"),
        workspace_key_version: n(value, "workspaceKeyVersion"),
        grantee_user_id: s(value, "granteeUserId"),
        grantee_key_version: n(value, "granteeKeyVersion"),
        granter_user_id: s(value, "granterUserId"),
        roster_version: n(value, "rosterVersion"),
        roster_digest: s(value, "rosterDigest"),
    }
}

pub fn statement_without_digest(statement: &[u8]) -> Vec<u8> {
    let mut parts: Vec<Value> = serde_json::from_slice(statement).unwrap();
    parts.pop();
    Value::Array(parts).to_string().into_bytes()
}

/*
 * The seals both twins make and must open, or refuse, alike (the web's
 * `sealCases`, in its order): the two openers, the sealer's history, and
 * the keys that must never open one. `reader` names whose secrets open it and
 * `claim` who the opener is told the reader is.
 */
#[derive(Clone)]
pub struct SealCase {
    pub name: String,
    pub kind: String,
    pub rosters: Vec<SignedGroupStatement>,
    pub ml_dsa_keys: HashMap<String, String>,
    pub ctx: Value,
    pub envelope: Vec<u8>,
    pub signer_ml_dsa_public_key: String,
    pub history: Option<SignerHistory>,
    pub reader: (u8, u8),
    pub claim: (String, u64),
    pub expected: String,
}

pub fn seal_cases() -> Vec<SealCase> {
    let (o, a, g, child, planted) = (person(1), person(2), person(3), person_at(4, 2), person(9));
    let owner =
        o.entry(&[GroupRole::Billing, GroupRole::Guardian, GroupRole::Members], 1, MemberStatus::Active);
    let active = |p: &Person, roles: &[GroupRole]| p.entry(roles, 1, MemberStatus::Active);
    let seed = group_seed(1);
    let workspace_key = pattern(32, 77);
    // Each seal names the sealer's latest accepted roster, `at`.
    let key_ctx = |holder: &Person, sealer: &Person, at: &AcceptedRosters| GroupKeySealContext {
        group_id: GROUP.into(),
        group_key_version: 1,
        holder_user_id: holder.user_id.clone(),
        holder_key_version: 1,
        sealer_user_id: sealer.user_id.clone(),
        roster_version: at.roster().roster_version,
        roster_digest: at.roster_digest(),
    };
    let mut cases = vec![];
    #[allow(clippy::too_many_arguments)]
    let mut push = |name: &str,
                    kind: &str,
                    rosters: &[SignedGroupStatement],
                    ml_dsa_keys: &HashMap<String, String>,
                    ctx: Value,
                    envelope: Vec<u8>,
                    signer: &Person,
                    history: Option<SignerHistory>,
                    reader: (u8, u8),
                    claim: Option<(String, u64)>,
                    expected: String| {
        let claim =
            claim.unwrap_or((format!("{:08x}-abcd-4abc-8abc-abcdefabcdef", reader.0), reader.1 as u64));
        cases.push(SealCase {
            name: name.into(),
            kind: kind.into(),
            rosters: rosters.to_vec(),
            ml_dsa_keys: ml_dsa_keys.clone(),
            ctx,
            envelope,
            signer_ml_dsa_public_key: signer.served.ml_dsa_public_key.clone(),
            history,
            reader,
            claim,
            expected,
        });
    };
    let refused = || "refused".to_string();

    // A family at 1: the organizer, a `members` adult, a guardian, a child.
    let as_one = vec![
        owner.clone(),
        active(&a, &[GroupRole::Members]),
        active(&g, &[GroupRole::Guardian]),
        active(&child, &[]),
    ];
    let mut h = History::new();
    h.roster(&o, as_one.clone(), None);
    let one = accepted_of(&h, &[&o]);
    let keys1 = served_ml_dsa(&[&o, &a, &g, &child]);
    let at_one = h.rosters.clone();
    let key_seal =
        group_key_seal(seed.clone(), key_ctx(&a, &o, &one), one.clone(), a.kem(), o.keys.clone()).unwrap();
    let kc = key_seal_ctx_json(&key_ctx(&a, &o, &one));
    push("key-opens", "key", &at_one, &keys1, kc.clone(), key_seal.clone(), &o, None, (2, 1), None, e(&seed));
    push(
        "key-other-reader-version",
        "key",
        &at_one,
        &keys1,
        kc.clone(),
        key_seal.clone(),
        &o,
        None,
        (2, 1),
        Some((a.user_id.clone(), 2)),
        refused(),
    );
    let unpublished =
        group_key_seal(pattern(64, 5), key_ctx(&a, &o, &one), one.clone(), a.kem(), o.keys.clone()).unwrap();
    push(
        "key-seed-not-published",
        "key",
        &at_one,
        &keys1,
        kc.clone(),
        unpublished,
        &o,
        None,
        (2, 1),
        None,
        refused(),
    );
    // g held `members` at 2 and sealed there; 3 takes the role away. Not theirs to hand out now.
    {
        let mut held = History::new();
        held.roster(&o, as_one.clone(), None);
        held.roster(
            &o,
            vec![
                owner.clone(),
                active(&a, &[GroupRole::Members]),
                active(&g, &[GroupRole::Guardian, GroupRole::Members]),
                active(&child, &[]),
            ],
            None,
        );
        let at_two = accepted_of(&held, &[&o]);
        let by_g =
            group_key_seal(seed.clone(), key_ctx(&a, &g, &at_two), at_two.clone(), a.kem(), g.keys.clone())
                .unwrap();
        held.roster(&o, as_one.clone(), None);
        push(
            "key-sealer-not-holder",
            "key",
            &held.rosters,
            &keys1,
            key_seal_ctx_json(&key_ctx(&a, &g, &at_two)),
            by_g,
            &g,
            None,
            (2, 1),
            None,
            refused(),
        );
    }
    let grant_ctx = AreaGrantContext {
        group_id: GROUP.into(),
        workspace_id: AREA.into(),
        workspace_key_version: 1,
        grantee_user_id: g.user_id.clone(),
        grantee_key_version: 1,
        granter_user_id: a.user_id.clone(),
        roster_version: one.roster().roster_version,
        roster_digest: one.roster_digest(),
    };
    let grant = area_grant_seal(
        workspace_key.clone(),
        grant_ctx.clone(),
        one.clone(),
        AREA_SEED.into(),
        g.kem(),
        a.keys.clone(),
    )
    .unwrap();
    let gc = grant_ctx_json(&grant_ctx);
    push(
        "grant-opens",
        "grant",
        &at_one,
        &keys1,
        gc.clone(),
        grant.clone(),
        &a,
        None,
        (3, 1),
        None,
        e(&workspace_key),
    );
    // At 2 the adult has left: their grant no longer opens.
    h.roster(
        &o,
        vec![
            owner.clone(),
            a.entry(&[GroupRole::Members], 2, MemberStatus::Left),
            active(&g, &[]),
            active(&child, &[]),
        ],
        None,
    );
    push(
        "grant-from-left-granter",
        "grant",
        &h.rosters,
        &keys1,
        gc,
        grant,
        &a,
        None,
        (3, 1),
        None,
        refused(),
    );

    // The adult seals while a holder, then their next identity is folded in at 2.
    let (a2, link) = succeed(&a);
    let mut f = History::new();
    f.roster(&o, vec![owner.clone(), active(&a, &[GroupRole::Members])], None);
    let before = accepted_of(&f, &[&o, &a]);
    let folded =
        group_key_seal(seed.clone(), key_ctx(&o, &a, &before), before.clone(), o.kem(), a.keys.clone())
            .unwrap();
    f.roster(&o, vec![owner.clone(), active(&a2, &[GroupRole::Members])], None);
    let keys_f = served_ml_dsa(&[&o, &a, &a2]);
    let a_history = SignerHistory { served: served_keys(&a2), links: vec![link.clone()] };
    let junk_link = SuccessionLink {
        old_encryption_public_key: g.served.encryption_public_key.clone(),
        signature: e(&[0u8; 3373]),
        ..link.clone()
    };
    let fc = key_seal_ctx_json(&key_ctx(&o, &a, &before));
    push(
        "folded-sealer-opens",
        "key",
        &f.rosters,
        &keys_f,
        fc.clone(),
        folded.clone(),
        &a2,
        Some(a_history.clone()),
        (1, 1),
        None,
        e(&seed),
    );
    push(
        "folded-sealer-needs-history",
        "key",
        &f.rosters,
        &keys_f,
        fc.clone(),
        folded.clone(),
        &a2,
        None,
        (1, 1),
        None,
        refused(),
    );
    push(
        "folded-sealer-junk-link",
        "key",
        &f.rosters,
        &keys_f,
        fc.clone(),
        folded.clone(),
        &a2,
        Some(SignerHistory { links: vec![junk_link.clone(), link.clone(), junk_link], ..a_history.clone() }),
        (1, 1),
        None,
        e(&seed),
    );
    // A second successor the adult signed from the same key: a forked identity lends no history.
    let twin_link = link_between(&a, &person_at(2, 4));
    push(
        "folded-sealer-forked",
        "key",
        &f.rosters,
        &keys_f,
        fc.clone(),
        folded.clone(),
        &a2,
        Some(SignerHistory { links: vec![twin_link, link.clone()], ..a_history.clone() }),
        (1, 1),
        None,
        refused(),
    );
    // a2 replaced in turn and not folded in. A seal under a2's keys (the entry's) still opens with
    // the served a3.
    let (a3, link23) = succeed(&a2);
    let a3_history = SignerHistory { served: served_keys(&a3), links: vec![link.clone(), link23.clone()] };
    let with_a2 = accepted_of(&f, &[&o, &a, &a2]);
    let by_a2 =
        group_key_seal(seed.clone(), key_ctx(&o, &a, &with_a2), with_a2.clone(), o.kem(), a2.keys.clone())
            .unwrap();
    push(
        "entry-sealer-moved-on",
        "key",
        &f.rosters,
        &keys_f,
        key_seal_ctx_json(&key_ctx(&o, &a, &with_a2)),
        by_a2,
        &a3,
        Some(a3_history.clone()),
        (1, 1),
        None,
        e(&seed),
    );
    // r9: the seal from before the fold-in, with a2's own successor a3 served on its version 2 link
    // alone: only the links before the entry's keys need consent, so it still opens.
    push(
        "folded-sealer-one-sided-after-entry",
        "key",
        &f.rosters,
        &keys_f,
        fc.clone(),
        folded.clone(),
        &a2,
        Some(SignerHistory { served: served_keys(&a3), links: vec![link.clone(), one_sided(&link23)] }),
        (1, 1),
        None,
        e(&seed),
    );
    // a3 was folded in at 3 and sealed there; 4 puts a2 back. A seal under keys past the entry's
    // never opens, whether a3 is served (lagging-sealer-refused) or a4 beyond it (past-entry).
    let mut rolled = History::new();
    rolled.roster(&o, vec![owner.clone(), active(&a, &[GroupRole::Members])], None);
    rolled.roster(&o, vec![owner.clone(), active(&a2, &[GroupRole::Members])], None);
    rolled.roster(&o, vec![owner.clone(), active(&a3, &[GroupRole::Members])], None);
    let with_a3 = accepted_of(&rolled, &[&o, &a, &a2, &a3]);
    let by_a3 =
        group_key_seal(seed.clone(), key_ctx(&o, &a, &with_a3), with_a3.clone(), o.kem(), a3.keys.clone())
            .unwrap();
    rolled.roster(&o, vec![owner.clone(), active(&a2, &[GroupRole::Members])], None);
    let keys_rolled = served_ml_dsa(&[&o, &a, &a2, &a3]);
    let rc = key_seal_ctx_json(&key_ctx(&o, &a, &with_a3));
    push(
        "lagging-sealer-refused",
        "key",
        &rolled.rosters,
        &keys_rolled,
        rc.clone(),
        by_a3.clone(),
        &a3,
        Some(a3_history),
        (1, 1),
        None,
        refused(),
    );
    let (a4, link34) = succeed(&a3);
    push(
        "sealer-past-entry-refused",
        "key",
        &rolled.rosters,
        &keys_rolled,
        rc,
        by_a3,
        &a4,
        Some(SignerHistory { served: served_keys(&a4), links: vec![link.clone(), link23, link34] }),
        (1, 1),
        None,
        refused(),
    );
    // While a holder's planted keys are a's entry, a's real chain never reaches it: a's own seal
    // from before does not open through it.
    let mut pa = History::new();
    pa.roster(&o, vec![owner.clone(), active(&a, &[GroupRole::Members])], None);
    pa.roster(
        &o,
        vec![
            owner.clone(),
            RosterMember { user_id: a.user_id.clone(), ..active(&planted, &[GroupRole::Members]) },
        ],
        None,
    );
    push(
        "planted-entry-lends-no-history",
        "key",
        &pa.rosters,
        &served_ml_dsa(&[&o, &a, &planted]),
        fc,
        folded,
        &a2,
        Some(a_history),
        (1, 1),
        None,
        refused(),
    );

    // The organizer replaced their identity, a roster folded it in at 2 and they sealed there; 3
    // puts the old keys back. The new keys open nothing while the entry names the old.
    let (o2, o_link) = succeed(&o);
    let mut r = History::new();
    r.roster(&o, vec![owner.clone(), active(&g, &[GroupRole::Members])], None);
    r.roster(
        &o,
        vec![
            o2.entry(&[GroupRole::Billing, GroupRole::Guardian, GroupRole::Members], 1, MemberStatus::Active),
            active(&g, &[GroupRole::Members]),
        ],
        None,
    );
    let with_o2 = accepted_of(&r, &[&o, &o2, &g]);
    let by_o2 =
        group_key_seal(seed.clone(), key_ctx(&g, &o, &with_o2), with_o2.clone(), g.kem(), o2.keys.clone())
            .unwrap();
    r.roster(&o2, vec![owner.clone(), active(&g, &[GroupRole::Members])], None);
    push(
        "replaced-sealer-not-folded-in",
        "key",
        &r.rosters,
        &served_ml_dsa(&[&o, &o2, &g]),
        key_seal_ctx_json(&key_ctx(&g, &o, &with_o2)),
        by_o2,
        &o2,
        Some(SignerHistory { served: served_keys(&o2), links: vec![o_link] }),
        (3, 1),
        None,
        refused(),
    );

    // r8 (Fable F2): the same family at 2 on the real chain and on a branch. g, active on both,
    // grants an area key on the branch: the grant names the branch roster and opens nothing on the
    // real chain; g's grant made on the real chain does. A seal from a roster the opener has not
    // reached yet opens nothing either.
    {
        let mut real = History::new();
        real.roster(
            &o,
            vec![owner.clone(), active(&a, &[GroupRole::Members]), active(&g, &[GroupRole::Members])],
            None,
        );
        let mut branch = History::new();
        branch.roster(
            &o,
            vec![owner.clone(), active(&a, &[GroupRole::Members]), active(&g, &[GroupRole::Members])],
            None,
        );
        real.roster(
            &o,
            vec![
                owner.clone(),
                a.entry(&[GroupRole::Members], 1, MemberStatus::Left),
                active(&g, &[GroupRole::Members]),
            ],
            None,
        );
        branch.roster(
            &a,
            vec![
                owner.clone(),
                active(&a, &[GroupRole::Members]),
                active(&g, &[GroupRole::Members]),
                active(&child, &[]),
            ],
            None,
        );
        let keys = served_ml_dsa(&[&o, &a, &g, &child]);
        let on_branch = accepted_of(&branch, &[&o, &a, &g, &child]);
        let on_real = accepted_of(&real, &[&o, &a, &g]);
        let grant_on = |at: &AcceptedRosters| AreaGrantContext {
            group_id: GROUP.into(),
            workspace_id: AREA.into(),
            workspace_key_version: 1,
            grantee_user_id: o.user_id.clone(),
            grantee_key_version: 1,
            granter_user_id: g.user_id.clone(),
            roster_version: at.roster().roster_version,
            roster_digest: at.roster_digest(),
        };
        let seal_on = |at: &Arc<AcceptedRosters>| {
            area_grant_seal(
                workspace_key.clone(),
                grant_on(at),
                at.clone(),
                AREA_SEED.into(),
                o.kem(),
                g.keys.clone(),
            )
            .unwrap()
        };
        push(
            "grant-sealed-on-a-branch",
            "grant",
            &real.rosters,
            &keys,
            grant_ctx_json(&grant_on(&on_branch)),
            seal_on(&on_branch),
            &g,
            None,
            (1, 1),
            None,
            refused(),
        );
        push(
            "grant-sealed-on-the-chain",
            "grant",
            &real.rosters,
            &keys,
            grant_ctx_json(&grant_on(&on_real)),
            seal_on(&on_real),
            &g,
            None,
            (1, 1),
            None,
            e(&workspace_key),
        );
        push(
            "seal-from-a-newer-roster",
            "grant",
            &real.rosters[..1],
            &keys,
            grant_ctx_json(&grant_on(&on_real)),
            seal_on(&on_real),
            &g,
            None,
            (1, 1),
            None,
            refused(),
        );
    }

    // A holder writes keys they hold into the child's entry at 2 and signs a link from them to the
    // child's real keys; the child's own entry is back at 3. A grant the planted keys made opens
    // nothing.
    let mut p = History::new();
    p.roster(&o, vec![owner.clone(), active(&g, &[GroupRole::Guardian]), active(&child, &[])], None);
    p.roster(
        &o,
        vec![
            owner.clone(),
            active(&g, &[GroupRole::Guardian]),
            RosterMember { user_id: child.user_id.clone(), ..active(&planted, &[]) },
        ],
        None,
    );
    let while_planted = accepted_of(&p, &[&o, &g, &child, &planted]);
    p.roster(
        &o,
        vec![owner.clone(), active(&g, &[GroupRole::Guardian]), child.entry(&[], 3, MemberStatus::Active)],
        None,
    );
    let mut planted_link = SuccessionLink {
        old_key_version: 1,
        new_key_version: 2,
        old_encryption_public_key: planted.served.encryption_public_key.clone(),
        old_signing_public_key: planted.served.signing_public_key.clone(),
        old_ml_dsa_public_key: planted.served.ml_dsa_public_key.clone(),
        new_encryption_public_key: child.served.encryption_public_key.clone(),
        new_signing_public_key: child.served.signing_public_key.clone(),
        new_ml_dsa_public_key: child.served.ml_dsa_public_key.clone(),
        new_kem_public_key: child.served.kem_public_key.clone(),
        signature: String::new(),
        consent: None,
    };
    let statement = succession_statement(child.user_id.clone(), planted_link.clone()).unwrap();
    planted_link.signature =
        e(&hybrid_sign(planted.keys.signing_seed.to_vec(), planted.keys.ml_dsa_seed.to_vec(), statement)
            .unwrap());
    // Given the child's consent as well (a test can sign it), so the case pins the first-keys
    // rule apart from the consent rule.
    planted_link.consent = Some(consent_of(&planted_link, &child.user_id, &planted.keys, &child.keys));
    let planted_grant = AreaGrantContext {
        group_id: GROUP.into(),
        workspace_id: AREA.into(),
        workspace_key_version: 1,
        grantee_user_id: g.user_id.clone(),
        grantee_key_version: 1,
        granter_user_id: child.user_id.clone(),
        roster_version: while_planted.roster().roster_version,
        roster_digest: while_planted.roster_digest(),
    };
    let by_planted_grant = area_grant_seal(
        workspace_key.clone(),
        planted_grant.clone(),
        while_planted,
        AREA_SEED.into(),
        g.kem(),
        planted.keys.clone(),
    )
    .unwrap();
    push(
        "planted-key-grant",
        "grant",
        &p.rosters,
        &served_ml_dsa(&[&o, &g, &child, &planted]),
        grant_ctx_json(&planted_grant),
        by_planted_grant,
        &child,
        Some(SignerHistory { served: served_keys(&child), links: vec![planted_link.clone()] }),
        (3, 1),
        None,
        refused(),
    );
    // F1: the planted keys are the child's FIRST entry, so the chain starts at them, and the
    // child's real keys follow at 2. A link from the planted keys the child never co-signed (all a
    // planter can serve: one-sided, or with junk for the consent) bridges nothing, and the planted
    // keys' grant opens nothing. With the child's consent, the same link carries it.
    {
        let mut pf = History::new();
        pf.roster(
            &o,
            vec![
                owner.clone(),
                active(&g, &[GroupRole::Guardian]),
                RosterMember { user_id: child.user_id.clone(), ..active(&planted, &[]) },
            ],
            None,
        );
        let first_planted = accepted_of(&pf, &[&o, &g, &child, &planted]);
        let first_grant = AreaGrantContext {
            roster_version: first_planted.roster().roster_version,
            roster_digest: first_planted.roster_digest(),
            ..planted_grant.clone()
        };
        pf.roster(
            &o,
            vec![
                owner.clone(),
                active(&g, &[GroupRole::Guardian]),
                child.entry(&[], 2, MemberStatus::Active),
            ],
            None,
        );
        let envelope = area_grant_seal(
            workspace_key.clone(),
            first_grant.clone(),
            first_planted,
            AREA_SEED.into(),
            g.kem(),
            planted.keys.clone(),
        )
        .unwrap();
        let keys = served_ml_dsa(&[&o, &g, &child, &planted]);
        for (name, link, expected) in [
            ("planted-first-key-grant", one_sided(&planted_link), refused()),
            (
                "planted-first-key-grant-planter-consent",
                SuccessionLink {
                    consent: Some(consent_halves(&planted_link, &child.user_id, Some(&planted.keys), None)),
                    ..planted_link.clone()
                },
                refused(),
            ),
            ("planted-first-key-grant-consented", planted_link.clone(), e(&workspace_key)),
        ] {
            push(
                name,
                "grant",
                &pf.rosters,
                &keys,
                grant_ctx_json(&first_grant),
                envelope.clone(),
                &child,
                Some(SignerHistory { served: served_keys(&child), links: vec![link] }),
                (3, 1),
                None,
                expected,
            );
        }
    }
    // r9: after AREA's rotation to version 2 (key pattern(32, 78)), a grant of version 1's key (a
    // reader needs it for older files) still opens, checked against the commitment roster 1
    // listed; version 2's opens too. Another key under either, or version 3, is never sealed
    // (sealer_cases).
    {
        let mut r = History::new();
        let members = || vec![owner.clone(), active(&a, &[GroupRole::Members]), active(&g, &[])];
        r.roster(&o, members(), None);
        r.roster_with(
            &o,
            members(),
            Some(1),
            Some(vec![RosterArea {
                workspace_id: AREA.into(),
                workspace_key_version: 2,
                commitment: area_key_commitment(&pattern(32, 78)).unwrap(),
                root_commitment: None,
                retired: false,
            }]),
        );
        let rotated = accepted_of(&r, &[&o, &a, &g]);
        let ctx_at = |version: u64| AreaGrantContext {
            group_id: GROUP.into(),
            workspace_id: AREA.into(),
            workspace_key_version: version,
            grantee_user_id: g.user_id.clone(),
            grantee_key_version: 1,
            granter_user_id: a.user_id.clone(),
            roster_version: rotated.roster().roster_version,
            roster_digest: rotated.roster_digest(),
        };
        let keys = served_ml_dsa(&[&o, &a, &g]);
        for (name, version, key) in [
            ("grant-earlier-version-after-rotation", 1, workspace_key.clone()),
            ("grant-rotated-version", 2, pattern(32, 78)),
        ] {
            let envelope = area_grant_seal(
                key.clone(),
                ctx_at(version),
                rotated.clone(),
                AREA_SEED.into(),
                g.kem(),
                a.keys.clone(),
            )
            .unwrap();
            push(
                name,
                "grant",
                &r.rosters,
                &keys,
                grant_ctx_json(&ctx_at(version)),
                envelope,
                &a,
                None,
                (3, 1),
                None,
                e(&key),
            );
        }
    }
    // A key seal claimed by another reader than the holder it names.
    push(
        "key-other-reader",
        "key",
        &at_one,
        &keys1,
        kc,
        key_seal,
        &o,
        None,
        (2, 1),
        Some((o.user_id.clone(), 1)),
        refused(),
    );
    // Keys planted as the adult's at 2 seal; the adult's real chain is served with a junk link
    // naming the planted keys beside it. Only links on the verified chain lend keys: refused.
    let mut q = History::new();
    q.roster(&o, vec![owner.clone(), active(&a, &[GroupRole::Members])], None);
    q.roster(
        &o,
        vec![
            owner.clone(),
            RosterMember { user_id: a.user_id.clone(), ..active(&planted, &[GroupRole::Members]) },
        ],
        None,
    );
    let as_adult = accepted_of(&q, &[&o, &a, &planted]);
    q.roster(&o, vec![owner.clone(), active(&a2, &[GroupRole::Members])], None);
    let by_planted = group_key_seal(
        seed.clone(),
        key_ctx(&o, &a, &as_adult),
        as_adult.clone(),
        o.kem(),
        planted.keys.clone(),
    )
    .unwrap();
    let planted_junk = SuccessionLink {
        old_encryption_public_key: planted.served.encryption_public_key.clone(),
        old_signing_public_key: planted.served.signing_public_key.clone(),
        old_ml_dsa_public_key: planted.served.ml_dsa_public_key.clone(),
        signature: e(&[0u8; 3373]),
        ..link.clone()
    };
    push(
        "junk-link-names-planted-key",
        "key",
        &q.rosters,
        &served_ml_dsa(&[&o, &a, &a2, &planted]),
        key_seal_ctx_json(&key_ctx(&o, &a, &as_adult)),
        by_planted,
        &a2,
        Some(SignerHistory { served: served_keys(&a2), links: vec![link, planted_junk] }),
        (1, 1),
        None,
        refused(),
    );
    // The creator sealed key 1 to a, then left: their seals open nothing, key 1's included.
    let mut c = History::new();
    c.roster(&o, vec![owner.clone(), active(&a, &[GroupRole::Members])], None);
    let at_created = accepted_of(&c, &[&o, &a]);
    let by_creator = group_key_seal(
        seed.clone(),
        key_ctx(&a, &o, &at_created),
        at_created.clone(),
        a.kem(),
        o.keys.clone(),
    )
    .unwrap();
    c.roster(
        &a,
        vec![
            o.entry(&[GroupRole::Billing, GroupRole::Guardian, GroupRole::Members], 1, MemberStatus::Left),
            active(&a, &[GroupRole::Members]),
        ],
        None,
    );
    push(
        "creator-left-key-seal",
        "key",
        &c.rosters,
        &served_ml_dsa(&[&o, &a]),
        key_seal_ctx_json(&key_ctx(&a, &o, &at_created)),
        by_creator,
        &o,
        None,
        (2, 1),
        None,
        refused(),
    );
    cases
}

/*
 * Key seals both twins must make, or refuse to make, alike (the web's
 * `sealerCases`): a sealer whose key is not their entry's, nor reached from
 * it by their own chain, is refused.
 */
#[derive(Clone)]
pub struct SealerCase {
    pub name: String,
    pub rosters: Vec<SignedGroupStatement>,
    pub ml_dsa_keys: HashMap<String, String>,
    pub ctx: GroupKeySealContext,
    pub holder: (u8, u8),
    pub sealer: (u8, u8),
    /* An area grant from the sealer to the holder instead of a key seal. */
    pub grant: bool,
    /* The roster version the seal names, when not the sealer's latest. */
    pub at: Option<u64>,
    /* A grant's workspace key (pattern(32, seed)) and key version. */
    pub grant_key_seed: u8,
    pub grant_key_version: u64,
    pub expected: String,
}

pub fn sealer_cases() -> Vec<SealerCase> {
    let (o, g, outsider) = (person(1), person(3), person(5));
    let mut h = History::new();
    h.roster(
        &o,
        vec![
            o.entry(&[GroupRole::Billing, GroupRole::Guardian, GroupRole::Members], 1, MemberStatus::Active),
            g.entry(&[GroupRole::Members], 1, MemberStatus::Active),
        ],
        None,
    );
    let ctx = GroupKeySealContext {
        group_id: GROUP.into(),
        group_key_version: 1,
        holder_user_id: g.user_id.clone(),
        holder_key_version: 1,
        sealer_user_id: o.user_id.clone(),
        // Filled at sealing: a sealer seals at its own latest accepted roster.
        roster_version: 0,
        roster_digest: String::new(),
    };
    let owner =
        o.entry(&[GroupRole::Billing, GroupRole::Guardian, GroupRole::Members], 1, MemberStatus::Active);
    let mut plain = History::new();
    plain.roster(&o, vec![owner.clone(), g.entry(&[], 1, MemberStatus::Active)], None);
    let mut gone = History::new();
    gone.roster(&o, vec![owner.clone(), g.entry(&[GroupRole::Members], 1, MemberStatus::Active)], None);
    gone.roster(&o, vec![owner.clone(), g.entry(&[GroupRole::Members], 1, MemberStatus::Left)], None);
    // Format 2: the area listed, then retired.
    let mut retired = History::format_2();
    retired.roster(&o, vec![owner.clone(), g.entry(&[GroupRole::Members], 1, MemberStatus::Active)], None);
    retired.roster_with(
        &o,
        vec![owner.clone(), g.entry(&[GroupRole::Members], 1, MemberStatus::Active)],
        Some(1),
        Some(vec![tombstone_at(AREA, 2)]),
    );
    // Two rosters, the sealer a holder in both.
    let mut two = History::new();
    two.roster(&o, vec![owner.clone(), g.entry(&[GroupRole::Members], 1, MemberStatus::Active)], None);
    two.roster(
        &o,
        vec![owner.clone(), g.entry(&[GroupRole::Billing, GroupRole::Members], 2, MemberStatus::Active)],
        None,
    );
    let mut half = History::new();
    half.roster(
        &g,
        vec![
            g.entry(&[GroupRole::Billing, GroupRole::Guardian, GroupRole::Members], 1, MemberStatus::Active),
            RosterMember {
                ml_dsa_public_key_digest: e(&sha256(&outsider.ml_dsa())),
                ..o.entry(&[GroupRole::Members], 1, MemberStatus::Active)
            },
        ],
        None,
    );
    let to_organizer = |name: &str, rosters: Vec<SignedGroupStatement>| SealerCase {
        name: name.into(),
        rosters,
        ml_dsa_keys: served_ml_dsa(&[&o, &g]),
        ctx: GroupKeySealContext {
            holder_user_id: o.user_id.clone(),
            sealer_user_id: g.user_id.clone(),
            ..ctx.clone()
        },
        holder: (1, 1),
        sealer: (3, 1),
        grant: false,
        at: None,
        grant_key_seed: AREA_KEY_SEED,
        grant_key_version: 1,
        expected: "refused".into(),
    };
    let case = |name: &str, sealer: (u8, u8), expected: &str| SealerCase {
        name: name.into(),
        rosters: h.rosters.clone(),
        ml_dsa_keys: served_ml_dsa(&[&o, &g]),
        ctx: ctx.clone(),
        holder: (3, 1),
        sealer,
        grant: false,
        at: None,
        grant_key_seed: AREA_KEY_SEED,
        grant_key_version: 1,
        expected: expected.into(),
    };
    vec![
        case("sealer-own-keys", (1, 1), "sealed"),
        case("sealer-replaced-not-folded-in", (1, 2), "refused"),
        case("sealer-not-themselves", (3, 1), "refused"),
        // Only an active Members holder seals the key: g without it, then g after leaving.
        to_organizer("sealer-not-holder", plain.rosters.clone()),
        to_organizer("sealer-left", gone.rosters.clone()),
        // The sealer's entry names their Ed25519 key with another ML-DSA key: not their keys.
        SealerCase {
            name: "sealer-half-other-key".into(),
            rosters: half.rosters.clone(),
            ml_dsa_keys: served_ml_dsa(&[&o, &g, &outsider]),
            ..case("", (1, 1), "refused")
        },
        // Area grants: from an active member, and from one who has left.
        SealerCase { grant: true, ..case("granter-active", (1, 1), "sealed") },
        SealerCase { grant: true, ..to_organizer("granter-left", gone.rosters.clone()) },
        // A seal names the sealer's latest accepted roster: one naming an earlier roster on the
        // same chain is refused (a lagging seal carried forward), key seal and grant alike.
        SealerCase {
            rosters: two.rosters.clone(),
            at: Some(1),
            ..case("sealer-names-an-older-roster", (1, 1), "refused")
        },
        SealerCase {
            rosters: two.rosters.clone(),
            at: Some(1),
            grant: true,
            ..case("granter-names-an-older-roster", (1, 1), "refused")
        },
        // r9: a grant only of a key the latest roster lists: not another key at a listed version,
        // nor a version it does not list (a rotation is a roster first).
        SealerCase { grant: true, grant_key_seed: 13, ..case("granter-key-not-listed", (1, 1), "refused") },
        SealerCase {
            grant: true,
            grant_key_version: 2,
            ..case("granter-version-not-listed", (1, 1), "refused")
        },
        // Design 2.10: a retired area is granted no more, even its listed key.
        SealerCase {
            rosters: retired.rosters.clone(),
            grant: true,
            ..case("granter-retired-area", (1, 1), "refused")
        },
    ]
}

pub fn sealer_verdict(c: &SealerCase) -> String {
    let (holder, sealer) = (person_at(c.holder.0, c.holder.1), person_at(c.sealer.0, c.sealer.1));
    let Ok(RosterChain::Accepted { chain }) = accept_rosters(
        GROUP.into(),
        group_public_key(group_seed(1)).unwrap(),
        true,
        vec![],
        c.rosters.clone(),
        vec![],
        c.ml_dsa_keys.clone(),
        reader(),
        None,
    ) else {
        return "refused".into();
    };
    let keys = sealer.keys.clone();
    let (roster_version, roster_digest) = match c.at {
        Some(at) => (at, chain.roster_digests()[at as usize - 1].clone()),
        None => (chain.roster().roster_version, chain.roster_digest()),
    };
    let result = if c.grant {
        area_grant_seal(
            pattern(32, c.grant_key_seed),
            AreaGrantContext {
                group_id: c.ctx.group_id.clone(),
                workspace_id: AREA.into(),
                workspace_key_version: c.grant_key_version,
                grantee_user_id: c.ctx.holder_user_id.clone(),
                grantee_key_version: c.ctx.holder_key_version,
                granter_user_id: c.ctx.sealer_user_id.clone(),
                roster_version,
                roster_digest,
            },
            chain,
            AREA_SEED.into(),
            holder.kem(),
            keys,
        )
    } else {
        group_key_seal(
            group_seed(1),
            GroupKeySealContext { roster_version, roster_digest, ..c.ctx.clone() },
            chain,
            holder.kem(),
            keys,
        )
    };
    match result {
        Ok(_) => "sealed".into(),
        Err(_) => "refused".into(),
    }
}

pub fn sealer_case_json(c: &SealerCase) -> Value {
    json!({
        "name": c.name,
        "rosters": c.rosters.iter().map(signed_json).collect::<Vec<_>>(),
        "mlDsaKeys": c.ml_dsa_keys,
        "ctx": key_seal_ctx_json(&c.ctx),
        "holder": { "n": c.holder.0, "keyVersion": c.holder.1 },
        "sealer": { "n": c.sealer.0, "keyVersion": c.sealer.1 },
        "grant": c.grant,
        "at": c.at,
        "grantKeySeed": c.grant_key_seed,
        "grantKeyVersion": c.grant_key_version,
        "expected": c.expected,
    })
}

pub fn sealer_case_from(v: &Value) -> SealerCase {
    SealerCase {
        name: s(v, "name"),
        rosters: v["rosters"].as_array().unwrap().iter().map(signed_of).collect(),
        ml_dsa_keys: v["mlDsaKeys"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, x)| (k.clone(), x.as_str().unwrap().to_string()))
            .collect(),
        ctx: key_seal_ctx_of(&v["ctx"]),
        holder: (n(&v["holder"], "n") as u8, n(&v["holder"], "keyVersion") as u8),
        sealer: (n(&v["sealer"], "n") as u8, n(&v["sealer"], "keyVersion") as u8),
        grant: v["grant"].as_bool().unwrap(),
        at: v["at"].as_u64(),
        grant_key_seed: n(v, "grantKeySeed") as u8,
        grant_key_version: n(v, "grantKeyVersion"),
        expected: s(v, "expected"),
    }
}

/* What a seal case's opener gives: the payload (base64url), or refused. */
pub fn seal_verdict(c: &SealCase) -> String {
    let reader = person_at(c.reader.0, c.reader.1);
    let Ok(RosterChain::Accepted { chain }) = accept_rosters(
        GROUP.into(),
        group_public_key(group_seed(1)).unwrap(),
        true,
        vec![],
        c.rosters.clone(),
        vec![],
        c.ml_dsa_keys.clone(),
        reader_identities(),
        None,
    ) else {
        return "refused".into();
    };
    let signer = base64url_decode(c.signer_ml_dsa_public_key.clone()).unwrap();
    let (claim, version) = c.claim.clone();
    let opened = match c.kind.as_str() {
        "key" => group_key_open(
            c.envelope.clone(),
            key_seal_ctx_of(&c.ctx),
            chain,
            signer,
            c.history.clone(),
            claim,
            version,
            reader.keys.clone(),
        )
        .map(|seed| seed.to_vec()),
        "grant" => area_grant_open(
            c.envelope.clone(),
            grant_ctx_of(&c.ctx),
            chain,
            AREA_SEED.into(),
            signer,
            c.history.clone(),
            claim,
            version,
            reader.keys.clone(),
        ),
        kind => panic!("no seal kind {kind}"),
    };
    opened.map(|bytes| e(&bytes)).unwrap_or_else(|_| "refused".into())
}

fn reader_identities() -> OwnIdentities {
    reader()
}

fn history_json(h: &SignerHistory) -> Value {
    json!({ "served": served_keys_json(&h.served), "links": h.links.iter().map(link_json).collect::<Vec<_>>() })
}

pub fn seal_case_json(c: &SealCase) -> Value {
    json!({
        "name": c.name,
        "kind": c.kind,
        "rosters": c.rosters.iter().map(signed_json).collect::<Vec<_>>(),
        "mlDsaKeys": c.ml_dsa_keys,
        "ctx": c.ctx,
        "envelope": e(&c.envelope),
        "signerMlDsaPublicKey": c.signer_ml_dsa_public_key,
        "history": c.history.as_ref().map(history_json),
        "reader": { "n": c.reader.0, "keyVersion": c.reader.1 },
        "claim": { "userId": c.claim.0, "keyVersion": c.claim.1 },
        "expected": c.expected,
    })
}

pub fn seal_case_from(v: &Value) -> SealCase {
    SealCase {
        name: s(v, "name"),
        kind: s(v, "kind"),
        rosters: v["rosters"].as_array().unwrap().iter().map(signed_of).collect(),
        ml_dsa_keys: v["mlDsaKeys"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, x)| (k.clone(), x.as_str().unwrap().to_string()))
            .collect(),
        ctx: v["ctx"].clone(),
        envelope: b(v, "envelope"),
        signer_ml_dsa_public_key: s(v, "signerMlDsaPublicKey"),
        history: v["history"].as_object().map(|_| SignerHistory {
            served: served_keys_of(&v["history"]["served"]),
            links: v["history"]["links"].as_array().unwrap().iter().map(link_of).collect(),
        }),
        reader: (n(&v["reader"], "n") as u8, n(&v["reader"], "keyVersion") as u8),
        claim: (s(&v["claim"], "userId"), n(&v["claim"], "keyVersion")),
        expected: s(v, "expected"),
    }
}

/*
 * First rosters both twins must build to the same bytes, or refuse alike
 * (roster_first, firstRoster): the creator's entry normalized (roles sorted,
 * since-version 1), rows computed from the keys and sorted, and every rule
 * acceptance holds roster version 1 to. The web's firstRosterCases, in order.
 */
pub struct FirstRosterCase {
    pub name: String,
    pub group_id: String,
    pub kind: GroupKind,
    pub creator: RosterMember,
    /* Each area's workspace id and key. */
    pub area_keys: Vec<(String, Vec<u8>)>,
}

pub fn first_roster_cases() -> Vec<FirstRosterCase> {
    let organizer = person(1);
    let key = |workspace_id: &str, seed: u8| (workspace_id.to_string(), pattern(32, seed));
    let of = |name: &str, creator: RosterMember, area_keys: Vec<(String, Vec<u8>)>| FirstRosterCase {
        name: name.into(),
        group_id: GROUP.into(),
        kind: GroupKind::Family,
        creator,
        area_keys,
    };
    let entry = |roles: &[GroupRole]| organizer.entry(roles, 1, MemberStatus::Active);
    let (billing, members, data_admin) = (GroupRole::Billing, GroupRole::Members, GroupRole::DataAdmin);
    vec![
        // Roles out of order and a stale since-version: roster_first sets both.
        of(
            "first-roster",
            RosterMember { roles: vec![members, billing], since_version: 7, ..entry(&[]) },
            vec![key(AREA, AREA_KEY_SEED)],
        ),
        of("first-roster-no-areas", entry(&[billing, members]), vec![]),
        of(
            "first-roster-two-areas",
            entry(&[members]),
            vec![key(SECOND_AREA, 101), key(AREA, AREA_KEY_SEED)],
        ),
        FirstRosterCase {
            kind: GroupKind::Org,
            ..of("first-roster-org", entry(&[data_admin, members]), vec![key(AREA, AREA_KEY_SEED)])
        },
        of("first-roster-not-holder", entry(&[billing]), vec![key(AREA, AREA_KEY_SEED)]),
        of(
            "first-roster-left",
            organizer.entry(&[members], 1, MemberStatus::Left),
            vec![key(AREA, AREA_KEY_SEED)],
        ),
        of(
            "first-roster-same-key-twice",
            entry(&[members]),
            vec![key(AREA, AREA_KEY_SEED), key(SECOND_AREA, AREA_KEY_SEED)],
        ),
        of("first-roster-area-twice", entry(&[members]), vec![key(AREA, AREA_KEY_SEED), key(AREA, 78)]),
        of("first-roster-org-role-in-family", entry(&[data_admin, members]), vec![]),
        of("first-roster-short-key", entry(&[members]), vec![(AREA.to_string(), pattern(31, AREA_KEY_SEED))]),
        FirstRosterCase {
            group_id: GROUP.to_uppercase(),
            ..of("first-roster-uppercase-group-id", entry(&[members]), vec![])
        },
    ]
}

/* This twin's first roster for a case: its statement (base64url), or None when refused. */
pub fn first_roster_verdict(c: &FirstRosterCase) -> Option<String> {
    let area_keys = c
        .area_keys
        .iter()
        .map(|(workspace_id, key)| AreaKey {
            workspace_id: workspace_id.clone(),
            workspace_key: key.clone(),
            root_key: None,
        })
        .collect();
    roster_first(c.group_id.clone(), c.kind, c.creator.clone(), Some(area_keys), None)
        .and_then(roster_statement)
        .ok()
        .map(|statement| e(&statement))
}

pub fn first_roster_case_json(c: &FirstRosterCase, expected: &Option<String>) -> Value {
    json!({
        "name": c.name,
        "groupId": c.group_id,
        "kind": match c.kind { GroupKind::Family => "family", GroupKind::Org => "org" },
        "creator": member_json(&c.creator),
        "areaKeys": c.area_keys.iter().map(|(id, key)| json!({ "workspaceId": id, "workspaceKey": e(key) })).collect::<Vec<_>>(),
        "expected": expected,
    })
}

pub fn first_roster_case_from(v: &Value) -> (FirstRosterCase, Option<String>) {
    (
        FirstRosterCase {
            name: s(v, "name"),
            group_id: s(v, "groupId"),
            kind: if s(v, "kind") == "family" { GroupKind::Family } else { GroupKind::Org },
            creator: member_of(&v["creator"]),
            area_keys: v["areaKeys"]
                .as_array()
                .unwrap()
                .iter()
                .map(|k| (s(k, "workspaceId"), b(k, "workspaceKey")))
                .collect(),
        },
        v["expected"].as_str().map(String::from),
    )
}

/*
 * Own entries both twins must make alike, or refuse (roster_entry_own,
 * ownRosterEntry): only from an identity whose keys statement holds for the
 * account. The web's ownEntryCases, in order.
 */
pub struct OwnEntryCase {
    pub name: String,
    pub user_id: String,
    pub identity: PublicIdentity,
    pub roles: Vec<GroupRole>,
}

pub fn own_entry_cases() -> Vec<OwnEntryCase> {
    let (organizer, adult, adult2) = (person(1), person(2), person_at(2, 2));
    let of = |name: &str, user_id: &str, identity: PublicIdentity| OwnEntryCase {
        name: name.into(),
        user_id: user_id.into(),
        identity,
        roles: vec![GroupRole::Members, GroupRole::Billing],
    };
    vec![
        of("own-entry", &organizer.user_id, organizer.served.clone()),
        of("own-entry-later-identity", &adult2.user_id, adult2.served.clone()),
        of("own-entry-other-account", &adult.user_id, organizer.served.clone()),
        of(
            "own-entry-kem-swapped",
            &organizer.user_id,
            PublicIdentity {
                kem_public_key: adult.served.kem_public_key.clone(),
                ..organizer.served.clone()
            },
        ),
        of(
            "own-entry-another-keys-signature",
            &organizer.user_id,
            PublicIdentity {
                keys_signature: adult.served.keys_signature.clone(),
                ..organizer.served.clone()
            },
        ),
        // A key version the keys statement never named.
        of(
            "own-entry-key-version",
            &organizer.user_id,
            PublicIdentity { key_version: 2, ..organizer.served.clone() },
        ),
        // The adult's replaced identity: its keys statement still holds, so an entry is made; that it
        // is not their newest is the signer check's and the creating client's to catch.
        of("own-entry-earlier-identity", &adult.user_id, adult.served.clone()),
    ]
}

/* This twin's own entry for a case, as JSON, or null when refused. */
pub fn own_entry_verdict(c: &OwnEntryCase) -> Value {
    roster_entry_own(c.user_id.clone(), c.identity.clone(), c.roles.clone())
        .map(|entry| member_json(&entry))
        .unwrap_or(Value::Null)
}

pub fn own_entry_case_json(c: &OwnEntryCase, expected: &Value) -> Value {
    json!({
        "name": c.name,
        "userId": c.user_id,
        "identity": served_identity_json(&c.identity),
        "roles": c.roles.iter().map(|r| role_name(*r)).collect::<Vec<_>>(),
        "expected": expected,
    })
}

pub fn own_entry_case_from(v: &Value) -> (OwnEntryCase, Value) {
    (
        OwnEntryCase {
            name: s(v, "name"),
            user_id: s(v, "userId"),
            identity: served_identity_of(&v["identity"]),
            roles: v["roles"].as_array().unwrap().iter().map(|r| role_of(r.as_str().unwrap())).collect(),
        },
        v["expected"].clone(),
    )
}
