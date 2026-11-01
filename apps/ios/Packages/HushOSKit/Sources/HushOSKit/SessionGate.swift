import Foundation

/*
 * Work that belongs to the session it began in (the vault it read through), as Android's
 * FamiliesModel gate: an answer, or a failure, that lands after the session ended or changed (a
 * sign-out, a deletion, the same account signed in again) is dropped before it touches anything,
 * so a new session never shows the last one's families and a late "signed out" never ends it.
 * `reset` moves the generation on and cancels everything still running.
 */
@MainActor
public final class SessionGate<Owner: AnyObject & Sendable> {
    /* Where a piece of work began: dropped unless the gate still holds it when the work answers. */
    public struct Ticket: Sendable, Equatable {
        let generation: UInt64
        let owner: ObjectIdentifier
    }

    private var generation: UInt64 = 0
    private var running: [UUID: @Sendable () -> Void] = [:]
    /* The session's owner now; nil when there is none. */
    public var session: () -> Owner?

    public init(session: @escaping () -> Owner? = { nil }) { self.session = session }

    /* The session as it stands, for work in several steps; nil without one. */
    public func ticket() -> Ticket? { session().map { Ticket(generation: generation, owner: ObjectIdentifier($0)) } }

    /* Whether work that began at `ticket` still belongs to the session now. */
    public func holds(_ ticket: Ticket) -> Bool {
        ticket.generation == generation && session().map(ObjectIdentifier.init) == ticket.owner
    }

    /* The session ended, or is replaced: nothing that began before it lands, and what runs is cancelled. */
    public func reset() {
        generation += 1
        let cancels = running.values
        running = [:]
        for cancel in cancels { cancel() }
    }

    /*
     * `work` with the session's owner, its answer or failure; nil when there is no session, or it
     * ended or changed before the work answered. Cancelling the caller cancels the work too.
     */
    public func run<T: Sendable>(_ work: @escaping @Sendable (Owner) async throws -> T) async -> Result<T, Error>? {
        guard let owner = session(), let ticket = ticket() else { return nil }
        let task = Task { () -> Result<T, Error> in
            do { return .success(try await work(owner)) } catch { return .failure(error) }
        }
        let id = UUID()
        running[id] = { task.cancel() }
        let result = await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
        running[id] = nil
        return holds(ticket) ? result : nil
    }
}
