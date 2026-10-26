//! First-seen pins (docs/optional-verification.md 2): the rules that let a
//! device remember the keys it first saw for a person, follow them along
//! successions those keys signed, and notice when the settings document
//! stops agreeing with what this device has seen. Pure: the guard's store is
//! the app's own (beside its marks, excluded from backup); these say what its
//! entries mean. The twins are packages/crypto's `pins.ts` and
//! `first-seen.ts` and packages/drive's `trust.ts`.

use crate::bytes::decode;
use crate::contacts::{key_commitment, key_digest, pin_trust, PinKeys, PinTrust};
use crate::error::{input, CoreResult};
use crate::identity::{
    identity_verify_keys, succession_chain_verify, PinnedKeys, PublicIdentity, ServedKeys, SuccessionLink,
    KEM_PUBLIC_KEY_BYTES,
};
use crate::pq::ML_DSA_PUBLIC_KEY_BYTES;

/// The keys the server serves for a contact now, as a pin is compared with
/// them: the ML-DSA and ML-KEM keys in full, none for an identity that has
/// not upgraded.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ServedContactKeys {
    pub key_version: u64,
    pub encryption_public_key: String,
    pub signing_public_key: String,
    pub ml_dsa_public_key: Option<String>,
    pub kem_public_key: Option<String>,
}

/// What a pin says about the keys the server serves for that person now,
/// packages/drive's `comparePin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum PinComparison {
    /// A verified or first-seen pin, and every served key is the pinned one
    /// (the lattice keys by digest).
    Same,
    /// A legacy or malformed pin over the same X25519 and Ed25519 keys:
    /// nothing is trusted through it until it is pinned again.
    Recheck,
    /// Other keys at a higher key version, from a verified or first-seen pin:
    /// a chain signed by the pinned keys may explain it. A followed
    /// first-seen pin stays first-seen.
    Succession,
    /// Anything else: a served ML-DSA or ML-KEM key whose digest differs, none
    /// at all, or other keys no chain can explain.
    Changed,
}

/* SHA-256 (hex) of a canonical base64url key, or none. */
fn digest_of(key: &str) -> Option<String> {
    decode("publicKey", key, None).ok().map(key_digest)
}

/// What `pin` says about `served`; see [`PinComparison`].
///
/// ```
/// use hushos_core::*;
/// let served = ServedContactKeys {
///     key_version: 1,
///     encryption_public_key: base64url_encode(vec![1; 32]),
///     signing_public_key: base64url_encode(vec![2; 32]),
///     ml_dsa_public_key: Some(base64url_encode(vec![3; 1952])),
///     kem_public_key: Some(base64url_encode(vec![4; 1184])),
/// };
/// let keys = ServedKeys {
///     key_version: 1,
///     encryption_public_key: served.encryption_public_key.clone(),
///     signing_public_key: served.signing_public_key.clone(),
///     ml_dsa_public_key: served.ml_dsa_public_key.clone().unwrap(),
///     kem_public_key: served.kem_public_key.clone().unwrap(),
/// };
/// let first_seen = pin_of_served(keys, false)?;
/// assert_eq!(first_seen.fingerprint, "");
/// assert_eq!(compare_pin(first_seen.clone(), served.clone()), PinComparison::Same);
/// let swapped = ServedContactKeys { kem_public_key: Some(base64url_encode(vec![5; 1184])), ..served };
/// assert_eq!(compare_pin(first_seen, swapped), PinComparison::Changed);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn compare_pin(pin: PinKeys, served: ServedContactKeys) -> PinComparison {
    let held = matches!(pin_trust(pin.clone()), PinTrust::Verified | PinTrust::Seen);
    // An empty key is no key, as the web's `!served.mlDsaPublicKey` reads it.
    let present = |key: &Option<String>| key.clone().filter(|key| !key.is_empty());
    let (Some(ml_dsa), Some(kem)) = (present(&served.ml_dsa_public_key), present(&served.kem_public_key))
    else {
        // A downgrade, or an identity that never upgraded: never the same keys, never a succession.
        let same_keys = pin.encryption_public_key == served.encryption_public_key
            && pin.signing_public_key == served.signing_public_key;
        return if same_keys && !held { PinComparison::Recheck } else { PinComparison::Changed };
    };
    if pin.encryption_public_key == served.encryption_public_key
        && pin.signing_public_key == served.signing_public_key
    {
        if !held {
            return PinComparison::Recheck;
        }
        let same = digest_of(&ml_dsa).is_some_and(|d| Some(&d) == pin.ml_dsa_public_key_hash.as_ref())
            && digest_of(&kem).is_some_and(|d| Some(&d) == pin.kem_public_key_hash.as_ref());
        return if same { PinComparison::Same } else { PinComparison::Changed };
    }
    // A pin with no version: the chain is then looked for from 1.
    if held && served.key_version > pin.key_version.unwrap_or(1) {
        return PinComparison::Succession;
    }
    PinComparison::Changed
}

