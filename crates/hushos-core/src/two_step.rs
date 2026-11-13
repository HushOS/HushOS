//! Two-step sign-in, the parts an app builds and reads (`docs/two-step-design.md` 4, 5),
//! as `packages/crypto/src/two-step.ts` and `packages/auth/src/login-reply.ts` do on the web.
//!
//! Codes are checked only on the server, so nothing here makes or checks one. What is here:
//!
//! - **The recovery phrase's answer.** The phrase passes the step without leaving the
//!   device: the recovery signing key, derived from the phrase and the salt the step's
//!   reply carries as a phrase reset derives it (`recovery.rs`), signs
//!
//!   ```text
//!   ["hushos/two-step/phrase",1,userId,sha256(stepToken)]
//!   ```
//!
//!   with the id lowercased and the digest the SHA-256 of the step token's UTF-8 bytes,
//!   base64url. The server keeps only that digest of the token and rebuilds the statement
//!   from its own row; a token is used once, so a signature is good for one step.
//! - **How a backup code is read:** what a person types, forgivingly.
//! - **What a sign-in's reply is,** decided from the reply alone: the session, the step to
//!   answer, a refusal in the server's words, or a reply that is not the server's answer
//!   at all. An app that guessed at the last would sit on a screen nothing can finish.
//! - **The answer** a step is sent, as the routes take it.
//! - **Passkeys and security keys** (`docs/two-step-design.md` 3, 12): what a key is asked at
//!   a step and when it is added, in the JSON the platforms' own sheets take, and a key's two
//!   answers cut down to what the server checks. The platform runs the ceremony and verifies
//!   nothing is left to this crate: it only moves fields, and never sees a private key.
//! - **What this build names to the server** as answerable beyond a code and the phrase, and
//!   whether the server said it reads that.

use crate::bytes::{decode, encode};
use crate::envelope::context;
use crate::error::{input, CoreResult};
use crate::recovery::recovery_signing_seed;
use crate::signatures::{sign, verify};
use serde_json::{json, Map, Value};
use sha2::{Digest as _, Sha256};
use zeroize::Zeroizing;

const DOMAIN: &str = "hushos/two-step/phrase";
const DIGEST_BYTES: usize = 32;
/* A step token as the server mints it: 32 random bytes, base64url (`TOKEN_PATTERN`). */
const TOKEN_CHARACTERS: usize = 43;

/// The digest a phrase statement names: SHA-256 of the step token's UTF-8 bytes, base64url.
///
/// ```
/// use hushos_core::step_token_digest;
/// assert_eq!(step_token_digest("abc".into()), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn step_token_digest(step_token: String) -> String {
    encode(&Sha256::digest(step_token.as_bytes()))
}

/// The bytes the recovery phrase signs to pass a step. An empty account id, or a digest
/// that is not 32 bytes, is refused: no step names one, so a statement over one proves
/// nothing.
///
/// ```
/// use hushos_core::{step_token_digest, two_step_phrase_statement};
/// let digest = step_token_digest("token".into());
/// let statement = two_step_phrase_statement("USER-1".into(), digest.clone())?;
/// assert_eq!(String::from_utf8(statement)?, format!(r#"["hushos/two-step/phrase",1,"user-1","{digest}"]"#));
/// assert!(two_step_phrase_statement("".into(), digest).is_err());
/// assert!(two_step_phrase_statement("user-1".into(), "c2hvcnQ".into()).is_err());
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn two_step_phrase_statement(user_id: String, token_digest: String) -> CoreResult<Vec<u8>> {
    if user_id.is_empty() || decode("tokenDigest", &token_digest, Some(DIGEST_BYTES)).is_err() {
        return Err(input("Invalid two-step statement."));
    }
    Ok(context(&[json!(DOMAIN), json!(1), json!(user_id.to_lowercase()), json!(token_digest)]))
}

/// The phrase's answer to a step: the recovery signing key's signature over the statement
/// for `step_token`, base64url (64 bytes), which `login/two-step` and a change take as
/// `{ kind: "phrase", signature }`. `wrapping_salt` and `user_id` come from the step's
/// reply (`StepPhrase`). Nothing here says whether the phrase is the account's: the
/// server's check of the signature does. A phrase that is not 24 valid words is refused
/// before anything is signed, in the words the person reads.
///
/// ```
/// use hushos_core::*;
/// let account_key = random_bytes(32)?;
/// let made = recovery_create("user-1".into(), account_key, 1, 1)?;
/// let token = "t".repeat(43);
/// let signature = two_step_phrase_sign(made.phrase.clone(), made.envelope.wrapping_salt.clone(), "user-1".into(), token.clone())?;
/// let public_key = base64url_decode(made.envelope.public_key.clone())?;
/// let signed = base64url_decode(signature)?;
/// assert!(two_step_phrase_verify(public_key.clone(), "user-1".into(), step_token_digest(token), signed.clone()));
/// // Good for that token only.
/// assert!(!two_step_phrase_verify(public_key, "user-1".into(), step_token_digest("u".repeat(43)), signed));
/// # Ok::<(), hushos_core::CoreError>(())
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn two_step_phrase_sign(
    phrase: String,
    wrapping_salt: String,
    user_id: String,
    step_token: String,
) -> CoreResult<String> {
    let phrase = Zeroizing::new(phrase);
    let statement = two_step_phrase_statement(user_id, step_token_digest(step_token))?;
    let seed = recovery_signing_seed(&phrase, &wrapping_salt)?;
    Ok(encode(&sign(seed.as_slice(), &statement)?))
}

/// Whether `signature` is the recovery key `public_key`'s over this account's statement
/// for the token whose digest is `token_digest`. The server checks the same; apps use it
/// in tests.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn two_step_phrase_verify(
    public_key: Vec<u8>,
    user_id: String,
    token_digest: String,
    signature: Vec<u8>,
) -> bool {
    two_step_phrase_statement(user_id, token_digest)
        .map(|statement| verify(&public_key, &statement, &signature))
        .unwrap_or(false)
}

const BACKUP_CODE_ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BACKUP_CODE_LENGTH: usize = 10;

/// A backup code as the server compares it, from what a person typed: ten characters of
/// Crockford base32. Case, spaces and hyphens are ignored, I and L read as 1 and O as 0.
/// Anything else is not a code.
///
/// ```
/// use hushos_core::backup_code_normalize;
/// assert_eq!(backup_code_normalize(" 7kq2m-9xd4p ".into()), Some("7KQ2M9XD4P".into()));
/// assert_eq!(backup_code_normalize("ilo2m 9xd4p".into()), Some("1102M9XD4P".into()));
/// assert_eq!(backup_code_normalize("7KQ2M-9XD4".into()), None);
/// assert_eq!(backup_code_normalize("7KQ2M-9XD4U".into()), None);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn backup_code_normalize(typed: String) -> Option<String> {
    let code: String = typed
        .to_uppercase()
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '-')
        .map(|character| match character {
            'I' | 'L' => '1',
            'O' => '0',
            other => other,
        })
        .collect();
    (code.chars().count() == BACKUP_CODE_LENGTH
        && code.chars().all(|character| BACKUP_CODE_ALPHABET.contains(character)))
    .then_some(code)
}

/// One way to answer a step. A method this build does not know is one it cannot answer,
/// and is left out of a challenge's list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum StepMethod {
    /// A code from the authenticator app.
    Totp,
    /// One of the ten backup codes.
    Backup,
    /// The recovery phrase, signed on the device.
    Phrase,
    /// A passkey or security key, asked by the platform's own sheet.
    Webauthn,
    /// Another of the account's devices approves (`device_approval.rs`): this device shows a
    /// code, and the person types or scans it there.
    Device,
}

/// One of the account's keys, as a step or a registration names it: the credential id
/// (base64url) and the transports the key reported when it was added.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct StepKey {
    pub id: String,
    pub transports: Vec<String>,
}

/// What a passkey or security key is asked at a step: this token's own challenge
/// (base64url), the RP ID the keys are bound to, and the account's keys. No user
/// verification is asked: the password was the knowledge factor.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct StepKeyRequest {
    pub challenge: String,
    pub rp_id: String,
    pub keys: Vec<StepKey>,
}

/// What the device needs to sign with the recovery phrase: the account's id (a sign-in has
/// not been told it yet) and the recovery envelope's salt.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct StepPhrase {
    pub user_id: String,
    pub recovery_version: u64,
    pub wrapping_salt: String,
}

/// A step to answer, as `login/finish` (under `twoStep`) and `two-step/challenge` hand it
/// out: the token, what can answer it in the order to offer it, and when it ends.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct StepChallenge {
    pub token: String,
    /// In the server's order: the account's usual way first (`docs/two-step-design.md` 12).
    pub methods: Vec<StepMethod>,
    /// ISO 8601, as the server sent it.
    pub expires_at: String,
    pub phrase: Option<StepPhrase>,
    /// What a key is asked. Present exactly when `methods` holds `Webauthn`.
    pub key_request: Option<StepKeyRequest>,
    /// A way to answer was left out because this build did not name it.
    pub withheld: bool,
    /// The account's usual way is not the first one here: it can't be used for this step.
    /// The app says one line that names no reason.
    pub default_unavailable: bool,
}

/// A key's answer to a step, cut down to what the server checks: the credential id, the
/// client data, the authenticator data and the signature, each base64url without padding.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct KeyAssertion {
    pub credential_id: String,
    pub client_data_json: String,
    pub authenticator_data: String,
    pub signature: String,
}

/// An answer to a step, as a person gave it. The phrase's is its signature
/// (`two_step_phrase_sign`), never the words; a key's is its assertion.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum StepProof {
    Totp {
        code: String,
    },
    Backup {
        code: String,
    },
    Phrase {
        signature: String,
    },
    Webauthn {
        assertion: KeyAssertion,
    },
    /// The request another device approved (`docs/two-step-design.md` 12).
    Device {
        request_id: String,
    },
}

/// Why the server refused, for the app to act on (`docs/two-step-design.md` 4). The words
/// to show are the server's own, beside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum StepRefusal {
    /// `step-wrong`: the answer was wrong, and the token has answers left. Ask again.
    Wrong,
    /// `step-expired`: the token is over. The password again at sign-in, a new challenge at a change.
    Expired,
    /// `step-frozen`: the authenticator app is paused here. A backup code or the phrase.
    Frozen,
    /// `step-limited`: the shared budget for codes is spent for now. It covers the
    /// authenticator app and the backup codes together; the phrase, or waiting.
    Limited,
    /// `step-pending`: the other device has not approved yet. Nothing was counted; the
    /// same answer is sent again once it has.
    Pending,
    /// `two-step`: the action needs the step and came without it. A challenge, then the step.
    Required,
    /// `setup-required`: the account has no recovery key yet.
    SetupRequired,
    /// `update-required`: this build cannot answer what the account asks for.
    UpdateRequired,
    /// `step-unavailable`: the server cannot check the method that was tried right now, and
    /// nothing changed. It is said per method (the app's secret and the backup codes can sit
    /// under different server keys), and the reply names none: the app withdraws only the
    /// one it sent, and keeps the others offered.
    Unavailable,
    /// `device-unavailable`: no other device could approve this now. Another way.
    DeviceUnavailable,
    /// `device-busy`: another sign-in's request is being answered on the other device.
    DeviceBusy,
    /// `device-limited`: the other devices were asked too many times today. Another way.
    DeviceLimited,
    /// `device-mismatch`: what this device revealed is not what it committed to. The request ended.
    DeviceMismatch,
    /// `approval-over`: the request an approving device answered is over.
    ApprovalOver,
    /// `approval-taken`: another of the account's devices is answering the request.
    ApprovalTaken,
    /// `approval-refused`: the approving device's signature did not verify. The request ended.
    ApprovalRefused,
    /// A 429 without a code: the address's own limit, not the step's. Nothing about the
    /// step was looked at, and it is still there when the limit lets a request through.
    Busy,
    /// Anything else the server said: its words, and nothing to retry on this step.
    Other,
}

