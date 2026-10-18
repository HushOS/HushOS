//! The settings document opened by the ledger itself (groups 1d, Core 6;
//! docs/groups-mobile-plan.md, Core 5a's residual), the twin of the web
//! worker's `settingsKeyOpen`/`settingsOpen` (`packages/crypto/src/session.ts`)
//! and of the session's settings marks (`packages/crypto/src/settings-marks.ts`,
//! which `session-groups.ts` calls):
//!
//! - [`AreaLedger::use_settings_envelope`] takes the envelopes the server
//!   serves (the settings key and the document), opens the key under the
//!   account root [`AreaLedger::open_account`] holds, opens the document, and
//!   keeps its group pins and contact pins as the worker keeps them: the raw
//!   members of `groups` (each checked only when acceptance reads its
//!   family's, as `checkGroupPin` checks it) and of `contacts` in document
//!   order. A version 1 envelope is [`AreaLedger::legacy_settings`]; none is
//!   "no settings", refused after settings that opened in this unlock
//!   (decision D7).
//! - A contact pin is found as the worker's `contactPin` finds it: the first
//!   member whose key and whose `userId` both lowercase to the person's id.
//!   A member that is no object, or whose `userId` is no string, is skipped
//!   (the worker skips it too since this step; it threw a `TypeError` before).
//!
//! No app hands the ledger a pin any more: an admission, the admin's join code
//! and an admission's resend read only pins from a document the ledger opened.

use crate::area_ledger::{AreaLedger, HeldPin, NO_ACCOUNT};
use crate::bytes::{decode, KEY_BYTES, NONCE_BYTES};
use crate::canonical::uuid;
use crate::contacts::{hkdf, settings_context, SettingsEnvelope, SettingsKeyEnvelope};
use crate::envelope::open_with_nonce;
use crate::error::{input, CoreError, CoreResult};
use crate::group_trust::VerifiedPin;
use serde::de::{self, IgnoredAny, MapAccess, Visitor};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fmt;
use zeroize::Zeroizing;

/// The settings key or document did not open under this account's root: the
/// web's words for it (`decryptKey`).
pub const SETTINGS_NOT_OPENED: &str =
    "This encrypted key could not be opened. It may belong to a different account or version, or it may be damaged.";
const INVALID_ENCODING: &str = "Invalid key encoding.";
const OPEN_SETTINGS_KEY: &str = "Open your settings key first.";
const UNSUPPORTED_ENVELOPE: &str = "Unsupported settings envelope.";
const UNSUPPORTED_DOCUMENT: &str = "Unsupported settings document.";
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/* A served base64url field as the web's `decode` takes it: non-empty, canonical, of `length` bytes when given. */
fn web_decode(value: &str, length: Option<usize>) -> CoreResult<Vec<u8>> {
    if value.is_empty() {
        return Err(input(INVALID_ENCODING));
    }
    decode("value", value, length).map_err(|_| input(INVALID_ENCODING))
}

/* The settings key out of its envelope under the root, as the worker's openSettingsKey opens it. */
fn open_settings_key(
    user_id: &str,
    root: &[u8],
    envelope: &SettingsKeyEnvelope,
) -> CoreResult<Zeroizing<Vec<u8>>> {
    let wrap = hkdf(root, b"hushos/settings-key-wrap/v1")?;
    let ciphertext = web_decode(&envelope.ciphertext, Some(KEY_BYTES + 16))?;
    let nonce = web_decode(&envelope.nonce, Some(NONCE_BYTES))?;
    let key = open_with_nonce(wrap.as_slice(), &nonce, &ciphertext, user_id.to_lowercase().as_bytes())
        .map_err(|_| CoreError::Sealed(SETTINGS_NOT_OPENED.into()))?;
    Ok(Zeroizing::new(key))
}

