//! Where registrations live: the `hushos_push` database, one table of handle → token.

use std::str::FromStr;

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;

use crate::push::{BoxFuture, Platform};

/// One registration as stored: the handle's and the deletion secret's hashes, the platform and
/// the token. Nothing else exists to store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Registration {
    pub handle_key: [u8; 32],
    pub platform: Platform,
    pub token: String,
    pub secret_hash: [u8; 32],
}

#[derive(Debug)]
pub struct StoreError(pub String);

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<sqlx::Error> for StoreError {
    fn from(error: sqlx::Error) -> Self {
        StoreError(error.to_string())
    }
}

pub trait Store: Send + Sync {
    fn insert<'a>(&'a self, registration: &'a Registration) -> BoxFuture<'a, Result<(), StoreError>>;

    fn token<'a>(
        &'a self,
        handle_key: &'a [u8; 32],
    ) -> BoxFuture<'a, Result<Option<(Platform, String)>, StoreError>>;

    /// Deletes the registration only when the secret's hash matches; says whether it did.
    fn delete<'a>(
        &'a self,
        handle_key: &'a [u8; 32],
        secret_hash: &'a [u8; 32],
    ) -> BoxFuture<'a, Result<bool, StoreError>>;

    /// Deletes every registration holding this token, which Apple or Google said is dead.
    fn delete_token<'a>(
        &'a self,
        platform: Platform,
        token: &'a str,
    ) -> BoxFuture<'a, Result<u64, StoreError>>;

    fn ready(&self) -> BoxFuture<'_, bool>;
}

pub struct PgStore {
    pool: PgPool,
}

impl PgStore {
    /// Connects and runs the migrations that ship in the binary.
    pub async fn connect(url: &str) -> Result<PgStore, StoreError> {
        PgStore::connect_with(PgConnectOptions::from_str(url)?).await
    }

    pub async fn connect_with(options: PgConnectOptions) -> Result<PgStore, StoreError> {
        let pool = PgPoolOptions::new().max_connections(8).connect_with(options).await?;
        sqlx::migrate!("./migrations").run(&pool).await.map_err(|error| StoreError(error.to_string()))?;
        Ok(PgStore { pool })
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
}

impl Store for PgStore {
    fn insert<'a>(&'a self, registration: &'a Registration) -> BoxFuture<'a, Result<(), StoreError>> {
        Box::pin(async move {
            sqlx::query(
                "insert into registrations (handle_key, platform, token, secret_hash) values ($1, $2, $3, $4)",
            )
            .bind(&registration.handle_key[..])
            .bind(registration.platform.as_str())
            .bind(&registration.token)
            .bind(&registration.secret_hash[..])
            .execute(&self.pool)
            .await?;
            Ok(())
        })
    }

    fn token<'a>(
        &'a self,
        handle_key: &'a [u8; 32],
    ) -> BoxFuture<'a, Result<Option<(Platform, String)>, StoreError>> {
        Box::pin(async move {
            let row: Option<(String, String)> =
                sqlx::query_as("select platform, token from registrations where handle_key = $1")
                    .bind(&handle_key[..])
                    .fetch_optional(&self.pool)
                    .await?;
            row.map(|(platform, token)| {
                Platform::parse(&platform)
                    .map(|platform| (platform, token))
                    .ok_or_else(|| StoreError(format!("unknown platform {platform:?}")))
            })
            .transpose()
        })
    }

    fn delete<'a>(
        &'a self,
        handle_key: &'a [u8; 32],
        secret_hash: &'a [u8; 32],
    ) -> BoxFuture<'a, Result<bool, StoreError>> {
        Box::pin(async move {
            let done = sqlx::query("delete from registrations where handle_key = $1 and secret_hash = $2")
                .bind(&handle_key[..])
                .bind(&secret_hash[..])
                .execute(&self.pool)
                .await?;
            Ok(done.rows_affected() == 1)
        })
    }

    fn delete_token<'a>(
        &'a self,
        platform: Platform,
        token: &'a str,
    ) -> BoxFuture<'a, Result<u64, StoreError>> {
        Box::pin(async move {
            let done = sqlx::query("delete from registrations where platform = $1 and token = $2")
                .bind(platform.as_str())
                .bind(token)
                .execute(&self.pool)
                .await?;
            Ok(done.rows_affected())
        })
    }

    fn ready(&self) -> BoxFuture<'_, bool> {
        Box::pin(async move { sqlx::query("select 1").execute(&self.pool).await.is_ok() })
    }
}

