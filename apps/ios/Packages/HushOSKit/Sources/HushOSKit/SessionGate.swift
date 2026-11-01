import Foundation

/*
 * Work that belongs to the session it began in (the vault it read through), as Android's
 * SessionGate: an operation captures its session once, at its outermost entry (`begin`), and
 * passes that token down. A request never starts for a session that has ended or changed, and
 * what it answers (rows, a refusal, a 401) comes back only while that session is still the
 * current one, so a new session never shows the last one's families and a late "signed out"
 * never ends it. Every step after a suspension checks the same token (`current`). `reset` moves
 * the generation on and cancels everything still running.
 */
@MainActor
public final class SessionGate<Owner: AnyObject & Sendable> {
    /* Where an operation began: its session's owner, and the gate's generation then. */
    public struct Token: Sendable, Equatable {
        public let owner: Owner
        let generation: UInt64

        public static func == (a: Token, b: Token) -> Bool { a.owner === b.owner && a.generation == b.generation }
    }

    private var generation: UInt64 = 0
    private var running: [UUID: @Sendable () -> Void] = [:]
    /* The session's owner now; nil when there is none. */
    public var session: () -> Owner?

    public init(session: @escaping () -> Owner? = { nil }) { self.session = session }

    /* The session now, as the token every later step checks; nil without one. */
    public func begin() -> Token? { session().map { Token(owner: $0, generation: generation) } }

    /* Whether work that began at `token` still belongs to the session now. */
    public func current(_ token: Token) -> Bool { token.generation == generation && session() === token.owner }

    /* The session ended, or is replaced: nothing that began before it lands, and what runs is cancelled. */
    public func reset() {
        generation += 1
        let cancels = running.values
        running = [:]
        for cancel in cancels { cancel() }
    }

    /*
     * `work` against the token's own owner, its answer or failure; nil when that session ended
     * or changed before the work could start, or before it answered. Cancelling the caller
     * cancels the work too.
     */
    public func run<T: Sendable>(_ token: Token, _ work: @escaping @Sendable (Owner) async throws -> T) async -> Result<T, Error>? {
        guard current(token) else { return nil }
        let owner = token.owner
        let task = Task { () -> Result<T, Error> in
            do { return .success(try await work(owner)) } catch { return .failure(error) }
        }
        let id = UUID()
        running[id] = { task.cancel() }
        let result = await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
        running[id] = nil
        return current(token) ? result : nil
    }

    /* `run` for an operation of one step: its session is the one now. */
    public func run<T: Sendable>(_ work: @escaping @Sendable (Owner) async throws -> T) async -> Result<T, Error>? {
        guard let token = begin() else { return nil }
        return await run(token, work)
    }
}

/*
 * Each family item's verdict (its mark and Info lines), keyed by its row, under its family's
 * trust generation: moved by every family sync, clear and rejudge (one family) and by a trust
 * change (all of them, `moved(nil)`). A judgement captured under an older generation never
 * publishes, so a newer verdict can't be overwritten by an older judgement that finished last,
 * and an unchanged row can't keep a verdict its family's trust took back.
 */
public struct FamilyVerdictBook: Sendable {
    public struct Trust: Sendable, Equatable {
        let epoch: UInt64
        let generation: UInt64
    }

    private struct Entry: Sendable {
        let node: NodeView
        let verdict: FamilyVerdict
        let groupId: String
    }

    private var rows: [NodeRef: Entry] = [:]
    private var generations: [String: UInt64] = [:]
    private var epoch: UInt64 = 0

    public init() {}

    /* The verdict for this row as it is now; nil when not judged, or judged for another version of it. */
    public func verdict(of ref: NodeRef, node: NodeView) -> FamilyVerdict? {
        guard let entry = rows[ref], entry.node == node else { return nil }
        return entry.verdict
    }

    /* Whether a row holds any verdict (judged once per version of a row). */
    public func judged(_ ref: NodeRef, node: NodeView) -> Bool { verdict(of: ref, node: node) != nil }

    /* The family's trust generation now, for a judgement to publish under. */
    public func capture(_ groupId: String) -> Trust { Trust(epoch: epoch, generation: generations[groupId.lowercased(), default: 0]) }

    /* A family's trust moved (nil: every family's): its verdicts go, and judgements begun before never land. */
    public mutating func moved(_ groupId: String?) {
        if let groupId {
            let id = groupId.lowercased()
            generations[id, default: 0] += 1
            rows = rows.filter { $0.value.groupId != id }
        } else {
            epoch += 1
            rows = [:]
        }
    }

    /* A judgement begun under `trust`, published; false, and nothing changed, when the family's trust moved since. */
    @discardableResult
    public mutating func publish(_ groupId: String, trust: Trust, _ judged: [(ref: NodeRef, node: NodeView, verdict: FamilyVerdict)]) -> Bool {
        guard trust == capture(groupId) else { return false }
        for row in judged { rows[row.ref] = Entry(node: row.node, verdict: row.verdict, groupId: groupId.lowercased()) }
        return true
    }

    /* A session ended: nothing of it stays, and nothing begun in it lands. */
    public mutating func reset() {
        epoch += 1
        rows = [:]
    }
}
