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
     * `unconfirmed` is a gateway's 502 or 504: the request may have landed behind it, as it may
     * have when there was no answer at all, so neither is ever said to have "stayed".
     */
    public enum Failure: Sendable, Equatable { case offline, unconfirmed, signedOut, other }

    public static func failure(of error: Error) -> Failure {
        if endsSession(error) { return .signedOut }
        if case DriveAPIError.transport = error { return .offline }
        if error is URLError { return .offline }
        if case AuthError.message(let text) = error, text == AuthError.unreachable { return .offline }
        if case DriveAPIError.server(let status, _) = error, status == 502 || status == 504 { return .unconfirmed }
        return .other
    }

    public struct Outcome {
        public let tried: [Opened]
        public let moved: [Opened]
        public let failed: [(item: Opened, error: Error)]

        /* The folders whose listings changed: each read once after the batch, never once per item. */
        public var folders: Set<String> { Set(moved.compactMap(\.node.parentId)) }

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
                }
            }
            let count = "\(moved.count) of \(tried.count) moved to Trash. "
            switch failure {
            case .offline: return count + "You’re offline, so the rest weren’t confirmed."
            case .unconfirmed: return count + "The rest weren’t confirmed. Try again."
            case .signedOut: return count + "Sign in again to move the rest."
            case .other: return count + "The rest stayed where they were. Try again."
            }
        }
    }

    public struct Steps {
        /*
         * The whole batch in one call (`Vault.trashMany`): one outcome per item, in order, and
         * `moved` told of each item the moment the server confirms it.
         */
        public var send: @Sendable ([Opened], _ moved: @escaping @Sendable (Opened) async -> Void) async -> [Result<Void, Error>]
        /* Takes one confirmed row off every list, as soon as the server confirms it. */
        public var drop: @MainActor @Sendable (Opened) -> Void
        /* The notice; the closure brings back exactly what moved, and is nil when nothing did. */
        public var announce: @MainActor (String, (@MainActor () -> Void)?) -> Void
        /* What the notice's Undo runs, with exactly the items that moved. */
        public var restore: @MainActor ([Opened]) -> Void
        /* The feed, the listings and Files, once for the batch and in the background. */
        public var settle: @MainActor (Set<String>) -> Void

        public init(
            send: @escaping @Sendable ([Opened], _ moved: @escaping @Sendable (Opened) async -> Void) async -> [Result<Void, Error>],
            drop: @escaping @MainActor @Sendable (Opened) -> Void,
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
        let outcomes = await steps.send(items) { item in await drop(item) }
        precondition(outcomes.count == items.count, "One outcome per item")
        var moved: [Opened] = []
        var failed: [(item: Opened, error: Error)] = []
        for (item, outcome) in zip(items, outcomes) {
            switch outcome {
            case .success: moved.append(item)
            case .failure(let error): failed.append((item, error))
            }
        }
        let result = Outcome(tried: items, moved: moved, failed: failed)
        let restore = steps.restore
        let back = moved
        var undo: (@MainActor () -> Void)?
        if !back.isEmpty { undo = { restore(back) } }
        if let notice = result.notice { steps.announce(notice, undo) }
        if !moved.isEmpty { steps.settle(result.folders) }
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
    public static func undoProblem(back: Int, tried: Int) -> String? {
        if tried <= 1 || back == tried { return nil }
        if back == 0 { return "Couldn’t bring them back. They’re still in Trash." }
        return "\(back) of \(tried) are back. The rest are still in Trash."
    }
}
