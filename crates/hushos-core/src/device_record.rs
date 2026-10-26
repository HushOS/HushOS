//! What a device keeps of a family, and the pins it writes from it
//! (docs/groups-design.md 2.4 and 2.7), the twin of the web worker's device
//! store and acceptance (`packages/crypto/src/session-groups.ts`: the device
//! store, `marksOf`, `accept`), the order the web's data layer accepts in
//! (`packages/crypto/src/record-acceptance.ts`), and the settings pin's merge
//! (`packages/crypto/src/pins.ts`: `mergePin`, `pinAhead`):
//!
//! - every record is sealed under a key derived from the account root
//!   (HKDF-SHA-256, salt 32 zero bytes, info `hushos/group/device-store/v1`)
//!   with XChaCha20-Poly1305, bound by its associated data
//!   `["hushos/group/device-store",1,userId,groupId,store]` to the account,
//!   the family and the store it is kept in: membership is the social graph,
//!   so none of it sits on disk in the clear, and a master-key rotation makes
//!   it unreadable. The key is derived and held by [`AreaLedger::open_account`]
//!   ([`AreaLedger::group_device_record_seal`], [`AreaLedger::group_device_record_open`]);
//! - the chain record (`chains`: the cache and this device's own pin, as JSON
//!   `{"v":1,"cache":…,"pin":…}` with the cache exactly as the web writes it,
//!   `cacheVersion` 2 with `areaRoots` and `retiredAreas`) is sealed and
//!   opened only by [`AreaLedger::accept_served`], from a committed
//!   acceptance, as the worker keeps it;
//! - [`AreaLedger::accept_served`] accepts a served chain continuing the
//!   record's cache; refused, from version 1 with the cache, then from version
//!   1 with the cache left out and the record's own pin kept as a mark beside
//!   the settings pin ([`AreaLedger::use_settings_envelope`]), never against the settings
//!   pin alone (a server can serve older settings); the highest chain this
//!   session committed for the family (its floor, which a refusal never
//!   drops) is a mark too, and a run another acceptance overtook is
//!   [`ServedAcceptance::Overtaken`] with nothing kept;
//! - [`merge_pin`] and [`pin_ahead`] decide what an accepted pin may be saved
//!   over in settings: never lower, conflicts never saved. The opened areas
//!   folded in are [`OpenedArea`]s, which only [`AreaLedger::open_area`] makes;
//!   `current` and `next` are records an app can fill, so a forged area there
//!   only raises an area's mark (the next acceptance then needs that key
//!   version), which is the limit of what the type guards.
//!
//! The shared fixtures (`deviceRecords` and `mergePins` in both area-ledger
//! fixture files) hold the twins to each other in both directions, and the
//! fuzz kind `device_record` in `pins` compares how they read any record.

use crate::area_ledger::{
    AreaLedger, ServedAccount, NOT_THIS_ACCOUNT, NOT_THIS_FAMILYS, NO_ACCOUNT, OLDER_CHAIN, OPEN_SETTINGS,
    SPLIT_CHAIN,
};
use crate::bytes::{decode, encode, random, KEY_BYTES, NONCE_BYTES, TAG_BYTES};
use crate::canonical::{bytes_of, encode_statement, uuid};
use crate::envelope::{open_with_nonce, seal_with_nonce};
use crate::error::{input, CoreError, CoreResult};
use crate::group_trust::{
    accept_rosters_joining, check_time, group_pin_check, pin_after, AcceptedRosters, CachedSuccession,
    ForkOf, GroupAnchor, GroupChainCache, GroupPin, JoinMark, KeySet, MarkSide, MarkSource, OwnIdentities,
    PairMark, RosterChain,
};
use crate::groups::{parse_roster, GroupPublicKey, SignedGroupStatement};
use hkdf::Hkdf;
use serde_json::{json, Map, Value};
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::Arc;
use zeroize::Zeroizing;

const STORE_INFO: &[u8] = b"hushos/group/device-store/v1";
const STORE_DOMAIN: &str = "hushos/group/device-store";
const STORE_VERSION: u8 = 1;
/// A device store record that did not open: another account root (a master-key rotation), another
/// account, family or store, or damaged bytes.
pub const RECORD_UNREADABLE: &str = "This saved family record could not be opened on this account.";
pub(crate) const BAD_CACHE: &str = "Invalid member list cache.";
/* `me` does not hold the unlocked account's signing key: the worker's identity is not open. */
pub(crate) const OPEN_IDENTITY: &str = "Open your identity first.";
const BAD_PIN: &str = "Invalid group pin.";

/// Which of the app's own device stores a record is kept in: part of its associated data, so a
/// record never opens as another store's. The chain record (`chains`) is the core's alone
/// ([`AreaLedger::accept_served`] seals and opens it), and so are a join's records (`joins`, the
/// compared code, and `holds`, its escalation; [`crate::AreaLedger::join_check`]): an app that
/// could seal a joins record could commit a family nobody compared.
#[cfg(feature = "fixtures")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceStore {
    /// The roster calls still to send: sealed and read only by the core since Core 5a
    /// ([`crate::StagedCall`], [`AreaLedger::outbox_open`]).
    Outbox,
}

#[cfg(feature = "fixtures")]
impl DeviceStore {
    fn name(self) -> &'static str {
        match self {
            DeviceStore::Outbox => "outbox",
        }
    }
}

/// Any JSON sealed in any device store (the core's own included). For the
/// shared fixtures and the fuzz targets only: a joins record of an app's
/// making, or another family's, which the core must refuse.
#[cfg(feature = "fixtures")]
#[doc(hidden)]
pub fn device_store_seal_value(
    account_key: &[u8],
    user_id: &str,
    group_id: &str,
    store: &str,
    value: &Value,
) -> CoreResult<String> {
    let plaintext = Zeroizing::new(value.to_string().into_bytes());
    seal_bytes(&*store_key(account_key)?, user_id, group_id, store, &plaintext)
}

/// Any device store record's JSON (the core's own stores included), or none
/// when it does not open. For the shared fixtures only, beside
/// [`chain_record_open_value`].
#[cfg(feature = "fixtures")]
#[doc(hidden)]
pub fn device_store_open_value(
    account_key: &[u8],
    user_id: &str,
    group_id: &str,
    store: &str,
    envelope: &str,
) -> Option<Value> {
    let plaintext = open_bytes(&*store_key(account_key).ok()?, user_id, group_id, store, envelope).ok()?;
    serde_json::from_slice(&plaintext).ok()
}

const CHAINS: &str = "chains";

/* The device store key from the account root; a root of another length is an input error, never "unreadable". */
pub(crate) fn store_key(account_key: &[u8]) -> CoreResult<Zeroizing<[u8; KEY_BYTES]>> {
    if account_key.len() != KEY_BYTES {
        return Err(input("The account key must be 32 bytes."));
    }
    let mut key = Zeroizing::new([0u8; KEY_BYTES]);
    Hkdf::<Sha256>::new(Some(&[0u8; 32]), account_key)
        .expand(STORE_INFO, key.as_mut())
        .map_err(|_| input("HKDF failed"))?;
    Ok(key)
}

fn store_context(user_id: &str, group_id: &str, store: &str) -> CoreResult<Vec<u8>> {
    encode_statement(&[
        json!(STORE_DOMAIN),
        json!(STORE_VERSION),
        json!(uuid(user_id, "user id")?),
        json!(uuid(group_id, "group id")?),
        json!(store),
    ])
}

/* Bytes sealed in the device store: base64url of [version][24-byte nonce][XChaCha20-Poly1305 of the bytes]. */
pub(crate) fn seal_bytes(
    key: &[u8; KEY_BYTES],
    user_id: &str,
    group_id: &str,
    store: &str,
    plaintext: &[u8],
) -> CoreResult<String> {
    let context = store_context(user_id, group_id, store)?;
    let nonce = random(NONCE_BYTES);
    let sealed = seal_with_nonce(key.as_slice(), &nonce, plaintext, &context)?;
    let mut out = Vec::with_capacity(1 + NONCE_BYTES + sealed.len());
    out.push(STORE_VERSION);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(encode(&out))
}

/* The bytes a device store envelope holds, wiped when dropped. */
/* Refused as `Sealed` (unreadable: the app deletes it) only for the envelope; bad ids are `Input`. */
pub(crate) fn open_bytes(
    key: &[u8; KEY_BYTES],
    user_id: &str,
    group_id: &str,
    store: &str,
    envelope: &str,
) -> CoreResult<Zeroizing<Vec<u8>>> {
    let context = store_context(user_id, group_id, store)?;
    let unreadable = || CoreError::Sealed(RECORD_UNREADABLE.into());
    let bytes = decode("record", envelope, None).map_err(|_| unreadable())?;
    if bytes.len() < 1 + NONCE_BYTES + TAG_BYTES || bytes[0] != STORE_VERSION {
        return Err(unreadable());
    }
    open_with_nonce(key.as_slice(), &bytes[1..1 + NONCE_BYTES], &bytes[1 + NONCE_BYTES..], &context)
        .map(Zeroizing::new)
        .map_err(|_| unreadable())
}

/* The chain record ------------------------------------------------------- */

/* A JSON number a u64 holds exactly: `1`, `1.0` and `1e0` alike, as JSON.parse reads them. */
fn unsigned(value: &Value) -> Option<u64> {
    if let Some(n) = value.as_u64() {
        return Some(n);
    }
    let f = value.as_f64()?;
    (f.fract() == 0.0 && (0.0..18_446_744_073_709_551_616.0).contains(&f)).then_some(f as u64)
}

/* What JavaScript reads as false: how the worker tells "no cache" (`record.cache ?? null`, then `cache ?`). */
fn falsy(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Bool(b) => !b,
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::String(s) => s.is_empty(),
        _ => false,
    }
}

fn text(value: Option<&Value>) -> Result<String, ()> {
    value.and_then(Value::as_str).map(str::to_string).ok_or(())
}

fn object(value: Option<&Value>) -> Result<&Map<String, Value>, ()> {
    value.and_then(Value::as_object).ok_or(())
}

fn list(value: Option<&Value>) -> Result<&Vec<Value>, ()> {
    value.and_then(Value::as_array).ok_or(())
}

fn strings(value: Option<&Value>) -> Result<Vec<String>, ()> {
    list(value)?.iter().map(|at| text(Some(at))).collect()
}

/// The cache as the web writes it (`JSON.stringify` of the worker's `GroupChainCache`).
pub(crate) fn cache_json(cache: &GroupChainCache) -> Value {
    let key_history: Map<String, Value> = cache
        .key_history
        .iter()
        .map(|(user, sets)| {
            let sets: Vec<Value> = sets
                .iter()
                .map(|set| {
                    json!({
                        "encryptionPublicKey": set.encryption_public_key,
                        "signingPublicKey": set.signing_public_key,
                        "mlDsaPublicKeyDigest": set.ml_dsa_public_key_digest,
                    })
                })
                .collect();
            (user.clone(), Value::Array(sets))
        })
        .collect();
    json!({
        "groupId": cache.group_id,
        "rosterDigests": cache.roster_digests,
        "statement": cache.statement,
        "droppedHolder": cache.dropped_holder,
        "groupKeys": cache.group_keys.iter().map(|k| json!({ "ed25519PublicKey": k.ed25519_public_key, "mlDsaPublicKey": k.ml_dsa_public_key })).collect::<Vec<_>>(),
        "successions": cache.successions.iter().map(|s| json!({ "lastRosterVersion": s.last_roster_version, "digest": s.digest, "signerUserId": s.signer_user_id })).collect::<Vec<_>>(),
        "creatorUserId": cache.creator_user_id,
        "keyHistory": key_history,
        "areaKeys": cache.area_keys,
        "areaRoots": cache.area_roots,
        "retiredAreas": cache.retired_areas,
        "cacheVersion": cache.cache_version,
        "ownEntryWrongAt": cache.own_entry_wrong_at,
    })
}

