import Foundation
#if canImport(FileProvider)
import FileProvider
#endif

/*
 * A family's location in the Files app (docs/groups-mobile-plan.md, iOS 6): one File Provider
 * domain per family, `com.hushos.app.family.<groupId>`, named after the family, read only. Its
 * top level is the family's folders; below them, each folder as the family page lists it.
 *
 * A location stands only while its record does (`FamilyDomainRecords`, beside the drive's owner
 * record): the account it was added for and the family's name. The app adds the record and then
 * the location when a sync of its session accepts the family. Any process that lets the family go
 * (a removal, a fork, a refusal, a family still waiting or unchecked, found by the app, the
 * background pass or the Files extension's own sync) deletes the record at once, on disk, and then
 * asks for the location to go with `.removeAll`. The extension checks the record on every call,
 * before anything it holds, so a revocation anywhere wins over a family this process accepted
 * earlier, and no answer from the server ever brings one back.
 */
public enum FamilyFileIds {
    public static let prefix = "com.hushos.app.family."

    public static func domain(_ groupId: String) -> String { prefix + groupId.lowercased() }

    /* The family a location is for; nil for any other location, or an id that isn't one. */
    public static func group(ofDomain identifier: String) -> String? {
        guard identifier.hasPrefix(prefix) else { return nil }
        let groupId = String(identifier.dropFirst(prefix.count))
        return FamilyRecords.valid(groupId) ? groupId : nil
    }

    /* An item of a family's location: its workspace and node, so nothing is ever looked up by id alone. */
    public static func item(_ ref: NodeRef) -> String { "\(ref.workspaceId):\(ref.nodeId)" }

    public static func ref(_ item: String) -> NodeRef? {
        let parts = item.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 2, FamilyRecords.valid(parts[0]), FamilyRecords.valid(parts[1]) else { return nil }
        return NodeRef(workspaceId: parts[0], nodeId: parts[1])
    }
}

/* Whose a family's location is, and its name. */
public struct FamilyDomainRecord: Codable, Sendable, Equatable {
    public let owner: AccountOwner
    public let name: String

    public init(owner: AccountOwner, name: String) {
        self.owner = owner
        self.name = name
    }
}

/* What a family location's record says about the account signed in now. */
public enum FamilyAdmission: Equatable, Sendable {
    case admitted
    /* No record: the family was let go of (or never added). */
    case letGo
    /* Another account's location, or nobody signed in. */
    case otherAccount
    /* The records couldn't be read: nothing is decided, never taken as none. */
    case unreadable
}

/*
 * Every family location's record, in `local/files-family-domains.json` (app group, out of
 * backups), written under `local/files-family-domains.lock` by the app and any extension.
 */
public struct FamilyDomainRecords: Sendable {
    let folder: URL
    let activity: FileLock.Activity

    public init(folder: URL) { self.init(folder: folder, activity: .system) }

    init(folder: URL, activity: FileLock.Activity) {
        self.folder = folder
        self.activity = activity
    }

    public static var shared: FamilyDomainRecords { FamilyDomainRecords(folder: Unbacked.local) }

    var file: URL { folder.appendingPathComponent("files-family-domains.json") }
    private var lockPath: String { folder.appendingPathComponent("files-family-domains.lock").path }

    /* Every record by family; empty when none was ever kept. A file that can't be read throws, never read as none. */
    public func read() throws -> [String: FamilyDomainRecord] {
        let data: Data
        do {
            data = try Data(contentsOf: file)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile {
            return [:]
        } catch {
            throw GuardError.unreadable
        }
        guard let records = try? JSONDecoder().decode([String: FamilyDomainRecord].self, from: data) else { throw GuardError.unreadable }
        return records
    }

    /* `body` over the records under their lock, written back when it changed them; false when that couldn't be done. */
    @discardableResult
    func update(_ body: (inout [String: FamilyDomainRecord]) -> Void) -> Bool {
        var done = false
        let locked = (try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)) != nil && FileLock.withLock(lockPath, activity: activity) {
            guard var records = try? read() else { return }
            let before = records
            body(&records)
            if records == before {
                done = true
                return
            }
            guard let data = try? JSONEncoder().encode(records) else { return }
            done = (try? data.write(to: file, options: .atomic)) != nil
        }
        return locked && done
    }

