//! Rate limits: token buckets per handle, per sending address and per registering address.
//!
//! Each bucket holds a full hour's budget and refills continuously, so a burst of the whole
//! budget passes, then one ping every `3600 / budget` seconds. Every class has its own bucket,
//! so `other` pings never spend what `security` pings need. Buckets live in memory: one relay
//! instance holds them all, and a restart refills them.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::push::Class;

/// Pings (or registrations) allowed per hour.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Budget(pub u32);

pub const SECURITY_PER_HANDLE: Budget = Budget(20);
pub const OTHER_PER_HANDLE: Budget = Budget(60);
pub const REGISTRATIONS_PER_ADDRESS: Budget = Budget(30);

pub fn per_handle(class: Class) -> Budget {
    match class {
        Class::Security => SECURITY_PER_HANDLE,
        Class::Other => OTHER_PER_HANDLE,
    }
}

/// A sending address as the limits see it: an IPv4 address, or an IPv6 address's /64, which one
/// customer usually holds whole.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Sender([u8; 16]);

impl Sender {
    pub fn of(address: IpAddr) -> Sender {
        match address {
            IpAddr::V4(v4) => Sender(v4.to_ipv6_mapped().octets()),
            IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
                Some(v4) => Sender(v4.to_ipv6_mapped().octets()),
                None => {
                    let mut octets = v6.octets();
                    octets[8..].fill(0);
                    Sender(octets)
                }
            },
        }
    }
}

/// What a bucket counts. Handles are counted by their key whether or not they are registered,
/// so a spent budget looks the same for a handle that exists and one that does not.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Key {
    Handle([u8; 32], Class),
    Address(Sender, Class),
    Registrations(Sender),
}

/// Monotonic time since some fixed start.
pub trait Clock: Send + Sync {
    fn now(&self) -> Duration;
}

pub struct SystemClock(Instant);

impl SystemClock {
    pub fn new() -> SystemClock {
        SystemClock(Instant::now())
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        SystemClock::new()
    }
}

impl Clock for SystemClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
}

/// One ping in bucket units: a bucket's level is in ping-milliseconds per hour, so refilling is
/// integer arithmetic (elapsed milliseconds × budget) with nothing lost to rounding.
const ONE: u64 = 3_600_000;

struct Bucket {
    level: u64,
    at: Duration,
}

fn capacity(budget: Budget) -> u64 {
    u64::from(budget.0) * ONE
}

fn level(bucket: Option<&Bucket>, budget: Budget, now: Duration) -> u64 {
    match bucket {
        None => capacity(budget),
        Some(bucket) => {
            let elapsed = now.saturating_sub(bucket.at).as_millis().min(u128::from(ONE)) as u64;
            (bucket.level + elapsed * u64::from(budget.0)).min(capacity(budget))
        }
    }
}

pub struct Limiter {
    inner: Mutex<Inner>,
    max_entries: usize,
}

struct Inner {
    buckets: HashMap<Key, (Bucket, Budget)>,
    since_sweep: u32,
}

/// Sweep full buckets (which behave exactly like absent ones) this often, and whenever the map
/// reaches its cap.
const SWEEP_EVERY: u32 = 10_000;

impl Limiter {
    /// `max_entries` caps memory: past it, and with nothing a sweep can free, new keys are
    /// refused rather than let a flood of fresh handles or addresses grow the map without end.
    pub fn new(max_entries: usize) -> Limiter {
        Limiter { inner: Mutex::new(Inner { buckets: HashMap::new(), since_sweep: 0 }), max_entries }
    }

    /// Takes one from every bucket, or from none: a ping one limit refuses spends nothing from
    /// the others.
    pub fn take(&self, now: Duration, wants: &[(Key, Budget)]) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.since_sweep += 1;
        if inner.since_sweep >= SWEEP_EVERY {
            inner.sweep(now);
        }
        let mut fresh = 0;
        for (key, budget) in wants {
            let bucket = inner.buckets.get(key).map(|(bucket, _)| bucket);
            if bucket.is_none() {
                fresh += 1;
            }
            if level(bucket, *budget, now) < ONE {
                return false;
            }
        }
        if fresh > 0 && inner.buckets.len() + fresh > self.max_entries {
            inner.sweep(now);
            if inner.buckets.len() + fresh > self.max_entries {
                return false;
            }
        }
        for (key, budget) in wants {
            let current = level(inner.buckets.get(key).map(|(bucket, _)| bucket), *budget, now);
            inner.buckets.insert(*key, (Bucket { level: current - ONE, at: now }, *budget));
        }
        true
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.lock().unwrap().buckets.len()
    }
}

impl Inner {
    fn sweep(&mut self, now: Duration) {
        self.since_sweep = 0;
        self.buckets.retain(|_, (bucket, budget)| level(Some(bucket), *budget, now) < capacity(*budget));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);

    fn handle(n: u8) -> [u8; 32] {
        [n; 32]
    }

