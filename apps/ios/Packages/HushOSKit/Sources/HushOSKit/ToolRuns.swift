import Foundation
import HushOSCore

/*
 * The harness file tools run in (docs/file-tools-design.md, sections 2, 3 and 6), as the web's
 * workers do: one run at a time, a run started meanwhile waiting behind it; cancel; a watchdog
 * that stops a run reporting no progress for 30 seconds; and the 512 MiB budget of produced
 * plaintext waiting for upload, one for the process (`ToolRuns.budget`). The core holds the
 * run's control (RunControl), the seekable decrypting reader (VersionReader) and the budget;
 * this holds the order and the clock.
 *
 * Each run's work is the core's, blocking, so it runs on a thread of its own, never the
 * cooperative pool. A thread cannot be killed: cancel and the watchdog end the run for the
 * caller at once and fail the work's next read, produce or progress call, which stops it; a
 * fetch in flight is cancelled (StoreSource). The next run starts only once that thread has
 * really returned, so two runs never hold memory together; a tool that loops without calling
 * the core holds the queue until it returns.
 */

public enum ToolRunState: Sendable, Equatable {
    case waiting(behind: String)
    case running
    case done
    case failed(String)
    case cancelled
}

public struct ToolCancelled: Error, Equatable {}

/* A run that failed, in the person's words: the watchdog, or a tool that could not read the file. */
public struct ToolFailed: Error, Equatable, LocalizedError {
    public let message: String
    public init(_ message: String = toolFailedMessage()) { self.message = message }
    public var errorDescription: String? { message }
}

/* Settles once, from whichever comes first: the work, a cancel, the watchdog. */
private final class Outcome<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<T, Error>?
    private var waiter: CheckedContinuation<Result<T, Error>, Never>?

    func finish(_ value: Result<T, Error>) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = value
        let waiter = self.waiter
        self.waiter = nil
        lock.unlock()
        waiter?.resume(returning: value)
    }

    func value() async -> Result<T, Error> {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let result {
                lock.unlock()
                continuation.resume(returning: result)
            } else {
                waiter = continuation
                lock.unlock()
            }
        }
    }
}

/* What ends each live run, by id, reachable without the actor: a sign-out calls it from anywhere. */
private final class LiveRuns: @unchecked Sendable {
    private let lock = NSLock()
    private var ends: [UUID: @Sendable () -> Void] = [:]

    func track(_ id: UUID, _ end: @escaping @Sendable () -> Void) {
        lock.lock(); ends[id] = end; lock.unlock()
    }

    func untrack(_ id: UUID) {
        lock.lock(); ends[id] = nil; lock.unlock()
    }

    func endAll() {
        lock.lock(); let all = Array(ends.values); lock.unlock()
        for end in all { end() }
    }
}