/// What a request that may meet a step was answered with.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum StepReply {
    /// The server's own success. At sign-in the body carries the account, its envelope
    /// and the device; the app reads them as it always has.
    Done,
    /// The account asks for the step: no session yet, and nothing else in the reply.
    Step { challenge: StepChallenge },
    /// The server refused, in its own words.
    Refused { refusal: StepRefusal, message: String },
    /// Not the server's answer: a proxy's page, an empty body, a reply cut short, a 200
    /// that carries neither a session nor a step. The server may have done what was
    /// asked or not, and nothing here can tell. Never a sign-in, never a refusal: the
    /// app says so and offers to try again.
    Lost,
}

fn object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn text<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key)?.as_str().filter(|value| !value.is_empty())
}

/* A positive whole number a double carries exactly, as the web's `Number.isSafeInteger` and `> 0`. */
fn count(map: &Map<String, Value>, key: &str) -> Option<u64> {
    map.get(key)?.as_u64().filter(|value| (1..=9_007_199_254_740_991).contains(value))
}

fn token_shaped(token: &str) -> bool {
    token.len() == TOKEN_CHARACTERS
        && token.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/* An ISO 8601 instant, loosely: a date, `T`, a time. The server writes `toISOString()`. */
fn instant_shaped(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 20
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(u8::is_ascii_digit)
        && bytes[10] == b'T'
        && bytes[11..13].iter().all(u8::is_ascii_digit)
        && bytes[13] == b':'
        && bytes[14..16].iter().all(u8::is_ascii_digit)
        && bytes[16] == b':'
        && bytes[17..19].iter().all(u8::is_ascii_digit)
}

/* Base64url without padding, and not empty: how WebAuthn's JSON carries bytes. */
fn webauthn_bytes(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/* A list of key descriptors (`{ id, type: "public-key", transports? }`), or none if any entry is not one. */
fn keys_of(value: Option<&Value>) -> Option<Vec<StepKey>> {
    value?
        .as_array()?
        .iter()
        .map(|entry| {
            let entry = object(entry)?;
            let id = text(entry, "id").filter(|id| webauthn_bytes(id))?;
            (entry.get("type").and_then(Value::as_str) == Some("public-key")).then_some(())?;
            let transports = entry
                .get("transports")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            Some(StepKey { id: id.to_string(), transports })
        })
        .collect()
}

/* What a key is asked at a step, or none: a key cannot answer without a challenge and a key to ask. */
fn key_request_of(value: Option<&Value>) -> Option<StepKeyRequest> {
    let map = value.and_then(object)?;
    let challenge = text(map, "challenge").filter(|challenge| webauthn_bytes(challenge))?;
    let rp_id = text(map, "rpId")?;
    let keys = keys_of(map.get("allowCredentials")).filter(|keys| !keys.is_empty())?;
    Some(StepKeyRequest { challenge: challenge.to_string(), rp_id: rp_id.to_string(), keys })
}

fn challenge_of(value: &Value) -> Option<StepChallenge> {
    let map = object(value)?;
    let token = text(map, "token").filter(|token| token_shaped(token))?;
    let listed = map.get("methods")?.as_array()?;
    let expires_at = text(map, "expiresAt").filter(|at| instant_shaped(at))?;
    let phrase = map.get("phrase").and_then(object).and_then(|phrase| {
        Some(StepPhrase {
            user_id: text(phrase, "userId")?.to_string(),
            recovery_version: count(phrase, "recoveryVersion")?,
            wrapping_salt: text(phrase, "wrappingSalt")?.to_string(),
        })
    });
    let key_request = key_request_of(map.get("webauthn"));
    // The order is the server's: the account's usual way comes first. A method listed twice
    // is offered once; one this build does not know, or cannot answer with what the reply
    // carries (the phrase without what it signs with, a key without its challenge), is left out.
    let mut methods = Vec::new();
    for name in listed {
        let method = match name.as_str() {
            Some("totp") => StepMethod::Totp,
            Some("backup") => StepMethod::Backup,
            Some("phrase") if phrase.is_some() => StepMethod::Phrase,
            Some("webauthn") if key_request.is_some() => StepMethod::Webauthn,
            Some("device") => StepMethod::Device,
            _ => continue,
        };
        if !methods.contains(&method) {
            methods.push(method);
        }
    }
    let webauthn = methods.contains(&StepMethod::Webauthn);
    // What the server put first is not what is first here: the usual way is not on offer.
    let first_dropped = listed.first().is_some_and(|first| {
        let kept = methods.first().map(|method| match method {
            StepMethod::Totp => "totp",
            StepMethod::Backup => "backup",
            StepMethod::Phrase => "phrase",
            StepMethod::Webauthn => "webauthn",
            StepMethod::Device => "device",
        });
        first.as_str() != kept
    });
    Some(StepChallenge {
        token: token.to_string(),
        methods,
        expires_at: expires_at.to_string(),
        phrase,
        key_request: key_request.filter(|_| webauthn),
        withheld: map.get("withheld") == Some(&Value::Bool(true)),
        default_unavailable: first_dropped || map.get("defaultUnavailable") == Some(&Value::Bool(true)),
    })
}

/* The session's reply: the account, its wrapped key and the session's device, each whole. */
fn session_shaped(map: &Map<String, Value>) -> bool {
    let user = map.get("user").and_then(object);
    let envelope = map.get("envelope").and_then(object);
    let device = map.get("device").and_then(object);
    let (Some(user), Some(envelope), Some(device)) = (user, envelope, device) else {
        return false;
    };
    text(user, "id").is_some()
        && text(user, "email").is_some()
        && count(envelope, "envelopeVersion").is_some()
        && count(envelope, "keyVersion").is_some()
        && count(envelope, "credentialVersion").is_some()
        && text(envelope, "wrappingSalt").is_some()
        && text(envelope, "wrappingNonce").is_some()
        && text(envelope, "encryptedKey").is_some()
        && text(device, "id").is_some()
}

fn refusal_of(status: u16, body: &str) -> StepReply {
    // The server words every refusal: `{ message, code? }`. Anything else came from something in the way.
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let Some(map) = parsed.as_ref().and_then(object) else {
        return StepReply::Lost;
    };
    let Some(message) = text(map, "message") else {
        return StepReply::Lost;
    };
    let refusal = match (map.get("code").and_then(Value::as_str), status) {
        (Some("step-wrong"), _) => StepRefusal::Wrong,
        (Some("step-expired"), _) => StepRefusal::Expired,
        (Some("step-frozen"), _) => StepRefusal::Frozen,
        (Some("step-limited"), _) => StepRefusal::Limited,
        (Some("step-unavailable"), _) => StepRefusal::Unavailable,
        (Some("step-pending"), _) => StepRefusal::Pending,
        (Some("device-unavailable"), _) => StepRefusal::DeviceUnavailable,
        (Some("device-busy"), _) => StepRefusal::DeviceBusy,
        (Some("device-limited"), _) => StepRefusal::DeviceLimited,
        (Some("device-mismatch"), _) => StepRefusal::DeviceMismatch,
        (Some("approval-over"), _) => StepRefusal::ApprovalOver,
        (Some("approval-taken"), _) => StepRefusal::ApprovalTaken,
        (Some("approval-refused"), _) => StepRefusal::ApprovalRefused,
        (Some("two-step"), _) => StepRefusal::Required,
        (Some("setup-required"), _) => StepRefusal::SetupRequired,
        (Some("update-required"), _) => StepRefusal::UpdateRequired,
        (_, 429) => StepRefusal::Busy,
        // A server error without the step's own code says nothing about what happened to the
        // request, whatever words came with it: sent again, never read as an answer.
        (_, 500..=599) => return StepReply::Lost,
        _ => StepRefusal::Other,
    };
    StepReply::Refused { refusal, message: message.to_string() }
}

/// What `login/finish` or `login/two-step` answered, from the status and the body alone.
/// A 200 is the session (the account, its envelope and its device, whole), or the step
/// and nothing else; a reply with both, with neither, or with either cut short is `Lost`.
/// Any other status is the server's refusal when it carries the server's words, and
/// `Lost` when it does not. A 5xx is `Lost` too unless it names `step-unavailable`.
///
/// ```
/// use hushos_core::*;
/// let token = "t".repeat(43);
/// let step = format!(r#"{{"twoStep":{{"token":"{token}","methods":["totp","backup","webauthn","phrase"],"expiresAt":"2026-11-13T10:00:00.000Z"}}}}"#);
/// let StepReply::Step { challenge } = sign_in_reply_read(200, step) else { panic!("a step") };
/// // A key has no challenge to answer, and the phrase nothing to sign with: neither is offered.
/// assert_eq!(challenge.methods, vec![StepMethod::Totp, StepMethod::Backup]);
/// assert_eq!(sign_in_reply_read(200, "{}".into()), StepReply::Lost);
/// assert_eq!(sign_in_reply_read(200, "<html>".into()), StepReply::Lost);
/// assert_eq!(
///     sign_in_reply_read(401, r#"{"message":"That code didn’t work.","code":"step-wrong"}"#.into()),
///     StepReply::Refused { refusal: StepRefusal::Wrong, message: "That code didn’t work.".into() },
/// );
/// assert_eq!(sign_in_reply_read(502, "Bad gateway".into()), StepReply::Lost);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn sign_in_reply_read(status: u16, body: String) -> StepReply {
    if status != 200 {
        return refusal_of(status, &body);
    }
    let parsed: Option<Value> = serde_json::from_str(&body).ok();
    let Some(map) = parsed.as_ref().and_then(object) else {
        return StepReply::Lost;
    };
    // The server sends one or the other, never both: a reply with both is not its answer.
    if let Some(step) = map.get("twoStep") {
        return match challenge_of(step) {
            Some(challenge) if !map.contains_key("user") => StepReply::Step { challenge },
            _ => StepReply::Lost,
        };
    }
    if session_shaped(map) {
        StepReply::Done
    } else {
        StepReply::Lost
    }
}

/// What `two-step/challenge` answered: the step for a change this session makes, a
/// refusal, or a lost reply. Never `Done`.
///
/// ```
/// use hushos_core::*;
/// let token = "t".repeat(43);
/// let body = format!(r#"{{"token":"{token}","methods":["totp"],"expiresAt":"2026-11-13T10:00:00.000Z"}}"#);
/// assert!(matches!(step_challenge_reply_read(200, body), StepReply::Step { .. }));
/// assert_eq!(step_challenge_reply_read(200, r#"{"success":true}"#.into()), StepReply::Lost);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn step_challenge_reply_read(status: u16, body: String) -> StepReply {
    if status != 200 {
        return refusal_of(status, &body);
    }
    serde_json::from_str::<Value>(&body)
        .ok()
        .as_ref()
        .and_then(challenge_of)
        .map_or(StepReply::Lost, |challenge| StepReply::Step { challenge })
}

/// What a change that may carry a step answered (`security/finish`, `delete/finish`, the
/// two-step routes): `Done` for the server's JSON object on a 200, a refusal in its
/// words, or `Lost`. The change may have gone through when the reply is lost; the app
/// checks before it says either way. Never `Step`.
///
/// ```
/// use hushos_core::*;
/// assert_eq!(step_change_reply_read(200, r#"{"success":true}"#.into()), StepReply::Done);
/// assert_eq!(step_change_reply_read(200, "".into()), StepReply::Lost);
/// assert_eq!(
///     step_change_reply_read(403, r#"{"message":"This needs your second step.","code":"two-step"}"#.into()),
///     StepReply::Refused { refusal: StepRefusal::Required, message: "This needs your second step.".into() },
/// );
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn step_change_reply_read(status: u16, body: String) -> StepReply {
    if status != 200 {
        return refusal_of(status, &body);
    }
    match serde_json::from_str::<Value>(&body) {
        Ok(Value::Object(_)) => StepReply::Done,
        _ => StepReply::Lost,
    }
}