/// A version 3 pin of keys the server serves: verified (`verified`, as a
/// words check writes it, with the version 3 fingerprint) or first-seen
/// (`""`). Refused when the keys would not make a pin of that kind. Only for
/// an identity whose keys statement holds.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn pin_of_served(served: ServedKeys, verified: bool) -> CoreResult<PinKeys> {
    let invalid = || input("Invalid identity key.");
    let ml_dsa = decode("mlDsaPublicKey", &served.ml_dsa_public_key, Some(ML_DSA_PUBLIC_KEY_BYTES))
        .map_err(|_| invalid())?;
    let kem =
        decode("kemPublicKey", &served.kem_public_key, Some(KEM_PUBLIC_KEY_BYTES)).map_err(|_| invalid())?;
    if served.key_version < 1 || served.key_version > (1 << 53) - 1 {
        return Err(invalid());
    }
    let mut pin = PinKeys {
        key_version: Some(served.key_version),
        encryption_public_key: served.encryption_public_key,
        signing_public_key: served.signing_public_key,
        ml_dsa_public_key_hash: Some(key_digest(ml_dsa)),
        kem_public_key_hash: Some(key_digest(kem)),
        fingerprint: String::new(),
    };
    let commitment = key_commitment(pin.clone()).ok_or_else(invalid)?;
    if verified {
        pin.fingerprint = commitment;
    }
    Ok(pin)
}

/// A pin from before post-quantum identities, or a malformed one
/// ([`PinTrust::Legacy`] or [`PinTrust::Invalid`]), as a first-seen pin of
/// the served keys (2.5): only when its X25519 and Ed25519 keys are the
/// served ones and the served keys statement holds, so the lattice keys are
/// signed by the very Ed25519 key the person pinned before. Never verified.
/// None when the rule does not apply; the pin is then left as it is.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn pin_first_seen_of_legacy(user_id: String, pin: PinKeys, served: PublicIdentity) -> Option<PinKeys> {
    if !matches!(pin_trust(pin.clone()), PinTrust::Legacy | PinTrust::Invalid) {
        return None;
    }
    if pin.encryption_public_key != served.encryption_public_key
        || pin.signing_public_key != served.signing_public_key
    {
        return None;
    }
    if !identity_verify_keys(user_id, served.clone()) {
        return None;
    }
    pin_of_served(
        ServedKeys {
            key_version: served.key_version,
            encryption_public_key: served.encryption_public_key,
            signing_public_key: served.signing_public_key,
            ml_dsa_public_key: served.ml_dsa_public_key,
            kem_public_key: served.kem_public_key,
        },
        false,
    )
    .ok()
}

/// What one device keeps per contact, apart from the settings (2.8): the
/// keys it last acted on for them (the inputs of their key commitment, and
/// the key version), the signing keys it saw them replace, whether it saw
/// these keys verified, and a revision that only rises. Never written to the
/// settings, never cleared by anything the server answers.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct GuardEntry {
    pub revision: u64,
    pub key_version: Option<u64>,
    pub encryption_public_key: String,
    pub signing_public_key: String,
    pub ml_dsa_public_key_hash: String,
    pub kem_public_key_hash: String,
    pub previous_signing_keys: Vec<String>,
    pub verified: bool,
}

impl GuardEntry {
    fn keys(&self) -> PinKeys {
        PinKeys {
            key_version: self.key_version,
            encryption_public_key: self.encryption_public_key.clone(),
            signing_public_key: self.signing_public_key.clone(),
            ml_dsa_public_key_hash: Some(self.ml_dsa_public_key_hash.clone()),
            kem_public_key_hash: Some(self.kem_public_key_hash.clone()),
            fingerprint: String::new(),
        }
    }
}

/// What the device's guard store held for a person when it was read.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum GuardState {
    /// Nothing stored for them on this device: first use.
    Absent,
    /// The store could not be read (unavailable, a read error, a corrupt
    /// entry): never first use.
    Unreadable,
    Held {
        entry: GuardEntry,
    },
}

