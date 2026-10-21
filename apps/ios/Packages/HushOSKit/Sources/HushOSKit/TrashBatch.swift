import Foundation

/*
 * Move to Trash for one item or many, as the app runs it: the batch sent in one call
 * (`Vault.trashMany`), each row off the lists as the server confirms it, then the notice, and
 * one follow-up that runs on its own. A follow-up that fails leaves the lists as they are: the
 * rows were taken off from the server's answers, not from a listing. The decisions live here so
 * the tests can reach them.
 */
public enum TrashBatch {
    /*
     * One request per item, one after another; one outcome per item, in the items' order. After a
     * failure every later request would share (no network, the session ended, a cancellation) the
     * rest are not sent and carry that failure: a dozen timeouts in a row would only keep the
     * person waiting.
     */
    public static func oneAfterAnother<Item: Sendable, Value: Sendable>(
        _ items: [Item], _ send: @Sendable (Item) async throws -> Value
    ) async -> [Result<Value, Error>] {
        var outcomes: [Result<Value, Error>] = []
        var stopped: Error?
        for item in items {
            if let stopped { outcomes.append(.failure(stopped)); continue }
            do {
                outcomes.append(.success(try await send(item)))
            } catch {
                outcomes.append(.failure(error))
                let kind = failure(of: error)
                if ErrorWords.isCancellation(error) || kind == .offline || kind == .signedOut { stopped = error }
            }
        }
        return outcomes
    }

    /*
     * Each item trashed, and `moved` told of it only once its trash came back (`Vault.trashMany`'s
     * body). Telling first would take a row off the lists that the server then refused to move.
     */
    public static func trashEach(
        _ ids: [String], trash: @escaping @Sendable (String) async throws -> Void, moved: @escaping @Sendable (String) async -> Void
    ) async -> [Result<Void, Error>] {
        await oneAfterAnother(ids) { id in
            try await trash(id)
            await moved(id)
        }
    }

    /*
     * Why the rest didn't move, in words of our own: the server's sentence is never shown here.
     * `unconfirmed` is a gateway's 502 or 504, or an item a batch's answer left out: the request
     * may have landed, as it may have when there was no answer at all, so neither is ever said to
     * have "stayed". `busy`, `tooMany` and `tooLarge` refused a whole batch request before
     * anything moved. `alreadyTrashed` is an item the server refused as in the trash already
     * (itself or through a folder): it didn't move, but it didn't stay where it was either.
     */
    public enum Failure: Sendable, Equatable { case offline, unconfirmed, signedOut, busy, tooMany, tooLarge, alreadyTrashed, other }

    public static func failure(of error: Error) -> Failure {
        if endsSession(error) { return .signedOut }
        if let refusal = error as? RequestRefusal {
            switch refusal {
            case .busy: return .busy
            case .tooMany: return .tooMany
            case .tooLarge: return .tooLarge
            }
        }
        if case DriveAPIError.transport = error { return .offline }
        if error is URLError { return .offline }
        if case AuthError.message(let text) = error, text == AuthError.unreachable { return .offline }
        if case DriveAPIError.server(let status, _) = error, status == 502 || status == 504 { return .unconfirmed }
        if case DriveAPIError.trashed = error { return .alreadyTrashed }
        return .other
    }

    /*
     * `moved` is every item now in the trash, those that went with a folder included: what the
     * count says. `undoable` is what reached the trash on its own, exactly what Undo puts back
     * (the rest come back with their folders).
     */
    public struct Outcome {
        public let tried: [Opened]
        public let moved: [Opened]
        public let failed: [(item: Opened, error: Error)]
        public var undoable: [Opened] = []

        /*
         * What the server said was in the trash already: not moved, but not where the list shows
         * it either (another device trashed it), so its row leaves the lists too.
         */
        public var alreadyTrashed: [Opened] { failed.filter { TrashBatch.failure(of: $0.error) == .alreadyTrashed }.map(\.item) }

        /* The folders whose listings changed: each read once after the batch, never once per item. */
        public var folders: Set<String> { Set((moved + alreadyTrashed).compactMap(\.node.parentId)) }

