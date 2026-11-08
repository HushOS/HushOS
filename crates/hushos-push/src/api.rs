//! The relay's routes, and the delivery that runs behind them.
//!
//! `POST /v1/ping` answers before it looks the handle up, and the push goes out in the
//! background, so a server learns nothing from the answer: a registered handle, an unknown one
//! and a dead one get the same response at the same speed.

use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, FromRequestParts, Path, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderName, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::{mpsc, Semaphore};

use crate::handle;
use crate::limits::{self, Budget, Clock, Key, Limiter, Sender};
use crate::push::{Class, Outcome, Platform, Push, Pusher};
use crate::store::{Registration, Store};

/// Bodies are a few dozen bytes; an FCM token is the longest thing in any of them.
const BODY_LIMIT: usize = 8 * 1024;

/// Pings waiting for delivery. Past this the relay is far behind, and a ping is dropped (the
/// device still fetches every pending event the next time it wakes).
const QUEUE: usize = 10_000;

/// Pushes in flight to Apple and Google at once.
const CONCURRENT_DELIVERIES: usize = 64;

/// Buckets kept in memory at most (about a hundred bytes each).
pub const MAX_LIMIT_ENTRIES: usize = 1_000_000;

#[derive(Clone, Debug)]
pub struct Settings {
    /// The header the proxy in front of the relay fills with the client's address; its last
    /// value is the one the nearest proxy appended. It is read only on connections from
    /// `trusted_proxies`: anyone else could write it. Without it the socket's address is used.
    pub trusted_proxy_header: Option<HeaderName>,
    pub trusted_proxies: Vec<limits::Range>,
    /// Addresses (hushos.com's own) that skip the per-address limits, never the per-handle ones.
    pub trusted_senders: Vec<IpAddr>,
    pub address_security: Budget,
    pub address_other: Budget,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            trusted_proxy_header: None,
            trusted_proxies: Vec::new(),
            trusted_senders: Vec::new(),
            address_security: Budget(1000),
            address_other: Budget(3000),
        }
    }
}

/// One sender per platform; a platform without credentials has none, and refuses registrations.
#[derive(Clone, Default)]
pub struct Pushers {
    pub apns: Option<Arc<dyn Pusher>>,
    pub apns_sandbox: Option<Arc<dyn Pusher>>,
    pub fcm: Option<Arc<dyn Pusher>>,
}

impl Pushers {
    fn get(&self, platform: Platform) -> Option<&Arc<dyn Pusher>> {
        match platform {
            Platform::Apns => self.apns.as_ref(),
            Platform::ApnsSandbox => self.apns_sandbox.as_ref(),
            Platform::Fcm => self.fcm.as_ref(),
        }
    }
}

/// Counts, the only thing the relay reports about its traffic.
#[derive(Default)]
pub struct Counters {
    pub registered: AtomicU64,
    pub deleted: AtomicU64,
    pub accepted: AtomicU64,
    pub limited: AtomicU64,
    pub dropped: AtomicU64,
    pub delivered: AtomicU64,
    pub dead: AtomicU64,
    pub failed: AtomicU64,
}

impl Counters {
    /// One line of counts since the last call, which resets them.
    pub fn take_line(&self) -> String {
        let take = |counter: &AtomicU64| counter.swap(0, Ordering::Relaxed);
        format!(
            "registered={} deleted={} pings accepted={} limited={} dropped={} delivered={} dead={} failed={}",
            take(&self.registered),
            take(&self.deleted),
            take(&self.accepted),
            take(&self.limited),
            take(&self.dropped),
            take(&self.delivered),
            take(&self.dead),
            take(&self.failed),
        )
    }
}

fn count(counter: &AtomicU64) {
    counter.fetch_add(1, Ordering::Relaxed);
}

/// What delivery needs, shared by the routes and the delivery loop.
pub struct Deliverer {
    pub store: Arc<dyn Store>,
    pub pushers: Pushers,
    pub counters: Counters,
}

pub struct Job {
    handle_key: [u8; 32],
    push: Push,
}

pub struct Relay {
    deliverer: Arc<Deliverer>,
    limiter: Limiter,
    clock: Arc<dyn Clock>,
    settings: Settings,
    queue: mpsc::Sender<Job>,
}

/// The relay's state and the receiving end of its delivery queue. The queue closes when the
/// last `Relay` (the router) is dropped, which lets `run_deliveries` finish.
pub fn relay(
    store: Arc<dyn Store>,
    pushers: Pushers,
    clock: Arc<dyn Clock>,
    settings: Settings,
    max_limit_entries: usize,
) -> (Arc<Relay>, Arc<Deliverer>, mpsc::Receiver<Job>) {
    let (queue, jobs) = mpsc::channel(QUEUE);
    let deliverer = Arc::new(Deliverer { store, pushers, counters: Counters::default() });
    let relay = Relay {
        deliverer: deliverer.clone(),
        limiter: Limiter::new(max_limit_entries),
        clock,
        settings,
        queue,
    };
    (Arc::new(relay), deliverer, jobs)
}

