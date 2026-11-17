//! The ground file tools stand on in the phone apps (docs/file-tools-design.md,
//! section 6): a seekable, decrypting reader over one version; the control a
//! run is held by (cancel and the no-progress watchdog); and the budget of
//! produced plaintext waiting for upload, which the app keeps one of for the
//! whole process so results a finished run left behind still count.
//!
//! The reader fetches the object's ciphertext through the app's HTTP layer
//! ([`ObjectSource`], one chunk's range at a time), opens each chunk here and
//! keeps only the chunks it is reading in memory, wiped when they leave. No
//! plaintext is written anywhere.
//!
//! A run is one thread the app starts. Unlike a web worker, a thread cannot be
//! killed: cancelling or timing a run out stops it at its next read, produce or
//! progress call, each of which then fails, and its memory goes as it unwinds.

use std::collections::VecDeque;
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{
    chunk_decrypt, chunk_length, chunk_range, content_layout, input, ByteRange, Content, CoreError,
    CoreResult,
};

/// Produced plaintext waiting for upload, across every run of the process,
/// before producing pauses (section 3, "Memory").
pub const TOOL_BUDGET_BYTES: u64 = 512 * 1024 * 1024;
/// How long a run may go without reporting progress, waits on the network and
/// on the budget not counted, before it is stopped.
pub const TOOL_WATCHDOG_MILLIS: u64 = 30_000;
/// What a run that timed out, or that a tool refused part-way, tells the person.
pub const TOOL_FAILED: &str = "This file couldn't be processed.";
const CANCELLED: &str = "Cancelled.";
const DAMAGED: &str = "This file could not be decrypted. It may be damaged.";
/// The most one [`VersionReader::read_at`] hands back at once: a range bigger
/// than any tool asks for (the zip listing cap) is refused, not allocated.
const READ_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Chunks a reader keeps opened besides the file's last: the one being read
/// and the one before, for a read that straddles them.
const CACHED_CHUNKS: usize = 2;
/// A reader fetches at most this many times its object's size: a parser made to
/// seek back and forth over the file without end fails instead of downloading
/// it again and again.
const FETCH_FACTOR: u64 = 4;
/// The most of the watchdog's clock one check can add. The apps check each
/// second; a phone that suspended the app for a minute adds this much, not the
/// minute the run never had.
const WATCHDOG_TICK_CAP_MILLIS: u64 = 2_000;
/// How often a producer waiting on a full budget looks whether its run ended.
const BUDGET_WAIT_SLICE: Duration = Duration::from_millis(50);

/// The object store, as the app reaches it: the bytes `range.start` to
/// `range.end` inclusive of one version's object, exactly as stored. The app
/// renews an expired address and retries as its downloads do, and gives up as
/// soon as the run's control has ended ([`RunControl::is_ended`]). It is called
/// on the run's own thread and may block it; never call a reader from the main
/// thread or a cooperative pool.
#[cfg_attr(feature = "uniffi", uniffi::export(with_foreign))]
pub trait ObjectSource: Send + Sync {
    fn fetch(&self, range: ByteRange) -> Result<Vec<u8>, FetchError>;
}

/// Why the store's bytes did not come: the app's words, which the read fails with. Not a
/// [`CoreError`], which is flat and so cannot be thrown back from Swift or Kotlin.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Error))]
pub enum FetchError {
    /* Not `message`, which Kotlin's Throwable already has. */
    #[error("{reason}")]
    Failed { reason: String },
}

#[cfg(feature = "uniffi")]
impl From<uniffi::UnexpectedUniFFICallbackError> for FetchError {
    fn from(error: uniffi::UnexpectedUniFFICallbackError) -> Self {
        FetchError::Failed { reason: error.reason }
    }
}

/// Milliseconds from any fixed point, for the watchdog. The apps pass none and
/// get the system's monotonic clock; tests pass one they move by hand.
#[cfg_attr(feature = "uniffi", uniffi::export(with_foreign))]
pub trait ToolClock: Send + Sync {
    fn now_millis(&self) -> u64;
}

struct SystemClock(Instant);

impl ToolClock for SystemClock {
    fn now_millis(&self) -> u64 {
        self.0.elapsed().as_millis() as u64
    }
}

/// The constants above, for the apps.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn tool_budget_bytes() -> u64 {
    TOOL_BUDGET_BYTES
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn tool_watchdog_millis() -> u64 {
    TOOL_WATCHDOG_MILLIS
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn tool_failed_message() -> String {
    TOOL_FAILED.into()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic elsewhere while holding it leaves plain numbers or chunks behind: still usable.
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// Run control
// ---------------------------------------------------------------------------

const RUNNING: u8 = 0;
const CANCELLED_STATE: u8 = 1;
const TIMED_OUT: u8 = 2;

#[derive(Debug)]
struct Clock {
    /* Waits on someone else (a fetch, the budget) in progress: the watchdog's clock stops for them. */
    holds: u32,
    /* Time without progress, holds left out. */
    idle: u64,
    /* When the clock was last brought up to date. */
    last: u64,
}

/// One run's control, shared by the thread doing the work and the app that
/// started it. The work calls [`progress`](Self::progress) as it gets on; the
/// app calls [`check_watchdog`](Self::check_watchdog) about once a second and
/// [`cancel`](Self::cancel). After a cancel or a timeout every call the work
/// makes fails (a read, a produce, progress, check), so it stops at the next.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct RunControl {
    ended: AtomicU8,
    clock: Mutex<Clock>,
    source: Arc<dyn ToolClock>,
    watchdog: u64,
}

impl std::fmt::Debug for RunControl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunControl").field("ended", &self.ended).field("watchdog", &self.watchdog).finish()
    }
}

