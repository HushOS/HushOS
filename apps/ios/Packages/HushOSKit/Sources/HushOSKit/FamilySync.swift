import Foundation
import HushOSCore

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

    public var provenance: Provenance? { mark.map { .family($0) } }

    public static func == (a: FamilyVerdict, b: FamilyVerdict) -> Bool {
        a.mark == b.mark && a.changedBy?.label == b.changedBy?.label && a.changedBy?.words == b.changedBy?.words
            && a.writtenBy == b.writtenBy && a.replacedBy == b.replacedBy && a.verifiedBy == b.verifiedBy
    }

    /* Everything unchecked: whom to judge by didn't load. */
    static let unchecked = FamilyVerdict(
        mark: FamilyMark(label: "Couldn’t check", lines: [FamilyLines.couldntCheck], danger: false, retry: true, check: nil),
        changedBy: ("Changed by", "Not checked"), writtenBy: nil, replacedBy: [], verifiedBy: nil
    )
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
    /* Families whose kept join escalation went into this sync's ledger (FamilyJoin): once per ledger, before anything is shown. */
    var restoredHolds: Set<String> = []

    public init(vault: Vault, api: GroupsAPI? = nil, records: FamilyRecords = .shared, now: @escaping @Sendable () -> Date = { Date() }) {
        self.vault = vault
        self.api = api ?? GroupsAPI(drive: vault.api)
        self.records = records
        self.now = now
    }

    /* One per session in this process: the app's screens and any background task share it. */
    private static let registry = Registry()
    public static func shared(for vault: Vault) -> FamilySync { registry.sync(for: vault) }

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
        func sync(for vault: Vault) -> FamilySync {
            lock.withLock {
                if let current, self.vault === vault { return current }
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
        if areasOf[groupId] != nil, ledger.isArea(workspaceId: areasOf[groupId]?.first ?? "") { return }
        let summary: GroupSummary
        if let known = summaries[groupId] { summary = known } else {
            let listed: [GroupSummary]
            do { listed = try await list() } catch where Self.unanswered(error) {
                // No answer is the network's: the queue waits for one, it doesn't fail the upload.
                throw DriveAPIError.transport(error.localizedDescription)
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
        await vault.noteFamilyWorkspaces(areas)
    }

    /* One family synced, after any sync of it already running. */
    public func sync(_ summary: GroupSummary) async -> FamilyState {
        families[summary.id] = summary.name
        summaries[summary.id] = summary
        // The vault asks this sync how family records are signed again (FamilyJudge).
        await vault.useFamilyJudge(self)
        running[summary.id, default: 0] += 1
        defer { running[summary.id, default: 1] -= 1 }
        return await exclusive(summary.id) { await self.run(summary) }
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
            await vault.forgetWorkspaces(knownAreas(groupId))
            return .waiting
        }
        do {
            try await vault.prepareLedger()
            var reset = false
            for _ in 0 ..< 2 {
                switch try await accept(groupId) {
                case .unchecked:
                    await vault.forgetWorkspaces(knownAreas(groupId))
                    return .unchecked
                case .fork(let fork):
                    await vault.forgetWorkspaces(knownAreas(groupId))
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
            await wipe(groupId)
            return .wiped
        } catch {
            // Refused (a rollback, a race that kept losing, keys that didn't check): the ledger kept nothing of this run, and
            // nothing of the family stays open here. No answer at all leaves what was opened before as it was.
            if !Self.unanswered(error) { await vault.forgetWorkspaces(knownAreas(groupId)) }
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
        switch try await settle(groupId, pin: pin, opened: areas.compactMap(\.pinArea)) {
        case .fork(let fork):
            await vault.forgetWorkspaces(knownAreas(groupId))
            return .fork(fork)
        case .settled(let latest):
            if let detail = try? await api.group(groupId) { details[groupId] = detail }
            return .accepted(view(groupId, chain: latest ?? chain, areas: areas.map(\.area), reset: reset))
        }
    }

    /* The family folders this process or the device record knows of. */
    func knownAreas(_ groupId: String) -> [String] {
        let known = groupsOf.filter { $0.value == groupId }.map(\.key)
        return Array(Set(known + (areasOf[groupId] ?? []) + (records.read(userId: userId, groupId: groupId)?.areas ?? [])))
    }

    /* A request that got no answer, the settings route's included: nothing was refused, so nothing is taken away. */
    static func unanswered(_ error: Error) -> Bool {
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
     * older member list. The record is written only from a committed acceptance, before anything
     * else, and never over one at a later roster version.
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
            var answer = try ledger.acceptServed(me: me, groupId: groupId, record: row?.envelope, served: served, checkedAt: checkedAt)
            if case .fetchFromVersionOne = answer {
                served = try await fetchServed(groupId, after: 0)
                answer = try ledger.acceptServed(me: me, groupId: groupId, record: row?.envelope, served: served, checkedAt: checkedAt)
            }
            switch answer {
            case .accepted(let chain, let record, let pin):
                let areas = Array(chain.areaKeys().keys).sorted()
                try records.put(userId: userId, groupId: groupId, FamilyRecords.Row(envelope: record, rosterVersion: chain.roster().rosterVersion, areas: areas))
                return .accepted(chain, pin)
            case .fork(let of, let version, let sides):
                return .fork(Self.fork(of: of, version: version, sides: sides))
            case .recordUnreadable:
                records.delete(userId: userId, groupId: groupId)
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
        areasOf[groupId] = family.map(\.workspaceId)
        await note(family.map(\.workspaceId), of: groupId)
        let served = try await fetchIdentities(groupId)
        identities[groupId] = served
        let keyVersion = try await vault.accountKeyVersion()
        var out: [OpenedFolder] = []
        for area in family {
            var folder = OpenedFolder(area: FamilyArea(workspaceId: area.workspaceId, root: area.root, rotating: area.rotation != nil))
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
                    let item = try await vault.openListed(root)
                    folder.area.name = item.name
                    folder.area.rootListed = root.parentKeyEpoch == areaWriteVersion(chain: chain, workspaceId: area.workspaceId)
                }
                folder.area.write = Self.write(reason: opened.opened.reason, rootListed: folder.area.rootListed, root: area.root != nil)
            } catch let error as GroupsAPIError where error.isNotMember {
                throw error
            } catch where Self.unanswered(error) {
                // No answer (the identity history): nothing was refused, so the sync leaves things as they were.
                throw error
            } catch {
                // The row says "Couldn't check this folder's keys", as the web's does; nothing of it opens.
                folder.area.name = nil
                folder.area.write = .readOnly
            }
            out.append(folder)
        }
        return out
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
    func settle(_ groupId: String, pin accepted: GroupPin, opened: [OpenedArea]) async throws -> Settled {
        var pin = accepted
        var latest: AcceptedRosters?
        for _ in 0 ..< 4 {
            let current = try await vault.familyPin(groupId)
            if case .merged(let merged) = try mergePin(groupId: groupId, current: current, next: pin, opened: opened) {
                if !pinAhead(current: current, next: merged) { return .settled(latest) }
                if try await vault.saveGroupPin(groupId, over: current, merged) { return .settled(latest) }
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
     * folders opened here go. **The settings pin stays**: if the family comes back (a server
     * that said not-member to erase a warning), it is still a mark.
     */
    func wipe(_ groupId: String) async {
        let areas = knownAreas(groupId)
        ledger.forgetGroup(groupId: groupId)
        records.delete(userId: userId, groupId: groupId)
        await vault.forgetWorkspaces(areas)
        identities[groupId] = nil
        details[groupId] = nil
        areasOf[groupId] = nil
    }

    // MARK: Verdicts

    /*
     * Who may have written what the family's folders hold, as the core's group verdicts take
     * them (the web's groupWriters): every member route 6 serves, each with this person's
     * version 3 pin of them (and where it came from), and the personal keys of everyone they
     * checked. Built from the current trust set at every judgement, so a pin saved or checked
     * since is never judged by the one before. This account's own records go by its own keys.
     */
    func groupWriters(_ served: [String: MemberIdentity], signers: TrustedSigners, pins: [String: ContactPin]) -> [GroupWriter] {
        let me = userId.lowercased()
        func pinned(_ id: String) -> WriterPin? {
            guard let pin = pins[id.lowercased()], pin.verified, let digest = pin.mlDsaPublicKeyHash else { return nil }
            return WriterPin(keyVersion: pin.keyVersion, encryptionPublicKey: pin.encryptionPublicKey, signingPublicKey: pin.signingPublicKey,
                             mlDsaPublicKeyHash: digest, trustedVia: pin.trustedVia)
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
        let writers = groupWriters(served, signers: signers, pins: pins)
        let names = names(groupId, pins: pins)
        return nodes.map { node in
            var judged = [judge(Self.metadataRecord(of: node), .metadata, groupId: groupId, reader: reader, writers: writers)]
            if !node.isFolder, let current = node.currentVersion {
                judged.append(judge(Self.versionRecord(current, of: node), .version, groupId: groupId, reader: reader, writers: writers))
            }
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
        return try ledger.copyForm(groupId: groupId, reader: reader, writers: groupWriters(served, signers: signers, pins: pins), record: record, cache: nil)
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

    /* The web's issues, mark and Info lines over the judged records. */
    static func verdict(_ judged: [FamilyJudged], names: FamilyNames, groupId: String) -> FamilyVerdict {
        let issues = FamilyLines.issues(judged)
        let rekeyed = FamilyLines.rekeyed(judged, names)
        return FamilyVerdict(
            mark: FamilyLines.mark(issues, names),
            changedBy: issues.first.map { (FamilyLines.changedByLabel($0), FamilyLines.changedByWords($0, names)) },
            writtenBy: issues.isEmpty ? rekeyed.writtenBy : nil,
            replacedBy: rekeyed.replacedBy,
            verifiedBy: FamilyLines.vouched(judged, issues: issues, groupId: groupId) ? "Verified by \(names.family)" : nil
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
                                note: RekeyNote(writer: record.rekey?.origin.signerId, by: record.signer, integrity: rekeyed.rekeyer.verdict, bound: rekeyed.bound))
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
            members: roster.members.filter { $0.status == .active }.map { FamilyMember(userId: $0.userId, roles: $0.roles.map(Self.role)) },
            areas: areas, recordReset: reset, ownEntryWrong: !chain.ownEntryWrongAt().isEmpty, ownEntryBehind: !chain.ownEntryBehindAt().isEmpty,
            foreign: owners.map { ForeignNotice(owner: $0.key, count: $0.value) }.sorted { ($0.owner ?? "") < ($1.owner ?? "") }
        )
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
                case .cache: "this device’s earlier check"
                case .join: "the join code you compared"
                case .served: "what the server shows now"
                }
            })
        })
    }

    /* A check time as pins carry it: ISO 8601 UTC to the millisecond, as the web's toISOString. */
    static func checkTime(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: date)
    }
}