    fn address(text: &str) -> Sender {
        Sender::of(text.parse().unwrap())
    }

    fn ping(limiter: &Limiter, now: Duration, h: u8, class: Class) -> bool {
        limiter.take(now, &[(Key::Handle(handle(h), class), per_handle(class))])
    }

    fn passed(limiter: &Limiter, now: Duration, h: u8, class: Class, times: usize) -> usize {
        (0..times).filter(|_| ping(limiter, now, h, class)).count()
    }

    #[test]
    fn a_handle_gets_20_security_pings_an_hour() {
        let limiter = Limiter::new(1000);
        assert_eq!(passed(&limiter, Duration::ZERO, 1, Class::Security, 25), 20);
        // One more every three minutes, and not before.
        assert!(!ping(&limiter, 3 * MINUTE - Duration::from_millis(1), 1, Class::Security));
        assert!(ping(&limiter, 3 * MINUTE, 1, Class::Security));
        assert!(!ping(&limiter, 3 * MINUTE, 1, Class::Security));
        // A quiet hour refills the bucket, and never past the budget.
        assert_eq!(passed(&limiter, 3 * MINUTE + 5 * 60 * MINUTE, 1, Class::Security, 25), 20);
    }

    #[test]
    fn a_handle_gets_60_other_pings_an_hour() {
        let limiter = Limiter::new(1000);
        assert_eq!(passed(&limiter, Duration::ZERO, 1, Class::Other, 70), 60);
        assert!(!ping(&limiter, MINUTE - Duration::from_millis(1), 1, Class::Other));
        assert!(ping(&limiter, MINUTE, 1, Class::Other));
    }

    #[test]
    fn other_pings_cannot_spend_the_security_budget() {
        let limiter = Limiter::new(1000);
        assert_eq!(passed(&limiter, Duration::ZERO, 1, Class::Other, 500), 60);
        assert_eq!(passed(&limiter, Duration::ZERO, 1, Class::Security, 25), 20);
        // Nor the other way round, and handles never share.
        assert!(!ping(&limiter, Duration::ZERO, 1, Class::Other));
        assert_eq!(passed(&limiter, Duration::ZERO, 2, Class::Security, 25), 20);
        assert_eq!(passed(&limiter, Duration::ZERO, 2, Class::Other, 70), 60);
    }

    #[test]
    fn an_address_budget_spans_handles_and_a_refusal_spends_nothing() {
        let limiter = Limiter::new(1000);
        let from = address("198.51.100.4");
        let wants = |h: u8| {
            [
                (Key::Handle(handle(h), Class::Other), OTHER_PER_HANDLE),
                (Key::Address(from, Class::Other), Budget(5)),
            ]
        };
        for h in 0..5 {
            assert!(limiter.take(Duration::ZERO, &wants(h)));
        }
        assert!(!limiter.take(Duration::ZERO, &wants(9)));
        // The refused pings took nothing from handle 9: from another address it has its 60.
        for _ in 0..100 {
            limiter.take(Duration::ZERO, &wants(9));
        }
        let elsewhere = Key::Address(address("198.51.100.5"), Class::Other);
        let passed = (0..70)
            .filter(|_| {
                limiter.take(
                    Duration::ZERO,
                    &[(Key::Handle(handle(9), Class::Other), OTHER_PER_HANDLE), (elsewhere, Budget(1000))],
                )
            })
            .count();
        assert_eq!(passed, 60);
    }

    #[test]
    fn an_ipv6_slash_64_is_one_sender() {
        assert_eq!(address("2001:db8:1:2::1"), address("2001:db8:1:2:ffff:ffff:ffff:ffff"));
        assert_ne!(address("2001:db8:1:2::1"), address("2001:db8:1:3::1"));
        assert_eq!(address("::ffff:198.51.100.4"), address("198.51.100.4"));
        assert_ne!(address("198.51.100.4"), address("198.51.100.5"));
    }

    #[test]
    fn sweeping_forgets_only_full_buckets() {
        let limiter = Limiter::new(4);
        assert_eq!(passed(&limiter, Duration::ZERO, 1, Class::Security, 25), 20);
        assert!(ping(&limiter, Duration::ZERO, 2, Class::Security));
        assert!(ping(&limiter, Duration::ZERO, 3, Class::Security));
        assert!(ping(&limiter, Duration::ZERO, 4, Class::Security));
        // Full map, nothing refilled: a new key is refused, not let in by forgetting a spent one.
        assert!(!ping(&limiter, Duration::ZERO, 5, Class::Security));
        assert_eq!(limiter.len(), 4);
        // Ten minutes on, handles 2 to 4 have refilled and are swept to make room. Handle 1 has
        // earned back three pings in those ten minutes, and the sweep gave it no more.
        let later = 10 * MINUTE;
        assert!(ping(&limiter, later, 5, Class::Security));
        assert_eq!(limiter.len(), 2);
        assert_eq!(passed(&limiter, later, 1, Class::Security, 25), 3);
    }
}