/*
 * A cache as the record holds it, or `Err` for one the worker's checkCache
 * refuses at a point the typed cache cannot express: not a plain object, an
 * `origin` (only the server's record has one), a field of the wrong JSON
 * kind, `areaRoots` or `retiredAreas` present but not an object or a list
 * (null included), or a version 2 cache without them. Everything else is
 * held, and acceptance's own cache check (check_cache, the twin of the rest
 * of checkCache) decides.
 */
pub(crate) fn cache_of(value: &Value) -> Result<GroupChainCache, ()> {
    let cache = value.as_object().ok_or(())?;
    if cache.contains_key("origin") {
        return Err(());
    }
    let key_set = |set: &Value| -> Result<KeySet, ()> {
        let set = set.as_object().ok_or(())?;
        Ok(KeySet {
            encryption_public_key: text(set.get("encryptionPublicKey"))?,
            signing_public_key: text(set.get("signingPublicKey"))?,
            ml_dsa_public_key_digest: text(set.get("mlDsaPublicKeyDigest"))?,
        })
    };
    let cache_version = match cache.get("cacheVersion") {
        None | Some(Value::Null) => 1,
        Some(version) => unsigned(version).and_then(|v| u8::try_from(v).ok()).ok_or(())?,
    };
    let area_roots = match cache.get("areaRoots") {
        None => None,
        Some(roots) => Some(
            roots
                .as_object()
                .ok_or(())?
                .iter()
                .map(|(id, roots)| {
                    let roots = list(Some(roots))?
                        .iter()
                        .map(|at| if at.is_null() { Ok(None) } else { text(Some(at)).map(Some) })
                        .collect::<Result<Vec<_>, ()>>()?;
                    Ok((id.clone(), roots))
                })
                .collect::<Result<HashMap<_, _>, ()>>()?,
        ),
    };
    let retired_areas = match cache.get("retiredAreas") {
        None => None,
        Some(retired) => Some(strings(Some(retired))?),
    };
    if cache_version != 1 && (area_roots.is_none() || retired_areas.is_none()) {
        return Err(());
    }
    Ok(GroupChainCache {
        group_id: text(cache.get("groupId"))?,
        roster_digests: strings(cache.get("rosterDigests"))?,
        statement: text(cache.get("statement"))?,
        dropped_holder: cache.get("droppedHolder").and_then(Value::as_bool).ok_or(())?,
        group_keys: list(cache.get("groupKeys"))?
            .iter()
            .map(|key| {
                let key = key.as_object().ok_or(())?;
                Ok(GroupPublicKey {
                    ed25519_public_key: text(key.get("ed25519PublicKey"))?,
                    ml_dsa_public_key: text(key.get("mlDsaPublicKey"))?,
                })
            })
            .collect::<Result<_, ()>>()?,
        successions: list(cache.get("successions"))?
            .iter()
            .map(|at| {
                let at = at.as_object().ok_or(())?;
                Ok(CachedSuccession {
                    last_roster_version: at.get("lastRosterVersion").and_then(unsigned).ok_or(())?,
                    digest: text(at.get("digest"))?,
                    signer_user_id: text(at.get("signerUserId"))?,
                })
            })
            .collect::<Result<_, ()>>()?,
        creator_user_id: text(cache.get("creatorUserId"))?,
        key_history: object(cache.get("keyHistory"))?
            .iter()
            .map(|(user, sets)| {
                Ok((user.clone(), list(Some(sets))?.iter().map(key_set).collect::<Result<_, ()>>()?))
            })
            .collect::<Result<_, ()>>()?,
        area_keys: object(cache.get("areaKeys"))?
            .iter()
            .map(|(id, commitments)| Ok((id.clone(), strings(Some(commitments))?)))
            .collect::<Result<_, ()>>()?,
        area_roots: area_roots.unwrap_or_default(),
        retired_areas: retired_areas.unwrap_or_default(),
        cache_version,
        own_entry_wrong_at: list(cache.get("ownEntryWrongAt"))?
            .iter()
            .map(|at| unsigned(at).ok_or(()))
            .collect::<Result<_, ()>>()?,
    })
}

/// A group pin as the settings document and the chain record hold it (the web's `GroupPin`).
pub(crate) fn pin_json(pin: &GroupPin) -> Value {
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

/*
 * A pin as a record holds it, checked as the worker's checkGroupPin checks the
 * raw JSON, field by field in its order, so a refusal says what the web's
 * says: the check time and the areas' shape ("Invalid group pin."), every
 * area id, every area version, then the keys and versions, each named.
 */
pub(crate) fn pin_of(group_id: &str, value: &Value) -> CoreResult<GroupPin> {
    let bad_pin = || input(BAD_PIN);
    let pin = value.as_object().ok_or_else(bad_pin)?;
    let checked_at = pin.get("checkedAt").and_then(Value::as_str).ok_or_else(bad_pin)?;
    check_time(checked_at)?;
    let areas = pin.get("areas").and_then(Value::as_object).ok_or_else(bad_pin)?;
    let invalid = |what: &str| input(format!("Invalid {what}."));
    let integer = |value: Option<&Value>, what: &str| {
        value.and_then(unsigned).filter(|n| (1..=MAX_SAFE_INTEGER).contains(n)).ok_or_else(|| invalid(what))
    };
    let bytes = |value: Option<&Value>, length: usize, what: &str| -> CoreResult<String> {
        let text = value.and_then(Value::as_str).ok_or_else(|| invalid(what))?;
        bytes_of(text, length, what)?;
        Ok(text.to_string())
    };
    for workspace_id in areas.keys() {
        uuid(workspace_id, "workspace id")?;
    }
    let areas = areas
        .iter()
        .map(|(id, version)| Ok((id.clone(), integer(Some(version), "workspace key version")?)))
        .collect::<CoreResult<_>>()?;
    let pin = GroupPin {
        first_ed25519_public_key: bytes(pin.get("firstEd25519PublicKey"), 32, "group key")?,
        first_ml_dsa_public_key_digest: bytes(pin.get("firstMlDsaPublicKeyDigest"), 32, "key digest")?,
        checked_at: checked_at.to_string(),
        key_version: integer(pin.get("keyVersion"), "group key version")?,
        group_key_digest: bytes(pin.get("groupKeyDigest"), 32, "key digest")?,
        roster_version: integer(pin.get("rosterVersion"), "roster version")?,
        roster_digest: bytes(pin.get("rosterDigest"), 32, "roster digest")?,
        areas,
    };
    group_pin_check(group_id.into(), pin)
}

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/* The record's cache as the worker reads it: none, one to continue from, or one acceptance refuses. */
#[derive(Debug, Clone)]
pub(crate) enum RecordCache {
    None,
    Held(Box<GroupChainCache>),
    /* What the damaged cache's `rosterDigests` counts, if a list: all the worker reads of it before refusing. */
    Refused { head: u64 },
}

/* An opened chain record: its cache, and its pin (`Err`, with the web's words, for one acceptance refuses). */
#[derive(Debug, Clone)]
pub(crate) struct ChainRecord {
    pub(crate) cache: RecordCache,
    pub(crate) pin: CoreResult<Option<GroupPin>>,
}

/*
 * The chain record, or none when it does not open or is not version 1 (the
 * worker's `record-unreadable`): sealed under another account root, another
 * account's, family's or store's, damaged, not JSON, or not `{"v":1,…}`.
 */
pub(crate) fn chain_record_open(
    key: &[u8; KEY_BYTES],
    user_id: &str,
    group_id: &str,
    envelope: &str,
) -> CoreResult<Option<ChainRecord>> {
    let plaintext = match open_bytes(key, user_id, group_id, CHAINS, envelope) {
        Ok(plaintext) => plaintext,
        Err(CoreError::Sealed(_)) => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(serde_json::from_slice::<Value>(&plaintext)
        .ok()
        .as_ref()
        .and_then(|value| chain_record_read(group_id, value)))
}

/* What the worker's marksOf takes from a record's JSON (`value?.v !== 1`, `cache ?? null`, `pin ?? null`). */
pub(crate) fn chain_record_read(group_id: &str, value: &Value) -> Option<ChainRecord> {
    let record = value.as_object()?;
    if record.get("v").and_then(unsigned) != Some(1) {
        return None;
    }
    let cache = match record.get("cache") {
        None => RecordCache::None,
        Some(cache) if falsy(cache) => RecordCache::None,
        Some(cache) => match cache_of(cache) {
            Ok(held) => RecordCache::Held(Box::new(held)),
            Err(()) => RecordCache::Refused {
                head: cache
                    .get("rosterDigests")
                    .and_then(Value::as_array)
                    .map_or(0, |list| list.len() as u64),
            },
        },
    };
    let pin = match record.get("pin") {
        None | Some(Value::Null) => Ok(None),
        Some(pin) => pin_of(group_id, pin).map(Some),
    };
    Some(ChainRecord { cache, pin })
}

/* The chain record a committed acceptance leaves: its cache and the pin after it. */
pub(crate) fn chain_record_seal(
    key: &[u8; KEY_BYTES],
    user_id: &str,
    group_id: &str,
    cache: &GroupChainCache,
    pin: &GroupPin,
) -> CoreResult<String> {
    let value = json!({ "v": 1, "cache": cache_json(cache), "pin": pin_json(pin) });
    let plaintext = Zeroizing::new(value.to_string().into_bytes());
    seal_bytes(key, user_id, group_id, CHAINS, &plaintext)
}

/// Seals any JSON as a chain record. For the shared fixtures and the fuzz
/// target only (a damaged cache, a newer `cacheVersion`); apps never write a
/// chain record: [`AreaLedger::accept_served`] does.
#[doc(hidden)]
pub fn chain_record_seal_value(
    account_key: &[u8],
    user_id: &str,
    group_id: &str,
    value: &Value,
) -> CoreResult<String> {
    let plaintext = Zeroizing::new(value.to_string().into_bytes());
    seal_bytes(&*store_key(account_key)?, user_id, group_id, CHAINS, &plaintext)
}

/// A chain record's JSON, or none when it does not open. For the shared
/// fixtures and the fuzz target only, beside [`chain_record_seal_value`].
#[doc(hidden)]
pub fn chain_record_open_value(
    account_key: &[u8],
    user_id: &str,
    group_id: &str,
    envelope: &str,
) -> Option<Value> {
    let plaintext = open_bytes(&*store_key(account_key).ok()?, user_id, group_id, CHAINS, envelope).ok()?;
    serde_json::from_slice(&plaintext).ok()
}

/* Accepting what the server served ------------------------------------------ */

/// What route 5 served for a family: the rosters after `after` (0 for the
/// whole chain from version 1, the record's roster version to continue its
/// cache), the successions and first keys of the last page, and every
/// signer's ML-DSA key by its SHA-256.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ServedChain {
    pub after: u64,
    pub first_keys: GroupPublicKey,
    pub rosters: Vec<SignedGroupStatement>,
    pub successions: Vec<SignedGroupStatement>,
    pub signer_keys: HashMap<String, String>,
}

/// What [`AreaLedger::accept_served`] found.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ServedAcceptance {
    /// Committed on the ledger: keep `record` (beside the chain's roster
    /// version, which says where the next fetch continues; never over a stored
    /// record at a later version) and settle `pin` into settings ([`merge_pin`],
    /// [`pin_ahead`]). `pin` is the only pin an app may pass `merge_pin` as `next`.
    Accepted { chain: Arc<AcceptedRosters>, record: String, pin: GroupPin },
    /// The person's marks disagree with each other or with the chain served:
    /// the hard warning. Nothing is kept and the family's folders are not
    /// written.
    Fork { of: ForkOf, version: u64, sides: Vec<MarkSide> },
    /// The record did not open (a master-key rotation): delete it and accept
    /// again without it, against the settings pin.
    RecordUnreadable,
    /// The served rosters did not continue the record's cache: fetch route 5
    /// from version 1 (`after` 0) and call again **with the same record**.
    FetchFromVersionOne,
    /// Served from version 1 short of the chain this session already committed
    /// for the family (`split` false), or another chain at its version (`split`
    /// true): a run a later acceptance overtook, or a server rolling back.
    /// Nothing was kept, and writes go on under the chain held. Read the record
    /// and settings again and call again; after three, show
    /// [`served_race_message`].
    Overtaken { split: bool },
}

