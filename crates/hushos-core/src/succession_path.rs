use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use sha2::{Digest as _, Sha256};

use crate::bytes::decode;
use crate::contacts::key_digest;
use crate::identity::{
    succession_consent_verify, succession_verify, PinnedKeys, ServedKeys, SuccessionLink, SuccessionSigner,
};
use crate::pq::ML_DSA_PUBLIC_KEY_BYTES;

/*
 * The group core's own way along a member's succession links (group_trust.rs
 * and the seal openers in groups.rs use it; personal pins keep the shipped
 * strict verifier, succession_chain_verify, whose callers rely on its chain
 * being contiguous in the order served, and which must never reuse this
 * walk's `verified` map: the two accept links on different proofs).
 * packages/crypto/src/succession-path.ts is its twin.
 *
 * Each link is verified once, under its proof:
 * - by default its version 2 signature under the old keys it names (what every
 *   shipped client signs): the roster-lag walk, the personal-pin walk and
 *   roster_entry_fold_in, where a holder's planted keys never start;
 * - with `consent_until`, its successor consent (both the old keys and the new
 *   keys it names sign `hushos/identity/succession-consent`) for every link
 *   until the walk reaches those keys, and its version 2 signature after: the
 *   walk from a member's first keys to their entry's, which a holder who
 *   planted the first keys could otherwise bridge to the real identity with a
 *   link signed from the planted keys alone. The group walk never checks a
 *   consented link's version 2 signature, so it and the personal verifier can
 *   disagree on one link.
 * The verified links form a graph between sets of keys. From `start` (matched
 * by X25519, Ed25519 and the ML-DSA key's digest) the reachable part must be a
 * single line:
 * - a set of keys with two verified links leaving it, to different keys, is an
 *   identity fork of the member (two of their devices succeeded at once, or a
 *   retried upload made a second successor): Fork, whatever order the links
 *   were served in, since nothing tells which identity is theirs now;
 * - otherwise the line is followed to the served keys (Path, the links in
 *   order), or it ends, or loops, short of them (None);
 * - a verified link leaving the served keys means the served identity is not
 *   the member's latest (the server rolled it back): Stale, which readers
 *   treat as unchecked, never as a verdict on the member's records. That holds
 *   when the start itself is the served identity (its three keys match): a
 *   rollback to the entry's own keys is stale too;
 * - more than MAX_SUCCESSION_LINKS links that could join the member's chain
 *   (from the start, from one of `member_keys`, or from a link the walk
 *   followed): TooMany, checked no further (each costs two hybrid
 *   verifications). Links with other old keys are never verified and never
 *   counted. The member's own keys are public, so a server can always make a
 *   walk overflow; readers treat TooMany as links that did not load
 *   (group_trust.rs), which costs retirement and leaves unknown keys
 *   unchecked, never a verdict on the member.
 * The served identity's key version is not signed, so it decides nothing: the
 * served keys are matched by their four keys alone.
 * Junk, links out of order and duplicates of one link change nothing. The
 * work is at most one verification per link and proof and one step per link.
 * `verified`, which a caller may share across calls for a session, is keyed by
 * the SHA-256 of the member, the proof and the link's fields, and holds at
 * most MAX_VERIFIED_LINKS results, the least recently used dropped first; it
 * is locked only to look up or store, never across a verification.
 */
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SuccessionPath {
    Path(Vec<SuccessionLink>),
    Fork,
    Stale,
    TooMany,
    None,
}

/* The most succession links one identity may carry: far beyond any honest history. */
pub(crate) const MAX_SUCCESSION_LINKS: usize = 64;

/* The most verification results one `VerifiedLinks` keeps. */
pub(crate) const MAX_VERIFIED_LINKS: usize = 4096;

/*
 * What a link's verification is remembered by: the SHA-256 of the member,
 * whether consent was asked, and every field of the link, each named in a
 * fixed order (a JSON array, so no two field lists encode alike).
 */
