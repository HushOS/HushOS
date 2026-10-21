import Foundation
import Testing
@testable import HushOSKit

/*
 * A selection through the batch routes: 200 ids a request, a request per workspace; what counts
 * as moved; a whole request refused or unanswered; Undo with folders first and `parent-trashed`
 * tried again; and the fall back to one request an item on a server without the routes.
 */
@Suite struct TrashBatchRoutesTests {
    func ids(_ n: Int, _ prefix: String = "n") -> [String] { (1...n).map { "\(prefix)\($0)" } }

    /* A fake server: each request recorded; every id answered by `answer` unless `fail` throws. */
    actor Server {
        var requests: [(workspace: String, ids: [String])] = []
        let answer: @Sendable (String, [String]) -> TrashBatch.Answer?
        let fail: @Sendable (String, [String]) -> Error?
        init(answer: @escaping @Sendable (String, [String]) -> TrashBatch.Answer? = { id, _ in .trashed(id: id, changeSeq: 1) },
             fail: @escaping @Sendable (String, [String]) -> Error? = { _, _ in nil }) {
            self.answer = answer
            self.fail = fail
        }
        func send(_ workspace: String, _ ids: [String]) throws -> [TrashBatch.Answer] {
            let earlier = requests.flatMap(\.ids)
            requests.append((workspace, ids))
            if let error = fail(workspace, ids) { throw error }
            return ids.compactMap { answer($0, earlier) }
        }
    }

    actor Log {
        var ids: [String] = []
        func add(_ id: String) { ids.append(id) }
        func add(_ more: [String]) { ids += more }
    }

    func trash(_ items: [(id: String, workspace: String)], _ server: Server,
               sequential: @escaping @Sendable ([String]) async -> [Result<TrashBatch.Move, Error>] = { _ in [] }) async -> ([Result<TrashBatch.Move, Error>], [String]) {
        let moved = Log()
        let outcomes = await TrashBatch.trashInBatches(items, send: { try await server.send($0, $1) }, sequential: sequential) { landed in await moved.add(landed.map(\.id)) }
        return (outcomes, await moved.ids)
    }

    func succeeded<T>(_ outcome: Result<T, Error>) -> Bool { if case .success = outcome { true } else { false } }

    @Test func aLargeSelectionGoesInRequestsOfTwoHundredOnePerWorkspace() async {
        let items = ids(250).map { ($0, "own") } + ids(3, "s").map { ($0, "shared") }
        let server = Server()
        let (outcomes, moved) = await trash(items, server)
        let requests = await server.requests
        #expect(requests.map { "\($0.workspace) \($0.ids.count)" } == ["own 200", "own 50", "shared 3"])
        #expect(requests.flatMap(\.ids) == items.map(\.0))
        #expect(outcomes.allSatisfy { (try? $0.get()) == .trashed })
        #expect(moved.count == 253)
    }

    @Test func whatARequestMovedLandsTogetherOncePerRequest() async {
        // One landing a request, so the lists drop a request's rows in one update, not one per row.
        let sizes = Log()
        _ = await TrashBatch.trashInBatches(ids(250).map { ($0, "own") }, send: { try await Server().send($0, $1) }, sequential: { _ in [] }) { landed in
            await sizes.add("\(landed.count)")
        }
        #expect(await sizes.ids == ["200", "50"])
    }

    /* The screen: a row it still shows whose node this device forgot is looked up again. */
    actor Screen {
        var rows: Set<String>
        var forgotten: [String] = []
        var lookedUpAgain = 0
        init(_ rows: [String]) { self.rows = Set(rows) }
        func drop(_ ids: [String]) { rows.subtract(ids) }
        func forget(_ ids: [String]) { for id in ids { if rows.contains(id) { lookedUpAgain += 1 }; forgotten.append(id) } }
    }

