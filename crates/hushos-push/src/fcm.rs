//! Firebase Cloud Messaging (HTTP v1), with an OAuth token made from HushOS's service account.
//!
//! The push is a high-priority data message with no `notification` block: Android shows nothing
//! by itself, and the app's messaging service fetches the event and posts the notification.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::push::{BoxFuture, Outcome, Push, Pusher};

const SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";

/// How long Google keeps trying a device that is off: a day.
const TTL: &str = "86400s";

#[derive(Deserialize)]
struct ServiceAccount {
    project_id: String,
    client_email: String,
    private_key: String,
    token_uri: String,
}

#[derive(Deserialize)]
struct Grant {
    access_token: String,
    expires_in: u64,
}

pub struct FcmPusher {
    client: reqwest::Client,
    client_email: String,
    token_uri: String,
    send_url: String,
    key: EncodingKey,
    cached: Mutex<Option<(String, Instant)>>,
}

impl FcmPusher {
    /// `service_account` is the JSON key Google Cloud gives for the service account.
    pub fn new(service_account: &[u8]) -> Result<FcmPusher, String> {
        let account: ServiceAccount = serde_json::from_slice(service_account)
            .map_err(|_| "FCM_SERVICE_ACCOUNT is not a service account key".to_owned())?;
        let key = EncodingKey::from_rsa_pem(account.private_key.as_bytes())
            .map_err(|_| "FCM_SERVICE_ACCOUNT's private_key is not an RSA key".to_owned())?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(FcmPusher {
            client,
            send_url: format!("https://fcm.googleapis.com/v1/projects/{}/messages:send", account.project_id),
            client_email: account.client_email,
            token_uri: account.token_uri,
            key,
            cached: Mutex::new(None),
        })
    }

    async fn access_token(&self) -> Option<String> {
        let mut cached = self.cached.lock().await;
        if let Some((token, until)) = cached.as_ref() {
            if Instant::now() < *until {
                return Some(token.clone());
            }
        }
        let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
        let claims = json!({
            "iss": self.client_email,
            "scope": SCOPE,
            "aud": self.token_uri,
            "iat": now,
            "exp": now + 3600,
        });
        let assertion = jsonwebtoken::encode(&Header::new(Algorithm::RS256), &claims, &self.key).ok()?;
        let body = format!("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion={assertion}");
        let response = self
            .client
            .post(&self.token_uri)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let grant: Grant = response.json().await.ok()?;
        // Five minutes' margin before Google's expiry.
        let until = Instant::now() + Duration::from_secs(grant.expires_in.saturating_sub(300));
        *cached = Some((grant.access_token.clone(), until));
        Some(grant.access_token)
    }
}

/// The whole message: the token, the event id and the tag as data, high priority.
pub fn message(token: &str, push: &Push) -> Value {
    json!({
        "message": {
            "token": token,
            "data": { "id": push.id, "tag": push.tag },
            "android": { "priority": "HIGH", "ttl": TTL },
        }
    })
}

/// What Google's answer means for the token. Only `UNREGISTERED` (sent with 404) says the token
/// is gone; `INVALID_ARGUMENT` and `SENDER_ID_MISMATCH` can be the relay's own mistake, and
/// must not delete every registration.
pub fn classify(status: u16, body: &[u8]) -> Outcome {
    if (200..300).contains(&status) {
        return Outcome::Delivered;
    }
    let body: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let unregistered = body["error"]["details"]
        .as_array()
        .is_some_and(|details| details.iter().any(|detail| detail["errorCode"] == "UNREGISTERED"));
    if unregistered || (status == 404 && body["error"]["status"] == "NOT_FOUND") {
        Outcome::Dead
    } else {
        Outcome::Failed
    }
}

impl Pusher for FcmPusher {
    fn send<'a>(&'a self, token: &'a str, push: &'a Push) -> BoxFuture<'a, Outcome> {
        Box::pin(async move {
            let Some(access) = self.access_token().await else { return Outcome::Failed };
            let response = self.client.post(&self.send_url).bearer_auth(access).json(&message(token, push)).send().await;
            let Ok(response) = response else { return Outcome::Failed };
            let status = response.status().as_u16();
            if status == 401 {
                *self.cached.lock().await = None;
            }
            let body = response.bytes().await.unwrap_or_default();
            classify(status, &body)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error(code: u16, status: &str, error_code: Option<&str>) -> Vec<u8> {
        let details: Vec<Value> = error_code
            .map(|code| json!({ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": code }))
            .into_iter()
            .collect();
        json!({ "error": { "code": code, "status": status, "details": details } }).to_string().into_bytes()
    }

    #[test]
    fn only_unregistered_makes_a_token_dead() {
        assert_eq!(classify(200, b"{\"name\":\"projects/p/messages/1\"}"), Outcome::Delivered);
        assert_eq!(classify(404, &error(404, "NOT_FOUND", Some("UNREGISTERED"))), Outcome::Dead);
        assert_eq!(classify(404, &error(404, "NOT_FOUND", None)), Outcome::Dead);
        for (status, name, code) in [
            (400, "INVALID_ARGUMENT", Some("INVALID_ARGUMENT")),
            (403, "PERMISSION_DENIED", Some("SENDER_ID_MISMATCH")),
            (401, "UNAUTHENTICATED", Some("THIRD_PARTY_AUTH_ERROR")),
            (429, "RESOURCE_EXHAUSTED", Some("QUOTA_EXCEEDED")),
            (500, "INTERNAL", Some("INTERNAL")),
            (503, "UNAVAILABLE", Some("UNAVAILABLE")),
        ] {
            assert_eq!(classify(status, &error(status, name, code)), Outcome::Failed, "{status} {name}");
        }
        assert_eq!(classify(502, b"<html>bad gateway</html>"), Outcome::Failed);
        assert_eq!(classify(404, b"<html>not found</html>"), Outcome::Failed);
    }

    #[test]
    fn the_message_is_data_only_at_high_priority() {
        let push = Push { id: "0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b".to_owned(), tag: "tag".to_owned() };
        assert_eq!(
            message("token", &push),
            json!({
                "message": {
                    "token": "token",
                    "data": { "id": "0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b", "tag": "tag" },
                    "android": { "priority": "HIGH", "ttl": "86400s" },
                }
            })
        );
    }
}