        /*
         * The reason the notice gives: signed out when any was; offline only when every failure
         * was; unconfirmed when any may have landed (offline or a gateway error); else a refusal.
         */
        public var failure: Failure? {
            guard !failed.isEmpty else { return nil }
            let kinds = failed.map { TrashBatch.failure(of: $0.error) }
            if kinds.contains(.signedOut) { return .signedOut }
            if kinds.allSatisfy({ $0 == .offline }) { return .offline }
            if kinds.contains(where: { $0 == .offline || $0 == .unconfirmed }) { return .unconfirmed }
            for refused in [Failure.busy, .tooMany, .tooLarge] where kinds.contains(refused) { return refused }
            if kinds.allSatisfy({ $0 == .alreadyTrashed }) { return .alreadyTrashed }
            return .other
        }

        /*
         * What the notice says: only what moved is counted. Nil when the one item asked for failed,
         * whose error is reported the way a single write's always was. Without an answer a request
         * may still have landed, so offline says "weren't confirmed", never "stayed": the next sync
         * takes off any row the server did move.
         */
        public var notice: String? {
            guard let failure else { return moved.count == 1 ? "Moved “\(moved[0].name)” to Trash" : "Moved \(moved.count) items to Trash" }
            if tried.count == 1 { return nil }
            if moved.isEmpty {
                switch failure {
                case .offline: return "Couldn’t move to Trash. You’re offline. Try again once you’re connected."
                case .unconfirmed: return "Couldn’t move to Trash. HushOS didn’t confirm it. Try again."
                case .signedOut: return "Couldn’t move to Trash. Sign in again, then try again."
                case .other: return "Couldn’t move to Trash. Try again."
                case .alreadyTrashed: return "Couldn’t move to Trash. They’re in Trash already."
                case .busy: return "Couldn’t move to Trash. " + RequestRefusal.busy.words
                case .tooMany: return "Couldn’t move to Trash. " + RequestRefusal.tooMany.words
                case .tooLarge: return "Couldn’t move to Trash. " + RequestRefusal.tooLarge.words
                }
            }
            let count = "\(moved.count) of \(tried.count) moved to Trash. "
            switch failure {
            case .offline: return count + "You’re offline, so the rest weren’t confirmed."
            case .unconfirmed: return count + "The rest weren’t confirmed. Try again."
            case .signedOut: return count + "Sign in again to move the rest."
            case .other: return count + "The rest stayed where they were. Try again."
            case .alreadyTrashed: return count + "The rest were in Trash already."
            case .busy: return count + RequestRefusal.busy.words
            case .tooMany: return count + RequestRefusal.tooMany.words
            case .tooLarge: return count + RequestRefusal.tooLarge.words
            }
        }
    }

    public struct Steps {
        /*
         * The whole batch in one call (`Vault.trashMany`): one outcome per item, in order (how it
         * went, or why not), and `moved` told of what a request moved the moment its answer lands.
         */
        public var send: @Sendable ([Opened], _ moved: @escaping @Sendable ([Opened]) async -> Void) async -> [Result<Move, Error>]
        /*
         * Takes confirmed rows off every list, a request's worth at once as its answer lands (one
         * update for 200 rows, not 200: each update redraws the list).
         */
        public var drop: @MainActor @Sendable ([Opened]) -> Void
        /* The notice; the closure brings back exactly what moved, and is nil when nothing did. */
        public var announce: @MainActor (String, (@MainActor () -> Void)?) -> Void
        /* What the notice's Undo runs, with exactly the items that moved. */
        public var restore: @MainActor ([Opened]) -> Void
        /* The feed, the listings and Files, once for the batch and in the background. */
        public var settle: @MainActor (Set<String>) -> Void

        public init(
            send: @escaping @Sendable ([Opened], _ moved: @escaping @Sendable ([Opened]) async -> Void) async -> [Result<Move, Error>],
            drop: @escaping @MainActor @Sendable ([Opened]) -> Void,
            announce: @escaping @MainActor (String, (@MainActor () -> Void)?) -> Void,
            restore: @escaping @MainActor ([Opened]) -> Void,
            settle: @escaping @MainActor (Set<String>) -> Void
        ) {
            self.send = send
            self.drop = drop
            self.announce = announce
            self.restore = restore
            self.settle = settle
        }
    }

