import Foundation
import HushOSCore

/*
 * Joining a family on this phone (docs/groups-mobile-plan.md, iOS 3): the newcomer's side, the
 * twin of the web's apps/web/src/lib/groups/join.ts over the core's join rules (Core 4, join.rs).
 * Every rule is the core's: which roster's code is shown, the two positions it hides (drawn by
 * the core from the system CSPRNG, kept only in the ledger), whether the typed words match, the
 * calm first wrong pair and the alarm after it, and whether the served chain still gives the
 * code. This file fetches, stores and keeps the order.
 *
 * 1. The newcomer reads their twelve words to the admin, who checks them and lets them in.
 *    Nothing happens on this phone meanwhile; `joinStatus` says waiting until route 2 says active.
 * 2. `joinStatus` then shows the code of the roster that let this account in, worked out over
 *    what route 5 serves from version 1, with the two positions the core drew. Nothing is kept,
 *    marked or committed, and the positions never leave the ledger: no request carries them.
 * 3. `confirmJoin` ("They match"): the code worked out again; another code keeps nothing and is
 *    the one to compare now. Then the typed words at the issued positions. The family's first
 *    wrong pair is `wrongWords` and holds that code's positions; any later wrong pair, for any
 *    code, is `mismatch`. What a check leaves comes back sealed (`holds`), is kept beside the
 *    family's record and passed back on the first showing after a relaunch or a new vault, so the
 *    same two words are asked and the alarm stays. On a match the core seals the joins record,
 *    kept before acceptance; the acceptance takes the family with the code as its join mark, then
 *    the device record, the folders and the settings pin are written as after any acceptance, and
 *    the joins record goes. "They don't match" keeps nothing and needs no call.
 *
 * The positions go into the ledger once per ledger: this sync is dropped with the ledger it
 * uses (`FamilySync.forget` clears the ledger and replaces the sync; a new vault brings a new
 * ledger and a new sync), so `restored` here is "once per unlock" as the app review rules ask.
 */

/* One showing of the join code: the twelve words, the two positions (0 to 11) the screen hides, and the core's showing to pass back. */
public struct JoinShowing: Sendable, Equatable {
    public let session: JoinSession
    public let rosterVersion: UInt64
    public let code: [String]
    public let hidden: [Int]

    init(_ session: JoinSession) {
        self.session = session
        rosterVersion = session.rosterVersion()
        code = session.code()
        hidden = session.hidden().map(Int.init)
    }

    public static func == (a: JoinShowing, b: JoinShowing) -> Bool {
        a.rosterVersion == b.rosterVersion && a.code == b.code && a.hidden == b.hidden
    }
}

/* Where a join stands, as the web's JoinOutcome. */
public enum JoinOutcome: Sendable, Equatable {
    /* In: the family as the acceptance after the join left it (accepted, or the hard warning a settings pin raised). */
    case joined(FamilyState)
    /* This phone already holds the family: a member, nothing to join. */
    case member
    /* Not let in yet: route 2 is polled until the state is active. */
    case waiting
    /* The code to compare. `changed`: a code compared earlier is not the one the served chain gives now, and nothing was kept. */
    case compare(JoinShowing, changed: Bool)
    /* The typed words are not the code's, the first time for this family: said calmly, never which. Nothing was kept. */
    case wrongWords
    /* A wrong pair again for this family: the alarm. Nothing was kept. */
    case mismatch
    /* This person's own marks disagree with what is served: the hard warning. */
    case fork(FamilyFork)
}

/* The join's own words, as the web's copy.ts and the join page say them. */
public enum JoinWords {
    /* The core's NOT_SHOWN and HOLDS_UNREADABLE (join.rs), matched exactly as the web matches them. */
    static let notShown = "Compare the join code again."
    static let holdsUnreadable = "This saved join check could not be opened on this account."
    public static let incomplete = "Type the two hidden words of the join code."

    /* After a wrong pair: the calm line, then (`again`) the alarm's, with the admin's first name. */
    public static func checkMessage(again: Bool, them: String) -> String { joinCheckMessage(again: again, them: them) }

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
     * let in, the code to compare, a join "They match" began and a relaunch cut short (finished
     * here, from the joins record), or `member` when this phone already holds the family.
     */
    public func joinStatus(_ groupId: String) async throws -> JoinOutcome {
        guard let summary = try await admitted(groupId) else { return .waiting }
        try await vault.prepareLedger()
        // Kept only after the typed words matched: a relaunch finishes from it.
        if let joins = records.read(.joins, userId: userId, groupId: groupId) {
            return try await completeJoin(summary, joins: joins)
        }
        if records.read(userId: userId, groupId: groupId) != nil { return .member }
        return try await show(groupId, served: try await fetchServed(groupId, after: 0))
    }

