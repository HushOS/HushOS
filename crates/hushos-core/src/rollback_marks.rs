//! A device's rollback marks for one account, sealed: the twin of
//! `packages/crypto/src/rollback-marks.ts`, byte for byte (docs/integrity-design.md,
//! "Rollback marks"). The highest settings sequence and own identity key version
//! this device has seen, and whether it has opened a version 2 settings document
//! and a version 2 identity, say how far an account got on the phone, so they are
//! kept sealed, never in the clear, and deleted at sign-out.
//!
//! Sealed under a key derived from the settings key (HKDF-SHA-256, salt 32 zero
//! bytes, info `hushos/rollback-marks/v1`), not the root: a master-key rotation
//! only re-wraps the settings key, so the marks open under every root the account
//! has had, one a server replays from before a rotation included. The record is
//! found by a slot that needs no key (SHA-256 of `hushos/rollback-marks/slot/v1`,
//! a zero byte and the user id, cut to 16 bytes, base64url), so a record that is
//! there and does not open is told apart from none and refused. The associated
//! data `["hushos/rollback-marks",1,userId,slot]` binds a record to its account.
//!
//! Envelope: base64url of `[1][24-byte nonce][XChaCha20-Poly1305 of the marks as
//! JSON]`, the JSON `{"settings":…,"settingsDocument":…,"identity":…,"identityVersion":…}`.

use crate::bytes::{decode, encode, random, NONCE_BYTES, TAG_BYTES};
use crate::canonical::{encode_statement, uuid};
use crate::contacts::hkdf;
use crate::envelope::{open_with_nonce, seal_with_nonce};
use crate::error::{input, CoreError, CoreResult};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const KEY_INFO: &[u8] = b"hushos/rollback-marks/v1";
const SLOT_LABEL: &str = "hushos/rollback-marks/slot/v1";
const DOMAIN: &str = "hushos/rollback-marks";
const VERSION: u8 = 1;
/* The largest integer a JavaScript reader keeps exactly: the web's marks are numbers. */
const MAX_SAFE: u64 = (1 << 53) - 1;
const UNREADABLE: &str = "These rollback marks could not be read.";

/// What a device has seen of one account; zeros and false for nothing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RollbackMarks {
    /// The highest settings sequence seen.
    pub settings: u64,
    /// Whether a version 2 settings document has been opened or saved here.
    pub settings_document: bool,
    /// The highest own identity key version opened.
    pub identity: u64,
    /// The highest own identity form opened (1, or 2 once upgraded).
    pub identity_version: u64,
}

impl RollbackMarks {
    /* `self` raised to at least `to`, field by field: no mark is ever lowered. */
    fn highest(self, to: RollbackMarks) -> RollbackMarks {
        RollbackMarks {
            settings: self.settings.max(to.settings),
            settings_document: self.settings_document || to.settings_document,
            identity: self.identity.max(to.identity),
            identity_version: self.identity_version.max(to.identity_version),
        }
    }
}

/// One update's outcome: the marks now, the envelope holding them, and whether it changed.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RollbackMarksUpdate {
    pub marks: RollbackMarks,
    pub envelope: String,
    pub changed: bool,
}

fn user(user_id: &str) -> CoreResult<String> {
    let lower = user_id.to_lowercase();
    uuid(&lower, "user id")?;
    Ok(lower)
}

/// Where this account's marks are kept on the device: found without a key, and not the id itself.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn rollback_marks_slot(user_id: String) -> CoreResult<String> {
    let user = user(&user_id)?;
    let digest = Sha256::digest(format!("{SLOT_LABEL}\u{0}{user}").as_bytes());
    Ok(encode(&digest[..16]))
}

fn context(user: &str, slot: &str) -> CoreResult<Vec<u8>> {
    encode_statement(&[json!(DOMAIN), json!(VERSION), json!(user), json!(slot)])
}

fn refused() -> CoreError {
    CoreError::Sealed(UNREADABLE.into())
}

