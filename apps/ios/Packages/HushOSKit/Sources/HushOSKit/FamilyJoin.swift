import Foundation
import HushOSCore

/*
 * Joining a family on this phone (docs/optional-verification.md 3.2, 3.3, 6.8): the newcomer's
 * side, the twin of the web's apps/web/src/lib/groups/join.ts over the core's join calls
 * (join.rs). Every rule is the core's; this file fetches, stores and keeps the order.
 *
 * 1. Invite, Join (accept): the newcomer waits. Nothing happens on this phone until route 2 says
 *    they were let in; `joinStatus` says waiting meanwhile.
 * 2. Then the phone joins on first use (`join_first_use`): the core verifies what route 5 serves
 *    from version 1, against every mark this phone and account hold (a rejoin's settings pin, this
 *    phone's family guard, which a `not-member` answer never clears); with none at all, over the
 *    served version 1 keys, only while this account's entry is active at the head and only with
 *    settings that opened here. Nothing is committed: the core seals a version 4 joins record of
 *    the head's pin, kept here before anything else.
 * 3. `accept_joining` with that record commits, holding its pin as one more mark, so a relaunch in
 *    between finishes against the same history rather than taking first use again over whatever is
 *    served then. Then the family guard, the device record, the folders and the settings pin are
 *    written, in that order, and the joins record goes.
 *
 * No words on either side: checking each other is for later, from the members list (FamilyCheck).
 * A version 3 joins record (a join code compared on an earlier release, mid-join) still finishes
 * as it would have; one that no longer holds goes, and the join is a first use.
 */

/* Where a join stands, as the web's JoinOutcome. */
public enum JoinOutcome: Sendable, Equatable {
    /* In: the family as the acceptance after the join left it (accepted, or the hard warning a settings pin raised). */
    case joined(FamilyState)
    /* This phone already holds the family: a member, nothing to join. */
    case member
    /* Not let in yet: route 2 is polled until the state is active. */
    case waiting
    /* This person's own marks disagree with what is served: the hard warning. */
    case fork(FamilyFork)
}

/* The join's own words, as the web's copy.ts and the join page say them. */
public enum JoinWords {
    /* The invitation for someone already in a family (one per account; the web's joinInFamilyCopy). */
    public static func inFamily(_ yours: String, invitedTo: String, expiresAt: String) -> String {
        "You’re in \(yours). To join \(invitedTo), leave yours first, from its page. This invitation stays open until \(day(expiresAt))."
    }

    /* "26 October", as the web's en-GB day and month. */
    static func day(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return iso }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_GB")
        formatter.setLocalizedDateFormatFromTemplate("d MMMM")
        return formatter.string(from: date)
    }

    /*
     * A refusal of the invitation routes, as the web's errorCopy words it for the join page; `family`
     * is the family invited to. Anything else is the families screens' usual wording.
     */
    public static func refusal(_ error: Error, family: String? = nil) -> String {
        guard let error = error as? GroupsAPIError, error.status != 0, let code = error.code else { return FamilyWords.error(error) }
        switch code {
        case "gone": return "This invitation is no longer open. Ask for a new one."
        case "email-mismatch": return "This invitation is for another email address. Sign in with that one."
        case "already-member": return "That person is already in the family."
        case "in-family":
            if error.reason == "newcomer" { return "They’ve joined another family since they accepted. They can join yours once they leave it." }
            return error.family.map { "You’re in \($0.name). Leave it before you create another." } ?? "You’re in a family already. Leave it before you create another."
        case "no-plan":
            return error.invitee
                ? "\(family ?? "This family") can’t take anyone new right now. Ask whoever invited you; this invitation works again once the family has a plan."
                : "Choose a plan for \(family ?? "this family") first. Until it has one, nobody can be invited and no family folders can be made."
        case "unsupported": return "Update HushOS to do this."
        case "rate-limited": return "That’s been tried too often. Wait a little, then try again."
        case "not-member": return "You’re not in this family any more."
        case "unavailable": return "HushOS couldn’t save that just now. Try again in a moment."
        default: return FamilyWords.error(error)
        }
    }
}

/*
 * What the invitation screen says under the invitation and whether Accept is offered, from route
 * 14's answer and route 15's refusal (the web's routes/join/route.tsx). One family per account:
 * someone in a family (as opening the invitation found it, or as accepting did) is told to leave
 * theirs first, and Accept is off; an `in-family` refusal that names no family (or names the
 * newcomer) is said in the web's error words, and Accept is off too (the web leaves it on, where
 * pressing it again only meets the same refusal).
 */
