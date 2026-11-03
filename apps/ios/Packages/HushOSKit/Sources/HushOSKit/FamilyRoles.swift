import Foundation
import HushOSCore

/*
 * A manager's role changes and the organizer handover (docs/groups-mobile-plan.md iOS 5a part 2,
 * Android's #276, the web's MemberList): Let them manage the family / Stop them managing it
 * (route 18, the core's `roles_body`: granting seals the family's key to them, taking it away
 * replaces the key in the same call and seals the new one to every manager who stays), and Make
 * them the organizer (billing given to them, then let go of here, `handover_body`). Every call goes
 * through the outbox and the one staging gate (stageCall), as every roster call does:
 *
 * - Each attempt (a first one, a re-sign after another manager's win, a resumed handover) syncs
 *   the chain and checks the head first, then judges the freshly synced member list: a promotion
 *   asks for a check of their words (the manager rule, read again from the settings and this
 *   device's guard); billing is given only while this account still holds it and no other
 *   handover is left half done; the step down is only in favour of the person it was handed to.
 * - The handover is kept on this device before its first call (`markHandover`), so one the app
 *   was stopped in the middle of is finished at the next open (resumeOutbox → finishHandover).
 * - A sync that fails is a refusal, never a landing or an absence; not-member from anywhere is the
 *   removal path.
 */

/* What a role change or the organizer handover came to. */
public enum RoleEnd: Sendable, Equatable {
    case landed
    /* No definite answer yet: kept on this phone, sent again at the next open. */
    case pending(String)
    case refused(String)
    /* The manager rule: managing the family (or its billing) is given only after a check of their words. */
    case checkFirst
    /* An earlier change kept here is unresolved: nothing was staged (the gate), nothing kept for this one. */
    case waiting(String)
    case wiped
}

extension FamilySync {
    /* Who a kept call is about: the person let in, or whose roles change. */
    static func person(of route: ChainRoute) -> String? {
        switch route {
        case .admit(let userId), .member(let userId): return userId.lowercased()
        default: return nil
        }
    }

    /* Who else holds billing beside `me`, on a member list where `me` does too: a handover left half done. */
    public static func handoverToFinish(_ view: FamilyView, me: String) -> String? {
        let me = me.lowercased()
        guard view.members.contains(where: { $0.userId.lowercased() == me && $0.roles.contains("billing") }) else { return nil }
        return view.members.first { $0.userId.lowercased() != me && $0.roles.contains("billing") }?.userId.lowercased()
    }

    private func bills(_ view: FamilyView, _ id: String) -> Bool {
        view.members.contains { $0.userId.lowercased() == id.lowercased() && $0.roles.contains("billing") }
    }

    /* Let them manage the family (`grant`) or Stop them managing it (`take`), under the manager rule for a grant. */
    public func changeRole(_ summary: GroupSummary, userId person: String, first: String, change: MembersRole) async throws -> RoleEnd {
        try await exclusive(summary.id) { try await self.changeRoleInTurn(summary, person: person, first: first, change: change) }
    }

    private func changeRoleInTurn(_ summary: GroupSummary, person: String, first: String, change: MembersRole) async throws -> RoleEnd {
        try await removalLetsGo(summary.id) {
            try await self.callFor(summary, person: person, first: first, unchangedIsDone: false, check: change == .grant ? person : nil) { revision, kems in
                try self.ledger.rolesBody(me: try await self.vault.ownIdentities(), identity: try await self.vault.currentIdentityEnvelope(), groupId: summary.id,
                                          expectedRevision: revision, userId: person.lowercased(), change: change, kems: kems)
            }
        }
    }

    /*
     * Make them the organizer: billing given to them (under the same check a manager role takes),
     * and once that landed and the family was synced, let go of here. A handover to someone else
     * still unfinished is settled first (its kept calls sent, its last step taken), never replaced:
     * two handovers under way could leave two organizers; one that still waits refuses this one.
     * `names`: first names by user id, for the sentences about whoever else holds billing.
     */
    public func handOver(_ summary: GroupSummary, to: String, first: String, names: [String: String] = [:]) async throws -> RoleEnd {
        try await exclusive(summary.id) { try await self.handOverInTurn(summary, to: to.lowercased(), first: first, names: names) }
    }

