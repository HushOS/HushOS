import Foundation
import HushOSCore

/*
 * A manager's side of joining (docs/groups-mobile-plan.md iOS 5a, Android's #265, the web's
 * groups/outbox.ts and stageLocked): invite by email, turn down or let in whoever waits, and
 * cancel an invitation. Letting someone in is a roster call the core signs (`admit_body`): it is
 * kept on this device before it is sent (the outbox), so an unknown outcome is sent again as the
 * same bytes, after a kill too, and never signed twice; the core judges a kept call before every
 * send (`outbox_open`) against the committed chain and the settings read just now.
 *
 * - Settings first: a send reads the settings afresh; a read that gets no answer sends nothing,
 *   and the call stays kept.
 * - Not-member from any step is the removal path (removedInTurn): published, and the family's
 *   kept calls go with the wipe.
 * - A second press while a call is unanswered sends that call again; nothing new is signed.
 * - One staging gate for every roster call (`stageCall`, Android #281's): whatever is kept for the
 *   family is sent first (what each came to kept until the screens say it, keptEnds), and nothing new
 *   is staged while any is still unresolved, so a new roster never overtakes a kept call.
 * - Staging syncs the chain first and checks the head the server serves against it, and reads
 *   the newcomer's keys from route 16 again every time.
 * - A store that can't be read is never read as empty: nothing is signed or sent.
 */

/* What became of a kept call. */
public enum CallEnd: Sendable, Equatable {
    case landed
    /* Superseded or stale: another change landed first; nothing of this one was applied. */
    case stale
    /* Not sent, or no answer: still kept, sent again later. The words to show. */
    case pending(String)
    case refused(String)
    /* Kept for keys the newcomer had before their account changed: held, never sent. */
    case otherKeys
    /* Someone else's kept call, left alone. */
    case other
    case wiped
}

/* What Let them in came to. */
public enum LetIn: Sendable, Equatable {
    case landed
    case pending(String)
    case refused(String)
    /* Their account changed since this phone pinned them: said first, then Continue. */
    case changed(AccountChange)
    /* An earlier Let them in for them, for keys they had before, is kept: drop it first. */
    case keptOther
    case wiped
}

enum Staged {
    case call(StagedCall)
    case refused(String)
    case wiped
    /* The manager rule: a promotion over keys this phone hasn't checked. */
    case checkFirst
    /* The core found nothing to change (`UNCHANGED`). */
    case unchanged
    /* An earlier change kept here is unresolved: nothing was staged (the gate). */
    case waiting
}

/* A refusal a build met before anything was signed, in its words. */
struct StageRefused: Error { let words: String }

/* A promotion whose person isn't verified on this phone now (guard included): their words first. */
struct CheckFirstNeeded: Error {}

public enum ManageWords {
    public static let keptOnDevice = "Kept on this device."
    public static let keysUnread = "HushOS couldn’t load everyone’s keys. Try again."
    public static let noSeal = "Another manager needs to open the family before you can change it. Try again later."
    public static let grantsDue = "Someone in the family is still missing a folder’s keys. Try again in a moment."
    public static let poolFull = "Their files don’t fit in the family’s free space. Free up space, then let them in."

    static func changesLost(_ family: String) -> String {
        "A change to \(family) hadn’t reached the server and couldn’t be opened on this device. Make it again."
    }

    static func keepsChanging(_ family: String) -> String { "\(family) keeps changing. Try again in a moment." }
    static func couldntCheck(_ family: String) -> String { "Couldn’t check \(family). Try again." }
    /* The gate's words (Android #281's): an earlier change of this phone's is still unresolved. */
    public static func earlierWaiting(_ family: String) -> String { "An earlier change to \(family) hasn’t reached the server yet. Try again once it has." }
    /* The core's and the web's words (roster_calls.rs). */
    static let checkManagerFirst = "Check it’s them first. Managers are checked before they get the role."
    static let unchanged = "That doesn’t change their roles."
    static let organizerFirst = "Make someone else the organizer first."
    public static func notWaiting(_ first: String?) -> String {
        first.map { "\($0) isn’t waiting to join any more." } ?? "They aren’t waiting to join any more."
    }

    /*
     * What Let them in says in passing: in, or kept on this device with why it isn't in yet (the
     * words the outbox gave, as Android #265 says them). Nil for outcomes said elsewhere.
     */
    public static func letIn(_ outcome: LetIn, first: String, family: String) -> String? {
        switch outcome {
        case .landed: return "\(first) is in \(family)"
        case .pending(let reason): return "Saved on this device. \(reason)"
        default: return nil
        }
    }

