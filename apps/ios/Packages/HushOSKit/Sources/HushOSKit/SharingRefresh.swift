import Foundation

/*
 * When what this account shares (`/shares/mine`: By me and the rows' who-can-open lines) is
 * asked again. The server leaves trashed items out of it, and a change in the feed can't say
 * it put an item back, so: after every restore (one row, many, a trash's Undo), at once, and
 * after a sync that applied any change in this account's own drive. Both apps sync after
 * nearly every write, so that second path is held to one load per `interval` (a 200-photo
 * upload is not 200 requests): a change inside the interval waits for one load at its end.
 * One load at a time; a request made while a load runs gets one more load after it (the
 * running one may have read the server before the change), however many asked meanwhile, and
 * any load that begins answers every change waiting for the interval to end.
 * The decisions live here so the tests can reach them; the store only loads and applies.
 */
@MainActor public final class SharingRefresh {
    /* Asks the server and applies what it said. */
    public typealias Load = @MainActor () async -> Void
    /* Seconds on a clock that only goes forward. */
    public typealias Now = @MainActor () -> TimeInterval
    /* Waits that many seconds (returns early when cancelled). */
    public typealias Wait = @MainActor (TimeInterval) async -> Void

    private let load: Load
    private let interval: TimeInterval
    private let clock: Now
    private let wait: Wait
    private var running: Task<Void, Never>?
    private var wanted = false
    private var lastBegan: TimeInterval?
    /* The load a change inside the interval waits for; internal so the tests can wait for it. */
    var trailing: Task<Void, Never>?

    public init(interval: TimeInterval = 10,
                clock: @escaping Now = { ProcessInfo.processInfo.systemUptime },
                wait: @escaping Wait = { seconds in try? await Task.sleep(for: .seconds(seconds)) },
                load: @escaping Load) {
        self.interval = interval
        self.clock = clock
        self.wait = wait
        self.load = load
    }

    /*
     * After a sync: `touched` is what it applied of this account's own drive (nil when the
     * server wasn't asked), `restored` that the sync follows a restore, which always loads now.
     */
    public func afterSync(touched: Set<String>?, restored: Bool) async {
        if restored { await now(); return }
        guard !(touched ?? []).isEmpty else { return }
        let since = lastBegan.map { clock() - $0 } ?? .infinity
        if since >= interval { await now(); return }
        // Inside the interval: one load at its end, for this change and any that follow it.
        guard trailing == nil else { return }
        trailing = Task { @MainActor in
            // Measured when the wait starts, so a late start never pushes the load past the interval's end.
            await self.wait(max(0, (self.lastBegan ?? 0) + self.interval - self.clock()))
            guard !Task.isCancelled else { return }
            self.trailing = nil
            await self.now()
        }
    }

    /* Loads now, or once more after the load under way; returns when a load begun after this call is done. */
    public func now() async {
        wanted = true
        if let running { await running.value; return }
        let task = Task { @MainActor in
            while self.wanted {
                self.wanted = false
                // Begun after every change asked so far: the one waiting for the interval is answered too.
                self.trailing?.cancel()
                self.trailing = nil
                self.lastBegan = self.clock()
                await self.load()
            }
            self.running = nil
        }
        running = task
        await task.value
    }

    /*
     * What By me lists, as the server answered: each share with its role, each link, by id. By me
     * reads its list again whenever this changes, even when the rows' marks stay the same (a link
     * replaced by another: the marks count links).
     */
    public nonisolated static func listing(shares: [(id: String, role: String)], links: [String]) -> Set<String> {
        Set(shares.map { "share \($0.id) \($0.role)" }).union(links.map { "link \($0)" })
    }
}