/// The answer as the routes take it: the body of `login/two-step`, and the `twoStep` field
/// of a change. Compact JSON, `{"token":…,"proof":{"kind":…,…}}`. A code goes as typed,
/// without the spaces a person or an autofill put in it; the server reads a backup code
/// forgivingly.
///
/// ```
/// use hushos_core::*;
/// let answer = step_answer_json("tok".into(), StepProof::Totp { code: "123 456".into() });
/// assert_eq!(answer, r#"{"token":"tok","proof":{"kind":"totp","code":"123456"}}"#);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn step_answer_json(token: String, proof: StepProof) -> String {
    let spaceless =
        |code: &str| code.chars().filter(|character| !character.is_whitespace()).collect::<String>();
    let proof = match proof {
        StepProof::Totp { code } => format!(r#"{{"kind":"totp","code":{}}}"#, json!(spaceless(&code))),
        StepProof::Backup { code } => format!(r#"{{"kind":"backup","code":{}}}"#, json!(code.trim())),
        StepProof::Phrase { signature } => format!(r#"{{"kind":"phrase","signature":{}}}"#, json!(signature)),
        StepProof::Webauthn { assertion } => {
            format!(r#"{{"kind":"webauthn","response":{}}}"#, assertion_value(&assertion))
        }
        StepProof::Device { request_id } => {
            format!(r#"{{"kind":"device","requestId":{}}}"#, json!(request_id.to_lowercase()))
        }
    };
    format!(r#"{{"token":{},"proof":{proof}}}"#, json!(token))
}

/* A key's assertion as the server takes it (AuthenticationResponseJSON, only what it checks). */
fn assertion_value(assertion: &KeyAssertion) -> Value {
    json!({
        "id": assertion.credential_id,
        "rawId": assertion.credential_id,
        "type": "public-key",
        "response": {
            "clientDataJSON": assertion.client_data_json,
            "authenticatorData": assertion.authenticator_data,
            "signature": assertion.signature,
        },
    })
}

/* A key descriptor as WebAuthn's JSON has it: the transports only when the key reported some. */
fn descriptor(key: &StepKey) -> Value {
    let mut entry = json!({ "type": "public-key", "id": key.id });
    if !key.transports.is_empty() {
        entry["transports"] = json!(key.transports);
    }
    entry
}

/* Five minutes, as long as the token a ceremony belongs to. */
const KEY_TIMEOUT_MS: u64 = 300_000;

/// What a step asks a key, as the platform's sheet takes it
/// (`PublicKeyCredentialRequestOptionsJSON`, for Android's Credential Manager): this token's
/// challenge, the RP ID, the account's keys, and no user verification.
///
/// ```
/// use hushos_core::*;
/// let request = StepKeyRequest {
///     challenge: "Y2hhbGxlbmdl".into(),
///     rp_id: "hushos.com".into(),
///     keys: vec![StepKey { id: "a2V5".into(), transports: vec!["usb".into()] }],
/// };
/// assert_eq!(
///     key_request_json(request),
///     r#"{"allowCredentials":[{"id":"a2V5","transports":["usb"],"type":"public-key"}],"challenge":"Y2hhbGxlbmdl","rpId":"hushos.com","timeout":300000,"userVerification":"discouraged"}"#,
/// );
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn key_request_json(request: StepKeyRequest) -> String {
    json!({
        "challenge": request.challenge,
        "rpId": request.rp_id,
        "timeout": KEY_TIMEOUT_MS,
        "userVerification": "discouraged",
        "allowCredentials": request.keys.iter().map(descriptor).collect::<Vec<_>>(),
    })
    .to_string()
}

/// A key's assertion, read from the JSON a platform's sheet hands back
/// (`AuthenticationResponseJSON`). Only what the server checks is kept; a reply without
/// any of it is not an assertion.
///
/// ```
/// use hushos_core::*;
/// let handed = r#"{"id":"a2V5","rawId":"a2V5","type":"public-key","authenticatorAttachment":"cross-platform","response":{"clientDataJSON":"ZGF0YQ","authenticatorData":"YXV0aA","signature":"c2ln","userHandle":"aA"},"clientExtensionResults":{}}"#;
/// let assertion = key_assertion_read(handed.into()).unwrap();
/// assert_eq!(assertion.credential_id, "a2V5");
/// assert_eq!(key_assertion_read(r#"{"id":"a2V5","response":{}}"#.into()), None);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn key_assertion_read(handed: String) -> Option<KeyAssertion> {
    let parsed: Value = serde_json::from_str(&handed).ok()?;
    let map = object(&parsed)?;
    let response = map.get("response").and_then(object)?;
    let bytes = |map: &Map<String, Value>, key: &str| {
        text(map, key).filter(|value| webauthn_bytes(value)).map(str::to_string)
    };
    Some(KeyAssertion {
        credential_id: bytes(map, "id")?,
        client_data_json: bytes(response, "clientDataJSON")?,
        authenticator_data: bytes(response, "authenticatorData")?,
        signature: bytes(response, "signature")?,
    })
}

/// A key about to be added: the registration token its answer goes back with, and what
/// the key is asked. No attestation, no resident key and no user verification are asked,
/// whatever a reply says: a second step needs none of them.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct KeyCreation {
    pub registration_token: String,
    /// Base64url.
    pub challenge: String,
    pub rp_id: String,
    pub rp_name: String,
    /// The account's WebAuthn handle (base64url): random, never the account id.
    pub user_id: String,
    pub user_name: String,
    pub user_display_name: String,
    /// COSE algorithm identifiers, in the server's order of preference.
    pub algorithms: Vec<i64>,
    /// The account's keys, so the same one is not added twice.
    pub exclude: Vec<StepKey>,
}

/// What `two-step/keys/options` answered.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum KeyOptionsReply {
    Options {
        creation: KeyCreation,
    },
    Refused {
        refusal: StepRefusal,
        message: String,
    },
    /// Not the server's answer; nothing was added, and the app starts again.
    Lost,
}

/// Reads `two-step/keys/options`: the options whole, a refusal in the server's words, or
/// a lost reply. Options short of what the server always sets are not its answer.
///
/// ```
/// use hushos_core::*;
/// let token = "r".repeat(43);
/// let body = format!(r#"{{"registrationToken":"{token}","options":{{"challenge":"Y2g","rp":{{"id":"hushos.com","name":"HushOS"}},"user":{{"id":"aGFuZGxl","name":"maya@example.org","displayName":"maya@example.org"}},"pubKeyCredParams":[{{"type":"public-key","alg":-7}}],"excludeCredentials":[]}}}}"#);
/// let KeyOptionsReply::Options { creation } = key_options_reply_read(200, body) else { panic!("options") };
/// assert_eq!(creation.algorithms, vec![-7]);
/// assert_eq!(key_options_reply_read(200, "{}".into()), KeyOptionsReply::Lost);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn key_options_reply_read(status: u16, body: String) -> KeyOptionsReply {
    if status != 200 {
        return match refusal_of(status, &body) {
            StepReply::Refused { refusal, message } => KeyOptionsReply::Refused { refusal, message },
            _ => KeyOptionsReply::Lost,
        };
    }
    let read = || {
        let parsed: Value = serde_json::from_str(&body).ok()?;
        let map = object(&parsed)?;
        let options = map.get("options").and_then(object)?;
        let rp = options.get("rp").and_then(object)?;
        let user = options.get("user").and_then(object)?;
        let algorithms: Vec<i64> = options
            .get("pubKeyCredParams")?
            .as_array()?
            .iter()
            .filter_map(|entry| {
                let entry = object(entry)?;
                (entry.get("type").and_then(Value::as_str) == Some("public-key")).then_some(())?;
                entry.get("alg")?.as_i64()
            })
            .collect();
        (!algorithms.is_empty()).then_some(())?;
        let user_name = text(user, "name")?.to_string();
        Some(KeyCreation {
            registration_token: text(map, "registrationToken")
                .filter(|token| token_shaped(token))?
                .to_string(),
            challenge: text(options, "challenge").filter(|value| webauthn_bytes(value))?.to_string(),
            rp_id: text(rp, "id")?.to_string(),
            rp_name: text(rp, "name")?.to_string(),
            user_id: text(user, "id").filter(|value| webauthn_bytes(value))?.to_string(),
            user_display_name: text(user, "displayName").unwrap_or(&user_name).to_string(),
            user_name,
            algorithms,
            exclude: keys_of(options.get("excludeCredentials"))?,
        })
    };
    read().map_or(KeyOptionsReply::Lost, |creation| KeyOptionsReply::Options { creation })
}

/// What a key is asked when it is added, as the platform's sheet takes it
/// (`PublicKeyCredentialCreationOptionsJSON`, for Android's Credential Manager).
///
/// ```
/// use hushos_core::*;
/// let creation = KeyCreation {
///     registration_token: "r".repeat(43), challenge: "Y2g".into(),
///     rp_id: "hushos.com".into(), rp_name: "HushOS".into(),
///     user_id: "aGFuZGxl".into(), user_name: "maya@example.org".into(), user_display_name: "maya@example.org".into(),
///     algorithms: vec![-8, -7], exclude: vec![],
/// };
/// let asked: serde_json::Value = serde_json::from_str(&key_creation_json(creation)).unwrap();
/// assert_eq!(asked["attestation"], "none");
/// assert_eq!(asked["authenticatorSelection"]["userVerification"], "discouraged");
/// assert_eq!(asked["authenticatorSelection"]["residentKey"], "discouraged");
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn key_creation_json(creation: KeyCreation) -> String {
    json!({
        "challenge": creation.challenge,
        "rp": { "id": creation.rp_id, "name": creation.rp_name },
        "user": {
            "id": creation.user_id,
            "name": creation.user_name,
            "displayName": creation.user_display_name,
        },
        "pubKeyCredParams": creation
            .algorithms
            .iter()
            .map(|alg| json!({ "type": "public-key", "alg": alg }))
            .collect::<Vec<_>>(),
        "timeout": KEY_TIMEOUT_MS,
        "attestation": "none",
        "excludeCredentials": creation.exclude.iter().map(descriptor).collect::<Vec<_>>(),
        "authenticatorSelection": {
            "residentKey": "discouraged",
            "requireResidentKey": false,
            "userVerification": "discouraged",
        },
    })
    .to_string()
}

/// A key's registration, cut down to what the server checks: the credential id, the client
/// data and the attestation object (base64url), and the transports the platform reported.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct KeyRegistration {
    pub credential_id: String,
    pub client_data_json: String,
    pub attestation_object: String,
    pub transports: Vec<String>,
}

/// A key's registration, read from the JSON a platform's sheet hands back
/// (`RegistrationResponseJSON`).
///
/// ```
/// use hushos_core::*;
/// let handed = r#"{"id":"a2V5","rawId":"a2V5","type":"public-key","response":{"clientDataJSON":"ZGF0YQ","attestationObject":"b2Jq","transports":["internal","hybrid"],"publicKey":"cGs"}}"#;
/// let registration = key_registration_read(handed.into()).unwrap();
/// assert_eq!(registration.transports, vec!["internal", "hybrid"]);
/// assert_eq!(key_registration_read("{}".into()), None);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn key_registration_read(handed: String) -> Option<KeyRegistration> {
    let parsed: Value = serde_json::from_str(&handed).ok()?;
    let map = object(&parsed)?;
    let response = map.get("response").and_then(object)?;
    let bytes = |map: &Map<String, Value>, key: &str| {
        text(map, key).filter(|value| webauthn_bytes(value)).map(str::to_string)
    };
    Some(KeyRegistration {
        credential_id: bytes(map, "id")?,
        client_data_json: bytes(response, "clientDataJSON")?,
        attestation_object: bytes(response, "attestationObject")?,
        transports: response
            .get("transports")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(Value::as_str).take(8).map(str::to_string).collect())
            .unwrap_or_default(),
    })
}

