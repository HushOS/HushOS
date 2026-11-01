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
        #expect(gate.begin() == nil)
    }

    @Test func aTokenHoldsOnlyWhileItsSessionStands() {
        var owner = Owner()
        let gate = SessionGate<Owner> { owner }
        let token = try! #require(gate.begin())
        #expect(gate.current(token))
        owner = Owner()
        #expect(!gate.current(token))
        let next = try! #require(gate.begin())
        gate.reset()
        #expect(!gate.current(next))
    }

    /*
     * Signed in again (adopt): an operation the old session began, carried on past the switch,
     * never starts a request, under either vault, and its 401 is never said in the new session.
     * Fails if the gate runs work for an ended session, or with the new session's vault.
     */
    @Test func anOperationOfAnEndedSessionStartsNothingUnderTheNewOne() async {
        var owner = Owner()
        let old = owner
        let gate = SessionGate<Owner> { owner }
        let token = try! #require(gate.begin())
        // The same account signed in again while the operation waited: a new vault, the gate reset.
        owner = Owner()
        gate.reset()
        let ran = Gate()
        let result = await gate.run(token) { vault -> Int in
            ran.open()
            #expect(vault === old)
            throw URLError(.userAuthenticationRequired)
        }
        #expect(result == nil, "an ended session's 401 was handed to the new one")
        #expect(!ran.isOpen, "a request started for an ended session")
    }

    /* The owner a token runs against is its own, never whichever session is current by then. */
    @Test func aTokenRunsAgainstItsOwnSession() async throws {
        let owner = Owner()
        let gate = SessionGate<Owner> { owner }
        let token = try #require(gate.begin())
        let seen = await gate.run(token) { $0 }
        #expect(try seen?.get() === owner)
    }
}

/*
 * Family marks under each family's trust generation. Fails if a judgement that began before the
 * family's trust moved (a sync, a clear, a rejudge, a pin or guard change) publishes over the
 * newer one, or if one family's move holds another back.
 */
@Suite struct FamilyVerdictBookTests {
    let group = "0a427e6e-a934-4366-aea3-b09f70984781"
    let ws = "1b427e6e-a934-4366-aea3-b09f70984781"
    var node: NodeView {
        NodeView(id: "2c427e6e-a934-4366-aea3-b09f70984781", workspaceId: ws, parentId: nil, kind: "file", keyEpoch: 1, parentKeyEpoch: 1,
                 keyEnvelope: "", metadataVersion: 1, metadataEnvelope: "", currentVersion: nil, trashedAt: nil, changeSeq: 1, createdAt: nil, updatedAt: nil)
    }
    func verdict(_ by: String) -> FamilyVerdict { FamilyVerdict(mark: nil, changedBy: nil, writtenBy: by, replacedBy: [], verifiedBy: nil) }

    @Test func aStaleJudgementNeverPublishesOverANewerOne() {
        var book = FamilyVerdictBook()
        let ref = NodeRef(workspaceId: ws, nodeId: node.id)
        let older = book.capture(group)
        // The family synced (or a pin changed) while that judgement ran; a new one begins and lands first.
        book.moved(group)
        let newer = book.capture(group)
        let published1 = book.publish(group, trust: newer, [(ref, node, verdict("newer"))])
        #expect(published1)
        let published2 = book.publish(group, trust: older, [(ref, node, verdict("older"))])
        #expect(!published2)
        #expect(book.verdict(of: ref, node: node)?.writtenBy == "newer")
    }

    @Test func aTrustChangeDropsEveryFamilysVerdictsAndHoldsBackWhatBeganBefore() {
        var book = FamilyVerdictBook()
        let ref = NodeRef(workspaceId: ws, nodeId: node.id)
        let before = book.capture(group)
        let published3 = book.publish(group, trust: before, [(ref, node, verdict("a"))])
        #expect(published3)
        book.moved(nil)
        #expect(book.verdict(of: ref, node: node) == nil)
        let published4 = book.publish(group, trust: before, [(ref, node, verdict("b"))])
        #expect(!published4)
        // Another family's move doesn't hold this one back.
        let now = book.capture(group)
        book.moved("3d427e6e-a934-4366-aea3-b09f70984781")
        let published5 = book.publish(group, trust: now, [(ref, node, verdict("c"))])
        #expect(published5)
    }

    /* A family's sync or clear takes back its verdicts at once: none stands until judged again, another family's stays. */
    @Test func aFamilysMoveDropsOnlyItsOwnVerdicts() {
        var book = FamilyVerdictBook()
        let other = "3d427e6e-a934-4366-aea3-b09f70984781"
        let ref = NodeRef(workspaceId: ws, nodeId: node.id)
        let otherRef = NodeRef(workspaceId: "4e427e6e-a934-4366-aea3-b09f70984781", nodeId: node.id)
        let mine = book.publish(group, trust: book.capture(group), [(ref, node, verdict("a"))])
        let theirs = book.publish(other, trust: book.capture(other), [(otherRef, node, verdict("b"))])
        #expect(mine && theirs)
        book.moved(group)
        #expect(book.verdict(of: ref, node: node) == nil)
        #expect(book.verdict(of: otherRef, node: node)?.writtenBy == "b")
    }

    @Test func aResetDropsAndHoldsBackEverything() {
        var book = FamilyVerdictBook()
        let ref = NodeRef(workspaceId: ws, nodeId: node.id)
        let before = book.capture(group)
        let published6 = book.publish(group, trust: before, [(ref, node, verdict("a"))])
        #expect(published6)
        book.reset()
        #expect(book.verdict(of: ref, node: node) == nil)
        let published7 = book.publish(group, trust: before, [(ref, node, verdict("b"))])
        #expect(!published7)
    }
}
