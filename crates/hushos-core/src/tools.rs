//! The ground file tools stand on in the phone apps (docs/file-tools-design.md,
//! section 6): a seekable, decrypting reader over one version, and the control
//! a run is held by: cancel, the no-progress watchdog and the budget of
//! produced plaintext waiting for upload.
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
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{
    chunk_decrypt, chunk_length, chunk_range, content_layout, input, ByteRange, Content, CoreError,
    CoreResult,
};

/// Produced plaintext a run may hold waiting for upload before producing
/// pauses (section 3, "Memory").
pub const TOOL_BUDGET_BYTES: u64 = 512 * 1024 * 1024;
/// How long a run may go without reporting progress, waits on the network and
/// on the budget not counted, before it is stopped.
pub const TOOL_WATCHDOG_MILLIS: u64 = 30_000;
/// What a run that timed out, or that a tool refused part-way, tells the person.
pub const TOOL_FAILED: &str = "This file couldn't be processed.";
const CANCELLED: &str = "Cancelled.";
/// The most one [`VersionReader::read_at`] hands back at once: a range bigger
/// than any tool asks for (the zip listing cap) is refused, not allocated.
const READ_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Chunks a reader keeps opened: the one being read and the one before, for a
/// read that straddles them. 16 MiB of plaintext at most.
const CACHED_CHUNKS: usize = 2;

/// The object store, as the app reaches it: the bytes `range.start` to
/// `range.end` inclusive of one version's object, exactly as stored. The app
/// renews an expired address and retries as its downloads do. It is called on
/// the run's own thread and may block it; never call a reader from the main
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

// ---------------------------------------------------------------------------
// Run control
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ended {
    Cancelled,
    TimedOut,
}

#[derive(Debug)]
struct RunState {
    ended: Option<Ended>,
    waiting: u64,
    /* Waits on someone else (a fetch, the budget) in progress: the watchdog's clock stops for them. */
    holds: u32,
    /* Time without progress before the current stretch began, holds left out. */
    idle: Duration,
    since: Instant,
}

impl RunState {
    fn idle_now(&self, now: Instant) -> Duration {
        if self.holds > 0 {
            self.idle
        } else {
            self.idle + now.saturating_duration_since(self.since)
        }
    }

    fn refusal(&self) -> CoreResult<()> {
        match self.ended {
            None => Ok(()),
            Some(Ended::Cancelled) => Err(input(CANCELLED)),
            Some(Ended::TimedOut) => Err(input(TOOL_FAILED)),
        }
    }
}

/// One run's control, shared by the thread doing the work and the app that
/// started it. The work calls [`progress`](Self::progress) as it gets on and
/// [`produce`](Self::produce) before handing a result on; the app calls
/// [`release`](Self::release) once a result is uploaded,
/// [`check_watchdog`](Self::check_watchdog) on a timer, and
/// [`cancel`](Self::cancel). After a cancel or a timeout every call the work
/// makes fails, so it stops at the next one.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
#[derive(Debug)]
pub struct RunControl {
    state: Mutex<RunState>,
    changed: Condvar,
    budget: u64,
    watchdog: Duration,
}

/* A wait on someone else; the watchdog's clock runs again from where it stopped when it ends. */
struct Hold<'a>(&'a RunControl);

impl Drop for Hold<'_> {
    fn drop(&mut self) {
        let mut state = self.0.lock();
        state.holds -= 1;
        if state.holds == 0 {
            state.since = Instant::now();
        }
    }
}

impl RunControl {
    fn lock(&self) -> MutexGuard<'_, RunState> {
        // A panic elsewhere while holding it leaves plain numbers behind: still usable.
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn hold_in(&self, state: &mut RunState) {
        if state.holds == 0 {
            state.idle = state.idle_now(Instant::now());
        }
        state.holds += 1;
    }