impl Relay {
    /// Forgets rate-limit records that have refilled (see `Limiter::forget_idle`).
    pub fn forget_idle(&self) {
        self.limiter.forget_idle(self.clock.now());
    }
}

pub fn router(relay: Arc<Relay>) -> Router {
    Router::new()
        .route("/v1/register", post(register))
        .route("/v1/register/{handle}", delete(unregister))
        .route("/v1/ping", post(ping))
        .route("/healthz", get(healthz))
        .route("/", get(page))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .with_state(relay)
}

/// Sends every queued ping until the queue closes and empties.
pub async fn run_deliveries(deliverer: Arc<Deliverer>, mut jobs: mpsc::Receiver<Job>) {
    let slots = Arc::new(Semaphore::new(CONCURRENT_DELIVERIES));
    while let Some(job) = jobs.recv().await {
        let Ok(slot) = slots.clone().acquire_owned().await else { break };
        let deliverer = deliverer.clone();
        tokio::spawn(async move {
            deliver(&deliverer, job).await;
            drop(slot);
        });
    }
    // Wait for the pushes still in flight.
    let _ = slots.acquire_many(CONCURRENT_DELIVERIES as u32).await;
}

/// Looks the handle up and sends the push. An unknown handle, or a platform without
/// credentials, sends nothing; a token Apple or Google report dead is deleted with every handle
/// that uses it.
pub async fn deliver(deliverer: &Deliverer, job: Job) {
    let (platform, token) = match deliverer.store.token(&job.handle_key).await {
        Ok(Some(found)) => found,
        Ok(None) => return,
        // The database, not the handle: counted, so an outage shows in the hourly line.
        Err(_) => return count(&deliverer.counters.failed),
    };
    let Some(pusher) = deliverer.pushers.get(platform) else { return };
    match pusher.send(&token, &job.push).await {
        Outcome::Delivered => count(&deliverer.counters.delivered),
        Outcome::Failed => count(&deliverer.counters.failed),
        Outcome::Dead => {
            count(&deliverer.counters.dead);
            if deliverer.store.delete_token(platform, &token).await.is_err() {
                count(&deliverer.counters.failed);
            }
        }
    }
}

/// The address a request came from, as the limits count it.
pub struct ClientAddress(Option<IpAddr>);

impl FromRequestParts<Arc<Relay>> for ClientAddress {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, relay: &Arc<Relay>) -> Result<Self, Self::Rejection> {
        let socket = parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|info| info.0.ip());
        // The header only from a proxy listed as one: from anyone else it is whatever they wrote.
        let from_proxy =
            socket.is_some_and(|ip| relay.settings.trusted_proxies.iter().any(|r| r.contains(ip)));
        // Right to left, past every hop that is itself a listed proxy (Coolify's, and Cloudflare's
        // edges when it fronts the relay): the first other address is the one that connected.
        // Anything a client wrote to the left of it is never reached.
        let from_header =
            relay.settings.trusted_proxy_header.as_ref().filter(|_| from_proxy).and_then(|name| {
                let value = parts.headers.get(name)?.to_str().ok()?;
                let mut nearest = None;
                for hop in value.rsplit(',') {
                    let hop = hop.trim();
                    // An address, or an address and port as some proxies write it.
                    let ip = hop
                        .parse::<IpAddr>()
                        .ok()
                        .or_else(|| hop.parse::<SocketAddr>().ok().map(|s| s.ip()))?;
                    nearest = Some(ip);
                    if !relay.settings.trusted_proxies.iter().any(|r| r.contains(ip)) {
                        break;
                    }
                }
                nearest
            });
        Ok(ClientAddress(from_header.or(socket).map(limits::canonical)))
    }
}

impl ClientAddress {
    fn ip(&self) -> IpAddr {
        self.0.unwrap_or(IpAddr::from([0u8; 16]))
    }

    fn sender(&self) -> Sender {
        Sender::of(self.ip())
    }

    fn block(&self) -> limits::Block {
        limits::Block::of(self.ip())
    }

    fn trusted(&self, settings: &Settings) -> bool {
        self.0.is_some_and(|ip| settings.trusted_senders.iter().any(|t| limits::canonical(*t) == ip))
    }
}

fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

fn bad_request() -> Response {
    error(StatusCode::BAD_REQUEST, "bad-request")
}

fn limited() -> Response {
    error(StatusCode::TOO_MANY_REQUESTS, "rate-limited")
}

#[derive(Deserialize)]
struct RegisterBody {
    platform: String,
    token: String,
}

