import Foundation
import os

/*
 * The family check that runs while the app is closed (docs/groups-mobile-plan.md iOS 4, owner
 * decision: a BGProcessingTask), as Android's FamilyWalkWork: route 2 and its removal check, each
 * family synced, and every walk this device has its own reason to run, to its end. The app's
 * scheduler (FamilyWalkTasks) runs one pass at a time against the session's vault and asks again
 * on `retry`.
 *
 * - Bound to its session: `current` (the vault still open and still the keychain's session) is
 *   asked before every step; a session that ended or changed ends the pass, touching nothing of the
 *   next one's.
 * - `checkStop` (the task expiring) is asked between families and walk batches, never while a
 *   batch's keys are pending, so a stopped pass has committed or dropped every key and released
 *   every lock.
 * - Only a confirmed not-member wipes; an unanswered or failed removal check keeps the pass coming
 *   back. No answer, 408, 429 and 5xx are worth another pass (FamilySync.transient).
 */
public enum FamilyWalkPass: Sendable, Equatable {
    case done
    /* Something is left to do or to confirm: run again soon. */
    case retry
    /* The session ended or changed meanwhile: nothing more of it runs. */
    case signedOut
    /* The task's time ran out between steps. */
    case stopped
}

/*
 * When to ask iOS to run the background check: iOS keeps one request for it, and a new one replaces
 * the last, so a later ask (the hourly check route 2 wants) must never push back an earlier one of
 * the same session (a stopped walk's retry), or closing the app would postpone the key change.
 */
public enum FamilyCheckSchedule {
    /*
     * The earliest begin to submit: `requested`, or the pending request's when it is earlier and
     * belongs to the same session. Another session's pending request says nothing about this one.
     */
    public static func earliest(requested: Date, session: String, pending: Date?, pendingSession: String?) -> Date {
        guard let pending, pendingSession == session else { return requested }
        return min(pending, requested)
    }
}

/* A pass whose session ended between steps (asked with the task's own stop check). */
struct SessionEndedMidPass: Error {}

/* What `checkStop` throws when the background task's time is up. */
public struct FamilyWalkStopped: Error, Sendable {
    public init() {}
}

/* Every family a sync let go of, for the screens (FamilySync.releases). */
public final class FamilyReleases: Sendable {
    public struct Release: Sendable {
        public let groupId: String
        public let revised: FamilySync.Revised
    }

    private let state = OSAllocatedUnfairLock(initialState: (queue: [Release](), listener: (@Sendable () -> Void)?.none))

    /* Whether a state lets the family go on this device: anything but an acceptance or no answer. */
    public static func letsGo(_ state: FamilyState) -> Bool {
        switch state {
        case .accepted: false
        case .failed(let words): words != FamilyWords.noAnswer
        default: true
        }
    }

    func post(_ groupId: String, _ revised: FamilySync.Revised) {
        let listener = state.withLock { state -> (@Sendable () -> Void)? in
            state.queue.append(Release(groupId: groupId, revised: revised))
            return state.listener
        }
        listener?()
    }

    /* Everything posted since the last take, oldest first. */
    public func take() -> [Release] { state.withLock { state in defer { state.queue = [] }; return state.queue } }

    /* Called after each post (on whatever thread posted): the screens take what came. */
    public func listen(_ listener: (@Sendable () -> Void)?) { state.withLock { $0.listener = listener } }
}

/* Whether the session's families need the background check: true schedules it, false lets it go. */
public final class FamilyWorkHook: Sendable {
    private let hook = OSAllocatedUnfairLock(initialState: (@Sendable (Bool) -> Void)?.none)

    public func set(_ hook: (@Sendable (Bool) -> Void)?) { self.hook.withLock { $0 = hook } }

    func call(_ wanted: Bool) { hook.withLock { $0 }?(wanted) }
}

extension FamilySync {
    /* Families this device holds a record of that route 2 doesn't list: their removal isn't settled until a not-member wipes them. */
    func unsettled(_ listed: [GroupSummary]) -> [String] {
        let shown = Set(listed.map { $0.id.lowercased() })
        return records.groups(userId: userId).filter { !shown.contains($0.lowercased()) }.sorted()
    }

    /*
     * One background pass. `current`: whether this pass's session still stands (asked before every
     * step). `checkStop`: throws FamilyWalkStopped once the task's time is up.
     */
    public func backgroundPass(current: @escaping @Sendable () -> Bool, checkStop: @escaping @Sendable () throws -> Void) async -> FamilyWalkPass {
        guard current() else { return .signedOut }
        // Between a walk's batches too: a session that ended mid-walk stops it there, as the task's time running out does.
        let stopOrEnded: @Sendable () throws -> Void = {
            try checkStop()
            if !current() { throw SessionEndedMidPass() }
        }
        do {
            let (listed, _, failed) = try await listReconciling()
            guard current() else { return .signedOut }
            var again = !unsettled(listed).isEmpty || !failed.isEmpty
            for summary in listed where summary.state == "active" {
                try checkStop()
                guard current() else { return .signedOut }
                let revised = await syncRevised(summary)
                guard current() else { return .signedOut }
                switch revised.state {
                case .failed:
                    // No answer, a wipe that couldn't finish, keys that didn't check: asked again on the next pass.
                    again = true
                case .accepted(let view):
                    for target in view.areas.compactMap(\.walkTarget) {
                        try checkStop()
                        guard current() else { return .signedOut }
                        do {
                            _ = try await walk(summary.id, target, checkStop: stopOrEnded)
                        } catch let error as FamilyWalkStopped {
                            throw error
                        } catch let error as SessionEndedMidPass {
                            throw error
                        } catch let error as DriveAPIError {
                            if case .notAuthenticated = error { throw error }
                            again = true
                        } catch {
                            again = true
                        }
                        guard current() else { return .signedOut }
                    }
                default:
                    break
                }
            }
            // Ended after the last step: nothing of it is rescheduled or let go of for the next session.
            guard current() else { return .signedOut }
            if listed.isEmpty, unsettled(listed).isEmpty, !again { wantWork(false) }
            return again ? .retry : .done
        } catch is SessionEndedMidPass {
            return .signedOut
        } catch is FamilyWalkStopped {
            return .stopped
        } catch let error as DriveAPIError {
            if case .notAuthenticated = error { return .signedOut }
            return Self.transient(error) ? .retry : .done
        } catch {
            return Self.transient(error) ? .retry : .done
        }
    }
}