public actor ToolRuns {
    public static let shared = ToolRuns()

    /*
     * Produced plaintext waiting for upload, for the whole process: a finished run's results
     * still count until the save path releases each one (uploaded or dropped). Tools produce
     * into it with their run's control.
     */
    public static let budget = ToolBudget(limitBytes: toolBudgetBytes())

    /* The watchdogs' own queue: their timers never wait on the cooperative pool. */
    private static let watchdogQueue = DispatchQueue(label: "com.hushos.tool-watchdog")

    private struct Waiter {
        let id: UUID
        let label: String
        let state: @Sendable (ToolRunState) -> Void
        let continuation: CheckedContinuation<Void, Error>
    }

    private var current: String?
    private var waiters: [Waiter] = []
    private nonisolated let live = LiveRuns()

    public init() {}

    /* Sign-out and account removal: every run ends, running or waiting, and none starts. */
    public nonisolated func cancelAll() {
        live.endAll()
    }

    /*
     * Runs `work` when no other run is going, on a thread of its own, under a fresh RunControl:
     * the work passes it to the core's reader and tools. `label` names the run to one waiting
     * behind it ("Extracting Photos.zip"). Throws ToolCancelled when the calling task is
     * cancelled (waiting or running) or cancelAll ends it, ToolFailed when the watchdog fires or
     * the work throws. `clock` is for tests; the apps measure on the system's clock.
     */
    public func run<T: Sendable>(
        _ label: String,
        watchdog: Duration = .milliseconds(Int(toolWatchdogMillis())),
        poll: Duration = .seconds(1),
        clock: ToolClock? = nil,
        state: @escaping @Sendable (ToolRunState) -> Void = { _ in },
        work: @escaping @Sendable (RunControl) throws -> T
    ) async throws -> T {
        let id = UUID()
        let millis = UInt64(watchdog.components.seconds) * 1000 + UInt64(watchdog.components.attoseconds / 1_000_000_000_000_000)
        let control = RunControl(watchdogMillis: millis, clock: clock)
        let outcome = Outcome<T>()
        // One cancellation for the run's whole life, in place before anything is announced: a
        // sign-out reaches it waiting, being let in, or running. The control is the latch.
        live.track(id) {
            control.cancel()
            outcome.finish(.failure(ToolCancelled()))
            Task { await self.drop(id) }
        }
        do {
            try await enter(id, label, state: state)
        } catch {
            live.untrack(id)
            throw error
        }
        // The handler is in place before the thread starts: a task cancelled already, or a run
        // ended while it waited or was being let in, ends here and never starts its work.
        let result = await withTaskCancellationHandler {
            // Checked before announcing it, so a run cancelled while it waited is never called running,
            // and after, so a sign-out from the .running callback starts nothing.
            let stop = { [live] () -> Result<T, Error> in
                live.untrack(id)
                self.leave()
                return .failure(ToolCancelled())
            }
            if Task.isCancelled || control.isEnded() { return stop() }
            state(.running)
            if Task.isCancelled || control.isEnded() { return stop() }
            // On a dispatch timer of its own: a watchdog on the cooperative pool waits behind whatever else runs there.
            let watcher = DispatchSource.makeTimerSource(queue: Self.watchdogQueue)
            let interval = DispatchTimeInterval.milliseconds(Int(poll.components.seconds) * 1000 + Int(poll.components.attoseconds / 1_000_000_000_000_000))
            watcher.schedule(deadline: .now() + interval, repeating: interval)
            watcher.setEventHandler {
                if control.checkWatchdog() { outcome.finish(.failure(ToolFailed())) }
            }
            watcher.resume()
            let live = self.live
            let thread = Thread {
                let result = Result { try work(control) }.mapError { error -> Error in
                    if control.isCancelled() { return ToolCancelled() }
                    if control.timedOut() { return ToolFailed() }
                    return error as? ToolFailed ?? ToolFailed()
                }
                // Every reader the work made lets go of its chunks and its key now, held or not,
                // before anyone is told the run is over.
                control.finish()
                outcome.finish(result)
                watcher.cancel()
                live.untrack(id)
                Task { await self.leave() }
            }
            // The core's parsers recurse more than a secondary thread's default 512 KiB allows.
            thread.stackSize = 8 << 20
            thread.start()
            return await outcome.value()
        } onCancel: {
            control.cancel()
            outcome.finish(.failure(ToolCancelled()))
        }
        switch result {
        case .success(let value):
            state(.done)
            return value
        case .failure(let error):
            control.cancel()
            state(error is ToolCancelled ? .cancelled : .failed((error as? ToolFailed)?.message ?? toolFailedMessage()))
            throw error
        }
    }

    /* The run going now, by its label; nil when none is. */
    public var running: String? { current }

    private func enter(_ id: UUID, _ label: String, state: @escaping @Sendable (ToolRunState) -> Void) async throws {
        guard let ahead = current else {
            current = label
            return
        }
        state(.waiting(behind: ahead))
        do {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    waiters.append(Waiter(id: id, label: label, state: state, continuation: continuation))
                }
            } onCancel: {
                // Runs on the actor after the append above: the waiter is found, unless leave() already let it in.
                Task { await self.drop(id) }
            }
        } catch {
            state(.cancelled)
            throw ToolCancelled()
        }
    }

    private func drop(_ id: UUID) {
        guard let at = waiters.firstIndex(where: { $0.id == id }) else { return }
        waiters.remove(at: at).continuation.resume(throwing: ToolCancelled())
    }

    private func leave() {
        guard !waiters.isEmpty else {
            current = nil
            return
        }
        let next = waiters.removeFirst()
        current = next.label
        for waiter in waiters { waiter.state(.waiting(behind: next.label)) }
        next.continuation.resume()
    }
}