    /*
     * Each row leaves the lists as the server confirms it; after the last answer come the notice
     * and one follow-up that runs on its own.
     */
    @MainActor
    public static func trash(_ items: [Opened], _ steps: Steps) async -> Outcome {
        let drop = steps.drop
        let outcomes = await steps.send(items) { landed in await drop(landed) }
        precondition(outcomes.count == items.count, "One outcome per item")
        var moved: [Opened] = []
        var undoable: [Opened] = []
        var failed: [(item: Opened, error: Error)] = []
        for (item, outcome) in zip(items, outcomes) {
            switch outcome {
            case .success(let how):
                moved.append(item)
                if how == .trashed { undoable.append(item) }
            case .failure(let error): failed.append((item, error))
            }
        }
        let result = Outcome(tried: items, moved: moved, failed: failed, undoable: undoable)
        let restore = steps.restore
        let back = undoable
        var undo: (@MainActor () -> Void)?
        if !back.isEmpty { undo = { restore(back) } }
        // In the trash already (trashed elsewhere): the row goes as a moved one would, and its folder is read again.
        let elsewhere = result.alreadyTrashed
        if !elsewhere.isEmpty { drop(elsewhere) }
        if let notice = result.notice { steps.announce(notice, undo) }
        if !moved.isEmpty || !elsewhere.isEmpty { steps.settle(result.folders) }
        return result
    }

    /*
     * After the notice's Undo: each row that came back goes into its folder's list, if that folder
     * is on screen, once, in list order; rows that didn't come back stay out. Every row that came
     * back leaves the Trash list, which may be open under the notice.
     */
    public static func afterUndo(
        _ back: [Opened], folders: [String: [Opened]], trash: [(item: Opened, parentTrashed: Bool)]
    ) -> (folders: [String: [Opened]], trash: [(item: Opened, parentTrashed: Bool)]) {
        var rows = folders
        for item in back {
            guard let parent = item.node.parentId, let list = rows[parent], !list.contains(where: { $0.id == item.id }) else { continue }
            rows[parent] = (list + [item]).sorted(by: Opened.byName)
        }
        let backIds = Set(back.map(\.id))
        return (rows, trash.filter { !backIds.contains($0.item.id) })
    }

    /* What an Undo of many says when not everything came back; nil when it all did, or for one item (its error says it). */
    public static func undoProblem(back: Int, tried: Int, errors: [Error] = []) -> String? {
        if tried <= 1 || back == tried { return nil }
        // A whole request turned away says why, in the web's words; the rest are still in Trash.
        let refused = errors.lazy.compactMap { ($0 as? RequestRefusal)?.words }.first
        guard let refused else {
            return back == 0 ? "Couldn’t bring them back. They’re still in Trash." : "\(back) of \(tried) are back. The rest are still in Trash."
        }
        return (back == 0 ? "Couldn’t bring them back. " : "\(back) of \(tried) are back. ") + refused + " The rest are still in Trash."
    }

    // MARK: The batch routes

    /* The most ids one trash-batch or restore-batch request names (packages/drive/src/protocol.ts). */
    public static let maxBatch = 200

    /* One item's answer in a batch request. */
    public enum Answer: Sendable, Equatable {
        case trashed(id: String, changeSeq: Int)
        case covered(id: String, by: String)
        case restored(id: String, changeSeq: Int)
        case refused(id: String, reason: String, message: String)

        public var id: String {
            switch self {
            case .trashed(let id, _), .covered(let id, _), .restored(let id, _), .refused(let id, _, _): return id
            }
        }
    }

    /*
     * How an item reached the trash: on its own (Undo brings it back), or with a folder that went
     * (`covered`, or a selected folder it sits in, which is all that was sent): it is in the trash,
     * so it counts as moved, and it comes back with that folder, never on its own. An item refused
     * as `trashed` (already there, itself or through a folder) did not move, as the web counts it.
     */
    public enum Move: Sendable, Equatable { case trashed, withFolder }

