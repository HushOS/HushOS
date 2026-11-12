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

/// One way to answer a step. A method this build does not know (a security key, later) is
/// one it cannot answer, and is left out of a challenge's list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum StepMethod {
    /// A code from the authenticator app.
    Totp,
    /// One of the ten backup codes.
    Backup,
    /// The recovery phrase, signed on the device.
    Phrase,
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
    pub methods: Vec<StepMethod>,
    /// ISO 8601, as the server sent it.
    pub expires_at: String,
    pub phrase: Option<StepPhrase>,
}

/// An answer to a step, as a person gave it. The phrase's is its signature
/// (`two_step_phrase_sign`), never the words.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum StepProof {
    Totp { code: String },
    Backup { code: String },
    Phrase { signature: String },
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
    /// `step-limited`: too many wrong codes for now. The phrase, or waiting.
    Limited,
    /// `two-step`: the action needs the step and came without it. A challenge, then the step.
    Required,
    /// `setup-required`: the account has no recovery key yet.
    SetupRequired,
    /// `update-required`: this build cannot answer what the account asks for.
    UpdateRequired,
    /// `step-unavailable`: the server cannot check this method right now, and nothing
    /// changed. The phrase, or later.
    Unavailable,
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
    let names = |name: &str| listed.iter().any(|method| method.as_str() == Some(name));
    let mut methods = Vec::new();
    if names("totp") {
        methods.push(StepMethod::Totp);
    }
    if names("backup") {
        methods.push(StepMethod::Backup);
    }
    // Without what the phrase signs with, the phrase cannot answer, whatever the list says.
    if names("phrase") && phrase.is_some() {
        methods.push(StepMethod::Phrase);
    }
    Some(StepChallenge { token: token.to_string(), methods, expires_at: expires_at.to_string(), phrase })
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
/// let step = format!(r#"{{"twoStep":{{"token":"{token}","methods":["totp","backup","webauthn"],"expiresAt":"2026-11-13T10:00:00.000Z"}}}}"#);
/// let StepReply::Step { challenge } = sign_in_reply_read(200, step) else { panic!("a step") };
/// // A security key is not something this build can answer with; the phrase has nothing to sign with.
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
    };
    format!(r#"{{"token":{},"proof":{proof}}}"#, json!(token))
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
        // A security key (later) is skipped, in whatever order the server lists things.
        let mut later = step_body();
        later["methods"] = json!(["webauthn", "phrase", "totp"]);
        assert_eq!(read(later).methods, vec![StepMethod::Totp, StepMethod::Phrase]);
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
        keys_only["methods"] = json!(["webauthn"]);
        assert!(read(keys_only).methods.is_empty());
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
