use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::Duration;

use axum::body::Body;
use axum::http::{HeaderMap, Method, Request};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

use super::*;
use crate::push::fake::FakePusher;
use crate::store::memory::MemoryStore;

const EVENT: &str = "0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
const SERVER: &str = "198.51.100.4";

#[derive(Default)]
struct ManualClock(Mutex<Duration>);

impl ManualClock {
    fn advance(&self, by: Duration) {
        *self.0.lock().unwrap() += by;
    }
}

impl Clock for ManualClock {
    fn now(&self) -> Duration {
        *self.0.lock().unwrap()
    }
}

struct Answer {
    status: StatusCode,
    headers: HeaderMap,
    body: Bytes,
}

impl Answer {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

struct Harness {
    router: Router,
    deliverer: Arc<Deliverer>,
    jobs: mpsc::Receiver<Job>,
    apns: Arc<FakePusher>,
    fcm: Arc<FakePusher>,
    clock: Arc<ManualClock>,
}

impl Harness {
    fn new(settings: Settings) -> Harness {
        Harness::with_store(Arc::new(MemoryStore::default()), settings)
    }

    fn with_store(store: Arc<dyn Store>, settings: Settings) -> Harness {
        let (apns, fcm) = (Arc::new(FakePusher::default()), Arc::new(FakePusher::default()));
        let pushers = Pushers { apns: Some(apns.clone()), apns_sandbox: None, fcm: Some(fcm.clone()) };
        let clock = Arc::new(ManualClock::default());
        let (relay, deliverer, jobs) = relay(store, pushers, clock.clone(), settings, MAX_LIMIT_ENTRIES);
        Harness { router: router(relay), deliverer, jobs, apns, fcm, clock }
    }

    async fn call(
        &self,
        method: Method,
        uri: &str,
        body: Value,
        from: &str,
        headers: &[(&str, &str)],
    ) -> Answer {
        let mut request =
            Request::builder().method(method).uri(uri).header("content-type", "application/json");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let mut request = request.body(Body::from(body.to_string())).unwrap();
        let socket: SocketAddr = format!("{from}:40000").parse().unwrap();
        request.extensions_mut().insert(ConnectInfo(socket));
        let response = self.router.clone().oneshot(request).await.unwrap();
        let (parts, body) = response.into_parts();
        Answer {
            status: parts.status,
            headers: parts.headers,
            body: body.collect().await.unwrap().to_bytes(),
        }
    }

    async fn register(&self, platform: &str, token: &str) -> (String, String) {
        let answer = self.register_from(platform, token, "192.0.2.10").await;
        assert_eq!(answer.status, StatusCode::OK);
        let json = answer.json();
        (json["handle"].as_str().unwrap().to_owned(), json["deleteSecret"].as_str().unwrap().to_owned())
    }

    async fn register_from(&self, platform: &str, token: &str, from: &str) -> Answer {
        self.call(Method::POST, "/v1/register", json!({ "platform": platform, "token": token }), from, &[])
            .await
    }

    async fn ping_from(&self, handle: &str, class: &str, from: &str, headers: &[(&str, &str)]) -> Answer {
        self.call(
            Method::POST,
            "/v1/ping",
            json!({ "handle": handle, "id": EVENT, "class": class }),
            from,
            headers,
        )
        .await
    }

    async fn ping(&self, handle: &str, class: &str) -> StatusCode {
        self.ping_from(handle, class, SERVER, &[]).await.status
    }

    async fn unregister(&self, handle: &str, secret: &str) -> Answer {
        self.call(
            Method::DELETE,
            &format!("/v1/register/{handle}"),
            json!({ "deleteSecret": secret }),
            SERVER,
            &[],
        )
        .await
    }