/*
 * The object store as the core's VersionReader reaches it. The core calls `fetch` on the run's
 * own thread (ToolRuns), which may block: the async fetch runs on a task of its own meanwhile,
 * and is cancelled as soon as the run ends, padding or not. Padding a run still owed when it
 * ended comes back through `drainLater`, for PaddingDrains to fetch in the background. Never hand
 * this to a reader used from the main thread or a cooperative one.
 */
public final class StoreSource: ObjectSource, @unchecked Sendable {
    private let control: RunControl?
    private let fetchRange: @Sendable (ByteRange) async throws -> Data
    private let drain: @Sendable ([ByteRange]) -> Void

    public init(
        control: RunControl? = nil,
        drainLater: @escaping @Sendable ([ByteRange]) -> Void = { _ in },
        _ fetch: @escaping @Sendable (ByteRange) async throws -> Data
    ) {
        self.control = control
        drain = drainLater
        fetchRange = fetch
    }

    public func fetch(range: ByteRange, drain: Bool) throws -> Data {
        let box = FetchBox()
        let done = DispatchSemaphore(value: 0)
        let fetchRange = self.fetchRange
        let task = Task.detached {
            do { box.result = .success(try await fetchRange(range)) } catch { box.result = .failure(error) }
            done.signal()
        }
        // In slices, so a run that ends meanwhile stops waiting (and fetching) within a twentieth of a second.
        while done.wait(timeout: .now() + .milliseconds(50)) == .timedOut {
            if control?.isEnded() == true {
                task.cancel()
                throw FetchError.Failed(reason: "Cancelled.")
            }
        }
        switch box.result! {
        case .success(let data): return data
        case .failure(let error): throw FetchError.Failed(reason: error.localizedDescription)
        }
    }

    public func drainLater(ranges: [ByteRange]) {
        drain(ranges)
    }
}

/*
 * The padding a cancelled run still owed (docs/file-tools-design.md, "Padding"): fetched in the
 * background, ciphertext only and thrown away, with no key and no plaintext, so the store still
 * sees the object read to its end, while the run's slot is already free for the next.
 * - One drain at a time for the process; at most `maxWaiting` wait behind it (more are dropped).
 * - Each range tried once (an expired address renewed once).
 * - A drain gives up after `maxBytes` of padding (`meteredMaxBytes` on a metered path) or
 *   `maxDuration`, whichever comes first; the deadline cancels a request still in flight.
 * - `cancelAll` (sign-out) drops every waiting drain and stops the current one at once,
 *   its request cancelled: the store then sees where that file ends.
 * The defaults cover the padding of any file well past the 4 GiB extraction ceiling (Padmé's
 * bucket adds at most about 12%) on an ordinary connection.
 */