fn verified_key(user_id: &str, consent: bool, link: &SuccessionLink) -> [u8; 32] {
    let encoded = serde_json::json!([
        user_id,
        consent,
        link.old_key_version,
        link.new_key_version,
        link.old_encryption_public_key,
        link.old_signing_public_key,
        link.old_ml_dsa_public_key,
        link.new_encryption_public_key,
        link.new_signing_public_key,
        link.new_ml_dsa_public_key,
        link.new_kem_public_key,
        link.signature,
        link.consent,
    ])
    .to_string();
    Sha256::digest(encoded.as_bytes()).into()
}

/*
 * Verification results the walk remembers, at most MAX_VERIFIED_LINKS, the
 * least recently used dropped first. Locked only for a lookup or a store:
 * verifying a link happens outside the lock, so concurrent walks never wait
 * on each other's verifications (two may verify one link at once; both store
 * the same result).
 */
#[derive(Debug, Default)]
pub(crate) struct VerifiedLinks {
    inner: Mutex<Remembered>,
}

/* Each link's digest with its result and when it was last used, and the use counter. */
type Remembered = (HashMap<[u8; 32], (bool, u64)>, u64);

impl VerifiedLinks {
    pub(crate) fn new() -> VerifiedLinks {
        VerifiedLinks::default()
    }

    fn locked(&self) -> std::sync::MutexGuard<'_, Remembered> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn get(&self, key: &[u8; 32]) -> Option<bool> {
        let mut inner = self.locked();
        let (map, clock) = &mut *inner;
        *clock += 1;
        let tick = *clock;
        map.get_mut(key).map(|(held, used)| {
            *used = tick;
            *held
        })
    }

    pub(crate) fn put(&self, key: [u8; 32], held: bool) {
        let mut inner = self.locked();
        let (map, clock) = &mut *inner;
        *clock += 1;
        map.insert(key, (held, *clock));
        while map.len() > MAX_VERIFIED_LINKS {
            let Some(oldest) = map.iter().min_by_key(|(_, (_, used))| *used).map(|(key, _)| *key) else {
                break;
            };
            map.remove(&oldest);
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.locked().0.len()
    }

    #[cfg(test)]
    pub(crate) fn contains(&self, key: &[u8; 32]) -> bool {
        self.locked().0.contains_key(key)
    }
}

/* The new keys a link leads to. */
fn keys_of(link: &SuccessionLink) -> (String, String, String, String) {
    (
        link.new_encryption_public_key.clone(),
        link.new_signing_public_key.clone(),
        link.new_ml_dsa_public_key.clone(),
        link.new_kem_public_key.clone(),
    )
}

/* The SHA-256 of a base64url ML-DSA public key, as hex; none when it is not one. */
fn ml_dsa_hash(public_key: &str) -> Option<String> {
    decode("mlDsaPublicKey", public_key, Some(ML_DSA_PUBLIC_KEY_BYTES)).ok().map(key_digest)
}

fn same_keys(a: &PinnedKeys, b: &PinnedKeys) -> bool {
    a.encryption_public_key == b.encryption_public_key
        && a.signing_public_key == b.signing_public_key
        && a.ml_dsa_public_key_hash == b.ml_dsa_public_key_hash
}

