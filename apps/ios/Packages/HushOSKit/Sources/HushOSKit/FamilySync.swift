import Foundation
import HushOSCore
import os

private let familyLog = Logger(subsystem: "com.hushos.app", category: "family")

/*
 * Syncing one family on this phone (docs/groups-mobile-plan.md, iOS 1; the web's
 * apps/web/src/lib/groups/sync.ts and pins.ts): the member list from route 5, accepted by the
 * core's area ledger against this person's marks (the device record, the settings pin, and the
 * chain committed this session); the record written from that acceptance only, never over a
 * record at a later roster version; every family folder from route 25 opened from its grant
 * and its top folder listed through the ledger; and only then the settings pin brought up to
 * the acceptance with the folders just opened. Nothing here writes a family folder; the vault's
 * writes there take their keys from the same ledger and their records' forms from `prior`.
 *
 * Every rule (what is a rollback, a fork, a race, whose grant opens what) is the core's; this
 * file fetches, stores and keeps the order. Runs for one family at a time: a second sync of the
 * same family waits for the first.
 */

/* Whether a family folder could be written on this device, as the web words it (sync.ts areaWrite). */
public enum AreaWrite: Sendable, Equatable {
    case writable, readOnly, keysChanged
}

/* One family folder, as this device opened it. */
public struct FamilyArea: Sendable, Equatable, Identifiable {
    public let workspaceId: String
    /* From the top folder's sealed metadata; nil when it did not open. */
    public var name: String?
    public var root: NodeView?
    /* The folder's key opened from a grant the member list vouches for. */
    public var opened = false
    /* Its top folder opened through the ledger at the member list's latest key version. */
    public var rootListed = false
    public var rotating = false
    public var write: AreaWrite = .readOnly
    public var id: String { workspaceId }

    /* What its row says under its name, in the web's words (s/$groupId/index.tsx, areaLine). */
    public var line: String {
        // Its top folder didn't open through the ledger (a key the member list never committed to, NOT_COMMITTED_ROOT): Couldn't check.
        if !opened || root == nil || name == nil { return "Couldn’t check this folder’s keys" }
        switch write {
        case .readOnly: return "Open only: its keys couldn’t be checked here"
        case .keysChanged: return "Its keys changed. Open it to check again."
        case .writable: return rotating ? "Finishing a key change…" : "Everyone in the family can open it"
        }
    }

    /* Whether it can be opened here: its key and its top folder both opened. */
    public var openable: Bool { opened && root != nil && name != nil }
}

/* A member as the accepted member list names them: roles are the list's, names come from route 3. */
public struct FamilyMember: Sendable, Equatable, Identifiable {
    public let userId: String
    public let roles: [String]
    /* The key commitment of their entry's four keys (the web's entryCommitment); nil when it makes none. */
    public var commitment: String? = nil
    public var id: String { userId }
}

/*
 * Folders this family's member list names that aren't its own (the ledger's `foreign_listings`),
 * one notice per owner: another family (`owner`), or this account's own files (nil). Ignored for
 * every decision; said on the family's page with the web's words (copy.ts, foreign-listing).
 */
public struct ForeignNotice: Sendable, Equatable {
    public let owner: String?
    public let count: Int

    public func title(family: String) -> String {
        if owner == nil { return "\(family)’s member list names your own files" }
        return count == 1 ? "\(family)’s member list names a folder that isn’t its own" : "\(family)’s member list names folders that aren’t its own"
    }

    public func body(family: String, familyOf: (String) -> String?) -> String {
        let them = count == 1 && owner != nil ? "it" : "them"
        let what = owner.map { "\(count == 1 ? "one" : String(count)) of \(familyOf($0) ?? "another family")’s folders" } ?? "your own files, in My files"
        return [
            "It names \(what).",
            "HushOS ignored that, so nothing in \(them) was shared or changed.",
            "Someone who manages, or managed, \(family) signed it, and the server accepted it.",
            "A member list keeps everything it names, so this notice stays.",
            "Tell the other members of \(family).",
        ].joined(separator: " ")
    }
}

public struct FamilyView: Sendable, Equatable {
    public let groupId: String
    public let rosterVersion: UInt64
    public let rosterDigest: String
    public let groupKeyVersion: UInt64
    public let members: [FamilyMember]
    public let areas: [FamilyArea]
    /* This device's saved check didn't open (a master-key rotation) and the family was checked from the start. */
    public let recordReset: Bool
    /* A roster named keys that aren't this account's for its entry: the web's hard warning. */
    public let ownEntryWrong: Bool
    /* The member list still names this account's previous keys: a note, not a warning. */
    public let ownEntryBehind: Bool
    public let foreign: [ForeignNotice]
}

/* The hard warning's technical details: what was shown differently, at which version, and where each side came from. */
public struct FamilyFork: Sendable, Equatable {
    public struct Side: Sendable, Equatable {
        public let digest: String
        /* "your account’s earlier check", "this device’s earlier check", "what the server shows now". */
        public let from: [String]
    }
    public let memberList: Bool
    public let version: UInt64
    public let sides: [Side]
}

public enum FamilyState: Sendable, Equatable {
    /* Accepted the invitation, not let in yet. */
    case waiting
    /* Nothing on this device or in the account's settings checked the family: only joining can start it. */
    case unchecked
    case accepted(FamilyView)
    /* The member list was shown differently to this person: nothing opens. */
    case fork(FamilyFork)
    /* The server said this account is not in the family: what the phone kept of it is gone. */
    case wiped
    /* Couldn't check: the words to show (FamilyWords). */
    case failed(String)
}

/*
 * A family folder item, as the web's Info and mark say it: the mark (nil when nothing is
 * marked), Info's "Changed by" for the worst record, "Written by" and "Keys replaced by" for a
 * re-keyed item, and "Verified by <family>" when every record verified on the family's word.
 */
public struct FamilyVerdict: Sendable, Equatable {
    public let mark: FamilyMark?
    public let changedBy: (label: String, words: String)?
    public let writtenBy: String?
    public let replacedBy: [String]
    public let verifiedBy: String?
    /* Who wrote it, when nobody checked them (a family taken on first use) and no mark speaks instead: Info's "Added by". */
    public var seen: FamilySeen? = nil

    public var provenance: Provenance? { mark.map { .family($0) } }

    public static func == (a: FamilyVerdict, b: FamilyVerdict) -> Bool {
        a.mark == b.mark && a.changedBy?.label == b.changedBy?.label && a.changedBy?.words == b.changedBy?.words
            && a.writtenBy == b.writtenBy && a.replacedBy == b.replacedBy && a.verifiedBy == b.verifiedBy && a.seen == b.seen
    }

    /* Everything unchecked: whom to judge by didn't load. */
    static let unchecked = FamilyVerdict(
        mark: FamilyMark(label: "Couldn’t check", lines: [FamilyLines.couldntCheck], danger: false, retry: true, check: nil),
        changedBy: ("Changed by", "Not checked"), writtenBy: nil, replacedBy: [], verifiedBy: nil
    )
}

/*
 * Who wrote a family item whose writer nobody checked (2.6, first use): Info's "Added by <name>"
 * with "Not verified · Check it's <first name>", as personal files say it. The account id picks
 * the check: the family's member check for a member, the person's own otherwise.
 */
public struct FamilySeen: Sendable, Equatable {
    public let name: String
    public let userId: String
    public let email: String?
}

struct FamilyFailure: Error, LocalizedError, Equatable {
    let message: String
    var errorDescription: String? { message }
    /* Route 2 no longer lists the family, or route 3 answered not-member: what was opened is wiped. */
    static let notInFamily = FamilyFailure(message: "You’re not in this family any more.")
}