/// The body of `two-step/keys`: the registration token, the key's answer, and a name for
/// the key when the person gave one (the server names it otherwise).
///
/// ```
/// use hushos_core::*;
/// let registration = KeyRegistration {
///     credential_id: "a2V5".into(), client_data_json: "ZGF0YQ".into(),
///     attestation_object: "b2Jq".into(), transports: vec![],
/// };
/// assert_eq!(
///     key_registration_json("tok".into(), None, registration),
///     r#"{"registrationToken":"tok","response":{"id":"a2V5","rawId":"a2V5","response":{"attestationObject":"b2Jq","clientDataJSON":"ZGF0YQ"},"type":"public-key"}}"#,
/// );
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn key_registration_json(
    registration_token: String,
    name: Option<String>,
    registration: KeyRegistration,
) -> String {
    let mut response = json!({
        "clientDataJSON": registration.client_data_json,
        "attestationObject": registration.attestation_object,
    });
    if !registration.transports.is_empty() {
        response["transports"] = json!(registration.transports);
    }
    let mut body = Map::new();
    body.insert("registrationToken".into(), json!(registration_token));
    if let Some(name) = name.map(|name| name.trim().to_string()).filter(|name| !name.is_empty()) {
        body.insert("name".into(), json!(name));
    }
    body.insert(
        "response".into(),
        json!({
            "id": registration.credential_id,
            "rawId": registration.credential_id,
            "type": "public-key",
            "response": response,
        }),
    );
    Value::Object(body).to_string()
}

/// A key the server says it added: how the list shows it, and the backup codes when it
/// turned the step on (empty otherwise).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct KeyAdded {
    pub id: String,
    pub name: String,
    /// A passkey a password manager syncs.
    pub synced: bool,
    pub backup_codes: Vec<String>,
}

/// What `two-step/keys` answered.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum KeyAddedReply {
    Added {
        key: KeyAdded,
    },
    Refused {
        refusal: StepRefusal,
        message: String,
    },
    /// Not the server's answer: the key may have been added or not. The app reads the
    /// settings again before it says either way.
    Lost,
}

/// Reads `two-step/keys`: only the server's own answer says a key was added.
///
/// ```
/// use hushos_core::*;
/// let body = r#"{"method":{"id":"f1","kind":"webauthn","name":"Passkey","createdAt":"2026-11-13T10:00:00.000Z","lastUsedAt":null,"synced":true}}"#;
/// let KeyAddedReply::Added { key } = key_added_reply_read(200, body.into()) else { panic!("added") };
/// assert!(key.synced && key.backup_codes.is_empty());
/// assert_eq!(key_added_reply_read(200, r#"{"success":true}"#.into()), KeyAddedReply::Lost);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn key_added_reply_read(status: u16, body: String) -> KeyAddedReply {
    if status != 200 {
        return match refusal_of(status, &body) {
            StepReply::Refused { refusal, message } => KeyAddedReply::Refused { refusal, message },
            _ => KeyAddedReply::Lost,
        };
    }
    let read = || {
        let parsed: Value = serde_json::from_str(&body).ok()?;
        let map = object(&parsed)?;
        let method = map.get("method").and_then(object)?;
        (method.get("kind").and_then(Value::as_str) == Some("webauthn")).then_some(())?;
        let backup_codes = match map.get("backupCodes") {
            None => Vec::new(),
            // Sent, the codes are a set: anything else is not the server's answer.
            Some(codes) => {
                let codes: Vec<String> = codes
                    .as_array()?
                    .iter()
                    .map(|code| code.as_str().filter(|code| !code.is_empty()).map(str::to_string))
                    .collect::<Option<_>>()?;
                (!codes.is_empty()).then_some(codes)?
            }
        };
        Some(KeyAdded {
            id: text(method, "id")?.to_string(),
            name: text(method, "name")?.to_string(),
            synced: method.get("synced") == Some(&Value::Bool(true)),
            backup_codes,
        })
    };
    read().map_or(KeyAddedReply::Lost, |key| KeyAddedReply::Added { key })
}

/// The kinds of method this build names to the server beyond the ones every client answers
/// (the app's code, a backup code, the phrase), for `twoStepMethods` at sign-in and at a
/// change (`docs/two-step-design.md` 12). `passkeys`: whether this device can use a passkey or
/// security key for this server. `device`: whether it can ask another device, which needs a
/// device key of its own to commit to. One that cannot names neither, and is never shown one.
///
/// ```
/// use hushos_core::step_methods_named;
/// assert_eq!(step_methods_named(true, true), vec!["webauthn", "device"]);
/// assert_eq!(step_methods_named(false, true), vec!["device"]);
/// assert!(step_methods_named(false, false).is_empty());
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn step_methods_named(passkeys: bool, device: bool) -> Vec<String> {
    let mut named = Vec::new();
    if passkeys {
        named.push("webauthn".to_string());
    }
    if device {
        named.push("device".to_string());
    }
    named
}

/// The kinds of method this build can list in settings (`?methods=`), whether or not this
/// device can use them: a passkey added in a browser is still shown, named and removed here.
///
/// ```
/// use hushos_core::step_methods_shown;
/// assert_eq!(step_methods_shown(), vec!["webauthn", "device"]);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn step_methods_shown() -> Vec<String> {
    vec!["webauthn".to_string(), "device".to_string()]
}

/// Whether `login/start`'s reply says the server reads `twoStepMethods`. It is sent only to
/// a server that said so; a release from before passkeys says nothing.
///
/// ```
/// use hushos_core::step_methods_advertised;
/// assert!(step_methods_advertised(r#"{"attemptToken":"a","twoStepMethods":true}"#.into()));
/// assert!(!step_methods_advertised(r#"{"attemptToken":"a"}"#.into()));
/// assert!(!step_methods_advertised(r#"{"twoStepMethods":"true"}"#.into()));
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn step_methods_advertised(login_start_body: String) -> bool {
    serde_json::from_str::<Value>(&login_start_body)
        .ok()
        .as_ref()
        .and_then(object)
        .is_some_and(|map| map.get("twoStepMethods") == Some(&Value::Bool(true)))
}

/// Whether a refusal may be the server's schema refusing a field it does not know
/// (`twoStepMethods`): a 422, or the 400 its auth routes answer a body they cannot read
/// with. The app asks once more without the field, on the same attempt.
///
/// ```
/// use hushos_core::step_methods_refused;
/// assert!(step_methods_refused(422) && step_methods_refused(400));
/// assert!(!step_methods_refused(401) && !step_methods_refused(200));
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn step_methods_refused(status: u16) -> bool {
    status == 422 || status == 400
}

/* ------------------------------------------------------------------------- */
/* Approving on another device: the replies                                   */
/* ------------------------------------------------------------------------- */

/// Where a request to approve stands, as its routes say it (`docs/two-step-design.md` 12).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ApprovalState {
    /// Made; no device has opened it yet, so there is no code to show.
    Waiting,
    /// One approving device posted its own value: the asking device reveals now.
    Opened,
    /// The asking device revealed: both show the code.
    Revealed,
    /// Approved: the step can be answered with this request.
    Approved,
    /// Over without an approval.
    Ended,
}

/// Why a request ended, as the device that made it is told: never who ended it, or how.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ApprovalEnded {
    /// A newer request took its place.
    Replaced,
    /// Its time ran out.
    Over,
    /// The other device did not approve it.
    Refused,
}

fn key_shaped(value: &str) -> bool {
    value.len() == 43 && webauthn_bytes(value)
}

fn id_shaped(value: &str) -> bool {
    value.len() == 36
        && value.char_indices().all(|(index, character)| match index {
            8 | 13 | 18 | 23 => character == '-',
            _ => character.is_ascii_digit() || ('a'..='f').contains(&character),
        })
}

/// What the asking device sends to make a request: its commitment, and what it calls
/// itself for a server that does not know it yet (`kind`: `ios` or `android`).
///
/// ```
/// use hushos_core::*;
/// let body = approval_start_json("tok".into(), "Y29tbWl0".into(), "ios".into(), "iPhone 16 Pro".into());
/// assert_eq!(body, r#"{"stepToken":"tok","commitment":"Y29tbWl0","kind":"ios","name":"iPhone 16 Pro"}"#);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn approval_start_json(step_token: String, commitment: String, kind: String, name: String) -> String {
    format!(
        r#"{{"stepToken":{},"commitment":{},"kind":{},"name":{}}}"#,
        json!(step_token),
        json!(commitment),
        json!(kind),
        json!(name)
    )
}

/// What `POST /api/auth/approvals` answered.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ApprovalStartReply {
    /// The request, the account it is for (a sign-in has not been told it yet, and the
    /// code covers it) and when it ends with its token.
    Started {
        request_id: String,
        user_id: String,
        expires_at: String,
    },
    Refused {
        refusal: StepRefusal,
        message: String,
    },
    Lost,
}

/// Reads `POST /api/auth/approvals`.
///
/// ```
/// use hushos_core::*;
/// let body = r#"{"requestId":"7c9e6679-7425-40de-944b-e07fc1f90ae7","userId":"0f8fad5b-d9cb-469f-a165-70867728950e","expiresAt":"2026-11-14T10:00:00.000Z"}"#;
/// assert!(matches!(approval_start_reply_read(200, body.into()), ApprovalStartReply::Started { .. }));
/// assert_eq!(approval_start_reply_read(200, "{}".into()), ApprovalStartReply::Lost);
/// assert_eq!(
///     approval_start_reply_read(429, r#"{"message":"Too many.","code":"device-limited"}"#.into()),
///     ApprovalStartReply::Refused { refusal: StepRefusal::DeviceLimited, message: "Too many.".into() },
/// );
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn approval_start_reply_read(status: u16, body: String) -> ApprovalStartReply {
    if status != 200 {
        return match refusal_of(status, &body) {
            StepReply::Refused { refusal, message } => ApprovalStartReply::Refused { refusal, message },
            _ => ApprovalStartReply::Lost,
        };
    }
    let read = || {
        let parsed: Value = serde_json::from_str(&body).ok()?;
        let map = object(&parsed)?;
        Some(ApprovalStartReply::Started {
            request_id: text(map, "requestId").filter(|id| id_shaped(id))?.to_string(),
            user_id: text(map, "userId").filter(|id| id_shaped(id))?.to_string(),
            expires_at: text(map, "expiresAt").filter(|at| instant_shaped(at))?.to_string(),
        })
    };
    read().unwrap_or(ApprovalStartReply::Lost)
}

/// What `GET /api/auth/approvals/:id` answered.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ApprovalStatusReply {
    Status {
        state: ApprovalState,
        /// The approving device's own value, once one opened the request (base64url).
        approver_key: Option<String>,
        /// Why it ended, when `state` is `Ended`.
        ended: Option<ApprovalEnded>,
    },
    Refused {
        refusal: StepRefusal,
        message: String,
    },
    Lost,
}