    /* A server without the batch routes (an older self-hosted one): one request an item instead. */
    public struct Unsupported: Error {}

    /* A whole batch request refused before anything moved, in the web's words. */
    public enum RequestRefusal: Error, WordedError, Sendable {
        case busy, tooMany, tooLarge

        public var words: String {
            switch self {
            case .busy: return "Too many changes are being made here at once. Please try again."
            case .tooMany: return "Too many requests. Please try again shortly."
            case .tooLarge: return "That’s too many items for one request. Select fewer and try again."
            }
        }
        public var errorDescription: String? { words }
    }

    /* No answer for an item in a batch that did answer: its outcome isn't known, as with a lost response. */
    public static let unanswered = DriveAPIError.server(502, "HushOS didn’t say what happened to this item.")

    /* What a refusal is, as the single route's error would have been. */
    static func refused(_ reason: String, _ message: String) -> Error {
        switch reason {
        case "not-found": return DriveAPIError.notFound(message)
        case "trashed": return DriveAPIError.trashed(message)
        case "forbidden", "removed": return DriveAPIError.forbidden(message)
        default: return DriveAPIError.server(409, message)
        }
    }

    /*
     * A batch route's reply, read: the answers, or the error the whole request failed with. A
     * server without the route answers 501 `unsupported`, or a 404 that isn't the drive's own
     * `not-found` (one from before servers said `unsupported`): Unsupported, so the caller falls
     * back. A busy workspace (409 `conflict`), the rate limit (429) and the body cap (413) are
     * RequestRefusal, never retried here.
     */
    public static func answers(status: Int, data: Data) throws -> [Answer] {
        if status == 401 { throw DriveAPIError.notAuthenticated }
        let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard (200 ..< 300).contains(status) else {
            let message = body?["message"] as? String
            let code = body?["code"] as? String
            if status == 501 || (status == 404 && code != "not-found") { throw Unsupported() }
            if status == 404 { throw DriveAPIError.notFound(message ?? "This item no longer exists.") }
            if status == 409, code == "conflict" { throw RequestRefusal.busy }
            if status == 429 { throw RequestRefusal.tooMany }
            if status == 413 { throw RequestRefusal.tooLarge }
            throw DriveAPIError.server(status, message ?? DriveAPIError.noReply)
        }
        // An answer that can't be read says nothing about what moved: unconfirmed, as no answer would be.
        guard let results = body?["results"] as? [[String: Any]] else { throw unanswered }
        return results.compactMap { item in
            guard let id = item["id"] as? String else { return nil }
            switch item["status"] as? String {
            case "trashed": return .trashed(id: id, changeSeq: item["changeSeq"] as? Int ?? 0)
            case "covered": return .covered(id: id, by: item["by"] as? String ?? "")
            case "restored": return .restored(id: id, changeSeq: item["changeSeq"] as? Int ?? 0)
            default: return .refused(id: id, reason: item["reason"] as? String ?? "", message: item["message"] as? String ?? "That didn’t move.")
            }
        }
    }

    /* A failure every later request would share: no network (or no answer), the session ended, a cancellation. */
    static func stops(_ error: Error) -> Bool {
        let kind = failure(of: error)
        return ErrorWords.isCancellation(error) || kind == .offline || kind == .signedOut
    }

    /* The ids by workspace, in the order given, each workspace's in chunks of maxBatch. */
    static func chunks(_ items: [(id: String, workspace: String)]) -> [(workspace: String, indexes: [Int])] {
        var order: [String] = []
        var byWorkspace: [String: [Int]] = [:]
        for (index, item) in items.enumerated() {
            if byWorkspace[item.workspace] == nil { order.append(item.workspace) }
            byWorkspace[item.workspace, default: []].append(index)
        }
        return order.flatMap { workspace in
            let indexes = byWorkspace[workspace]!
            return stride(from: 0, to: indexes.count, by: maxBatch).map { (workspace, Array(indexes[$0 ..< min($0 + maxBatch, indexes.count)])) }
        }
    }