    /* Whether `owner` may be answered for in the family's location. */
    public func admission(_ groupId: String, owner: AccountOwner?) -> FamilyAdmission {
        guard let records = try? read() else { return .unreadable }
        return Self.admission(groupId, records: records, owner: owner)
    }

    public static func admission(_ groupId: String, records: [String: FamilyDomainRecord], owner: AccountOwner?) -> FamilyAdmission {
        guard let owner else { return .otherAccount }
        guard let record = records[groupId.lowercased()] else { return .letGo }
        return record.owner == owner ? .admitted : .otherAccount
    }
}

/* The system's family locations, as `FamilyFilesDomains` drives them (a test's own in tests). */
public protocol FamilyDomainManaging: Sendable {
    /* The family locations there are, by identifier. */
    func domains() async throws -> [String]
    func add(_ identifier: String, name: String) async throws
    /* Removed with everything Files kept in it (`.removeAll`). */
    func remove(_ identifier: String) async throws
    /* Files is told something changed in it. */
    func signal(_ identifier: String) async
}

/*
 * The family locations' lifecycle in one process, its system calls one after another. A family
 * accepted at a look (`revision`, FamilySync.revise) is added only when no let-go at a later look
 * came first, so an older acceptance that lands after a removal never brings the location back.
 */
public final class FamilyFilesDomains: @unchecked Sendable {
    #if canImport(FileProvider)
    public static let shared = FamilyFilesDomains(records: .shared, manager: SystemFamilyDomains())
    #endif

    let records: FamilyDomainRecords
    let manager: any FamilyDomainManaging
    private let lock = NSLock()
    /* The latest look at which each family was let go of in this process (lowercase id). */
    private var letGoAt: [String: UInt64] = [:]
    private var tail: Task<Void, Never>?

    public init(records: FamilyDomainRecords, manager: any FamilyDomainManaging) {
        self.records = records
        self.manager = manager
    }

    @discardableResult
    private func enqueue(_ work: @escaping @Sendable () async -> Void) -> Task<Void, Never> {
        lock.withLock {
            let previous = tail
            let next = Task {
                await previous?.value
                await work()
            }
            tail = next
            return next
        }
    }

    /*
     * A sync of `session` accepted the family at `revision`: its record, then its location. Never
     * over another account's record (that location goes at the next `reconcile`), never once the
     * session ended, and never when the family was let go of at a later look.
     */
    @discardableResult
    public func accepted(_ groupId: String, name: String, owner: AccountOwner, revision: UInt64, session: CopySession) -> Task<Void, Never> {
        let groupId = groupId.lowercased()
        return enqueue { [self] in
            guard FamilyRecords.valid(groupId), session.stands else { return }
            let kept = lock.withLock { () -> Bool in
                guard letGoAt[groupId, default: 0] < revision else { return false }
                var ours = false
                let wrote = records.update { held in
                    if let record = held[groupId], record.owner != owner { return }
                    held[groupId] = FamilyDomainRecord(owner: owner, name: name)
                    ours = true
                }
                return wrote && ours
            }
            guard kept, session.stands else { return }
            let identifier = FamilyFileIds.domain(groupId)
            guard let existing = try? await manager.domains() else { return }
            if !existing.contains(identifier) { try? await manager.add(identifier, name: name) }
            await manager.signal(identifier)
        }
    }

    /*
     * The family was let go of at `revision` (by whatever process found it): its record goes now,
     * on disk, so every extension call refuses from here on, then its location with what Files
     * kept of it. Only `owner`'s record (nil: whoever's).
     */
    @discardableResult
    public func letGo(_ groupId: String, owner: AccountOwner?, revision: UInt64) -> Task<Void, Never> {
        let groupId = groupId.lowercased()
        lock.withLock {
            letGoAt[groupId] = max(letGoAt[groupId, default: 0], revision)
            records.update { held in
                if let record = held[groupId], owner == nil || record.owner == owner { held[groupId] = nil }
            }
        }
        return enqueue { [manager] in try? await manager.remove(FamilyFileIds.domain(groupId)) }
    }

