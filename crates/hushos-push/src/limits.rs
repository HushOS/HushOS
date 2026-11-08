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
pub const DELETES_PER_ADDRESS: Budget = Budget(60);
/// A block (an IPv4 /24 or an IPv6 /48) may spend this many times one address's budget: enough
/// for a shared network, too little for one customer's whole prefix to flood the relay.
pub const BLOCK_FACTOR: u32 = 4;

pub fn block_budget(address: Budget) -> Budget {
    Budget(address.0.saturating_mul(BLOCK_FACTOR))
}

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

/// The network around an address: an IPv4 /24, or an IPv6 /48 (what one customer is usually
/// given). Counted beside the address itself, so one customer cannot spread a flood over the
/// 65,536 /64s of a /48.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Block([u8; 16]);

impl Block {
    pub fn of(address: IpAddr) -> Block {
        let mut octets = Sender::of(address).0;
        if is_mapped_v4(&octets) {
            octets[15] = 0;
        } else {
            octets[6..].fill(0);
        }
        Block(octets)
    }
}

fn is_mapped_v4(octets: &[u8; 16]) -> bool {
    octets[..10].iter().all(|b| *b == 0) && octets[10] == 0xff && octets[11] == 0xff
}

/// An address as the relay compares it: an IPv4 address, whether it arrived as such or mapped
/// into IPv6 (as it does on a socket listening on `[::]`).
pub fn canonical(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    }
}

/// An address range, as `PUSH_TRUSTED_PROXIES` lists them (`10.0.0.0/8`, `2001:db8::/32`, or a
/// bare address). IPv4 ranges match IPv4 addresses however they arrive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Range {
    base: [u8; 16],
    bits: u8,
}

impl Range {
    pub fn parse(text: &str) -> Option<Range> {
        let (address, bits) = match text.split_once('/') {
            Some((address, bits)) => (address, Some(bits.parse::<u8>().ok()?)),
            None => (text, None),
        };
        let address = canonical(address.parse::<IpAddr>().ok()?);
        let (base, bits) = match address {
            IpAddr::V4(v4) => (v4.to_ipv6_mapped().octets(), 96 + bits.unwrap_or(32).min(33)),
            IpAddr::V6(v6) => (v6.octets(), bits.unwrap_or(128)),
        };
        if bits > 128 {
            return None;
        }
        Some(Range { base, bits })
    }

    pub fn contains(&self, address: IpAddr) -> bool {
        let octets = match canonical(address) {
            IpAddr::V4(v4) => v4.to_ipv6_mapped().octets(),
            IpAddr::V6(v6) => v6.octets(),
        };
        let (whole, rest) = (usize::from(self.bits / 8), self.bits % 8);
        if octets[..whole] != self.base[..whole] {
            return false;
        }
        rest == 0 || (octets[whole] ^ self.base[whole]) >> (8 - rest) == 0
    }
}

/// What a bucket counts. Handles are counted by their key whether or not they are registered,
/// so a spent budget looks the same for a handle that exists and one that does not.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Key {
    Handle([u8; 32], Class),
    Address(Sender, Class),
    AddressBlock(Block, Class),
    Registrations(Sender),
    RegistrationsBlock(Block),
    Deletes(Sender),
    DeletesBlock(Block),
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
    last_sweep: Option<Duration>,
}

/// Sweep full buckets (which behave exactly like absent ones) this often, and whenever the map
/// reaches its cap, but at most once a second: a sweep walks the whole map under the lock, so a
/// flood that keeps the map full must not make every request pay for one.
const SWEEP_EVERY: u32 = 10_000;
const SWEEP_GAP: Duration = Duration::from_secs(1);

impl Limiter {
    /// `max_entries` caps memory: past it, and with nothing a sweep can free, new keys are
    /// refused rather than let a flood of fresh handles or addresses grow the map without end.
    pub fn new(max_entries: usize) -> Limiter {
        Limiter {
            inner: Mutex::new(Inner { buckets: HashMap::new(), since_sweep: 0, last_sweep: None }),
            max_entries,
        }
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
            if inner.last_sweep.is_none_or(|at| now.saturating_sub(at) >= SWEEP_GAP) {
                inner.sweep(now);
            }
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
        self.last_sweep = Some(now);
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

    #[test]
    fn ranges_match_their_addresses_however_they_arrive() {
        let v4 = Range::parse("10.0.0.0/24").unwrap();
        assert!(v4.contains("10.0.0.7".parse().unwrap()));
        assert!(v4.contains("::ffff:10.0.0.7".parse().unwrap()));
        assert!(!v4.contains("10.0.1.7".parse().unwrap()));
        let one = Range::parse("198.51.100.9").unwrap();
        assert!(one.contains("198.51.100.9".parse().unwrap()));
        assert!(!one.contains("198.51.100.10".parse().unwrap()));
        let v6 = Range::parse("2001:db8::/33").unwrap();
        assert!(v6.contains("2001:db8:7fff::1".parse().unwrap()));
        assert!(!v6.contains("2001:db8:8000::1".parse().unwrap()));
        for bad in ["10.0.0.0/33", "2001:db8::/129", "not-an-address", "10.0.0.0/x"] {
            assert_eq!(Range::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_block_is_a_v4_slash_24_or_a_v6_slash_48() {
        let block = |text: &str| Block::of(text.parse().unwrap());
        assert_eq!(block("192.0.2.1"), block("192.0.2.254"));
        assert_ne!(block("192.0.2.1"), block("192.0.3.1"));
        assert_eq!(block("::ffff:192.0.2.9"), block("192.0.2.1"));
        assert_eq!(block("2001:db8:1:ffff::1"), block("2001:db8:1::1"));
        assert_ne!(block("2001:db8:1::1"), block("2001:db8:2::1"));
    }

    #[test]
    fn a_full_map_is_swept_at_most_once_a_second() {
        let limiter = Limiter::new(2);
        assert!(ping(&limiter, Duration::ZERO, 1, Class::Security));
        assert!(ping(&limiter, Duration::ZERO, 2, Class::Security));
        // Full: the first refusal sweeps (and frees nothing, nothing has refilled).
        assert!(!ping(&limiter, Duration::ZERO, 3, Class::Security));
        // An hour on both have refilled, but a sweep within the second is skipped: still refused.
        let hour = Duration::from_secs(3600);
        limiter.inner.lock().unwrap().last_sweep = Some(hour - Duration::from_millis(500));
        assert!(!ping(&limiter, hour, 3, Class::Security));
        // A second later the sweep runs and makes room.
        assert!(ping(&limiter, hour + Duration::from_secs(1), 3, Class::Security));
    }
}
