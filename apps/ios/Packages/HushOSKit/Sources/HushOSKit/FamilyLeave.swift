import Foundation

/*
 * Leaving a family (route 20, docs/groups-mobile-plan.md iOS 4), as the web's family-leave.ts and
 * Android's FamilySync.leave: Leave family is offered unless the member list already shows the
 * server would refuse it, the server's refusals are said in the web's words, a plan this person
 * pays for that leaving ends is named and confirmed by id, and a leave that lands runs the
 * not-member wipe (keys, record, rows, copies), which keeps the settings pin and the family guard,
 * so a family that comes back is never taken as first use.
 */

/* A plan this person pays for that leaving ends at once (route 20's `ends-lapsed`, `data.plans`). */
public struct FamilyLapsedPlan: Sendable, Equatable, Codable {
    public let id: String
    public let name: String
    /* Paused; otherwise its payment didn't go through. */
    public let paused: Bool

    public init(id: String, name: String, paused: Bool) {
        self.id = id
        self.name = name
        self.paused = paused
    }

    /* `data.plans` as the server sends it: an entry without an id or a name is no plan. */
    static func list(in value: Any?) -> [FamilyLapsedPlan] {
        guard let entries = value as? [[String: Any]] else { return [] }
        return entries.compactMap { entry in
            guard let id = entry["id"] as? String, !id.isEmpty, let name = entry["name"] as? String, !name.isEmpty else { return nil }
            return FamilyLapsedPlan(id: id, name: name, paused: entry["standing"] as? String == "paused")
        }
    }

    /* "Family Pro (monthly)" → "Family Pro"; a neutral "Family plan" → "Family" (the web's planWord). */
    static func word(_ name: String) -> String {
        name.replacingOccurrences(of: #"\s*\((monthly|yearly|annual)\)\s*$"#, with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: #"\s+plan$"#, with: "", options: [.regularExpression, .caseInsensitive])
    }

    /* What ends when this person leaves, every plan named (the web's lapsedEndsWords for the one leaving). */
    public static func endsWhenYouLeave(family: String, plans: [FamilyLapsedPlan]) -> String {
        let several = plans.count > 1
        let names = plans.map { word($0.name) }.joined(separator: " and ") + (several ? " plans" : " plan")
        let how = several ? "which give nothing now" : (plans.first?.paused == true ? "which is paused" : "whose payment didn’t go through")
        let after = several ? "Nothing of them is refunded: no part of them is in use." : "Nothing of it is refunded: no part of it is in use."
        return "The \(names) for \(family), which you pay for and \(how), \(several ? "end" : "ends") at once when you leave. \(after)"
    }
}

public enum FamilyLeave {
    public static let organizerFirst = "Make someone else the organizer first."
    public static let managerFirst = "Let someone else manage the family first."
    public static let whatGoes = "You’ll lose the family folders. Your own files stay yours."

    /*
     * Why this person can't leave now, by the rule the server applies (the web's leaveBlocker), or
     * nil when Leave family can be offered: the family's only organizer or only manager can't, the
     * last one in it always can (that ends it). The server stays the judge.
     */
    public static func blocker(userId: String, members: [GroupDetail.Member]) -> String? {
        let active = members.filter { $0.state == "active" }
        guard let me = active.first(where: { $0.userId.lowercased() == userId.lowercased() }) else { return nil }
        let others = active.filter { $0.userId.lowercased() != me.userId.lowercased() }
        guard !others.isEmpty else { return nil }
        func holds(_ role: String) -> Bool { others.contains { $0.roles.contains(role) } }
        if me.roles.contains("billing"), !holds("billing") { return organizerFirst }
        if me.roles.contains("members"), !holds("members") { return managerFirst }
        return nil
    }

    /*
     * Whether Leave family is offered, and what its row says: held back only when the member list
     * (route 3) shows the server would refuse it. Members not loaded (a family whose check failed
     * or showed another history, after a cold start) is no reason to hold it back: route 20 decides
     * and its refusals are worded, so leaving stays possible from a family this phone refused.
     */
    public static func offered(userId: String, members: [GroupDetail.Member]?) -> (enabled: Bool, line: String) {
        guard let members, let reason = blocker(userId: userId, members: members) else { return (true, whatGoes) }
        return (false, reason)
    }