#[cfg(test)]
pub mod memory {
    use std::sync::Mutex;

    use subtle::ConstantTimeEq;

    use super::*;

    /// The same contract in memory, for the handler tests.
    #[derive(Default)]
    pub struct MemoryStore {
        pub rows: Mutex<Vec<Registration>>,
    }

    impl Store for MemoryStore {
        fn insert<'a>(&'a self, registration: &'a Registration) -> BoxFuture<'a, Result<(), StoreError>> {
            self.rows.lock().unwrap().push(registration.clone());
            Box::pin(async { Ok(()) })
        }

        fn token<'a>(
            &'a self,
            handle_key: &'a [u8; 32],
        ) -> BoxFuture<'a, Result<Option<(Platform, String)>, StoreError>> {
            let rows = self.rows.lock().unwrap();
            let found = rows
                .iter()
                .find(|row| &row.handle_key == handle_key)
                .map(|row| (row.platform, row.token.clone()));
            Box::pin(async move { Ok(found) })
        }

        fn delete<'a>(
            &'a self,
            handle_key: &'a [u8; 32],
            secret_hash: &'a [u8; 32],
        ) -> BoxFuture<'a, Result<bool, StoreError>> {
            let mut rows = self.rows.lock().unwrap();
            let before = rows.len();
            rows.retain(|row| {
                !(&row.handle_key == handle_key && bool::from(row.secret_hash.ct_eq(secret_hash)))
            });
            let deleted = rows.len() < before;
            Box::pin(async move { Ok(deleted) })
        }

        fn delete_token<'a>(
            &'a self,
            platform: Platform,
            token: &'a str,
        ) -> BoxFuture<'a, Result<u64, StoreError>> {
            let mut rows = self.rows.lock().unwrap();
            let before = rows.len();
            rows.retain(|row| !(row.platform == platform && row.token == token));
            let deleted = (before - rows.len()) as u64;
            Box::pin(async move { Ok(deleted) })
        }

        fn ready(&self) -> BoxFuture<'_, bool> {
            Box::pin(async { true })
        }
    }
}

/// The contract every store keeps, run against the memory store and against Postgres.
#[cfg(test)]
pub async fn check_contract(store: &dyn Store) {
    let row = |n: u8, platform: Platform, token: &str| Registration {
        handle_key: [n; 32],
        platform,
        token: token.to_owned(),
        secret_hash: [n ^ 0xff; 32],
    };
    let shared = "a".repeat(64);
    store.insert(&row(1, Platform::Apns, &shared)).await.unwrap();
    store.insert(&row(2, Platform::Apns, &shared)).await.unwrap();
    store.insert(&row(3, Platform::ApnsSandbox, &shared)).await.unwrap();
    store.insert(&row(4, Platform::Fcm, "fcm-token-of-at-least-thirty-two-characters")).await.unwrap();

    assert_eq!(store.token(&[1; 32]).await.unwrap(), Some((Platform::Apns, shared.clone())));
    assert_eq!(store.token(&[9; 32]).await.unwrap(), None);

    // Another handle's secret, or the handle's own key, deletes nothing.
    assert!(!store.delete(&[4; 32], &[2 ^ 0xff; 32]).await.unwrap());
    assert!(!store.delete(&[4; 32], &[4; 32]).await.unwrap());
    assert!(store.token(&[4; 32]).await.unwrap().is_some());
    assert!(store.delete(&[4; 32], &[4 ^ 0xff; 32]).await.unwrap());
    assert_eq!(store.token(&[4; 32]).await.unwrap(), None);
    assert!(!store.delete(&[4; 32], &[4 ^ 0xff; 32]).await.unwrap());

    // A dead token takes every handle that uses it, on that platform only.
    assert_eq!(store.delete_token(Platform::Apns, &shared).await.unwrap(), 2);
    assert_eq!(store.token(&[1; 32]).await.unwrap(), None);
    assert_eq!(store.token(&[2; 32]).await.unwrap(), None);
    assert_eq!(store.token(&[3; 32]).await.unwrap(), Some((Platform::ApnsSandbox, shared.clone())));
    assert!(store.ready().await);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn memory_store_keeps_the_contract() {
        check_contract(&memory::MemoryStore::default()).await;
    }
}