/* A version 2 document's plaintext under the settings key, as the worker's openSettings opens it. */
fn open_document(user_id: &str, key: &[u8], envelope: &SettingsEnvelope) -> CoreResult<Zeroizing<Vec<u8>>> {
    let ciphertext = web_decode(&envelope.ciphertext, None)?;
    let nonce = web_decode(&envelope.nonce, Some(NONCE_BYTES))?;
    let aad = settings_context(user_id, 2, envelope.settings_version);
    let plaintext = open_with_nonce(key, &nonce, &ciphertext, &aad)
        .map_err(|_| CoreError::Sealed(SETTINGS_NOT_OPENED.into()))?;
    Ok(Zeroizing::new(plaintext))
}

/* What the worker keeps of an opened document: the group pins by family id and the contacts in order. */
pub(crate) struct SettingsReading {
    pub(crate) pins: HashMap<String, Value>,
    pub(crate) contacts: Vec<(String, Value)>,
}

/* The `contacts` member as JavaScript holds it: an object's members in order (a key again keeps its place, takes the last value), or what kind it was. */
enum Contacts {
    Members(Vec<(String, Value)>),
    /* An array or null: `typeof` says object, and spreading it gives no member keyed by a user id. */
    Empty,
    /* A string, number or boolean: not a settings document. */
    Scalar,
}