/// Reads `GET /api/auth/approvals/:id`. A state past `Waiting` without the approving
/// device's value is not the server's answer: the code could not be computed from it.
///
/// ```
/// use hushos_core::*;
/// let key = "A".repeat(43);
/// assert_eq!(
///     approval_status_reply_read(200, format!(r#"{{"state":"opened","approverKey":"{key}"}}"#)),
///     ApprovalStatusReply::Status { state: ApprovalState::Opened, approver_key: Some(key), ended: None },
/// );
/// assert_eq!(
///     approval_status_reply_read(200, r#"{"state":"ended","ended":"replaced"}"#.into()),
///     ApprovalStatusReply::Status { state: ApprovalState::Ended, approver_key: None, ended: Some(ApprovalEnded::Replaced) },
/// );
/// assert_eq!(approval_status_reply_read(200, r#"{"state":"opened"}"#.into()), ApprovalStatusReply::Lost);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn approval_status_reply_read(status: u16, body: String) -> ApprovalStatusReply {
    if status != 200 {
        return match refusal_of(status, &body) {
            StepReply::Refused { refusal, message } => ApprovalStatusReply::Refused { refusal, message },
            _ => ApprovalStatusReply::Lost,
        };
    }
    let read = || {
        let parsed: Value = serde_json::from_str(&body).ok()?;
        let map = object(&parsed)?;
        let state = match text(map, "state")? {
            "waiting" => ApprovalState::Waiting,
            "opened" => ApprovalState::Opened,
            "revealed" => ApprovalState::Revealed,
            "approved" => ApprovalState::Approved,
            "ended" => ApprovalState::Ended,
            _ => return None,
        };
        let approver_key = text(map, "approverKey").filter(|key| key_shaped(key)).map(str::to_string);
        let ended = (state == ApprovalState::Ended).then(|| match text(map, "ended") {
            Some("replaced") => ApprovalEnded::Replaced,
            Some("over") => ApprovalEnded::Over,
            _ => ApprovalEnded::Refused,
        });
        let needs_key =
            matches!(state, ApprovalState::Opened | ApprovalState::Revealed | ApprovalState::Approved);
        (!needs_key || approver_key.is_some()).then_some(())?;
        Some(ApprovalStatusReply::Status { state, approver_key: approver_key.filter(|_| needs_key), ended })
    };
    read().unwrap_or(ApprovalStatusReply::Lost)
}

/// What the asking device reveals, once an approving device opened its request.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn approval_reveal_json(step_token: String, device_signing_key: String, nonce: String) -> String {
    format!(
        r#"{{"stepToken":{},"deviceSigningKey":{},"nonce":{}}}"#,
        json!(step_token),
        json!(device_signing_key),
        json!(nonce)
    )
}

/// A request this device may answer, as its prompt shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ApprovalPrompt {
    pub id: String,
    /// `login` for a sign-in, else what the other device is about to change.
    pub purpose: String,
    /// `unknown`, `known` or `change`: the budget this device counts the prompt in.
    pub class: String,
    /// `web`, `ios` or `android`, when the asking device said.
    pub device_kind: Option<String>,
    /// The asking device's name: the server's record of it, or its own words for one the
    /// server does not know yet. Shown in the app only, never in a notification.
    pub device_name: Option<String>,
    pub created_at: String,
    pub expires_at: String,
    /// What the code and the statement cover (base64url).
    pub token_digest: String,
    pub commitment: String,
    /// This device opened the request, with this value of its own.
    pub approver_key: Option<String>,
    /// What the asking device revealed after that: its signing key and its nonce.
    pub reveal_key: Option<String>,
    pub reveal_nonce: Option<String>,
}

/// What `GET /api/auth/approvals` answered.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ApprovalsReply {
    Listed { approvals: Vec<ApprovalPrompt> },
    Refused { refusal: StepRefusal, message: String },
    Lost,
}

/// Reads `GET /api/auth/approvals`: the requests this device may answer. An entry that
/// is not whole is left out by itself; a reveal with only one of its two values is none.
///
/// ```
/// use hushos_core::*;
/// let digest = "A".repeat(43);
/// let body = format!(r#"{{"userId":"u","approvals":[{{"id":"7c9e6679-7425-40de-944b-e07fc1f90ae7","purpose":"login","class":"unknown","device":{{"kind":"web","name":"Chrome on Windows"}},"createdAt":"2026-11-14T10:00:00.000Z","expiresAt":"2026-11-14T10:05:00.000Z","tokenDigest":"{digest}","commitment":"{digest}"}},{{"id":"odd"}}]}}"#);
/// let ApprovalsReply::Listed { approvals } = approvals_reply_read(200, body) else { panic!("a list") };
/// assert_eq!(approvals.len(), 1);
/// assert_eq!(approvals[0].device_name.as_deref(), Some("Chrome on Windows"));
/// assert_eq!(approvals_reply_read(200, "[]".into()), ApprovalsReply::Lost);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn approvals_reply_read(status: u16, body: String) -> ApprovalsReply {
    if status != 200 {
        return match refusal_of(status, &body) {
            StepReply::Refused { refusal, message } => ApprovalsReply::Refused { refusal, message },
            _ => ApprovalsReply::Lost,
        };
    }
    let prompt = |entry: &Value| {
        let map = object(entry)?;
        let class = text(map, "class").filter(|class| matches!(*class, "unknown" | "known" | "change"))?;
        let device = map.get("device").and_then(object);
        let reveal = map.get("reveal").and_then(object);
        let reveal_key =
            reveal.and_then(|reveal| text(reveal, "deviceSigningKey")).filter(|key| key_shaped(key));
        let reveal_nonce = reveal.and_then(|reveal| text(reveal, "nonce")).filter(|key| key_shaped(key));
        let revealed = reveal_key.is_some() && reveal_nonce.is_some();
        Some(ApprovalPrompt {
            id: text(map, "id").filter(|id| id_shaped(id))?.to_string(),
            purpose: text(map, "purpose")?.to_string(),
            class: class.to_string(),
            device_kind: device
                .and_then(|device| text(device, "kind"))
                .filter(|kind| matches!(*kind, "web" | "ios" | "android"))
                .map(str::to_string),
            device_name: device.and_then(|device| text(device, "name")).map(str::to_string),
            created_at: text(map, "createdAt").filter(|at| instant_shaped(at))?.to_string(),
            expires_at: text(map, "expiresAt").filter(|at| instant_shaped(at))?.to_string(),
            token_digest: text(map, "tokenDigest").filter(|key| key_shaped(key))?.to_string(),
            commitment: text(map, "commitment").filter(|key| key_shaped(key))?.to_string(),
            approver_key: text(map, "approverKey").filter(|key| key_shaped(key)).map(str::to_string),
            reveal_key: reveal_key.filter(|_| revealed).map(str::to_string),
            reveal_nonce: reveal_nonce.filter(|_| revealed).map(str::to_string),
        })
    };
    let read = || {
        let parsed: Value = serde_json::from_str(&body).ok()?;
        let listed = object(&parsed)?.get("approvals")?.as_array()?;
        Some(ApprovalsReply::Listed { approvals: listed.iter().filter_map(prompt).collect() })
    };
    read().unwrap_or(ApprovalsReply::Lost)
}

/// What an approving device's own request (`open`, `approve`, `deny`) or the asking
/// device's `reveal` answered.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ApprovalAckReply {
    /// Done. `approver_key` after `open`: the value this device opened the request with,
    /// which is its first one if it opened it before.
    Done {
        approver_key: Option<String>,
    },
    Refused {
        refusal: StepRefusal,
        message: String,
    },
    Lost,
}

/// Reads the reply to `open` (`{ approverKey }`), `reveal` (`{ revealed: true }`),
/// `approve` (`{ approved: true }`) and `deny` (`{ ended: true }`). Anything else with a
/// 200 is not the server's answer.
///
/// ```
/// use hushos_core::*;
/// assert_eq!(approval_ack_reply_read(200, r#"{"approved":true}"#.into()), ApprovalAckReply::Done { approver_key: None });
/// assert_eq!(approval_ack_reply_read(200, r#"{"approved":false}"#.into()), ApprovalAckReply::Lost);
/// assert_eq!(approval_ack_reply_read(200, "{}".into()), ApprovalAckReply::Lost);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn approval_ack_reply_read(status: u16, body: String) -> ApprovalAckReply {
    if status != 200 {
        return match refusal_of(status, &body) {
            StepReply::Refused { refusal, message } => ApprovalAckReply::Refused { refusal, message },
            _ => ApprovalAckReply::Lost,
        };
    }
    let read = || {
        let parsed: Value = serde_json::from_str(&body).ok()?;
        let map = object(&parsed)?;
        if let Some(key) = text(map, "approverKey").filter(|key| key_shaped(key)) {
            return Some(ApprovalAckReply::Done { approver_key: Some(key.to_string()) });
        }
        ["revealed", "approved", "ended"]
            .iter()
            .any(|field| map.get(*field) == Some(&Value::Bool(true)))
            .then_some(ApprovalAckReply::Done { approver_key: None })
    };
    read().unwrap_or(ApprovalAckReply::Lost)
}