    private func handOverInTurn(_ summary: GroupSummary, to: String, first: String, names: [String: String]) async throws -> RoleEnd {
        try await removalLetsGo(summary.id) {
            let groupId = summary.id
            let me = self.userId
            if let earlier = try self.records.handover(userId: me, groupId: groupId), earlier.to != to {
                let them = names[earlier.to] ?? "someone else"
                for kept in try self.records.outboxList(userId: me, groupId: groupId) {
                    guard let opened = try? self.ledger.outboxOpen(groupId: groupId, outboxId: kept.outboxId, userId: me, entry: kept.entry) else { continue }
                    let about = Self.person(of: Self.route(of: opened))
                    guard about == earlier.to || about == me.lowercased() else { continue }
                    if try await self.sendKept(groupId, outboxId: kept.outboxId, entry: kept.entry, only: nil) == .wiped { return .wiped }
                }
                let settled = try await self.finishHandover(groupId, names: names)
                if try self.records.handover(userId: me, groupId: groupId) != nil { return .refused("Finish handing over to \(them) first.") }
                if settled?.1 == .landed { return .refused("\(them) is the organizer now.") }
            }
            try self.records.markHandover(userId: me, groupId: groupId, to: to)
            return try await self.giveThenStepDown(summary, to: to, first: first, names: names)
        }
    }

    /*
     * Finish handing over to {first}: this account and they both hold billing (a handover whose
     * last step was refused, or never sent), and this account lets go of it now.
     */
    public func finishHandingOver(_ summary: GroupSummary, to: String, first: String, names: [String: String] = [:]) async throws -> RoleEnd {
        try await exclusive(summary.id) { try await self.finishHandingOverInTurn(summary, to: to.lowercased(), first: first, names: names) }
    }

    private func finishHandingOverInTurn(_ summary: GroupSummary, to: String, first: String, names: [String: String]) async throws -> RoleEnd {
        try await removalLetsGo(summary.id) { try await self.stepDown(summary, to: to, first: first, names: names) }
    }

    /*
     * A handover kept on this device whose calls are no longer waiting: billing given and still
     * held here, so this account lets go of it now; given and let go of, or never given (its
     * refusal was said with its call), and the record goes. Nil when it took no step. A pending or
     * waiting end keeps the record for the next open. Runs in the family's turn.
     */
    func finishHandover(_ groupId: String, names: [String: String]) async throws -> (String, RoleEnd)? {
        guard let kept = try records.handover(userId: userId, groupId: groupId), let summary = summaries[groupId] else { return nil }
        // Nothing new while any change is kept unresolved here (the gate would refuse it): the record waits for the next open.
        guard try records.outboxList(userId: userId, groupId: groupId).isEmpty else { return nil }
        // A sync that fails decides nothing: the record waits.
        guard case .accepted(let view)? = await syncInTurn(groupId) else { return nil }
        let first = names[kept.to] ?? "They"
        let end: RoleEnd
        if !bills(view, userId) {
            // Let go of already (here or on another device): done.
            try records.clearHandover(userId: userId, groupId: groupId)
            return nil
        } else if bills(view, kept.to) {
            end = try await stepDown(summary, to: kept.to, first: first, names: names)
        } else if !kept.staged {
            // Billing never staged for them (a change for them was still waiting): the handover goes on from its start.
            end = try await giveThenStepDown(summary, to: kept.to, first: first, names: names)
        } else {
            // Staged and ended without landing: its refusal was said with its call.
            try records.clearHandover(userId: userId, groupId: groupId)
            return nil
        }
        switch end {
        case .pending, .waiting, .wiped: break
        default: try records.clearHandover(userId: userId, groupId: groupId)
        }
        return (kept.to, end)
    }

    /*
     * The handover's two calls, its record kept: billing to them, the record marked staged once that
     * call is kept, then this account lets go of it. Pending (unanswered, or a change kept before it)
     * keeps the record for the next open; a refusal or a check asked for ends it.
     */
    private func giveThenStepDown(_ summary: GroupSummary, to: String, first: String, names: [String: String]) async throws -> RoleEnd {
        let me = userId.lowercased()
        let groupId = summary.id
        let given = try await callFor(summary, person: to, first: first, unchangedIsDone: true, check: to, before: { view in
            // Not the organizer any more (another device finished a handover, or this one's earlier step down landed):
            // billing is not this account's to give.
            if !self.bills(view, me) {
                let now = view.members.first { $0.roles.contains("billing") }?.userId.lowercased()
                throw StageRefused(words: "\(now.flatMap { names[$0] } ?? "Someone else") is the organizer now.")
            }
            // A handover left half done to someone else (here, or by another device meanwhile) ends this one.
            if let other = Self.handoverToFinish(view, me: me), other != to {
                throw StageRefused(words: "Finish handing over to \(names[other] ?? "them") first.")
            }
        }, kept: {
            try self.records.markHandover(userId: me, groupId: groupId, to: to, staged: true)
        }) { revision, kems in
            try self.ledger.handoverBody(me: try await self.vault.ownIdentities(), identity: try await self.vault.currentIdentityEnvelope(), groupId: groupId,
                                         expectedRevision: revision, step: .to(userId: to), kems: kems)
        }
        switch given {
        case .landed: return try await stepDown(summary, to: to, first: first, names: names)
        case .pending, .wiped: return given
        default:
            try records.clearHandover(userId: me, groupId: groupId)
            return given
        }
    }