fn sealing_key(settings_key: &[u8]) -> CoreResult<zeroize::Zeroizing<[u8; 32]>> {
    if settings_key.len() != 32 {
        return Err(input("Invalid settings key."));
    }
    hkdf(settings_key, KEY_INFO)
}

fn count(value: &Value) -> Option<u64> {
    value.as_u64().filter(|n| *n <= MAX_SAFE)
}

/* Marks as stored, or refused: anything else reads as a record that does not open. */
fn parse(plaintext: &[u8]) -> CoreResult<RollbackMarks> {
    let value: Value = serde_json::from_slice(plaintext).map_err(|_| refused())?;
    let field = |name: &str| value.get(name).ok_or_else(refused);
    Ok(RollbackMarks {
        settings: count(field("settings")?).ok_or_else(refused)?,
        settings_document: field("settingsDocument")?.as_bool().ok_or_else(refused)?,
        identity: count(field("identity")?).ok_or_else(refused)?,
        identity_version: count(field("identityVersion")?).ok_or_else(refused)?,
    })
}

pub(crate) fn seal_marks(settings_key: &[u8], user_id: &str, marks: RollbackMarks) -> CoreResult<String> {
    let user = user(user_id)?;
    let slot = rollback_marks_slot(user.clone())?;
    if [marks.settings, marks.identity, marks.identity_version].iter().any(|n| *n > MAX_SAFE) {
        return Err(input("These rollback marks are out of range."));
    }
    let plaintext = json!({
        "settings": marks.settings,
        "settingsDocument": marks.settings_document,
        "identity": marks.identity,
        "identityVersion": marks.identity_version,
    })
    .to_string();
    let key = sealing_key(settings_key)?;
    let nonce = random(NONCE_BYTES);
    let sealed = seal_with_nonce(key.as_slice(), &nonce, plaintext.as_bytes(), &context(&user, &slot)?)?;
    let mut out = Vec::with_capacity(1 + NONCE_BYTES + sealed.len());
    out.push(VERSION);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(encode(&out))
}

/* The marks `envelope` holds for this account, or `Sealed`: never "none". */
pub(crate) fn open_marks(settings_key: &[u8], user_id: &str, envelope: &str) -> CoreResult<RollbackMarks> {
    let user = user(user_id)?;
    let slot = rollback_marks_slot(user.clone())?;
    let key = sealing_key(settings_key)?;
    let bytes = decode("rollback marks", envelope, None).map_err(|_| refused())?;
    if bytes.len() < 1 + NONCE_BYTES + TAG_BYTES || bytes[0] != VERSION {
        return Err(refused());
    }
    let plaintext = open_with_nonce(
        key.as_slice(),
        &bytes[1..1 + NONCE_BYTES],
        &bytes[1 + NONCE_BYTES..],
        &context(&user, &slot)?,
    )
    .map_err(|_| refused())?;
    parse(&plaintext)
}

