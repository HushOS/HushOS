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

/*
 * A family file's plaintext copy against a wipe that lands while it comes down. Fails if any
 * chunk, the finished copy or its folder outlives the forget, or if the copy is handed on.
 */
@Suite(.serialized) struct FamilyCopyGateTests {
    /*
     * Signed out while a family file and a personal one come down (their content keys already
     * opened): the sign-out's wipe lands while each waits for its address, before any write, or
     * between two chunks, and no download writes again or leaves a file. Fails if a personal copy
     * has no guard, or the wipe doesn't end what the account's downloads write under.
     */
    @Test func aSignOutDuringDownloadsLeavesNoFileForEither() async throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("signout-\(UUID().uuidString)")
        let temporary = base.appendingPathComponent("tmp")
        let account = CopyEpoch()
        let store = AccountStore(root: base.appendingPathComponent("group"), temporary: temporary, copies: account)
        let ws = UUID().uuidString.lowercased()
        let familyFile = try #require(TemporaryCopies.openedFolder(itemId: "f", version: "v", familyWorkspace: ws, in: temporary)).appendingPathComponent("Recipes.txt")
        let personalFile = try #require(TemporaryCopies.openedFolder(itemId: "p", version: "v", familyWorkspace: nil, in: temporary)).appendingPathComponent("Notes.txt")
        // Each download's gate is taken as it starts; the sign-out lands while it waits for its address (before any write),
        // or between two chunks.
        for (file, gate, wipeAt) in [(familyFile, TemporaryCopies.copyGate(familyWorkspace: ws, account: account), -1),
                                     (personalFile, TemporaryCopies.copyGate(familyWorkspace: nil, account: account), -1),
                                     (personalFile, TemporaryCopies.copyGate(familyWorkspace: nil, account: account), 1)] {
            if wipeAt < 0 { store.wipe() }
            do {
                try await Resumable.download(to: file, count: 3, chunkBytes: 4, gate: gate) { index in
                    if index == wipeAt { store.wipe() }
                    return Data("abcd".utf8)
                }
                Issue.record("a download went on after the sign-out")
            } catch {}
            #expect(!FileManager.default.fileExists(atPath: file.path), "plaintext outlived the sign-out: \(file.lastPathComponent)")
            #expect(!FileManager.default.fileExists(atPath: file.appendingPathExtension("part").path))
        }
        // The next account's downloads go on.
        let next = try #require(TemporaryCopies.openedFolder(itemId: "n", version: "v", familyWorkspace: nil, in: temporary)).appendingPathComponent("n.txt")
        try await Resumable.download(to: next, count: 1, chunkBytes: 4, gate: TemporaryCopies.copyGate(familyWorkspace: nil, account: account)) { _ in Data("abcd".utf8) }
        #expect(FileManager.default.fileExists(atPath: next.path))
    }

    @Test func aWipeMidDownloadLeavesNoPlaintextAndHandsNothingOn() async throws {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("copies-\(UUID().uuidString)")
        let ws = UUID().uuidString.lowercased()
        let folder = try #require(TemporaryCopies.openedFolder(itemId: "item", version: "v", familyWorkspace: ws, in: temporary))
        let destination = folder.appendingPathComponent("Recipes.txt")
        let gate = TemporaryCopies.copyGate(familyWorkspace: ws)
        await #expect(throws: FamilyFailure.self) {
            try await Resumable.download(to: destination, count: 3, chunkBytes: 4, gate: gate) { index in
                // The family is forgotten while the second chunk is on its way.
                if index == 1 { TemporaryCopies.forgetFamily([ws], in: temporary) }
                return Data("abcd".utf8)
            }
        }
        #expect(!FileManager.default.fileExists(atPath: destination.path))
        #expect(!FileManager.default.fileExists(atPath: destination.appendingPathExtension("part").path))
        #expect(!FileManager.default.fileExists(atPath: folder.path))
        #expect(throws: FamilyFailure.self) { try gate.check() }
    }

    /* The forget lands after the last chunk, just before the copy moves into place: it never does. */
    @Test func aWipeBeforeTheCopyMovesIntoPlaceStopsIt() async throws {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("copies-\(UUID().uuidString)")
        let ws = UUID().uuidString.lowercased()
        let folder = try #require(TemporaryCopies.openedFolder(itemId: "item", version: "v", familyWorkspace: ws, in: temporary))
        let destination = folder.appendingPathComponent("Recipes.txt")
        let gate = TemporaryCopies.copyGate(familyWorkspace: ws)
        await #expect(throws: FamilyFailure.self) {
            try await Resumable.download(to: destination, count: 2, chunkBytes: 4, progress: { fraction in
                if fraction >= 1 { TemporaryCopies.forgetFamily([ws], in: temporary) }
            }, gate: gate) { _ in Data("abcd".utf8) }
        }
        #expect(!FileManager.default.fileExists(atPath: destination.path))
    }

    @Test func aCopyBegunAfterTheForgetAndAPersonalOneGoThrough() async throws {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("copies-\(UUID().uuidString)")
        let ws = UUID().uuidString.lowercased()
        TemporaryCopies.forgetFamily([ws], in: temporary)
        let after = TemporaryCopies.copyGate(familyWorkspace: ws)
        let folder = try #require(TemporaryCopies.openedFolder(itemId: "item", version: "v", familyWorkspace: ws, in: temporary))
        try await Resumable.download(to: folder.appendingPathComponent("f"), count: 1, chunkBytes: 4, gate: after) { _ in Data("abcd".utf8) }
        #expect(FileManager.default.fileExists(atPath: folder.appendingPathComponent("f").path))
        // Another family's forget doesn't touch it; a personal copy's gate always lets it through.
        TemporaryCopies.forgetFamily([UUID().uuidString], in: temporary)
        try after.check()
        try TemporaryCopies.copyGate(familyWorkspace: nil).check()
    }
}