    /*
     * The handover's second call: this account lets go of billing, only in favour of the person it
     * was handed to. On every freshly synced member list (a first attempt, a re-sign after `stale`)
     * they must still hold billing; moved to someone else meanwhile, this account stays the
     * organizer and is told who holds it now.
     */
    private func stepDown(_ summary: GroupSummary, to: String, first: String, names: [String: String]) async throws -> RoleEnd {
        let me = userId.lowercased()
        let groupId = summary.id
        let moved = Moved()
        let end = try await callFor(summary, person: me, first: first, unchangedIsDone: true, before: { view in
            if !self.bills(view, to) {
                let now = view.members.first { $0.userId.lowercased() != me && $0.roles.contains("billing") }?.userId.lowercased()
                let words = now.map { "\(names[$0] ?? "Someone else") is the organizer now." } ?? ManageWords.organizerFirst
                moved.words = words
                throw StageRefused(words: words)
            }
        }) { revision, kems in
            try self.ledger.handoverBody(me: try await self.vault.ownIdentities(), identity: try await self.vault.currentIdentityEnvelope(), groupId: groupId,
                                         expectedRevision: revision, step: .stepDown, kems: kems)
        }
        switch end {
        case .landed:
            try records.clearHandover(userId: me, groupId: groupId)
            return end
        case .refused(let words):
            try records.clearHandover(userId: me, groupId: groupId)
            if let words = moved.words { return .refused(words) }
            return .refused("\(first) is an organizer now, and so are you still: \(words)")
        default:
            return end
        }
    }

    /*
     * One role change of `person` through the outbox: an earlier one for them kept here goes first
     * (an unanswered one stays the only one), then the core's call is staged through the gate and
     * sent, and signed again over another manager's win (`stale`). `before` judges each freshly
     * synced member list (throw StageRefused to stop); `check`: a promotion's person, who must be
     * verified on this phone now. A change that no longer changes anything after a landing or a win
     * is done; `unchangedIsDone` says so from the start.
     */
    func callFor(_ summary: GroupSummary, person: String, first: String, unchangedIsDone: Bool, check: String? = nil,
                 before: ((FamilyView) throws -> Void)? = nil, kept: (() throws -> Void)? = nil,
                 build: (UInt64, [String: String]) async throws -> RosterCall) async throws -> RoleEnd {
        let groupId = summary.id
        let route = ChainRoute.member(userId: person.lowercased())
        var moved = unchangedIsDone
        for call in try records.outboxList(userId: userId, groupId: groupId) {
            switch try await sendKept(groupId, outboxId: call.outboxId, entry: call.entry, only: route) {
            case .other: continue
            case .landed, .stale: moved = true
            case .pending(let words): return .pending(words)
            case .refused(let words): return .refused(words)
            case .otherKeys: return .refused(ManageWords.unchanged)
            case .wiped: return .wiped
            }
        }
        for _ in 0 ..< 3 {
            let staged = try await stageCall(summary, kept: kept) { view, revision, kems in
                try before?(view)
                // Where they stand on this phone now, from the settings and the guard read together over the member list
                // just synced (the row's label may be old). A guard that can't be read throws: nothing is signed.
                if let check, try await self.memberStandings(view)[check.lowercased()] != .verified { throw CheckFirstNeeded() }
                return try await build(revision, kems)
            }
            switch staged {
            case .refused(let words): return .refused(words)
            case .checkFirst: return .checkFirst
            case .unchanged: return moved ? .landed : .refused(ManageWords.unchanged)
            case .wiped: return .wiped
            case .waiting: return .waiting(ManageWords.earlierWaiting(summary.name))
            case .call(let call):
                switch try await sendKept(groupId, outboxId: call.outboxId, entry: call.entry, only: nil) {
                case .landed: return .landed
                case .pending(let words): return .pending(words)
                case .refused(let words): return .refused(words)
                case .wiped: return .wiped
                case .otherKeys, .other: return .refused(ManageWords.unchanged)
                // Dropped and synced by the outbox: signed again over the new head.
                case .stale: moved = true
                }
            }
        }
        return .refused(ManageWords.keepsChanging(summary.name))
    }

    /* What the step down's judgement found, for after the call: billing moved to someone else meanwhile. */
    private final class Moved: @unchecked Sendable { var words: String? }

    /* A kept call's route, however the core judged it. */
    static func route(of opened: OutboxCall) -> ChainRoute {
        switch opened {
        case .send(_, let r, _), .hold(_, let r, _), .landed(_, let r), .superseded(_, let r): return r
        }
    }

    /* `body`, with a not-member answer from any of its reads let go of as a removal (published), then `wiped`. */
    private func removalLetsGo(_ groupId: String, _ body: () async throws -> RoleEnd) async throws -> RoleEnd {
        do {
            return try await body()
        } catch let error as GroupsAPIError where error.isNotMember {
            _ = await removedInTurn(groupId)
            return .wiped
        }
    }
}
