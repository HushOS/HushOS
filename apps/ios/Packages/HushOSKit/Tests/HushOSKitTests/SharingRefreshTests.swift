import Foundation
import Testing
@testable import HushOSKit

/*
 * What this account shares is asked again after every restore and after a sync that applied a
 * change in its own drive, once per sync: the server leaves trashed items out of `/shares/mine`,
 * so a restored shared folder showed nobody on it (and By me left it out) until a pull or a
 * relaunch. A request made while a load is under way gets a load begun after it, or the marks
 * keep what the server said before the restore.
 */
@MainActor
@Suite struct SharingRefreshTests {
    /* Counts loads; while `holding`, each load waits for `release` so requests can arrive mid-load. */
    @MainActor final class Server {
        var loads = 0
        var events: [String] = []
        var holding = false
        private var waiting: [CheckedContinuation<Void, Never>] = []

        func load() async {
            loads += 1
            events.append("load \(loads) began")
            if holding { await withCheckedContinuation { waiting.append($0) } }
            events.append("load \(loads) answered")
        }

        func release() {
            holding = false
            let all = waiting
            waiting = []
            for continuation in all { continuation.resume() }
        }

        /* Until a load is parked waiting for `release`. */
        func parked() async {
            for _ in 0..<1000 where waiting.isEmpty { await Task.yield() }
        }
    }

    @Test func aRestoreRefreshesEvenWhenTheSyncBroughtNothing() async {
        let server = Server()
        let refresh = SharingRefresh { await server.load() }
        // The restore's own change was already filed, or the feed wasn't asked: the restore still counts.
        await refresh.afterSync(touched: [], restored: true, inUse: false)
        await refresh.afterSync(touched: nil, restored: true, inUse: false)
        #expect(server.loads == 2)
    }

    @Test func aSyncWithOwnChangesRefreshesOnceAndOneWithoutDoesNot() async {
        let server = Server()
        let refresh = SharingRefresh { await server.load() }
        await refresh.afterSync(touched: ["lisbon", "photos", "root"], restored: false, inUse: true)
        #expect(server.loads == 1)
        await refresh.afterSync(touched: [], restored: false, inUse: true)
        await refresh.afterSync(touched: nil, restored: false, inUse: true)
        #expect(server.loads == 1)
    }

    @Test func nothingIsAskedWhileNothingShowsWhatIsShared() async {
        let server = Server()
        let refresh = SharingRefresh { await server.load() }
        await refresh.afterSync(touched: ["lisbon"], restored: false, inUse: false)
        #expect(server.loads == 0)
    }

    @Test func requestsDuringALoadGetOneLoadBegunAfterThem() async {
        let server = Server()
        server.holding = true
        let refresh = SharingRefresh { await server.load() }
        // A live sync's refresh is reading the server when a restore lands, then two more syncs come in.
        let first = Task { await refresh.afterSync(touched: ["a"], restored: false, inUse: true) }
        await server.parked()
        let restore = Task { await refresh.afterSync(touched: ["lisbon"], restored: true, inUse: true) }
        let more = Task { await refresh.afterSync(touched: ["b"], restored: false, inUse: true) }
        let again = Task { await refresh.now() }
        for _ in 0..<50 { await Task.yield() }
        server.release()
        await first.value
        await restore.value
        // The restore is answered by a load that began after it, not by the one already reading.
        #expect(server.events.last == "load 2 answered")
        await more.value
        await again.value
        // One more load after the one under way, not one per request, and it began after the restore.
        #expect(server.loads == 2)
        #expect(server.events == ["load 1 began", "load 1 answered", "load 2 began", "load 2 answered"])
    }
}