/// Whether a device may act on a person through the settings pin it holds now
/// (2.8, "The rule"), packages/crypto's `guardAgrees`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum GuardVerdict {
    /// This device has no guard entry for them.
    FirstUse,
    /// The pin's keys are the guard's, by key commitment.
    Agrees,
    /// The pin's keys are the served ones, and a succession chain this device
    /// verifies itself leads to them from the guard's keys: taken silently,
    /// and the guard moves on.
    Follows,
    /// Anything else, a pin missing from the settings included: paused for
    /// that person until Continue or a check (2.4).
    Changed,
    /// The guard could not be read.
    Unchecked,
}

/// See [`GuardVerdict`]. The chain is checked from the guard's own keys,
/// never from the pin's nor from anything a link supplies; `served` and
/// `links` are the person's identity and succession links as served, none
/// when they were not fetched. A `previous_signing_keys` list in the settings
/// never stands in for the chain: it is only what some device saw.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn guard_agrees(
    user_id: String,
    guard: GuardState,
    pin: Option<PinKeys>,
    served: Option<ServedKeys>,
    links: Vec<SuccessionLink>,
) -> GuardVerdict {
    let entry = match guard {
        GuardState::Absent => return GuardVerdict::FirstUse,
        GuardState::Unreadable => return GuardVerdict::Unchecked,
        GuardState::Held { entry } => entry,
    };
    let Some(pin) = pin else {
        return GuardVerdict::Changed;
    };
    if !matches!(pin_trust(pin.clone()), PinTrust::Verified | PinTrust::Seen) {
        return GuardVerdict::Changed;
    }
    let (Some(held), Some(keys)) = (key_commitment(entry.keys()), key_commitment(pin)) else {
        return GuardVerdict::Changed;
    };
    if keys == held {
        return GuardVerdict::Agrees;
    }
    let Some(served) = served else {
        return GuardVerdict::Changed;
    };
    let served_keys = pin_of_served(served.clone(), false).ok().and_then(key_commitment);
    if served_keys.as_deref() != Some(keys.as_str()) {
        return GuardVerdict::Changed;
    }
    let pinned = PinnedKeys {
        key_version: entry.key_version,
        encryption_public_key: entry.encryption_public_key,
        signing_public_key: entry.signing_public_key,
        ml_dsa_public_key_hash: entry.ml_dsa_public_key_hash,
    };
    if succession_chain_verify(user_id, pinned, served, links) {
        GuardVerdict::Follows
    } else {
        GuardVerdict::Changed
    }
}

/// The guard entry after this device acted on `pin` (adding, sharing,
/// opening, Continue, a check, a followed succession): the pin's keys at the
/// next revision. A signing key the guard held before and the pin does not is
/// kept as replaced; `verified` says whether this device saw these very keys
/// verified, through this pin or before. Refused for a pin that is neither
/// verified nor first-seen.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn guard_entry_next(previous: Option<GuardEntry>, pin: PinKeys) -> CoreResult<GuardEntry> {
    let trust = pin_trust(pin.clone());
    if !matches!(trust, PinTrust::Verified | PinTrust::Seen) {
        return Err(input("Only a verified or first-seen pin is remembered."));
    }
    let keys = key_commitment(pin.clone());
    let same = previous.as_ref().is_some_and(|at| key_commitment(at.keys()) == keys);
    let mut replaced = previous.as_ref().map(|at| at.previous_signing_keys.clone()).unwrap_or_default();
    if let Some(at) = &previous {
        if at.signing_public_key != pin.signing_public_key && !replaced.contains(&at.signing_public_key) {
            replaced.push(at.signing_public_key.clone());
        }
    }
    replaced.retain(|key| *key != pin.signing_public_key);
    Ok(GuardEntry {
        revision: previous.as_ref().map_or(0, |at| at.revision) + 1,
        key_version: pin.key_version,
        encryption_public_key: pin.encryption_public_key,
        signing_public_key: pin.signing_public_key,
        ml_dsa_public_key_hash: pin.ml_dsa_public_key_hash.unwrap_or_default(),
        kem_public_key_hash: pin.kem_public_key_hash.unwrap_or_default(),
        previous_signing_keys: replaced,
        verified: trust == PinTrust::Verified || (same && previous.is_some_and(|at| at.verified)),
    })
}

#[cfg(test)]
mod tests;