    /*
     * Signed in (or found signed in) as `owner`: a family location without a record of this account
     * goes (another account's, or one whose record a revocation took), and another account's records
     * go once their locations have. Families are added only by an acceptance.
     */
    @discardableResult
    public func reconcile(owner: AccountOwner) -> Task<Void, Never> {
        enqueue { [self] in
            guard let identifiers = try? await manager.domains(), let held = try? records.read() else { return }
            var present = Set(identifiers)
            for identifier in identifiers {
                let groupId = FamilyFileIds.group(ofDomain: identifier)
                if let groupId, held[groupId]?.owner == owner { continue }
                if (try? await manager.remove(identifier)) != nil { present.remove(identifier) }
            }
            records.update { held in
                held = held.filter { $0.value.owner == owner || present.contains(FamilyFileIds.domain($0.key)) }
            }
        }
    }

    /*
     * Sign-out, deletion, another account in: every family location goes, each record only once
     * its location went (one that stays is refused to anyone else). Unknown locations: nothing.
     */
    public func removeAll() async {
        await enqueue { [self] in
            guard let identifiers = try? await manager.domains() else { return }
            var present = Set(identifiers)
            for identifier in identifiers where (try? await manager.remove(identifier)) != nil { present.remove(identifier) }
            records.update { held in held = held.filter { present.contains(FamilyFileIds.domain($0.key)) } }
            lock.withLock { letGoAt = [:] }
        }.value
    }

    /* Files is told a family's location changed (the app saw its folders change). */
    public func signal(_ groupId: String) {
        enqueue { [manager] in await manager.signal(FamilyFileIds.domain(groupId)) }
    }

    /* Tests: every system call asked for so far, done. */
    func settled() async { await enqueue {}.value }
}

#if canImport(FileProvider)
/* The system's family locations. A new one on iOS starts disabled until the person turns it on in Files, as the drive's. */
struct SystemFamilyDomains: FamilyDomainManaging {
    func domains() async throws -> [String] {
        try await NSFileProviderManager.domains().map(\.identifier.rawValue).filter { $0.hasPrefix(FamilyFileIds.prefix) }
    }

    func add(_ identifier: String, name: String) async throws {
        let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier(identifier), displayName: name)
        #if DEBUG && targetEnvironment(simulator)
        domain.testingModes = .alwaysEnabled
        #endif
        try await NSFileProviderManager.add(domain)
    }

    func remove(_ identifier: String) async throws {
        _ = try await NSFileProviderManager.remove(NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier(identifier), displayName: ""), mode: .removeAll)
    }

    func signal(_ identifier: String) async {
        guard let manager = NSFileProviderManager(for: NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier(identifier), displayName: "")) else { return }
        manager.signalEnumerator(for: .workingSet) { _ in }
        manager.signalEnumerator(for: .rootContainer) { _ in }
    }
}
#endif

/* Why a family location refused a call. */
public enum FamilyFilesError: Error, Equatable, Sendable {
    /* The family was let go of here or elsewhere: the location is going. */
    case letGo
    /* Another account's location, or nobody signed in. */
    case otherAccount
    /* Not one of the family's folders (another workspace's item, an id that isn't one). */
    case notInFamily
    /* The family couldn't be checked and nothing was accepted before: Files asks again. */
    case unavailable
}

/* Where the location's change feed stands: each folder's top node and its feed cursor. */
public struct FamilyAnchor: Codable, Sendable, Equatable {
    public struct Folder: Codable, Sendable, Equatable {
        public let root: String
        public let cursor: Int
    }

    public var folders: [String: Folder]

    public init(folders: [String: Folder] = [:]) { self.folders = folders }
}

/* What changed in the location since an anchor. */
public struct FamilyChanges: Sendable {
    /* Folders that are new at the top level. */
    public let added: [FamilyArea]
    public let updated: [Opened]
    /* Item ids (FamilyFileIds.item) that are gone. */
    public let deleted: [String]
    public let next: FamilyAnchor
    public let hasMore: Bool
}

