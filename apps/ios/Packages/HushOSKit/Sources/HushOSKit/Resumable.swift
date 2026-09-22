import Foundation
import Network

/*
 * Transfers that survive a bad connection, as the web's do. A piece (a chunk
 * down, a part up) that fails because of the network is tried again after a
 * jittered backoff; while the device has no network at all it waits for one
 * and the wait does not count as a failed try. An answer a retry cannot
 * change (a 4xx other than 403, 408 and 429) fails at once; a 403 is an
 * expired address, fetched fresh before the next try.
 *
 * A download keeps its `.part` file between tries and between launches: the
 * next attempt continues from the last whole chunk rather than from zero.
 */
public enum Resumable {
    public static let maxAttempts = 8
    static let offlineLimit: Double = 600

    /* 1 s, 2 s, 4 s… up to a minute, each somewhere in its upper half so retries from many pieces do not land together. */
    public static func delay(attempt: Int, random: Double = Double.random(in: 0 ..< 1)) -> Double {
        let ceiling = min(60, pow(2, Double(max(0, min(attempt - 1, 6)))))
        return ceiling / 2 + ceiling / 2 * random
    }

    public static func retryable(_ error: Error) -> Bool {
        switch error {
        case DriveAPIError.transport: return true
        case DriveAPIError.server(let status, _): return status == 0 || status == 403 || status == 408 || status == 429 || status >= 500
        default: return false
        }
    }

    /* Whether the device has a network path right now, from one monitor shared by every transfer. */
    public static var online: Bool { NetworkWatch.shared.online }

    /*
     * Runs `step` until it succeeds, retrying what the network broke. `online` and
     * `sleep` are parameters so a test can play out an outage without waiting.
     */
    public static func run<T>(
        isolation: isolated (any Actor)? = #isolation,
        online: () -> Bool = { Resumable.online },
        sleep: (Double) async throws -> Void = { try await Task.sleep(for: .seconds($0)) },
        onExpired: () async throws -> Void = {},
        _ step: () async throws -> T
    ) async throws -> T {
        var attempt = 0
        var offlineFor: Double = 0
        while true {
            do {
                return try await step()
            } catch {
                if error is CancellationError || !retryable(error) { throw error }
                if case DriveAPIError.server(403, _) = error { try await onExpired() }
                if !online() {
                    // No network: wait for one without spending a try, up to a limit.
                    if offlineFor >= offlineLimit { throw error }
                    try await sleep(1); offlineFor += 1
                    continue
                }
                attempt += 1
                if attempt >= maxAttempts { throw error }
                try await sleep(delay(attempt: attempt))
            }
        }
    }

    /*
     * Fetches chunks `0 ..< count` into `destination`, each `chunkBytes` of plaintext but
     * the last, continuing a `.part` left by an earlier try from its last whole chunk.
     * `fetch` returns one chunk's plaintext; it is retried through `run`.
     */
    public static func download(
        isolation: isolated (any Actor)? = #isolation,
        to destination: URL,
        count: UInt64,
        chunkBytes: UInt64,
        online: () -> Bool = { Resumable.online },
        sleep: (Double) async throws -> Void = { try await Task.sleep(for: .seconds($0)) },
        onExpired: () async throws -> Void = {},
        progress: (Double) -> Void = { _ in },
        fetch: (UInt64) async throws -> Data
    ) async throws {
        let files = FileManager.default
        try files.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        let partial = destination.appendingPathExtension("part")
        if !files.fileExists(atPath: partial.path) { files.createFile(atPath: partial.path, contents: nil) }
        let existing = (try? files.attributesOfItem(atPath: partial.path)[.size] as? UInt64) ?? 0
        let kept = min(existing / chunkBytes, count)
        let handle = try FileHandle(forWritingTo: partial)
        do {
            // Whatever came after the last whole chunk may be cut short: drop it and fetch that chunk again.
            try handle.truncate(atOffset: kept * chunkBytes)
            try handle.seekToEnd()
            var index = kept
            while index < count {
                try Task.checkCancellation()
                let chunk = index
                let plaintext = try await run(online: online, sleep: sleep, onExpired: onExpired) { try await fetch(chunk) }
                try handle.write(contentsOf: plaintext)
                progress(Double(index + 1) / Double(count))
                index += 1
            }
            try handle.close()
        } catch {
            try? handle.close()
            throw error
        }
        if files.fileExists(atPath: destination.path) { try files.removeItem(at: destination) }
        try files.moveItem(at: partial, to: destination)
    }
}

/* One path monitor for the process, read from any thread; the app's offline line and every transfer ask it. */
public final class NetworkWatch: @unchecked Sendable {
    public static let shared = NetworkWatch()
    private let monitor = NWPathMonitor()
    private let lock = NSLock()
    private var satisfied = true
    private var observers: [UUID: @Sendable (Bool) -> Void] = [:]

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let online = path.status == .satisfied
            let handlers = self.lock.withLock { () -> [@Sendable (Bool) -> Void] in
                self.satisfied = online
                return Array(self.observers.values)
            }
            for handler in handlers { handler(online) }
        }
        monitor.start(queue: DispatchQueue(label: "com.hushos.network"))
    }

    public var online: Bool { lock.withLock { satisfied } }

    /* Calls `handler` on every change of path, from the monitor's queue; returns a token for `stop`. */
    @discardableResult
    public func observe(_ handler: @escaping @Sendable (Bool) -> Void) -> UUID {
        let token = UUID()
        lock.withLock { observers[token] = handler }
        return token
    }

    public func stop(_ token: UUID) { _ = lock.withLock { observers.removeValue(forKey: token) } }
}
