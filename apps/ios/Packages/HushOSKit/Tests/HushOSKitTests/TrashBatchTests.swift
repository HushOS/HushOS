import Foundation
import Testing
@testable import HushOSKit

/*
 * Move to Trash for many: only what the server moved is counted, offered back by the notice's
 * Undo and taken off the lists, each row as its request is confirmed; the batch reaches the data
 * layer in one call (`Vault.trashMany`, the seam a batch route replaces), which sends one request
 * after another and stops when no later one can succeed; and the follow-up (feed, listings,
 * Files) runs once for the batch, after the last answer and the notice.
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
        var dropped: [String] = []
        /* What each call to `drop` took off the lists: one call is one update of the lists. */
        var drops: [[String]] = []
        /* Each notice's text, and what tapping its Undo restores (nil: the notice has no Undo). */
        var notices: [(text: String, undo: [String]?)] = []
        var settled: [Set<String>] = []
        private var restored: [String]?

        /*
         * `send` answers for one item, as the server would; the batch goes through the kit's
         * sequencing. Items in `withFolder` went with a folder (`covered`), the rest on their own.
         */
        func steps(withFolder: Set<String> = [], _ send: @escaping @Sendable (Opened) async throws -> Void) -> TrashBatch.Steps {
            TrashBatch.Steps(
                send: { batch, moved in
                    await MainActor.run { self.batches.append(batch.map(\.id)) }
                    return await TrashBatch.oneAfterAnother(batch) { item in
                        try await send(item)
                        await MainActor.run { self.events.append("sent \(item.id)") }
                        await moved([item])
                        return withFolder.contains(item.id) ? TrashBatch.Move.withFolder : .trashed
                    }
                },
                drop: { items in
                    self.drops.append(items.map(\.id))
                    for item in items { self.events.append("drop \(item.id)"); self.dropped.append(item.id) }
                },
                announce: { text, undo in
                    self.events.append("announce")
                    // Tap Undo at once: what reaches `restore` is what the person gets back.
                    self.restored = nil
                    undo?()
                    self.notices.append((text, undo == nil ? nil : self.restored))
                },
                restore: { moved in self.restored = moved.map(\.id) },
                settle: { folders in self.events.append("settle"); self.settled.append(folders) }
            )
        }

        /* As the batch route answers: every item moved, a request of `size` at a time, each request's landing told at once. */
        func requests(_ size: Int) -> TrashBatch.Steps {
            var steps = self.steps { _ in }
            steps.send = { batch, moved in
                for start in stride(from: 0, to: batch.count, by: size) { await moved(Array(batch[start ..< min(start + size, batch.count)])) }
                return batch.map { _ in .success(.trashed) }
            }
            return steps
        }
    }

    nonisolated static let failing: Set<String> = ["f3", "f8"]
    let failsSome: @Sendable (Opened) async throws -> Void = { item in
        if TrashBatchTests.failing.contains(item.id) { throw DriveAPIError.server(500, "Server said something internal") }
    }
    var movedIds: [String] { thirteen.map(\.id).filter { !Self.failing.contains($0) } }

    @Test func aRequestsRowsLeaveTheListsInOneUpdate() async {
        // 251 rows dropped one at a time redraw the list 251 times; a request's worth goes in one.
        let many = (1...251).map { item("m\($0)") }
        let recorder = Recorder()
        _ = await TrashBatch.trash(many, recorder.requests(200))
        #expect(recorder.drops == [many.prefix(200).map(\.id), many.dropFirst(200).map(\.id)])
    }

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
        #expect(recorder.dropped == movedIds)
    }

    @Test func eachRowLeavesAsItIsConfirmedAndTheFollowUpRunsOnceAtTheEnd() async {
        let recorder = Recorder()
        _ = await TrashBatch.trash(thirteen, recorder.steps { _ in })
        #expect(recorder.settled == [["work", "photos"]])
        // Each row goes right after its own answer; the notice and one follow-up come after the last.
        #expect(recorder.events == thirteen.flatMap { ["sent \($0.id)", "drop \($0.id)"] } + ["announce", "settle"])
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
        #expect(recorder.notices.map(\.undo) == [nil])
        #expect(recorder.dropped.isEmpty && recorder.settled.isEmpty)
    }

    @Test func theReasonIsOfflineOnlyWhenEveryFailureWas() async {
        // A refusal, then no network: the second may have landed, so nothing is said to have stayed.
        let mixed = await TrashBatch.trash(thirteen, Recorder().steps { item in
            if item.id == "f2" { throw DriveAPIError.server(409, "x") }
            if item.id == "f4" { throw DriveAPIError.transport("offline") }
        })
        #expect(mixed.failure == .unconfirmed)
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

    @Test func aGatewayErrorIsUnconfirmedNeverStayed() async {
        // A 502 or 504 can come after the trash committed behind the gateway.
        let partial = await TrashBatch.trash(thirteen, Recorder().steps { item in
            if item.id == "f12" { throw DriveAPIError.server(502, "Bad gateway") }
        })
        #expect(partial.notice == "12 of 13 moved to Trash. The rest weren’t confirmed. Try again.")
        let none = await TrashBatch.trash(Array(thirteen.prefix(2)), Recorder().steps { _ in throw DriveAPIError.server(504, "Gateway timeout") })
        #expect(none.notice == "Couldn’t move to Trash. HushOS didn’t confirm it. Try again.")
        let refused = await TrashBatch.trash(thirteen, Recorder().steps { item in
            if item.id == "f2" || item.id == "f4" { throw DriveAPIError.server(409, "x") }
        })
        #expect(refused.notice == "11 of 13 moved to Trash. The rest stayed where they were. Try again.")
        #expect(TrashBatch.failure(of: DriveAPIError.server(500, "x")) == .other)
    }

    @Test func anItemIsReportedMovedOnlyAfterItsTrashCameBack() async {
        let ids = (1...6).map { "n\($0)" }
        let log = Sent()
        let outcomes = await TrashBatch.trashEach(ids, trash: { id in
            await log.add("trash \(id)")
            if id == "n3" { throw DriveAPIError.server(409, "trashed") }
        }, moved: { id in await log.add("moved \(id)") })
        let events = await log.ids
        #expect(Array(events.prefix(7)) == ["trash n1", "moved n1", "trash n2", "moved n2", "trash n3", "trash n4", "moved n4"])
        #expect(!events.contains("moved n3"))
        #expect(outcomes.map { if case .success = $0 { true } else { false } } == [true, true, false, true, true, true])
    }

    @Test func undoPutsBackOnlyWhatCameBackOnceInListOrderAndOnlyInFoldersOnScreen() {
        let folders = ["work": [item("Budget"), item("Zebra")], "photos": []]
        let back = [item("apple"), item("Zebra"), item("elsewhere", parent: "music")]
        let result = TrashBatch.afterUndo(back, folders: folders, trash: [])
        // "apple" joins Work in name order, "Zebra" isn't doubled, and a folder not on screen gets no list.
        #expect(result.folders["work"]?.map(\.id) == ["apple", "Budget", "Zebra"])
        #expect(result.folders["photos"]?.isEmpty == true)
        #expect(Set(result.folders.keys) == ["work", "photos"])
    }

    @Test func undoTakesWhatCameBackOffTheTrashListAndLeavesTheRest() {
        let trashed = [item("a"), item("b"), item("c")]
        let result = TrashBatch.afterUndo([trashed[0], trashed[2]], folders: [:], trash: trashed.map { ($0, false) })
        #expect(result.trash.map(\.item.id) == ["b"])
    }

    @Test func anUndoOfManySaysWhatDidntComeBack() {
        #expect(TrashBatch.undoProblem(back: 13, tried: 13) == nil)
        #expect(TrashBatch.undoProblem(back: 0, tried: 1) == nil)
        #expect(TrashBatch.undoProblem(back: 11, tried: 13) == "11 of 13 are back. The rest are still in Trash.")
        #expect(TrashBatch.undoProblem(back: 0, tried: 13) == "Couldn’t bring them back. They’re still in Trash.")
        // A whole Undo request turned away says why, as the web does.
        #expect(TrashBatch.undoProblem(back: 0, tried: 13, errors: [TrashBatch.RequestRefusal.busy])
            == "Couldn’t bring them back. Too many changes are being made here at once. Please try again.")
        #expect(TrashBatch.undoProblem(back: 200, tried: 251, errors: [TrashBatch.RequestRefusal.tooMany])
            == "200 of 251 are back. Too many requests. Please try again shortly.")
    }

    @Test func anItemThatWentWithItsFolderCountsAsMovedButUndoLeavesItToTheFolder() async {
        let recorder = Recorder()
        let result = await TrashBatch.trash(thirteen, recorder.steps(withFolder: ["f2", "f5"]) { _ in })
        #expect(recorder.notices.map(\.text) == ["Moved 13 items to Trash"])
        #expect(recorder.dropped == thirteen.map(\.id))
        // Undo puts back what went on its own; f2 and f5 come back with their folder.
        #expect(recorder.notices.map(\.undo) == [thirteen.map(\.id).filter { $0 != "f2" && $0 != "f5" }])
        #expect(result.moved.count == 13)
    }

    @Test func nothingOfItsOwnToPutBackMeansNoUndo() async {
        let recorder = Recorder()
        _ = await TrashBatch.trash(Array(thirteen.prefix(2)), recorder.steps(withFolder: ["f1", "f2"]) { _ in })
        #expect(recorder.notices.map(\.text) == ["Moved 2 items to Trash"])
        #expect(recorder.notices.map(\.undo) == [nil])
    }

    @Test func anItemAlreadyInTheTrashIsNotSaidToHaveStayed() async {
        let result = await TrashBatch.trash(thirteen, Recorder().steps { item in
            if item.id == "f13" { throw DriveAPIError.trashed("This item is in the trash.") }
        })
        #expect(result.moved.count == 12)
        #expect(result.notice == "12 of 13 moved to Trash. The rest were in Trash already.")
    }

    @Test func aBusyOrRateLimitedRequestSaysSoInTheWebsWords() async {
        let busy = await TrashBatch.trash(thirteen, Recorder().steps { item in
            if item.id == "f13" { throw TrashBatch.RequestRefusal.busy }
        })
        #expect(busy.notice == "12 of 13 moved to Trash. Too many changes are being made here at once. Please try again.")
        let none = await TrashBatch.trash(Array(thirteen.prefix(3)), Recorder().steps { _ in throw TrashBatch.RequestRefusal.tooMany })
        #expect(none.notice == "Couldn’t move to Trash. Too many requests. Please try again shortly.")
        let large = await TrashBatch.trash(Array(thirteen.prefix(3)), Recorder().steps { _ in throw TrashBatch.RequestRefusal.tooLarge })
        #expect(large.failure == .tooLarge)
    }
}
