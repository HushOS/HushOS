import Foundation
import Testing
@testable import HushOSKit

/*
 * Move to Trash for many: only what the server moved is counted, offered back and taken off the
 * lists; the batch reaches the data layer in one call (`Vault.trashMany`, the seam a batch route
 * replaces), which sends one request after another and stops when no later one can succeed; and
 * the follow-up (feed, listings, Files) runs once for the batch, after the rows are gone and the
 * notice is up.
 */
@MainActor
@Suite struct TrashBatchTests {
    func item(_ id: String, parent: String = "work") -> Opened {
        let node = NodeView(id: id, workspaceId: "own", parentId: parent, kind: "file", keyEpoch: 1, parentKeyEpoch: 1,
                            keyEnvelope: "", metadataVersion: 1, metadataEnvelope: "", currentVersion: nil, trashedAt: nil,
                            changeSeq: 1, createdAt: nil, updatedAt: nil)
        return Opened(node: node, metadata: NodeMetadata(name: id, mime: nil, size: 3, modified: nil), nodeKey: nil)
    }

    var thirteen: [Opened] { (1...13).map { item("f\($0)", parent: $0 % 2 == 0 ? "work" : "photos") } }

    /* Records what each step got, and in which order the steps ran. */
    @MainActor final class Recorder {
        var events: [String] = []
        var batches: [[String]] = []
        var dropped: [[String]] = []
        var notices: [(text: String, undo: [String])] = []
        var settled: [Set<String>] = []

        /* `send` answers for one item, as the server would; the batch goes through the kit's sequencing. */
        func steps(_ send: @escaping @Sendable (Opened) async throws -> Void) -> TrashBatch.Steps {
            TrashBatch.Steps(
                send: { batch in
                    await MainActor.run { self.batches.append(batch.map(\.id)) }
                    return await TrashBatch.oneAfterAnother(batch) { item in
                        try await send(item)
                        await MainActor.run { self.events.append("sent \(item.id)") }
                    }
                },
                drop: { moved in self.events.append("drop"); self.dropped.append(moved.map(\.id)) },
                announce: { text, undo in self.events.append("announce"); self.notices.append((text, undo.map(\.id))) },
                settle: { folders in self.events.append("settle"); self.settled.append(folders) }
            )
        }
    }

    nonisolated static let failing: Set<String> = ["f3", "f8"]
    let failsSome: @Sendable (Opened) async throws -> Void = { item in
        if TrashBatchTests.failing.contains(item.id) { throw DriveAPIError.server(500, "Server said something internal") }
    }
    var movedIds: [String] { thirteen.map(\.id).filter { !Self.failing.contains($0) } }

    @Test func aFailedItemIsNotCountedAsMoved() async {
        let recorder = Recorder()
        let result = await TrashBatch.trash(thirteen, recorder.steps(failsSome))
        #expect(result.moved.map(\.id) == movedIds)
        // The server's own sentence never reaches the notice; the count is of what moved.
        #expect(recorder.notices.map(\.text) == ["11 of 13 moved to Trash. The rest stayed where they were. Try again."])
    }

    @Test func undoOffersBackOnlyWhatMoved() async {
        let recorder = Recorder()
        _ = await TrashBatch.trash(thirteen, recorder.steps(failsSome))
        #expect(recorder.notices.map(\.undo) == [movedIds])
        // Rows that stayed are not taken off the lists either.
        #expect(recorder.dropped == [movedIds])
    }

    @Test func theFollowUpRunsOnceAfterEveryRequestNotOncePerItem() async {
        let recorder = Recorder()
        _ = await TrashBatch.trash(thirteen, recorder.steps { _ in })
        #expect(recorder.settled == [["work", "photos"]])
        // Every request answered, then the rows go, then the notice, then the follow-up.
        #expect(recorder.events.prefix(13).allSatisfy { $0.hasPrefix("sent ") })
        #expect(Array(recorder.events.dropFirst(13)) == ["drop", "announce", "settle"])
    }