public struct InvitationNotice: Sendable, Equatable {
    public enum Note: Sendable, Equatable {
        /* Leave yours first: the words, and the family to open. */
        case inFamily(words: String, yours: Invitation.Family)
        case alreadyMember
        case problem(String)
    }
    public let note: Note?
    public let canAccept: Bool

    public static func of(_ invitation: Invitation, refusal: GroupsAPIError?, email: String?) -> InvitationNotice {
        let code = refusal?.code
        if let yours = invitation.inFamily ?? (code == "in-family" ? refusal?.family : nil) {
            return InvitationNotice(note: .inFamily(words: JoinWords.inFamily(yours.name, invitedTo: invitation.name, expiresAt: invitation.expiresAt), yours: yours),
                                    canAccept: false)
        }
        guard let refusal else { return InvitationNotice(note: nil, canAccept: true) }
        switch code {
        case "already-member":
            return InvitationNotice(note: .alreadyMember, canAccept: true)
        case "in-family":
            return InvitationNotice(note: .problem(JoinWords.refusal(refusal, family: invitation.name)), canAccept: false)
        case "email-mismatch":
            return InvitationNotice(note: .problem("This invitation is for another email address than \(email ?? "this one"). Sign in with that one."), canAccept: false)
        default:
            return InvitationNotice(note: .problem(JoinWords.refusal(refusal, family: invitation.name)), canAccept: true)
        }
    }
}

extension FamilySync {
    /*
     * Where this phone's join of `groupId` stands, for the join screen to resume at: waiting to be
     * let in, joined now (on first use, or a join a relaunch cut short, finished here), or `member`
     * when this phone already holds the family.
     */
    public func joinStatus(_ groupId: String) async throws -> JoinOutcome {
        guard let summary = try await admitted(groupId) else { return .waiting }
        try await vault.prepareLedger()
        // Kept before acceptance: a relaunch finishes from it.
        if let joins = records.read(.joins, userId: userId, groupId: groupId) {
            return try await completeJoin(summary, joins: joins)
        }
        if records.read(userId: userId, groupId: groupId) != nil { return .member }
        return try await joinOnFirstUse(summary)
    }

    /* Route 2's row for the family once it says active (let in); nil while it doesn't. */
    private func admitted(_ groupId: String) async throws -> GroupSummary? {
        guard FamilyRecords.valid(groupId) else { throw FamilyFailure(message: "Please try again.") }
        return try await list().first { $0.id == groupId && $0.state == "active" }
    }

    /* The first-use join over what route 5 serves now, in the family's turn. */
    private func joinOnFirstUse(_ summary: GroupSummary) async throws -> JoinOutcome {
        // Read first, so the ledger holds the settings' pin of the family (a rejoin's mark).
        _ = try await vault.familyPin(summary.id)
        return try await exclusive(summary.id) {
            if let before = try await self.finishedBefore(summary) { return before }
            return try await self.firstUse(summary.id, served: try await self.fetchServed(summary.id, after: 0))
        }
    }

    /* `join_first_use` over `served`, then its commit; for a caller already in the family's turn. */
    private func firstUse(_ groupId: String, served: ServedChain) async throws -> JoinOutcome {
        let me = try await vault.ownIdentities()
        while true {
            let joined = try ledger.joinFirstUse(me: me, groupId: groupId, record: records.read(userId: userId, groupId: groupId)?.envelope,
                                                 served: served, guard: await vault.heldFamilyGuard(groupId), now: Self.checkTime(now()))
            switch joined {
            case .recordUnreadable:
                records.delete(userId: userId, groupId: groupId)
                continue
            case .notAdmitted:
                // Active on route 2 but not on the member list it serves yet: still waiting.
                return .waiting
            case .fork(let of, let version, let sides):
                return .fork(Self.fork(of: of, version: version, sides: sides))
            case .ready(let matched, _):
                // Kept before acceptance: a relaunch between the two finishes from here.
                try records.put(.joins, userId: userId, groupId: groupId, matched.record())
                // The same served chain the record was just sealed over.
                return try await acceptJoin(groupId, served: served, matched: matched, orFirstUse: false)
            }
        }
    }

    /*
     * An earlier finish wrote the device record and stopped before the joins record went (the pin
     * not saved, no answer while opening the folders): the record is a mark now, so this is a sync,
     * and the joins record goes. With no device record, a join this session committed but couldn't
     * keep (its guard or record not stored) is let go of in the core first, storing the guard it
     * hands back, so the join runs again from a clean session; while that guard can't be stored,
     * that error is the answer. Nil when the join goes on.
     */
    private func finishedBefore(_ summary: GroupSummary) async throws -> JoinOutcome? {
        guard records.read(userId: userId, groupId: summary.id) != nil else {
            guard try await forgetInCore(summary.id) else { throw FamilyFailure(message: "The family could not be checked. Try again.") }
            return nil
        }
        switch await run(summary) {
        case .accepted(let view):
            records.delete(.joins, userId: userId, groupId: summary.id)
            return .joined(.accepted(view))
        case .fork(let fork):
            return .fork(fork)
        case .unchecked:
            // A record that did not open and no pin: the join goes on.
            return nil
        case .failed(let words):
            throw FamilyFailure(message: words)
        case .waiting, .wiped:
            return .waiting
        }
    }