/* A wait on someone else; the watchdog's clock runs on from where it stopped when it ends. */
struct Hold<'a>(&'a RunControl);

impl Drop for Hold<'_> {
    fn drop(&mut self) {
        let mut clock = lock(&self.0.clock);
        self.0.bring_up(&mut clock);
        clock.holds -= 1;
    }
}

impl RunControl {
    /* Time since the clock was last brought up counts, capped, unless the run was waiting on someone else. */
    fn bring_up(&self, clock: &mut Clock) {
        let now = self.source.now_millis();
        let passed = now.saturating_sub(clock.last).min(WATCHDOG_TICK_CAP_MILLIS);
        if clock.holds == 0 {
            clock.idle = clock.idle.saturating_add(passed);
        }
        clock.last = now;
    }

    fn hold(&self) -> Hold<'_> {
        let mut clock = lock(&self.clock);
        self.bring_up(&mut clock);
        clock.holds += 1;
        Hold(self)
    }

    fn end(&self, how: u8) -> bool {
        self.ended.compare_exchange(RUNNING, how, Ordering::SeqCst, Ordering::SeqCst).is_ok()
    }

    fn refusal(&self) -> CoreResult<()> {
        match self.ended.load(Ordering::SeqCst) {
            RUNNING => Ok(()),
            CANCELLED_STATE => Err(input(CANCELLED)),
            _ => Err(input(TOOL_FAILED)),
        }
    }
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl RunControl {
    /// The watchdog stops a run that reports no progress for `watchdog_millis`
    /// (the apps pass [`tool_watchdog_millis`]), measured on `clock`, or the
    /// system's monotonic clock when there is none.
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn new(watchdog_millis: u64, clock: Option<Arc<dyn ToolClock>>) -> Arc<Self> {
        let source = clock.unwrap_or_else(|| Arc::new(SystemClock(Instant::now())));
        let last = source.now_millis();
        Arc::new(RunControl {
            ended: AtomicU8::new(RUNNING),
            clock: Mutex::new(Clock { holds: 0, idle: 0, last }),
            source,
            watchdog: watchdog_millis,
        })
    }

    /// Stops the run: every later call from the work fails with "Cancelled.".
    pub fn cancel(&self) {
        self.end(CANCELLED_STATE);
    }

    /// Brings the watchdog's clock up to date, adding at most two seconds since
    /// the last check (time the app was suspended is not the run's), and none
    /// while the work waits on the network or the budget. The first check that
    /// finds the watchdog's time spent ends the run, as a cancel does but
    /// failing with [`TOOL_FAILED`], and answers true; every other answers false.
    pub fn check_watchdog(&self) -> bool {
        if self.is_ended() {
            return false;
        }
        let idle = {
            let mut clock = lock(&self.clock);
            self.bring_up(&mut clock);
            clock.idle
        };
        idle >= self.watchdog && self.end(TIMED_OUT)
    }

    /// Whether the run has ended, by a cancel or the watchdog.
    pub fn is_ended(&self) -> bool {
        self.ended.load(Ordering::SeqCst) != RUNNING
    }

    pub fn is_cancelled(&self) -> bool {
        self.ended.load(Ordering::SeqCst) == CANCELLED_STATE
    }

    pub fn timed_out(&self) -> bool {
        self.ended.load(Ordering::SeqCst) == TIMED_OUT
    }

    /// The work got on: the watchdog starts over. Fails once the run has ended.
    pub fn progress(&self) -> CoreResult<()> {
        self.refusal()?;
        let mut clock = lock(&self.clock);
        clock.idle = 0;
        clock.last = self.source.now_millis();
        Ok(())
    }

    /// Fails once the run has ended; otherwise nothing.
    pub fn check(&self) -> CoreResult<()> {
        self.refusal()
    }
}

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

