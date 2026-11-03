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
 * - Kept calls are judged per person: another person's kept call is left alone.
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
}

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
    public static func notWaiting(_ first: String?) -> String {
        first.map { "\($0) isn’t waiting to join any more." } ?? "They aren’t waiting to join any more."
    }

    /*
     * What a manager is told, until read, of a kept call the resume let go of: a refusal in its own
     * words; an admission another change overtook (nothing of it was made: they're let in again,
     * Android #276's words); nil for one that landed. `name`: a person's first name, if known.
     */
    public static func resumed(_ end: CallEnd, route: ChainRoute?, name: (String) -> String?) -> String? {
        switch (end, route) {
        case (.refused(let words), _): return words
        case (.stale, .admit(let userId)?): return "An earlier admission of \(name(userId) ?? "someone waiting to join") wasn’t sent; let them in again."
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
     * Route 26: Not now. Once it is confirmed, every Let them in kept for them goes, in the
     * family's turn: turning down and accepting again move no revision, so a kept admission would
     * otherwise still apply after a later invitation, with nobody pressing Let them in.
     */
    public func turnDown(_ groupId: String, userId person: String) async throws {
        try await notMemberLetsGo(groupId) { try await self.api.decline(groupId, userId: person) }
        try await dropKeptAdmissions(groupId, of: person, heldOnly: false)
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
     * came to, by outbox id. Stops at a removal. A store that can't be read throws. `handOver`
     * hears each call that is let go of, before its entry is deleted, so what it came to is said
     * even when whoever asked has stopped waiting (a page left mid-resend).
     */
    public func resumeOutbox(_ groupId: String, handOver: (@Sendable (CallEnd, ChainRoute?) async -> Void)? = nil) async throws -> [String: CallEnd] {
        let user = userId
        return try await exclusive(groupId) {
            var out: [String: CallEnd] = [:]
            do {
                for kept in try self.records.outboxList(userId: user, groupId: groupId) {
                    let end = try await self.sendKept(groupId, outboxId: kept.outboxId, entry: kept.entry, only: nil, handOver: handOver)
                    out[kept.outboxId] = end
                    if end == .wiped { break }
                }
            } catch let error as GroupsAPIError where error.isNotMember {
                _ = await self.removedInTurn(groupId)
                out["wiped"] = .wiped
            }
            return out
        }
    }

    /*
     * One kept call, in the family's turn: the settings read afresh, the core's judgement of it,
     * then sent (as the same bytes, a few times on no answer) and its answer followed. `only`: a
     * person's Let them in looks only at their own admission; anyone else's is `other`, untouched.
     */
    func sendKept(_ groupId: String, outboxId: String, entry: String, only: String?,
                  handOver: (@Sendable (CallEnd, ChainRoute?) async -> Void)? = nil) async throws -> CallEnd {
        var sends = 0
        var fixes = 0
        // What the call came to is handed over first, then its entry goes: a caller that stops waiting loses nothing.
        func drop(_ end: CallEnd, _ route: ChainRoute?) async throws {
            await handOver?(end, route)
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
            if let only, route != .admit(userId: only.lowercased()) { return .other }
            switch opened {
            case .hold(_, _, let reason):
                return reason == .otherKeys ? .otherKeys : .pending(ManageWords.keptOnDevice)
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
     * Let them in: pinned first-seen from their keys (a changed account is said first), then in
     * the family's turn any kept admission of theirs is sent before anything new is signed, and
     * only then is a new one staged and sent, signed again over whatever change landed first.
     */
    public func letIn(_ summary: GroupSummary, _ person: PendingPerson) async throws -> LetIn {
        families[summary.id] = summary.name
        summaries[summary.id] = summary
        if case .changed(let change) = try await vault.addContact(email: person.email, writer: person.userId, firstSeen: "family") {
            return .changed(change)
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
            switch try await sendKept(groupId, outboxId: kept.outboxId, entry: kept.entry, only: person.userId) {
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
     * The web's stageLocked: the chain synced first, the head the server serves checked against
     * it, their keys read from route 16 again, the settings read afresh, then the core signs; kept
     * before anything is sent.
     */
    func stageAdmit(_ summary: GroupSummary, _ person: PendingPerson, first: String?) async throws -> Staged {
        let groupId = summary.id
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
            guard let now = try await api.pending(groupId).first(where: { $0.userId == person.userId.lowercased() }) else {
                return .refused(ManageWords.notWaiting(first))
            }
            guard let served = now.identity else { return .refused(ManageWords.keysUnread) }
            _ = try await vault.familyPin(groupId)
            let identities = try await fetchIdentities(groupId)
            let kems = Dictionary(identities.compactMap { id, member in member.identity.map { (id, $0.kemPublicKey) } }, uniquingKeysWith: { a, _ in a })
            let me = try await vault.ownIdentities()
            let envelope = try await vault.currentIdentityEnvelope()
            let staged: RosterCall
            do {
                staged = try ledger.admitBody(me: me, identity: envelope, groupId: groupId, expectedRevision: revision, userId: person.userId.lowercased(),
                                              served: served, roles: [], kems: kems)
            } catch let error as CoreError {
                return .refused(FamilyWords.error(error))
            }
            switch staged {
            case .staged(let call):
                try records.outboxPut(userId: userId, groupId: groupId, outboxId: call.outboxId, entry: call.entry)
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
        let user = userId
        try await exclusive(groupId) {
            _ = try await self.vault.familyPin(groupId)
            for kept in try self.records.outboxList(userId: user, groupId: groupId) {
                let opened: OutboxCall
                do {
                    opened = try self.vault.areaLedger.outboxOpen(groupId: groupId, outboxId: kept.outboxId, userId: user, entry: kept.entry)
                } catch CoreError.Sealed {
                    continue
                }
                let route: ChainRoute
                switch opened {
                case .send(_, let r, _), .landed(_, let r), .superseded(_, let r): if heldOnly { continue } else { route = r }
                case .hold(_, let r, _): route = r
                }
                guard case .admit(let who) = route, who.lowercased() == person.lowercased() else { continue }
                try self.records.outboxDelete(userId: user, groupId: groupId, outboxId: kept.outboxId)
            }
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