async fn register(State(relay): State<Arc<Relay>>, address: ClientAddress, body: Bytes) -> Response {
    let Ok(body) = serde_json::from_slice::<RegisterBody>(&body) else { return bad_request() };
    let Some(platform) = Platform::parse(&body.platform) else { return bad_request() };
    let Some(token) = platform.normalize_token(&body.token) else { return bad_request() };
    if relay.deliverer.pushers.get(platform).is_none() {
        return error(StatusCode::SERVICE_UNAVAILABLE, "platform-unavailable");
    }
    let wants = [
        (Key::Registrations(address.sender()), limits::REGISTRATIONS_PER_ADDRESS),
        (Key::RegistrationsBlock(address.block()), limits::block_budget(limits::REGISTRATIONS_PER_ADDRESS)),
    ];
    if !relay.limiter.take(relay.clock.now(), &wants) {
        return limited();
    }
    let (handle, secret) = (handle::random32(), handle::random32());
    let registration = Registration {
        handle_key: handle::handle_key(&handle),
        platform,
        token,
        secret_hash: handle::secret_hash(&secret),
    };
    if relay.deliverer.store.insert(&registration).await.is_err() {
        return error(StatusCode::SERVICE_UNAVAILABLE, "unavailable");
    }
    count(&relay.deliverer.counters.registered);
    let body = json!({ "handle": handle::encode(&handle), "deleteSecret": handle::encode(&secret) });
    (StatusCode::OK, Json(body)).into_response()
}

#[derive(Deserialize)]
struct UnregisterBody {
    #[serde(rename = "deleteSecret")]
    delete_secret: String,
}

/// Deletes a registration given its secret. A wrong secret and an unknown handle get the same
/// answer, so a server holding a handle cannot learn whether the device still has it.
async fn unregister(
    State(relay): State<Arc<Relay>>,
    address: ClientAddress,
    Path(handle): Path<String>,
    body: Bytes,
) -> Response {
    let Ok(body) = serde_json::from_slice::<UnregisterBody>(&body) else { return bad_request() };
    // Each delete is a database round trip: bounded per address, so a flood cannot take the pool.
    let wants = [
        (Key::Deletes(address.sender()), limits::DELETES_PER_ADDRESS),
        (Key::DeletesBlock(address.block()), limits::block_budget(limits::DELETES_PER_ADDRESS)),
    ];
    if !relay.limiter.take(relay.clock.now(), &wants) {
        return limited();
    }
    let (Some(handle), Some(secret)) = (handle::decode32(&handle), handle::decode32(&body.delete_secret))
    else {
        return bad_request();
    };
    match relay.deliverer.store.delete(&handle::handle_key(&handle), &handle::secret_hash(&secret)).await {
        Ok(true) => {
            count(&relay.deliverer.counters.deleted);
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => error(StatusCode::NOT_FOUND, "not-found"),
        Err(_) => error(StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
    }
}

#[derive(Deserialize)]
struct PingBody {
    handle: String,
    id: String,
    class: Class,
}

async fn ping(State(relay): State<Arc<Relay>>, address: ClientAddress, body: Bytes) -> Response {
    let Ok(body) = serde_json::from_slice::<PingBody>(&body) else { return bad_request() };
    let Some(handle) = handle::decode32(&body.handle) else { return bad_request() };
    if !handle::is_event_id(&body.id) {
        return bad_request();
    }
    let handle_key = handle::handle_key(&handle);
    let class = body.class;
    let mut wants = vec![(Key::Handle(handle_key, class), limits::per_handle(class))];
    if !address.trusted(&relay.settings) {
        let budget = match class {
            Class::Security => relay.settings.address_security,
            Class::Other => relay.settings.address_other,
        };
        wants.push((Key::Address(address.sender(), class), budget));
        wants.push((Key::AddressBlock(address.block(), class), limits::block_budget(budget)));
    }
    if !relay.limiter.take(relay.clock.now(), &wants) {
        count(&relay.deliverer.counters.limited);
        return limited();
    }
    let job = Job { handle_key, push: Push { id: body.id, tag: handle::tag(&handle) } };
    if relay.queue.try_send(job).is_ok() {
        count(&relay.deliverer.counters.accepted);
    } else {
        count(&relay.deliverer.counters.dropped);
    }
    StatusCode::ACCEPTED.into_response()
}

/// What this service is and keeps, for anyone who opens push.hushos.com, a self-hoster among them.
/// Static and script-free: the policy allows only its own inline style.
async fn page() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::REFERRER_POLICY, "no-referrer"),
            (header::CACHE_CONTROL, "public, max-age=3600"),
        ],
        include_str!("page.html"),
    )
        .into_response()
}

async fn healthz(State(relay): State<Arc<Relay>>) -> Response {
    if relay.deliverer.store.ready().await {
        (StatusCode::OK, "ok").into_response()
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, "database unavailable").into_response()
    }
}

#[cfg(test)]
mod tests;
