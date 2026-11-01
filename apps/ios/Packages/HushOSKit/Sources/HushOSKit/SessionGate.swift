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
/*
 * Overlapping listings of one folder (a tick, a pull, a sync's relist): each is numbered as it
 * starts, and the one begun last is what shows, so an older listing that lands late never puts
 * back older rows (and verdicts keyed to the newer ones).
 */
public struct ListingOrder: Sendable {
    private var started: UInt64 = 0
    private var shown: [String: UInt64] = [:]
    public init() {}

    /* A listing starting now: its number. */
    public mutating func begin() -> UInt64 {
        started += 1
        return started
    }

    /* Whether a listing begun as `ticket` may show for `folder` (its rows or its failure): never one begun before the last shown. */
    public mutating func admits(_ ticket: UInt64, of folder: String) -> Bool {
        guard ticket > shown[folder, default: 0] else { return false }
        shown[folder] = ticket
        return true
    }
}

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

    /*
     * A judgement begun under `trust`, published; false, and nothing changed, when the family's
     * trust moved since. A row's judgement for an older version than the one held (two listings
     * overlapping, the older landing last) is dropped: the newer one's mark and lines stand.
     */
    @discardableResult
    public mutating func publish(_ groupId: String, trust: Trust, _ judged: [(ref: NodeRef, node: NodeView, verdict: FamilyVerdict)]) -> Bool {
        guard trust == capture(groupId) else { return false }
        for row in judged {
            if let held = rows[row.ref]?.node, Self.older(row.node, than: held) { continue }
            rows[row.ref] = Entry(node: row.node, verdict: row.verdict, groupId: groupId.lowercased())
        }
        return true
    }

    /* Whether `row` is an older version of the node than `held`: the server's change order first, then key epoch, then metadata version. */
    static func older(_ row: NodeView, than held: NodeView) -> Bool {
        if let a = row.changeSeq, let b = held.changeSeq, a != b { return a < b }
        if row.keyEpoch != held.keyEpoch { return row.keyEpoch < held.keyEpoch }
        return row.metadataVersion < held.metadataVersion
    }

    /*
     * Whether a family sync's outcome moves its trust generation: anything it found does, but no
     * answer at all says nothing new, and what was judged before stays on screen (read only).
     */
    public static func moves(after state: FamilyState) -> Bool {
        if case .failed(let words) = state, words == FamilyWords.noAnswer { return false }
        return true
    }

    /* A session ended: nothing of it stays, and nothing begun in it lands. */
    public mutating func reset() {
        epoch += 1
        rows = [:]
    }
}

/*
 * Whether a family folder's listing that was out may land: each family's clears (a removal, a
 * fork, a refusal, a guard that couldn't be stored) are counted, and a listing begun before one,
 * or answering while the family isn't open (accepted, or still shown read only with no answer),
 * is dropped rather than undoing the clear. A folder of no family always lands.
 */
public struct FamilyListings: Sendable {
    public struct Mark: Sendable, Equatable {
        let groupId: String?
        let clears: UInt64
    }

    private var clears: [String: UInt64] = [:]

    public init() {}

    public func mark(_ groupId: String?) -> Mark { Mark(groupId: groupId?.lowercased(), clears: groupId.map { clears[$0.lowercased(), default: 0] } ?? 0) }

    public mutating func cleared(_ groupId: String) { clears[groupId.lowercased(), default: 0] += 1 }

    /* `admits` against the families' states as shown, by the mark's own family. */
    public func admits(_ mark: Mark, states: [String: FamilyState]) -> Bool {
        let state = mark.groupId.flatMap { id in states[id] ?? states.first { $0.key.lowercased() == id }?.value }
        return admits(mark, state: state)
    }

    public func admits(_ mark: Mark, state: FamilyState?) -> Bool {
        guard let groupId = mark.groupId else { return true }
        guard clears[groupId, default: 0] == mark.clears else { return false }
        switch state {
        case .accepted: return true
        case .failed(let words): return words == FamilyWords.noAnswer
        default: return false
        }
    }
}