/// Produced plaintext waiting for upload. The app keeps one for the process
/// and hands it to every run: a run that finished leaves its results counted
/// until the upload has them, so the next run cannot add another 512 MiB on
/// top. Whoever takes a result (the save path) releases it when it is uploaded
/// or dropped, a cancelled run's included.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
#[derive(Debug)]
pub struct ToolBudget {
    limit: u64,
    waiting: Mutex<u64>,
    room: Condvar,
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl ToolBudget {
    /// The apps pass [`tool_budget_bytes`]; tests pass less.
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn new(limit_bytes: u64) -> Arc<Self> {
        Arc::new(ToolBudget { limit: limit_bytes.max(1), waiting: Mutex::new(0), room: Condvar::new() })
    }

    /// Before the run under `control` hands on a result of `bytes`: waits while
    /// the budget is full, then counts it. The result that crosses the line
    /// goes through; the next waits until releases bring the total under it.
    /// The wait stops the watchdog's clock (a paused upload is no hang) and
    /// ends, failing, when the run does. Counts as progress.
    pub fn produce(&self, bytes: u64, control: Arc<RunControl>) -> CoreResult<()> {
        control.check()?;
        let mut waiting = lock(&self.waiting);
        if *waiting >= self.limit {
            let _hold = control.hold();
            while *waiting >= self.limit {
                control.check()?;
                waiting = self
                    .room
                    .wait_timeout(waiting, BUDGET_WAIT_SLICE)
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .0;
            }
        }
        control.check()?;
        *waiting = waiting.saturating_add(bytes);
        drop(waiting);
        control.progress()
    }

    /// A result of `bytes` was uploaded or dropped: its room goes back.
    pub fn release(&self, bytes: u64) {
        let mut waiting = lock(&self.waiting);
        *waiting = waiting.saturating_sub(bytes);
        self.room.notify_all();
    }

    /// Produced plaintext waiting for upload now.
    pub fn waiting(&self) -> u64 {
        *lock(&self.waiting)
    }
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

type Plain = Arc<Zeroizing<Vec<u8>>>;

struct ReaderState {
    /* Most recently used last; each chunk's plaintext is wiped when the last reference goes. */
    cache: VecDeque<(u64, Plain)>,
    /*
     * The file's last chunk, kept for the reader's life: it is where a zip's directory is, and
     * its padding was fetched with it once, never again.
     */
    tail: Option<Plain>,
}

/// Random access to one version's plaintext. Each chunk a read touches is
/// fetched by its own range, opened, and kept while it is one of the last two
/// read; the file's last chunk is kept for the reader's life. When that chunk
/// is fetched, the padding chunks after it are fetched too, as the web's reader
/// does, so the ranges never show the store where the file ends; a padding
/// chunk that fails to arrive or to open fails the read. Any chunk that fails
/// to open fails the read. In all a reader fetches at most four times its
/// object's size, then fails.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct VersionReader {
    source: Arc<dyn ObjectSource>,
    content: Content,
    control: Option<Arc<RunControl>>,
    chunk_bytes: u64,
    chunk_count: u64,
    file_chunks: u64,
    fetched: AtomicU64,
    fetch_limit: u64,
    state: Mutex<ReaderState>,
}

impl std::fmt::Debug for VersionReader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VersionReader")
            .field("object_id", &self.content.object_id)
            .field("size", &self.content.plaintext_size)
            .finish()
    }
}

impl VersionReader {
    /// A reader for Rust callers (the tools): the same as the exported constructor.
    pub fn open(
        source: Arc<dyn ObjectSource>,
        content: Content,
        control: Option<Arc<RunControl>>,
    ) -> CoreResult<Arc<Self>> {
        let layout = content_layout(content.suite, content.plaintext_size, content.thumbnail_bytes)?;
        let file_chunks = content.plaintext_size.div_ceil(layout.chunk_bytes).clamp(1, layout.chunk_count);
        Ok(Arc::new(VersionReader {
            source,
            control,
            chunk_bytes: layout.chunk_bytes,
            chunk_count: layout.chunk_count,
            file_chunks,
            fetched: AtomicU64::new(0),
            fetch_limit: layout.ciphertext_size.saturating_mul(FETCH_FACTOR),
            content,
            state: Mutex::new(ReaderState { cache: VecDeque::new(), tail: None }),
        }))
    }

    /// A `Read + Seek` view at offset 0. Each cursor keeps its own position;
    /// they share the reader's chunks.
    pub fn cursor(self: &Arc<Self>) -> VersionCursor {
        VersionCursor { reader: Arc::clone(self), position: 0 }
    }

    /* Every opened chunk goes: the run ended, and nothing more is read. */
    fn forget(&self) {
        let mut state = lock(&self.state);
        state.cache.clear();
        state.tail = None;
    }

    /* Fails, and lets go of every chunk, once the run has ended. */
    fn check(&self) -> CoreResult<()> {
        match &self.control {
            Some(control) if control.is_ended() => {
                self.forget();
                control.check()
            }
            _ => Ok(()),
        }
    }

    fn fetch_open(&self, index: u64) -> CoreResult<Zeroizing<Vec<u8>>> {
        self.check()?;
        let range = chunk_range(
            self.content.suite,
            self.content.plaintext_size,
            self.content.thumbnail_bytes,
            index,
        )?;
        let length = range.end - range.start + 1;
        if self.fetched.fetch_add(length, Ordering::SeqCst).saturating_add(length) > self.fetch_limit {
            return Err(input(TOOL_FAILED));
        }
        let ciphertext = {
            let _hold = self.control.as_ref().map(|control| control.hold());
            self.source.fetch(range).map_err(|FetchError::Failed { reason }| input(reason))?
        };
        if ciphertext.len() as u64 != length {
            return Err(CoreError::Sealed(DAMAGED.into()));
        }
        // A cancel while the fetch was out: nothing it brought is opened.
        self.check()?;
        Ok(Zeroizing::new(chunk_decrypt(self.content.clone(), index, ciphertext)?))
    }