public actor FamilySync: FamilyJudge {
    let vault: Vault
    let api: GroupsAPI
    let records: FamilyRecords
    let now: @Sendable () -> Date
    /* The last piece of work queued for each family: syncs and the join's steps run one at a time per family (the web's lock). */
    private var tails: [String: Task<Void, Never>] = [:]
    /* Each family's members and their identities from the last sync (routes 3 and 6). */
    private var details: [String: GroupDetail] = [:]
    private var identities: [String: [String: MemberIdentity]] = [:]
    private var families: [String: String] = [:]
    /* Each family as route 2 or a caller last named it, for checking it again from a write that waits. */
    private var summaries: [String: GroupSummary] = [:]
    /* Syncs not finished yet, per family: uploads waiting together share the one running rather than queue one each. */
    private var running: [String: Int] = [:]
    private var areasOf: [String: [String]] = [:]
    /* Every family folder this process learned of, to its family: never forgotten in a session (a wipe or fork keeps it a family folder). */
    private var groupsOf: [String: String] = [:]
    /* Families route 2 stopped listing that this session wiped on the server's not-member: not asked about again unless listed again. */
    private var settledUnlisted: Set<String> = []
    /* A 401 a sync met, until the app takes it (takeEnded). */
    private var endedBy: (any Error)?
    /*
     * Whether this person vouched for each family (Settings.familyChecked), read after every
     * accepted sync: until it is, a family reads as first use (an under-claim, never an over-claim).
     */
    var vouched: [String: Bool] = [:]
    /* Each family's chain as this process last committed it. */
    private var chains: [String: AcceptedRosters] = [:]
    /* Families whose last refusal was a fork (lowercase): a later refusal keeps the core's fork. A commit clears it. */
    private var forked: Set<String> = []
    /* Families accepted in this process and not refused, forked or wiped since (lowercase): whose proven folders' copies may stay. */
    private var acceptedFamilies: Set<String> = []

    public init(vault: Vault, api: GroupsAPI? = nil, records: FamilyRecords = .shared, now: @escaping @Sendable () -> Date = { Date() },
                temporary: URL = FileManager.default.temporaryDirectory) {
        self.vault = vault
        self.api = api ?? GroupsAPI(drive: vault.api)
        // Kept to its vault's session, never the one open as it is made: a sync made late for a replaced vault
        // deletes and writes no record or copy, its first sweep included, since those there now are the next session's.
        let session = vault.copySession
        self.session = session
        self.records = records.bound(to: session)
        // The families start with nothing proven: every family copy goes before any family download (sweepCopies).
        TemporaryCopies.sweepFamily(keeping: [], in: temporary, session: session)
        self.now = now
        self.temporary = temporary
    }

    /* This process's temporary folder, where opened copies of family items are kept (TemporaryCopies.openedFolder). */
    let temporary: URL
    /* The session this sync belongs to (CopySession): its cleanup and record writes do nothing once it ended. */
    public nonisolated let session: CopySession

    /*
     * One per session in this process: the app's screens and any background task share it. None
     * for a vault whose session ended or that a later vault replaced (a family request of the last
     * session that runs after a sign-in): it would take the new session's place.
     */
    private static let registry = Registry()
    public static func shared(for vault: Vault) -> FamilySync? { registry.sync(for: vault) }

    /*
     * Sign-out (and deletion, and a removed device): the session's sync goes, the ledger it held is
     * wiped, and the session's vault is let go, so nothing keeps the family keys alive.
     */
    public static func forget() {
        registry.forget()
        Vault.forgetCurrent()
    }

    private final class Registry: @unchecked Sendable {
        private let lock = NSLock()
        private weak var vault: Vault?
        private var current: FamilySync?
        /* The latest vault a sync was made for (Vault.serial): an earlier one is replaced, whether its sync is held or not. */
        private var latest: UInt64 = 0
        func sync(for vault: Vault) -> FamilySync? {
            lock.withLock {
                if let current, self.vault === vault, vault.copySession.stands { return current }
                guard vault.serial >= latest, vault.copySession.stands else { return nil }
                latest = vault.serial
                let made = FamilySync(vault: vault)
                self.vault = vault
                current = made
                return made
            }
        }
        func forget() {
            let dropped = lock.withLock { () -> FamilySync? in
                defer { current = nil; vault = nil }
                return current
            }
            dropped?.vault.areaLedger.clear()
        }
    }

    var ledger: AreaLedger { vault.areaLedger }
    var userId: String { vault.session.userId }

    /* Route 2: the families whose ids are ids (a server's other strings never reach a path or a file name). */
    public func list() async throws -> [GroupSummary] {
        let groups = try await api.listGroups().filter { FamilyRecords.valid($0.id) }
        for group in groups {
            families[group.id] = group.name
            summaries[group.id] = group
        }
        return groups
    }

    /*
     * A family's folders open in this process's ledger for a write that may run without the
     * screens (the upload queue, after a background launch): checked now unless this process
     * already accepted it. Throws the family's words when it isn't accepted.
     */
    public func ensureOpen(_ groupId: String) async throws {
        // Accepted in this process and not refused since (a refusal drops the chain): open already.
        if chains[groupId] != nil, areasOf[groupId] != nil, ledger.isArea(workspaceId: areasOf[groupId]?.first ?? "") { return }
        let summary: GroupSummary
        if let known = summaries[groupId] { summary = known } else {
            let listed: [GroupSummary]
            do { listed = try await list() } catch where Self.unanswered(error) {
                // No answer is the network's: the queue waits for one, it doesn't fail the upload.
                throw DriveAPI.noAnswer(error)
            }
            guard let found = listed.first(where: { $0.id.lowercased() == groupId.lowercased() }) else {
                throw FamilyFailure.notInFamily
            }
            summary = found
        }
        switch await sync(summary) {
        case .accepted: return
        case .failed(let words) where words == FamilyWords.noAnswer: throw DriveAPIError.transport(words)
        case .failed(let words): throw FamilyFailure(message: words)
        case .wiped: throw FamilyFailure.notInFamily
        default: throw FamilyFailure(message: FamilyWords.openAgain)
        }
    }

    /*
     * Families this phone holds (a device record, or a chain accepted this session) that route 2 no
     * longer lists: each asked about once (route 5 from the record's version). Only the server's
     * 404 `not-member` wipes one, as any sync's does (`wipe`); a family still served (route 2 caught
     * between two states) or no answer at all changes nothing. A list that didn't load never reaches
     * here: nothing is unlisted without one. The wiped families, by id; and those the server said
     * not-member of whose wipe couldn't store the guard it hands back (`failed`, with the words to
     * show, as a sync's failed wipe says them): kept, with their device record, and asked again.
     */
    public func listReconciling() async throws -> (listed: [GroupSummary], removed: [String], failed: [String: String]) {
        // Route 2 first: when it doesn't load, nothing is unlisted and nothing is asked about.
        let listed = try await list()
        let (removed, failed) = await reconcile(listed: listed)
        return (listed, removed, failed)
    }

    func reconcile(listed: [GroupSummary]) async -> (removed: [String], failed: [String: String]) {
        let shown = Set(listed.map { $0.id.lowercased() })
        settledUnlisted.subtract(shown)
        var held = Set(records.groups(userId: userId))
        held.formUnion(groupsOf.values.map { $0.lowercased() })
        held.subtract(settledUnlisted)
        var wiped: [String] = []
        var failed: [String: String] = [:]
        for groupId in held.subtracting(shown).sorted() where FamilyRecords.valid(groupId) {
            switch await checkUnlisted(groupId) {
            case .kept: break
            case .wiped: wiped.append(groupId)
            case .failed(let words): failed[groupId] = words
            }
        }
        return (wiped, failed)
    }

    private enum Unlisted: Sendable { case kept, wiped, failed(String) }

    /* One family route 2 stopped listing, asked about in its own turn. */
    private func checkUnlisted(_ groupId: String) async -> Unlisted {
        await exclusive(groupId) { await self.askUnlisted(groupId) }
    }

    private func askUnlisted(_ groupId: String) async -> Unlisted {
        let after = Int(records.read(userId: userId, groupId: groupId)?.rosterVersion ?? 0)
        do {
            _ = try await api.rosters(groupId, after: after)
            // Still served: a list caught mid-change, never a removal.
            return .kept
        } catch let error as GroupsAPIError where error.isNotMember {
            do {
                try await wipe(groupId)
            } catch {
                // The guard the wipe hands back couldn't be stored (or read): nothing of the family was let go of, and
                // nothing of it opens here; said as a sync's failed wipe is, and asked again on the next pass.
                await refuse(groupId)
                return .failed(FamilyWords.error(error))
            }
            forgetSession(groupId)
            return .wiped
        } catch {
            // No answer, a 5xx, any other refusal: nothing is taken away.
            return .kept
        }
    }

    /*
     * A wiped family's place in route 2 goes with it, and it isn't asked about again this session
     * unless route 2 lists it again. Its folders stay family folders (`groupsOf`): never opened under
     * a personal key, whatever a server says later.
     */
    private func forgetSession(_ groupId: String) {
        summaries[groupId] = nil
        families[groupId] = nil
        settledUnlisted.insert(groupId.lowercased())
    }

    /* Route 3 as the last sync read it: who is in the family, named by the server. */
    public func detail(_ groupId: String) -> GroupDetail? { details[groupId] }

    /* Routes 14 and 15: the mailed invitation opened, then accepted (which lets nobody in; the join screen comes next). */
    public func openInvitation(_ token: String) async throws -> Invitation { try await api.openInvitation(token) }
    public func acceptInvitation(_ token: String) async throws -> String { try await api.acceptInvitation(token) }

    /* Route 3 read now (it answers someone who accepted, too): who manages the family, for the join screen to name. */
    public func members(_ groupId: String) async throws -> GroupDetail {
        let detail = try await api.group(groupId)
        details[groupId] = detail
        return detail
    }

    /* Every family folder this process knows of, to its family id. */
    public func familyAreas() -> [String: String] { groupsOf }

    /* Folders route 25 named for the family and derived under it: family folders for the rest of the session. */
    private func note(_ areas: [String], of groupId: String) async {
        for area in areas { groupsOf[area.lowercased()] = groupId }
        await vault.noteFamilyWorkspaces(areas, of: groupId)
    }

    /* One family synced, after any sync of it already running. */
    public func sync(_ summary: GroupSummary) async -> FamilyState { await syncRevised(summary).state }

    /* A sync's outcome and the revision it ran at (`FamilySync.revise`), for the screens to order answers by. */
    public struct Revised: Sendable {
        public let state: FamilyState
        public let revision: UInt64
    }

    /*
     * Revisions for every family, taken inside the family's turn as an answer is settled: a later
     * revision is a later look at the family, whenever it was asked for. Process-wide, so what
     * publishes without one (a join, a removal the list found) can take the latest.
     */
    private static let revisions = OSAllocatedUnfairLock(initialState: UInt64(0))
    static func revise() -> UInt64 { revisions.withLock { $0 += 1; return $0 } }
    /* The last revision given out: an answer taken at or before it is no later than now. */
    public static func latestRevision() -> UInt64 { revisions.withLock { $0 } }

    /* A sync with the revision it ran at: taken inside the family's turn, after the sync settled. */
    public func syncRevised(_ summary: GroupSummary) async -> Revised {
        families[summary.id] = summary.name
        summaries[summary.id] = summary
        // The vault asks this sync how family records are signed again (FamilyJudge).
        await vault.useFamilyJudge(self)
        running[summary.id, default: 0] += 1
        defer { running[summary.id, default: 1] -= 1 }
        return await exclusive(summary.id) { Revised(state: await self.run(summary), revision: Self.revise()) }
    }

    /* `body` once every earlier piece of work on the family has finished, and before any queued after it. */
    func exclusive<T: Sendable>(_ groupId: String, _ body: @escaping @Sendable () async -> T) async -> T {
        let previous = tails[groupId]
        let task = Task { () -> T in
            _ = await previous?.value
            return await body()
        }
        tails[groupId] = Task { _ = await task.value }
        return await task.value
    }

    func exclusive<T: Sendable>(_ groupId: String, _ body: @escaping @Sendable () async throws -> T) async throws -> T {
        let result: Result<T, Error> = await exclusive(groupId) {
            do { return .success(try await body()) } catch { return .failure(error) }
        }
        return try result.get()
    }

    /* One sync's work, run inside the family's turn (`exclusive`): a join step that syncs calls it from its own turn. */
    func run(_ summary: GroupSummary) async -> FamilyState {
        let groupId = summary.id
        guard FamilyRecords.valid(groupId) else { return .failed("Please try again.") }
        // Accepted but not let in: the join flow's (iOS 3), never a sync's. Nothing of the family stays open meanwhile.
        // A record on this device means the join finished (a list read before it, still saying `accepted`): synced as a member.
        if summary.state == "accepted" && records.read(userId: userId, groupId: groupId) == nil {
            await refuse(groupId)
            return .waiting
        }
        do {
            try await vault.prepareLedger()
            var reset = false
            for _ in 0 ..< 2 {
                switch try await accept(groupId) {
                case .unchecked:
                    await refuse(groupId)
                    return .unchecked
                case .fork(let fork):
                    await refuse(groupId, fork: true)
                    return .fork(fork)
                case .recordReset:
                    reset = true
                    continue
                case .accepted(let chain, let pin):
                    return try await afterAcceptance(groupId, chain: chain, pin: pin, reset: reset)
                }
            }
            throw FamilyFailure(message: "This device’s saved check of the family could not be opened.")
        } catch let error as GroupsAPIError where error.isNotMember {
            do {
                try await wipe(groupId)
            } catch {
                // The guard the wipe hands back couldn't be stored (or read): nothing of the family was let go of, but
                // nothing of it opens either.
                await refuse(groupId)
                return .failed(FamilyWords.error(error))
            }
            return .wiped
        } catch {
            // Refused (a rollback, a race that kept losing, keys that didn't check): the ledger kept nothing of this run, and
            // nothing of the family stays open here. No answer at all leaves what was opened before as it was.
            if !Self.unanswered(error) { await refuse(groupId) }
            // A 401: kept for the app (takeEnded), which asks whether the session ended.
            if endsSession(error) { endedBy = error }
            return .failed(FamilyWords.error(error))
        }
    }

    /*
     * What follows a committed acceptance, a sync's or a join's (the web's afterAccept): every family
     * folder opened from its grant, then the settings pin brought up to the acceptance with the
     * folders just opened. A pin that names another history is the hard warning.
     */
    func afterAcceptance(_ groupId: String, chain: AcceptedRosters, pin: GroupPin, reset: Bool) async throws -> FamilyState {
        let areas = try await openAreas(groupId, chain: chain)
        switch try await settle(groupId, pin: pin, checked: chain.checked(), opened: areas.compactMap(\.pinArea)) {
        case .fork(let fork):
            await refuse(groupId, fork: true)
            return .fork(fork)
        case .settled(let latest):
            // The family's details are a nicety: going without them is fine, but not-member means the family went (the wipe)
            // and a 401 that the session may have ended (handed on).
            do {
                details[groupId] = try await api.group(groupId)
            } catch let error as GroupsAPIError where error.isNotMember {
                throw error
            } catch where endsSession(error) {
                throw error
            } catch {}
            // Read with the settings the pin was just saved into: Verified by the family only when this person vouched for it.
            vouched[groupId] = (try? await vault.familyChecked(groupId)) ?? false
            return .accepted(view(groupId, chain: latest ?? chain, areas: areas.map(\.area), reset: reset))
        }
    }

    /* Whether this person vouched for the family, as the last accepted sync read it (false until one did). */
    public func familyChecked(_ groupId: String) -> Bool { vouched[groupId] ?? false }

    /* A 401 a sync met, once, for the app to treat as any request's (the session may have ended): nil when none. */
    public func takeEnded() -> (any Error)? {
        defer { endedBy = nil }
        return endedBy
    }

    /* The chain this process last accepted for the family: the pair code is worked out over it. */
    func acceptedChain(_ groupId: String) -> AcceptedRosters? { chains[groupId] }

    func noteAccepted(_ groupId: String, _ chain: AcceptedRosters) {
        chains[groupId] = chain
        forked.remove(groupId.lowercased())
        acceptedFamilies.insert(groupId.lowercased())
    }

    /*
     * The allowlist sweep (TemporaryCopies.sweepFamily): only the copies of folders proven this
     * process to belong to a family accepted now (or shown read only after no answer) stay. Run when
     * this sync starts, after every refusal, fork or wipe, after an unreadable record goes, and
     * whenever a family's folders change. Nothing once this session ended.
     */
    func sweepCopies() {
        let keep = Set(groupsOf.filter { acceptedFamilies.contains($0.value.lowercased()) }.map(\.key))
        TemporaryCopies.sweepFamily(keeping: keep, in: temporary, session: session)
    }

    /* A device record nothing opens any more: its folders' rows and keys first (the sweep takes their copies), then the record. */
    func dropUnreadableRecord(_ groupId: String) async {
        await vault.forgetWorkspaces(await knownAreas(groupId))
        records.delete(userId: userId, groupId: groupId)
        sweepCopies()
    }

    /*
     * Refused (a settings rollback, a fork, a guard that can't be stored, an unchecked chain, keys
     * that didn't check, a race that kept losing): the core opens and writes nothing of the family
     * until a chain is committed again (the web's uncommit), so no listing or queued upload goes on
     * through the chain an earlier sync committed, and nothing of it stays open here. A refusal of
     * a family found forked keeps the fork.
     */
    func refuse(_ groupId: String, fork: Bool? = nil) async {
        let key = groupId.lowercased()
        let fork = fork ?? forked.contains(key)
        if fork { forked.insert(key) }
        ledger.uncommit(groupId: groupId, fork: fork)
        chains[groupId] = nil
        acceptedFamilies.remove(key)
        await forgetOpened(groupId)
        sweepCopies()
    }

    /*
     * The server said not-member outside a sync (a member check's own read of the member list): let
     * go of in two phases as a sync's removal is, after any sync of it; a guard the wipe can't store
     * leaves the family refused instead.
     */
    func removedNow(_ groupId: String) async -> Revised {
        await exclusive(groupId) {
            let state: FamilyState
            do {
                try await self.wipe(groupId)
                state = .wiped
            } catch {
                await self.refuse(groupId)
                state = .failed(FamilyWords.error(error))
            }
            return Revised(state: state, revision: Self.revise())
        }
    }

    /* The family folders this process or the device record knows of. */
    /*
     * Everything opened of a family on this phone goes (a not-member wipe, a fork, a refusal, a
     * guard that couldn't be stored): its rows and keys, and the plaintext copies opened from it,
     * by every folder of it this phone knows, the device record's included, not only those this
     * session listed.
     */
    func forgetOpened(_ groupId: String) async {
        let areas = await knownAreas(groupId)
        await vault.forgetWorkspaces(areas)
        TemporaryCopies.forgetFamily(areas, in: temporary, session: session)
    }

    /*
     * The family folders this process or the device record knows of, that may be let go of with the
     * family: never one proven another family's (derived under it, seen this process) or this
     * account's own drive, whatever a member list or a saved record names. A roster's word alone
     * clears nothing.
     */
    func knownAreas(_ groupId: String) async -> [String] {
        let key = groupId.lowercased()
        let known = groupsOf.filter { $0.value.lowercased() == key }.map(\.key)
        var out: [String] = []
        // A record an earlier version wrote names folders on a member list's word alone (a received share's maybe): hints, never
        // let go of with the family (FamilyRecords.Row.ownedAreas).
        for area in Set((known + (areasOf[groupId] ?? []) + (records.read(userId: userId, groupId: groupId)?.ownedAreas ?? [])).map { $0.lowercased() }) {
            if await owned(area, by: groupId) { out.append(area) }
        }
        return out.sorted()
    }

    /* Whether a folder may be let go of with `groupId`: never one proven another family's, never the own drive. */
    private func owned(_ area: String, by groupId: String) async -> Bool {
        if let owner = groupsOf[area.lowercased()], owner.lowercased() != groupId.lowercased() { return false }
        return await vault.mayForget(area, with: groupId)
    }

    /*
     * The folders a device record keeps after an acceptance: every one it already holds (a folder
     * leaves the record only once its copies are forgotten, in openAreas) and those of the chain's
     * proven this family's. Merged, never replaced: after a relaunch nothing is proven yet.
     */
    func keptAreas(_ groupId: String, of chainAreas: [String]) -> [String] {
        let held = records.read(userId: userId, groupId: groupId)?.ownedAreas ?? []
        return Array(Set((held + provenAreas(groupId, of: chainAreas)).map { $0.lowercased() })).sorted()
    }

    /* The folders a device record keeps for `groupId`: of the chain's, only those proven this family's (opened under it). */
    func provenAreas(_ groupId: String, of chainAreas: [String]) -> [String] {
        let key = groupId.lowercased()
        let proven = Set(((areasOf[groupId] ?? []) + groupsOf.filter { $0.value.lowercased() == key }.map(\.key)).map { $0.lowercased() })
        return chainAreas.filter { proven.contains($0.lowercased()) }.sorted()
    }

    /* A request that got no answer, the settings route's included: nothing was refused, so nothing is taken away. */
    static func unanswered(_ error: Error) -> Bool {
        // Cancelled: nobody refused anything either.
        if ErrorWords.isCancellation(error) { return true }
        if let error = error as? GroupsAPIError { return error.status == 0 }
        if case DriveAPIError.transport = error { return true }
        if case AuthError.message(let text) = error, text == AuthError.unreachable { return true }
        if let error = error as? URLError, error.code != .cancelled { return true }
        return false
    }

    // MARK: Acceptance

    enum Acceptance {
        case unchecked
        case fork(FamilyFork)
        case recordReset
        case accepted(AcceptedRosters, GroupPin)
    }

    /*
     * One acceptance (the web's acceptServed): the settings read first, so the ledger holds
     * their pin as a mark; the record continued from its roster version; a chain that doesn't
     * continue it fetched again from version 1 **with the same record**, so the record's own pin
     * stays a mark whatever settings the server serves. A run another acceptance overtook
     * (`Overtaken`) is read again quietly, three times; then the server is said to be serving an
     * older member list. The family guard this phone holds goes in as one more mark (read afresh
     * for every call), and the guard an acceptance hands back is stored before anything else of it
     * (docs/optional-verification.md 2.8): a crash after it leaves the guard at or above the record,
     * never below. The record is written only from a committed acceptance, after the guard, and
     * never over one at a later roster version.
     */
    func accept(_ groupId: String) async throws -> Acceptance {
        var overtaken = 0
        while true {
            let pinned = try await vault.familyPin(groupId)
            let row = records.read(userId: userId, groupId: groupId)
            if row == nil && pinned == nil { return .unchecked }
            let me = try await vault.ownIdentities()
            let checkedAt = Self.checkTime(now())
            var served = try await fetchServed(groupId, after: row?.rosterVersion ?? 0)
            // The write barrier (the web worker's guard owed): raised before the core commits, so no write into the
            // family seals under this acceptance until its guard is stored; put back as it was if nothing commits.
            let owedBefore = await vault.oweFamilyGuard(groupId)
            let answer: ServedAcceptance
            do {
                var first = try ledger.acceptServed(me: me, groupId: groupId, record: row?.envelope, served: served,
                                                    guard: await vault.heldFamilyGuard(groupId), checkedAt: checkedAt)
                if case .fetchFromVersionOne = first {
                    served = try await fetchServed(groupId, after: 0)
                    first = try ledger.acceptServed(me: me, groupId: groupId, record: row?.envelope, served: served,
                                                    guard: await vault.heldFamilyGuard(groupId), checkedAt: checkedAt)
                }
                answer = first
            } catch {
                if !owedBefore { await vault.familyGuardKept(groupId) }
                throw error
            }
            if case .accepted = answer {} else if !owedBefore { await vault.familyGuardKept(groupId) }
            switch answer {
            case .accepted(let chain, let record, let pin, let guardPin):
                // Its folders are held as family folders whatever follows: a guard that can't be stored refuses the family (the
                // core then opens none of them) and the barrier holds writes into them, never taken as personal. Only for the
                // barrier: a roster's word never makes a folder this family's to show or clear (route 25 and checkId do).
                await vault.holdAsFamilyWorkspaces(Array(chain.areaKeys().keys), of: groupId)
                // A guard that can't be stored stops everything of this acceptance, and the barrier stays raised until a
                // later acceptance stores it; one with nothing new to store (the held guard covers it) releases it.
                if let guardPin { try await vault.keepFamilyGuard(groupId, guardPin) }
                await vault.familyGuardKept(groupId)
                // What it held and the folders proven this family's (opened under it before): a roster's word never names
                // another's for cleanup, and nothing it held is let go of here.
                let areas = keptAreas(groupId, of: Array(chain.areaKeys().keys))
                try records.put(userId: userId, groupId: groupId, FamilyRecords.Row(envelope: record, rosterVersion: chain.roster().rosterVersion, areas: areas,
                                                                                    areasProven: true))
                noteAccepted(groupId, chain)
                return .accepted(chain, pin)
            case .fork(let of, let version, let sides):
                return .fork(Self.fork(of: of, version: version, sides: sides))
            case .recordUnreadable:
                await dropUnreadableRecord(groupId)
                return .recordReset
            case .overtaken(let split):
                overtaken += 1
                if overtaken >= 3 { throw FamilyFailure(message: servedRaceMessage(split: split)) }
            case .fetchFromVersionOne:
                throw FamilyFailure(message: "The server sent this family’s member list inconsistently.")
            }
        }
    }

    /* Route 5 from `after` to the head, a page at a time; pages that disagree on the first keys are refused. */
    func fetchServed(_ groupId: String, after: UInt64) async throws -> ServedChain {
        var rosters: [SignedGroupStatement] = []
        var signerKeys: [String: String] = [:]
        var last: RosterPage?
        var cursor = Int(after)
        for _ in 0 ..< 64 {
            let page = try await api.rosters(groupId, after: cursor)
            if let last, last.firstKeys != page.firstKeys {
                throw FamilyFailure(message: "The server sent this family’s member list inconsistently.")
            }
            rosters += try page.rosters.map { try $0.signed() }
            signerKeys.merge(page.signerKeys) { _, new in new }
            last = page
            guard let next = page.next else { break }
            guard next > cursor else { throw FamilyFailure(message: "The server sent a member list page twice.") }
            cursor = next
        }
        guard let last, last.next == nil else { throw FamilyFailure(message: "This family’s member list is too long to load.") }
        return ServedChain(
            after: after,
            firstKeys: GroupPublicKey(ed25519PublicKey: last.firstKeys.ed25519PublicKey, mlDsaPublicKey: last.firstKeys.mlDsaPublicKey),
            rosters: rosters, successions: try last.successions.map { try $0.signed() }, signerKeys: signerKeys
        )
    }

    // MARK: Family folders

    struct OpenedFolder {
        var area: FamilyArea
        var pinArea: OpenedArea?
    }

    /*
     * Every family folder route 25 lists for the family, opened in the ledger as the web's worker
     * opens it (`open_family_area`, Core 6): this account's self-grant when it is at the folder's
     * current version, else the area grant through its granter's keys from route 6 (the identity
     * it was sealed to is opened by the ledger, under the account root). A self-grant the ledger
     * wraps from a current grant is stored (route 23), so the folder keeps opening after its
     * granter's identity is gone. The key never leaves the ledger. Then the top folder is listed
     * through the ledger, which counts a folder as rooted only once it opened that itself. A
     * folder that doesn't open says "Couldn't check this folder's keys", as the web's row.
     */
    func openAreas(_ groupId: String, chain: AcceptedRosters) async throws -> [OpenedFolder] {
        let spaces = try await api.spaces()
        guard let space = spaces.first(where: { $0.space.kind == "group" && $0.space.groupId?.lowercased() == groupId.lowercased() }) else { return [] }
        // Only folders whose ids are derived under this family count as its own: never the personal drive, never another family's.
        let family = space.areas.filter { area in
            guard let seed = area.idSeed else { return false }
            return (try? checkId(kind: .workspace, scopeId: groupId, seed: seed, id: area.workspaceId)) != nil
        }
        let proven = family.map { $0.workspaceId.lowercased() }.sorted()
        // A folder the family no longer lists (deleted elsewhere, maybe while the app was closed): its rows, keys and copies
        // go before anything lets go of the tie between it and the family, so no plaintext of it outlives the last place a
        // cleanup would find it. An ended session forgets nothing, and so lets go of nothing.
        let row = records.read(userId: userId, groupId: groupId)
        var dropped: [String] = []
        for area in Set(((areasOf[groupId] ?? []) + (row?.ownedAreas ?? [])).map { $0.lowercased() }) where !proven.contains(area) {
            if await owned(area, by: groupId) { dropped.append(area) }
        }
        var forgotten: Set<String> = []
        if !dropped.isEmpty {
            await vault.forgetWorkspaces(dropped)
            if TemporaryCopies.forgetFamily(dropped, in: temporary, session: session) { forgotten = Set(dropped) }
        }
        areasOf[groupId] = family.map(\.workspaceId)
        await note(family.map(\.workspaceId), of: groupId)
        // The record keeps what it held and the folders proven this family's now, less those just forgotten: merged, never
        // replaced, so a folder deleted while the app was closed is still found after a relaunch.
        // An earlier version's record is rewritten with the proven folders alone: its other areas were a member list's word.
        if let row {
            let kept = Array(Set(row.ownedAreas.map { $0.lowercased() } + proven)).filter { !forgotten.contains($0) }.sorted()
            // Passed on: folders whose ids couldn't be kept are not opened, so no copy of them is made either.
            if kept != row.ownedAreas.map({ $0.lowercased() }).sorted() || row.areasProven != true,
               !(try records.put(userId: userId, groupId: groupId, FamilyRecords.Row(envelope: row.envelope, rosterVersion: row.rosterVersion, areas: kept,
                                                                                     areasProven: true))) {
                throw FamilyRecords.RecordsError.busy
            }
        }
        // The family's folders changed: only the copies of folders proven a family's accepted now stay.
        sweepCopies()
        let served = try await fetchIdentities(groupId)
        identities[groupId] = served
        let keyVersion = try await vault.accountKeyVersion()
        var out: [OpenedFolder] = []
        for area in family {
            // The top folder is set only once it proved to be this area's own (below): a refused one is never handed out.
            var folder = OpenedFolder(area: FamilyArea(workspaceId: area.workspaceId, root: nil, rotating: area.rotation != nil))
            do {
                guard let seed = area.idSeed else {
                    out.append(folder)
                    continue
                }
                var grant: ServedAreaGrant?
                // Without this account's identity at the grant's key version the grant cannot open, and a
                // grant or granter key that doesn't decode opens nothing either: the self-grant still may, as on
                // the web. No answer while the identity history is read leaves things as they were.
                if let row = area.grant, let envelope = try? base64urlDecode(value: row.envelope) {
                    var holder: IdentityEnvelope?
                    do {
                        holder = try await vault.identityEnvelope(atKeyVersion: row.granteeKeyVersion)
                    } catch where Self.unanswered(error) {
                        throw error
                    } catch {
                        holder = nil
                    }
                    if let holder {
                        // The granter's keys only when route 6 serves their identity: an account gone serves none.
                        let granter = memberIdentity(row.granterUserId, in: groupId)
                        grant = ServedAreaGrant(
                            envelope: envelope, workspaceKeyVersion: row.workspaceKeyVersion,
                            granteeKeyVersion: row.granteeKeyVersion, granterUserId: row.granterUserId, rosterVersion: row.rosterVersion,
                            rosterDigest: row.rosterDigest,
                            granterMlDsaPublicKey: granter.flatMap { try? base64urlDecode(value: $0.identity.mlDsaPublicKey) },
                            granterHistory: granter.map { SignerHistory(served: $0.identity.served, links: $0.links) },
                            holder: holder
                        )
                    }
                }
                let opened = try ledger.openFamilyArea(
                    groupId: groupId,
                    area: ServedArea(workspaceId: area.workspaceId, idSeed: seed, servedVersion: area.workspaceKeyVersion,
                                     grant: grant, selfGrant: area.selfGrant?.grant),
                    accountKeyVersion: keyVersion
                )
                if let own = opened.selfGrantToStore {
                    do {
                        try await api.putSelfGrant(groupId, workspaceId: area.workspaceId, grant: own)
                    } catch let error as GroupsAPIError where error.isNotMember {
                        throw error
                    } catch {
                        // `area-moved` or no answer: the folder is open now; the next sync wraps the current key again.
                    }
                }
                folder.area.opened = true
                folder.pinArea = opened.opened.pinArea
                if let root = area.root {
                    // The area's own top folder or nothing: a server naming a folder of another workspace (this account's own
                    // drive, another family's) or one inside the area is the family's Couldn't check, never opened by its own
                    // workspace's key path, checked before any cache is touched.
                    guard Self.isAreaRoot(root, of: area.workspaceId) else { throw FamilyFailure(message: "Couldn’t check this folder’s keys") }
                    let item = try await vault.openListed(root)
                    folder.area.root = root
                    folder.area.name = item.name
                    folder.area.rootListed = root.parentKeyEpoch == areaWriteVersion(chain: chain, workspaceId: area.workspaceId)
                }
                folder.area.write = Self.write(reason: opened.opened.reason, rootListed: folder.area.rootListed, root: folder.area.root != nil)
            } catch let error as GroupsAPIError where error.isNotMember {
                throw error
            } catch where Self.unanswered(error) {
                // No answer (the identity history): nothing was refused, so the sync leaves things as they were.
                throw error
            } catch {
                // The row says "Couldn't check this folder's keys", as the web's does; nothing of it opens.
                folder.area.root = nil
                folder.area.name = nil
                folder.area.write = .readOnly
            }
            out.append(folder)
        }
        return out
    }

    /* A family area's top folder: a folder of that very workspace, at its top (no parent, or the workspace itself). */
    static func isAreaRoot(_ root: NodeView, of workspaceId: String) -> Bool {
        root.workspaceId.lowercased() == workspaceId.lowercased() && root.isFolder
            && (root.parentId == nil || root.parentId?.lowercased() == workspaceId.lowercased())
    }

    /* A member's identity and links as route 6 served them, by user id in any case; none when it served none. */
    private func memberIdentity(_ userId: String, in groupId: String) -> (identity: MemberIdentity.Identity, links: [SuccessionLink])? {
        guard let member = identities[groupId]?[userId.lowercased()], let identity = member.identity else { return nil }
        return (identity, member.links.map(\.link))
    }

    /* As the web's areaWrite: what the ledger found, and whether the top folder opened at the latest version. */
    static func write(reason: AreaBlock?, rootListed: Bool, root: Bool) -> AreaWrite {
        if reason == .noGrantAtLatest { return .readOnly }
        if reason == .serverBehind || reason == .serverAhead { return .keysChanged }
        if rootListed { return .writable }
        return root ? .keysChanged : .readOnly
    }

    /* Route 6, every page: each member's identity and links, by lowercase user id. */
    func fetchIdentities(_ groupId: String) async throws -> [String: MemberIdentity] {
        var out: [String: MemberIdentity] = [:]
        var after: String?
        for _ in 0 ..< 64 {
            let page = try await api.identities(groupId, after: after)
            for member in page.identities { out[member.userId.lowercased()] = member }
            guard let next = page.next else { return out }
            after = next
        }
        throw FamilyFailure(message: "This family has too many members to load.")
    }

    // MARK: The settings pin

    enum Settled {
        case settled(AcceptedRosters?)
        case fork(FamilyFork)
    }

    /*
     * The settings pin brought up to the acceptance (the web's settlePin): never lower, compare
     * and set, and areas only from grants opened here. When the stored pin is ahead or names
     * another history, or another device saved meanwhile, the family is accepted again with the
     * settings read anew, and only that acceptance's pin is saved; four tries, as the web. The
     * only `next` is an acceptance's pin; the only opened areas are the ledger's.
     */
    func settle(_ groupId: String, pin accepted: GroupPin, checked: FamilyChecked?, opened: [OpenedArea]) async throws -> Settled {
        var pin = accepted
        var latest: AcceptedRosters?
        for _ in 0 ..< 4 {
            let current = try await vault.familyPin(groupId)
            if case .merged(let merged) = try mergePin(groupId: groupId, current: current, next: pin, opened: opened) {
                if !pinAhead(current: current, next: merged) { return .settled(latest) }
                if try await vault.saveGroupPin(groupId, over: current, merged, checked: checked, now: Self.checkTime(now())) { return .settled(latest) }
            }
            // Behind, a conflict, or a save another device won: accept again against what is stored now.
            switch try await accept(groupId) {
            case .fork(let fork): return .fork(fork)
            case .accepted(let chain, let next):
                pin = next
                latest = chain
            case .recordReset, .unchecked:
                throw FamilyFailure(message: "This device’s saved check of the family could not be opened.")
            }
        }
        throw FamilyFailure(message: "Your settings keep changing on another device. Try again.")
    }

    // MARK: Not a member

    /*
     * Only after a 404 `not-member`: the ledger's chain and keys, the device record and the
     * folders opened here go. **The settings pin and the family guard stay**: if the family comes
     * back (a server that said not-member to erase a warning, then served settings without the pin
     * and a fresh invitation), they are still marks, and first use is refused. Nothing goes until
     * the core let go of the family, which waits for the guard it hands back to be stored; a guard
     * that can't be stored or read throws, and nothing is deleted.
     */
    func wipe(_ groupId: String) async throws {
        let areas = await knownAreas(groupId)
        guard try await forgetInCore(groupId) else { return }
        // Its folders' rows, keys and copies first, then the record that ties them to the family: a stop in between leaves
        // the record, and the next cleanup finds them again.
        await vault.forgetWorkspaces(areas)
        TemporaryCopies.forgetFamily(areas, in: temporary, session: session)
        records.delete(userId: userId, groupId: groupId)
        identities[groupId] = nil
        details[groupId] = nil
        areasOf[groupId] = nil
        chains[groupId] = nil
        forked.remove(groupId.lowercased())
        acceptedFamilies.remove(groupId.lowercased())
        sweepCopies()
    }

    // MARK: Verdicts

    /*
     * Who may have written what the family's folders hold, as the core's group verdicts take
     * them (the web's groupWriters): every member route 6 serves, each with this person's
     * version 3 pin of them, verified or first-seen, and where it came from, and the personal keys
     * of everyone they checked. A first-seen pin (let in without words) is no check of this
     * person's own: it goes as the family's word (`trustedVia` the family), so keys the member list
     * puts in its place are a key conflict, and what agrees with it reads as the family's word
     * does. Built from the current trust set at every judgement, so a pin saved or checked since
     * is never judged by the one before. This account's own records go by its own keys.
     */
    func groupWriters(_ served: [String: MemberIdentity], signers: TrustedSigners, pins: [String: ContactPin], groupId: String) -> [GroupWriter] {
        let me = userId.lowercased()
        func pinned(_ id: String) -> WriterPin? {
            guard let pin = pins[id.lowercased()], let digest = pin.mlDsaPublicKeyHash else { return nil }
            let trust = pin.trust
            guard trust == .verified || trust == .seen else { return nil }
            return WriterPin(keyVersion: pin.keyVersion, encryptionPublicKey: pin.encryptionPublicKey, signingPublicKey: pin.signingPublicKey,
                             mlDsaPublicKeyHash: digest, trustedVia: trust == .seen ? groupId : pin.trustedVia)
        }
        func personal(_ id: String) -> TrustedKeys? { id.lowercased() == me ? nil : signers.trusted(Signer(id: id)) }
        var out: [String: GroupWriter] = [:]
        for (id, member) in served {
            out[id] = GroupWriter(userId: member.userId, pinned: pinned(id), served: member.identity?.served,
                                  links: member.identity == nil ? nil : member.links.map(\.link), personal: personal(id))
        }
        for id in signers.keys.keys where out[id] == nil && id != me {
            out[id] = GroupWriter(userId: id, pinned: pinned(id), served: nil, links: nil, personal: personal(id))
        }
        return Array(out.values)
    }

    /* Who lines can name: this account, its checked contacts, pins on a family's word, and route 3's members (D10). */
    private func names(_ groupId: String, pins: [String: ContactPin]) -> FamilyNames {
        var checked: [String: String] = [:]
        var vouched: [String: FamilyNames.Vouched] = [:]
        for (id, pin) in pins where pin.verified {
            checked[id] = pin.name.isEmpty ? pin.email : pin.name
            if let via = pin.trustedVia { vouched[id] = .init(name: pin.name, email: pin.email, family: families[via] ?? "a family") }
        }
        var members: [String: FamilyNames.Member] = [:]
        for member in details[groupId]?.members ?? [] { members[member.userId.lowercased()] = .init(name: member.name, email: member.email) }
        return FamilyNames(userId: userId, checked: checked, vouched: vouched, family: families[groupId] ?? "the family", members: members)
    }

    /*
     * Each item's mark and Info lines: its name and current version judged by the family's member
     * list (others' records) and this account's own keys (its own), then said as the web says them
     * (FamilyLines). Without the writers or the reader every record is "Couldn't check", never clean.
     */
    public func verdicts(of nodes: [NodeView], groupId: String) async -> [FamilyVerdict] {
        guard let served = identities[groupId], let signers = try? await vault.signers(), let reader = try? await reader() else {
            return nodes.map { _ in .unchecked }
        }
        let pins = await vault.knownPins()
        let writers = groupWriters(served, signers: signers, pins: pins, groupId: groupId)
        let names = names(groupId, pins: pins)
        let checked = familyChecked(groupId)
        return nodes.map { node in
            var judged = [judge(Self.metadataRecord(of: node), .metadata, groupId: groupId, reader: reader, writers: writers)]
            if !node.isFolder, let current = node.currentVersion {
                judged.append(judge(Self.versionRecord(current, of: node), .version, groupId: groupId, reader: reader, writers: writers))
            }
            if !checked { judged = judged.map { Self.asFirstUse($0, groupId: groupId) } }
            return Self.verdict(judged, names: names, groupId: groupId)
        }
    }

    public func verdict(of node: NodeView, groupId: String) async -> FamilyVerdict {
        await verdicts(of: [node], groupId: groupId)[0]
    }

    // MARK: Writes

    /*
     * The form a family folder record is signed again with when a write carries it over (a
     * rename's name, a copy, a replacement's name): the core's `copy_form` over the committed
     * chain, with this account's records by its own keys and everyone else's by the member list.
     * Verified stays ordinary, saved from a link stays saved, anything else (a former member, keys
     * that don't match, someone nobody checked) is re-sealed; unchecked refuses.
     */
    public func prior(of record: ServedRecord, in workspaceId: String) async throws -> Integrity {
        guard let groupId = groupsOf[workspaceId.lowercased()], let served = identities[groupId] else {
            throw FamilyFailure(message: Provenance.couldNotCheck)
        }
        let signers = try await vault.signers()
        let reader = try await reader()
        let pins = await vault.knownPins()
        return try ledger.copyForm(groupId: groupId, reader: reader, writers: groupWriters(served, signers: signers, pins: pins, groupId: groupId), record: record, cache: nil)
    }

    /* The family of a folder checked again, for an upload waiting out a key change there. */
    public func recheck(_ workspaceId: String) async {
        guard let groupId = groupsOf[workspaceId.lowercased()], let summary = summaries[groupId] else { return }
        // A check still running (another waiting upload's) is the one this waits for; a finished one is not asked again.
        if running[groupId, default: 0] > 0, let tail = tails[groupId] {
            _ = await tail.value
            return
        }
        _ = await sync(summary)
    }

    /*
     * A record as this person may read it in a family taken on first use (the web's asFirstUse,
     * docs/optional-verification.md 2.6): nobody checked the member list, so what it vouches for
     * reads `seen`, as a first-seen contact's work does, never "Verified by" the family. A verdict
     * from this person's own verified pin (no `via`) stays verified.
     */
    static func asFirstUse(_ record: FamilyJudged, groupId: String) -> FamilyJudged {
        func seen(_ verdict: GroupVerdict, _ via: String?) -> GroupVerdict {
            verdict == .verified && via?.lowercased() == groupId.lowercased() ? .seen : verdict
        }
        var note = record.note
        if let held = note { note = RekeyNote(writer: held.writer, by: held.by, integrity: seen(held.integrity, held.via), bound: held.bound, via: held.via) }
        return FamilyJudged(record: record.record, verdict: seen(record.verdict, record.via), via: record.via, signer: record.signer, note: note)
    }

    /* The web's issues, mark and Info lines over the judged records. */
    static func verdict(_ judged: [FamilyJudged], names: FamilyNames, groupId: String) -> FamilyVerdict {
        let issues = FamilyLines.issues(judged)
        let rekeyed = FamilyLines.rekeyed(judged, names)
        return FamilyVerdict(
            mark: FamilyLines.mark(issues, names),
            changedBy: issues.first.map { (FamilyLines.changedByLabel($0), FamilyLines.changedByWords($0, names)) },
            writtenBy: issues.isEmpty ? rekeyed.writtenBy : nil,
            replacedBy: rekeyed.replacedBy,
            verifiedBy: FamilyLines.vouched(judged, issues: issues, groupId: groupId) ? "Verified by \(names.family)" : nil,
            seen: FamilyLines.seenWriter(judged, issues: issues, names: names)
        )
    }

    private func reader() async throws -> RecordReader {
        let all = try await vault.allIdentities()
        guard let current = all.first else { throw FamilyFailure(message: Provenance.couldNotCheck) }
        return RecordReader(userId: userId, keys: TrustedKeys(
            current: try base64urlDecode(value: current.signingPublicKey),
            retired: try all.dropFirst().map { try base64urlDecode(value: $0.signingPublicKey) }
        ))
    }

    private func judge(_ record: ServedRecord, _ kind: FamilyRecordKind, groupId: String, reader: RecordReader, writers: [GroupWriter]) -> FamilyJudged {
        guard let verdict = try? ledger.recordVerdict(groupId: groupId, reader: reader, writers: writers, record: record, cache: nil) else {
            return FamilyJudged(record: kind, verdict: .unchecked, via: nil, signer: record.signer, note: nil)
        }
        switch verdict {
        case .signed(let integrity):
            return FamilyJudged(record: kind, verdict: integrity.verdict, via: integrity.via, signer: record.signer, note: nil)
        case .rekeyed(let rekeyed):
            // A re-keyed record's verdict is its origin's; its own signer is the re-keyer.
            return FamilyJudged(record: kind, verdict: rekeyed.origin.verdict, via: rekeyed.origin.via, signer: record.signer,
                                note: RekeyNote(writer: record.rekey?.origin.signerId, by: record.signer, integrity: rekeyed.rekeyer.verdict, bound: rekeyed.bound,
                                                via: rekeyed.rekeyer.via))
        }
    }

    /* Present but unreadable is a signature that cannot hold, as the web reads it. */
    private static func signature(_ value: String?) -> Data? {
        guard let value else { return nil }
        return (try? base64urlDecode(value: value)) ?? Data()
    }

    private static func rekey(_ view: RekeyView?) -> ServedRekey? {
        guard let view else { return nil }
        return ServedRekey(
            origin: ServedOrigin(envelope: (try? base64urlDecode(value: view.origin.envelope)) ?? Data(), signerId: view.origin.signer?.id,
                                 signature: signature(view.origin.signature), keyEnvelope: (try? base64urlDecode(value: view.origin.keyEnvelope)) ?? Data()),
            signature: signature(view.signature) ?? Data()
        )
    }

    static func metadataRecord(of node: NodeView) -> ServedRecord {
        ServedRecord(
            statement: .metadata(statement: MetadataStatement(workspaceId: node.workspaceId, nodeId: node.id, kind: node.isFolder ? .folder : .file,
                                                              metadataVersion: node.metadataVersion)),
            keyEpoch: node.keyEpoch, envelope: (try? base64urlDecode(value: node.metadataEnvelope)) ?? Data(),
            signer: node.metadataSigner?.id, signature: signature(node.metadataSignature), rekey: rekey(node.metadataRekey)
        )
    }

    static func versionRecord(_ version: VersionView, of node: NodeView) -> ServedRecord {
        ServedRecord(
            statement: .version(statement: VersionStatement(workspaceId: node.workspaceId, nodeId: node.id, versionId: version.id,
                                                            objectId: version.objectId, contentSuite: version.contentSuite)),
            keyEpoch: node.keyEpoch, envelope: (try? base64urlDecode(value: version.contentKeyEnvelope)) ?? Data(),
            signer: version.signer?.id, signature: signature(version.signature), rekey: rekey(version.rekey)
        )
    }

    // MARK: Shapes

    func view(_ groupId: String, chain: AcceptedRosters, areas: [FamilyArea], reset: Bool) -> FamilyView {
        let roster = chain.roster()
        var owners: [String?: Int] = [:]
        for listing in ledger.foreignListings() where listing.groupId.lowercased() == groupId.lowercased() {
            owners[listing.openedBy, default: 0] += 1
        }
        return FamilyView(
            groupId: groupId, rosterVersion: roster.rosterVersion, rosterDigest: chain.rosterDigest(), groupKeyVersion: chain.groupKeyVersion(),
            members: roster.members.filter { $0.status == .active }.map {
                FamilyMember(userId: $0.userId, roles: $0.roles.map(Self.role), commitment: Self.commitment(of: $0))
            },
            areas: areas, recordReset: reset, ownEntryWrong: !chain.ownEntryWrongAt().isEmpty, ownEntryBehind: !chain.ownEntryBehindAt().isEmpty,
            foreign: owners.map { ForeignNotice(owner: $0.key, count: $0.value) }.sorted { ($0.owner ?? "") < ($1.owner ?? "") }
        )
    }

    /* The key commitment of an entry's four keys (the web's entryCommitment): nil for digests that don't decode. */
    static func commitment(of entry: RosterMember) -> String? {
        guard let mlDsa = try? digestHex(base64url: entry.mlDsaPublicKeyDigest), let kem = try? digestHex(base64url: entry.kemPublicKeyDigest) else { return nil }
        return keyCommitment(pin: PinKeys(keyVersion: entry.keyVersion, encryptionPublicKey: entry.encryptionPublicKey, signingPublicKey: entry.signingPublicKey,
                                          mlDsaPublicKeyHash: mlDsa, kemPublicKeyHash: kem, fingerprint: ""))
    }

    /* The web's names for roles (rolesLine reads `billing` and `members`). */
    static func role(_ role: GroupRole) -> String {
        switch role {
        case .billing: "billing"
        case .dataAdmin: "data-admin"
        case .guardian: "guardian"
        case .members: "members"
        case .recovery: "recovery"
        }
    }

    static func fork(of: ForkOf, version: UInt64, sides: [MarkSide]) -> FamilyFork {
        FamilyFork(memberList: of == .roster, version: version, sides: sides.map { side in
            FamilyFork.Side(digest: side.digest, from: side.from.map { source in
                switch source {
                case .pin: "your account’s earlier check"
                case .pair: "the family check you made"
                case .cache: "this device’s earlier check"
                case .join: "the join code you compared"
                case .served: "what the server shows now"
                }
            })
        })
    }

    /*
     * The core lets go of a family (docs/optional-verification.md 2.8), store before delete: it
     * drops nothing while the guard this phone holds does not cover the highest chain the session
     * accepted, and hands that guard back instead; it is stored here (merged, never lower, under the
     * guard's lock) and the core asked again with what is stored then. Nothing of the family is
     * deleted unless this says the core forgot it. A guard that can't be stored throws (the wipe
     * waits, and the family says it couldn't save on this phone); one that couldn't be read over a
     * floor throws too. A held guard that disagrees with the core's floor (GUARD_CONFLICT) or is past
     * it (GUARD_AHEAD) is the core's refusal, thrown: nothing of the family goes. False when an
     * acceptance landed in between every time: the wipe waits for the next answer.
     */
    func forgetInCore(_ groupId: String) async throws -> Bool {
        let at = Self.checkTime(now())
        for _ in 0 ..< 4 {
            let answer = try ledger.forgetGroup(groupId: groupId, guard: await vault.heldFamilyGuard(groupId), checkedAt: at)
            guard let pin = answer.guard else {
                // Let go of in the core: nothing is written under its chains any more, so no guard is owed.
                await vault.familyGuardKept(groupId)
                return true
            }
            if answer.unreadable { throw GuardError.unreadable }
            try await vault.keepFamilyGuard(groupId, pin)
        }
        familyLog.notice("A family wipe waits: an acceptance landed while it ran.")
        return false
    }

    /* A check time as pins carry it: ISO 8601 UTC to the millisecond, as the web's toISOString. */
    static func checkTime(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: date)
    }
}