impl<'de> de::Deserialize<'de> for Contacts {
    fn deserialize<D: de::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Members;
        impl<'de> Visitor<'de> for Members {
            type Value = Contacts;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Contacts, A::Error> {
                let mut members: Vec<(String, Value)> = vec![];
                while let Some((key, value)) = map.next_entry::<String, Value>()? {
                    match members.iter_mut().find(|(at, _)| *at == key) {
                        Some(member) => member.1 = value,
                        None => members.push((key, value)),
                    }
                }
                Ok(Contacts::Members(members))
            }
            fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Contacts, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Contacts::Empty)
            }
            fn visit_unit<E: de::Error>(self) -> Result<Contacts, E> {
                Ok(Contacts::Empty)
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Contacts, E> {
                Ok(Contacts::Scalar)
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Contacts, E> {
                Ok(Contacts::Scalar)
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Contacts, E> {
                Ok(Contacts::Scalar)
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Contacts, E> {
                Ok(Contacts::Scalar)
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Contacts, E> {
                Ok(Contacts::Scalar)
            }
        }
        deserializer.deserialize_any(Members)
    }
}

/* The document's top level: every member as a Value (the last of a repeated key), and `contacts` in order. */
enum Top {
    Object { members: Map<String, Value>, contacts: Option<Contacts> },
    Other,
}

impl<'de> de::Deserialize<'de> for Top {
    fn deserialize<D: de::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Document;
        impl<'de> Visitor<'de> for Document {
            type Value = Top;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Top, A::Error> {
                let (mut members, mut contacts) = (Map::new(), None);
                while let Some(key) = map.next_key::<String>()? {
                    if key == "contacts" {
                        contacts = Some(map.next_value::<Contacts>()?);
                    } else {
                        members.insert(key, map.next_value::<Value>()?);
                    }
                }
                Ok(Top::Object { members, contacts })
            }
            fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Top, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Top::Other)
            }
            fn visit_unit<E: de::Error>(self) -> Result<Top, E> {
                Ok(Top::Other)
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Top, E> {
                Ok(Top::Other)
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Top, E> {
                Ok(Top::Other)
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Top, E> {
                Ok(Top::Other)
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Top, E> {
                Ok(Top::Other)
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Top, E> {
                Ok(Top::Other)
            }
        }
        deserializer.deserialize_any(Document)
    }
}

/*
 * An opened document's plaintext, read as the worker reads it: UTF-8 decoded as TextDecoder does
 * (malformed bytes replaced, a leading BOM dropped), parsed as JSON, then `readSettingsDocument`'s
 * shape check (an object or array, `version` the number 1 or 2, `contacts` an object, array or
 * null), and `{ ...groups }`, `{ ...contacts }` kept.
 */
pub(crate) fn read_document(plaintext: &[u8]) -> CoreResult<SettingsReading> {
    let text = String::from_utf8_lossy(plaintext);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let unsupported = || input(UNSUPPORTED_DOCUMENT);
    let mut parser = serde_json::Deserializer::from_str(text);
    let top: Top = de::Deserialize::deserialize(&mut parser).map_err(|_| unsupported())?;
    parser.end().map_err(|_| unsupported())?;
    let Top::Object { members, contacts } = top else { return Err(unsupported()) };
    let version = members.get("version").and_then(Value::as_f64);
    if version != Some(1.0) && version != Some(2.0) {
        return Err(unsupported());
    }
    let contacts = match contacts {
        Some(Contacts::Members(members)) => members,
        Some(Contacts::Empty) => vec![],
        Some(Contacts::Scalar) | None => return Err(unsupported()),
    };
    let pins = match members.get("groups") {
        Some(Value::Object(groups)) => groups.iter().map(|(id, pin)| (id.clone(), pin.clone())).collect(),
        _ => HashMap::new(),
    };
    Ok(SettingsReading { pins, contacts })
}

/* A contact pin as the worker reads one: its `userId`, and each field it compares only when it is a string. */
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ContactPin {
    pub(crate) user_id: String,
    pub(crate) encryption_public_key: Option<String>,
    pub(crate) signing_public_key: Option<String>,
    pub(crate) fingerprint: Option<String>,
    pub(crate) ml_dsa_public_key_hash: Option<String>,
    pub(crate) kem_public_key_hash: Option<String>,
    /* `trustedVia` absent or null: the pin stands for a words check, not a group's word. */
    pub(crate) words_checked: bool,
}

impl ContactPin {
    fn of(value: &Value) -> Option<ContactPin> {
        let pin = value.as_object()?;
        let text = |key: &str| pin.get(key).and_then(Value::as_str).map(str::to_string);
        Some(ContactPin {
            user_id: text("userId")?,
            encryption_public_key: text("encryptionPublicKey"),
            signing_public_key: text("signingPublicKey"),
            fingerprint: text("fingerprint"),
            ml_dsa_public_key_hash: text("mlDsaPublicKeyHash"),
            kem_public_key_hash: text("kemPublicKeyHash"),
            words_checked: matches!(pin.get("trustedVia"), None | Some(Value::Null)),
        })
    }

    /// The pin as an admission takes it ([`crate::roster_entry_new`]): only a
    /// words check with every key part a string; anything else admits no one
    /// (the worker's `newRosterEntry` refuses it with the same words).
    pub(crate) fn checked(&self) -> Option<VerifiedPin> {
        if !self.words_checked {
            return None;
        }
        Some(VerifiedPin {
            user_id: self.user_id.clone(),
            key_version: 1,
            encryption_public_key: self.encryption_public_key.clone()?,
            signing_public_key: self.signing_public_key.clone()?,
            ml_dsa_public_key_hash: self.ml_dsa_public_key_hash.clone()?,
            kem_public_key_hash: self.kem_public_key_hash.clone()?,
            fingerprint: self.fingerprint.clone()?,
            trusted_via: None,
        })
    }
}

/* The worker's contactPin over a document's contacts: the first member whose key and `userId` both lowercase to `user_id`. */
pub(crate) fn contact_pin_of(contacts: &[(String, Value)], user_id: &str) -> Option<ContactPin> {
    let wanted = user_id.to_lowercase();
    contacts
        .iter()
        .filter(|(key, _)| key.to_lowercase() == wanted)
        .filter_map(|(_, value)| ContactPin::of(value))
        .find(|pin| pin.user_id.to_lowercase() == wanted)
}

/* A typed pin as the settings document carries it (camelCase, `trustedVia` only when set): the fixtures' use_settings. */
#[cfg(feature = "fixtures")]
pub(crate) fn contact_json(pin: &VerifiedPin) -> Value {
    let mut out = serde_json::json!({
        "userId": pin.user_id,
        "keyVersion": pin.key_version,
        "encryptionPublicKey": pin.encryption_public_key,
        "signingPublicKey": pin.signing_public_key,
        "mlDsaPublicKeyHash": pin.ml_dsa_public_key_hash,
        "kemPublicKeyHash": pin.kem_public_key_hash,
        "fingerprint": pin.fingerprint,
    });
    if let Some(via) = &pin.trusted_via {
        out["trustedVia"] = Value::String(via.clone());
    }
    out
}

#[cfg(test)]
type LedgerHook = Option<Box<dyn Fn(&AreaLedger)>>;
#[cfg(test)]
thread_local! {
    static AFTER_OPENING_SETTINGS: std::cell::RefCell<LedgerHook> = const { std::cell::RefCell::new(None) };
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl AreaLedger {
    /// The account's settings as the server serves them, opened here: the
    /// settings key's envelope (`key_envelope`, as `GET /api/auth/settings`
    /// serves it beside the document) under the account root
    /// [`AreaLedger::open_account`] holds, then the document
    /// (`settings_envelope`), whose group pins acceptance takes as marks and
    /// whose contact pins are the only ones an admission, the admin's join
    /// code and an admission's resend read. The worker's `settingsKeyOpen`
    /// then `settingsOpen`, in its order:
    ///
    /// - none served: "no settings" for the account open (`Unlock your
    ///   account first.` for another), refused after settings that opened in
    ///   this unlock (decision D7);
    /// - an envelope whose version is not 1 or 2, or whose settings version
    ///   is not 1 to 2^53 − 1: refused;
    /// - version 1 (sealed under the identity, which opens nowhere now):
    ///   [`AreaLedger::legacy_settings`];
    /// - version 2: the account open (`Unlock your account first.`), the key
    ///   envelope (`Open your settings key first.`), the key and the document
    ///   opened under this account's root ([`SETTINGS_NOT_OPENED`],
    ///   `CoreError::Sealed`; a field that is not canonical base64url is
    ///   `Invalid key encoding.`), the document read (`Unsupported settings
    ///   document.`), then, under the lock, still the account and root it was
    ///   opened under (`NOT_THIS_ACCOUNT`: unlock again and read again).
    ///
    /// A malformed group pin refuses only its family's acceptance, as the
    /// worker refuses it; a malformed contact pin is no pin.
    ///
    /// ```
    /// use hushos_core::*;
    /// let ledger = AreaLedger::new();
    /// let user = "00000001-abcd-4abc-8abc-abcdefabcdef".to_string();
    /// let root = vec![7u8; 32];
    /// let identity = identity_create(user.clone(), root.clone(), 1)?;
    /// // Locked: no settings are taken, not even none.
    /// assert!(ledger.use_settings_envelope(user.clone(), None, None).is_err());
    /// ledger.open_account(user.clone(), base64url_decode(identity.signing_public_key.clone())?, root.clone())?;
    /// let made = settings_key_create(user.clone(), root)?;
    /// let document = settings_seal(user.clone(), made.key.to_vec(), 1, r#"{"version":2,"contacts":{}}"#.into())?;
    /// ledger.use_settings_envelope(user.clone(), Some(made.envelope.clone()), Some(document))?;
    /// // Settings that opened never give way to none within one unlock.
    /// let none = ledger.use_settings_envelope(user.clone(), None, None).unwrap_err();
    /// assert_eq!(none.to_string(), "The server sent older settings than this device has opened, so nothing was changed.");
    /// // A key wrapped under another account's root opens nothing.
    /// let other = settings_key_create(user.clone(), vec![8u8; 32])?;
    /// let sealed = settings_seal(user.clone(), other.key.to_vec(), 2, r#"{"version":2,"contacts":{}}"#.into())?;
    /// let refused = ledger.use_settings_envelope(user, Some(other.envelope), Some(sealed)).unwrap_err();
    /// assert!(matches!(refused, CoreError::Sealed(message) if message == SETTINGS_NOT_OPENED));
    /// # Ok::<(), hushos_core::CoreError>(())
    /// ```
    pub fn use_settings_envelope(
        &self,
        user_id: String,
        key_envelope: Option<SettingsKeyEnvelope>,
        settings_envelope: Option<SettingsEnvelope>,
    ) -> CoreResult<()> {
        uuid(&user_id, "user id")?;
        let unlocked = || {
            self.unlocked()
                .filter(|(held, _, _)| held.eq_ignore_ascii_case(&user_id))
                .ok_or_else(|| input(NO_ACCOUNT))
        };
        let Some(envelope) = settings_envelope else {
            let (_, generation, root) = unlocked()?;
            return self.set_settings(&user_id, false, HashMap::new(), vec![], Some((generation, &root)));
        };
        if !(1..=2).contains(&envelope.version)
            || !(1..=MAX_SAFE_INTEGER).contains(&envelope.settings_version)
        {
            return Err(input(UNSUPPORTED_ENVELOPE));
        }
        if envelope.version == 1 {
            return self.legacy_settings(user_id);
        }
        let (_, generation, root) = unlocked()?;
        let key_envelope = key_envelope.ok_or_else(|| input(OPEN_SETTINGS_KEY))?;
        let key = open_settings_key(&user_id, &root, &key_envelope)?;
        let plaintext = open_document(&user_id, &key, &envelope)?;
        let reading = read_document(&plaintext)?;
        // Tests only: a lock or another account while the document was opened.
        #[cfg(test)]
        AFTER_OPENING_SETTINGS.with(|hook| {
            if let Some(hook) = hook.borrow().as_ref() {
                hook(self)
            }
        });
        let pins = reading.pins.into_iter().map(|(id, pin)| (id, HeldPin::Raw(pin))).collect();
        self.set_settings(&user_id, true, pins, reading.contacts, Some((generation, &root)))
    }
}

/// A settings document's plaintext read as the ledger reads it, with what
/// each probe finds: for each of `user_ids` the contact pin (its key parts
/// and fingerprint where they are strings, whether an admission takes it as
/// a words check), for each of `group_ids` the group pin's verdict. For the
/// shared fixtures and the fuzz kind `settings` only (`readSettingsDocument`
/// and the worker's marks in the web twin).
#[cfg(feature = "fixtures")]
#[doc(hidden)]
pub fn settings_document_verdict(plaintext: &[u8], user_ids: &[String], group_ids: &[String]) -> Value {
    use serde_json::json;
    let reading = match read_document(plaintext) {
        Ok(reading) => reading,
        Err(error) => return json!({ "status": "refused", "message": error.to_string() }),
    };
    let mut contacts = Map::new();
    for user_id in user_ids {
        let found = contact_pin_of(&reading.contacts, user_id).map(|pin| {
            let checked = pin.checked().is_some_and(|checked| {
                crate::pin_verified(
                    checked.encryption_public_key,
                    checked.signing_public_key,
                    Some(checked.ml_dsa_public_key_hash),
                    Some(checked.kem_public_key_hash),
                    checked.fingerprint,
                )
            });
            json!({
                "userId": pin.user_id,
                "keys": [pin.encryption_public_key, pin.signing_public_key, pin.ml_dsa_public_key_hash, pin.kem_public_key_hash],
                "fingerprint": pin.fingerprint,
                "checked": checked,
            })
        });
        contacts.insert(user_id.clone(), found.unwrap_or(Value::Null));
    }
    let mut groups = Map::new();
    for group_id in group_ids {
        let verdict = match reading.pins.get(group_id) {
            None | Some(Value::Null) => Value::Null,
            Some(pin) => match crate::device_record::pin_of(group_id, pin) {
                Ok(pin) => json!({ "pin": crate::device_record::pin_json(&pin) }),
                Err(error) => json!({ "refused": error.to_string() }),
            },
        };
        groups.insert(group_id.clone(), verdict);
    }
    json!({ "status": "read", "contacts": contacts, "groups": groups })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{identity_create, settings_key_create, settings_seal};
    use serde_json::json;

    const USER: &str = "00000001-abcd-4abc-8abc-abcdefabcdef";
    const OTHER: &str = "00000002-abcd-4abc-8abc-abcdefabcdef";

    fn ledger() -> (std::sync::Arc<AreaLedger>, Vec<u8>) {
        let ledger = AreaLedger::new();
        let root = vec![7u8; 32];
        let identity = identity_create(USER.into(), root.clone(), 1).unwrap();
        let signing = crate::base64url_decode(identity.signing_public_key).unwrap();
        ledger.open_account(USER.into(), signing, root.clone()).unwrap();
        (ledger, root)
    }

    fn sealed(root: &[u8], json: &str) -> (SettingsKeyEnvelope, SettingsEnvelope) {
        let made = settings_key_create(USER.into(), root.to_vec()).unwrap();
        let document = settings_seal(USER.into(), made.key.to_vec(), 3, json.into()).unwrap();
        (made.envelope, document)
    }

    fn pin(user: &str, keys: &str) -> Value {
        json!({ "userId": user, "encryptionPublicKey": keys, "signingPublicKey": keys,
            "mlDsaPublicKeyHash": "aa", "kemPublicKeyHash": "bb", "fingerprint": "f" })
    }

    #[test]
    fn contact_pins_are_found_as_the_worker_finds_them() {
        let upper = USER.to_uppercase();
        // The first member whose key and userId both lowercase to the id, in document order.
        let contacts = vec![
            (USER.to_string(), pin(OTHER, "misfiled")),
            (upper.clone(), pin(&upper, "first")),
            (USER.to_string(), pin(USER, "second")),
        ];
        let found = contact_pin_of(&contacts, USER).unwrap();
        assert_eq!(found.encryption_public_key.as_deref(), Some("first"));
        assert_eq!(found.user_id, upper, "the pin's own userId, as filed");
        // A misfiled member is no pin of either person.
        assert_eq!(contact_pin_of(&contacts[..1], USER), None);
        assert_eq!(contact_pin_of(&contacts[..1], OTHER), None);
        // A member that is no object, or whose userId is no string, is skipped, not a refusal.
        let junk = vec![(USER.to_string(), json!("junk")), (USER.to_string(), json!({ "userId": 7 }))];
        assert_eq!(contact_pin_of(&junk, USER), None);
    }

    #[test]
    fn an_admission_takes_only_a_words_check_with_every_key_part() {
        let words = ContactPin::of(&pin(USER, "k")).unwrap();
        assert!(words.checked().is_some());
        let mut via = pin(USER, "k");
        via["trustedVia"] = json!("0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a");
        assert_eq!(ContactPin::of(&via).unwrap().checked(), None, "a group's word admits no one");
        // Any non-null trustedVia, as the worker's `!== undefined && !== null`.
        via["trustedVia"] = json!(false);
        assert_eq!(ContactPin::of(&via).unwrap().checked(), None);
        via["trustedVia"] = Value::Null;
        assert!(ContactPin::of(&via).unwrap().checked().is_some(), "null is a words check");
        for key in [
            "encryptionPublicKey",
            "signingPublicKey",
            "mlDsaPublicKeyHash",
            "kemPublicKeyHash",
            "fingerprint",
        ] {
            let mut short = pin(USER, "k");
            short[key] = json!(1);
            assert_eq!(ContactPin::of(&short).unwrap().checked(), None, "{key} not a string");
        }
    }

    #[test]
    fn the_document_is_read_as_the_worker_reads_it() {
        let read = |text: &str| read_document(text.as_bytes());
        // The shape check: an object, version the number 1 or 2, contacts an object, array or null.
        assert!(read(r#"{"version":2,"contacts":{}}"#).is_ok());
        assert!(read(r#"{"version":1.0,"contacts":null}"#).is_ok(), "1.0 is 1, typeof null is object");
        assert!(read(r#"{"version":2,"contacts":[]}"#).is_ok());
        for bad in [
            r#"{"version":3,"contacts":{}}"#,
            r#"{"version":"2","contacts":{}}"#,
            r#"{"version":2}"#,
            r#"{"version":2,"contacts":"x"}"#,
            r#"[2]"#,
            r#"null"#,
            r#"{"version":2,"contacts":{}} x"#,
            "not json",
        ] {
            assert_eq!(read(bad).err(), Some(input(UNSUPPORTED_DOCUMENT)), "{bad}");
        }
        // A repeated key takes the last value; within contacts it keeps its first place.
        let doc = read(
            r#"{"version":2,"contacts":{"b":1,"a":2,"b":3},"groups":{"g":1,"g":{"x":1}},"contacts":{"c":4,"a":5,"c":6}}"#,
        )
        .unwrap();
        assert_eq!(doc.contacts, vec![("c".to_string(), json!(6)), ("a".to_string(), json!(5))]);
        assert_eq!(doc.pins["g"], json!({ "x": 1 }));
        // Groups that are no object hold no pins; a BOM and malformed bytes read as TextDecoder reads them.
        assert!(read(r#"{"version":2,"contacts":{},"groups":[1]}"#).unwrap().pins.is_empty());
        assert!(read_document("\u{feff}{\"version\":2,\"contacts\":{}}".as_bytes()).is_ok());
        let mut bytes = br#"{"version":2,"contacts":{},"name":"#.to_vec();
        bytes.extend_from_slice(b"\"\xff\"}");
        assert!(read_document(&bytes).is_ok());
        // Trailing padding (spaces, as both twins pad) is whitespace JSON ignores.
        assert!(read(&format!("{}{}", r#"{"version":2,"contacts":{}}"#, " ".repeat(900))).is_ok());
    }

    #[test]
    fn served_envelopes_open_only_under_this_account_s_root() {
        let (ledger, root) = ledger();
        let doc = format!(r#"{{"version":2,"contacts":{{"{OTHER}":{}}}}}"#, pin(OTHER, "k"));
        let (key, document) = sealed(&root, &doc);
        ledger.use_settings_envelope(USER.into(), Some(key.clone()), Some(document.clone())).unwrap();
        assert_eq!(ledger.contact_pin(OTHER).unwrap().encryption_public_key.as_deref(), Some("k"));
        // Another root's key, a flipped byte, another settings version, another account: none opens.
        let (foreign, _) = sealed(&[8u8; 32], &doc);
        let sealed_error = Err(CoreError::Sealed(SETTINGS_NOT_OPENED.into()));
        assert_eq!(
            ledger.use_settings_envelope(USER.into(), Some(foreign), Some(document.clone())),
            sealed_error
        );
        let mut flipped = document.clone();
        let mut bytes = crate::base64url_decode(flipped.ciphertext.clone()).unwrap();
        bytes[0] ^= 1;
        flipped.ciphertext = crate::base64url_encode(bytes);
        assert_eq!(ledger.use_settings_envelope(USER.into(), Some(key.clone()), Some(flipped)), sealed_error);
        let moved = SettingsEnvelope { settings_version: 4, ..document.clone() };
        assert_eq!(ledger.use_settings_envelope(USER.into(), Some(key.clone()), Some(moved)), sealed_error);
        assert_eq!(
            ledger.use_settings_envelope(OTHER.into(), Some(key.clone()), Some(document.clone())),
            Err(input(NO_ACCOUNT))
        );
        // A refusal keeps the settings held.
        assert!(ledger.contact_pin(OTHER).is_some());
        // The envelope's own checks come before the key's.
        let three = SettingsEnvelope { version: 3, ..document.clone() };
        assert_eq!(
            ledger.use_settings_envelope(USER.into(), None, Some(three)),
            Err(input(UNSUPPORTED_ENVELOPE))
        );
        let zero = SettingsEnvelope { settings_version: 0, ..document.clone() };
        assert_eq!(
            ledger.use_settings_envelope(USER.into(), None, Some(zero)),
            Err(input(UNSUPPORTED_ENVELOPE))
        );
        let past = SettingsEnvelope { settings_version: 1 << 53, ..document.clone() };
        assert_eq!(
            ledger.use_settings_envelope(USER.into(), None, Some(past)),
            Err(input(UNSUPPORTED_ENVELOPE))
        );
        assert_eq!(
            ledger.use_settings_envelope(USER.into(), None, Some(document.clone())),
            Err(input(OPEN_SETTINGS_KEY))
        );
        let padded = SettingsKeyEnvelope { nonce: format!("{}=", key.nonce), ..key.clone() };
        assert_eq!(
            ledger.use_settings_envelope(USER.into(), Some(padded), Some(document.clone())),
            Err(input(INVALID_ENCODING))
        );
        let empty = SettingsEnvelope { ciphertext: String::new(), ..document };
        assert_eq!(
            ledger.use_settings_envelope(USER.into(), Some(key), Some(empty)),
            Err(input(INVALID_ENCODING))
        );
    }

    #[test]
    fn none_and_version_1_never_replace_settings_that_opened() {
        let (ledger, root) = ledger();
        // Before anything opened: none is "no settings", version 1 sets nothing.
        ledger.use_settings_envelope(USER.into(), None, None).unwrap();
        assert_eq!(ledger.settings_pin(USER, "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"), Ok(Ok(None)));
        let (key, document) = sealed(&root, r#"{"version":2,"contacts":{}}"#);
        let legacy = SettingsEnvelope { version: 1, ..document.clone() };
        ledger.use_settings_envelope(USER.into(), None, Some(legacy.clone())).unwrap();
        ledger.use_settings_envelope(USER.into(), Some(key), Some(document)).unwrap();
        let older = Err(input(crate::area_ledger::OLDER_SETTINGS));
        assert_eq!(ledger.use_settings_envelope(USER.into(), None, None), older);
        assert_eq!(ledger.use_settings_envelope(USER.into(), None, Some(legacy)), older);
    }

    #[test]
    fn group_pins_are_checked_when_their_family_is_read_and_only_theirs() {
        let (ledger, root) = ledger();
        let (good, bad) = ("0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a", "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b");
        let null = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
        let doc =
            format!(r#"{{"version":2,"contacts":{{}},"groups":{{"{bad}":{{"junk":1}},"{null}":null}}}}"#);
        let (key, document) = sealed(&root, &doc);
        ledger.use_settings_envelope(USER.into(), Some(key), Some(document)).unwrap();
        assert_eq!(ledger.settings_pin(USER, good), Ok(Ok(None)));
        assert_eq!(
            ledger.settings_pin(USER, null),
            Ok(Ok(None)),
            "a null pin is none, as the worker filters it"
        );
        assert!(matches!(ledger.settings_pin(USER, bad), Ok(Err(_))), "refused for its family only");
        // Exactly as filed: another case of the family id is another key.
        assert_eq!(ledger.settings_pin(USER, &bad.to_uppercase()), Ok(Ok(None)));
    }

    #[test]
    fn a_lock_while_the_document_opened_keeps_nothing_of_it() {
        let (ledger, root) = ledger();
        let doc = format!(r#"{{"version":2,"contacts":{{"{OTHER}":{}}}}}"#, pin(OTHER, "k"));
        let (key, document) = sealed(&root, &doc);
        AFTER_OPENING_SETTINGS.with(|hook| *hook.borrow_mut() = Some(Box::new(|ledger| ledger.clear())));
        let refused = ledger.use_settings_envelope(USER.into(), Some(key.clone()), Some(document.clone()));
        AFTER_OPENING_SETTINGS.with(|hook| *hook.borrow_mut() = None);
        assert_eq!(refused, Err(input(crate::NOT_THIS_ACCOUNT)));
        assert!(ledger.contact_pin(OTHER).is_none());
        // The same account opened again with another root (a master-key rotation) is no longer the root it opened under.
        let identity = identity_create(USER.into(), root.clone(), 1).unwrap();
        let signing = crate::base64url_decode(identity.signing_public_key).unwrap();
        ledger.open_account(USER.into(), signing.clone(), root.clone()).unwrap();
        AFTER_OPENING_SETTINGS.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move |ledger| {
                ledger.open_account(USER.into(), signing.clone(), vec![9u8; 32]).unwrap()
            }))
        });
        let rotated = ledger.use_settings_envelope(USER.into(), Some(key), Some(document));
        AFTER_OPENING_SETTINGS.with(|hook| *hook.borrow_mut() = None);
        assert_eq!(rotated, Err(input(crate::NOT_THIS_ACCOUNT)));
    }
}