/// This device's family guard (docs/optional-verification.md 2.8), as the
/// app's own store held it when it was read: kept apart from the chain record,
/// never cleared by a `not-member` wipe nor by anything the server answers.
/// It holds the pin of the first acceptance that kept the family on this
/// device ([`ServedAcceptance::Accepted`]'s `pin`, stored when none is held),
/// and acceptance takes it as a mark like any pin, so a family that once was
/// here is never taken on first use again.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum FamilyGuard {
    /// Nothing stored for this family on this device.
    Absent,
    /// The store could not be read (unavailable, a read error, a corrupt
    /// entry): never first use, and nothing is accepted on it
    /// ([`GUARD_UNREADABLE`]).
    Unreadable,
    Held {
        pin: GroupPin,
    },
}

/// A family guard that could not be read: the words to show, with Try again.
pub const GUARD_UNREADABLE: &str = "HushOS couldn’t check this right now.";

impl FamilyGuard {
    /* The guard's pin, a mark; refused before anything else when it could not be read. */
    pub(crate) fn pin(&self) -> CoreResult<Option<&GroupPin>> {
        match self {
            FamilyGuard::Absent => Ok(None),
            FamilyGuard::Unreadable => Err(input(GUARD_UNREADABLE)),
            FamilyGuard::Held { pin } => Ok(Some(pin)),
        }
    }
}

/* The roster a first use's joins record holds: the chain must pass through it. */
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FirstUseMark {
    pub(crate) roster_version: u64,
    pub(crate) roster_digest: String,
}

/* How a run joins: not at all (a sync), with a compared join code, or on first use through a record's roster. */
#[derive(Clone, Copy)]
pub(crate) enum JoinWith<'a> {
    None,
    Code(&'a JoinMark),
    FirstUse(&'a FirstUseMark),
}

/*
 * An accepted chain held against a first use's joins record (the worker's throughFirstUse): short
 * of its roster, a rollback (refused); another roster there, the fork, with the record's side
 * `Join` and the served one named by its signer when it is the head.
 */
pub(crate) fn through_first_use(
    chain: &AcceptedRosters,
    at: &FirstUseMark,
) -> CoreResult<Option<(u64, Vec<MarkSide>)>> {
    if (chain.roster_digests.len() as u64) < at.roster_version {
        return Err(input("This is an older member list than this device has seen."));
    }
    let digest = &chain.roster_digests[(at.roster_version - 1) as usize];
    if *digest == at.roster_digest {
        return Ok(None);
    }
    let mut sides = vec![
        MarkSide { digest: at.roster_digest.clone(), from: vec![MarkSource::Join], signer_user_id: None },
        MarkSide {
            digest: digest.clone(),
            from: vec![MarkSource::Served],
            signer_user_id: (*digest == chain.roster_digest).then(|| chain.roster.signer_user_id.clone()),
        },
    ];
    sides.sort_by(|x, y| x.digest.cmp(&y.digest));
    Ok(Some((at.roster_version, sides)))
}

/* What the web's sync says after three overtaken runs (sync.ts, SERVED_OLDER and SERVED_SPLIT). */
const SERVED_OLDER: &str =
    "HushOS sent an older member list than this device already checked. Try again later.";
const SERVED_SPLIT: &str =
    "HushOS sent a different member list at the version this device already checked. Try again later.";

/// What to tell the person after three runs that each came back
/// [`ServedAcceptance::Overtaken`]: it is no race, the server keeps serving an
/// older member list than this device checked (`split` false) or another one
/// at its version (`split` true). The web's sync says the same words.
///
/// ```
/// assert!(hushos_core::served_race_message(true).contains("different member list"));
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn served_race_message(split: bool) -> String {
    if split { SERVED_SPLIT } else { SERVED_OLDER }.to_string()
}

/*
 * A refusal because the account or session changed, or because no account or
 * settings are open: nothing served is in question, so it goes straight to the
 * app (the web's `accountError`), never as a reason to fetch again.
 */
pub(crate) fn account_error(error: &CoreError) -> bool {
    matches!(error, CoreError::Input(message)
        if message == NOT_THIS_ACCOUNT || message == NO_ACCOUNT || message == OPEN_SETTINGS || message == OPEN_IDENTITY)
}

/* Whether a refusal is a run another acceptance overtook. */
pub(crate) fn lost_race(error: &CoreError) -> bool {
    matches!(error, CoreError::Input(message) if message == OLDER_CHAIN || message == SPLIT_CHAIN)
}

pub(crate) fn overtaken(error: &CoreError) -> ServedAcceptance {
    ServedAcceptance::Overtaken {
        split: matches!(error, CoreError::Input(message) if message == SPLIT_CHAIN),
    }
}

/*
 * The latest roster version what was served reaches (the worker's
 * servedHead): the highest a served roster claims, or the record's cache when
 * nothing after it was served. Only a lower bound; acceptance verifies the rest.
 */
fn served_head(served: &ServedChain, cache: &RecordCache) -> u64 {
    let mut head = match cache {
        RecordCache::None => 0,
        RecordCache::Held(cache) => cache.roster_digests.len() as u64,
        RecordCache::Refused { head } => *head,
    };
    for roster in &served.rosters {
        if let Ok(roster) = parse_roster(&roster.statement) {
            head = head.max(roster.roster_version);
        }
    }
    head
}

/* The account an acceptance runs for, as the ledger held it when the acceptance began. */
pub(crate) struct Reader<'a> {
    pub(crate) account: &'a ServedAccount,
    pub(crate) me: &'a OwnIdentities,
    pub(crate) group_id: &'a str,
    pub(crate) checked_at: &'a str,
    /* The family guard's pin, a mark beside the person's pins. */
    pub(crate) guard: Option<&'a GroupPin>,
    /* The family's check record: whether there is one, and its pair mark (refused when it is not one). */
    pub(crate) check: &'a CoreResult<(bool, Vec<PairMark>)>,
}

impl AreaLedger {
    /*
     * One run of the worker's `accept`: the family's floor (the highest chain
     * committed this session) a mark and a floor, the person's pins (settings
     * and the record's), the cache given, then commit (under the account the
     * run began with, never below or beside the floor), the pin after, and the
     * record sealed. A refusal uncommits the family (keeping a fork a fork) but
     * never its floor, unless the attempt is `retried` (the ladder tries again:
     * the family stays committed under the chain held until the last attempt's
     * refusal, the worker's `retried`); a fork uncommits it as one. A run
     * another overtook is `Err(OLDER_CHAIN | SPLIT_CHAIN)`.
     */
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn accept_once(
        &self,
        reader: &Reader<'_>,
        served: &ServedChain,
        cache: &RecordCache,
        settings_pin: &CoreResult<Option<GroupPin>>,
        record_pin: &CoreResult<Option<GroupPin>>,
        join: JoinWith<'_>,
        retried: bool,
    ) -> CoreResult<ServedAcceptance> {
        let group_id = reader.group_id;
        let floor = self.floor(group_id);
        if let Some(floor) = &floor {
            if served_head(served, cache) < floor.roster.roster_version {
                return Err(input(OLDER_CHAIN));
            }
        }
        let session_pin = match &floor {
            Some(floor) => Some(pin_after(vec![], Arc::clone(floor), reader.checked_at.into())?),
            None => None,
        };
        let generation = reader.account.generation;
        // A refusal uncommits the family, but only under the session the run began in.
        let refuse = |error: CoreError| {
            if retried {
                self.still_the_session(generation)?;
            } else {
                self.uncommit_served(group_id, generation, None)?;
            }
            Err(error)
        };
        // The person's pins in the worker's order (settings, then the record's), then the cache.
        // The settings pin as checked when read (pin_of, or group_pin_check for a typed one).
        let settings_pin = match settings_pin {
            Ok(pin) => pin.clone(),
            Err(error) => return refuse(error.clone()),
        };
        let record_pin = match record_pin {
            Ok(pin) => pin.clone(),
            Err(error) => return refuse(error.clone()),
        };
        let pins: Vec<GroupPin> =
            settings_pin.into_iter().chain(record_pin).chain(reader.guard.cloned()).collect();
        let pins = pins.as_slice();
        let cache = match cache {
            RecordCache::None => None,
            RecordCache::Held(cache) => Some((**cache).clone()),
            RecordCache::Refused { .. } => return refuse(input(BAD_CACHE)),
        };
        let (checked, pair_marks) = match reader.check {
            Ok(check) => check.clone(),
            Err(error) => return refuse(error.clone()),
        };
        // A join vouches for the first keys only where nothing marks the family (the worker's
        // accept): through its join mark, or on first use through nothing, the head admitting this
        // account. With marks (a rejoin, which keeps the settings pin and the guard) they decide,
        // and the join mark adds to them. A family check is a mark too.
        let marked = !pins.is_empty() || cache.is_some() || checked || self.holds_family(group_id);
        let anchor = match join {
            JoinWith::Code(_) if !marked => Some(GroupAnchor::Join),
            JoinWith::FirstUse(_) if !marked => Some(GroupAnchor::FirstUse),
            _ => None,
        };
        let join_mark = match join {
            JoinWith::Code(mark) => Some(mark.clone()),
            _ => None,
        };
        let mut marks = pins.to_vec();
        marks.extend(session_pin);
        let accepted = accept_rosters_joining(
            group_id.into(),
            served.first_keys.clone(),
            anchor,
            marks,
            served.rosters.clone(),
            served.successions.clone(),
            served.signer_keys.clone(),
            reader.me.clone(),
            cache,
            join_mark,
            pair_marks,
        );
        // A first use passes through the roster its joins record holds, or is refused or the fork.
        let accepted = match (accepted, join) {
            (Ok(RosterChain::Accepted { chain }), JoinWith::FirstUse(mark)) => {
                match through_first_use(&chain, mark) {
                    Err(error) => Err(error),
                    Ok(Some((version, sides))) => {
                        Ok(RosterChain::Fork { of: ForkOf::Roster, version, sides })
                    }
                    Ok(None) => Ok(RosterChain::Accepted { chain }),
                }
            }
            (other, _) => other,
        };
        match accepted {
            Err(error) => refuse(error),
            Ok(RosterChain::Fork { of, version, sides }) => {
                self.uncommit_served(group_id, generation, Some(true))?;
                Ok(ServedAcceptance::Fork { of, version, sides })
            }
            Ok(RosterChain::Accepted { chain }) => {
                let store_key = self.commit_served(Arc::clone(&chain), generation)?;
                let pin = pin_after(pins.to_vec(), Arc::clone(&chain), reader.checked_at.into())?;
                let record =
                    chain_record_seal(&store_key, &reader.account.user_id, group_id, &chain.cache(), &pin)?;
                Ok(ServedAcceptance::Accepted { chain, record, pin })
            }
        }
    }