    fn hold(&self) -> Hold<'_> {
        let mut state = self.lock();
        self.hold_in(&mut state);
        Hold(self)
    }

    fn end(&self, how: Ended) -> bool {
        let mut state = self.lock();
        if state.ended.is_some() {
            return false;
        }
        state.ended = Some(how);
        state.waiting = 0;
        self.changed.notify_all();
        true
    }
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl RunControl {
    /// `budget_bytes` of produced plaintext may wait for upload; the watchdog
    /// stops a run that reports no progress for `watchdog_millis`. The apps pass
    /// [`tool_budget_bytes`] and [`tool_watchdog_millis`]; tests pass less.
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn new(budget_bytes: u64, watchdog_millis: u64) -> Arc<Self> {
        Arc::new(RunControl {
            state: Mutex::new(RunState {
                ended: None,
                waiting: 0,
                holds: 0,
                idle: Duration::ZERO,
                since: Instant::now(),
            }),
            changed: Condvar::new(),
            budget: budget_bytes.max(1),
            watchdog: Duration::from_millis(watchdog_millis),
        })
    }

    /// Stops the run: a producer waiting on the budget wakes, and every later
    /// call from the work fails with "Cancelled.".
    pub fn cancel(&self) {
        self.end(Ended::Cancelled);
    }

    /// Whether the run has gone the watchdog's time without progress, waits on
    /// the network and the budget left out. The first call that finds it so
    /// ends the run, as a cancel does but failing with [`TOOL_FAILED`], and
    /// answers true; every other call answers false.
    pub fn check_watchdog(&self) -> bool {
        {
            let state = self.lock();
            if state.ended.is_some() || state.idle_now(Instant::now()) < self.watchdog {
                return false;
            }
        }
        self.end(Ended::TimedOut)
    }

    pub fn is_cancelled(&self) -> bool {
        self.lock().ended == Some(Ended::Cancelled)
    }

    pub fn timed_out(&self) -> bool {
        self.lock().ended == Some(Ended::TimedOut)
    }

    /// The work got on: the watchdog starts over. Fails once the run has ended.
    pub fn progress(&self) -> CoreResult<()> {
        let mut state = self.lock();
        state.refusal()?;
        state.idle = Duration::ZERO;
        state.since = Instant::now();
        Ok(())
    }

    /// Fails once the run has ended; otherwise nothing.
    pub fn check(&self) -> CoreResult<()> {
        self.lock().refusal()
    }

    /// Before a result of `bytes` is handed on for upload: waits while the
    /// budget is full, then counts it. The result that crosses the line goes
    /// through; the next waits until uploads [`release`](Self::release) enough.
    /// The wait stops the watchdog's clock (a paused upload is no hang).
    /// Counts as progress.
    pub fn produce(&self, bytes: u64) -> CoreResult<()> {
        let mut state = self.lock();
        state.refusal()?;
        if state.waiting >= self.budget {
            self.hold_in(&mut state);
            while state.ended.is_none() && state.waiting >= self.budget {
                state = self.changed.wait(state).unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            state.holds -= 1;
            if state.holds == 0 {
                state.since = Instant::now();
            }
            state.refusal()?;
        }
        state.waiting = state.waiting.saturating_add(bytes);
        state.idle = Duration::ZERO;
        state.since = Instant::now();
        Ok(())
    }

    /// A result of `bytes` finished uploading (or was dropped): its room goes back.
    pub fn release(&self, bytes: u64) {
        let mut state = self.lock();
        state.waiting = state.waiting.saturating_sub(bytes);
        self.changed.notify_all();
    }

    /// Produced plaintext waiting for upload now.
    pub fn waiting(&self) -> u64 {
        self.lock().waiting
    }
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

struct ReaderState {
    /* Most recently used last; each chunk's plaintext is wiped when it leaves. */
    cache: VecDeque<(u64, Arc<Zeroizing<Vec<u8>>>)>,
}

/// Random access to one version's plaintext. Each chunk a read touches is
/// fetched by its own range, opened, and kept while it is one of the last two
/// read. When the file's last chunk is fetched, the padding chunks after it
/// are fetched too, as the web's reader does, so the ranges never show the
/// store where the file ends. Any chunk that fails to open fails the read.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct VersionReader {
    source: Arc<dyn ObjectSource>,
    content: Content,
    control: Option<Arc<RunControl>>,
    chunk_count: u64,
    file_chunks: u64,
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
            chunk_count: layout.chunk_count,
            file_chunks,
            content,
            state: Mutex::new(ReaderState { cache: VecDeque::new() }),
        }))
    }

    /// A `Read + Seek` view at offset 0. Each cursor keeps its own position;
    /// they share the reader's chunks.
    pub fn cursor(self: &Arc<Self>) -> VersionCursor {
        VersionCursor { reader: Arc::clone(self), position: 0 }
    }

    fn fetch_open(&self, index: u64) -> CoreResult<Zeroizing<Vec<u8>>> {
        if let Some(control) = &self.control {
            control.check()?;
        }
        let range = chunk_range(
            self.content.suite,
            self.content.plaintext_size,
            self.content.thumbnail_bytes,
            index,
        )?;
        let ciphertext = {
            let _hold = self.control.as_ref().map(|control| control.hold());
            self.source.fetch(range.clone()).map_err(|FetchError::Failed { reason }| input(reason))?
        };
        if ciphertext.len() as u64 != range.end - range.start + 1 {
            return Err(CoreError::Sealed("This file could not be decrypted. It may be damaged.".into()));
        }
        Ok(Zeroizing::new(chunk_decrypt(self.content.clone(), index, ciphertext)?))
    }

    fn chunk(&self, index: u64) -> CoreResult<Arc<Zeroizing<Vec<u8>>>> {
        {
            let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(at) = state.cache.iter().position(|(i, _)| *i == index) {
                let entry = state.cache.remove(at).expect("present");
                let bytes = Arc::clone(&entry.1);
                state.cache.push_back(entry);
                return Ok(bytes);
            }
        }
        let plaintext = self.fetch_open(index)?;
        if plaintext.len() as u64 != chunk_length(self.content.plaintext_size, index) {
            return Err(CoreError::Sealed("This file could not be decrypted. It may be damaged.".into()));
        }
        // The padding after the file, each time its last chunk is fetched: opened, giving nothing.
        if index + 1 == self.file_chunks {
            for padding in self.file_chunks..self.chunk_count {
                if !self.fetch_open(padding)?.is_empty() {
                    return Err(CoreError::Sealed(
                        "This file could not be decrypted. It may be damaged.".into(),
                    ));
                }
            }
        }
        let plaintext = Arc::new(plaintext);
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.cache.push_back((index, Arc::clone(&plaintext)));
        while state.cache.len() > CACHED_CHUNKS {
            state.cache.pop_front();
        }
        Ok(plaintext)
    }

    /// Fills `out` from `offset`, as far as the file goes; how many bytes it wrote.
    pub fn read_into(&self, offset: u64, out: &mut [u8]) -> CoreResult<usize> {
        let size = self.content.plaintext_size;
        if offset >= size || out.is_empty() {
            return Ok(0);
        }
        let end = size.min(offset.saturating_add(out.len() as u64));
        let chunk_bytes = content_layout(self.content.suite, size, self.content.thumbnail_bytes)?.chunk_bytes;
        let mut at = offset;
        while at < end {
            let index = at / chunk_bytes;
            let base = index * chunk_bytes;
            let plaintext = self.chunk(index)?;
            let from = (at - base) as usize;
            let to = ((end - base) as usize).min(plaintext.len());
            if to <= from {
                return Err(CoreError::Sealed("This file could not be decrypted. It may be damaged.".into()));
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
    /// object `source` fetches. With a `control`, every fetch first checks the
    /// run has not ended, and the watchdog's clock stops while it waits.
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

    struct Store {
        object: Vec<u8>,
        fetched: Mutex<Vec<ByteRange>>,
        delay: Duration,
    }

    impl ObjectSource for Store {
        fn fetch(&self, range: ByteRange) -> Result<Vec<u8>, FetchError> {
            self.fetched.lock().unwrap().push(range.clone());
            thread::sleep(self.delay);
            Ok(self.object[range.start as usize..=range.end as usize].to_vec())
        }
    }

    fn store(object: Vec<u8>) -> Arc<Store> {
        Arc::new(Store { object, fetched: Mutex::new(Vec::new()), delay: Duration::ZERO })
    }

    fn fetched_chunks(store: &Store) -> Vec<u64> {
        store.fetched.lock().unwrap().iter().map(|range| range.start / (CHUNK + 16)).collect()
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
    fn keeps_two_chunks_and_fetches_again_what_it_let_go() {
        let size = 3 * CHUNK;
        let plain = plaintext(size);
        let content = content(size, 0);
        let store = store(object(&content, &plain));
        let reader = VersionReader::open(store.clone(), content, None).unwrap();
        reader.read_at(10, 10).unwrap();
        reader.read_at(20, 10).unwrap();
        assert_eq!(fetched_chunks(&store), vec![0], "a second read in the same chunk fetches nothing");
        reader.read_at(CHUNK, 1).unwrap();
        reader.read_at(2 * CHUNK, 1).unwrap();
        reader.read_at(0, 1).unwrap();
        assert_eq!(fetched_chunks(&store), vec![0, 1, 2, 0], "chunk 0 had left the cache");
        assert_eq!(reader.state.lock().unwrap().cache.len(), 2);
    }

    #[test]
    fn a_tampered_chunk_fails_the_read_that_touches_it() {
        let size = 2 * CHUNK + 1000;
        let plain = plaintext(size);
        let content = content(size, 0);
        let mut stored = object(&content, &plain);
        stored[(CHUNK + 16 + 100) as usize] ^= 1;
        let reader = VersionReader::open(store(stored), content, None).unwrap();
        assert_eq!(reader.read_at(0, 100).unwrap(), &plain[..100], "chunk 0 is intact");
        let error = reader.read_at(CHUNK - 10, 20).unwrap_err();
        assert!(matches!(error, CoreError::Sealed(_)), "{error:?}");
        let mut cursor = reader.cursor();
        cursor.seek(SeekFrom::Start(CHUNK)).unwrap();
        assert!(cursor.read(&mut [0u8; 4]).is_err());
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
    fn the_padding_after_the_file_is_fetched_with_its_last_chunk() {
        // Just under a chunk with a 2000-byte thumbnail: the bucket runs into a second chunk of padding alone.
        let size = CHUNK - 100;
        let content = content(size, 2000);
        assert_eq!(content_layout(3, size, 2000).unwrap().chunk_count, 2);
        let plain = plaintext(size);
        let store = store(object(&content, &plain));
        let reader = VersionReader::open(store.clone(), content, None).unwrap();
        assert_eq!(reader.read_at(0, 10).unwrap(), &plain[..10]);
        let fetched = store.fetched.lock().unwrap().clone();
        assert_eq!(fetched.len(), 2);
        assert_eq!(fetched[1].end as usize, store.object.len() - 1, "read to the object's end");
    }

    #[test]
    fn produce_waits_while_the_budget_is_full_until_uploads_release() {
        let control = RunControl::new(100, 60_000);
        control.produce(60).unwrap();
        control.produce(60).unwrap(); // crosses the line: 120 waiting
        let producer = {
            let control = Arc::clone(&control);
            thread::spawn(move || control.produce(10))
        };
        thread::sleep(Duration::from_millis(100));
        assert!(!producer.is_finished(), "a full budget holds the next result back");
        control.release(10);
        thread::sleep(Duration::from_millis(50));
        assert!(!producer.is_finished(), "110 is still over 100");
        control.release(60);
        producer.join().unwrap().unwrap();
        assert_eq!(control.waiting(), 60);
    }

    #[test]
    fn cancel_wakes_a_waiting_producer_and_stops_every_later_call() {
        let control = RunControl::new(10, 60_000);
        control.produce(10).unwrap();
        let producer = {
            let control = Arc::clone(&control);
            thread::spawn(move || control.produce(1))
        };
        thread::sleep(Duration::from_millis(50));
        control.cancel();
        assert_eq!(producer.join().unwrap(), Err(input(CANCELLED)));
        assert!(control.progress().is_err());
        assert_eq!(control.waiting(), 0, "nothing is counted for a run that ended");
        assert!(!control.check_watchdog(), "a cancelled run does not time out as well");

        // A reader under the control fetches nothing more.
        let content = content(1000, 0);
        let store = store(object(&content, &plaintext(1000)));
        let reader = VersionReader::open(store.clone(), content, Some(control)).unwrap();
        assert!(reader.read_at(0, 1).is_err());
        assert!(store.fetched.lock().unwrap().is_empty());
    }

    #[test]
    fn the_watchdog_ends_a_run_without_progress_but_not_one_waiting_on_the_store() {
        let control = RunControl::new(TOOL_BUDGET_BYTES, 150);
        thread::sleep(Duration::from_millis(100));
        assert!(!control.check_watchdog());
        control.progress().unwrap();
        thread::sleep(Duration::from_millis(100));
        assert!(!control.check_watchdog(), "progress started the clock over");

        // A slow fetch, three times the watchdog: the clock stops while it waits.
        let size = 1000;
        let content = content(size, 0);
        let store = Arc::new(Store {
            object: object(&content, &plaintext(size)),
            fetched: Mutex::new(Vec::new()),
            delay: Duration::from_millis(450),
        });
        control.progress().unwrap();
        let reading = {
            let reader = VersionReader::open(store, content, Some(Arc::clone(&control))).unwrap();
            thread::spawn(move || reader.read_at(0, 10))
        };
        thread::sleep(Duration::from_millis(300));
        assert!(!control.check_watchdog(), "waiting on the store is not a hang");
        reading.join().unwrap().unwrap();

        thread::sleep(Duration::from_millis(200));
        assert!(control.check_watchdog(), "no progress since: timed out");
        assert!(!control.check_watchdog(), "only once");
        assert!(control.timed_out());
        assert_eq!(control.progress(), Err(input(TOOL_FAILED)));
    }

    #[test]
    fn range_digest_hashes_the_range_and_stops_when_cancelled() {
        let size = CHUNK + 5000;
        let plain = plaintext(size);
        let content = content(size, 0);
        let store = store(object(&content, &plain));
        let control = RunControl::new(TOOL_BUDGET_BYTES, 60_000);
        let reader = VersionReader::open(store, content, Some(Arc::clone(&control))).unwrap();
        let digest = range_digest(Arc::clone(&reader), Arc::clone(&control), CHUNK - 100, 300).unwrap();
        assert_eq!(digest, Sha256::digest(&plain[(CHUNK - 100) as usize..(CHUNK + 200) as usize]).to_vec());
        control.cancel();
        assert!(range_digest(reader, control, 0, 10).is_err());
    }
}