    /// Delivers every queued ping, as the background loop would.
    async fn drain(&mut self) {
        while let Ok(job) = self.jobs.try_recv() {
            deliver(&self.deliverer, job).await;
        }
    }
}

fn apns_token(n: u8) -> String {
    format!("{n:02x}").repeat(32)
}

fn fcm_token(n: u8) -> String {
    format!("fcm-{n}:APA91b{}", "x".repeat(40))
}

/// Every header but the date, which moves with the clock.
fn without_date(headers: &HeaderMap) -> Vec<(String, Vec<u8>)> {
    let mut list: Vec<_> = headers
        .iter()
        .filter(|(name, _)| *name != "date")
        .map(|(name, value)| (name.to_string(), value.as_bytes().to_vec()))
        .collect();
    list.sort();
    list
}

#[tokio::test]
async fn registering_returns_a_fresh_32_byte_handle_and_secret_and_a_ping_reaches_the_token() {
    let mut harness = Harness::new(Settings::default());
    let (handle, secret) = harness.register("apns", &apns_token(1).to_uppercase()).await;
    let (other, _) = harness.register("fcm", &fcm_token(2)).await;
    let raw = handle::decode32(&handle).expect("a 32-byte handle");
    assert!(handle::decode32(&secret).is_some());
    assert_ne!(handle, secret);
    assert_ne!(handle, other);

    assert_eq!(harness.ping(&handle, "security").await, StatusCode::ACCEPTED);
    harness.drain().await;
    let push = Push { id: EVENT.to_owned(), tag: handle::tag(&raw) };
    assert_eq!(harness.apns.sent(), vec![(apns_token(1), push)]);
    assert!(harness.fcm.sent().is_empty());
}

#[tokio::test]
async fn a_ping_for_an_unknown_handle_reveals_nothing() {
    let mut harness = Harness::new(Settings::default());
    let (known, _) = harness.register("apns", &apns_token(1)).await;
    let unknown = handle::encode(&handle::random32());

    let a = harness.ping_from(&known, "security", SERVER, &[]).await;
    let b = harness.ping_from(&unknown, "security", SERVER, &[]).await;
    assert_eq!((a.status, without_date(&a.headers), &a.body), (b.status, without_date(&b.headers), &b.body));
    harness.drain().await;
    assert_eq!(harness.apns.sent().len(), 1, "only the known handle is pushed");

    // A spent budget answers alike too: a 429 is no sign that the handle exists.
    for _ in 0..19 {
        harness.ping(&known, "security").await;
        harness.ping(&unknown, "security").await;
    }
    let a = harness.ping_from(&known, "security", SERVER, &[]).await;
    let b = harness.ping_from(&unknown, "security", SERVER, &[]).await;
    assert_eq!(a.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!((a.status, without_date(&a.headers), &a.body), (b.status, without_date(&b.headers), &b.body));
}

#[tokio::test]
async fn per_handle_budgets_hold_and_other_cannot_spend_security() {
    let mut harness = Harness::new(Settings::default());
    let (handle, _) = harness.register("fcm", &fcm_token(1)).await;
    let mut other = 0;
    for _ in 0..100 {
        if harness.ping(&handle, "other").await == StatusCode::ACCEPTED {
            other += 1;
        }
    }
    assert_eq!(other, 60);
    let mut security = 0;
    for _ in 0..30 {
        if harness.ping(&handle, "security").await == StatusCode::ACCEPTED {
            security += 1;
        }
    }
    assert_eq!(security, 20);
    harness.drain().await;
    assert_eq!(harness.fcm.sent().len(), 80);

    // Three minutes earn one security ping back.
    harness.clock.advance(Duration::from_secs(180));
    assert_eq!(harness.ping(&handle, "security").await, StatusCode::ACCEPTED);
    assert_eq!(harness.ping(&handle, "security").await, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn a_sending_address_has_its_own_budget_across_handles() {
    let settings = Settings { address_security: Budget(3), ..Settings::default() };
    let harness = Harness::new(settings);
    let mut handles = Vec::new();
    for n in 0..4 {
        handles.push(harness.register("apns", &apns_token(n)).await.0);
    }
    for handle in &handles[..3] {
        assert_eq!(harness.ping(handle, "security").await, StatusCode::ACCEPTED);
    }
    assert_eq!(harness.ping(&handles[3], "security").await, StatusCode::TOO_MANY_REQUESTS);
    // Another server is not held back.
    let elsewhere = harness.ping_from(&handles[3], "security", "198.51.100.99", &[]).await;
    assert_eq!(elsewhere.status, StatusCode::ACCEPTED);
}

#[tokio::test]
async fn a_trusted_sender_skips_the_address_budget_but_not_the_handle_budget() {
    let settings = Settings {
        address_security: Budget(3),
        trusted_senders: vec![SERVER.parse().unwrap()],
        ..Settings::default()
    };
    let harness = Harness::new(settings);
    let mut handles = Vec::new();
    for n in 0..5 {
        handles.push(harness.register("apns", &apns_token(n)).await.0);
    }
    for handle in &handles {
        assert_eq!(harness.ping(handle, "security").await, StatusCode::ACCEPTED);
    }
    for _ in 0..19 {
        assert_eq!(harness.ping(&handles[0], "security").await, StatusCode::ACCEPTED);
    }
    assert_eq!(harness.ping(&handles[0], "security").await, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn the_address_comes_from_the_last_value_of_the_trusted_proxy_header() {
    let settings = Settings {
        address_security: Budget(1),
        trusted_proxy_header: Some(HeaderName::from_static("x-forwarded-for")),
        ..Settings::default()
    };
    let harness = Harness::new(settings);
    let a = harness.register("apns", &apns_token(1)).await.0;
    let b = harness.register("apns", &apns_token(2)).await.0;
    let proxy = "10.0.0.2";
    // Two servers behind the same proxy have a budget each.
    let first = harness.ping_from(&a, "security", proxy, &[("x-forwarded-for", "203.0.113.1")]).await;
    let second = harness.ping_from(&b, "security", proxy, &[("x-forwarded-for", "203.0.113.2")]).await;
    assert_eq!((first.status, second.status), (StatusCode::ACCEPTED, StatusCode::ACCEPTED));
    // A server cannot pick a fresh address by writing its own first value.
    let spoofed =
        harness.ping_from(&b, "security", proxy, &[("x-forwarded-for", "192.0.2.77, 203.0.113.1")]).await;
    assert_eq!(spoofed.status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn registrations_are_limited_per_address() {
    let harness = Harness::new(Settings::default());
    for n in 0..30 {
        assert_eq!(harness.register_from("apns", &apns_token(n), "192.0.2.50").await.status, StatusCode::OK);
    }
    assert_eq!(
        harness.register_from("apns", &apns_token(31), "192.0.2.50").await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(harness.register_from("apns", &apns_token(31), "192.0.2.51").await.status, StatusCode::OK);
}

#[tokio::test]
async fn a_dead_token_is_dropped_with_every_handle_on_it_and_a_failure_drops_nothing() {
    let mut harness = Harness::new(Settings::default());
    // One phone signed in to two servers, and another phone.
    let (first, _) = harness.register("apns", &apns_token(1)).await;
    let (second, _) = harness.register("apns", &apns_token(1)).await;
    let (third, _) = harness.register("apns", &apns_token(3)).await;
    let (flaky, _) = harness.register("fcm", &fcm_token(4)).await;
    harness.apns.answer(&apns_token(1), Outcome::Dead);
    harness.fcm.answer(&fcm_token(4), Outcome::Failed);

    harness.ping(&first, "other").await;
    harness.ping(&flaky, "other").await;
    harness.drain().await;
    assert_eq!(harness.apns.sent().len(), 1);

    harness.ping(&first, "other").await;
    harness.ping(&second, "other").await;
    harness.ping(&third, "other").await;
    harness.ping(&flaky, "other").await;
    harness.drain().await;
    let apns: Vec<String> = harness.apns.sent().into_iter().map(|(token, _)| token).collect();
    assert_eq!(apns, vec![apns_token(1), apns_token(3)], "both handles on the dead token are gone");
    assert_eq!(harness.fcm.sent().len(), 2, "a failed push keeps its registration");
}

#[tokio::test]
async fn deleting_needs_the_handles_own_secret() {
    let mut harness = Harness::new(Settings::default());
    let (handle, secret) = harness.register("apns", &apns_token(1)).await;
    let (_, other_secret) = harness.register("apns", &apns_token(2)).await;

    let wrong = harness.unregister(&handle, &other_secret).await;
    assert_eq!(wrong.status, StatusCode::NOT_FOUND);
    let unknown = harness.unregister(&handle::encode(&handle::random32()), &secret).await;
    assert_eq!(
        (wrong.status, without_date(&wrong.headers), &wrong.body),
        (unknown.status, without_date(&unknown.headers), &unknown.body)
    );
    // The handle itself is not its secret.
    assert_eq!(harness.unregister(&handle, &handle).await.status, StatusCode::NOT_FOUND);

    harness.ping(&handle, "other").await;
    harness.drain().await;
    assert_eq!(harness.apns.sent().len(), 1, "a refused deletion leaves the device registered");

    assert_eq!(harness.unregister(&handle, &secret).await.status, StatusCode::NO_CONTENT);
    harness.ping(&handle, "other").await;
    harness.drain().await;
    assert_eq!(harness.apns.sent().len(), 1, "a deleted handle is pushed no more");
    assert_eq!(harness.unregister(&handle, &secret).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_ping_carries_only_a_lowercase_uuid() {
    let mut harness = Harness::new(Settings::default());
    let (handle, _) = harness.register("apns", &apns_token(1)).await;
    let bodies = [
        json!({ "handle": handle, "id": "Maya shared Taxes 2025.pdf", "class": "other" }),
        json!({ "handle": handle, "id": EVENT.to_uppercase(), "class": "other" }),
        json!({ "handle": handle, "id": EVENT, "class": "urgent" }),
        json!({ "handle": &handle[..42], "id": EVENT, "class": "other" }),
        json!({ "handle": handle, "class": "other" }),
    ];
    for body in bodies {
        let answer = harness.call(Method::POST, "/v1/ping", body.clone(), SERVER, &[]).await;
        assert_eq!(answer.status, StatusCode::BAD_REQUEST, "{body}");
    }
    harness.drain().await;
    assert!(harness.apns.sent().is_empty());
}

#[tokio::test]
async fn tokens_must_look_like_their_platforms() {
    let harness = Harness::new(Settings::default());
    for (platform, token) in [
        ("apns", "not hex at all, and long enough to pass a length check on its own!!!!!!!!!"),
        ("apns", "abcd"),
        ("fcm", "short"),
        ("fcm", "has spaces and is long enough to be a token otherwise"),
        ("webpush", "anything"),
    ] {
        assert_eq!(
            harness.register_from(platform, token, "192.0.2.60").await.status,
            StatusCode::BAD_REQUEST
        );
    }
    // Sandbox tokens are refused while the relay has no sandbox sender.
    let answer = harness.register_from("apns-sandbox", &apns_token(1), "192.0.2.60").await;
    assert_eq!(answer.status, StatusCode::SERVICE_UNAVAILABLE);
}

/// Postgres, in a schema of its own, when `PUSH_TEST_DATABASE_URL` names a database. CI sets it,
/// and a run there without it fails rather than skip.
mod postgres {
    use std::str::FromStr;

    use sqlx::postgres::PgConnectOptions;
    use sqlx::PgPool;

    use super::*;
    use crate::store::{check_contract, PgStore};

    struct Schema {
        admin: PgPool,
        name: String,
    }

    impl Schema {
        async fn drop(self) {
            let _ = sqlx::query(&format!("drop schema {} cascade", self.name)).execute(&self.admin).await;
        }
    }

    async fn fresh() -> Option<(Arc<PgStore>, Schema)> {
        let Ok(url) = std::env::var("PUSH_TEST_DATABASE_URL") else {
            assert!(std::env::var_os("CI").is_none(), "PUSH_TEST_DATABASE_URL must be set in CI");
            eprintln!("PUSH_TEST_DATABASE_URL is not set: skipping the Postgres tests");
            return None;
        };
        let admin = PgPool::connect(&url).await.unwrap();
        let name = format!(
            "push_test_{}",
            handle::encode(&handle::random32())[..12].to_ascii_lowercase().replace(['-', '_'], "x")
        );
        sqlx::query(&format!("create schema {name}")).execute(&admin).await.unwrap();
        let options = PgConnectOptions::from_str(&url).unwrap().options([("search_path", name.as_str())]);
        let store = PgStore::connect_with(options).await.unwrap();
        Some((Arc::new(store), Schema { admin, name }))
    }

    #[tokio::test]
    async fn postgres_keeps_the_store_contract() {
        let Some((store, schema)) = fresh().await else { return };
        check_contract(store.as_ref()).await;
        schema.drop().await;
    }

    #[tokio::test]
    async fn the_database_holds_only_hashed_handles_and_tokens() {
        let Some((store, schema)) = fresh().await else { return };
        let mut harness = Harness::with_store(store.clone(), Settings::default());
        let answer = harness.register_from("fcm", &fcm_token(7), "203.0.113.77").await;
        let json = answer.json();
        let handle = json["handle"].as_str().unwrap().to_owned();
        let secret = json["deleteSecret"].as_str().unwrap().to_owned();
        assert_eq!(
            harness.ping_from(&handle, "security", "203.0.113.78", &[]).await.status,
            StatusCode::ACCEPTED
        );
        harness.drain().await;
        assert_eq!(harness.fcm.sent().len(), 1);

        let tables: Vec<(String,)> = sqlx::query_as(
            "select table_name::text from information_schema.tables where table_schema = $1 order by 1",
        )
        .bind(&schema.name)
        .fetch_all(store.pool())
        .await
        .unwrap();
        let tables: Vec<String> = tables.into_iter().map(|(name,)| name).collect();
        assert_eq!(tables, vec!["_sqlx_migrations".to_owned(), "registrations".to_owned()]);
        let columns: Vec<(String,)> = sqlx::query_as(
            "select column_name::text from information_schema.columns where table_schema = $1 and table_name = 'registrations' order by 1",
        )
        .bind(&schema.name)
        .fetch_all(store.pool())
        .await
        .unwrap();
        let columns: Vec<String> = columns.into_iter().map(|(name,)| name).collect();
        assert_eq!(columns, vec!["handle_key", "platform", "secret_hash", "token"]);

        let rows: Vec<(String, Vec<u8>, Vec<u8>)> =
            sqlx::query_as("select row_to_json(r)::text, handle_key, secret_hash from registrations r")
                .fetch_all(store.pool())
                .await
                .unwrap();
        assert_eq!(rows.len(), 1);
        let (text, handle_key, secret_hash) = &rows[0];
        assert!(text.contains(&fcm_token(7)));
        for leak in ["203.0.113", &handle, &secret, EVENT] {
            assert!(!text.contains(leak), "{leak} is stored: {text}");
        }
        let raw_handle = handle::decode32(&handle).unwrap();
        let raw_secret = handle::decode32(&secret).unwrap();
        assert_eq!(handle_key.as_slice(), handle::handle_key(&raw_handle).as_slice());
        assert_eq!(secret_hash.as_slice(), handle::secret_hash(&raw_secret).as_slice());
        let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        assert!(!text.contains(&hex(&raw_handle)) && !text.contains(&hex(&raw_secret)));
        schema.drop().await;
    }
}