    fn chunk(&self, index: u64) -> CoreResult<Plain> {
        let last = index + 1 == self.file_chunks;
        {
            let mut state = lock(&self.state);
            if last {
                if let Some(tail) = &state.tail {
                    return Ok(Arc::clone(tail));
                }
            } else if let Some(at) = state.cache.iter().position(|(i, _)| *i == index) {
                let entry = state.cache.remove(at).expect("present");
                let bytes = Arc::clone(&entry.1);
                state.cache.push_back(entry);
                return Ok(bytes);
            }
        }
        let plaintext = self.fetch_open(index)?;
        if plaintext.len() as u64 != chunk_length(self.content.plaintext_size, index) {
            return Err(CoreError::Sealed(DAMAGED.into()));
        }
        let plaintext = Arc::new(plaintext);
        if last {
            // The padding after the file, once, with its last chunk: opened, giving nothing.
            for padding in self.file_chunks..self.chunk_count {
                if !self.fetch_open(padding)?.is_empty() {
                    return Err(CoreError::Sealed(DAMAGED.into()));
                }
            }
            lock(&self.state).tail = Some(Arc::clone(&plaintext));
            return Ok(plaintext);
        }
        let mut state = lock(&self.state);
        state.cache.push_back((index, Arc::clone(&plaintext)));
        while state.cache.len() > CACHED_CHUNKS {
            state.cache.pop_front();
        }
        Ok(plaintext)
    }

    /// Fills `out` from `offset`, as far as the file goes; how many bytes it
    /// wrote. Fails at once, whatever is cached, once the run has ended.
    pub fn read_into(&self, offset: u64, out: &mut [u8]) -> CoreResult<usize> {
        self.check()?;
        let size = self.content.plaintext_size;
        if offset >= size || out.is_empty() {
            return Ok(0);
        }
        let end = size.min(offset.saturating_add(out.len() as u64));
        let mut at = offset;
        while at < end {
            let index = at / self.chunk_bytes;
            let base = index * self.chunk_bytes;
            let plaintext = self.chunk(index)?;
            let from = (at - base) as usize;
            let to = ((end - base) as usize).min(plaintext.len());
            if to <= from {
                return Err(CoreError::Sealed(DAMAGED.into()));
            }
            let written = (at - offset) as usize;
            out[written..written + (to - from)].copy_from_slice(&plaintext[from..to]);
            at += (to - from) as u64;
        }
        Ok((end - offset) as usize)
    }
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl VersionReader {
    /// A reader over the version `content` opens (from `versionOpen`), whose
    /// object `source` fetches. With a `control`, every read first checks the
    /// run has not ended, and the watchdog's clock stops while a fetch waits.
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn new(
        source: Arc<dyn ObjectSource>,
        content: Content,
        control: Option<Arc<RunControl>>,
    ) -> CoreResult<Arc<Self>> {
        Self::open(source, content, control)
    }

    /// The file's size in bytes.
    pub fn size(&self) -> u64 {
        self.content.plaintext_size
    }

    /// Up to `length` bytes from `offset`; fewer at the end of the file, none
    /// past it. At most 64 MiB in one read.
    pub fn read_at(&self, offset: u64, length: u64) -> CoreResult<Vec<u8>> {
        if length > READ_MAX_BYTES {
            return Err(input("A read of more than 64 MiB was refused."));
        }
        let available = self.content.plaintext_size.saturating_sub(offset).min(length);
        let mut out = vec![0u8; available as usize];
        let read = self.read_into(offset, &mut out)?;
        out.truncate(read);
        Ok(out)
    }
}

/// A position over a [`VersionReader`], for the `zip` and `tar` crates.
#[derive(Debug)]
pub struct VersionCursor {
    reader: Arc<VersionReader>,
    position: u64,
}

impl Read for VersionCursor {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        // Never ErrorKind::Interrupted: read_exact would retry a cancelled run forever.
        let read = self.reader.read_into(self.position, buf).map_err(io::Error::other)?;
        self.position += read as u64;
        Ok(read)
    }
}

impl Seek for VersionCursor {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let size = self.reader.size() as i128;
        let target = match from {
            SeekFrom::Start(at) => at as i128,
            SeekFrom::End(delta) => size + delta as i128,
            SeekFrom::Current(delta) => self.position as i128 + delta as i128,
        };
        if target < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "seek before the start of the file"));
        }
        self.position =
            u64::try_from(target).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "seek too far"))?;
        Ok(self.position)
    }
}

