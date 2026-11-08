//! What a push is, and the trait Apple's and Google's senders sit behind.

use std::future::Future;
use std::pin::Pin;

use serde::Deserialize;

/// The only text the relay ever asks a phone to show. The apps replace it with what they write
/// from the fetched event, and put it back on any failure.
pub const FALLBACK_TEXT: &str = "New activity in HushOS";

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Which budget a ping spends: `security` for approval requests and security notices, `other`
/// for the rest.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Class {
    Security,
    Other,
}

/// Where a token came from. `apns-sandbox` tokens come from development builds (Xcode), which
/// Apple serves from its sandbox host.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Platform {
    Apns,
    ApnsSandbox,
    Fcm,
}

impl Platform {
    pub fn as_str(self) -> &'static str {
        match self {
            Platform::Apns => "apns",
            Platform::ApnsSandbox => "apns-sandbox",
            Platform::Fcm => "fcm",
        }
    }

    pub fn parse(text: &str) -> Option<Platform> {
        match text {
            "apns" => Some(Platform::Apns),
            "apns-sandbox" => Some(Platform::ApnsSandbox),
            "fcm" => Some(Platform::Fcm),
            _ => None,
        }
    }

    /// The token as stored, or nothing when it cannot be one of this platform's. APNs tokens are
    /// hex (lowercased here); FCM tokens are URL-safe text.
    pub fn normalize_token(self, token: &str) -> Option<String> {
        match self {
            Platform::Apns | Platform::ApnsSandbox => {
                let ok = (64..=200).contains(&token.len())
                    && token.len().is_multiple_of(2)
                    && token.bytes().all(|b| b.is_ascii_hexdigit());
                ok.then(|| token.to_ascii_lowercase())
            }
            Platform::Fcm => {
                // FCM tokens are about 160 characters; 512 leaves room without letting a fake
                // registration store kilobytes (or pass Postgres's index entry limit).
                let ok = (32..=512).contains(&token.len())
                    && token.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_:.".contains(&b));
                ok.then(|| token.to_owned())
            }
        }
    }
}

/// Everything a push carries: the event id and the handle's tag.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Push {
    pub id: String,
    pub tag: String,
}

/// What Apple or Google said.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Delivered,
    /// The token will never work again: the app was removed, or the token was replaced.
    Dead,
    /// Anything else, ours or theirs. The registration stays.
    Failed,
}

pub trait Pusher: Send + Sync {
    fn send<'a>(&'a self, token: &'a str, push: &'a Push) -> BoxFuture<'a, Outcome>;
}

#[cfg(test)]
pub mod fake {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    /// Records every push, and answers with the outcome set for its token (delivered otherwise).
    #[derive(Default)]
    pub struct FakePusher {
        pub sent: Mutex<Vec<(String, Push)>>,
        pub outcomes: Mutex<HashMap<String, Outcome>>,
    }

    impl FakePusher {
        pub fn answer(&self, token: &str, outcome: Outcome) {
            self.outcomes.lock().unwrap().insert(token.to_owned(), outcome);
        }

        pub fn sent(&self) -> Vec<(String, Push)> {
            self.sent.lock().unwrap().clone()
        }
    }

    impl Pusher for FakePusher {
        fn send<'a>(&'a self, token: &'a str, push: &'a Push) -> BoxFuture<'a, Outcome> {
            self.sent.lock().unwrap().push((token.to_owned(), push.clone()));
            let outcome = self.outcomes.lock().unwrap().get(token).copied().unwrap_or(Outcome::Delivered);
            Box::pin(async move { outcome })
        }
    }
}