/* Family marks when a sync got no answer, and listings out while a family was cleared. */
@Suite struct FamilyStaleWorkTests {
    let group = "0a427e6e-a934-4366-aea3-b09f70984781"
    var accepted: FamilyState {
        .accepted(FamilyView(groupId: group, rosterVersion: 2, rosterDigest: "d", groupKeyVersion: 1, members: [], areas: [],
                             recordReset: false, ownEntryWrong: false, ownEntryBehind: false, foreign: []))
    }

    /* No connection says nothing new: "Unverified" and the like stay on the rows. Anything a sync found moves the generation. */
    @Test func aSyncWithNoAnswerKeepsTheMarks() {
        #expect(!FamilyVerdictBook.moves(after: .failed(FamilyWords.noAnswer)))
        #expect(FamilyVerdictBook.moves(after: .failed("Refused")))
        #expect(FamilyVerdictBook.moves(after: accepted))
        #expect(FamilyVerdictBook.moves(after: .wiped))
        #expect(FamilyVerdictBook.moves(after: .fork(FamilyFork(memberList: true, version: 2, sides: []))))
    }

    /*
     * A family folder's listing out while a fork, refusal or removal cleared the family: dropped,
     * never undoing the clear. Fails if a listing begun before a clear lands, or lands while the
     * family isn't open.
     */
    @Test func aListingOutDuringAClearNeverUndoesIt() {
        var listings = FamilyListings()
        let mark = listings.mark(group)
        #expect(listings.admits(mark, state: accepted))
        listings.cleared(group)
        #expect(!listings.admits(mark, state: accepted), "a listing begun before the clear landed")
        let fresh = listings.mark(group)
        #expect(listings.admits(fresh, state: accepted))
        #expect(listings.admits(fresh, state: .failed(FamilyWords.noAnswer)))
        #expect(!listings.admits(fresh, state: .fork(FamilyFork(memberList: true, version: 2, sides: []))))
        #expect(!listings.admits(fresh, state: .failed("Refused")))
        #expect(!listings.admits(fresh, state: nil))
        // A folder of no family always lands; another family's clear holds nothing back.
        #expect(listings.admits(listings.mark(nil), state: nil))
        listings.cleared("1b427e6e-a934-4366-aea3-b09f70984781")
        #expect(listings.admits(fresh, state: accepted))
    }
}