    @Test func aRowIsForgottenOnlyOnceTheListsLetGoOfIt() async {
        // Forgetting rows still on screen cost 115 to 156 listings and 8 to 11 s a 251-item batch. Refused rows stay known.
        let screen = Screen(ids(250))
        let server = Server(answer: { id, _ in id == "n7" ? .refused(id: id, reason: "forbidden", message: "You can’t change this.") : .trashed(id: id, changeSeq: 1) })
        _ = await TrashBatch.trashInBatches(ids(250).map { ($0, "own") }, send: { try await server.send($0, $1) }, sequential: { _ in [] },
                                            forget: { await screen.forget($0) }) { landed in await screen.drop(landed.map(\.id)) }
        #expect(await screen.lookedUpAgain == 0)
        #expect(await screen.forgotten == ids(250).filter { $0 != "n7" })
        #expect(await screen.rows == ["n7"])
    }

    @Test func coveredCountsAsMovedButAlreadyInTheTrashIsARefusalAsOnTheWeb() async {
        let server = Server(answer: { id, _ in
            switch id {
            case "n2": return .covered(id: id, by: "n1")
            case "n3": return .refused(id: id, reason: "trashed", message: "This item is in the trash.")
            case "n4": return .refused(id: id, reason: "forbidden", message: "You can’t change this.")
            default: return .trashed(id: id, changeSeq: 1)
            }
        })
        let (outcomes, moved) = await trash(ids(4).map { ($0, "own") }, server)
        #expect(outcomes.prefix(2).map { try? $0.get() } == [.trashed, .withFolder])
        // Already in the trash didn't move: the web counts it as a failure ("N of M") too.
        if case .failure(let error) = outcomes[2] { #expect(TrashBatch.failure(of: error) == .alreadyTrashed) } else { Issue.record("n3 counted as moved") }
        #expect(!succeeded(outcomes[3]))
        #expect(moved == ["n1", "n2"])
    }

    actor Landings {
        var all: [[(id: String, how: TrashBatch.Move)]] = []
        func add(_ landed: [(id: String, how: TrashBatch.Move)]) { all.append(landed) }
    }

    @Test func aChildOfASelectedFolderIsNeverSentAndGoesWithItsFolder() async {
        // The child comes first, its folder after the first 200: sent, the child would be trashed on
        // its own in the first request and come back on Undo without its folder.
        let items = [("c", "own")] + ids(250).map { ($0, "own") } + [("F", "own")]
        let server = Server()
        let landings = Landings()
        let outcomes = await TrashBatch.trashInBatches(items, send: { try await server.send($0, $1) }, sequential: { _ in [] },
                                                       ancestors: { $0 == "c" ? ["F", "top"] : ["top"] }) { landed in await landings.add(landed) }
        let requests = await server.requests
        #expect(!requests.contains { $0.ids.contains("c") })
        #expect(requests.map(\.ids.count) == [200, 51])
        #expect((try? outcomes[0].get()) == .withFolder)
        // It leaves the lists with its folder's request, not before.
        let all = await landings.all
        #expect(all.map(\.count) == [200, 52])
        #expect(all.last?.last?.id == "c")
    }

    @Test func aChildStaysWithItsRefusedFolder() async {
        let server = Server(answer: { id, _ in id == "F" ? .refused(id: id, reason: "forbidden", message: "You can’t change this.") : .trashed(id: id, changeSeq: 1) })
        let outcomes = await TrashBatch.trashInBatches([("F", "own"), ("c", "own")], send: { try await server.send($0, $1) }, sequential: { _ in [] },
                                                       ancestors: { $0 == "c" ? ["F"] : [] }) { _ in }
        #expect(await server.requests.map(\.ids) == [["F"]])
        if case .failure(DriveAPIError.forbidden) = outcomes[1] {} else { Issue.record("the child didn't stay with its refused folder: \(outcomes[1])") }
    }

    @Test func anItemLeftOutOfTheAnswerIsUnconfirmed() async {
        let (outcomes, moved) = await trash(ids(3).map { ($0, "own") }, Server(answer: { id, _ in id == "n2" ? nil : .trashed(id: id, changeSeq: 1) }))
        if case .failure(let error) = outcomes[1] { #expect(TrashBatch.failure(of: error) == .unconfirmed) } else { Issue.record("n2 counted as moved") }
        #expect(moved == ["n1", "n3"])
    }

    @Test func aBusyRequestFailsItsOwnChunkOnlyAndIsNotRetried() async {
        let server = Server(fail: { _, ids in ids.first == "n1" ? TrashBatch.RequestRefusal.busy : nil })
        let (outcomes, _) = await trash(ids(250).map { ($0, "own") }, server)
        #expect(await server.requests.count == 2)
        #expect(outcomes.prefix(200).allSatisfy { if case .failure(let e) = $0 { TrashBatch.failure(of: e) == .busy } else { false } })
        #expect(outcomes.dropFirst(200).allSatisfy(succeeded))
    }

    @Test func aLostResponseLeavesItsChunkUnconfirmedAndSendsNoMore() async {
        let server = Server(fail: { _, _ in DriveAPIError.transport("lost") })
        let (outcomes, moved) = await trash(ids(450).map { ($0, "own") }, server)
        #expect(await server.requests.count == 1)
        #expect(outcomes.allSatisfy { if case .failure(let e) = $0 { TrashBatch.failure(of: e) == .offline } else { false } })
        #expect(moved.isEmpty)
    }

    @Test func aServerWithoutTheRouteFallsBackToOneRequestAnItemForEveryRemainingChunk() async {
        let server = Server(fail: { _, _ in TrashBatch.Unsupported() })
        let sent = Log()
        let (outcomes, _) = await trash(ids(250).map { ($0, "own") }, server) { chunk in
            await sent.add(chunk)
            return chunk.map { _ in .success(.trashed) }
        }
        // One batch request found the route missing; nothing after it tried the route again.
        #expect(await server.requests.count == 1)
        #expect(await sent.ids == ids(250))
        #expect(outcomes.allSatisfy(succeeded))
    }

    @Test func theReplyIsReadAsTheServerMeantIt() throws {
        func reply(_ status: Int, _ json: String) throws -> [TrashBatch.Answer] { try TrashBatch.answers(status: status, data: Data(json.utf8)) }
        // No route: 501 `unsupported` now, a bare 404 on servers from before; the drive's own 404 is not that.
        #expect(throws: TrashBatch.Unsupported.self) { try reply(501, #"{"message":"This server does not offer that yet.","code":"unsupported"}"#) }
        #expect(throws: TrashBatch.Unsupported.self) { try reply(404, #"{"message":"Not found."}"#) }
        #expect(throws: DriveAPIError.self) { try reply(404, #"{"message":"This item no longer exists.","code":"not-found"}"#) }
        #expect(throws: TrashBatch.RequestRefusal.busy) { try reply(409, #"{"message":"Too many changes","code":"conflict"}"#) }
        #expect(throws: TrashBatch.RequestRefusal.tooMany) { try reply(429, #"{"message":"Too many requests.","code":"conflict"}"#) }
        #expect(throws: TrashBatch.RequestRefusal.tooLarge) { try reply(413, #"{"message":"Request is too large.","code":"too-large"}"#) }
        let answers = try reply(200, #"{"results":[{"id":"a","status":"trashed","trashedAt":"t","changeSeq":7},{"id":"b","status":"covered","by":"a"},{"id":"c","status":"refused","reason":"root","message":"No"},{"id":"d","status":"restored","changeSeq":9}]}"#)
        #expect(answers == [.trashed(id: "a", changeSeq: 7), .covered(id: "b", by: "a"), .refused(id: "c", reason: "root", message: "No"), .restored(id: "d", changeSeq: 9)])
        #expect(throws: DriveAPIError.self) { try reply(200, "<html>") }
    }

    /* Undo: depth from a parent map of the given items. */
    static let parents: [String: String] = ["b": "a", "c": "b"]
    static func depth(_ id: String) -> Int { var n = 0; var at = parents[id]; while let p = at { n += 1; at = parents[p] }; return n }

    @Test func undoSendsFoldersBeforeWhatIsInThemWhateverTheOrderGiven() async {
        let server = Server(answer: { id, _ in .restored(id: id, changeSeq: 2) })
        let outcomes = await TrashBatch.restoreInBatches(["c", "x", "b", "a"].map { ($0, "own") }, depth: Self.depth,
                                                         send: { try await server.send($0, $1) }, sequential: { _ in [] })
        let order = await server.requests.single.ids
        #expect(order.firstIndex(of: "a")! < order.firstIndex(of: "b")! && order.firstIndex(of: "b")! < order.firstIndex(of: "c")!)
        #expect(outcomes.allSatisfy(succeeded))
    }

    @Test func anItemWaitingForItsFolderIsTriedAgainAfterTheRestLanded() async {
        // The folder comes back only in a later request; its file is refused until then.
        let server = Server(answer: { id, earlier in
            id == "b" && !earlier.contains("a") ? .refused(id: id, reason: "parent-trashed", message: "Its folder is in the trash.") : .restored(id: id, changeSeq: 2)
        })
        let items = ids(200, "f").map { ($0, "own") } + [("b", "own"), ("a", "other")]
        let outcomes = await TrashBatch.restoreInBatches(items, depth: { _ in 0 }, send: { try await server.send($0, $1) }, sequential: { _ in [] })
        let requests = await server.requests
        #expect(requests.map(\.workspace) == ["own", "own", "other", "own"])
        #expect(requests.last?.ids == ["b"])
        #expect(outcomes.allSatisfy(succeeded))
    }

    @Test func aRefusalThatNothingChangesIsNotTriedForever() async {
        let server = Server(answer: { id, _ in .refused(id: id, reason: "parent-trashed", message: "Its folder is in the trash.") })
        let outcomes = await TrashBatch.restoreInBatches([("b", "own")], depth: { _ in 0 }, send: { try await server.send($0, $1) }, sequential: { _ in [] })
        #expect(await server.requests.count == 2)
        #expect(!succeeded(outcomes[0]))
    }

    actor OneByOne {
        var sent: [String] = []
        var back: Set<String> = []
        func restore(_ id: String) -> Result<Void, Error> {
            sent.append(id)
            return back.insert(id).inserted ? .success(()) : .failure(DriveAPIError.server(409, "This item is not in the trash."))
        }
    }

    @Test func anItemTheFallbackBroughtBackIsNotSentAgain() async {
        // Round one: the batch refuses b until its folder is back. Round two finds the route gone
        // (an older server behind a switch) and the one-by-one route brings b back; sent again, it
        // would be refused as not in the trash and counted as failed.
        let server = Server(answer: { id, _ in id == "b" ? .refused(id: id, reason: "parent-trashed", message: "Its folder is in the trash.") : .restored(id: id, changeSeq: 2) },
                            fail: { _, ids in ids == ["b"] ? TrashBatch.Unsupported() : nil })
        let oneByOne = OneByOne()
        let outcomes = await TrashBatch.restoreInBatches([("a", "own"), ("b", "own")], depth: { _ in 0 }, send: { try await server.send($0, $1) }) { chunk in
            var results: [Result<Void, Error>] = []
            for id in chunk { results.append(await oneByOne.restore(id)) }
            return results
        }
        #expect(await oneByOne.sent == ["b"])
        #expect(outcomes.allSatisfy(succeeded))
    }

    @Test func undoOnAServerWithoutTheRouteRestoresOneByOne() async {
        let server = Server(fail: { _, _ in TrashBatch.Unsupported() })
        let sent = Log()
        let outcomes = await TrashBatch.restoreInBatches(["c", "a", "b"].map { ($0, "own") }, depth: Self.depth, send: { try await server.send($0, $1) }) { chunk in
            await sent.add(chunk)
            return chunk.map { _ in .success(()) }
        }
        // Still folders first, one request each.
        #expect(await sent.ids == ["a", "b", "c"])
        #expect(outcomes.allSatisfy(succeeded))
    }
}

private extension Array {
    var single: Element { precondition(count == 1, "expected one, got \(count)"); return self[0] }
}