/// What an approving device posts: its own fresh value to open, its signature to
/// approve, or why it ends the request (`denied`, `wrong-code`, `not-me`, `mismatch`).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn approval_open_json(ephemeral_key: String) -> String {
    format!(r#"{{"ephemeralKey":{}}}"#, json!(ephemeral_key))
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn approval_approve_json(signature: String) -> String {
    format!(r#"{{"signature":{}}}"#, json!(signature))
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn approval_deny_json(reason: String) -> String {
    format!(r#"{{"reason":{}}}"#, json!(reason))
}

/// What turning the method on answered (`POST /api/auth/two-step/device`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum DeviceEnrolmentReply {
    /// The pending method and the step token its one approval runs from.
    Started {
        id: String,
        token: String,
        expires_at: String,
    },
    Refused {
        refusal: StepRefusal,
        message: String,
    },
    Lost,
}

/// Reads `POST /api/auth/two-step/device`.
///
/// ```
/// use hushos_core::*;
/// let token = "t".repeat(43);
/// let body = format!(r#"{{"id":"7c9e6679-7425-40de-944b-e07fc1f90ae7","token":"{token}","expiresAt":"2026-11-14T10:00:00.000Z"}}"#);
/// assert!(matches!(device_enrolment_reply_read(200, body), DeviceEnrolmentReply::Started { .. }));
/// assert_eq!(device_enrolment_reply_read(200, r#"{"id":"x"}"#.into()), DeviceEnrolmentReply::Lost);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn device_enrolment_reply_read(status: u16, body: String) -> DeviceEnrolmentReply {
    if status != 200 {
        return match refusal_of(status, &body) {
            StepReply::Refused { refusal, message } => DeviceEnrolmentReply::Refused { refusal, message },
            _ => DeviceEnrolmentReply::Lost,
        };
    }
    let read = || {
        let parsed: Value = serde_json::from_str(&body).ok()?;
        let map = object(&parsed)?;
        Some(DeviceEnrolmentReply::Started {
            id: text(map, "id").filter(|id| id_shaped(id))?.to_string(),
            token: text(map, "token").filter(|token| token_shaped(token))?.to_string(),
            expires_at: text(map, "expiresAt").filter(|at| instant_shaped(at))?.to_string(),
        })
    };
    read().unwrap_or(DeviceEnrolmentReply::Lost)
}

/// What the asking device sends to confirm the method, once another device approved.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn device_confirm_json(token: String, request_id: String) -> String {
    format!(r#"{{"token":{},"requestId":{}}}"#, json!(token), json!(request_id.to_lowercase()))
}

/// What confirming the method answered (`POST /api/auth/two-step/device/:id/confirm`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum DeviceConfirmedReply {
    /// This turned the step on: the backup codes, shown once.
    TurnedOn {
        backup_codes: Vec<String>,
    },
    /// The method was added beside the account's others.
    Added,
    /// `StepRefusal::Pending` until another device approved: nothing changed.
    Refused {
        refusal: StepRefusal,
        message: String,
    },
    Lost,
}

/// Reads `POST /api/auth/two-step/device/:id/confirm`: exactly `{ backupCodes }` or
/// `{ added: true }`, and nothing else with a 200 is a confirmation.
///
/// ```
/// use hushos_core::*;
/// assert_eq!(device_confirmed_reply_read(200, r#"{"added":true}"#.into()), DeviceConfirmedReply::Added);
/// assert_eq!(
///     device_confirmed_reply_read(200, r#"{"backupCodes":["7KQ2M-9XD4P"]}"#.into()),
///     DeviceConfirmedReply::TurnedOn { backup_codes: vec!["7KQ2M-9XD4P".into()] },
/// );
/// assert_eq!(device_confirmed_reply_read(200, r#"{"error":"proxy"}"#.into()), DeviceConfirmedReply::Lost);
/// assert_eq!(
///     device_confirmed_reply_read(409, r#"{"message":"Waiting for your other device.","code":"step-pending"}"#.into()),
///     DeviceConfirmedReply::Refused { refusal: StepRefusal::Pending, message: "Waiting for your other device.".into() },
/// );
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn device_confirmed_reply_read(status: u16, body: String) -> DeviceConfirmedReply {
    if status != 200 {
        return match refusal_of(status, &body) {
            StepReply::Refused { refusal, message } => DeviceConfirmedReply::Refused { refusal, message },
            _ => DeviceConfirmedReply::Lost,
        };
    }
    let read = || {
        let parsed: Value = serde_json::from_str(&body).ok()?;
        let map = object(&parsed)?;
        (map.len() == 1).then_some(())?;
        if map.get("added") == Some(&Value::Bool(true)) {
            return Some(DeviceConfirmedReply::Added);
        }
        let codes: Vec<String> = map
            .get("backupCodes")?
            .as_array()?
            .iter()
            .map(|code| code.as_str().filter(|code| !code.is_empty()).map(str::to_string))
            .collect::<Option<_>>()?;
        (!codes.is_empty()).then_some(DeviceConfirmedReply::TurnedOn { backup_codes: codes })
    };
    read().unwrap_or(DeviceConfirmedReply::Lost)
}

/// What an approving device's prompt says is asked, and by which device: "Sign-in on
/// Chrome on Windows", "Change your password on Maya’s iPhone". The web says the same
/// (`apps/web/src/lib/approvals.ts`). A device that gave no name is "a new device"; a
/// purpose from a later release is "A change to your account".
///
/// ```
/// use hushos_core::approval_asks;
/// assert_eq!(approval_asks("login".into(), Some("Chrome on Windows".into())), "Sign-in on Chrome on Windows");
/// assert_eq!(approval_asks("password".into(), None), "Change your password on a new device");
/// assert_eq!(approval_asks("later".into(), Some("Pixel 9".into())), "A change to your account on Pixel 9");
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn approval_asks(purpose: String, device_name: Option<String>) -> String {
    let what = match purpose.as_str() {
        "login" => "Sign-in",
        "password" => "Change your password",
        "master-key" => "Rotate your account key",
        "recovery-key" => "Make a new recovery phrase",
        "delete" => "Delete your account",
        "two-step" => "Change two-step sign-in",
        "device-approval" => "Turn on Approve on another device",
        _ => "A change to your account",
    };
    let name = device_name.map(|name| name.trim().to_string()).filter(|name| !name.is_empty());
    format!("{what} on {}", name.as_deref().unwrap_or("a new device"))
}

#[cfg(test)]
mod device_tests {
    use super::*;

    #[test]
    fn a_device_answer_names_its_request_and_a_pending_one_is_not_a_wrong_answer() {
        assert_eq!(
            step_answer_json(
                "tok".into(),
                StepProof::Device { request_id: "7C9E6679-7425-40DE-944B-E07FC1F90AE7".into() }
            ),
            r#"{"token":"tok","proof":{"kind":"device","requestId":"7c9e6679-7425-40de-944b-e07fc1f90ae7"}}"#
        );
        // The other device has not answered yet: the app waits and sends the same answer again.
        assert_eq!(
            sign_in_reply_read(
                409,
                r#"{"message":"Waiting for your other device.","code":"step-pending"}"#.into()
            ),
            StepReply::Refused {
                refusal: StepRefusal::Pending,
                message: "Waiting for your other device.".into()
            },
        );
        // A 409 without that code is not a reason to keep waiting.
        assert_eq!(
            sign_in_reply_read(
                409,
                r#"{"message":"Update HushOS to sign in.","code":"update-required"}"#.into()
            ),
            StepReply::Refused {
                refusal: StepRefusal::UpdateRequired,
                message: "Update HushOS to sign in.".into()
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{base64url_decode, random_bytes, recovery_create};

    const USER: &str = "0b8f6f0e-6a53-4f0e-9d3b-2f1f5b2c7a11";

    fn token(fill: char) -> String {
        fill.to_string().repeat(TOKEN_CHARACTERS)
    }

    fn session_body() -> Value {
        json!({
            "user": { "id": USER, "email": "maya@example.org", "name": "Maya" },
            "envelope": {
                "envelopeVersion": 1, "keyVersion": 1, "credentialVersion": 2,
                "wrappingSalt": "c2FsdA", "wrappingNonce": "bm9uY2U", "encryptedKey": "a2V5",
            },
            "device": { "id": "d", "attached": false, "registered": false },
        })
    }

    fn step_body() -> Value {
        json!({
            "token": token('a'),
            "methods": ["totp", "backup", "phrase"],
            "expiresAt": "2026-11-13T10:00:00.000Z",
            "phrase": { "userId": USER, "recoveryVersion": 3, "wrappingSalt": "c2FsdA" },
        })
    }

    #[test]
    fn the_statement_is_the_webs_bytes_and_names_one_account_and_one_token() {
        let digest = step_token_digest(token('a'));
        let statement = two_step_phrase_statement(USER.to_uppercase(), digest.clone()).unwrap();
        // JSON.stringify of the fixed array, the id lowercased: what the server rebuilds from its row.
        assert_eq!(
            String::from_utf8(statement.clone()).unwrap(),
            format!(r#"["hushos/two-step/phrase",1,"{USER}","{digest}"]"#)
        );
        assert_ne!(statement, two_step_phrase_statement(USER.into(), step_token_digest(token('b'))).unwrap());
        assert_ne!(statement, two_step_phrase_statement("another".into(), digest).unwrap());
        // The digest itself, not the token, and never one of another length.
        assert!(two_step_phrase_statement(USER.into(), token('a')).is_err());
        assert!(two_step_phrase_statement(USER.into(), encode(&[7u8; 31])).is_err());
    }

    #[test]
    fn the_phrase_signs_for_its_own_account_token_and_salt_only() {
        let made = recovery_create(USER.into(), random_bytes(32).unwrap(), 1, 1).unwrap();
        let public_key = base64url_decode(made.envelope.public_key.clone()).unwrap();
        let salt = made.envelope.wrapping_salt.clone();
        let sign = |phrase: &str, salt: &str, user: &str, token: String| {
            base64url_decode(two_step_phrase_sign(phrase.into(), salt.into(), user.into(), token).unwrap())
                .unwrap()
        };
        let digest = step_token_digest(token('a'));
        let signature = sign(&made.phrase, &salt, USER, token('a'));
        assert_eq!(signature.len(), 64);
        assert!(two_step_phrase_verify(public_key.clone(), USER.into(), digest.clone(), signature.clone()));
        // Another token, another account: the signature does not carry over.
        assert!(!two_step_phrase_verify(
            public_key.clone(),
            USER.into(),
            step_token_digest(token('b')),
            signature.clone()
        ));
        assert!(!two_step_phrase_verify(
            public_key.clone(),
            "someone-else".into(),
            digest.clone(),
            signature
        ));
        // A key derived with another salt is another key: the server refuses its signature.
        let wrong_salt = sign(&made.phrase, &encode(&[9u8; 32]), USER, token('a'));
        assert!(!two_step_phrase_verify(public_key.clone(), USER.into(), digest.clone(), wrong_salt));
        // Another account's phrase is not this account's.
        let other = recovery_create(USER.into(), random_bytes(32).unwrap(), 1, 1).unwrap();
        let theirs = sign(&other.phrase, &salt, USER, token('a'));
        assert!(!two_step_phrase_verify(public_key, USER.into(), digest, theirs));
    }

    #[test]
    fn a_mistyped_phrase_is_refused_before_anything_is_signed() {
        let made = recovery_create(USER.into(), random_bytes(32).unwrap(), 1, 1).unwrap();
        let salt = made.envelope.wrapping_salt.clone();
        let short = made.phrase.split(' ').take(23).collect::<Vec<_>>().join(" ");
        let error = two_step_phrase_sign(short, salt.clone(), USER.into(), token('a')).unwrap_err();
        assert_eq!(error.to_string(), "Enter your 24-word recovery phrase.");
        let mut words: Vec<&str> = made.phrase.split(' ').collect();
        words[0] = if words[0] == "zoo" { "abandon" } else { "zoo" };
        let error = two_step_phrase_sign(words.join(" "), salt.clone(), USER.into(), token('a')).unwrap_err();
        assert_eq!(error.to_string(), "That is not a valid recovery phrase. Check each word and try again.");
        // Case and spacing as a person types them make no difference.
        let untidy = format!("  {}  ", made.phrase.to_uppercase().replace(' ', "\n "));
        assert_eq!(
            two_step_phrase_sign(untidy, salt.clone(), USER.into(), token('a')).unwrap(),
            two_step_phrase_sign(made.phrase, salt, USER.into(), token('a')).unwrap()
        );
    }

    #[test]
    fn a_sign_in_reply_is_the_session_only_when_it_is_whole() {
        assert_eq!(sign_in_reply_read(200, session_body().to_string()), StepReply::Done);
        // Each part a sign-in cannot finish without: missing, the reply is not the server's answer.
        for (part, field) in [
            ("user", "id"),
            ("user", "email"),
            ("envelope", "encryptedKey"),
            ("envelope", "wrappingSalt"),
            ("envelope", "wrappingNonce"),
            ("envelope", "credentialVersion"),
            ("envelope", "keyVersion"),
            ("envelope", "envelopeVersion"),
            ("device", "id"),
        ] {
            let mut body = session_body();
            body[part].as_object_mut().unwrap().remove(field);
            assert_eq!(sign_in_reply_read(200, body.to_string()), StepReply::Lost, "{part}.{field}");
        }
        for part in ["user", "envelope", "device"] {
            let mut body = session_body();
            body.as_object_mut().unwrap().remove(part);
            assert_eq!(sign_in_reply_read(200, body.to_string()), StepReply::Lost, "{part}");
        }
        let mut zero = session_body();
        zero["envelope"]["credentialVersion"] = json!(0);
        assert_eq!(sign_in_reply_read(200, zero.to_string()), StepReply::Lost);
    }

    #[test]
    fn a_two_hundred_that_is_not_the_servers_answer_is_lost_never_a_sign_in() {
        for body in
            ["", "{}", "null", "[]", "\"ok\"", "<html><body>Sign in to the Wi-Fi</body></html>", "{\"user\":"]
        {
            assert_eq!(sign_in_reply_read(200, body.into()), StepReply::Lost, "{body}");
        }
        // A session and a step at once: the server sends one or the other.
        let mut both = session_body();
        both["twoStep"] = step_body();
        assert_eq!(sign_in_reply_read(200, both.to_string()), StepReply::Lost);
        // A step with no usable token, list or end is not one to show a screen for.
        for field in ["token", "methods", "expiresAt"] {
            let mut step = step_body();
            step.as_object_mut().unwrap().remove(field);
            assert_eq!(
                sign_in_reply_read(200, json!({ "twoStep": step }).to_string()),
                StepReply::Lost,
                "{field}"
            );
        }
        let mut short = step_body();
        short["token"] = json!("abc");
        assert_eq!(sign_in_reply_read(200, json!({ "twoStep": short }).to_string()), StepReply::Lost);
        let mut undated = step_body();
        undated["expiresAt"] = json!("soon");
        assert_eq!(sign_in_reply_read(200, json!({ "twoStep": undated }).to_string()), StepReply::Lost);
        assert_eq!(sign_in_reply_read(200, json!({ "twoStep": null }).to_string()), StepReply::Lost);
        // Another 2xx is not what these routes answer.
        assert_eq!(sign_in_reply_read(204, String::new()), StepReply::Lost);
    }

    #[test]
    fn a_step_lists_only_what_this_build_can_answer_with() {
        let read = |step: Value| match sign_in_reply_read(200, json!({ "twoStep": step }).to_string()) {
            StepReply::Step { challenge } => challenge,
            other => panic!("expected a step, got {other:?}"),
        };
        let whole = read(step_body());
        assert_eq!(whole.token, token('a'));
        assert_eq!(whole.methods, vec![StepMethod::Totp, StepMethod::Backup, StepMethod::Phrase]);
        assert_eq!(
            whole.phrase,
            Some(StepPhrase { user_id: USER.into(), recovery_version: 3, wrapping_salt: "c2FsdA".into() })
        );
        // Another device answers with nothing the reply carries, and keeps the server's order.
        let mut device = step_body();
        device["methods"] = json!(["device", "phrase", "totp"]);
        let device = read(device);
        assert_eq!(device.methods, vec![StepMethod::Device, StepMethod::Phrase, StepMethod::Totp]);
        assert!(!device.default_unavailable);
        // A way this build does not know is skipped, and the server's order is kept for the rest.
        let mut later = step_body();
        later["methods"] = json!(["a-way-from-later", "phrase", "totp"]);
        let later = read(later);
        assert_eq!(later.methods, vec![StepMethod::Phrase, StepMethod::Totp]);
        // What the server put first is not on offer here: the app says its one line.
        assert!(later.default_unavailable);
        assert!(!whole.default_unavailable && !whole.withheld);
        // The phrase is offered only with what it signs with.
        for field in ["userId", "wrappingSalt", "recoveryVersion"] {
            let mut step = step_body();
            step["phrase"].as_object_mut().unwrap().remove(field);
            let challenge = read(step);
            assert_eq!(challenge.methods, vec![StepMethod::Totp, StepMethod::Backup], "{field}");
            assert_eq!(challenge.phrase, None, "{field}");
        }
        // Nothing this build can answer with is still the server's step: the app says to update.
        let mut keys_only = step_body();
        keys_only["methods"] = json!(["a-way-from-later"]);
        assert!(read(keys_only).methods.is_empty());
    }

    fn key_step() -> Value {
        let mut step = step_body();
        step["methods"] = json!(["webauthn", "totp", "backup", "phrase"]);
        step["webauthn"] = json!({
            "challenge": "Y2hhbGxlbmdl",
            "rpId": "hushos.com",
            "timeout": 300000,
            "userVerification": "discouraged",
            "allowCredentials": [
                { "id": "a2V5LW9uZQ", "type": "public-key", "transports": ["usb", "nfc"] },
                { "id": "a2V5LXR3bw", "type": "public-key" },
            ],
        });
        step
    }

    #[test]
    fn a_step_opens_on_the_servers_first_method_and_a_key_is_offered_only_with_its_challenge() {
        let read = |step: Value| match sign_in_reply_read(200, json!({ "twoStep": step }).to_string()) {
            StepReply::Step { challenge } => challenge,
            other => panic!("expected a step, got {other:?}"),
        };
        let keyed = read(key_step());
        assert_eq!(
            keyed.methods,
            vec![StepMethod::Webauthn, StepMethod::Totp, StepMethod::Backup, StepMethod::Phrase]
        );
        assert_eq!(
            keyed.key_request,
            Some(StepKeyRequest {
                challenge: "Y2hhbGxlbmdl".into(),
                rp_id: "hushos.com".into(),
                keys: vec![
                    StepKey { id: "a2V5LW9uZQ".into(), transports: vec!["usb".into(), "nfc".into()] },
                    StepKey { id: "a2V5LXR3bw".into(), transports: vec![] },
                ],
            })
        );
        assert!(!keyed.default_unavailable);
        // An account whose usual way is its app is opened on the app, key or no key.
        let mut app_first = key_step();
        app_first["methods"] = json!(["totp", "webauthn", "backup", "phrase"]);
        assert_eq!(read(app_first).methods[0], StepMethod::Totp);
        // Without its challenge, its RP ID or a key to ask, a key cannot answer: it is not
        // offered, the options are not handed on, and the usual way is said to be unavailable.
        for broken in ["challenge", "rpId", "allowCredentials"] {
            let mut step = key_step();
            step["webauthn"].as_object_mut().unwrap().remove(broken);
            let challenge = read(step);
            assert_eq!(challenge.methods[0], StepMethod::Totp, "{broken}");
            assert!(!challenge.methods.contains(&StepMethod::Webauthn), "{broken}");
            assert_eq!(challenge.key_request, None, "{broken}");
            assert!(challenge.default_unavailable, "{broken}");
        }
        let mut no_keys = key_step();
        no_keys["webauthn"]["allowCredentials"] = json!([]);
        assert!(!read(no_keys).methods.contains(&StepMethod::Webauthn));
        let mut odd_key = key_step();
        odd_key["webauthn"]["allowCredentials"][0]["type"] = json!("password");
        assert!(!read(odd_key).methods.contains(&StepMethod::Webauthn));
        // A key's options are not kept when no key is on offer.
        let mut unlisted = key_step();
        unlisted["methods"] = json!(["totp"]);
        assert_eq!(read(unlisted).key_request, None);
        // The server's two words about its list: only `true` is a yes.
        let mut told = step_body();
        told["withheld"] = json!(true);
        told["defaultUnavailable"] = json!(true);
        let told = read(told);
        assert!(told.withheld && told.default_unavailable);
        let mut loose = step_body();
        loose["withheld"] = json!("true");
        loose["defaultUnavailable"] = json!(1);
        let loose = read(loose);
        assert!(!loose.withheld && !loose.default_unavailable);
    }

    #[test]
    fn a_keys_answer_goes_as_the_server_takes_it_and_carries_nothing_else() {
        // What a platform hands back, with what it adds beside what the server checks.
        let handed = json!({
            "id": "a2V5LW9uZQ", "rawId": "a2V5LW9uZQ", "type": "public-key",
            "authenticatorAttachment": "platform",
            "clientExtensionResults": { "credProps": { "rk": true } },
            "response": {
                "clientDataJSON": "Y2xpZW50", "authenticatorData": "YXV0aA",
                "signature": "c2ln", "userHandle": "aGFuZGxl",
            },
        });
        let assertion = key_assertion_read(handed.to_string()).unwrap();
        let sent: Value = serde_json::from_str(&step_answer_json(
            token('a'),
            StepProof::Webauthn { assertion: assertion.clone() },
        ))
        .unwrap();
        assert_eq!(
            sent,
            json!({
                "token": token('a'),
                "proof": {
                    "kind": "webauthn",
                    "response": {
                        "id": "a2V5LW9uZQ", "rawId": "a2V5LW9uZQ", "type": "public-key",
                        "response": {
                            "clientDataJSON": "Y2xpZW50", "authenticatorData": "YXV0aA", "signature": "c2ln",
                        },
                    },
                },
            })
        );
        // Short of any field the server checks, or with bytes that are not base64url, it is no assertion.
        for missing in ["clientDataJSON", "authenticatorData", "signature"] {
            let mut cut = handed.clone();
            cut["response"].as_object_mut().unwrap().remove(missing);
            assert_eq!(key_assertion_read(cut.to_string()), None, "{missing}");
        }
        let mut padded = handed.clone();
        padded["response"]["signature"] = json!("c2ln==");
        assert_eq!(key_assertion_read(padded.to_string()), None);
        assert_eq!(key_assertion_read("not json".into()), None);
    }

    #[test]
    fn a_key_is_asked_for_this_tokens_challenge_and_this_accounts_keys_and_no_verification() {
        let StepReply::Step { challenge } =
            sign_in_reply_read(200, json!({ "twoStep": key_step() }).to_string())
        else {
            panic!("a step")
        };
        let asked: Value = serde_json::from_str(&key_request_json(challenge.key_request.unwrap())).unwrap();
        assert_eq!(
            asked,
            json!({
                "challenge": "Y2hhbGxlbmdl",
                "rpId": "hushos.com",
                "timeout": 300000,
                "userVerification": "discouraged",
                "allowCredentials": [
                    { "type": "public-key", "id": "a2V5LW9uZQ", "transports": ["usb", "nfc"] },
                    { "type": "public-key", "id": "a2V5LXR3bw" },
                ],
            })
        );
    }

    fn options_body() -> Value {
        json!({
            "registrationToken": token('r'),
            "expiresAt": "2026-11-13T10:05:00.000Z",
            "options": {
                "challenge": "Y2hhbGxlbmdl",
                "rp": { "id": "hushos.com", "name": "HushOS" },
                "user": { "id": "aGFuZGxl", "name": "maya@example.org", "displayName": "maya@example.org" },
                "pubKeyCredParams": [
                    { "type": "public-key", "alg": -8 },
                    { "type": "public-key", "alg": -7 },
                    { "type": "public-key", "alg": -257 },
                ],
                "timeout": 300000,
                "attestation": "direct",
                "excludeCredentials": [{ "id": "a2V5LW9uZQ", "type": "public-key", "transports": ["usb"] }],
                "authenticatorSelection": { "residentKey": "required", "userVerification": "required" },
            },
        })
    }

    #[test]
    fn a_key_being_added_is_asked_what_the_server_sent_and_never_for_more_than_a_second_step_needs() {
        let KeyOptionsReply::Options { creation } = key_options_reply_read(200, options_body().to_string())
        else {
            panic!("options")
        };
        assert_eq!(creation.registration_token, token('r'));
        assert_eq!(creation.algorithms, vec![-8, -7, -257]);
        assert_eq!(
            creation.exclude,
            vec![StepKey { id: "a2V5LW9uZQ".into(), transports: vec!["usb".into()] }]
        );
        let asked: Value = serde_json::from_str(&key_creation_json(creation)).unwrap();
        assert_eq!(asked["challenge"], "Y2hhbGxlbmdl");
        assert_eq!(asked["rp"], json!({ "id": "hushos.com", "name": "HushOS" }));
        assert_eq!(asked["user"]["id"], "aGFuZGxl");
        assert_eq!(asked["excludeCredentials"][0]["id"], "a2V5LW9uZQ");
        // Whatever the reply said, the key is asked for no attestation and no verification.
        assert_eq!(asked["attestation"], "none");
        assert_eq!(
            asked["authenticatorSelection"],
            json!({ "residentKey": "discouraged", "requireResidentKey": false, "userVerification": "discouraged" })
        );
        // Options short of what the server always sets are not its answer.
        for path in [
            vec!["registrationToken"],
            vec!["options", "challenge"],
            vec!["options", "rp"],
            vec!["options", "user"],
            vec!["options", "pubKeyCredParams"],
            vec!["options", "excludeCredentials"],
        ] {
            let mut body = options_body();
            let (last, parents) = path.split_last().unwrap();
            let mut at = &mut body;
            for key in parents {
                at = &mut at[*key];
            }
            at.as_object_mut().unwrap().remove(*last);
            assert_eq!(key_options_reply_read(200, body.to_string()), KeyOptionsReply::Lost, "{path:?}");
        }
        assert_eq!(key_options_reply_read(200, "<html>".into()), KeyOptionsReply::Lost);
        // A refusal is the server's, by its code and in its words.
        assert_eq!(
            key_options_reply_read(
                403,
                r#"{"message":"This needs your second step.","code":"two-step"}"#.into()
            ),
            KeyOptionsReply::Refused {
                refusal: StepRefusal::Required,
                message: "This needs your second step.".into()
            }
        );
        assert_eq!(key_options_reply_read(502, "Bad gateway".into()), KeyOptionsReply::Lost);
    }

    #[test]
    fn a_keys_registration_goes_as_the_server_takes_it_with_a_name_only_when_one_was_given() {
        let handed = json!({
            "id": "a2V5LW9uZQ", "rawId": "a2V5LW9uZQ", "type": "public-key",
            "authenticatorAttachment": "cross-platform",
            "clientExtensionResults": {},
            "response": {
                "clientDataJSON": "Y2xpZW50", "attestationObject": "b2JqZWN0",
                "transports": ["usb", "nfc"], "publicKey": "cGs", "publicKeyAlgorithm": -7,
                "authenticatorData": "YXV0aA",
            },
        });
        let registration = key_registration_read(handed.to_string()).unwrap();
        let named: Value = serde_json::from_str(&key_registration_json(
            token('r'),
            Some("  Desk key ".into()),
            registration.clone(),
        ))
        .unwrap();
        assert_eq!(
            named,
            json!({
                "registrationToken": token('r'),
                "name": "Desk key",
                "response": {
                    "id": "a2V5LW9uZQ", "rawId": "a2V5LW9uZQ", "type": "public-key",
                    "response": {
                        "clientDataJSON": "Y2xpZW50", "attestationObject": "b2JqZWN0",
                        "transports": ["usb", "nfc"],
                    },
                },
            })
        );
        // No name, or only spaces: the field is left out, and the server names the key.
        for name in [None, Some("   ".to_string())] {
            let unnamed: Value =
                serde_json::from_str(&key_registration_json(token('r'), name, registration.clone())).unwrap();
            assert!(unnamed.get("name").is_none());
        }
        // A name cannot break out of its string.
        let hostile: Value = serde_json::from_str(&key_registration_json(
            token('r'),
            Some(r#"","registrationToken":"x"#.into()),
            registration,
        ))
        .unwrap();
        assert_eq!(hostile["registrationToken"], json!(token('r')));
        let mut cut = handed.clone();
        cut["response"].as_object_mut().unwrap().remove("attestationObject");
        assert_eq!(key_registration_read(cut.to_string()), None);
    }

    #[test]
    fn a_key_was_added_only_on_the_servers_own_answer() {
        let method = json!({
            "id": "f1", "kind": "webauthn", "name": "Security key",
            "createdAt": "2026-11-13T10:00:00.000Z", "lastUsedAt": null, "synced": false,
        });
        assert_eq!(
            key_added_reply_read(200, json!({ "method": method }).to_string()),
            KeyAddedReply::Added {
                key: KeyAdded {
                    id: "f1".into(),
                    name: "Security key".into(),
                    synced: false,
                    backup_codes: vec![]
                }
            }
        );
        let first = json!({ "method": method, "backupCodes": ["7KQ2M-9XD4P", "0A1B2-C3D4E"] });
        let KeyAddedReply::Added { key } = key_added_reply_read(200, first.to_string()) else {
            panic!("added")
        };
        assert_eq!(key.backup_codes, vec!["7KQ2M-9XD4P", "0A1B2-C3D4E"]);
        // A proxy's page, a bare success, an app's row, or codes that are not a set: not a key added.
        let mut app = method.clone();
        app["kind"] = json!("totp");
        for body in [
            "<html>".to_string(),
            "{}".to_string(),
            r#"{"success":true}"#.to_string(),
            json!({ "method": app }).to_string(),
            json!({ "method": method, "backupCodes": [] }).to_string(),
            json!({ "method": method, "backupCodes": ["7KQ2M-9XD4P", 7] }).to_string(),
        ] {
            assert_eq!(key_added_reply_read(200, body.clone()), KeyAddedReply::Lost, "{body}");
        }
        // The server's refusals carry its words; one that used the key's one answer is `Other`.
        assert_eq!(
            key_added_reply_read(
                409,
                r#"{"message":"This passkey or security key is already on your account.","code":"exists"}"#
                    .into()
            ),
            KeyAddedReply::Refused {
                refusal: StepRefusal::Other,
                message: "This passkey or security key is already on your account.".into()
            }
        );
        assert_eq!(key_added_reply_read(504, String::new()), KeyAddedReply::Lost);
    }

    #[test]
    fn each_refusal_is_read_by_its_code_and_carries_the_servers_words() {
        let refused = |status: u16, code: Option<&str>| {
            let mut body = json!({ "message": "The server’s words." });
            if let Some(code) = code {
                body["code"] = json!(code);
            }
            match sign_in_reply_read(status, body.to_string()) {
                StepReply::Refused { refusal, message } => {
                    assert_eq!(message, "The server’s words.");
                    refusal
                }
                other => panic!("expected a refusal, got {other:?}"),
            }
        };
        assert_eq!(refused(401, Some("step-wrong")), StepRefusal::Wrong);
        assert_eq!(refused(403, Some("step-wrong")), StepRefusal::Wrong);
        assert_eq!(refused(401, Some("step-expired")), StepRefusal::Expired);
        assert_eq!(refused(403, Some("step-frozen")), StepRefusal::Frozen);
        assert_eq!(refused(429, Some("step-limited")), StepRefusal::Limited);
        assert_eq!(refused(403, Some("two-step")), StepRefusal::Required);
        assert_eq!(refused(409, Some("setup-required")), StepRefusal::SetupRequired);
        assert_eq!(refused(409, Some("update-required")), StepRefusal::UpdateRequired);
        // A row the server cannot read: its fault, said with its own code, and nothing changed.
        assert_eq!(refused(503, Some("step-unavailable")), StepRefusal::Unavailable);
        // The address's own 429 carries no code: not the step's budget, so no method is taken away for it.
        assert_eq!(refused(429, None), StepRefusal::Busy);
        assert_ne!(refused(429, None), refused(429, Some("step-limited")));
        // A wrong password at login/finish, or a code this build does not know: the words, and no retry here.
        assert_eq!(refused(401, None), StepRefusal::Other);
        assert_eq!(refused(409, Some("something-new")), StepRefusal::Other);
        // A wrong answer is never mistaken for an ended step, or the other way round: one asks
        // again on the same token, the other needs the password.
        assert_ne!(refused(401, Some("step-wrong")), refused(401, Some("step-expired")));
    }

    #[test]
    fn a_server_error_without_the_steps_code_is_lost_whatever_it_says() {
        // The server's own catch-all 503, a gateway's, a 500: none says whether the request did
        // anything. Read as "the server cannot check codes", it would take the code field away
        // from someone whose code was fine; read as a wrong answer, it would cost them a try.
        for (status, body) in [
            (503, r#"{"message":"Authentication is temporarily unavailable. Please try again."}"#),
            (500, r#"{"message":"Something broke."}"#),
            (502, r#"{"message":"Bad gateway","code":"upstream"}"#),
            (503, r#"{"message":"Try later.","code":null}"#),
        ] {
            assert_eq!(sign_in_reply_read(status, body.into()), StepReply::Lost, "{status} {body}");
            assert_eq!(step_change_reply_read(status, body.into()), StepReply::Lost, "{status} {body}");
            assert_eq!(step_challenge_reply_read(status, body.into()), StepReply::Lost, "{status} {body}");
        }
        // With the code it is the server's answer, at any of the routes.
        let said = r#"{"message":"Two-step sign-in is unavailable on this server right now. Use your recovery phrase, or try again later.","code":"step-unavailable"}"#;
        let routes: [fn(u16, String) -> StepReply; 3] =
            [sign_in_reply_read, step_change_reply_read, step_challenge_reply_read];
        for read in routes {
            assert!(matches!(
                read(503, said.into()),
                StepReply::Refused { refusal: StepRefusal::Unavailable, .. }
            ));
        }
    }

    #[test]
    fn unavailable_and_limited_are_told_apart_by_the_code_never_by_the_status() {
        // They withdraw different things: `unavailable` only the method that was tried, `limited`
        // the code methods together. Read by status, a `step-limited` behind a 503 would leave a
        // spent budget's field on screen, and a `step-unavailable` behind a 429 would take the
        // backup codes away with the app.
        let read = |status: u16, code: &str| {
            let body = json!({ "message": "The server’s words.", "code": code }).to_string();
            match sign_in_reply_read(status, body.clone()) {
                StepReply::Refused { refusal, .. } => {
                    // The same at a change, where the step rides on another request.
                    assert_eq!(
                        step_change_reply_read(status, body),
                        StepReply::Refused { refusal, message: "The server’s words.".into() }
                    );
                    refusal
                }
                other => panic!("expected a refusal, got {other:?}"),
            }
        };
        for status in [401, 403, 429, 503] {
            assert_eq!(read(status, "step-unavailable"), StepRefusal::Unavailable, "{status}");
            assert_eq!(read(status, "step-limited"), StepRefusal::Limited, "{status}");
        }
    }

    #[test]
    fn a_refusal_without_the_servers_words_is_lost() {
        for (status, body) in [
            (502, "<html>Bad gateway</html>"),
            (503, ""),
            (401, "{}"),
            (401, r#"{"code":"step-wrong"}"#),
            (401, r#"{"message":""}"#),
            (401, r#"{"message":7}"#),
            (429, "[]"),
            (302, r#"{"location":"/login"}"#),
        ] {
            assert_eq!(sign_in_reply_read(status, body.into()), StepReply::Lost, "{status} {body}");
        }
    }

    #[test]
    fn a_challenge_for_a_change_is_a_step_and_a_change_is_done_only_on_the_servers_object() {
        assert!(matches!(step_challenge_reply_read(200, step_body().to_string()), StepReply::Step { .. }));
        // The sign-in's wrapper is not the challenge route's reply.
        assert_eq!(
            step_challenge_reply_read(200, json!({ "twoStep": step_body() }).to_string()),
            StepReply::Lost
        );
        assert_eq!(
            step_challenge_reply_read(
                409,
                r#"{"message":"Two-step sign-in is off for this account."}"#.into()
            ),
            StepReply::Refused {
                refusal: StepRefusal::Other,
                message: "Two-step sign-in is off for this account.".into()
            }
        );
        assert_eq!(step_change_reply_read(200, r#"{"removed":true,"on":false}"#.into()), StepReply::Done);
        for body in ["", "ok", "[]", "null"] {
            assert_eq!(step_change_reply_read(200, body.into()), StepReply::Lost, "{body}");
        }
        assert_eq!(
            step_change_reply_read(
                403,
                r#"{"message":"Too many wrong answers. Start again.","code":"step-expired"}"#.into()
            ),
            StepReply::Refused {
                refusal: StepRefusal::Expired,
                message: "Too many wrong answers. Start again.".into()
            }
        );
    }

    #[test]
    fn an_answer_is_the_json_the_routes_take() {
        let read =
            |proof: StepProof| serde_json::from_str::<Value>(&step_answer_json(token('a'), proof)).unwrap();
        assert_eq!(
            read(StepProof::Totp { code: " 123 456\n".into() }),
            json!({ "token": token('a'), "proof": { "kind": "totp", "code": "123456" } })
        );
        // A backup code goes as typed, trimmed: the server reads its hyphen and case.
        assert_eq!(
            read(StepProof::Backup { code: " 7kq2m-9xd4p ".into() }),
            json!({ "token": token('a'), "proof": { "kind": "backup", "code": "7kq2m-9xd4p" } })
        );
        assert_eq!(
            read(StepProof::Phrase { signature: "sig".into() }),
            json!({ "token": token('a'), "proof": { "kind": "phrase", "signature": "sig" } })
        );
        // Whatever is typed stays inside its string.
        assert_eq!(
            read(StepProof::Backup { code: r#"","kind":"phrase"#.into() })["proof"]["kind"],
            json!("backup")
        );
    }

    #[test]
    fn a_backup_code_is_read_as_the_server_reads_it() {
        assert_eq!(backup_code_normalize("7kq2m 9xd4p".into()), Some("7KQ2M9XD4P".into()));
        assert_eq!(backup_code_normalize("7KQ2M-9XD4P".into()), Some("7KQ2M9XD4P".into()));
        assert_eq!(backup_code_normalize("OIL2M-9XD4P".into()), Some("0112M9XD4P".into()));
        // U is not in the alphabet, and nine or eleven characters are not a code.
        for typed in ["7KQ2M-9XD4U", "7KQ2M-9XD4", "7KQ2M-9XD4PP", "", "7KQ2M_9XD4P"] {
            assert_eq!(backup_code_normalize(typed.into()), None, "{typed}");
        }
    }
}