    @Test func theWholeBatchReachesTheDataLayerInOneCall() async {
        let recorder = Recorder()
        _ = await TrashBatch.trash(thirteen, recorder.steps { _ in })
        // One call with every item, in order: the one place a batch route will take over.
        #expect(recorder.batches == [thirteen.map(\.id)])
    }

    @Test func anOrdinaryRefusalDoesNotStopTheRest() async {
        let ids = (1...6).map { "n\($0)" }
        let sent = Sent()
        let outcomes = await TrashBatch.oneAfterAnother(ids) { id in
            await sent.add(id)
            if id == "n2" { throw DriveAPIError.server(409, "trashed") }
        }
        #expect(await sent.ids == ids)
        #expect(outcomes.map { if case .success = $0 { true } else { false } } == [true, false, true, true, true, true])
    }

    @Test func noNetworkOrAnEndedSessionStopsSendingAndTheRestAreNotMoved() async {
        let ids = (1...6).map { "n\($0)" }
        for (at, error) in [("n3", DriveAPIError.transport("offline")), ("n1", DriveAPIError.notAuthenticated)] {
            let sent = Sent()
            let outcomes = await TrashBatch.oneAfterAnother(ids) { id in
                await sent.add(id)
                if id == at { throw error }
            }
            let index = ids.firstIndex(of: at)!
            #expect(await sent.ids == Array(ids[...index]))
            #expect(outcomes.map { if case .success = $0 { true } else { false } } == ids.indices.map { $0 < index })
        }
    }

    actor Sent {
        var ids: [String] = []
        func add(_ id: String) { ids.append(id) }
    }

    @Test func everythingMovedIsSaidPlainly() async {
        let many = Recorder()
        _ = await TrashBatch.trash(thirteen, many.steps { _ in })
        #expect(many.notices.map(\.text) == ["Moved 13 items to Trash"])
        let one = Recorder()
        _ = await TrashBatch.trash([item("Report.pdf")], one.steps { _ in })
        #expect(one.notices.map(\.text) == ["Moved “Report.pdf” to Trash"])
        #expect(one.notices.map(\.undo) == [["Report.pdf"]])
        #expect(one.settled == [["work"]])
    }

    @Test func aSingleItemThatFailedIsLeftToTheCallerAndNothingFollows() async {
        let recorder = Recorder()
        let result = await TrashBatch.trash([item("f3")], recorder.steps(failsSome))
        #expect(result.moved.isEmpty)
        #expect(result.notice == nil)
        #expect(recorder.notices.isEmpty && recorder.dropped.isEmpty && recorder.settled.isEmpty)
    }

    @Test func nothingMovedOfManySaysSoWithNoUndoAndNoFollowUp() async {
        let recorder = Recorder()
        _ = await TrashBatch.trash(thirteen, recorder.steps { _ in throw DriveAPIError.transport("offline") })
        #expect(recorder.notices.map(\.text) == ["Couldn’t move to Trash. You’re offline. Try again once you’re connected."])
        #expect(recorder.notices.map(\.undo) == [[]])
        #expect(recorder.dropped.isEmpty && recorder.settled.isEmpty)
    }

    @Test func theReasonIsOfflineOnlyWhenEveryFailureWas() async {
        // A refusal, then no network: the reason can't honestly be "offline" alone.
        let mixed = await TrashBatch.trash(thirteen, Recorder().steps { item in
            if item.id == "f2" { throw DriveAPIError.server(409, "x") }
            if item.id == "f4" { throw DriveAPIError.transport("offline") }
        })
        #expect(mixed.failure == .other)
        // No network at the twelfth: nothing after it was sent, and none of it counts as moved.
        let offline = await TrashBatch.trash(thirteen, Recorder().steps { item in
            if item.id == "f12" { throw URLError(.notConnectedToInternet) }
        })
        #expect(offline.notice == "11 of 13 moved to Trash. You’re offline, so the rest weren’t confirmed.")
        let signedOut = await TrashBatch.trash(thirteen, Recorder().steps { item in
            if item.id == "f2" { throw DriveAPIError.server(409, "x") }
            if item.id == "f4" { throw DriveAPIError.notAuthenticated }
        })
        #expect(signedOut.failure == .signedOut)
    }
}