    /*
     * "They match": `shown` is the showing the screen displayed and the person compared, `typed`
     * the two hidden words in the order of its positions, as the admin read them. A showing the
     * ledger no longer holds (from before a relaunch or a new vault, or replaced) is refused
     * before anything is checked: the code is shown again, to compare again.
     */
    public func confirmJoin(_ groupId: String, _ shown: JoinShowing, typed: [String]) async throws -> JoinOutcome {
        guard let summary = try await admitted(groupId) else { return .waiting }
        try await vault.prepareLedger()
        _ = try await vault.familyPin(groupId)
        return try await exclusive(groupId) {
            if let before = try await self.finishedBefore(summary) { return before }
            let served = try await self.fetchServed(groupId, after: 0)
            return try await self.check(groupId, summary: summary, served: served, shown: shown, typed: typed)
        }
    }

    private func check(_ groupId: String, summary: GroupSummary, served: ServedChain, shown: JoinShowing, typed: [String]) async throws -> JoinOutcome {
        let me = try await vault.ownIdentities()
        while true {
            let checked: JoinCheck
            do {
                checked = try ledger.joinCheck(me: me, groupId: groupId, record: records.read(userId: userId, groupId: groupId)?.envelope, served: served,
                                               session: shown.session, typed: typed, now: Self.checkTime(now()), holds: nil)
            } catch let error as CoreError where FamilyWords.message(of: error) == JoinWords.notShown {
                // Shown before this ledger, or replaced: nothing was checked, so the code again.
                return try await show(groupId, served: served)
            }
            switch checked {
            case .recordUnreadable:
                records.delete(userId: userId, groupId: groupId)
                continue
            case .incomplete:
                throw FamilyFailure(message: JoinWords.incomplete)
            case .wrongWords(let holds):
                keep(holds, groupId)
                return .wrongWords
            case .mismatch(let holds):
                keep(holds, groupId)
                return .mismatch
            case .changed(let session):
                // Not the code that was compared: it vouches for nothing here.
                records.delete(.joins, userId: userId, groupId: groupId)
                return .compare(JoinShowing(session), changed: true)
            case .notAdmitted:
                return .waiting
            case .fork(let of, let version, let sides):
                return .fork(Self.fork(of: of, version: version, sides: sides))
            case .matched(let matched, let holds):
                keep(holds, groupId)
                // Kept before acceptance: a relaunch between the two finishes from here.
                try records.put(.joins, userId: userId, groupId: groupId, matched.record())
                // The same served chain the code was just worked out over.
                return try await acceptJoin(groupId, served: served, matched: matched)
            }
        }
    }

    /* Route 2's row for the family once it says active (let in); nil while it doesn't. */
    private func admitted(_ groupId: String) async throws -> GroupSummary? {
        guard FamilyRecords.valid(groupId) else { throw FamilyFailure(message: "Please try again.") }
        return try await list().first { $0.id == groupId && $0.state == "active" }
    }

    /*
     * The code this phone shows over `served`, against every mark it and the account hold (a
     * rejoin's settings pin decides the history; the code adds to it). The settings are read
     * first, so the ledger holds their pin. The kept escalation goes in on this ledger's first
     * showing of the family; one that doesn't open on this account is deleted (the only answer it
     * is deleted on), and a record from before a master-key rotation goes too.
     */
    private func preview(_ groupId: String, served: ServedChain) async throws -> JoinPreview {
        _ = try await vault.familyPin(groupId)
        let me = try await vault.ownIdentities()
        let restore = !restoredHolds.contains(groupId)
        while true {
            let result: JoinPreview
            do {
                result = try ledger.groupJoinPreview(me: me, groupId: groupId, record: records.read(userId: userId, groupId: groupId)?.envelope,
                                                     served: served, holds: restore ? records.read(.holds, userId: userId, groupId: groupId) : nil)
            } catch CoreError.Sealed(let message) where message == JoinWords.holdsUnreadable {
                records.delete(.holds, userId: userId, groupId: groupId)
                continue
            }
            switch result {
            case .recordUnreadable:
                records.delete(userId: userId, groupId: groupId)
                continue
            case .code:
                restoredHolds.insert(groupId)
                return result
            default:
                return result
            }
        }
    }

