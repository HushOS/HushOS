//! Approving on another device, as the second step (`docs/two-step-design.md` 12,
//! `docs/devices-design.md` 2): what the asking device and the approving device both
//! build. The twin of `packages/crypto/src/device-approval.ts`; the server's copy is
//! `packages/db/src/signatures.ts`.
//!
//! The asking device holds the step token. It commits to its signing key and a nonce
//! before it sees anything of the approving device:
//!
//! ```text
//! commitment = SHA-256("hushos/two-step/device/commit/v1" || purpose || sha256(stepToken) || deviceSigningKey || nonce)
//! ```
//!
//! One approving device opens the request with 32 fresh bytes of its own, and only then
//! does the asking device reveal its key and nonce. Both compute
//!
//! ```text
//! code = SHA-256("hushos/two-step/device/v1" || userId || requestId || purpose || sha256(stepToken) || deviceSigningKey || approverEphemeralKey || nonce)
//! ```
//!
//! shown as two digits and a word ("47 river"): the first four bytes as a big-endian
//! integer, mod 100, and the BIP-39 word the next 11 bits index. The person types on the
//! approving device what the asking device shows; only an exact match is approved, with
//! the approving device's key over
//!
//! ```text
//! ["hushos/two-step/device",1,userId,requestId,purpose,sha256(stepToken),deviceSigningKey]
//! ```
//!
//! Labels and the purpose are ASCII, ids lowercase UUIDs, the token digest the SHA-256
//! of the step token's UTF-8 bytes; keys, nonce and digest are 32 bytes each. Nothing
//! here talks to a server or decides who may approve: the server does.

use crate::bytes::{decode, encode};
use crate::envelope::context;
use crate::error::{input, CoreResult};
use crate::recovery::wordlist;
use crate::signatures::{sign, verify};
use serde_json::{json, Map, Value};
use sha2::{Digest as _, Sha256};
use zeroize::Zeroizing;

const COMMIT_DOMAIN: &str = "hushos/two-step/device/commit/v1";
const CODE_DOMAIN: &str = "hushos/two-step/device/v1";
const STATEMENT_DOMAIN: &str = "hushos/two-step/device";
const QR_PREFIX: &str = "hushos-approve:";
/// How many prompts a day an approving device shows for each class of request.
const PROMPTS_A_DAY: usize = 5;

fn purpose_of(purpose: &str) -> CoreResult<&str> {
    let shaped = (2..=32).contains(&purpose.len())
        && purpose.starts_with(|first: char| first.is_ascii_lowercase())
        && purpose.chars().all(|character| character.is_ascii_lowercase() || character == '-');
    if shaped {
        Ok(purpose)
    } else {
        Err(input("Invalid device approval."))
    }
}

/* A lowercase UUID, as every id here is written. */
fn id_of(id: &str) -> CoreResult<String> {
    let lower = id.to_lowercase();
    let shaped = lower.len() == 36
        && lower.char_indices().all(|(index, character)| match index {
            8 | 13 | 18 | 23 => character == '-',
            _ => character.is_ascii_digit() || ('a'..='f').contains(&character),
        });
    if shaped {
        Ok(lower)
    } else {
        Err(input("Invalid device approval."))
    }
}

fn field(name: &str, value: &str) -> CoreResult<Vec<u8>> {
    decode(name, value, Some(32))
}

/// What the asking device posts before it has seen the approving device's key,
/// base64url. `token_digest` is `step_token_digest(step_token)`.
///
/// ```
/// use hushos_core::*;
/// let key = base64url_encode(vec![1; 32]);
/// let nonce = base64url_encode(vec![2; 32]);
/// let digest = step_token_digest("token".into());
/// let made = device_step_commitment("login".into(), digest.clone(), key.clone(), nonce.clone())?;
/// // Another purpose, token, key or nonce is another commitment.
/// assert_ne!(made, device_step_commitment("password".into(), digest.clone(), key.clone(), nonce.clone())?);
/// assert_ne!(made, device_step_commitment("login".into(), step_token_digest("other".into()), key, nonce)?);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn device_step_commitment(
    purpose: String,
    token_digest: String,
    device_signing_key: String,
    nonce: String,
) -> CoreResult<String> {
    let mut hash = Sha256::new();
    hash.update(COMMIT_DOMAIN.as_bytes());
    hash.update(purpose_of(&purpose)?.as_bytes());
    hash.update(field("token digest", &token_digest)?);
    hash.update(field("device key", &device_signing_key)?);
    hash.update(field("nonce", &nonce)?);
    Ok(encode(&hash.finalize()))
}