    /*
     * Moves (id, workspace) pairs to the trash through trash-batch: one outcome per item, in the
     * order given, and `moved` told of what each request moved as its answer lands. An item inside
     * another selected item (`ancestors`: the folders it sits in, as far as this device knows) is
     * never sent, as the web leaves it out: trashed on its own it would come back on Undo without
     * its folder. It moves with its folder, landing with that folder's request, or stays with its
     * folder's failure. A request that fails as a whole fails its items with its error; no network,
     * an ended session or a cancellation fails the rest unsent. `sequential` is the per-item route,
     * for a server without the batch one; from then on every remaining chunk goes that way, and it
     * tells `moved` and `forget` of each item itself, in that order. `forget` hears ids only after
     * `moved` returned: the lists let go of a row first, or a row still on screen whose node is
     * gone is looked up again (a thumbnail, a listing).
     */
    public static func trashInBatches(
        _ items: [(id: String, workspace: String)],
        send: @Sendable (String, [String]) async throws -> [Answer],
        sequential: @Sendable ([String]) async -> [Result<Move, Error>],
        ancestors: @Sendable (String) -> [String] = { _ in [] },
        forget: @Sendable ([String]) async -> Void = { _ in },
        moved: @Sendable ([(id: String, how: Move)]) async -> Void
    ) async -> [Result<Move, Error>] {
        var outcomes = [Result<Move, Error>?](repeating: nil, count: items.count)
        let picked = Set(items.map(\.id))
        // The selected folders each item sits in; the roots, inside none of them, are all that is sent.
        let within = items.map { item in Array(Set(ancestors(item.id).filter { $0 != item.id && picked.contains($0) })) }
        let roots = items.indices.filter { within[$0].isEmpty }
        var rootOutcome: [String: Result<Move, Error>] = [:]
        // The nested items a request's roots took with them, landing with that request.
        func carried(_ landedRoots: Set<String>) -> [(id: String, how: Move)] {
            var out: [(id: String, how: Move)] = []
            for index in items.indices where outcomes[index] == nil && within[index].contains(where: landedRoots.contains) {
                outcomes[index] = .success(.withFolder)
                out.append((items[index].id, .withFolder))
            }
            return out
        }
        func settle(_ index: Int, _ outcome: Result<Move, Error>) {
            outcomes[index] = outcome
            rootOutcome[items[index].id] = outcome
        }
        var stopped: Error?
        var perItem = false
        let rootItems = roots.map { items[$0] }
        for (workspace, chunk) in chunks(rootItems) {
            let indexes = chunk.map { roots[$0] }
            let ids = indexes.map { items[$0].id }
            if let stopped { for index in indexes { settle(index, .failure(stopped)) }; continue }
            if !perItem {
                do {
                    let answers = try await send(workspace, ids)
                    let byId = Dictionary(answers.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
                    var landed: [(id: String, how: Move)] = []
                    for index in indexes {
                        let id = items[index].id
                        let outcome: Result<Move, Error>
                        switch byId[id] {
                        case .trashed?: outcome = .success(.trashed)
                        case .covered?: outcome = .success(.withFolder)
                        case .refused(_, let reason, let message)?: outcome = .failure(refused(reason, message))
                        case .restored?, nil: outcome = .failure(unanswered)
                        }
                        settle(index, outcome)
                        if case .success(let how) = outcome { landed.append((id, how)) }
                    }
                    landed += carried(Set(landed.map(\.id)))
                    if !landed.isEmpty {
                        await moved(landed)
                        await forget(landed.map(\.id))
                    }
                    continue
                } catch is Unsupported {
                    perItem = true
                } catch {
                    for index in indexes { settle(index, .failure(error)) }
                    if stops(error) { stopped = error }
                    continue
                }
            }
            for (at, outcome) in await sequential(ids).enumerated() {
                settle(indexes[at], outcome)
                if case .failure(let error) = outcome, stops(error) { stopped = error }
            }
            let carriedHere = carried(Set(ids.filter { if case .success? = rootOutcome[$0] { true } else { false } }))
            if !carriedHere.isEmpty {
                await moved(carriedHere)
                await forget(carriedHere.map(\.id))
            }
        }
        // Nested items whose folders all failed stay where they are, with their folder's reason.
        for index in items.indices where outcomes[index] == nil {
            let reason = within[index].lazy.compactMap { id -> Error? in
                if case .failure(let error)? = rootOutcome[id] { return error } else { return nil }
            }.first
            outcomes[index] = .failure(reason ?? unanswered)
        }
        return outcomes.map { $0! }
    }

    /*
     * Undo for trashInBatches: puts back (id, workspace) pairs, in place, through restore-batch.
     * Folders go before what is in them (`depth`: how many of the given items an item sits
     * inside), since the server waits for a folder in the same request but not in a later one; an
     * item refused as `parent-trashed` is sent again once the other requests have landed, for as
     * long as that brings more back. One outcome per item, in the order given. `sequential` as for
     * trashInBatches.
     */
    public static func restoreInBatches(
        _ items: [(id: String, workspace: String)],
        depth: (String) -> Int,
        send: @Sendable (String, [String]) async throws -> [Answer],
        sequential: @Sendable ([String]) async -> [Result<Void, Error>]
    ) async -> [Result<Void, Error>] {
        var latest: [String: Result<Void, Error>] = [:]
        var waiting: Set<String> = []
        var stopped: Error?
        var perItem = false
        func pass(_ batch: [(id: String, workspace: String)]) async {
            for (workspace, chunk) in chunks(batch) {
                let ids = chunk.map { batch[$0].id }
                // Sent again now: whatever this request says decides whether it waits once more.
                waiting.subtract(ids)
                if let stopped { for id in ids { latest[id] = .failure(stopped) }; continue }
                if !perItem {
                    do {
                        let answers = try await send(workspace, ids)
                        let byId = Dictionary(answers.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
                        for id in ids {
                            switch byId[id] {
                            case .restored?: latest[id] = .success(())
                            case .refused(_, let reason, let message)?:
                                latest[id] = .failure(refused(reason, message))
                                if reason == "parent-trashed" { waiting.insert(id) }
                            default: latest[id] = .failure(unanswered)
                            }
                        }
                        continue
                    } catch is Unsupported {
                        perItem = true
                    } catch {
                        for id in ids { latest[id] = .failure(error) }
                        if stops(error) { stopped = error }
                        continue
                    }
                }
                for (at, outcome) in await sequential(ids).enumerated() {
                    latest[ids[at]] = outcome
                    if case .failure(let error) = outcome, stops(error) { stopped = error }
                }
            }
        }
        let depths = Dictionary(items.map { ($0.id, depth($0.id)) }, uniquingKeysWith: { a, _ in a })
        await pass(items.enumerated().sorted { (depths[$0.element.id]!, $0.offset) < (depths[$1.element.id]!, $1.offset) }.map(\.element))
        while !waiting.isEmpty, stopped == nil {
            let before = latest.values.filter { if case .success = $0 { true } else { false } }.count
            await pass(items.filter { waiting.contains($0.id) })
            let after = latest.values.filter { if case .success = $0 { true } else { false } }.count
            if after <= before { break }
        }
        return items.map { latest[$0.id]! }
    }
}

extension NodeView {
    /* The row out of the trash, as a restore-batch answer leaves it: the same envelopes, a new change number. */
    func restored(changeSeq: Int) -> NodeView {
        var row = NodeView(
            id: id, workspaceId: workspaceId, parentId: parentId, kind: kind, keyEpoch: keyEpoch, parentKeyEpoch: parentKeyEpoch,
            keyEnvelope: keyEnvelope, metadataVersion: metadataVersion, metadataEnvelope: metadataEnvelope, currentVersion: currentVersion,
            trashedAt: nil, changeSeq: changeSeq, createdAt: createdAt, updatedAt: updatedAt
        )
        row.envelopeSuite = envelopeSuite
        row.metadataSigner = metadataSigner
        row.metadataSignature = metadataSignature
        row.metadataRekey = metadataRekey
        row.prevKeyEnvelope = prevKeyEnvelope
        row.prevKeyEpoch = prevKeyEpoch
        row.prevParentKeyEpoch = prevParentKeyEpoch
        return row
    }
}