/* Whether a link's new keys are `keys` (X25519, Ed25519 and the ML-DSA key's digest). */
fn leads_to(link: &SuccessionLink, keys: &PinnedKeys) -> bool {
    link.new_encryption_public_key == keys.encryption_public_key
        && link.new_signing_public_key == keys.signing_public_key
        && ml_dsa_hash(&link.new_ml_dsa_public_key).as_deref() == Some(keys.ml_dsa_public_key_hash.as_str())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn succession_path(
    user_id: &str,
    start: &PinnedKeys,
    served: &ServedKeys,
    links: &[SuccessionLink],
    verified: &VerifiedLinks,
    consent_until: Option<&PinnedKeys>,
    member_keys: &[PinnedKeys],
) -> SuccessionPath {
    let old_hashes: Vec<Option<String>> =
        links.iter().map(|link| ml_dsa_hash(&link.old_ml_dsa_public_key)).collect();
    let leaves_set = |index: usize, keys: &PinnedKeys| {
        links[index].old_encryption_public_key == keys.encryption_public_key
            && links[index].old_signing_public_key == keys.signing_public_key
            && old_hashes[index].as_deref() == Some(keys.ml_dsa_public_key_hash.as_str())
    };
    // The cap counts only links that could join the member's chain: from the start, from one of
    // their key sets on the chain, or from a link the walk followed. Junk with other old keys is
    // free (it is never verified), so serving it suppresses no verdict.
    let mut counted: HashSet<usize> = (0..links.len())
        .filter(|&index| std::iter::once(start).chain(member_keys).any(|keys| leaves_set(index, keys)))
        .collect();
    if counted.len() > MAX_SUCCESSION_LINKS {
        return SuccessionPath::TooMany;
    }
    let holds = |link: &SuccessionLink, consent: bool| -> bool {
        let key = verified_key(user_id, consent, link);
        if let Some(held) = verified.get(&key) {
            return held;
        }
        let held = if consent {
            succession_consent_verify(user_id.to_string(), link.clone())
        } else {
            succession_verify(
                user_id.to_string(),
                link.clone(),
                SuccessionSigner {
                    signing_public_key: link.old_signing_public_key.clone(),
                    ml_dsa_public_key: link.old_ml_dsa_public_key.clone(),
                },
            )
        };
        verified.put(key, held);
        held
    };
    let served_hash = ml_dsa_hash(&served.ml_dsa_public_key);
    // Where the walk is: the start (its ML-DSA key known by digest only), then a link's new keys.
    let mut at: Option<SuccessionLink> = None;
    // Consent is asked of every link until the walk has reached `consent_until`.
    let mut consenting = consent_until.is_some_and(|until| !same_keys(start, until));
    let mut seen = HashSet::new();
    let mut path = vec![];
    for _ in 0..=links.len() {
        let at_served = match &at {
            None => {
                start.encryption_public_key == served.encryption_public_key
                    && start.signing_public_key == served.signing_public_key
                    && served_hash.as_deref() == Some(start.ml_dsa_public_key_hash.as_str())
            }
            Some(at) => {
                at.new_encryption_public_key == served.encryption_public_key
                    && at.new_signing_public_key == served.signing_public_key
                    && at.new_ml_dsa_public_key == served.ml_dsa_public_key
                    && at.new_kem_public_key == served.kem_public_key
            }
        };
        let continuing: Vec<usize> = (0..links.len())
            .filter(|&index| {
                let link = &links[index];
                match &at {
                    Some(at) => {
                        link.old_encryption_public_key == at.new_encryption_public_key
                            && link.old_signing_public_key == at.new_signing_public_key
                            && link.old_ml_dsa_public_key == at.new_ml_dsa_public_key
                            && link.old_key_version >= at.new_key_version
                    }
                    None => {
                        leaves_set(index, start) && link.old_key_version >= start.key_version.unwrap_or(0)
                    }
                }
            })
            .collect();
        counted.extend(continuing.iter().copied());
        if counted.len() > MAX_SUCCESSION_LINKS {
            return SuccessionPath::TooMany;
        }
        let mut leaving: Vec<&SuccessionLink> = vec![];
        for &index in &continuing {
            if holds(&links[index], consenting) {
                leaving.push(&links[index]);
            }
        }
        // At the served identity: done, unless a verified link leaves it (a rollback). A start that
        // is the served identity with nothing leaving it is no path: there was no change.
        if at_served {
            return if !leaving.is_empty() {
                SuccessionPath::Stale
            } else if at.is_none() {
                SuccessionPath::None
            } else {
                SuccessionPath::Path(path)
            };
        }
        let targets: HashSet<_> = leaving.iter().map(|link| keys_of(link)).collect();
        if targets.len() > 1 {
            return SuccessionPath::Fork;
        }
        let Some(next) = leaving.first().map(|link| (*link).clone()) else {
            return SuccessionPath::None;
        };
        if !seen.insert(keys_of(&next)) {
            return SuccessionPath::None;
        }
        if consenting && consent_until.is_some_and(|until| leads_to(&next, until)) {
            consenting = false;
        }
        path.push(next.clone());
        at = Some(next);
    }
    SuccessionPath::None
}