/// What a request is about, as both devices and the server name it: the account, the
/// request, the purpose of the step token, the token's digest and the asking device's
/// signing key (base64url).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct DeviceStep {
    pub user_id: String,
    pub request_id: String,
    pub purpose: String,
    pub token_digest: String,
    pub device_signing_key: String,
}

/// The code both devices show, such as "47 river".
///
/// ```
/// use hushos_core::*;
/// let step = DeviceStep {
///     user_id: "0f8fad5b-d9cb-469f-a165-70867728950e".into(),
///     request_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7".into(),
///     purpose: "login".into(),
///     token_digest: step_token_digest("token".into()),
///     device_signing_key: base64url_encode(vec![1; 32]),
/// };
/// let code = device_step_code(step, base64url_encode(vec![3; 32]), base64url_encode(vec![2; 32]))?;
/// let (digits, word) = code.split_once(' ').unwrap();
/// assert!(digits.len() == 2 && digits.chars().all(|digit| digit.is_ascii_digit()));
/// assert_eq!(approval_code_normalize(format!("{digits}{}", word.to_uppercase())), Some(code));
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn device_step_code(step: DeviceStep, approver_key: String, nonce: String) -> CoreResult<String> {
    let mut hash = Sha256::new();
    hash.update(CODE_DOMAIN.as_bytes());
    hash.update(id_of(&step.user_id)?.as_bytes());
    hash.update(id_of(&step.request_id)?.as_bytes());
    hash.update(purpose_of(&step.purpose)?.as_bytes());
    hash.update(field("token digest", &step.token_digest)?);
    hash.update(field("device key", &step.device_signing_key)?);
    hash.update(field("approver key", &approver_key)?);
    hash.update(field("nonce", &nonce)?);
    let digest = hash.finalize();
    let number = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 100;
    let index = (usize::from(digest[4]) << 3) | (usize::from(digest[5]) >> 5);
    Ok(format!("{number:02} {}", wordlist()[index]))
}

/// The code an approving device expects the person to type, once the asking device has
/// revealed. `commitment` is the one this device saw before it posted its own value (or
/// scanned from the other screen): what was revealed must be what was committed to, for
/// this purpose and token, or there is no honest device on the other side. Then it is an
/// error, and the app ends the request (`mismatch`) instead of showing a field.
///
/// ```
/// use hushos_core::*;
/// let (key, nonce, approver) = (base64url_encode(vec![1; 32]), base64url_encode(vec![2; 32]), base64url_encode(vec![3; 32]));
/// let step = DeviceStep {
///     user_id: "0f8fad5b-d9cb-469f-a165-70867728950e".into(),
///     request_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7".into(),
///     purpose: "login".into(),
///     token_digest: step_token_digest("token".into()),
///     device_signing_key: key.clone(),
/// };
/// let commitment = device_step_commitment("login".into(), step.token_digest.clone(), key, nonce.clone())?;
/// let code = approval_code_expected(step.clone(), commitment.clone(), approver.clone(), nonce.clone())?;
/// assert_eq!(code, device_step_code(step.clone(), approver.clone(), nonce.clone())?);
/// // Another key than the committed one: refused, never a code to type.
/// let mut swapped = step;
/// swapped.device_signing_key = base64url_encode(vec![9; 32]);
/// assert!(approval_code_expected(swapped, commitment, approver, nonce).is_err());
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn approval_code_expected(
    step: DeviceStep,
    commitment: String,
    approver_key: String,
    nonce: String,
) -> CoreResult<String> {
    let committed = device_step_commitment(
        step.purpose.clone(),
        step.token_digest.clone(),
        step.device_signing_key.clone(),
        nonce.clone(),
    )?;
    if field("commitment", &commitment)? != field("commitment", &committed)? {
        return Err(input("The other device didn’t match its request."));
    }
    device_step_code(step, approver_key, nonce)
}