    /*
     * The attempts in their order (the web's acceptFromRecord): the
     * continuation, then from version 1 with the cache, then without it. A
     * changed session or account goes straight back, never as a reason to
     * fetch again; a race on the continuation fetches from version 1 once.
     */
    fn accept_in_order(
        &self,
        reader: &Reader<'_>,
        served: &ServedChain,
        cache: &RecordCache,
        settings_pin: &CoreResult<Option<GroupPin>>,
        record_pin: &CoreResult<Option<GroupPin>>,
        has_record: bool,
    ) -> CoreResult<ServedAcceptance> {
        // With a record a refusal here is always tried again (FetchFromVersionOne, or below).
        match self.accept_once(reader, served, cache, settings_pin, record_pin, JoinWith::None, has_record) {
            Ok(outcome) => return Ok(outcome),
            // A lock or another account meanwhile: the caller's, never a reason to fetch again.
            Err(error) if account_error(&error) => return Err(error),
            // The continuation, refused or overtaken: once more from version 1 with the same record.
            Err(_) if served.after > 0 => return Ok(ServedAcceptance::FetchFromVersionOne),
            Err(error) if lost_race(&error) => return Ok(overtaken(&error)),
            Err(error) if !has_record => return Err(error),
            Err(_) => {}
        }
        // From version 1 with the cache left out: the record's pin is still a mark.
        match self.accept_once(
            reader,
            served,
            &RecordCache::None,
            settings_pin,
            record_pin,
            JoinWith::None,
            false,
        ) {
            Err(error) if lost_race(&error) => Ok(overtaken(&error)),
            other => other,
        }
    }

    /* The unlocked account, or refused before anything is read or sealed. */
    fn account_for_records(&self) -> CoreResult<ServedAccount> {
        self.served_account().ok_or_else(|| input(NO_ACCOUNT))
    }

    /*
     * The person's marks for a family, as the worker's marksOf reads them: the
     * unlocked account (refused unless `me` is it), this device's chain record
     * opened, then the settings pin (refused before settings are open). `None`:
     * the record did not open, the answer even before settings are open.
     */
    pub(crate) fn open_marks(
        &self,
        me: &OwnIdentities,
        group_id: &str,
        record: Option<String>,
    ) -> CoreResult<Option<Marks>> {
        let account = self.account_for_records()?;
        // The worker's order: another account than the one unlocked first, then the record, then
        // the settings, then the identity it opened.
        if !me.user_id.eq_ignore_ascii_case(&account.user_id) {
            return Err(input(NO_ACCOUNT));
        }
        let record = match record {
            None => None,
            Some(envelope) => {
                match chain_record_open(&account.store_key, &account.user_id, group_id, &envelope)? {
                    None => return Ok(None),
                    Some(opened) => Some(opened),
                }
            }
        };
        let settings_pin = self.settings_pin(&account.user_id, group_id)?;
        let check = self.family_check(&account.user_id, group_id)?;
        let own_key = encode(&account.signing_public_key);
        if !me.identities.iter().any(|keys| keys.signing_public_key == own_key) {
            return Err(input(OPEN_IDENTITY));
        }
        Ok(Some(Marks { account, record, settings_pin, check }))
    }
}

/* What open_marks read: the account, the record (its cache and pin), the settings pin and the family check. */
pub(crate) struct Marks {
    pub(crate) account: ServedAccount,
    pub(crate) record: Option<ChainRecord>,
    /* The family's settings pin, refused (with the worker's words) when it does not read. */
    pub(crate) settings_pin: CoreResult<Option<GroupPin>>,
    /* The family's check record (familyChecks): whether there is one, and its pair mark. */
    pub(crate) check: CoreResult<(bool, Vec<PairMark>)>,
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl AreaLedger {
    /// Accepts what route 5 served for `group_id` against the person's marks:
    /// the settings pin of the settings the app last opened
    /// ([`AreaLedger::use_settings_envelope`]), this device's chain record (`record`,
    /// its cache and its own pin), and the family's floor: the highest chain
    /// this session committed for it, which a refusal never drops. The twin of
    /// the web's sync (`acceptFromRecord` driving the worker's `groupAccept`):
    ///
    /// - `served.after` above 0 continues the record's cache; refused, or
    ///   overtaken (a damaged cache that names no head), the answer is
    ///   [`ServedAcceptance::FetchFromVersionOne`]: fetch from version 1 and
    ///   call again with the same record;
    /// - from version 1 (`after` 0), first with the cache (its digests are
    ///   marks, so another history is the fork), then with the cache left
    ///   out and the record's own pin still a mark: a cache this release
    ///   refuses (damaged, or a newer `cacheVersion`) never refuses the family
    ///   for good, and a chain below the record's version and digest stays a
    ///   rollback whatever settings the server serves;
    /// - from version 1, a chain short of the floor, or another at its
    ///   version, is [`ServedAcceptance::Overtaken`] and keeps nothing.
    ///
    /// On acceptance the chain is committed here (its areas' write versions
    /// follow it) and a new record is sealed; nothing is written for a fork or
    /// a refusal. **Records must reach disk in commit order**: the app stores
    /// `record` only if no stored record is at a later roster version (a
    /// background acceptance can finish after a foreground one), and stores it
    /// before it settles `pin` into settings, as the web does. `me` is the
    /// account [`AreaLedger::open_account`] opened (its user id, with its
    /// current signing key among its identities); a lock or another account
    /// opened meanwhile refuses the commit. No mark at all (no record, no
    /// settings pin, nothing committed) is refused: only joining or creating
    /// vouches for first keys. `record` none with `served.after` above 0 is an
    /// input error, and touches nothing.
    ///
    /// ```
    /// use hushos_core::*;
    /// # fn main() -> CoreResult<()> {
    /// let user = "00000001-abcd-4abc-8abc-abcdefabcdef".to_string();
    /// let group = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".to_string();
    /// let signing_seed = vec![5u8; 32];
    /// let ledger = AreaLedger::new();
    /// ledger.open_account(user.clone(), signing_public_key(signing_seed)?, vec![9u8; 32])?;
    /// ledger.use_settings_envelope(user.clone(), None, None)?;
    /// let me = OwnIdentities { user_id: user, identities: vec![] };
    /// let served = ServedChain {
    ///     after: 0,
    ///     first_keys: group_public_key(vec![1u8; 64])?,
    ///     rosters: vec![],
    ///     successions: vec![],
    ///     signer_keys: Default::default(),
    /// };
    /// // No record, no settings pin, nothing committed: nothing vouches for the first keys.
    /// assert!(ledger.accept_served(me.clone(), group.clone(), None, served.clone(), FamilyGuard::Absent, "2026-10-18T00:00:00.000Z".into()).is_err());
    /// // A continuation without the record it continues is the app's mistake, refused before anything.
    /// let continuation = ServedChain { after: 3, ..served };
    /// assert!(ledger.accept_served(me, group, None, continuation, FamilyGuard::Absent, "2026-10-18T00:00:00.000Z".into()).is_err());
    /// # Ok(())
    /// # }
    /// ```
    pub fn accept_served(
        &self,
        me: OwnIdentities,
        group_id: String,
        record: Option<String>,
        served: ServedChain,
        guard: FamilyGuard,
        checked_at: String,
    ) -> CoreResult<ServedAcceptance> {
        uuid(&group_id, "group id")?;
        if record.is_none() && served.after > 0 {
            return Err(input("A continuation needs the record it continues: fetch from version 1."));
        }
        let guard = guard.pin()?;
        // The record first, then the settings, as the worker's marksOf: a record that does not open
        // is the answer even before settings are open.
        let Some(Marks { account, record, settings_pin, check }) = self.open_marks(&me, &group_id, record)?
        else {
            return Ok(ServedAcceptance::RecordUnreadable);
        };
        let reader = Reader {
            account: &account,
            me: &me,
            group_id: &group_id,
            checked_at: &checked_at,
            guard,
            check: &check,
        };
        let (cache, record_pin) = match &record {
            None => (RecordCache::None, Ok(None)),
            Some(ChainRecord { cache, pin }) => (cache.clone(), pin.clone()),
        };
        self.accept_in_order(&reader, &served, &cache, &settings_pin, &record_pin, record.is_some())
    }
}

/* The app's own device stores, for the shared fixtures and tests: the outbox is the core's since
 * Core 5a (entries come only from the roster call builders, AreaLedger::outbox_open reads them). */
#[cfg(feature = "fixtures")]
impl AreaLedger {
    /// Seals one of the app's own family records (`value`, JSON text) in the
    /// device store `store`, for the account [`AreaLedger::open_account`]
    /// opened, under the key it derived: bound to the account, the family and
    /// the store.
    /// (The shared fixtures' device-store cases run it.)
    #[doc(hidden)]
    pub fn group_device_record_seal(
        &self,
        group_id: String,
        store: DeviceStore,
        value: String,
    ) -> CoreResult<String> {
        let account = self.account_for_records()?;
        let value: Value = serde_json::from_str(&value).map_err(|_| input("This record is not JSON."))?;
        let plaintext = Zeroizing::new(value.to_string().into_bytes());
        seal_bytes(&account.store_key, &account.user_id, &group_id, store.name(), &plaintext)
    }

    /// One of the app's own family records, as JSON text. Refused as sealed
    /// ([`RECORD_UNREADABLE`], `CoreError::Sealed`) only when the envelope does
    /// not open: sealed under another account root (a master-key rotation), for
    /// another account, family or store, or damaged, and the app deletes it.
    /// Any other refusal (no account open, a malformed id) is an input error,
    /// and the record stays.
    #[doc(hidden)]
    pub fn group_device_record_open(
        &self,
        group_id: String,
        store: DeviceStore,
        envelope: String,
    ) -> CoreResult<String> {
        let account = self.account_for_records()?;
        let plaintext = open_bytes(&account.store_key, &account.user_id, &group_id, store.name(), &envelope)?;
        let value: Value =
            serde_json::from_slice(&plaintext).map_err(|_| CoreError::Sealed(RECORD_UNREADABLE.into()))?;
        Ok(value.to_string())
    }
}

/* The settings pin -------------------------------------------------------- */

/// An area this device opened, as [`AreaLedger::open_area`] returns it
/// (`AreaOpened::pin_area`), with the family it was opened under. Swift and
/// Kotlin cannot make one, so the areas [`merge_pin`] folds in from `opened`
/// are ones this device opened for that family. The pins it merges are plain
/// records, though: an app that wrote areas into `current` or `next` itself
/// could raise an area's mark (only ever raise it, and the next acceptance
/// then needs that key version); app reviews hold that the only `next` is
/// [`ServedAcceptance::Accepted`]'s `pin`.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct OpenedArea {
    group_id: String,
    workspace_id: String,
    version: u64,
}

impl OpenedArea {
    pub(crate) fn new(group_id: String, workspace_id: String, version: u64) -> Arc<OpenedArea> {
        Arc::new(OpenedArea { group_id, workspace_id, version })
    }
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl OpenedArea {
    /// The family it was opened under.
    pub fn group_id(&self) -> String {
        self.group_id.clone()
    }
    /// The family folder.
    pub fn workspace_id(&self) -> String {
        self.workspace_id.clone()
    }
    /// The key version opened.
    pub fn version(&self) -> u64 {
        self.version
    }
}

/// An opened area by hand. For the shared fixtures and the fuzz targets only;
/// apps take theirs from [`AreaLedger::open_area`].
#[doc(hidden)]
pub fn opened_area(group_id: String, workspace_id: String, version: u64) -> Arc<OpenedArea> {
    OpenedArea::new(group_id, workspace_id, version)
}

/// What [`merge_pin`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum PinMerge {
    /// What to save over the current pin (if [`pin_ahead`] says it records anything new).
    Merged { pin: GroupPin },
    /// The current pin is at a later roster or group key: never written over.
    /// Accept again with it as a mark.
    Behind,
    /// The two name other first keys, or other rosters or group keys at one
    /// version: never saved over; acceptance with the settings pin as a mark
    /// says what it is.
    Conflict,
}

/* JavaScript's `<` on strings: by UTF-16 code units, so both twins order any check time alike. */
fn earlier(a: &str, b: &str) -> bool {
    a.encode_utf16().lt(b.encode_utf16())
}