    /* The dialog's body: the only one left ends the family. */
    /*
     * The dialog's body. That leaving ends the family is said only when a member list was read and
     * names exactly one active member; members not loaded, or a list that failed to load, never
     * reads as alone.
     */
    public static func body(family: String, members: [GroupDetail.Member]?) -> String {
        guard let members, members.filter({ $0.state == "active" }).count == 1 else { return whatGoes }
        return "You’re the only one in \(family), so leaving ends it. \(whatGoes)"
    }

    /*
     * A refusal of route 20 in the web's words: the organizer's and the last manager's say what to
     * do first; a payer's is the server's own, which says where to cancel; anything else as any
     * family request's.
     */
    public static func words(_ error: Error) -> String {
        if let refused = error as? GroupsAPIError {
            switch refused.code {
            case "organizer": return organizerFirst
            case "last-holder": return managerFirst
            case "payer": return refused.message
            default: return refused.errorDescription ?? FamilyWords.error(error)
            }
        }
        return FamilyWords.error(error)
    }
}

extension FamilySync {
    public enum LeaveOutcome: Sendable {
        /* Left (or found already gone): what the wipe left of the family here, and whether leaving ended it. */
        case left(Revised, dissolved: Bool)
        /* Leaving ends these plans: named, then confirmed by id with the next press. */
        case endsLapsed([FamilyLapsedPlan])
        /* Refused: the words to show; everything on this device stays as it was. */
        case refused(String)
    }

    /*
     * Route 20, then the not-member wipe in the family's turn (removedNow). A not-member answer is a
     * leave that already happened. Any refusal keeps everything here. A 401 is thrown, as any
     * request's: the app asks whether the session ended.
     */
    public func leave(_ groupId: String, endsLapsed: [String]) async throws -> LeaveOutcome {
        guard FamilyRecords.valid(groupId) else { return .refused("Please try again.") }
        var dissolved = false
        do {
            dissolved = try await api.leave(groupId, endsLapsed: endsLapsed)
        } catch let error as GroupsAPIError where error.isNotMember {
            // Already out (left elsewhere, or removed): what this device holds goes as for a leave.
        } catch let error as GroupsAPIError where error.code == "ends-lapsed" && !error.plans.isEmpty {
            return .endsLapsed(error.plans)
        } catch let error as GroupsAPIError {
            return .refused(FamilyLeave.words(error))
        } catch let error as DriveAPIError {
            if case .notAuthenticated = error { throw error }
            return .refused(FamilyLeave.words(error))
        } catch {
            return .refused(FamilyLeave.words(error))
        }
        let removed = await removedNow(groupId)
        if case .wiped = removed.state { forgetSession(groupId) }
        return .left(removed, dissolved: dissolved)
    }
}

/*
 * The leave dialog's state, kept by the store rather than the screen, so a scene change or a
 * redraw keeps it as it was: open for a family, a leave in flight (`busy`), the plans an
 * `ends-lapsed` answer named, and a refusal's words. While a leave is in flight nothing asks,
 * dismisses or sends again: a second press sends nothing.
 */
public struct LeaveDialog: Sendable, Equatable {
    public let groupId: String
    public private(set) var busy = false
    public private(set) var plans: [FamilyLapsedPlan] = []
    public private(set) var error: String?

    public init(groupId: String) { self.groupId = groupId }

    /*
     * A press of Leave family: the plan ids to confirm, or nil when one is already in flight (nothing
     * is sent). Clears the last refusal.
     */
    public mutating func confirm() -> [String]? {
        guard !busy else { return nil }
        busy = true
        error = nil
        return plans.map(\.id)
    }

    /* What route 20 answered: true when the dialog is done (left), false when it stays open to say why or to confirm plans. */
    public mutating func answered(_ outcome: FamilySync.LeaveOutcome) -> Bool {
        busy = false
        switch outcome {
        case .left: return true
        case .endsLapsed(let named):
            plans = named
            return false
        case .refused(let words):
            error = words
            return false
        }
    }

    /* A leave that threw (a 401 the app follows, a failure said here). */
    public mutating func failed(_ words: String) {
        busy = false
        error = words
    }
}
