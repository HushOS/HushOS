//! Apple Push Notification service, over HTTP/2 with a token (JWT) signed by HushOS's `.p8` key.
//!
//! The push is an alert with `mutable-content`, so the app's Notification Service Extension
//! runs and replaces the fixed text with what it writes from the fetched event.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::push::{BoxFuture, Outcome, Push, Pusher, FALLBACK_TEXT};

pub const PRODUCTION_HOST: &str = "https://api.push.apple.com";
pub const SANDBOX_HOST: &str = "https://api.sandbox.push.apple.com";

/// Apple refuses a provider token older than an hour, and one replaced more often than every 20
/// minutes.
const TOKEN_LIFETIME: Duration = Duration::from_secs(40 * 60);
/// A provider token is replaced after a refusal only once it is this old.
const MIN_TOKEN_AGE: Duration = Duration::from_secs(60);

/// How long Apple keeps trying a device that is off: a day.
const EXPIRY: Duration = Duration::from_secs(24 * 60 * 60);

/// The signing key and the provider token made from it, shared by the production and sandbox
/// senders.
pub struct ApnsAuth {
    key: EncodingKey,
    key_id: String,
    team_id: String,
    cached: Mutex<Option<(String, Instant)>>,
}

impl ApnsAuth {
    /// `p8` is the key file Apple's developer site gives (a PKCS #8 P-256 key in PEM).
    pub fn new(p8: &[u8], key_id: String, team_id: String) -> Result<ApnsAuth, String> {
        let key = EncodingKey::from_ec_pem(p8).map_err(|_| "APNS_KEY is not a .p8 key".to_owned())?;
        Ok(ApnsAuth { key, key_id, team_id, cached: Mutex::new(None) })
    }

    fn bearer(&self) -> Option<String> {
        let mut cached = self.cached.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((token, made)) = cached.as_ref() {
            if made.elapsed() < TOKEN_LIFETIME {
                return Some(token.clone());
            }
        }
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(self.key_id.clone());
        let claims = json!({ "iss": self.team_id, "iat": unix_now() });
        let token = jsonwebtoken::encode(&header, &claims, &self.key).ok()?;
        *cached = Some((token.clone(), Instant::now()));
        Some(token)
    }

    /// Drops a refused provider token, unless it is less than a minute old: with many pushes in
    /// flight, every 403 making a new token would answer Apple with TooManyProviderTokenUpdates.
    fn forget(&self) {
        let mut cached = self.cached.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if cached.as_ref().is_some_and(|(_, made)| made.elapsed() >= MIN_TOKEN_AGE) {
            *cached = None;
        }
    }
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs()).unwrap_or(0)
}

pub struct ApnsPusher {
    client: reqwest::Client,
    host: &'static str,
    topic: String,
    auth: Arc<ApnsAuth>,
}

impl ApnsPusher {
    pub fn new(host: &'static str, topic: String, auth: Arc<ApnsAuth>) -> Result<ApnsPusher, String> {
        let client = reqwest::Client::builder()
            .http2_prior_knowledge()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(ApnsPusher { client, host, topic, auth })
    }
}

/// The whole payload: the fixed text, `mutable-content`, the event id and the tag. No sound, no
/// title, no badge; the extension decides how the notification it writes is shown.
pub fn payload(push: &Push) -> Value {
    json!({
        "aps": { "alert": { "body": FALLBACK_TEXT }, "mutable-content": 1 },
        "id": push.id,
        "tag": push.tag,
    })
}

#[derive(Deserialize)]
struct Refusal {
    reason: String,
}

/// What Apple's answer means for the token. Only an answer about the token itself makes it
/// dead: one about the relay's own key or topic must not delete every registration.
pub fn classify(status: u16, body: &[u8]) -> Outcome {
    let reason = serde_json::from_slice::<Refusal>(body).map(|refusal| refusal.reason).unwrap_or_default();
    match (status, reason.as_str()) {
        (200, _) => Outcome::Delivered,
        (410, _) => Outcome::Dead,
        // Not `DeviceTokenNotForTopic`: with a wrong APNS_TOPIC every token answers it, and
        // treating it as dead would delete every iOS registration on the first ping each.
        (400, "BadDeviceToken") => Outcome::Dead,
        _ => Outcome::Failed,
    }
}

impl Pusher for ApnsPusher {
    fn send<'a>(&'a self, token: &'a str, push: &'a Push) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let Some(bearer) = self.auth.bearer() else { return Outcome::Failed };
            let response = self
                .client
                .post(format!("{}/3/device/{token}", self.host))
                .header("authorization", format!("bearer {bearer}"))
                .header("apns-topic", &self.topic)
                .header("apns-push-type", "alert")
                .header("apns-priority", "10")
                .header("apns-expiration", (unix_now() + EXPIRY.as_secs()).to_string())
                .json(&payload(push))
                .send()
                .await;
            let Ok(response) = response else { return Outcome::Failed };
            let status = response.status().as_u16();
            let body = response.bytes().await.unwrap_or_default();
            if status == 403 {
                // An expired or refused provider token: make a new one for the next push.
                self.auth.forget();
            }
            classify(status, &body)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refusal(reason: &str) -> Vec<u8> {
        json!({ "reason": reason }).to_string().into_bytes()
    }

    #[test]
    fn only_answers_about_the_token_make_it_dead() {
        assert_eq!(classify(200, b""), Outcome::Delivered);
        assert_eq!(classify(410, &refusal("Unregistered")), Outcome::Dead);
        assert_eq!(classify(410, &refusal("ExpiredToken")), Outcome::Dead);
        assert_eq!(classify(400, &refusal("BadDeviceToken")), Outcome::Dead);
        // The relay's own mistakes, and Apple's: the registrations stay. A wrong APNS_TOPIC makes
        // every token answer DeviceTokenNotForTopic.
        for (status, reason) in [
            (400, "DeviceTokenNotForTopic"),
            (400, "BadTopic"),
            (400, "TopicDisallowed"),
            (400, "MissingTopic"),
            (400, "PayloadEmpty"),
            (403, "InvalidProviderToken"),
            (403, "ExpiredProviderToken"),
            (429, "TooManyRequests"),
            (429, "TooManyProviderTokenUpdates"),
            (500, "InternalServerError"),
            (503, "ServiceUnavailable"),
        ] {
            assert_eq!(classify(status, &refusal(reason)), Outcome::Failed, "{status} {reason}");
        }
        assert_eq!(classify(400, b"not json"), Outcome::Failed);
    }

    #[test]
    fn the_payload_is_the_fixed_text_the_id_and_the_tag() {
        let push = Push { id: "0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b".to_owned(), tag: "tag".to_owned() };
        assert_eq!(
            payload(&push),
            json!({
                "aps": { "alert": { "body": "New activity in HushOS" }, "mutable-content": 1 },
                "id": "0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
                "tag": "tag",
            })
        );
    }
}
