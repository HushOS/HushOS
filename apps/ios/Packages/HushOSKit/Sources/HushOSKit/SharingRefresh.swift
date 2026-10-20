import Foundation

/*
 * When what this account shares (`/shares/mine`: By me and the rows' who-can-open lines) is
 * asked again. The server leaves trashed items out of it, and a change in the feed can't say
 * it put an item back, so: after every restore (one row, many, a trash's Undo), and after a
 * sync that applied any change in this account's own drive while the answer is in use, once
 * per sync. One load at a time; a request made while a load runs gets one more load after it
 * (the running one may have read the server before the change), however many asked meanwhile.
 * The decisions live here so the tests can reach them; the store only loads and applies.
 */
@MainActor public final class SharingRefresh {
    /* Asks the server and applies what it said. */
    public typealias Load = @MainActor () async -> Void

    private let load: Load
    private var running: Task<Void, Never>?
    private var wanted = false

    public init(load: @escaping Load) { self.load = load }

    /*
     * After a sync: `touched` is what it applied of this account's own drive (nil when the
     * server wasn't asked), `restored` that the sync follows a restore, which always counts.
     */
    public func afterSync(touched: Set<String>?, restored: Bool, inUse: Bool) async {
        guard restored || (inUse && !(touched ?? []).isEmpty) else { return }
        await now()
    }

    /* Loads now, or once more after the load under way; returns when a load begun after this call is done. */
    public func now() async {
        wanted = true
        if let running { await running.value; return }
        let task = Task { @MainActor in
            while self.wanted {
                self.wanted = false
                await self.load()
            }
            self.running = nil
        }
        running = task
        await task.value
    }
}