    /*
     * What a manager is told, until read, of a kept call the resume let go of: a refusal in its own
     * words; an admission another change overtook (nothing of it was made: they're let in again,
     * Android #276's words); nil for one that landed. `name`: a person's first name, if known.
     */
    public static func resumed(_ end: CallEnd, route: ChainRoute?, family: String = "The family", name: (String) -> String?) -> String? {
        switch (end, route) {
        case (.refused(let words), _): return words
        case (.stale, .admit(let userId)?): return "An earlier admission of \(name(userId) ?? "someone waiting to join") wasn’t sent; let them in again."
        // A role change another change overtook: nothing of it was made (Android #276's words, the web's `stale`).
        case (.stale, .member?): return "\(family) changed while you were working on it. Try again."
        default: return nil
        }
    }

    /* A roster call's refusal, code by code, in the web's words (copy.ts), "Try again" where the web says to reload. */
    public static func call(_ answer: CallAnswer, family: String?, first: String? = nil) -> String {
        let family = family ?? "this family"
        let detail = answer.detail
        switch answer.code {
        case "invalid": return "Couldn’t save that change. Try again."
        case "succession-due": return "A manager of \(family) needs to finish an earlier change first. Try again."
        case "left-due": return "Someone left the family. A manager needs to finish that before anyone can join or roles change."
        case "members-changed", "stale": return "\(family) changed while you were working on it. Try again."
        case "busy": return "Another change to this plan is in progress. Try again in a moment."
        case "seats":
            switch detail["reason"] as? String {
            case "no-plan": return "Choose a plan for \(family) before letting anyone in."
            case "payer": return "Every place in the plan for \(family) is taken. Ask the person who pays for it to add a place."
            case "cap": return "The plan for \(family) allows no more members."
            default: return "Every place in \(family) is taken."
            }
        case "no-plan": return "Choose a plan for \(family) first. Until it has one, nobody can be invited and no family folders can be made."
        case "in-family":
            if detail["reason"] as? String == "newcomer" { return "They’ve joined another family since they accepted. They can join yours once they leave it." }
            return "You’re in a family already. Leave it before you create another."
        case "pool-full": return poolFull
        case "unsupported": return "Update HushOS to do this."
        case "forbidden": return "Only someone who manages the family can do that."
        case "not-member": return "You’re not in this family any more."
        case "not-pending": return notWaiting(first)
        case "held": return "Another manager paused your changes in this family for now."
        case "rotating", "epoch-stale", "root-moved", "document-stale": return "A family folder was changing at the same time. Try again in a moment."
        case "root-mid-rotation": return "A family folder is in the middle of a key change this server can’t account for. Contact the server’s operator."
        case "not-rotating", "area-moved": return "A family folder changed meanwhile. Try again."
        case "no-seal": return noSeal
        case "area-limit":
            if let limit = detail["limit"] as? Int { return "A family can have at most \(limit) shared folders on this server." }
            return "This family has as many shared folders as this server allows."
        case "grants-due": return grantsDue
        case "already-member": return "That person is already in the family."
        case "too-large": return "That change is too large for this server."
        case "rate-limited": return "That’s been tried too often. Wait a little, then try again."
        case "unavailable": return "HushOS couldn’t save that just now. Try again in a moment."
        case nil:
            return answer.status == 0 ? GroupsAPIError.noAnswer : "HushOS couldn’t do that just now. Try again in a moment."
        default: return "Couldn’t save that change. Try again."
        }
    }

    /* An invitation's refusal: its own words for an address, the server's for anything it words itself. */
    public static func invite(_ error: Error) -> String {
        guard let refused = error as? GroupsAPIError else { return FamilyWords.error(error) }
        switch refused.code {
        case "invalid": return "Enter their whole email address, like them@example.com."
        case "exists": return "That address already has an open invitation."
        case "already-member": return "That person is already in the family."
        case "rate-limited": return refused.message
        default:
            if refused.status == 409 || refused.status == 402 { return refused.message }
            return FamilyWords.error(refused)
        }
    }
}

extension FamilySync {
    /* The pause before a resend: half a second times the sends so far (tests: none). */
    @TaskLocal static var resendPause: Duration = .milliseconds(500)
    static let sendsPerCall = 3
    static let fixesPerCall = 3

    private func familyName(_ groupId: String) -> String { families[groupId] ?? summaries[groupId]?.name ?? "this family" }

    // MARK: Lists and plain manager actions

    /* Route 16: who waits to join. */
    public func waitingToJoin(_ groupId: String) async throws -> [PendingPerson] { try await notMemberLetsGo(groupId) { try await self.api.pending(groupId) } }

    /* Route 12: the invitations still open. */
    public func openInvitations(_ groupId: String) async throws -> [FamilyInvitation] {
        try await notMemberLetsGo(groupId) { try await self.api.invitations(groupId) }
    }