/// The bytes the approving device signs with its device key.
///
/// ```
/// use hushos_core::*;
/// let statement = device_step_statement(DeviceStep {
///     user_id: "0F8FAD5B-D9CB-469F-A165-70867728950E".into(),
///     request_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7".into(),
///     purpose: "login".into(),
///     token_digest: step_token_digest("abc".into()),
///     device_signing_key: base64url_encode(vec![0; 32]),
/// })?;
/// assert_eq!(
///     String::from_utf8(statement)?,
///     r#"["hushos/two-step/device",1,"0f8fad5b-d9cb-469f-a165-70867728950e","7c9e6679-7425-40de-944b-e07fc1f90ae7","login","ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0","AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]"#
/// );
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn device_step_statement(step: DeviceStep) -> CoreResult<Vec<u8>> {
    Ok(context(&[
        json!(STATEMENT_DOMAIN),
        json!(1),
        json!(id_of(&step.user_id)?),
        json!(id_of(&step.request_id)?),
        json!(purpose_of(&step.purpose)?),
        json!(encode(&field("token digest", &step.token_digest)?)),
        json!(encode(&field("device key", &step.device_signing_key)?)),
    ]))
}

/// The approving device's signature over its statement, base64url (64 bytes). `seed`
/// is the device key's seed (`device_signing_create`).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn device_step_sign(seed: Vec<u8>, step: DeviceStep) -> CoreResult<String> {
    let seed = Zeroizing::new(seed);
    if seed.len() != 32 {
        return Err(input("A device key seed is 32 bytes."));
    }
    Ok(encode(&sign(&seed, &device_step_statement(step)?)?))
}

/// Whether `signature` is the device key `public_key`'s approval of this request. The
/// server checks the same; apps use it in tests.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn device_step_verify(public_key: Vec<u8>, step: DeviceStep, signature: Vec<u8>) -> bool {
    device_step_statement(step).map(|statement| verify(&public_key, &statement, &signature)).unwrap_or(false)
}

/// A scanned request: its id and the commitment the asking device made.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ApprovalQr {
    pub request_id: String,
    pub commitment: String,
}

/// What the asking device shows as a QR code: `hushos-approve:` and the request's id
/// and commitment, base64url. An approving device with a camera then checks the
/// commitment itself, instead of asking the person to compare a code.
///
/// ```
/// use hushos_core::*;
/// let commitment = base64url_encode(vec![7; 32]);
/// let text = approval_qr("7C9E6679-7425-40DE-944B-E07FC1F90AE7".into(), commitment.clone())?;
/// assert!(text.starts_with("hushos-approve:"));
/// let read = approval_qr_read(format!(" {text}\n")).unwrap();
/// assert_eq!(read.request_id, "7c9e6679-7425-40de-944b-e07fc1f90ae7");
/// assert_eq!(read.commitment, commitment);
/// assert_eq!(approval_qr_read("https://hushos.com".into()), None);
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn approval_qr(request_id: String, commitment: String) -> CoreResult<String> {
    let id = id_of(&request_id)?.replace('-', "");
    let mut bytes: Vec<u8> =
        (0..16).map(|index| u8::from_str_radix(&id[index * 2..index * 2 + 2], 16).expect("hex")).collect();
    bytes.extend(field("commitment", &commitment)?);
    Ok(format!("{QR_PREFIX}{}", encode(&bytes)))
}

/// A scanned code's request and commitment, or `None` for anything that is not one.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn approval_qr_read(text: String) -> Option<ApprovalQr> {
    let bytes = decode("approval", text.trim().strip_prefix(QR_PREFIX)?, Some(48)).ok()?;
    let hex: String = bytes[..16].iter().map(|byte| format!("{byte:02x}")).collect();
    Some(ApprovalQr {
        request_id: format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]),
        commitment: encode(&bytes[16..]),
    })
}

/// A typed code as both devices write it ("47 river"), or `None` when it is not one:
/// two digits, then a word of the list. Case, and whatever stands between or around
/// the two, are ignored.
///
/// ```
/// use hushos_core::approval_code_normalize;
/// assert_eq!(approval_code_normalize(" 07-River ".into()), Some("07 river".into()));
/// assert_eq!(approval_code_normalize("07river".into()), Some("07 river".into()));
/// assert_eq!(approval_code_normalize("7 river".into()), None);
/// assert_eq!(approval_code_normalize("07 rivr".into()), None);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn approval_code_normalize(typed: String) -> Option<String> {
    let typed = typed.trim();
    let digits: String = typed.chars().take(2).collect();
    if digits.len() != 2 || !digits.chars().all(|digit| digit.is_ascii_digit()) {
        return None;
    }
    let word = typed[2..]
        .trim_start_matches(|between: char| between.is_whitespace() || between == '-')
        .to_lowercase();
    let listed = !word.is_empty()
        && word.chars().all(|letter| letter.is_ascii_lowercase())
        && wordlist().binary_search(&word.as_str()).is_ok();
    listed.then(|| format!("{digits} {word}"))
}