/// One update of the marks under one settings key: the record `envelope` holds (none for a
/// first record) is opened, raised to at least `to`, and sealed again under the same key, or
/// left as it is when nothing rises. A record that does not open under this key is refused
/// (`Sealed`), never sealed over: the marks only ever move to a key they opened under.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn rollback_marks_update(
    settings_key: Vec<u8>,
    user_id: String,
    envelope: Option<String>,
    to: RollbackMarks,
) -> CoreResult<RollbackMarksUpdate> {
    let current = match &envelope {
        Some(envelope) => open_marks(&settings_key, &user_id, envelope)?,
        None => RollbackMarks::default(),
    };
    let next = current.highest(to);
    match envelope {
        Some(envelope) if next == current => {
            Ok(RollbackMarksUpdate { marks: current, envelope, changed: false })
        }
        _ => Ok(RollbackMarksUpdate {
            marks: next,
            envelope: seal_marks(&settings_key, &user_id, next)?,
            changed: true,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "6b1a3f0e-2c4d-4e5f-8a9b-0c1d2e3f4a5b";
    const OTHER: &str = "0d4f2a1b-9c8e-4f7a-b6d5-e4c3b2a1f0e9";
    const KEY: [u8; 32] = [7; 32];

    /* Sealed by packages/crypto's sealRollbackMarks under KEY for USER (rollback-marks.test.ts's twin). */
    const WEB_SLOT: &str = "dm3BIs9g8rvG3OeM5lsOQA";
    const WEB_ENVELOPE: &str = "AUfIZtbpr-4vLR7sZFkdlrCMXpb1vIeilHEDaelHKtRKX-wERGvQWy3Ytu-I0l_ZcBFLz90kpQ7bRCltpD3IoehrE8pOY54w4xJZqyH-lGNnTBcAN5sAbVpzDrRqIAiUdRpuZULLyYbHCaxVScqrIQ";

    fn marks(settings: u64, identity: u64) -> RollbackMarks {
        RollbackMarks { settings, settings_document: true, identity, identity_version: 2 }
    }

    #[test]
    fn opens_what_the_web_sealed() {
        assert_eq!(rollback_marks_slot(USER.into()).unwrap(), WEB_SLOT);
        assert_eq!(open_marks(&KEY, USER, WEB_ENVELOPE).unwrap(), marks(9, 3));
        // The slot is the same for the id in capitals: the phones lowercase what the server sends.
        assert_eq!(rollback_marks_slot(USER.to_uppercase()).unwrap(), WEB_SLOT);
    }

    #[test]
    fn a_record_opens_only_for_its_account_and_key() {
        let sealed = seal_marks(&KEY, USER, marks(4, 2)).unwrap();
        assert_eq!(open_marks(&KEY, USER, &sealed).unwrap(), marks(4, 2));
        assert!(matches!(open_marks(&[8; 32], USER, &sealed), Err(CoreError::Sealed(_))));
        assert!(matches!(open_marks(&KEY, OTHER, &sealed), Err(CoreError::Sealed(_))));
        let mut bytes = decode("t", &sealed, None).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        assert!(matches!(open_marks(&KEY, USER, &encode(&bytes)), Err(CoreError::Sealed(_))));
        assert!(matches!(open_marks(&KEY, USER, "not base64!"), Err(CoreError::Sealed(_))));
        assert!(matches!(open_marks(&KEY, USER, &encode(&[1; 40])), Err(CoreError::Sealed(_))));
    }

    #[test]
    fn an_update_never_lowers_and_never_seals_over_a_record_it_cannot_open() {
        let first = rollback_marks_update(KEY.to_vec(), USER.into(), None, marks(5, 2)).unwrap();
        assert!(first.changed);
        let lower = rollback_marks_update(
            KEY.to_vec(),
            USER.into(),
            Some(first.envelope.clone()),
            RollbackMarks { settings: 3, settings_document: false, identity: 1, identity_version: 1 },
        )
        .unwrap();
        assert!(!lower.changed);
        assert_eq!(lower.envelope, first.envelope);
        assert_eq!(lower.marks, marks(5, 2));
        let raised = rollback_marks_update(
            KEY.to_vec(),
            USER.into(),
            Some(first.envelope.clone()),
            RollbackMarks { settings: 6, ..Default::default() },
        )
        .unwrap();
        assert!(raised.changed);
        assert_eq!(raised.marks, marks(6, 2));
        assert!(matches!(
            rollback_marks_update(vec![8; 32], USER.into(), Some(first.envelope), marks(9, 9)),
            Err(CoreError::Sealed(_))
        ));
    }

    #[test]
    fn marks_the_web_could_not_read_are_refused() {
        let out_of_range = RollbackMarks { settings: MAX_SAFE + 1, ..Default::default() };
        assert!(seal_marks(&KEY, USER, out_of_range).is_err());
        assert!(matches!(
            parse(br#"{"settings":1,"identity":1,"identityVersion":1}"#),
            Err(CoreError::Sealed(_))
        ));
        assert!(matches!(
            parse(br#"{"settings":-1,"settingsDocument":true,"identity":1,"identityVersion":1}"#),
            Err(CoreError::Sealed(_))
        ));
    }
}
