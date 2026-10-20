import Foundation
import Testing
@testable import HushOSKit

/*
 * What this account shares is asked again after every restore, at once, and after a sync that
 * applied a change in its own drive, at most once per ten seconds: the server leaves trashed
 * items out of `/shares/mine`, so a restored shared folder showed nobody on it (and By me left
 * it out) until a pull or a relaunch, while asking after every sync would send a request per
 * file of a large upload. A request made while a load is under way gets a load begun after it,
 * or the marks keep what the server said before the restore.
 */
@MainActor
@Suite(.timeLimit(.minutes(1))) struct SharingRefreshTests {
    /* Counts loads; while `holding`, each load waits for `release` so requests can arrive mid-load. */
    @MainActor final class Server {
        var loads = 0
        var events: [String] = []
        var holding = false
        let time: Time
        private var waiting: [CheckedContinuation<Void, Never>] = []

        init(time: Time) { self.time = time }

        func load() async {
            loads += 1
            events.append("load \(loads) began at \(Int(time.now))")
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

    /* A clock the test moves: a wait ends when the time passes its deadline (or at `finish`). */
    @MainActor final class Time {
        var now: TimeInterval = 0
        var waits: [TimeInterval] = []
        private var sleepers: [(deadline: TimeInterval, wake: CheckedContinuation<Void, Never>)] = []

        func wait(_ seconds: TimeInterval) async {
            waits.append(seconds)
            // A wait that begins at or past its end (the task started late) is over at once, as a real sleep is.
            if seconds <= 0 { return }
            await withCheckedContinuation { sleepers.append((now + seconds, $0)) }
        }

        func advance(to time: TimeInterval) async {
            now = time
            let due = sleepers.filter { $0.deadline <= time }
            sleepers.removeAll { $0.deadline <= time }
            for sleeper in due { sleeper.wake.resume() }
            for _ in 0..<50 { await Task.yield() }
        }

        /* Wakes every sleeper still waiting, so no task outlives the test. */
        func finish() async { await advance(to: 1_000_000) }
    }

    func refresher(_ server: Server, _ time: Time) -> SharingRefresh {
        SharingRefresh(interval: 10, clock: { time.now }, wait: { await time.wait($0) }, load: { await server.load() })
    }

    @Test func aRestoreRefreshesEvenWhenTheSyncBroughtNothing() async {
        let time = Time()
        let server = Server(time: time)
        let refresh = refresher(server, time)
        // The restore's own change was already filed, or the feed wasn't asked: the restore still counts.
        await refresh.afterSync(touched: [], restored: true)
        await refresh.afterSync(touched: nil, restored: true)
        #expect(server.loads == 2)
    }

    @Test func aSyncWithOwnChangesRefreshesOnceAndOneWithoutDoesNot() async {
        let time = Time()
        let server = Server(time: time)
        let refresh = refresher(server, time)
        await refresh.afterSync(touched: ["lisbon", "photos", "root"], restored: false)
        #expect(server.loads == 1)
        await time.advance(to: 30)
        await refresh.afterSync(touched: [], restored: false)
        await refresh.afterSync(touched: nil, restored: false)
        #expect(server.loads == 1)
        #expect(refresh.trailing == nil)
    }

    @Test func ownChangesLoadAtMostOncePerIntervalWithOneLoadAtItsEnd() async {
        let time = Time()
        let server = Server(time: time)
        let refresh = refresher(server, time)
        // An upload of many files: a sync after each one.
        await refresh.afterSync(touched: ["p1"], restored: false)
        for (second, id) in [(2.0, "p2"), (5.0, "p3"), (9.0, "p4")] {
            await time.advance(to: second)
            await refresh.afterSync(touched: [id], restored: false)
        }
        #expect(server.loads == 1)
        // One wait, to the end of the interval the first load began.
        #expect(time.waits.count == 1)
        await time.advance(to: 10)
        await refresh.trailing?.value
        #expect(server.events == ["load 1 began at 0", "load 1 answered", "load 2 began at 10", "load 2 answered"])
        await time.advance(to: 11)
        await refresh.afterSync(touched: ["p5"], restored: false)
        #expect(server.loads == 2)
        await time.finish()
        #expect(server.loads == 3)
    }

    @Test func aRestoreIsNeverHeldAndAnswersAChangeWaitingForTheInterval() async {
        let time = Time()
        let server = Server(time: time)
        let refresh = refresher(server, time)
        await refresh.afterSync(touched: ["p1"], restored: false)
        await time.advance(to: 2)
        await refresh.afterSync(touched: ["p2"], restored: false)
        await time.advance(to: 3)
        await refresh.afterSync(touched: ["lisbon"], restored: true)
        #expect(server.events == ["load 1 began at 0", "load 1 answered", "load 2 began at 3", "load 2 answered"])
        // The change at 2 s was answered by the restore's load: nothing more at the interval's end.
        await time.finish()
        #expect(server.loads == 2)
    }

    @Test func requestsDuringALoadGetOneLoadBegunAfterThem() async {
        let time = Time()
        let server = Server(time: time)
        server.holding = true
        let refresh = refresher(server, time)
        // A live sync's refresh is reading the server when a restore lands, then a sync and a pull come in.
        let first = Task { await refresh.afterSync(touched: ["a"], restored: false) }
        await server.parked()
        let restore = Task { await refresh.afterSync(touched: ["lisbon"], restored: true) }
        let more = Task { await refresh.afterSync(touched: ["b"], restored: false) }
        let again = Task { await refresh.now() }
        for _ in 0..<50 { await Task.yield() }
        server.release()
        await first.value
        await restore.value
        // The restore is answered by a load that began after it, not by the one already reading.
        #expect(server.events.last == "load 2 answered")
        await more.value
        await again.value
        await time.finish()
        // One more load after the one under way, not one per request.
        #expect(server.loads == 2)
        #expect(server.events == ["load 1 began at 0", "load 1 answered", "load 2 began at 0", "load 2 answered"])
    }
}