/// `next` (an accepted pin), with the opened areas folded in, as it may be
/// saved over `current` (the settings pin): never lower, never over a
/// conflict, the earliest words check kept, every area at its highest mark.
/// The twin of the web's `mergePin`. `group_id` is the family both pins are
/// of: an opened area of another family is refused ([`NOT_THIS_FAMILYS`]).
///
/// ```
/// use hushos_core::{merge_pin, GroupPin, PinMerge};
/// let group = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".to_string();
/// let pin = |roster_version: u64, checked_at: &str| GroupPin {
///     first_ed25519_public_key: "k".into(), first_ml_dsa_public_key_digest: "d".into(),
///     checked_at: checked_at.into(), key_version: 1, group_key_digest: "g".into(),
///     roster_version, roster_digest: format!("r{roster_version}"), areas: Default::default(),
/// };
/// let later = pin(5, "2026-10-01T00:00:00.000Z");
/// assert_eq!(merge_pin(group.clone(), Some(later.clone()), pin(4, "2026-10-02T00:00:00.000Z"), vec![]), Ok(PinMerge::Behind));
/// let Ok(PinMerge::Merged { pin: merged }) = merge_pin(group, Some(pin(4, "2026-09-01T00:00:00.000Z")), later, vec![]) else { panic!() };
/// assert_eq!((merged.roster_version, merged.checked_at.as_str()), (5, "2026-09-01T00:00:00.000Z"));
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn merge_pin(
    group_id: String,
    current: Option<GroupPin>,
    next: GroupPin,
    opened: Vec<Arc<OpenedArea>>,
) -> CoreResult<PinMerge> {
    if opened.iter().any(|area| area.group_id != group_id) {
        return Err(input(NOT_THIS_FAMILYS));
    }
    if let Some(current) = &current {
        if current.first_ed25519_public_key != next.first_ed25519_public_key
            || current.first_ml_dsa_public_key_digest != next.first_ml_dsa_public_key_digest
        {
            return Ok(PinMerge::Conflict);
        }
        if (current.roster_version == next.roster_version && current.roster_digest != next.roster_digest)
            || (current.key_version == next.key_version && current.group_key_digest != next.group_key_digest)
        {
            return Ok(PinMerge::Conflict);
        }
        if current.roster_version > next.roster_version || current.key_version > next.key_version {
            return Ok(PinMerge::Behind);
        }
    }
    let mut areas = current.as_ref().map(|pin| pin.areas.clone()).unwrap_or_default();
    let raise = |areas: &mut HashMap<String, u64>, workspace_id: &str, version: u64| {
        let mark = areas.entry(workspace_id.to_string()).or_insert(0);
        *mark = (*mark).max(version);
    };
    for (workspace_id, version) in &next.areas {
        raise(&mut areas, workspace_id, *version);
    }
    for area in &opened {
        raise(&mut areas, &area.workspace_id, area.version);
    }
    let checked_at = match &current {
        Some(current) if earlier(&current.checked_at, &next.checked_at) => current.checked_at.clone(),
        _ => next.checked_at.clone(),
    };
    Ok(PinMerge::Merged { pin: GroupPin { checked_at, areas, ..next } })
}