public actor PaddingDrains {
    public static let shared = PaddingDrains()

    public struct Job: Sendable {
        let ranges: [ByteRange]
        let metered: Bool
        let generation: UInt64
        let fetch: @Sendable (ByteRange) async throws -> Void
    }

    /* What a sign-out reaches without waiting on the actor: the generation, and the request in flight. */
    private final class Live: @unchecked Sendable {
        private let lock = NSLock()
        private var generation: UInt64 = 0
        private var current: Task<Void, Never>?
        var now: UInt64 { lock.withLock { generation } }
        func set(_ task: Task<Void, Never>?) { lock.withLock { current = task } }
        func bump() { lock.withLock { generation += 1; current?.cancel() } }
    }

    private let maxBytes: UInt64
    private let meteredMaxBytes: UInt64
    private let maxDuration: Duration
    private let maxWaiting: Int
    private nonisolated let live = Live()
    private var waiting: [Job] = []
    private var draining = false

    public init(maxBytes: UInt64 = 1 << 30, meteredMaxBytes: UInt64 = 64 << 20, maxDuration: Duration = .seconds(600), maxWaiting: Int = 4) {
        self.maxBytes = maxBytes
        self.meteredMaxBytes = meteredMaxBytes
        self.maxDuration = maxDuration
        self.maxWaiting = maxWaiting
    }

    public nonisolated func enqueue(_ ranges: [ByteRange], metered: Bool = false, fetch: @escaping @Sendable (ByteRange) async throws -> Void) {
        let job = Job(ranges: ranges, metered: metered, generation: live.now, fetch: fetch)
        Task { await self.add(job) }
    }

    /* Sign-out: nothing of the old account's goes on draining. */
    public nonisolated func cancelAll() {
        live.bump()
        Task { await self.dropWaiting() }
    }

    /* Whether nothing is draining or waiting: for tests. */
    public var idle: Bool { !draining && waiting.isEmpty }

    private func dropWaiting() { waiting.removeAll() }

    private func add(_ job: Job) {
        guard job.generation == live.now, waiting.count < maxWaiting else { return }
        waiting.append(job)
        guard !draining else { return }
        draining = true
        Task { await self.drainAll() }
    }

    private func drainAll() async {
        while !waiting.isEmpty {
            let job = waiting.removeFirst()
            let deadline = ContinuousClock.now + maxDuration
            let cap = job.metered ? meteredMaxBytes : maxBytes
            var bytes: UInt64 = 0
            for range in job.ranges {
                if job.generation != live.now || bytes >= cap || ContinuousClock.now >= deadline { break }
                bytes += range.end - range.start + 1
                let fetch = Task { _ = try? await job.fetch(range) }
                live.set(fetch)
                // A cancelAll between the check and the set above: the request goes at once.
                if job.generation != live.now { fetch.cancel() }
                let alarm = Task {
                    try? await Task.sleep(until: deadline, clock: .continuous)
                    fetch.cancel()
                }
                await fetch.value
                alarm.cancel()
                live.set(nil)
            }
        }
        draining = false
    }
}

/* Written by the fetch's task before the semaphore is signalled, read after the wait: never at once. */
private final class FetchBox: @unchecked Sendable {
    var result: Result<Data, Error>?
}

/* Where a reader's ranges come from: the version's presigned address, renewed when it expires. */
private actor ObjectAddress {
    private var url: URL
    private let renew: @Sendable () async throws -> URL
    init(_ url: URL, renew: @escaping @Sendable () async throws -> URL) { self.url = url; self.renew = renew }
    var current: URL { url }
    func refresh() async throws { url = try await renew() }
}

public enum ToolReaders {
    /*
     * A reader over `opened` for a run under `control`: each chunk's range fetched through `api`,
     * retried as downloads are, the address renewed when it expires, and given up as soon as the
     * run ends (a wait between tries, an offline wait, or a request in flight).
     */
    public static func reader(api: DriveAPI, opened: OpenedVersion, workspaceId: String, control: RunControl) async throws -> VersionReader {
        let versionId = opened.versionId
        let fresh: @Sendable () async throws -> URL = {
            guard let url = URL(string: try await api.versionURL(versionId, workspaceId: workspaceId).url) else {
                throw DriveAPIError.server(500, "Bad object URL")
            }
            return url
        }
        let address = ObjectAddress(try await fresh(), renew: fresh)
        // Padding owed when the run ended: once each, an expired address renewed once, in the background.
        let drainOnce: @Sendable (ByteRange) async throws -> Void = { range in
            do {
                _ = try await api.range(await address.current, range)
            } catch DriveAPIError.server(403, _) {
                try await address.refresh()
                _ = try await api.range(await address.current, range)
            }
        }
        let source = StoreSource(control: control, drainLater: { ranges in
            PaddingDrains.shared.enqueue(ranges, metered: NetworkWatch.shared.metered, fetch: drainOnce)
        }) { range in
            try await Resumable.run(onExpired: { try await address.refresh() }) {
                try await api.range(await address.current, range)
            }
        }
        return try VersionReader(source: source, content: opened.content, control: control)
    }
}

extension Vault {
    /* A seekable, decrypting reader over a file's version for a tool run under `control` (ToolReaders.reader). */
    public func toolReader(_ item: Opened, version: VersionListView? = nil, control: RunControl) async throws -> VersionReader {
        try await ToolReaders.reader(api: api, opened: try openVersion(item, version: version), workspaceId: item.node.workspaceId, control: control)
    }
}