/// The words a typed beginning could become, for completion: up to `limit`, in the
/// list's order. Nothing for an empty beginning.
///
/// ```
/// use hushos_core::approval_words;
/// assert_eq!(approval_words("riv".into(), 6), vec!["rival", "river"]);
/// assert!(approval_words("".into(), 6).is_empty());
/// assert_eq!(approval_words("a".into(), 3).len(), 3);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn approval_words(prefix: String, limit: u32) -> Vec<String> {
    let typed = prefix.trim().to_lowercase();
    if typed.is_empty() || !typed.chars().all(|letter| letter.is_ascii_lowercase()) {
        return Vec::new();
    }
    wordlist()
        .into_iter()
        .filter(|word| word.starts_with(&typed))
        .take(limit as usize)
        .map(str::to_owned)
        .collect()
}

/// A request as the approving device counts it: its id and the class the server put it
/// in (`unknown`, `known` or `change`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct PromptRequest {
    pub id: String,
    pub class: String,
}

/// Which requests to show, and what the device keeps for next time.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct PromptsAllowed {
    pub shown: Vec<String>,
    pub record: String,
}

/// The approving device's own limit on prompts (`docs/two-step-design.md` 12): at most
/// five a day for each class of request, whatever the server sends, so requests from
/// sign-ins it does not know can never use up the room for the owner's own. `record`
/// is what the device kept from before (empty at first, and anything unreadable counts
/// as empty); `day` is today's date as the device writes it (`2026-11-14`). A request
/// shown once stays shown; one past its class's five is not, that day.
///
/// ```
/// use hushos_core::*;
/// let ask = |id: &str, class: &str| PromptRequest { id: id.into(), class: class.into() };
/// let strangers: Vec<_> = (0..7).map(|n| ask(&format!("s{n}"), "unknown")).collect();
/// let first = approval_prompts_allowed(String::new(), "2026-11-14".into(), strangers.clone());
/// assert_eq!(first.shown, vec!["s0", "s1", "s2", "s3", "s4"]);
/// // The owner's own request still has all its room, and what was shown stays shown.
/// let mut next = strangers;
/// next.push(ask("mine", "known"));
/// let second = approval_prompts_allowed(first.record, "2026-11-14".into(), next.clone());
/// assert_eq!(second.shown, vec!["s0", "s1", "s2", "s3", "s4", "mine"]);
/// // A new day starts each class again.
/// let tomorrow = approval_prompts_allowed(second.record, "2026-11-15".into(), next);
/// assert_eq!(tomorrow.shown.len(), 6);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn approval_prompts_allowed(record: String, day: String, requests: Vec<PromptRequest>) -> PromptsAllowed {
    let kept: Option<Value> = serde_json::from_str(&record).ok();
    let mut seen: Map<String, Value> = kept
        .as_ref()
        .filter(|value| value.get("day").and_then(Value::as_str) == Some(day.as_str()))
        .and_then(|value| value.get("seen"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut shown = Vec::new();
    for request in requests {
        let entry = seen.entry(request.class.clone()).or_insert_with(|| json!([]));
        let mut ids: Vec<String> = entry
            .as_array()
            .map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default();
        if !ids.contains(&request.id) {
            if ids.len() >= PROMPTS_A_DAY {
                *entry = json!(ids);
                continue;
            }
            ids.push(request.id.clone());
        }
        *entry = json!(ids);
        shown.push(request.id);
    }
    PromptsAllowed { shown, record: json!({ "day": day, "seen": seen }).to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::device_signing_create;
    use crate::two_step::step_token_digest;

    const USER: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const REQUEST: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

    fn b64(byte: u8) -> String {
        encode(&[byte; 32])
    }

    fn step(purpose: &str, token: &str, key: u8) -> DeviceStep {
        DeviceStep {
            user_id: USER.into(),
            request_id: REQUEST.into(),
            purpose: purpose.into(),
            token_digest: step_token_digest(token.into()),
            device_signing_key: b64(key),
        }
    }

    #[test]
    fn the_code_changes_with_every_field_it_covers() {
        let code = |step: DeviceStep, approver: u8, nonce: u8| {
            let mut hash = Sha256::new();
            hash.update(CODE_DOMAIN.as_bytes());
            hash.update(step.user_id.as_bytes());
            hash.update(step.request_id.as_bytes());
            hash.update(step.purpose.as_bytes());
            hash.update(decode("d", &step.token_digest, Some(32)).unwrap());
            hash.update(decode("k", &step.device_signing_key, Some(32)).unwrap());
            hash.update([approver; 32]);
            hash.update([nonce; 32]);
            let expected = hash.finalize();
            let shown = device_step_code(step, b64(approver), b64(nonce)).unwrap();
            // The digits are the first four bytes mod 100; the word is the next 11 bits.
            let number = u32::from_be_bytes([expected[0], expected[1], expected[2], expected[3]]) % 100;
            let index = (usize::from(expected[4]) << 3) | (usize::from(expected[5]) >> 5);
            assert_eq!(shown, format!("{number:02} {}", wordlist()[index]));
            expected.to_vec()
        };
        let base = code(step("login", "token", 1), 3, 2);
        let mut other_user = step("login", "token", 1);
        other_user.user_id = "1f8fad5b-d9cb-469f-a165-70867728950e".into();
        let mut other_request = step("login", "token", 1);
        other_request.request_id = "8c9e6679-7425-40de-944b-e07fc1f90ae7".into();
        for different in [
            code(other_user, 3, 2),
            code(other_request, 3, 2),
            code(step("password", "token", 1), 3, 2),
            code(step("login", "another", 1), 3, 2),
            code(step("login", "token", 9), 3, 2),
            code(step("login", "token", 1), 4, 2),
            code(step("login", "token", 1), 3, 5),
        ] {
            assert_ne!(base, different);
        }
    }

    #[test]
    fn a_malformed_purpose_id_or_key_is_refused() {
        assert!(device_step_commitment("Login".into(), b64(1), b64(2), b64(3)).is_err());
        assert!(device_step_commitment("".into(), b64(1), b64(2), b64(3)).is_err());
        assert!(device_step_commitment("login".into(), encode(&[1; 31]), b64(2), b64(3)).is_err());
        let mut odd = step("login", "token", 1);
        odd.user_id = "not-an-id".into();
        assert!(device_step_statement(odd.clone()).is_err());
        assert!(device_step_code(odd, b64(3), b64(2)).is_err());
    }

    #[test]
    fn an_approval_holds_for_its_own_request_purpose_token_and_device_only() {
        let key = device_signing_create().unwrap();
        let signed = step("login", "token", 1);
        let signature =
            decode("signature", &device_step_sign(key.seed.to_vec(), signed.clone()).unwrap(), Some(64))
                .unwrap();
        let holds = |step: DeviceStep| device_step_verify(key.public_key.clone(), step, signature.clone());
        assert!(holds(signed.clone()));
        assert!(!holds(step("password", "token", 1)), "another purpose");
        assert!(!holds(step("login", "another", 1)), "another token");
        assert!(!holds(step("login", "token", 2)), "another asking device");
        let mut other = signed.clone();
        other.request_id = "8c9e6679-7425-40de-944b-e07fc1f90ae7".into();
        assert!(!holds(other), "another request");
        assert!(!device_step_verify(device_signing_create().unwrap().public_key, signed, signature.clone()));
    }

    #[test]
    fn a_device_shows_no_more_than_five_prompts_a_day_for_a_class_whatever_it_is_sent() {
        let ask = |id: String, class: &str| PromptRequest { id, class: class.into() };
        let mut record = String::new();
        let mut shown = 0;
        // Twenty different requests from sign-ins the device does not know, one at a time.
        for round in 0..20 {
            let allowed = approval_prompts_allowed(
                record,
                "2026-11-14".into(),
                vec![ask(format!("s{round}"), "unknown")],
            );
            shown += allowed.shown.len();
            record = allowed.record;
        }
        assert_eq!(shown, 5);
        // They took nothing from the other classes.
        let own = approval_prompts_allowed(
            record.clone(),
            "2026-11-14".into(),
            vec![ask("k".into(), "known"), ask("c".into(), "change")],
        );
        assert_eq!(own.shown, vec!["k", "c"]);
        // A record that is not one counts as empty, never as a reason to show nothing.
        let broken =
            approval_prompts_allowed("{".into(), "2026-11-14".into(), vec![ask("a".into(), "unknown")]);
        assert_eq!(broken.shown, vec!["a"]);
    }
}
