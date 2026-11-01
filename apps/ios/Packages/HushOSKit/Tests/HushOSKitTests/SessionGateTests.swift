import Foundation
import Testing
@testable import HushOSKit

/*
 * Family work kept to the session it began in. Fails if an answer or a failure from a session that
 * ended (a reset) or changed (another vault) lands, if a reset leaves the work running, or if work
 * of the session still in place is dropped.
 */
@MainActor
@Suite struct SessionGateTests {
    final class Owner: Sendable {}

    /* An answer the test lets go of when it chooses, seeing whether it was cancelled. */
    final class Gate: @unchecked Sendable {
        private let lock = NSLock()
        private var waiting: CheckedContinuation<Void, Never>?
        private var opened = false
        func wait() async {
            await withCheckedContinuation { done in
                let now = lock.withLock { () -> Bool in if opened { return true }; waiting = done; return false }
                if now { done.resume() }
            }
        }
        var isOpen: Bool { lock.withLock { opened } }
        func open() {
            let done = lock.withLock { () -> CheckedContinuation<Void, Never>? in opened = true; defer { waiting = nil }; return waiting }
            done?.resume()
        }
    }

    @Test func workOfTheSessionInPlaceLands() async throws {
        let owner = Owner()
        let gate = SessionGate<Owner> { owner }
        let result = await gate.run { _ in 7 }
        #expect(try result?.get() == 7)
        let failed = await gate.run { _ -> Int in throw URLError(.badServerResponse) }
        #expect(failed != nil, "a failure of the session in place is said")
    }

    @Test func anAnswerAfterAResetIsDroppedAndTheWorkCancelled() async {
        let owner = Owner()
        let gate = SessionGate<Owner> { owner }
        let held = Gate()
        let sawCancel = Gate()
        let pending = Task { @MainActor in
            await gate.run { _ -> Int in
                await held.wait()
                if Task.isCancelled { sawCancel.open() }
                return 1
            }
        }
        await Task.yield()
        try? await Task.sleep(for: .milliseconds(50))
        // Signed out (or signed in again) while the answer was out.
        gate.reset()
        held.open()
        #expect(await pending.value == nil)
        // The work itself was told to stop (within two seconds, so a reset that cancels nothing fails rather than hangs).
        for _ in 0 ..< 40 where !sawCancel.isOpen { try? await Task.sleep(for: .milliseconds(50)) }
        #expect(sawCancel.isOpen, "the reset left the work running")
    }

    @Test func aFailureFromAnotherSessionIsDropped() async {
        var owner = Owner()
        let gate = SessionGate<Owner> { owner }
        let held = Gate()
        let pending = Task { @MainActor in
            await gate.run { _ -> Int in
                await held.wait()
                throw URLError(.userAuthenticationRequired)
            }
        }
        try? await Task.sleep(for: .milliseconds(50))
        // The same account signed in again: a new vault, a new session. The old one's 401 must not end it.
        owner = Owner()
        held.open()
        #expect(await pending.value == nil)
    }

    @Test func noSessionRunsNothing() async {
        let gate = SessionGate<Owner> { nil }
        let ran = Gate()
        #expect(await gate.run { _ in ran.open(); return 1 } == nil)
        #expect(gate.ticket() == nil)
    }

    @Test func aTicketHoldsOnlyWhileItsSessionStands() {
        var owner = Owner()
        let gate = SessionGate<Owner> { owner }
        let ticket = try! #require(gate.ticket())
        #expect(gate.holds(ticket))
        owner = Owner()
        #expect(!gate.holds(ticket))
        let next = try! #require(gate.ticket())
        gate.reset()
        #expect(!gate.holds(next))
    }
}