/// Whether saving `next` over `current` records anything new: a later roster
/// or group key, an earlier words check, or a higher area mark. The twin of
/// the web's `pinAhead`.
///
/// ```
/// use hushos_core::{pin_ahead, GroupPin};
/// let pin = GroupPin {
///     first_ed25519_public_key: "k".into(), first_ml_dsa_public_key_digest: "d".into(),
///     checked_at: "2026-10-01T00:00:00.000Z".into(), key_version: 1, group_key_digest: "g".into(),
///     roster_version: 3, roster_digest: "r".into(), areas: Default::default(),
/// };
/// assert!(pin_ahead(None, pin.clone()));
/// assert!(!pin_ahead(Some(pin.clone()), pin));
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn pin_ahead(current: Option<GroupPin>, next: GroupPin) -> bool {
    let Some(current) = current else {
        return true;
    };
    next.roster_version > current.roster_version
        || next.key_version > current.key_version
        || earlier(&next.checked_at, &current.checked_at)
        || next
            .areas
            .iter()
            .any(|(workspace_id, version)| *version > current.areas.get(workspace_id).copied().unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::decode;
    use crate::envelope::open_with_nonce;
    use crate::group_trust::{accept_rosters, GroupAnchor};
    use crate::groups::tests::{
        area_key_at, ml_dsa_keys, History, Person, AREA, AREA_SEED, GROUP, OTHER_GROUP,
    };
    use crate::groups::{GroupRole, MemberStatus};

    const CHECKED: &str = "2026-10-18T00:00:00.000Z";
    const ROOT: [u8; 32] = [9; 32];
    const OUTBOX: &str = r#"{"calls":[{"id":"a"}]}"#;

    /* A family of two: person 1 holds members, person 2's roles change each roster. */
    struct Family {
        p1: Person,
        p2: Person,
        h: History,
    }

    fn family(versions: usize) -> Family {
        family_of(Person::new(1), Person::new(2), versions, None)
    }

    /*
     * The same people's history, `versions` rosters long; with `branch` at a
     * version, that roster (and so every one after it) is another one.
     */
    fn family_of(p1: Person, p2: Person, versions: usize, branch: Option<usize>) -> Family {
        let mut h = History::new();
        for at in 0..versions {
            let roles: &[GroupRole] = match (at, branch == Some(at + 1)) {
                (_, true) => &[GroupRole::Members],
                (at, false) if at % 2 == 1 => &[GroupRole::Billing],
                _ => &[],
            };
            h.roster(
                &p1,
                vec![
                    p1.entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active),
                    p2.entry(roles, 1, MemberStatus::Active),
                ],
                None,
            );
        }
        Family { p1, p2, h }
    }

    impl Family {
        fn branch(&self, at: usize) -> Family {
            family_of(self.p1.clone(), self.p2.clone(), self.h.rosters.len(), Some(at))
        }

        fn served(&self, after: usize, through: usize) -> ServedChain {
            ServedChain {
                after: after as u64,
                first_keys: self.h.key(1),
                rosters: self.h.rosters[after..through].to_vec(),
                successions: self.h.successions.clone(),
                signer_keys: ml_dsa_keys(&[&self.p1, &self.p2]),
            }
        }

        fn me(&self) -> OwnIdentities {
            OwnIdentities { user_id: self.p1.user_id.clone(), identities: vec![self.p1.served_keys()] }
        }

        /* The pin a device that accepted the first `version` rosters writes. */
        fn pin_at(&self, version: usize) -> GroupPin {
            let RosterChain::Accepted { chain } = accept_rosters(
                GROUP.into(),
                self.h.key(1),
                Some(GroupAnchor::Created),
                vec![],
                self.h.rosters[..version].to_vec(),
                vec![],
                ml_dsa_keys(&[&self.p1, &self.p2]),
                crate::groups::tests::reader(),
                None,
            )
            .unwrap() else {
                panic!("accepted")
            };
            pin_after(vec![], chain, CHECKED.into()).unwrap()
        }

        /* Person 1's ledger, under ROOT, with settings that opened carrying `pin` (or no pin). */
        fn ledger_with(&self, pin: Option<GroupPin>) -> Arc<AreaLedger> {
            let ledger = AreaLedger::new();
            let signing = decode("k", &self.p1.keys.signing_public_key, None).unwrap();
            ledger.open_account(self.p1.user_id.clone(), signing, ROOT.to_vec()).unwrap();
            settings(&ledger, &self.p1.user_id, pin);
            ledger
        }

        fn ledger(&self) -> Arc<AreaLedger> {
            self.ledger_with(None)
        }

        fn accept(
            &self,
            ledger: &AreaLedger,
            record: Option<&str>,
            served: ServedChain,
        ) -> CoreResult<ServedAcceptance> {
            ledger.accept_served(
                self.me(),
                GROUP.into(),
                record.map(str::to_string),
                served,
                FamilyGuard::Absent,
                CHECKED.into(),
            )
        }

        /* Accepted from version 1 with only the settings pin at `pinned`: the record a device keeps. */
        fn record_through(&self, through: usize, pinned: usize) -> String {
            let ledger = self.ledger_with(Some(self.pin_at(pinned)));
            match self.accept(&ledger, None, self.served(0, through)).unwrap() {
                ServedAcceptance::Accepted { record, .. } => record,
                other => panic!("expected an acceptance, got {other:?}"),
            }
        }

        /* A ledger that committed the first `through` rosters (against the settings pin at 1), its settings then `pin`. */
        fn held(&self, through: usize, pin: Option<GroupPin>) -> Arc<AreaLedger> {
            let ledger = self.ledger_with(Some(self.pin_at(1)));
            assert_eq!(
                version_of(&self.accept(&ledger, None, self.served(0, through)).unwrap()),
                Some(through as u64)
            );
            settings(&ledger, &self.p1.user_id, pin);
            ledger
        }
    }

    fn settings(ledger: &AreaLedger, user_id: &str, pin: Option<GroupPin>) {
        ledger
            .use_settings(
                user_id.into(),
                Some(pin.into_iter().map(|pin| (GROUP.to_string(), pin)).collect()),
                Default::default(),
            )
            .unwrap();
    }

    fn version_of(outcome: &ServedAcceptance) -> Option<u64> {
        match outcome {
            ServedAcceptance::Accepted { chain, .. } => Some(chain.roster.roster_version),
            _ => None,
        }
    }

    fn record_value(record: &str, user_id: &str) -> Value {
        chain_record_open_value(&ROOT, user_id, GROUP, record).unwrap()
    }

    fn reseal(f: &Family, value: &Value) -> String {
        chain_record_seal_value(&ROOT, &f.p1.user_id, GROUP, value).unwrap()
    }

    fn account_ledger(user: &str, root: &[u8]) -> Arc<AreaLedger> {
        let ledger = AreaLedger::new();
        ledger
            .open_account(
                user.into(),
                crate::signatures::signing_public_key_of(&[5; 32]).unwrap(),
                root.to_vec(),
            )
            .unwrap();
        ledger
    }

    #[test]
    fn a_record_opens_only_for_its_account_root_user_family_and_store() {
        let (user, other_user) =
            ("aaaaaaaa-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333");
        let ledger = account_ledger(user, &ROOT);
        let sealed =
            ledger.group_device_record_seal(GROUP.into(), DeviceStore::Outbox, OUTBOX.into()).unwrap();
        let open = |ledger: &AreaLedger, group: &str, store, envelope: &str| {
            ledger.group_device_record_open(group.into(), store, envelope.into())
        };
        let unreadable = |result: CoreResult<String>| matches!(result, Err(CoreError::Sealed(_)));
        assert_eq!(open(&ledger, GROUP, DeviceStore::Outbox, &sealed).unwrap(), OUTBOX);
        assert!(
            unreadable(open(&account_ledger(user, &[8; 32]), GROUP, DeviceStore::Outbox, &sealed)),
            "rotated root"
        );
        assert!(
            unreadable(open(&account_ledger(other_user, &ROOT), GROUP, DeviceStore::Outbox, &sealed)),
            "account"
        );
        assert!(unreadable(open(&ledger, OTHER_GROUP, DeviceStore::Outbox, &sealed)), "another family");
        let other_store = open_bytes(&store_key(&ROOT).unwrap(), user, GROUP, "joins", &sealed);
        assert!(matches!(other_store, Err(CoreError::Sealed(_))), "another store");
        // A flipped byte anywhere, the version byte included, and a cut envelope.
        let bytes = decode("r", &sealed, None).unwrap();
        for at in [0, 1, 25, bytes.len() - 1] {
            let mut flipped = bytes.clone();
            flipped[at] ^= 1;
            assert!(unreadable(open(&ledger, GROUP, DeviceStore::Outbox, &encode(&flipped))), "byte {at}");
        }
        assert!(unreadable(open(&ledger, GROUP, DeviceStore::Outbox, &encode(&bytes[..40]))));
        assert!(unreadable(open(&ledger, GROUP, DeviceStore::Outbox, &format!("{sealed}="))));
        // An app's mistake is an input error, never "unreadable", so no good record is deleted for it.
        assert!(matches!(
            open(&ledger, &GROUP.to_uppercase(), DeviceStore::Outbox, &sealed),
            Err(CoreError::Input(_))
        ));
        assert_eq!(open(&AreaLedger::new(), GROUP, DeviceStore::Outbox, &sealed), Err(input(NO_ACCOUNT)));
        assert!(ledger
            .group_device_record_seal(GROUP.into(), DeviceStore::Outbox, "{not json".into())
            .is_err());
    }

    #[test]
    fn a_root_of_another_length_is_the_app_s_mistake_and_records_need_an_open_account() {
        let user = "aaaaaaaa-1111-4111-8111-111111111111";
        let ledger = AreaLedger::new();
        let signing = crate::signatures::signing_public_key_of(&[5; 32]).unwrap();
        for root in [vec![9; 31], vec![9; 33], vec![]] {
            let refused = ledger.open_account(user.into(), signing.clone(), root);
            assert!(
                matches!(refused, Err(CoreError::Input(_))),
                "a root of another length is the app's mistake"
            );
        }
        ledger.open_account(user.into(), signing, ROOT.to_vec()).unwrap();
        let sealed =
            ledger.group_device_record_seal(GROUP.into(), DeviceStore::Outbox, OUTBOX.into()).unwrap();
        ledger.clear();
        assert_eq!(
            ledger.group_device_record_open(GROUP.into(), DeviceStore::Outbox, sealed),
            Err(input(NO_ACCOUNT))
        );
    }

    #[test]
    fn the_record_key_and_context_are_the_web_s_byte_for_byte() {
        let user = "11111111-1111-4111-8111-111111111111";
        let sealed = account_ledger(user, &ROOT)
            .group_device_record_seal(GROUP.into(), DeviceStore::Outbox, OUTBOX.into())
            .unwrap();
        let bytes = decode("r", &sealed, None).unwrap();
        assert_eq!(bytes[0], 1);
        // Derived and bound by hand, as session-groups.ts derives and binds it.
        let mut key = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&[0u8; 32]), &ROOT)
            .expand(b"hushos/group/device-store/v1", &mut key)
            .unwrap();
        let context = format!(r#"["hushos/group/device-store",1,"{user}","{GROUP}","outbox"]"#);
        let opened = open_with_nonce(&key, &bytes[1..25], &bytes[25..], context.as_bytes()).unwrap();
        assert_eq!(opened, OUTBOX.as_bytes());
        let other = format!(r#"["hushos/group/device-store",1,"{user}","{GROUP}","joins"]"#);
        assert!(open_with_nonce(&key, &bytes[1..25], &bytes[25..], other.as_bytes()).is_err());
    }

    #[test]
    fn a_cache_reads_back_as_written_and_what_the_web_refuses_by_shape_is_refused() {
        let f = family(2);
        let record = f.record_through(2, 1);
        let value = record_value(&record, &f.p1.user_id);
        let cache = cache_of(&value["cache"]).unwrap();
        assert_eq!(cache_json(&cache), value["cache"]);
        assert_eq!(cache.cache_version, 2);
        assert_eq!(cache.roster_digests.len(), 2);
        let refused = |change: &dyn Fn(&mut Map<String, Value>)| {
            let mut cache = value["cache"].as_object().unwrap().clone();
            change(&mut cache);
            cache_of(&Value::Object(cache)).is_err()
        };
        assert!(!refused(&|_| {}));
        assert!(refused(&|c| {
            c.insert("origin".into(), Value::Null);
        }));
        assert!(refused(&|c| {
            c.insert("areaRoots".into(), Value::Null);
        }));
        assert!(refused(&|c| {
            c.remove("retiredAreas");
        }));
        assert!(refused(&|c| {
            c.insert("droppedHolder".into(), json!("false"));
        }));
        assert!(refused(&|c| {
            c.insert("cacheVersion".into(), json!("2"));
        }));
        // A version 1 cache may leave both out (it carried neither); 2.0 is 2, as JSON.parse reads it.
        assert!(!refused(&|c| {
            c.insert("cacheVersion".into(), json!(1));
            c.remove("areaRoots");
            c.remove("retiredAreas");
        }));
        let mut as_float = value["cache"].as_object().unwrap().clone();
        as_float.insert("cacheVersion".into(), serde_json::from_str("2.0").unwrap());
        assert_eq!(cache_of(&Value::Object(as_float)).unwrap().cache_version, 2);
    }

    #[test]
    fn a_record_is_read_as_the_worker_reads_it() {
        let read = |value: Value| chain_record_read(GROUP, &value);
        assert!(read(json!({ "v": 2 })).is_none());
        assert!(read(json!({ "v": "1" })).is_none());
        assert!(read(json!([1])).is_none());
        let none = read(json!({ "v": 1, "cache": false, "pin": null })).unwrap();
        assert!(matches!(none.cache, RecordCache::None));
        assert_eq!(none.pin, Ok(None));
        for falsy in [json!(0), json!(""), json!(null)] {
            assert!(matches!(read(json!({ "v": 1, "cache": falsy })).unwrap().cache, RecordCache::None));
        }
        let damaged =
            read(json!({ "v": 1, "cache": { "rosterDigests": ["a", "b", "c"] }, "pin": false })).unwrap();
        assert!(matches!(damaged.cache, RecordCache::Refused { head: 3 }));
        assert_eq!(damaged.pin, Err(input(BAD_PIN)));
        // A pin wrong in its fields is refused in the worker's words and order, whatever the key order.
        let f = family(2);
        let good = pin_json(&f.pin_at(1));
        let with = |key: &str, value: Value| {
            let mut pin = good.clone();
            pin[key] = value;
            chain_record_read(GROUP, &json!({ "v": 1, "pin": pin })).unwrap().pin
        };
        assert_eq!(pin_of(GROUP, &good), Ok(f.pin_at(1)));
        assert_eq!(with("keyVersion", json!("2")), Err(input("Invalid group key version.")));
        assert_eq!(with("keyVersion", json!(1.5)), Err(input("Invalid group key version.")));
        assert_eq!(with("firstMlDsaPublicKeyDigest", json!(7)), Err(input("Invalid key digest.")));
        assert_eq!(with("checkedAt", json!("yesterday")), Err(input(BAD_PIN)));
        let both = json!({ "zzzzzzzz-bad": 1, "aaaaaaaa-1111-4111-8111-111111111111": 0 });
        assert_eq!(with("areas", both), Err(input("Invalid workspace id.")));
        let bad_key_and_area = {
            let mut pin = good.clone();
            pin["keyVersion"] = json!(0);
            pin["areas"] = json!({ "aaaaaaaa-1111-4111-8111-111111111111": 0 });
            pin_of(GROUP, &pin)
        };
        assert_eq!(bad_key_and_area, Err(input("Invalid workspace key version.")));
        assert!(matches!(
            read(json!({ "v": 1, "cache": 1 })).unwrap().cache,
            RecordCache::Refused { head: 0 }
        ));
    }

    #[test]
    fn a_record_continues_its_cache_and_takes_the_served_chain_from_there() {
        let f = family(3);
        let record = f.record_through(2, 1);
        let ledger = f.ledger();
        // Nothing but the record: its cache and its pin are the marks.
        let outcome = f.accept(&ledger, Some(&record), f.served(2, 3)).unwrap();
        assert_eq!(version_of(&outcome), Some(3));
        let ServedAcceptance::Accepted { record: next, pin, chain } = outcome else { unreachable!() };
        assert_eq!(ledger.held_chain(GROUP).unwrap().roster_digest, chain.roster_digest);
        // The new record holds the chain's cache and the pin after it, the earliest check kept.
        let value = record_value(&next, &f.p1.user_id);
        assert_eq!(value["v"], 1);
        assert_eq!(value["cache"], cache_json(&chain.cache()));
        assert_eq!(value["pin"], pin_json(&pin));
        assert_eq!((pin.roster_version, pin.checked_at.as_str()), (3, CHECKED));
    }

    #[test]
    fn a_continuation_the_cache_refuses_asks_for_version_1_and_keeps_nothing_committed() {
        let f = family(3);
        let other = f.branch(3);
        let record = f.record_through(2, 1);
        let ledger = f.ledger();
        f.accept(&ledger, Some(&record), f.served(0, 2)).unwrap();
        assert!(ledger.held_chain(GROUP).is_some());
        // A roster 3 that does not continue roster 2 as served here: another family's.
        let mut served = f.served(2, 3);
        served.rosters = vec![family(3).h.rosters[2].clone()];
        assert!(matches!(
            f.accept(&ledger, Some(&record), served).unwrap(),
            ServedAcceptance::FetchFromVersionOne
        ));
        // The ladder tries again from version 1: the chain held stays committed meanwhile, as the
        // worker keeps it for a `retried` attempt, so the family's folders read on.
        assert!(ledger.held_chain(GROUP).is_some(), "a retried refusal uncommits nothing");
        // From version 1 the cache's digests are marks: the branch at 3 agrees with them through 2.
        assert_eq!(version_of(&f.accept(&ledger, Some(&record), other.served(0, 3)).unwrap()), Some(3));
    }

    #[test]
    fn a_cache_this_release_refuses_takes_the_path_from_version_1_and_the_record_s_pin_still_holds() {
        let f = family(3);
        let record = f.record_through(3, 1);
        let mut value = record_value(&record, &f.p1.user_id);
        for damage in [json!({ "cacheVersion": 3 }), json!({ "statement": 7 })] {
            let mut damaged = value.clone();
            for (key, v) in damage.as_object().unwrap() {
                damaged["cache"][key] = v.clone();
            }
            let sealed = reseal(&f, &damaged);
            let ledger = f.ledger();
            assert!(matches!(
                f.accept(&ledger, Some(&sealed), f.served(3, 3)).unwrap(),
                ServedAcceptance::FetchFromVersionOne
            ));
            assert_eq!(version_of(&f.accept(&ledger, Some(&sealed), f.served(0, 3)).unwrap()), Some(3));
            // Cut below the record's pin (roster 3), with older settings served beside it: a rollback.
            let cut = f.accept(&f.ledger_with(Some(f.pin_at(1))), Some(&sealed), f.served(0, 2));
            assert!(cut.is_err(), "a chain below the record's pin is never taken");
            // Break-check: without the record's pin the same served chain is taken.
            let mut pinless = damaged.clone();
            pinless.as_object_mut().unwrap().remove("pin");
            let pinless = reseal(&f, &pinless);
            let taken = f.accept(&f.ledger_with(Some(f.pin_at(1))), Some(&pinless), f.served(0, 2)).unwrap();
            assert_eq!(version_of(&taken), Some(2));
        }
        value["pin"] = json!({ "rosterVersion": 3 });
        let sealed = reseal(&f, &value);
        assert!(f.accept(&f.ledger(), Some(&sealed), f.served(0, 3)).is_err());
    }

    #[test]
    fn a_record_from_another_root_account_or_family_is_unreadable() {
        let f = family(2);
        let record = f.record_through(2, 1);
        let signing = decode("k", &f.p1.keys.signing_public_key, None).unwrap();
        let rotated = f.ledger();
        rotated.open_account(f.p1.user_id.clone(), signing, vec![8; 32]).unwrap();
        let unreadable =
            |outcome: CoreResult<ServedAcceptance>| matches!(outcome, Ok(ServedAcceptance::RecordUnreadable));
        assert!(unreadable(f.accept(&rotated, Some(&record), f.served(0, 2))), "a rotated root");
        let other_family = f.ledger();
        let me = f.me();
        assert!(unreadable(other_family.accept_served(
            me,
            OTHER_GROUP.into(),
            Some(record.clone()),
            f.served(0, 2),
            FamilyGuard::Absent,
            CHECKED.into()
        )));
        let theirs = AreaLedger::new();
        theirs
            .open_account(
                f.p2.user_id.clone(),
                decode("k", &f.p2.keys.signing_public_key, None).unwrap(),
                ROOT.to_vec(),
            )
            .unwrap();
        settings(&theirs, &f.p2.user_id, None);
        let me = OwnIdentities { user_id: f.p2.user_id.clone(), identities: vec![f.p2.served_keys()] };
        assert!(unreadable(theirs.accept_served(
            me,
            GROUP.into(),
            Some(record.clone()),
            f.served(0, 2),
            FamilyGuard::Absent,
            CHECKED.into()
        )));
        let mut value = record_value(&record, &f.p1.user_id);
        value["v"] = json!(2);
        assert!(unreadable(f.accept(&f.ledger(), Some(&reseal(&f, &value)), f.served(0, 2))));
    }

    #[test]
    fn the_floor_is_a_mark_and_a_floor_and_an_overtaken_run_keeps_nothing() {
        let f = family(3);
        let branch = f.branch(3);
        let ledger = f.held(3, Some(f.pin_at(1)));
        // Served short of what is committed: overtaken, typed, and nothing uncommitted.
        let older = f.accept(&ledger, None, f.served(0, 2)).unwrap();
        assert!(matches!(older, ServedAcceptance::Overtaken { split: false }));
        assert!(ledger.held_chain(GROUP).is_some(), "an overtaken run uncommits nothing");
        // Another roster at the version committed: the floor is a mark, so the fork.
        let ServedAcceptance::Fork { version, .. } = f.accept(&ledger, None, branch.served(0, 3)).unwrap()
        else {
            panic!("expected the fork")
        };
        assert_eq!(version, 3);
        assert!(ledger.held_chain(GROUP).is_none());
        // A refusal after a fork keeps it a fork.
        settings(&ledger, &f.p1.user_id, None);
        let mut junk = f.served(0, 3);
        junk.rosters[2].signature.ed25519 = vec![0; 64];
        f.accept(&ledger, None, junk).unwrap_err();
        assert!(ledger.is_forked(GROUP));
        // Break-check: on a fresh ledger the branch is simply accepted (no floor).
        assert_eq!(
            version_of(&f.accept(&f.ledger_with(Some(f.pin_at(1))), None, branch.served(0, 3)).unwrap()),
            Some(3)
        );
    }

    #[test]
    fn a_refused_run_s_uncommit_keeps_the_floor_so_an_older_chain_is_never_taken_after_it() {
        // The background committed roster 3; a run with no record gets junk claiming roster 3 (a
        // last attempt: refused, uncommitted); then a run from the record at 2 is served the genuine
        // rosters 1 and 2.
        let f = family(3);
        let record = f.record_through(2, 1);
        let ledger = f.held(3, None);
        let mut junk = f.served(0, 3);
        junk.rosters[2].signature.ed25519 = vec![0; 64];
        f.accept(&ledger, None, junk).unwrap_err();
        assert!(ledger.held_chain(GROUP).is_none(), "the refusal uncommitted the chain");
        assert!(matches!(
            f.accept(&ledger, Some(&record), f.served(0, 2)).unwrap(),
            ServedAcceptance::Overtaken { split: false }
        ));
        // Only forgetting the family drops the floor: then the same run is taken.
        ledger.forget_group(GROUP.into());
        assert_eq!(version_of(&f.accept(&ledger, Some(&record), f.served(0, 2)).unwrap()), Some(2));
        // And a lock drops it with everything else.
        ledger.clear();
        assert!(ledger.floor(GROUP).is_none());
    }

    #[test]
    fn an_overtaken_continuation_asks_for_version_1_once_and_only_version_1_is_overtaken() {
        let f = family(3);
        let record = f.record_through(3, 1);
        let mut value = record_value(&record, &f.p1.user_id);
        let ledger = f.held(3, None);
        // A damaged cache with digests to count: refused, not raced, and nothing to fetch but version 1.
        value["cache"]["statement"] = json!(7);
        let damaged = reseal(&f, &value);
        assert!(matches!(
            f.accept(&ledger, Some(&damaged), f.served(3, 3)).unwrap(),
            ServedAcceptance::FetchFromVersionOne
        ));
        assert_eq!(version_of(&f.accept(&ledger, Some(&damaged), f.served(0, 3)).unwrap()), Some(3));
        // One whose digests are no list names no head: served short of the floor on the
        // continuation, which is a reason to fetch from version 1, never the overtaken answer.
        value["cache"]["rosterDigests"] = json!("abc");
        let headless = reseal(&f, &value);
        assert!(matches!(
            f.accept(&ledger, Some(&headless), f.served(3, 3)).unwrap(),
            ServedAcceptance::FetchFromVersionOne
        ));
        assert_eq!(version_of(&f.accept(&ledger, Some(&headless), f.served(0, 3)).unwrap()), Some(3));
        // A record behind the floor, with only rosters 1 and 2 served: overtaken from version 1.
        let behind = f.record_through(2, 1);
        assert!(matches!(
            f.accept(&ledger, Some(&behind), f.served(2, 2)).unwrap(),
            ServedAcceptance::FetchFromVersionOne
        ));
        assert!(matches!(
            f.accept(&ledger, Some(&behind), f.served(0, 2)).unwrap(),
            ServedAcceptance::Overtaken { split: false }
        ));
    }

    #[test]
    fn a_commit_needs_the_account_the_run_began_with() {
        let f = family(2);
        let chain = match f.accept(&f.ledger_with(Some(f.pin_at(1))), None, f.served(0, 2)).unwrap() {
            ServedAcceptance::Accepted { chain, .. } => chain,
            other => panic!("{other:?}"),
        };
        let signing_of = |p: &Person| decode("k", &p.keys.signing_public_key, None).unwrap();
        // Another account opened meanwhile.
        let ledger = f.ledger();
        let began = ledger.served_account().unwrap().generation;
        ledger.open_account(f.p2.user_id.clone(), signing_of(&f.p2), ROOT.to_vec()).unwrap();
        assert_eq!(ledger.commit_served(Arc::clone(&chain), began), Err(input(NOT_THIS_ACCOUNT)));
        // A lock meanwhile, and a lock with the same account unlocked again.
        let ledger = f.ledger();
        let began = ledger.served_account().unwrap().generation;
        ledger.clear();
        assert_eq!(ledger.commit_served(Arc::clone(&chain), began), Err(input(NOT_THIS_ACCOUNT)));
        ledger.open_account(f.p1.user_id.clone(), signing_of(&f.p1), ROOT.to_vec()).unwrap();
        assert_eq!(ledger.commit_served(Arc::clone(&chain), began), Err(input(NOT_THIS_ACCOUNT)));
        // A refusal or a fork under a session that changed touches nothing of the family.
        let held = f.ledger();
        held.commit(Arc::clone(&chain)).unwrap();
        let began = held.served_account().unwrap().generation;
        held.clear();
        held.open_account(f.p1.user_id.clone(), signing_of(&f.p1), ROOT.to_vec()).unwrap();
        held.commit(Arc::clone(&chain)).unwrap();
        assert_eq!(held.uncommit_served(GROUP, began, Some(true)), Err(input(NOT_THIS_ACCOUNT)));
        assert!(held.held_chain(GROUP).is_some() && !held.is_forked(GROUP));
        // Break-check: under the session it began in, the commit goes through, sealed under the key held.
        let fresh = f.ledger();
        let generation = fresh.served_account().unwrap().generation;
        assert_eq!(*fresh.commit_served(chain, generation).unwrap(), *store_key(&ROOT).unwrap());
    }

    #[test]
    fn a_session_that_changed_is_never_a_reason_to_fetch_again() {
        let f = family(3);
        let record = f.record_through(2, 1);
        let ledger = f.held(3, None);
        // The run began, then a lock and an unlock happened: its generation is not the ledger's.
        let mut account = ledger.served_account().unwrap();
        account.generation += 1;
        let me = f.me();
        let check = Ok((false, vec![]));
        let reader = Reader {
            account: &account,
            me: &me,
            group_id: GROUP,
            checked_at: CHECKED,
            guard: None,
            check: &check,
        };
        let opened =
            chain_record_open(&account.store_key, &account.user_id, GROUP, &record).unwrap().unwrap();
        // A refusal on the continuation: the account error, never FetchFromVersionOne, and the family
        // stays committed.
        let mut junk = f.served(2, 3);
        junk.rosters[0].signature.ed25519 = vec![0; 64];
        let refused = ledger.accept_in_order(&reader, &junk, &opened.cache, &Ok(None), &opened.pin, true);
        assert_eq!(refused.unwrap_err(), input(NOT_THIS_ACCOUNT));
        assert!(ledger.held_chain(GROUP).is_some());
        // An acceptance from version 1: the commit refuses, and no attempt without the cache follows.
        let from_one =
            ledger.accept_in_order(&reader, &f.served(0, 3), &opened.cache, &Ok(None), &opened.pin, true);
        assert_eq!(from_one.unwrap_err(), input(NOT_THIS_ACCOUNT));
    }

    #[test]
    fn no_commit_goes_below_or_beside_the_floor_after_a_refusal() {
        let f = family(3);
        let branch = f.branch(3);
        let chain_of = |family: &Family, version: usize| -> Arc<AcceptedRosters> {
            match f.accept(&family.ledger_with(Some(f.pin_at(1))), None, family.served(0, version)).unwrap() {
                ServedAcceptance::Accepted { chain, .. } => chain,
                other => panic!("{other:?}"),
            }
        };
        let (two, three, beside) = (chain_of(&f, 2), chain_of(&f, 3), chain_of(&branch, 3));
        let ledger = f.ledger();
        ledger.commit(Arc::clone(&three)).unwrap();
        let generation = ledger.served_account().unwrap().generation;
        ledger.uncommit_served(GROUP, generation, None).unwrap();
        assert!(ledger.held_chain(GROUP).is_none());
        // Through acceptance's commit and through the plain one alike.
        assert_eq!(ledger.commit_served(Arc::clone(&two), generation).err(), Some(input(OLDER_CHAIN)));
        assert_eq!(ledger.commit_served(Arc::clone(&beside), generation).err(), Some(input(SPLIT_CHAIN)));
        assert_eq!(ledger.commit(Arc::clone(&two)), Err(input(OLDER_CHAIN)));
        assert_eq!(ledger.commit(beside), Err(input(SPLIT_CHAIN)));
        // The same chain again, or a later one, is committed.
        assert!(ledger.commit_served(three, generation).is_ok());
        ledger.forget_group(GROUP.into());
        assert!(ledger.commit(two).is_ok(), "forgetting the family drops its floor");
    }

    #[test]
    fn another_account_opened_keeps_nothing_of_the_last_one_and_the_same_account_keeps_all() {
        let f = family(2);
        let ledger = f.held(2, Some(f.pin_at(1)));
        let signing_of = |p: &Person| decode("k", &p.keys.signing_public_key, None).unwrap();
        // The same account unlocked again (a new device key, a master-key rotation): its families stay.
        ledger.open_account(f.p1.user_id.clone(), signing_of(&f.p1), vec![8; 32]).unwrap();
        assert!(ledger.floor(GROUP).is_some() && ledger.held_chain(GROUP).is_some());
        assert_eq!(ledger.settings_pin(&f.p1.user_id, GROUP).unwrap(), Ok(Some(f.pin_at(1))));
        // Another account: no chain, floor or settings of the last one.
        ledger.open_account(f.p2.user_id.clone(), signing_of(&f.p2), ROOT.to_vec()).unwrap();
        assert!(ledger.floor(GROUP).is_none() && ledger.held_chain(GROUP).is_none());
        assert_eq!(ledger.settings_pin(&f.p1.user_id, GROUP), Err(input(OPEN_SETTINGS_FOR_TESTS)));
    }

    #[test]
    fn a_version_1_settings_document_sets_nothing_and_is_a_rollback_after_settings_that_opened() {
        let f = family(3);
        let ledger = AreaLedger::new();
        ledger
            .open_account(
                f.p1.user_id.clone(),
                decode("k", &f.p1.keys.signing_public_key, None).unwrap(),
                ROOT.to_vec(),
            )
            .unwrap();
        // Nothing opened yet: nothing set, so acceptance stays refused.
        ledger.legacy_settings(f.p1.user_id.clone()).unwrap();
        assert_eq!(f.accept(&ledger, None, f.served(0, 3)).unwrap_err(), input(OPEN_SETTINGS_FOR_TESTS));
        // After "none", still none (acceptance runs, with no settings pin).
        ledger.use_settings(f.p1.user_id.clone(), None, Default::default()).unwrap();
        ledger.legacy_settings(f.p1.user_id.clone()).unwrap();
        assert_eq!(ledger.settings_pin(&f.p1.user_id, GROUP), Ok(Ok(None)));
        // After settings that opened: refused, and the pin held stays a mark.
        settings(&ledger, &f.p1.user_id, Some(f.pin_at(3)));
        assert!(ledger.legacy_settings(f.p1.user_id.clone()).is_err());
        assert_eq!(ledger.settings_pin(&f.p1.user_id, GROUP), Ok(Ok(Some(f.pin_at(3)))));
    }

    #[test]
    fn an_unreadable_record_is_the_answer_before_settings_are_open() {
        let f = family(2);
        let record = f.record_through(2, 1);
        let ledger = AreaLedger::new();
        let signing = decode("k", &f.p1.keys.signing_public_key, None).unwrap();
        ledger.open_account(f.p1.user_id.clone(), signing, vec![8; 32]).unwrap();
        let outcome = f.accept(&ledger, Some(&record), f.served(0, 2)).unwrap();
        assert!(matches!(outcome, ServedAcceptance::RecordUnreadable));
    }

    #[test]
    fn the_account_is_compared_as_the_readers_are_and_must_hold_its_signing_key() {
        let f = family(2);
        let mut me = f.me();
        me.user_id = me.user_id.to_uppercase();
        let ledger = f.ledger_with(Some(f.pin_at(1)));
        let outcome = ledger.accept_served(
            me.clone(),
            GROUP.into(),
            None,
            f.served(0, 2),
            FamilyGuard::Absent,
            CHECKED.into(),
        );
        assert_eq!(version_of(&outcome.unwrap()), Some(2));
        me.identities = vec![f.p2.served_keys()];
        let wrong = f.ledger_with(Some(f.pin_at(1))).accept_served(
            me,
            GROUP.into(),
            None,
            f.served(0, 2),
            FamilyGuard::Absent,
            CHECKED.into(),
        );
        assert_eq!(wrong.unwrap_err(), input(OPEN_IDENTITY));
        // Another account than the one unlocked is refused before the record is read.
        let someone = OwnIdentities { user_id: f.p2.user_id.clone(), identities: vec![f.p2.served_keys()] };
        let other = f.ledger_with(Some(f.pin_at(1))).accept_served(
            someone,
            GROUP.into(),
            None,
            f.served(0, 2),
            FamilyGuard::Absent,
            CHECKED.into(),
        );
        assert_eq!(other.unwrap_err(), input(NO_ACCOUNT));
        assert_eq!(f.accept(&AreaLedger::new(), None, f.served(0, 2)).unwrap_err(), input(NO_ACCOUNT));
    }

    #[test]
    fn settings_that_opened_never_give_way_to_none_and_acceptance_reads_them() {
        let f = family(3);
        let ledger = AreaLedger::new();
        let signing = decode("k", &f.p1.keys.signing_public_key, None).unwrap();
        ledger.open_account(f.p1.user_id.clone(), signing, ROOT.to_vec()).unwrap();
        // Before any settings, nothing is accepted.
        assert_eq!(f.accept(&ledger, None, f.served(0, 3)).unwrap_err(), input(OPEN_SETTINGS_FOR_TESTS));
        // None after none is fine; none after settings that opened is refused, and the pin stays.
        ledger.use_settings(f.p1.user_id.clone(), None, Default::default()).unwrap();
        settings(&ledger, &f.p1.user_id, Some(f.pin_at(3)));
        assert!(ledger.use_settings(f.p1.user_id.clone(), None, Default::default()).is_err());
        assert_eq!(ledger.settings_pin(&f.p1.user_id, GROUP).unwrap(), Ok(Some(f.pin_at(3))));
        // The pin is a mark: rosters 1 and 2 alone are a rollback.
        assert!(f.accept(&ledger, None, f.served(0, 2)).is_err());
        assert_eq!(version_of(&f.accept(&ledger, None, f.served(0, 3)).unwrap()), Some(3));
        // Another account's settings are no settings for this one.
        ledger.use_settings(f.p2.user_id.clone(), Some(HashMap::new()), Default::default()).unwrap();
        assert_eq!(f.accept(&ledger, None, f.served(0, 3)).unwrap_err(), input(OPEN_SETTINGS_FOR_TESTS));
    }

    const OPEN_SETTINGS_FOR_TESTS: &str = "Open your settings first.";

    #[test]
    fn a_continuation_without_a_record_is_refused_before_the_ledger_is_touched() {
        let f = family(3);
        let ledger = f.held(3, None);
        let refused = f.accept(&ledger, None, f.served(2, 3));
        assert!(matches!(refused, Err(CoreError::Input(_))));
        assert!(ledger.held_chain(GROUP).is_some(), "the family stays committed");
    }

    fn pin(roster_version: u64, key_version: u64, checked_at: &str, areas: &[(&str, u64)]) -> GroupPin {
        GroupPin {
            first_ed25519_public_key: "first".into(),
            first_ml_dsa_public_key_digest: "digest".into(),
            checked_at: checked_at.into(),
            key_version,
            group_key_digest: format!("key{key_version}"),
            roster_version,
            roster_digest: format!("roster{roster_version}"),
            areas: areas.iter().map(|(id, v)| (id.to_string(), *v)).collect(),
        }
    }

    fn merge(current: Option<GroupPin>, next: GroupPin, opened: Vec<Arc<OpenedArea>>) -> PinMerge {
        merge_pin(GROUP.into(), current, next, opened).unwrap()
    }

    fn here(workspace_id: &str, version: u64) -> Arc<OpenedArea> {
        opened_area(GROUP.into(), workspace_id.into(), version)
    }

    #[test]
    fn a_pin_is_never_lowered_never_saved_over_a_conflict_and_keeps_the_earliest_check() {
        const EARLY: &str = "2026-01-01T00:00:00.000Z";
        const LATE: &str = "2026-06-01T00:00:00.000Z";
        let current = pin(5, 2, EARLY, &[("a", 3)]);
        assert_eq!(merge(Some(current.clone()), pin(4, 2, LATE, &[]), vec![]), PinMerge::Behind);
        assert_eq!(merge(Some(current.clone()), pin(6, 1, LATE, &[]), vec![]), PinMerge::Behind);
        let mut first = pin(6, 2, LATE, &[]);
        first.first_ed25519_public_key = "other".into();
        assert_eq!(merge(Some(current.clone()), first, vec![]), PinMerge::Conflict);
        let mut ml_dsa = pin(6, 2, LATE, &[]);
        ml_dsa.first_ml_dsa_public_key_digest = "other".into();
        assert_eq!(merge(Some(current.clone()), ml_dsa, vec![]), PinMerge::Conflict);
        let mut roster = pin(5, 2, LATE, &[]);
        roster.roster_digest = "another".into();
        assert_eq!(merge(Some(current.clone()), roster, vec![]), PinMerge::Conflict);
        let mut key = pin(6, 2, LATE, &[]);
        key.group_key_digest = "another".into();
        assert_eq!(merge(Some(current.clone()), key, vec![]), PinMerge::Conflict);
        let PinMerge::Merged { pin: merged } = merge(
            Some(current.clone()),
            pin(6, 3, LATE, &[("a", 2), ("b", 1)]),
            vec![here("c", 4), here("a", 5)],
        ) else {
            panic!()
        };
        assert_eq!((merged.roster_version, merged.key_version), (6, 3));
        assert_eq!(merged.checked_at, EARLY);
        assert_eq!(merged.areas, [("a".into(), 5), ("b".into(), 1), ("c".into(), 4)].into());
        assert!(pin_ahead(Some(current.clone()), merged.clone()));
        assert!(!pin_ahead(Some(merged.clone()), merged.clone()));
        assert!(pin_ahead(Some(current.clone()), pin(5, 2, "2025-01-01T00:00:00.000Z", &[("a", 3)])));
        assert!(pin_ahead(Some(current.clone()), pin(5, 2, LATE, &[("a", 4)])));
        assert!(pin_ahead(Some(current.clone()), pin(5, 3, LATE, &[])));
        assert!(!pin_ahead(Some(current.clone()), pin(5, 2, LATE, &[("a", 3)])));
        let PinMerge::Merged { pin: fresh } = merge(None, pin(1, 1, LATE, &[]), vec![here("a", 1)]) else {
            panic!()
        };
        assert_eq!((fresh.checked_at.as_str(), fresh.areas.get("a")), (LATE, Some(&1)));
    }

    #[test]
    fn an_area_opened_under_another_family_never_enters_this_one_s_pin() {
        let other = opened_area(OTHER_GROUP.into(), "a".into(), 9);
        assert_eq!(
            merge_pin(GROUP.into(), None, pin(1, 1, CHECKED, &[]), vec![other]),
            Err(input(NOT_THIS_FAMILYS))
        );
        let theirs = opened_area(OTHER_GROUP.into(), "a".into(), 9);
        let refused = merge_pin(GROUP.into(), None, pin(1, 1, CHECKED, &[]), vec![here("b", 1), theirs]);
        assert!(refused.is_err(), "one stray area refuses the merge");
    }

    #[test]
    fn check_times_order_by_utf_16_code_units_as_javascript_orders_them() {
        let (bmp, astral) = ("\u{FF61}", "\u{10000}");
        assert!(earlier(astral, bmp) && !earlier(bmp, astral));
        let PinMerge::Merged { pin: merged } =
            merge(Some(pin(1, 1, astral, &[])), pin(1, 1, bmp, &[]), vec![])
        else {
            panic!()
        };
        assert_eq!(merged.checked_at, astral);
    }

    #[test]
    fn an_opened_area_is_what_open_area_opened_and_folds_into_the_pin() {
        let f = family(2);
        let ledger = f.ledger_with(Some(f.pin_at(1)));
        let ServedAcceptance::Accepted { pin, .. } = f.accept(&ledger, None, f.served(0, 2)).unwrap() else {
            panic!()
        };
        assert!(pin.areas.is_empty(), "the chain's areas never enter a pin by themselves");
        let opened = ledger
            .open_area(GROUP.into(), AREA.into(), AREA_SEED.into(), 1, area_key_at(AREA, 1), 1)
            .unwrap();
        let area = &opened.pin_area;
        assert_eq!(
            (area.group_id(), area.workspace_id(), area.version()),
            (GROUP.to_string(), AREA.to_string(), 1)
        );
        let PinMerge::Merged { pin: merged } = merge(None, pin, vec![opened.pin_area]) else { panic!() };
        assert_eq!(merged.areas.get(AREA), Some(&1));
    }
}