/*
 * The Files extension's view of one family, in one process, for one session: every call is
 * admitted by the location's record first, then by the family as this process last accepted it
 * (checked again once a minute). No answer keeps what was accepted, read only; anything else
 * that lets the family go lets it go here too. Only the family's own folders are ever answered
 * for: an item of any other workspace is refused before anything is asked.
 */
public actor FamilyFilesSource {
    public let groupId: String
    public let vault: Vault
    let sync: FamilySync
    let records: FamilyDomainRecords
    let owner: AccountOwner
    let now: @Sendable () -> Date
    private var view: FamilyView?
    private var checkedAt: Date?

    static let fresh: TimeInterval = 60

    public init(groupId: String, vault: Vault, sync: FamilySync, records: FamilyDomainRecords = .shared, now: @escaping @Sendable () -> Date = { Date() }) {
        self.groupId = groupId.lowercased()
        self.vault = vault
        self.sync = sync
        self.records = records
        owner = AccountOwner(vault.session)
        self.now = now
    }

    /* The record's say, before anything this process holds: a revocation on disk wins. */
    private func admit() throws {
        switch records.admission(groupId, owner: owner) {
        case .admitted: return
        case .letGo:
            view = nil
            throw FamilyFilesError.letGo
        case .otherAccount:
            view = nil
            throw FamilyFilesError.otherAccount
        case .unreadable:
            throw GuardError.unreadable
        }
    }

    /* The family as accepted here, checked again when due. */
    public func admitted() async throws -> FamilyView {
        try admit()
        if let view, let checkedAt, now().timeIntervalSince(checkedAt) < Self.fresh { return view }
        return try await check()
    }

    private func check() async throws -> FamilyView {
        let listed: [GroupSummary]
        do {
            let found = try await sync.listReconciling()
            if found.removed.contains(where: { $0.lowercased() == groupId }) {
                view = nil
                throw FamilyFilesError.letGo
            }
            listed = found.listed
        } catch let error as FamilyFilesError {
            throw error
        } catch {
            // No answer: what this process accepted stands, read only (the record was checked first).
            if let view { return view }
            throw error
        }
        // Not listed, but not confirmed gone either: kept as it was until the server says not-member.
        guard let summary = listed.first(where: { $0.id.lowercased() == groupId }) else {
            if let view { return view }
            throw FamilyFilesError.unavailable
        }
        switch await sync.sync(summary) {
        case .accepted(let accepted):
            // A revocation that landed while the family was checked wins over it.
            try admit()
            view = accepted
            checkedAt = now()
            return accepted
        case .failed(let words) where words == FamilyWords.noAnswer:
            if let view { return view }
            throw FamilyFailure(message: words)
        default:
            // The sync let it go (its release took the record and asked for the location to go).
            view = nil
            throw FamilyFilesError.letGo
        }
    }

    /* The family's folders that open here, as the location's top level. */
    public func folders() async throws -> [FamilyArea] {
        try await admitted().areas.filter(\.openable).sorted { ($0.name ?? "").localizedStandardCompare($1.name ?? "") == .orderedAscending }
    }

    private func area(_ ref: NodeRef, in view: FamilyView) throws -> FamilyArea {
        guard let area = view.areas.first(where: { $0.workspaceId.lowercased() == ref.workspaceId && $0.openable }) else {
            throw FamilyFilesError.notInFamily
        }
        return area
    }

    /* Whether `ref` is a top folder of the family (its parent in Files is the location itself). */
    public func isFolderRoot(_ ref: NodeRef) async throws -> Bool {
        let view = try await admitted()
        return try area(ref, in: view).root?.id.lowercased() == ref.nodeId
    }

    /* A folder's children, in one of the family's folders. */
    public func children(of folder: NodeRef) async throws -> [Opened] {
        let view = try await admitted()
        _ = try area(folder, in: view)
        let listing = try await vault.listChildren(of: folder.nodeId, in: folder.workspaceId)
        try admit()
        var out: [Opened] = []
        for child in listing.children where child.ref.workspaceId == folder.workspaceId {
            if let opened = await vault.item(child.ref) { out.append(opened) }
        }
        return out
    }

    /* An item of the family's folders: as held here, or opened by listing the folder it was last seen in. */
    public func item(_ ref: NodeRef) async throws -> Opened {
        let view = try await admitted()
        let area = try area(ref, in: view)
        if let held = await vault.item(ref) { return held }
        if let root = area.root, root.id.lowercased() == ref.nodeId {
            _ = try await vault.listChildren(of: root.id, in: ref.workspaceId)
        } else if let parent = await vault.knownParent(ref.nodeId) {
            _ = try await vault.listChildren(of: parent, in: ref.workspaceId)
        } else {
            throw FamilyFailure(message: FamilyWords.openAgain)
        }
        try admit()
        guard let opened = await vault.item(ref) else { throw DriveAPIError.notFound("This item no longer exists.") }
        return opened
    }

    /*
     * A file's current version, decrypted to `file` under the family's copy gate (made by the caller
     * in the extension's temporary folder). Handed on only while the location's record still stands:
     * a revocation that landed during the download leaves nothing behind.
     */
    public func download(_ ref: NodeRef, to file: URL, progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> Opened {
        let item = try await item(ref)
        let gate = vault.copyGate(familyWorkspace: ref.workspaceId)
        try gate.perform { try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true) }
        try await vault.download(ref.nodeId, ref: ref, expectedVersionId: item.node.currentVersion?.id, to: file, gate: gate, progress: progress)
        do {
            try admit()
            try gate.check()
        } catch {
            try? FileManager.default.removeItem(at: file)
            throw error
        }
        return await vault.item(ref) ?? item
    }

    public func thumbnail(_ ref: NodeRef) async throws -> Data? {
        let item = try await item(ref)
        let data = try await vault.thumbnail(of: item)
        try admit()
        return data
    }

    /* Where each folder's feed stands now (route 25's change sequences), for a new anchor. */
    public func anchor() async throws -> FamilyAnchor {
        let folders = try await self.folders()
        let heads = try await heads()
        var anchor = FamilyAnchor()
        for area in folders {
            guard let root = area.root else { continue }
            anchor.folders[area.workspaceId.lowercased()] = .init(root: root.id.lowercased(), cursor: heads[area.workspaceId.lowercased()] ?? 0)
        }
        return anchor
    }

    private func heads() async throws -> [String: Int] {
        var out: [String: Int] = [:]
        for entry in try await sync.api.spaces() where entry.space.groupId?.lowercased() == groupId {
            for area in entry.areas { out[area.workspaceId.lowercased()] = area.changeSeq ?? 0 }
        }
        return out
    }

    /*
     * Everything that changed since `anchor`: folders added at the top level and folders gone (their
     * top nodes deleted), then each folder's own feed. Nil when a feed asks to start over.
     */
    public func changes(since anchor: FamilyAnchor) async throws -> FamilyChanges? {
        let folders = try await self.folders()
        var next = FamilyAnchor()
        var added: [FamilyArea] = []
        var updated: [Opened] = []
        var deleted: [String] = []
        var more = false
        let open = Set(folders.map { $0.workspaceId.lowercased() })
        for (workspace, folder) in anchor.folders where !open.contains(workspace) {
            deleted.append(FamilyFileIds.item(NodeRef(workspaceId: workspace, nodeId: folder.root)))
        }
        var heads: [String: Int]?
        for area in folders {
            guard let root = area.root else { continue }
            let workspace = area.workspaceId.lowercased()
            guard let held = anchor.folders[workspace], held.root == root.id.lowercased() else {
                if heads == nil { heads = try await self.heads() }
                if let held = anchor.folders[workspace] { deleted.append(FamilyFileIds.item(NodeRef(workspaceId: workspace, nodeId: held.root))) }
                added.append(area)
                next.folders[workspace] = .init(root: root.id.lowercased(), cursor: heads?[workspace] ?? 0)
                continue
            }
            guard let feed = try await vault.familyChanges(in: workspace, since: held.cursor) else { return nil }
            updated += feed.updated
            deleted += feed.deleted.map { FamilyFileIds.item(NodeRef(workspaceId: workspace, nodeId: $0)) }
            more = more || feed.hasMore
            next.folders[workspace] = .init(root: held.root, cursor: feed.nextCursor)
        }
        try admit()
        return FamilyChanges(added: added, updated: updated, deleted: deleted, next: next, hasMore: more)
    }
}
