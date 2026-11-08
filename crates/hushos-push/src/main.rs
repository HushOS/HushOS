//! `hushos-push`: the relay's process. Configuration is in `config.rs`; docs/push-relay-plan.md
//! says how it is deployed.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use hushos_push::api::{self, Pushers};
use hushos_push::apns::{self, ApnsAuth, ApnsPusher};
use hushos_push::config::Config;
use hushos_push::fcm::FcmPusher;
use hushos_push::limits::SystemClock;
use hushos_push::push::Pusher;
use hushos_push::store::PgStore;

/// How long a stopping relay waits for pushes already accepted.
const DRAIN: Duration = Duration::from_secs(10);

#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        std::process::exit(if healthy().await { 0 } else { 1 });
    }
    if let Err(message) = run().await {
        eprintln!("hushos-push: {message}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let config = Config::from_env(&|name| std::env::var(name).ok())?;
    let store = PgStore::connect(&config.database_url).await.map_err(|error| format!("database: {error}"))?;

    let mut pushers = Pushers::default();
    if let Some(apns) = config.apns {
        let auth = Arc::new(ApnsAuth::new(&apns.key, apns.key_id, apns.team_id)?);
        pushers.apns =
            Some(Arc::new(ApnsPusher::new(apns::PRODUCTION_HOST, apns.topic.clone(), auth.clone())?));
        pushers.apns_sandbox = Some(Arc::new(ApnsPusher::new(apns::SANDBOX_HOST, apns.topic, auth)?));
    }
    if let Some(account) = config.fcm_service_account {
        pushers.fcm = Some(Arc::new(FcmPusher::new(&account)?) as Arc<dyn Pusher>);
    }
    let platforms: Vec<&str> = [("apns", pushers.apns.is_some()), ("fcm", pushers.fcm.is_some())]
        .into_iter()
        .filter_map(|(name, on)| on.then_some(name))
        .collect();

    let (relay, deliverer, jobs) = api::relay(
        Arc::new(store),
        pushers,
        Arc::new(SystemClock::new()),
        config.settings,
        api::MAX_LIMIT_ENTRIES,
    );
    let deliveries = tokio::spawn(api::run_deliveries(deliverer.clone(), jobs));
    let idle = relay.clone();
    tokio::spawn(async move {
        let mut minutely = tokio::time::interval(Duration::from_secs(60));
        loop {
            minutely.tick().await;
            idle.forget_idle();
        }
    });
    let counts = deliverer.clone();
    tokio::spawn(async move {
        let mut hourly = tokio::time::interval(Duration::from_secs(3600));
        hourly.tick().await;
        loop {
            hourly.tick().await;
            eprintln!("hushos-push: last hour: {}", counts.counters.take_line());
        }
    });

    let listener = tokio::net::TcpListener::bind(config.listen)
        .await
        .map_err(|error| format!("listen on {}: {error}", config.listen))?;
    let platforms = if platforms.is_empty() {
        "nothing (no APNs or FCM credentials)".to_owned()
    } else {
        platforms.join(", ")
    };
    eprintln!("hushos-push: listening on {}, sending to {platforms}", config.listen);
    axum::serve(listener, api::router(relay).into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(stopped())
        .await
        .map_err(|error| error.to_string())?;

    // The router is gone, so the queue is closed: finish what it holds.
    if tokio::time::timeout(DRAIN, deliveries).await.is_err() {
        eprintln!("hushos-push: stopped with pushes still queued");
    }
    eprintln!("hushos-push: stopped: {}", deliverer.counters.take_line());
    Ok(())
}

/// The image's health check: the image has no shell or curl, so the binary asks its own
/// `/healthz` (which checks the database) over loopback.
async fn healthy() -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listen = std::env::var("PUSH_LISTEN").unwrap_or_else(|_| "0.0.0.0:8080".to_owned());
    let Ok(listen) = listen.parse::<SocketAddr>() else { return false };
    let target = SocketAddr::from(([127, 0, 0, 1], listen.port()));
    let check = async {
        let mut stream = tokio::net::TcpStream::connect(target).await.ok()?;
        stream.write_all(b"GET /healthz HTTP/1.0\r\nHost: localhost\r\n\r\n").await.ok()?;
        let mut answer = Vec::new();
        stream.read_to_end(&mut answer).await.ok()?;
        Some(answer.starts_with(b"HTTP/1.0 200") || answer.starts_with(b"HTTP/1.1 200"))
    };
    matches!(tokio::time::timeout(Duration::from_secs(4), check).await, Ok(Some(true)))
}

async fn stopped() {
    let interrupt = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("a SIGTERM handler");
        tokio::select! {
            _ = interrupt => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = interrupt.await;
    }
}