    /* One showing of the code over `served`. */
    private func show(_ groupId: String, served: ServedChain) async throws -> JoinOutcome {
        switch try await preview(groupId, served: served) {
        case .code(_, _, let session): return .compare(JoinShowing(session), changed: false)
        // Active on route 2 but not on the member list it serves yet: still waiting.
        case .notAdmitted, .recordUnreadable: return .waiting
        case .fork(let of, let version, let sides): return .fork(Self.fork(of: of, version: version, sides: sides))
        }
    }

    /*
     * The escalation a check returned, in place of the one kept before; none deletes it. Storage
     * refused leaves it held in the ledger for as long as this sync; a delete that failed leaves an
     * older escalation, which only ever holds more when restored.
     */
    private func keep(_ holds: String?, _ groupId: String) {
        if let holds {
            do { try records.put(.holds, userId: userId, groupId: groupId, holds) } catch {
                NSLog("HushOS: the join check could not be saved on this device.")
            }
        } else {
            records.delete(.holds, userId: userId, groupId: groupId)
        }
    }

    /*
     * An earlier finish wrote the device record and stopped before the joins record went (the pin
     * not saved, no answer while opening the folders): the record is a mark now, so this is a sync,
     * and the joins record goes. Nil when there is no record, or nothing checked the family.
     */
    private func finishedBefore(_ summary: GroupSummary) async throws -> JoinOutcome? {
        guard records.read(userId: userId, groupId: summary.id) != nil else { return nil }
        switch await run(summary) {
        case .accepted(let view):
            records.delete(.joins, userId: userId, groupId: summary.id)
            return .joined(.accepted(view))
        case .fork(let fork):
            return .fork(fork)
        case .unchecked:
            // A record that did not open and no pin: the join goes on from the code.
            return nil
        case .failed(let words):
            throw FamilyFailure(message: words)
        case .waiting, .wiped:
            return .waiting
        }
    }

    /* A relaunch finishing a join "They match" began: from the joins record, while the served chain gives its code. */
    private func completeJoin(_ summary: GroupSummary, joins: String) async throws -> JoinOutcome {
        _ = try await vault.familyPin(summary.id)
        return try await exclusive(summary.id) {
            if let before = try await self.finishedBefore(summary) { return before }
            return try await self.resume(summary.id, joins: joins)
        }
    }

    private func resume(_ groupId: String, joins: String) async throws -> JoinOutcome {
        let served = try await fetchServed(groupId, after: 0)
        // Another account's, an older version's, or sealed under an earlier account root: it goes, and the code is compared.
        guard let matched = try ledger.joinMatchedOpen(groupId: groupId, joinsRecord: joins) else {
            records.delete(.joins, userId: userId, groupId: groupId)
            return try await show(groupId, served: served)
        }
        return try await acceptJoin(groupId, served: served, matched: matched)
    }

    /*
     * The family taken with the code the person compared as its join mark, once, and only while
     * the served chain still gives that code; then the device record (before anything else, never
     * over a later one), the folders and the settings pin as after any acceptance, and the joins
     * record goes. A record that can't be kept lets the ledger go of the family too, or its chain
     * would count as a mark this phone can't show and a retry be refused.
     */
    private func acceptJoin(_ groupId: String, served first: ServedChain, matched: JoinMatched) async throws -> JoinOutcome {
        let me = try await vault.ownIdentities()
        var served = first
        var overtaken = 0
        while true {
            let result = try ledger.acceptJoining(me: me, groupId: groupId, record: records.read(userId: userId, groupId: groupId)?.envelope,
                                                  served: served, matched: matched, guard: .absent)
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
            case .changed(let session):
                records.delete(.joins, userId: userId, groupId: groupId)
                return .compare(JoinShowing(session), changed: true)
            case .notAdmitted:
                return .waiting
            case .fork(let of, let version, let sides):
                return .fork(Self.fork(of: of, version: version, sides: sides))
            case .accepted(let chain, let record, let pin, _):  // The guard (docs/optional-verification.md 2.8) is stored from PR 5.
                do {
                    try records.put(userId: userId, groupId: groupId, FamilyRecords.Row(envelope: record, rosterVersion: chain.roster().rosterVersion,
                                                                                        areas: Array(chain.areaKeys().keys).sorted()))
                } catch {
                    // The guard it returns (2.8) is stored from PR 5; with `.absent` held it never throws.
                    _ = try? ledger.forgetGroup(groupId: groupId, guard: .absent, checkedAt: Self.checkTime(now()))
                    throw error
                }
                let state = try await afterAcceptance(groupId, chain: chain, pin: pin, reset: false)
                if case .fork(let fork) = state { return .fork(fork) }
                records.delete(.joins, userId: userId, groupId: groupId)
                return .joined(state)
            }
        }
    }
}