    /* A relaunch finishing a join: from the joins record, against what route 5 serves now. */
    private func completeJoin(_ summary: GroupSummary, joins: String) async throws -> JoinOutcome {
        _ = try await vault.familyPin(summary.id)
        return try await exclusive(summary.id) {
            if let before = try await self.finishedBefore(summary) { return before }
            return try await self.resume(summary.id, joins: joins)
        }
    }

    private func resume(_ groupId: String, joins: String) async throws -> JoinOutcome {
        let served = try await fetchServed(groupId, after: 0)
        // Another account's, an older version's, or sealed under an earlier account root: it goes, and the join is a first use.
        guard let matched = try ledger.joinMatchedOpen(groupId: groupId, joinsRecord: joins) else {
            records.delete(.joins, userId: userId, groupId: groupId)
            return try await firstUse(groupId, served: served)
        }
        return try await acceptJoin(groupId, served: served, matched: matched, orFirstUse: true)
    }

    /*
     * The family taken with the joins record's pin as one more mark; then the family guard it hands
     * back (before anything else: a crash between it and the record leaves the guard above the
     * record, never below), the device record (never over a later one), the folders and the
     * settings pin as after any acceptance, and the joins record goes. A guard or record that
     * can't be kept lets the core go of the family too, or its chain would count as a mark this
     * phone can't show and a retry be refused.
     */
    private func acceptJoin(_ groupId: String, served first: ServedChain, matched: JoinMatched, orFirstUse: Bool) async throws -> JoinOutcome {
        let me = try await vault.ownIdentities()
        var served = first
        var overtaken = 0
        while true {
            // The write barrier, as for a sync's acceptance (FamilySync.accept).
            let owedBefore = await vault.oweFamilyGuard(groupId)
            let result: JoinAcceptance
            do {
                result = try ledger.acceptJoining(me: me, groupId: groupId, record: records.read(userId: userId, groupId: groupId)?.envelope,
                                                  served: served, matched: matched, guard: await vault.heldFamilyGuard(groupId))
            } catch {
                if !owedBefore { await vault.familyGuardKept(groupId) }
                throw error
            }
            if case .accepted = result {} else if !owedBefore { await vault.familyGuardKept(groupId) }
            switch result {
            case .recordUnreadable:
                records.delete(userId: userId, groupId: groupId)
                continue
            case .overtaken(let split):
                // Another acceptance moved the family on meanwhile: read the member list again, as a sync does.
                overtaken += 1
                if overtaken >= 3 { throw FamilyFailure(message: servedRaceMessage(split: split)) }
                served = try await fetchServed(groupId, after: 0)
                continue
            case .changed:
                // An earlier release's join code that no longer holds: it vouches for nothing here, and goes.
                records.delete(.joins, userId: userId, groupId: groupId)
                if orFirstUse { return try await firstUse(groupId, served: served) }
                throw FamilyFailure(message: "The family could not be checked. Try again.")
            case .notAdmitted:
                return .waiting
            case .fork(let of, let version, let sides):
                return .fork(Self.fork(of: of, version: version, sides: sides))
            case .accepted(let chain, let record, let pin, let guardPin):
                do {
                    if let guardPin { try await vault.keepFamilyGuard(groupId, guardPin) }
                    await vault.familyGuardKept(groupId)
                    try records.put(userId: userId, groupId: groupId, FamilyRecords.Row(envelope: record, rosterVersion: chain.roster().rosterVersion,
                                                                                        areas: provenAreas(groupId, of: Array(chain.areaKeys().keys))))
                } catch {
                    // A wipe the core refuses keeps its floor; the store's error is the answer.
                    _ = try? await forgetInCore(groupId)
                    throw error
                }
                noteAccepted(groupId, chain)
                let state = try await afterAcceptance(groupId, chain: chain, pin: pin, reset: false)
                if case .fork(let fork) = state { return .fork(fork) }
                records.delete(.joins, userId: userId, groupId: groupId)
                // An escalation an earlier release's join check left: nothing reads it now.
                records.delete(.holds, userId: userId, groupId: groupId)
                return .joined(state)
            }
        }
    }
}