    /* Route 11: an invitation to `email`, as typed (trimmed). */
    public func invite(_ groupId: String, email: String) async throws {
        try await notMemberLetsGo(groupId) { try await self.api.invite(groupId, email: email.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }

    /*
     * Route 26: Not now, in the family's turn. Every Let them in kept for them goes first, and
     * only then is the decline sent: turning down and accepting again move no revision, so a kept
     * admission that outlived a decline (its answer lost, or a cleanup that couldn't run after it)
     * would still apply after a later invitation, with nobody pressing Let them in. A decline that
     * then fails has cost nothing the manager wanted: Let them in signs a new one.
     */
    public func turnDown(_ groupId: String, userId person: String) async throws {
        try await exclusive(groupId) {
            try await self.dropKeptAdmissionsInTurn(groupId, of: person, heldOnly: false)
            do {
                try await self.api.decline(groupId, userId: person)
            } catch let error as GroupsAPIError where error.isNotMember {
                _ = await self.removedInTurn(groupId)
                throw error
            }
        }
    }

    /* Route 13: Cancel invitation. */
    public func cancelInvitation(_ groupId: String, invitationId: String) async throws {
        try await notMemberLetsGo(groupId) { try await self.api.cancelInvitation(groupId, invitationId) }
    }

    /* `body`, with a not-member answer let go of as a removal (published) before it is thrown on. */
    private func notMemberLetsGo<T: Sendable>(_ groupId: String, _ body: @escaping @Sendable () async throws -> T) async throws -> T {
        do {
            return try await body()
        } catch let error as GroupsAPIError where error.isNotMember {
            _ = await removedNow(groupId)
            throw error
        }
    }

    // MARK: The outbox

    /*
     * Every call kept for the family, sent again (or let go of) in the family's turn: what each
     * came to, by outbox id. Stops at a removal. A store that can't be read throws. What each call
     * that is let go of came to is kept to be said before its entry is deleted (`keptEnds`), so it
     * is said even when whoever asked has stopped waiting (a page left mid-resend, a relaunch).
     * `handed` hears what a handover the resume finished came to, after the turn is let go of: it
     * may sync.
     */
    public func resumeOutbox(_ groupId: String, names: [String: String] = [:],
                             handed: (@Sendable (String, RoleEnd) async -> Void)? = nil) async throws -> [String: CallEnd] {
        let user = userId
        let (out, settled) = try await exclusive(groupId) { () -> ([String: CallEnd], (String, RoleEnd)?) in
            var out: [String: CallEnd] = [:]
            var settled: (String, RoleEnd)?
            do {
                for kept in try self.records.outboxList(userId: user, groupId: groupId) {
                    let end = try await self.sendKept(groupId, outboxId: kept.outboxId, entry: kept.entry, only: nil, saysLater: true)
                    out[kept.outboxId] = end
                    if end == .wiped { break }
                }
                // A handover the app stopped in the middle of is finished.
                if !out.values.contains(.wiped) { settled = try await self.finishHandover(groupId, names: names) }
            } catch let error as GroupsAPIError where error.isNotMember {
                _ = await self.removedInTurn(groupId)
                out["wiped"] = .wiped
            }
            return (out, settled)
        }
        // Told once the family's turn is let go of: whoever hears it may sync the family (its own turn), which waited on this one for ever.
        if let (to, end) = settled { await handed?(to, end) }
        return out
    }

    /*
     * One kept call, in the family's turn: the settings read afresh, the core's judgement of it,
     * then sent (as the same bytes, a few times on no answer) and its answer followed. `only`: a
     * call on that route (a person's admission, a change of their roles) looks only at its own;
     * anyone else's is `other`, untouched.
     */
    func sendKept(_ groupId: String, outboxId: String, entry: String, only: ChainRoute?, saysLater: Bool = false) async throws -> CallEnd {
        var sends = 0
        var fixes = 0
        // `saysLater`: a call nobody waits on for its own answer (the resume, the gate) keeps what it came to to be said,
        // first, then its entry goes: a crash in between says it once (one per outbox id), and a relaunch loses nothing.
        func drop(_ end: CallEnd, _ route: ChainRoute?) async throws {
            if saysLater, let unsaid = FamilyRecords.UnsaidEnd(outboxId: outboxId, end: end, route: route) {
                try records.keepUnsaid(userId: userId, groupId: groupId, unsaid)
            }
            try handoverHears(end, groupId: groupId, outboxId: outboxId, route: route)
            try records.outboxDelete(userId: userId, groupId: groupId, outboxId: outboxId)
        }
        while true {
            // The settings first, every attempt: a pin changed or dropped on another device decides what is sent.
            do {
                _ = try await vault.familyPin(groupId)
            } catch {
                // The session ended: the app's lost session. Any other failure sends nothing; the call stays kept.
                if case DriveAPIError.notAuthenticated = error { throw error }
                if case AuthError.sessionEnded = error { throw error }
                // Pending only for the caller's own call: whose it is read from the entry (the settings as last read), and
                // one of anyone else, or that doesn't open, is left alone (Codex #285 round 5), never said as kept for them.
                if let only {
                    guard let opened = try? ledger.outboxOpen(groupId: groupId, outboxId: outboxId, userId: userId, entry: entry),
                          Self.route(of: opened) == only else { return .other }
                }
                return .pending(Self.transient(error) ? FamilyWords.noAnswer : FamilyWords.error(error))
            }
            let opened: OutboxCall
            do {
                opened = try ledger.outboxOpen(groupId: groupId, outboxId: outboxId, userId: userId, entry: entry)
            } catch CoreError.Sealed {
                // Not this account's, or doesn't open (a master-key rotation since): lost, and said so.
                let end = CallEnd.refused(ManageWords.changesLost(familyName(groupId)))
                try await drop(end, nil)
                return end
            }
            let route: ChainRoute
            switch opened {
            case .send(_, let r, _), .hold(_, let r, _), .landed(_, let r), .superseded(_, let r): route = r
            }
            if let only, route != only { return .other }
            switch opened {
            case .hold(_, let held, let reason):
                guard reason == .otherKeys else { return .pending(ManageWords.keptOnDevice) }
                // Held for keys they had before, for someone who no longer waits: retired, so it never holds back every change.
                switch try await retireOrphan(groupId, route: held) {
                case nil: return .otherKeys
                // The sync let go of the family (not-member): the wipe took the entry with it.
                case .wiped?: return .wiped
                case let end?:
                    try await drop(end, held)
                    return end
                }
            case .landed:
                try await drop(.landed, route)
                await syncInTurn(groupId)
                return .landed
            case .superseded:
                try await drop(.stale, route)
                return .stale
            case .send(_, _, let body):
                let answer = try await api.sendCall(groupId, route: route, body: body)
                sends += 1
                switch outboxStep(status: UInt16(clamping: max(0, answer.status)), code: answer.code) {
                case .landed:
                    try await drop(.landed, route)
                    await syncInTurn(groupId)
                    return .landed
                case .resend, .rebuild:
                    if sends >= Self.sendsPerCall { return .pending(ManageWords.call(answer, family: familyName(groupId))) }
                    try await Task.sleep(for: Self.resendPause * sends)
                case .sendGrants:
                    fixes += 1
                    if fixes > Self.fixesPerCall { return .pending(ManageWords.grantsDue) }
                    if let end = try await sendGrants(groupId, answer) { return end }
                case .stale:
                    try await drop(.stale, route)
                    await syncInTurn(groupId)
                    return .stale
                case .membershipMoved:
                    let end = CallEnd.refused(ManageWords.call(answer, family: familyName(groupId)))
                    try await drop(end, route)
                    await syncInTurn(groupId)
                    return end
                case .refused:
                    let end = CallEnd.refused(ManageWords.call(answer, family: familyName(groupId)))
                    try await drop(end, route)
                    if answer.code == "forbidden" { await syncInTurn(groupId) }
                    return end
                case .wiped:
                    _ = await removedInTurn(groupId)
                    return .wiped
                }
            }
        }
    }

    /* The family synced from inside its turn (`run`, not `sync`, which would wait for this turn), its letting go published. */
    @discardableResult
    func syncInTurn(_ groupId: String) async -> FamilyState? {
        guard let summary = summaries[groupId] else { return nil }
        let revised = Revised(state: await run(summary), revision: Self.revise())
        if FamilyReleases.letsGo(revised.state) { releases.post(groupId, revised) }
        return revised.state
    }

    /*
     * A `grants-due` answer: the grants it names posted, all or none, before the same bytes are
     * sent again. Nil when they went; otherwise what the call came to.
     */
    private func sendGrants(_ groupId: String, _ answer: CallAnswer) async throws -> CallEnd? {
        guard let rows = answer.detail["missing"] as? [[String: Any]], !rows.isEmpty else { return .pending(ManageWords.grantsDue) }
        let identities = try await fetchIdentities(groupId)
        var owed: [OwedGrant] = []
        for row in rows {
            guard let workspaceId = row["workspaceId"] as? String, let user = row["userId"] as? String,
                  let kem = identities[user.lowercased()]?.identity?.kemPublicKey else { return .pending(ManageWords.keysUnread) }
            owed.append(OwedGrant(workspaceId: workspaceId, userId: user, kemPublicKey: kem))
        }
        let me = try await vault.ownIdentities()
        let envelope = try await vault.currentIdentityEnvelope()
        for attempt in 0 ..< 2 {
            switch try ledger.grantsBody(me: me, identity: envelope, groupId: groupId, missing: owed) {
            case .grants(let requests):
                for request in requests {
                    let posted = try await api.postGrants(groupId, workspaceId: request.workspaceId, body: request.body)
                    if posted.status == 404, posted.code == "not-member" {
                        _ = await removedInTurn(groupId)
                        return .wiped
                    }
                    guard (200 ..< 300).contains(posted.status) else { return .pending(ManageWords.call(posted, family: familyName(groupId))) }
                }
                return nil
            case .syncFirst, .openFoldersFirst:
                if attempt == 0 { await syncInTurn(groupId) }
            }
        }
        return .pending(ManageWords.grantsDue)
    }

    // MARK: Let them in

    /*
     * Let them in: pinned first-seen from their keys (a changed account is said first; a move in
     * trust is told through `trustMoved`), then in
     * the family's turn any kept admission of theirs is sent before anything new is signed, and
     * only then is a new one staged and sent, signed again over whatever change landed first.
     */
    public func letIn(_ summary: GroupSummary, _ person: PendingPerson, trustMoved: (@Sendable () async -> Void)? = nil) async throws -> LetIn {
        families[summary.id] = summary.name
        summaries[summary.id] = summary
        // Pinning them can move trust (a new pin, a followed succession): told before anything else, as the Contacts
        // screen's add is, so whose signatures count is judged again however the admission then ends.
        switch try await vault.addContact(email: person.email, writer: person.userId, firstSeen: "family") {
        case .changed(let change): return .changed(change)
        case .added: await trustMoved?()
        case .already(_, let moved): if moved { await trustMoved?() }
        }
        return try await exclusive(summary.id) {
            do {
                return try await self.letInTurn(summary, person)
            } catch let error as GroupsAPIError where error.isNotMember {
                _ = await self.removedInTurn(summary.id)
                return .wiped
            }
        }
    }

    private func letInTurn(_ summary: GroupSummary, _ person: PendingPerson) async throws -> LetIn {
        let groupId = summary.id
        let first = person.name.split(whereSeparator: \.isWhitespace).first.map(String.init)
        for kept in try records.outboxList(userId: userId, groupId: groupId) {
            switch try await sendKept(groupId, outboxId: kept.outboxId, entry: kept.entry, only: .admit(userId: person.userId.lowercased())) {
            case .other, .stale: continue
            case .landed: if try await !stillWaiting(groupId, person) { return .landed }
            case .pending(let words): return .pending(words)
            case .refused(let words): return .refused(words)
            case .otherKeys: return .keptOther
            case .wiped: return .wiped
            }
        }
        for _ in 0 ..< 3 {
            switch try await stageAdmit(summary, person, first: first) {
            case .wiped: return .wiped
            case .refused(let words): return .refused(words)
            case .waiting: return .refused(ManageWords.earlierWaiting(summary.name))
            case .checkFirst, .unchanged: return .refused(ManageWords.keepsChanging(summary.name))
            case .call(let call):
                switch try await sendKept(groupId, outboxId: call.outboxId, entry: call.entry, only: nil) {
                case .landed: return .landed
                case .stale, .other: if try await !stillWaiting(groupId, person) { return await letInMeanwhile(summary, person, first: first) }
                case .pending(let words): return .pending(words)
                case .refused(let words): return .refused(words)
                case .otherKeys: return .keptOther
                case .wiped: return .wiped
                }
            }
        }
        return .refused(ManageWords.keepsChanging(summary.name))
    }

    /*
     * No longer waiting after this phone's call was overtaken: let in only if the member list
     * accepted afresh names them (another manager may have turned them down instead).
     */
    private func letInMeanwhile(_ summary: GroupSummary, _ person: PendingPerson, first: String?) async -> LetIn {
        switch await syncInTurn(summary.id) {
        case .accepted(let view)?:
            return view.members.contains { $0.userId.lowercased() == person.userId.lowercased() } ? .landed : .refused(ManageWords.notWaiting(first))
        case .wiped?: return .wiped
        case .failed(let words)?: return .refused(words)
        default: return .refused(ManageWords.couldntCheck(summary.name))
        }
    }

    private func stillWaiting(_ groupId: String, _ person: PendingPerson) async throws -> Bool {
        try await api.pending(groupId).contains { $0.userId == person.userId.lowercased() }
    }

    /*
     * The admission: staged as every call is (stageCall), with their keys as route 16 serves them
     * now (a row drawn before their account changed and this phone's Continue holds the old ones).
     */
    func stageAdmit(_ summary: GroupSummary, _ person: PendingPerson, first: String?) async throws -> Staged {
        try await stageCall(summary) { _, revision, kems in
            guard let now = try await self.api.pending(summary.id).first(where: { $0.userId == person.userId.lowercased() }) else {
                throw StageRefused(words: ManageWords.notWaiting(first))
            }
            guard let served = now.identity else { throw StageRefused(words: ManageWords.keysUnread) }
            return try self.ledger.admitBody(me: try await self.vault.ownIdentities(), identity: try await self.vault.currentIdentityEnvelope(), groupId: summary.id,
                                             expectedRevision: revision, userId: person.userId.lowercased(), served: served, roles: [], kems: kems)
        }
    }

    /*
     * What the handover kept here learns from one of its calls ending, before the entry goes (Codex #285 round 8):
     * billing's call to them ending means the handover was staged, whatever its marker said (one that couldn't be
     * written after the entry was kept), so finishHandover never signs billing again; its step down refused for good
     * ends the handover there, both still organizers, Finish handing over to {first} the person's to press.
     */
    private func handoverHears(_ end: CallEnd, groupId: String, outboxId: String, route: ChainRoute?) throws {
        guard let handover = try records.handover(userId: userId, groupId: groupId) else { return }
        let operation = try records.outboxOperation(userId: userId, groupId: groupId, outboxId: outboxId)
        if !handover.staged, operation == RoleOperation.billingTo.rawValue, case .member(let about)? = route, about.lowercased() == handover.to {
            try records.markHandover(userId: userId, groupId: groupId, to: handover.to, staged: true)
        }
        if case .refused = end, operation == RoleOperation.stepDown.rawValue {
            try records.clearHandover(userId: userId, groupId: groupId)
        }
    }

    /*
     * An admission held for keys this phone no longer pins (`otherKeys`) whose person no longer waits
     * to join, per reads that answered (Android #281's retireOrphan): in the member list just synced,
     * they joined (`landed`, quiet: the list says it); neither waiting nor a member, they were turned
     * down or went (`stale`, said as an admission that wasn't sent). Nil keeps it held: they still
     * wait (their row offers Drop it and let them in), or a read didn't answer. Definite answers are
     * never swallowed: route 16's not-member and a lost session are thrown, and a sync that let go of
     * the family is `wiped`. Runs in the family's turn.
     */
    private func retireOrphan(_ groupId: String, route: ChainRoute) async throws -> CallEnd? {
        guard case .admit(let person) = route else { return nil }
        let waiting: [PendingPerson]
        do {
            waiting = try await api.pending(groupId)
        } catch {
            if let refused = error as? GroupsAPIError, refused.isNotMember { throw error }
            if case DriveAPIError.notAuthenticated = error { throw error }
            if case AuthError.sessionEnded = error { throw error }
            return nil
        }
        if waiting.contains(where: { $0.userId.lowercased() == person.lowercased() }) { return nil }
        let state = await syncInTurn(groupId)
        switch state {
        case .accepted(let view)?:
            return view.members.contains { $0.userId.lowercased() == person.lowercased() } ? .landed : .stale
        case .wiped?:
            return .wiped
        default:
            if case .failed? = state, let ended = endedBy {
                if case DriveAPIError.notAuthenticated = ended { throw ended }
                if case AuthError.sessionEnded = ended { throw ended }
            }
            return nil
        }
    }

    /*
     * The one staging path of every roster call (the web's stageLocked, Android's stageCall). First
     * the gate: every call kept for the family is sent as it was signed (what each came to kept until
     * the screens say it, keptEnds), and while any is still unresolved nothing new is staged
     * (`waiting`): a new roster would overtake it, and its next resume would drop it as superseded,
     * unseen. Then the chain synced in this turn, the head the server serves checked against it
     * (a change between the two: synced again), the settings read afresh, every member's ML-KEM key,
     * and `build` given the head's revision; the group key's seal opened when the core asks. The
     * call is kept before anything is sent (`kept` hears it, after the put). A sync that fails is a
     * refusal or the lost session, never a landing or an absence.
     */
    func stageCall(_ summary: GroupSummary, operation: RoleOperation? = nil, kept: (() throws -> Void)? = nil,
                   build: (FamilyView, UInt64, [String: String]) async throws -> RosterCall) async throws -> Staged {
        let groupId = summary.id
        summaries[groupId] = summary
        families[groupId] = summary.name
        for call in try records.outboxList(userId: userId, groupId: groupId) {
            let end = try await sendKept(groupId, outboxId: call.outboxId, entry: call.entry, only: nil, saysLater: true)
            if end == .wiped { return .wiped }
        }
        if try !records.outboxList(userId: userId, groupId: groupId).isEmpty { return .waiting }
        var openedKey = false
        for _ in 0 ..< 4 {
            let state = await syncInTurn(groupId)
            // A 401 the sync met is the lost session, never a refusal said on the row.
            if case .failed? = state, let ended = endedBy {
                if case DriveAPIError.notAuthenticated = ended { throw ended }
                if case AuthError.sessionEnded = ended { throw ended }
            }
            guard case .accepted(let view)? = state else {
                switch state {
                case .wiped?: return .wiped
                case .failed(let words)?: return .refused(words)
                default: return .refused(ManageWords.couldntCheck(summary.name))
                }
            }
            let head = try await api.head(groupId)
            guard let version = head.version, let revision = head.revision else { return .refused("HushOS couldn’t do that just now. Try again in a moment.") }
            // A change landed between the sync and the head read: synced again before anything is signed.
            if version != view.rosterVersion { continue }
            _ = try await vault.familyPin(groupId)
            let identities = try await fetchIdentities(groupId)
            let kems = Dictionary(identities.compactMap { id, member in member.identity.map { (id, $0.kemPublicKey) } }, uniquingKeysWith: { a, _ in a })
            let staged: RosterCall
            do {
                staged = try await build(view, revision, kems)
            } catch let refused as StageRefused {
                return .refused(refused.words)
            } catch is CheckFirstNeeded {
                return .checkFirst
            } catch let error as CoreError {
                switch FamilyWords.message(of: error) {
                case ManageWords.checkManagerFirst: return .checkFirst
                case ManageWords.unchanged: return .unchanged
                default: return .refused(FamilyWords.error(error))
                }
            }
            switch staged {
            case .staged(let call):
                // What it does first, so no entry is ever kept without it.
                if let operation { try records.outboxNoteOperation(userId: userId, groupId: groupId, outboxId: call.outboxId, operation.rawValue) }
                try records.outboxPut(userId: userId, groupId: groupId, outboxId: call.outboxId, entry: call.entry)
                try kept?()
                return .call(call)
            case .syncFirst, .openFoldersFirst:
                continue
            case .openKeyFirst:
                if openedKey { return .refused(ManageWords.noSeal) }
                openedKey = true
                if let words = try await openGroupKey(groupId, identities: identities) { return .refused(words) }
            }
        }
        return .refused(ManageWords.keepsChanging(summary.name))
    }

    /* One kept call let go of whose end is still to be said: `outboxId` is what `dropKeptEnds` lets go of once it is. */
    public struct KeptEnd: Sendable, Equatable {
        public let groupId: String
        public let outboxId: String
        public let route: ChainRoute?
        public let end: CallEnd
    }

    /*
     * What the kept calls the resume and the staging gate let go of came to and is still to be said, for this account,
     * read only: kept on this phone until a screen says it (`dropKeptEnds`), so one the session changed under, or the
     * app stopped before, is said by the next look. A store that can't be read throws.
     */
    public func keptEnds() throws -> [KeptEnd] {
        try records.unsaidList(userId: userId).compactMap { kept in
            kept.end.said.map { KeptEnd(groupId: kept.groupId, outboxId: kept.end.outboxId, route: $0.route, end: $0.end) }
        }
    }

    /* Lets go of the ends a screen said; one kept since it looked stays. */
    public func dropKeptEnds(_ said: [KeptEnd]) throws {
        for (groupId, ends) in Dictionary(grouping: said, by: \.groupId) {
            try records.dropUnsaid(userId: userId, groupId: groupId, outboxIds: Set(ends.map(\.outboxId)))
        }
    }

    /* Route 8's seal opened by the ledger (a first change after a key change); the words when it can't be. */
    private func openGroupKey(_ groupId: String, identities: [String: MemberIdentity]) async throws -> String? {
        let seal: KeySealView
        do {
            seal = try await api.keySeal(groupId)
        } catch let error as GroupsAPIError where error.code == "no-seal" {
            return ManageWords.noSeal
        }
        guard let sealer = identities[seal.sealerUserId.lowercased()], let keys = sealer.identity,
              let mlDsa = try? base64urlDecode(value: keys.mlDsaPublicKey), let envelope = try? base64urlDecode(value: seal.envelope) else {
            return ManageWords.keysUnread
        }
        let holder = try await vault.identityEnvelope(atKeyVersion: seal.holderKeyVersion)
        _ = try ledger.openGroupKey(me: try await vault.ownIdentities(), groupId: groupId,
                                    seal: ServedKeySeal(groupKeyVersion: seal.groupKeyVersion, holderKeyVersion: seal.holderKeyVersion, sealerUserId: seal.sealerUserId,
                                                        rosterVersion: seal.rosterVersion, rosterDigest: seal.rosterDigest, envelope: envelope),
                                    sealerMlDsaPublicKey: mlDsa, sealerHistory: SignerHistory(served: keys.served, links: sealer.links.map(\.link)), holder: holder)
        return nil
    }

    /*
     * An admission kept for keys the newcomer had before their account changed: dropped, so they
     * can be let in again. Only theirs, only held ones; one that doesn't open is left for its notice.
     */
    public func dropKeptAdmission(_ groupId: String, userId person: String) async throws {
        try await dropKeptAdmissions(groupId, of: person, heldOnly: true)
    }

    /* The person's kept admissions deleted in the family's turn: only held ones, or all of them (turned down). */
    private func dropKeptAdmissions(_ groupId: String, of person: String, heldOnly: Bool) async throws {
        try await exclusive(groupId) { try await self.dropKeptAdmissionsInTurn(groupId, of: person, heldOnly: heldOnly) }
    }

    /* The same, from inside the family's turn (`exclusive` isn't reentrant). Any failure throws: nothing is assumed gone. */
    private func dropKeptAdmissionsInTurn(_ groupId: String, of person: String, heldOnly: Bool) async throws {
        let user = userId
        _ = try await vault.familyPin(groupId)
        for kept in try records.outboxList(userId: user, groupId: groupId) {
            let opened: OutboxCall
            do {
                opened = try ledger.outboxOpen(groupId: groupId, outboxId: kept.outboxId, userId: user, entry: kept.entry)
            } catch CoreError.Sealed {
                continue
            }
            let route: ChainRoute
            switch opened {
            case .send(_, let r, _), .landed(_, let r), .superseded(_, let r): if heldOnly { continue } else { route = r }
            case .hold(_, let r, _): route = r
            }
            guard case .admit(let who) = route, who.lowercased() == person.lowercased() else { continue }
            try records.outboxDelete(userId: user, groupId: groupId, outboxId: kept.outboxId)
        }
    }
}

extension Vault {
    /* The identity envelope in use now, as the core signs a manager's calls with it. */
    func currentIdentityEnvelope() async throws -> IdentityEnvelope {
        _ = try await identityKeys()
        guard let identityEnvelope else { throw DriveAPIError.server(500, "Your account’s keys couldn’t be opened. Sign in again.") }
        return identityEnvelope
    }
}

/*
 * The notices a manager's page says, one at a time: a passing one replaces whatever passing one is
 * shown; one that must be read (what a call resumed in the background came to) waits its turn and
 * is never replaced, so none is lost.
 */
public struct NoticeQueue: Sendable, Equatable {
    public struct Notice: Sendable, Equatable, Identifiable {
        public let id: Int
        public let text: String
        public let untilRead: Bool
    }

    public private(set) var shown: Notice?
    private var waiting: [Notice] = []
    private var next = 0

    public init() {}

    private mutating func make(_ text: String, untilRead: Bool) -> Notice {
        next += 1
        return Notice(id: next, text: text, untilRead: untilRead)
    }

    /* A notice that goes by itself: shown now; an until-read one shown is put back first in line. */
    @discardableResult
    public mutating func passing(_ text: String) -> Notice {
        let notice = make(text, untilRead: false)
        if let shown, shown.untilRead { waiting.insert(shown, at: 0) }
        shown = notice
        return notice
    }

    /* A notice that stays until read: behind an until-read one shown, otherwise shown now. */
    public mutating func untilRead(_ text: String) {
        let notice = make(text, untilRead: true)
        if let shown, shown.untilRead { waiting.append(notice) } else { shown = notice }
    }

    /* The shown notice read or closed: the next one waiting, if any. */
    public mutating func dismiss() { shown = waiting.isEmpty ? nil : waiting.removeFirst() }

    /* A passing notice's time is up: only if it is still the one shown. */
    public mutating func expire(_ id: Int) {
        guard let shown, shown.id == id, !shown.untilRead else { return }
        dismiss()
    }

    public mutating func clear() {
        shown = nil
        waiting = []
    }
}

/*
 * Each family's manager lists as loads numbered as they start: an answer of a load begun before
 * the last one started (a refresh answered after a cancel's own reload) is dropped.
 */
/*
 * Whose role change runs on the family page (one at a time), as the session's: a change begun
 * before a reset (sign-out, another account, the same account's session adopted in place) never
 * leaves the next session's menus disabled, and its late end never clears the next one's.
 */
public struct RoleChanges: Sendable, Equatable {
    public struct Token: Sendable, Equatable {
        let generation: UInt64
        let member: String
    }

    public private(set) var busy: String?
    private var generation: UInt64 = 0

    public init() {}

    /* The change of `member` begins; nil while another runs. */
    public mutating func begin(_ member: String) -> Token? {
        guard busy == nil else { return nil }
        busy = member.lowercased()
        return Token(generation: generation, member: member.lowercased())
    }

    /* The change `token` began ended: only its own session's, only its own. */
    public mutating func end(_ token: Token) {
        if token.generation == generation, busy == token.member { busy = nil }
    }

    /* The session ended or was replaced: nothing runs any more as far as the page goes. */
    public mutating func reset() {
        busy = nil
        generation &+= 1
    }
}

public struct ManagedLoads: Sendable, Equatable {
    private var latest: [String: UInt64] = [:]
    public init() {}

    public mutating func begin(_ groupId: String) -> UInt64 {
        latest[groupId.lowercased(), default: 0] += 1
        return latest[groupId.lowercased()]!
    }

    public func admits(_ groupId: String, _ load: UInt64) -> Bool { latest[groupId.lowercased()] == load }

    public mutating func reset() { latest = [:] }
}