/// The SHA-256 of `length` bytes from `offset` (clipped to the file), read a
/// MiB at a time under `control`: the smallest tool, which the apps' harness
/// tests run, and what a later tool checks an extracted entry with.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn range_digest(
    reader: Arc<VersionReader>,
    control: Arc<RunControl>,
    offset: u64,
    length: u64,
) -> CoreResult<Vec<u8>> {
    const STEP: usize = 1024 * 1024;
    let end = reader.size().min(offset.saturating_add(length));
    let mut hash = Sha256::new();
    let mut buf = Zeroizing::new(vec![0u8; STEP]);
    let mut at = offset;
    while at < end {
        let want = STEP.min((end - at) as usize);
        let read = reader.read_into(at, &mut buf[..want])?;
        if read == 0 {
            break;
        }
        hash.update(&buf[..read]);
        at += read as u64;
        control.progress()?;
    }
    control.check()?;
    Ok(hash.finalize().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{chunk_encrypt, thumbnail_encrypt};
    use std::thread;

    const CHUNK: u64 = 8 * 1024 * 1024;
    const SEALED_CHUNK: u64 = CHUNK + 16;

    fn plaintext(size: u64) -> Vec<u8> {
        // Not periodic in the chunk size, so a chunk read from the wrong place is caught.
        (0..size).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect()
    }

    fn content(size: u64, thumbnail_bytes: u32) -> Content {
        Content {
            workspace_id: "11111111-1111-4111-8111-111111111111".into(),
            object_id: "66666666-6666-4666-8666-666666666666".into(),
            suite: 3,
            key: vec![7u8; 32].into(),
            nonce: vec![9u8; 16],
            plaintext_size: size,
            thumbnail_bytes,
        }
    }

    /* The object exactly as an upload stores it: every chunk sealed, then the thumbnail trailer. */
    fn object(content: &Content, plain: &[u8]) -> Vec<u8> {
        let layout = content_layout(content.suite, content.plaintext_size, content.thumbnail_bytes).unwrap();
        let mut out = Vec::new();
        for index in 0..layout.chunk_count {
            let start = (index * CHUNK).min(plain.len() as u64) as usize;
            let len = chunk_length(content.plaintext_size, index) as usize;
            out.extend(chunk_encrypt(content.clone(), index, plain[start..start + len].to_vec()).unwrap());
        }
        if content.thumbnail_bytes > 0 {
            out.extend(
                thumbnail_encrypt(content.clone(), vec![1u8; content.thumbnail_bytes as usize]).unwrap(),
            );
        }
        assert_eq!(out.len() as u64, layout.ciphertext_size);
        out
    }

    /* A clock the test moves. */
    #[derive(Default)]
    struct Manual(AtomicU64);

    impl Manual {
        fn advance(&self, millis: u64) {
            self.0.fetch_add(millis, Ordering::SeqCst);
        }
    }

    impl ToolClock for Manual {
        fn now_millis(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    type Hook = Box<dyn Fn(&ByteRange) -> Option<FetchError> + Send + Sync>;

    struct Store {
        object: Vec<u8>,
        fetched: Mutex<Vec<ByteRange>>,
        /* Runs before each fetch: moves a clock, fails a range. */
        hook: Option<Hook>,
    }

    impl ObjectSource for Store {
        fn fetch(&self, range: ByteRange) -> Result<Vec<u8>, FetchError> {
            self.fetched.lock().unwrap().push(range.clone());
            if let Some(error) = self.hook.as_ref().and_then(|hook| hook(&range)) {
                return Err(error);
            }
            Ok(self.object[range.start as usize..=range.end as usize].to_vec())
        }
    }

    fn store(object: Vec<u8>) -> Arc<Store> {
        Arc::new(Store { object, fetched: Mutex::new(Vec::new()), hook: None })
    }

    fn store_with(object: Vec<u8>, hook: Hook) -> Arc<Store> {
        Arc::new(Store { object, fetched: Mutex::new(Vec::new()), hook: Some(hook) })
    }

    fn fetched_chunks(store: &Store) -> Vec<u64> {
        store.fetched.lock().unwrap().iter().map(|range| range.start / SEALED_CHUNK).collect()
    }

    fn control(clock: &Arc<Manual>, watchdog: u64) -> Arc<RunControl> {
        RunControl::new(watchdog, Some(Arc::clone(clock) as Arc<dyn ToolClock>))
    }

    #[test]
    fn seeks_and_reads_across_chunk_boundaries_and_the_short_last_chunk() {
        let size = 2 * CHUNK + 1000;
        let plain = plaintext(size);
        let content = content(size, 0);
        let store = store(object(&content, &plain));
        let reader = VersionReader::open(store.clone(), content, None).unwrap();
        let mut cursor = reader.cursor();

        // Across the first boundary, in one read.
        cursor.seek(SeekFrom::Start(CHUNK - 5)).unwrap();
        let mut across = [0u8; 10];
        cursor.read_exact(&mut across).unwrap();
        assert_eq!(&across[..], &plain[(CHUNK - 5) as usize..(CHUNK + 5) as usize]);

        // From the end: the short last chunk, then end of file.
        assert_eq!(cursor.seek(SeekFrom::End(-1000)).unwrap(), 2 * CHUNK);
        let mut tail = Vec::new();
        cursor.read_to_end(&mut tail).unwrap();
        assert_eq!(tail, &plain[(2 * CHUNK) as usize..]);
        assert_eq!(cursor.read(&mut [0u8; 8]).unwrap(), 0, "past the end reads nothing");

        // Backwards from the current position, over the second boundary.
        cursor.seek(SeekFrom::Current(-1010)).unwrap();
        let mut back = [0u8; 20];
        cursor.read_exact(&mut back).unwrap();
        assert_eq!(&back[..], &plain[(2 * CHUNK - 10) as usize..(2 * CHUNK + 10) as usize]);
        assert!(cursor.seek(SeekFrom::End(-(size as i64) - 1)).is_err(), "before the start is refused");

        // A read longer than a chunk, straddling all three.
        assert_eq!(
            reader.read_at(CHUNK - 3, CHUNK + 10).unwrap(),
            &plain[(CHUNK - 3) as usize..(2 * CHUNK + 7) as usize]
        );
        assert_eq!(reader.read_at(size - 4, 100).unwrap(), &plain[(size - 4) as usize..]);
        assert!(reader.read_at(size, 10).unwrap().is_empty());
        assert!(
            reader.read_at(0, 64 * 1024 * 1024 + 1).is_err(),
            "an oversized read is refused before allocating"
        );
    }

    #[test]
    fn keeps_two_chunks_and_the_tail_and_fetches_again_only_what_it_let_go() {
        let size = 4 * CHUNK - 10;
        let plain = plaintext(size);
        let content = content(size, 0);
        let store = store(object(&content, &plain));
        let reader = VersionReader::open(store.clone(), content, None).unwrap();
        reader.read_at(10, 10).unwrap();
        reader.read_at(20, 10).unwrap();
        assert_eq!(fetched_chunks(&store), vec![0], "a second read in the same chunk fetches nothing");
        // The tail (chunk 3), as a zip's directory is read first.
        reader.read_at(size - 22, 22).unwrap();
        reader.read_at(CHUNK, 1).unwrap();
        reader.read_at(2 * CHUNK, 1).unwrap();
        reader.read_at(0, 1).unwrap();
        // The tail again, after three other chunks: still held, not fetched again.
        assert_eq!(reader.read_at(size - 5, 5).unwrap(), &plain[(size - 5) as usize..]);
        assert_eq!(
            fetched_chunks(&store),
            vec![0, 3, 1, 2, 0],
            "chunk 0 had left the cache; the tail never did"
        );
        let state = reader.state.lock().unwrap();
        assert_eq!(state.cache.len(), 2);
        assert!(state.tail.is_some());
    }

    #[test]
    fn a_tampered_chunk_fails_the_read_that_touches_it() {
        let size = 2 * CHUNK + 1000;
        let plain = plaintext(size);
        let content = content(size, 0);
        let mut stored = object(&content, &plain);
        stored[(SEALED_CHUNK + 100) as usize] ^= 1;
        let reader = VersionReader::open(store(stored), content, None).unwrap();
        assert_eq!(reader.read_at(0, 100).unwrap(), &plain[..100], "chunk 0 is intact");
        let error = reader.read_at(CHUNK - 10, 20).unwrap_err();
        assert!(matches!(error, CoreError::Sealed(_)), "{error:?}");
        let mut cursor = reader.cursor();
        cursor.seek(SeekFrom::Start(CHUNK)).unwrap();
        assert!(cursor.read(&mut [0u8; 4]).is_err());
    }

    #[test]
    fn chunks_served_out_of_order_are_refused() {
        // A store (or someone between) answering chunk 0's range with chunk 1's bytes: same length, sealed fine.
        let size = 3 * CHUNK;
        let plain = plaintext(size);
        let content = content(size, 0);
        let stored = object(&content, &plain);
        let mut swapped = stored.clone();
        let (a, b) = (0..SEALED_CHUNK as usize, SEALED_CHUNK as usize..2 * SEALED_CHUNK as usize);
        swapped[a.clone()].copy_from_slice(&stored[b.clone()]);
        swapped[b].copy_from_slice(&stored[a]);
        let reader = VersionReader::open(store(swapped), content, None).unwrap();
        assert!(matches!(reader.read_at(0, 10), Err(CoreError::Sealed(_))));
        assert!(matches!(reader.read_at(CHUNK, 10), Err(CoreError::Sealed(_))));
    }

    #[test]
    fn a_short_answer_from_the_store_is_refused() {
        struct Short(Vec<u8>);
        impl ObjectSource for Short {
            fn fetch(&self, range: ByteRange) -> Result<Vec<u8>, FetchError> {
                Ok(self.0[range.start as usize..range.end as usize].to_vec())
            }
        }
        let content = content(1000, 0);
        let stored = object(&content, &plaintext(1000));
        let reader = VersionReader::open(Arc::new(Short(stored)), content, None).unwrap();
        assert!(reader.read_at(0, 10).is_err());
    }

    #[test]
    fn the_padding_after_the_file_is_fetched_once_with_its_last_chunk() {
        // Just under a chunk with a 2000-byte thumbnail: the bucket runs into a second chunk of padding alone.
        let size = CHUNK - 100;
        let content = content(size, 2000);
        assert_eq!(content_layout(3, size, 2000).unwrap().chunk_count, 2);
        let plain = plaintext(size);
        let store = store(object(&content, &plain));
        let reader = VersionReader::open(store.clone(), content, None).unwrap();
        assert_eq!(reader.read_at(0, 10).unwrap(), &plain[..10]);
        assert_eq!(reader.read_at(size - 10, 10).unwrap(), &plain[(size - 10) as usize..]);
        let fetched = store.fetched.lock().unwrap().clone();
        assert_eq!(fetched.len(), 2, "the file's chunk and the padding, once each");
        assert_eq!(fetched[1].end as usize, store.object.len() - 1, "read to the object's end");
    }

    #[test]
    fn a_padding_chunk_that_fails_fails_the_read() {
        let size = CHUNK - 100;
        let content = content(size, 2000);
        let stored = object(&content, &plaintext(size));
        // The padding chunk's range fails to arrive.
        let failing = store_with(
            stored.clone(),
            Box::new(|range| {
                (range.start == SEALED_CHUNK).then(|| FetchError::Failed { reason: "gone".into() })
            }),
        );
        let reader = VersionReader::open(failing, content.clone(), None).unwrap();
        assert_eq!(reader.read_at(0, 10), Err(input("gone")));
        // The padding chunk damaged.
        let mut damaged = stored;
        damaged[(SEALED_CHUNK + 5) as usize] ^= 1;
        let reader = VersionReader::open(store(damaged), content, None).unwrap();
        assert!(matches!(reader.read_at(0, 10), Err(CoreError::Sealed(_))));
    }

    #[test]
    fn the_last_chunk_carries_file_bytes_padding_and_trailer_together() {
        let size = 1000;
        let content = content(size, 2000);
        let layout = content_layout(3, size, 2000).unwrap();
        assert_eq!(layout.chunk_count, 1);
        let plain = plaintext(size);
        let store = store(object(&content, &plain));
        let reader = VersionReader::open(store.clone(), content, None).unwrap();
        assert_eq!(reader.read_at(0, 5000).unwrap(), plain);
        let fetched = store.fetched.lock().unwrap().clone();
        assert_eq!(fetched, vec![ByteRange { start: 0, end: layout.ciphertext_size - 1 }]);
    }

    #[test]
    fn a_zero_length_file_reads_nothing_and_fetches_nothing() {
        let content = content(0, 0);
        let store = store(object(&content, &[]));
        let reader = VersionReader::open(store.clone(), content, None).unwrap();
        assert_eq!(reader.size(), 0);
        assert!(reader.read_at(0, 10).unwrap().is_empty());
        let mut cursor = reader.cursor();
        assert_eq!(cursor.seek(SeekFrom::End(0)).unwrap(), 0);
        assert_eq!(cursor.read(&mut [0u8; 4]).unwrap(), 0);
        let control = RunControl::new(TOOL_WATCHDOG_MILLIS, None);
        assert_eq!(range_digest(reader, control, 0, 10).unwrap(), Sha256::digest(b"").to_vec());
        assert!(store.fetched.lock().unwrap().is_empty());
    }

    #[test]
    fn a_reader_made_to_seek_without_end_stops_at_four_times_the_object() {
        // Five chunks, the last kept: three others visited in turn past a cache of two, each read a fetch.
        let size = 5 * CHUNK;
        let content = content(size, 0);
        let stored = object(&content, &plaintext(size));
        let limit = stored.len() as u64 * FETCH_FACTOR;
        let store = store(stored);
        let reader = VersionReader::open(store.clone(), content, None).unwrap();
        let failed = (0..100u64).find_map(|i| reader.read_at((i % 3) * CHUNK, 1).err());
        assert_eq!(failed, Some(input(TOOL_FAILED)));
        let total: u64 = store.fetched.lock().unwrap().iter().map(|r| r.end - r.start + 1).sum();
        assert!(total <= limit, "fetched {total} of at most {limit}");
        assert!(total > limit - 2 * SEALED_CHUNK, "it was not refused early: {total}");
    }

    #[test]
    fn after_a_cancel_cached_reads_and_reads_at_the_end_fail_and_the_chunks_go() {
        let size = 2 * CHUNK;
        let plain = plaintext(size);
        let content = content(size, 0);
        let store = store(object(&content, &plain));
        let control = RunControl::new(TOOL_WATCHDOG_MILLIS, None);
        let reader = VersionReader::open(store.clone(), content, Some(Arc::clone(&control))).unwrap();
        assert_eq!(reader.read_at(10, 10).unwrap(), &plain[10..20]);
        assert_eq!(reader.read_at(size - 10, 10).unwrap(), &plain[(size - 10) as usize..]);
        let fetches = store.fetched.lock().unwrap().len();
        control.cancel();
        assert_eq!(reader.read_at(10, 10), Err(input(CANCELLED)), "a chunk in the cache");
        assert_eq!(reader.read_at(size - 10, 10), Err(input(CANCELLED)), "the tail");
        assert_eq!(reader.read_at(size, 10), Err(input(CANCELLED)), "at the end of the file");
        let mut cursor = reader.cursor();
        cursor.seek(SeekFrom::End(0)).unwrap();
        assert!(cursor.read(&mut [0u8; 4]).is_err());
        assert_eq!(store.fetched.lock().unwrap().len(), fetches, "nothing more was fetched");
        let state = reader.state.lock().unwrap();
        assert!(state.cache.is_empty() && state.tail.is_none(), "every opened chunk went");
    }

    #[test]
    fn a_cancel_during_a_fetch_opens_nothing_it_brought() {
        let size = 1000;
        let content = content(size, 0);
        let control = RunControl::new(TOOL_WATCHDOG_MILLIS, None);
        let cancel = Arc::clone(&control);
        let store = store_with(
            object(&content, &plaintext(size)),
            Box::new(move |_| {
                cancel.cancel();
                None
            }),
        );
        let reader = VersionReader::open(store, content, Some(control)).unwrap();
        assert_eq!(reader.read_at(0, 10), Err(input(CANCELLED)));
        assert!(reader.state.lock().unwrap().tail.is_none());
    }

    #[test]
    fn produce_waits_while_the_budget_is_full_until_uploads_release() {
        let budget = ToolBudget::new(100);
        let control = RunControl::new(60_000, None);
        budget.produce(60, Arc::clone(&control)).unwrap();
        budget.produce(60, Arc::clone(&control)).unwrap(); // crosses the line: 120 waiting
        let producer = {
            let (budget, control) = (Arc::clone(&budget), Arc::clone(&control));
            thread::spawn(move || budget.produce(10, control))
        };
        thread::sleep(Duration::from_millis(100));
        assert!(!producer.is_finished(), "a full budget holds the next result back");
        budget.release(10);
        thread::sleep(Duration::from_millis(100));
        assert!(!producer.is_finished(), "110 is still over 100");
        budget.release(60);
        producer.join().unwrap().unwrap();
        assert_eq!(budget.waiting(), 60);
    }

    #[test]
    fn the_budget_outlives_a_run_and_holds_the_next_one_back() {
        let budget = ToolBudget::new(100);
        let first = RunControl::new(60_000, None);
        budget.produce(150, first).unwrap();
        // The first run finished; its result is not uploaded yet. The next run's first result waits.
        let next = RunControl::new(60_000, None);
        let producer = {
            let (budget, next) = (Arc::clone(&budget), Arc::clone(&next));
            thread::spawn(move || budget.produce(1, next))
        };
        thread::sleep(Duration::from_millis(100));
        assert!(!producer.is_finished());
        budget.release(150);
        producer.join().unwrap().unwrap();
        assert_eq!(budget.waiting(), 1);
    }

    #[test]
    fn cancel_wakes_a_waiting_producer_and_stops_every_later_call() {
        let budget = ToolBudget::new(10);
        let control = RunControl::new(60_000, None);
        budget.produce(10, Arc::clone(&control)).unwrap();
        let producer = {
            let (budget, control) = (Arc::clone(&budget), Arc::clone(&control));
            thread::spawn(move || budget.produce(1, control))
        };
        thread::sleep(Duration::from_millis(50));
        control.cancel();
        assert_eq!(producer.join().unwrap(), Err(input(CANCELLED)));
        assert!(control.progress().is_err());
        assert_eq!(budget.waiting(), 10, "what was produced stays until the save path releases it");
        assert!(!control.check_watchdog(), "a cancelled run does not time out as well");
    }

    #[test]
    fn the_watchdog_counts_time_without_progress_and_nothing_else() {
        let clock = Arc::new(Manual::default());
        let control = control(&clock, 30_000);
        // Checked each second, as the apps do.
        let tick = |seconds: u64| {
            for _ in 0..seconds {
                clock.advance(1_000);
                assert!(!control.check_watchdog());
            }
        };
        tick(29);
        control.progress().unwrap();
        tick(29);
        assert!(!control.is_ended(), "progress started the clock over");

        // The app suspended for ten minutes: one check, two seconds of it counted at most.
        control.progress().unwrap();
        clock.advance(600_000);
        assert!(!control.check_watchdog());
        tick(27);

        // A fetch that takes two minutes: waiting on the store is not a hang.
        let size = 1000;
        let content = content(size, 0);
        let slow = Arc::clone(&clock);
        let store = store_with(
            object(&content, &plaintext(size)),
            Box::new(move |_| {
                slow.advance(120_000);
                None
            }),
        );
        let reader = VersionReader::open(store, content, Some(Arc::clone(&control))).unwrap();
        reader.read_at(0, 10).unwrap();
        assert!(!control.check_watchdog());
        assert!(!control.is_ended(), "29 s without progress, the fetch left out");

        clock.advance(1_000);
        assert!(control.check_watchdog(), "30 s: timed out");
        assert!(!control.check_watchdog(), "only once");
        assert!(control.timed_out());
        assert_eq!(control.progress(), Err(input(TOOL_FAILED)));
        assert_eq!(reader.read_at(0, 10), Err(input(TOOL_FAILED)), "the cached chunk too");
    }

    #[test]
    fn a_wait_on_a_full_budget_is_not_a_hang() {
        let clock = Arc::new(Manual::default());
        let control = control(&clock, 30_000);
        let budget = ToolBudget::new(10);
        budget.produce(10, Arc::clone(&control)).unwrap();
        let producer = {
            let (budget, control) = (Arc::clone(&budget), Arc::clone(&control));
            thread::spawn(move || budget.produce(1, control))
        };
        thread::sleep(Duration::from_millis(50));
        for _ in 0..120 {
            clock.advance(1_000);
            assert!(!control.check_watchdog(), "uploads paused for two minutes");
        }
        budget.release(10);
        producer.join().unwrap().unwrap();
    }

    #[test]
    fn range_digest_hashes_the_range_and_stops_when_cancelled() {
        let size = CHUNK + 5000;
        let plain = plaintext(size);
        let content = content(size, 0);
        let store = store(object(&content, &plain));
        let control = RunControl::new(TOOL_WATCHDOG_MILLIS, None);
        let reader = VersionReader::open(store, content, Some(Arc::clone(&control))).unwrap();
        let digest = range_digest(Arc::clone(&reader), Arc::clone(&control), CHUNK - 100, 300).unwrap();
        assert_eq!(digest, Sha256::digest(&plain[(CHUNK - 100) as usize..(CHUNK + 200) as usize]).to_vec());
        control.cancel();
        assert!(range_digest(reader, control, 0, 10).is_err());
    }
}
