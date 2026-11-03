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

/* Whose a family's location is, its name, and the family's folders it was added with (whose copies a sweep keeps). */
public struct FamilyDomainRecord: Codable, Sendable, Equatable {
    public let owner: AccountOwner
    public let name: String
    public var workspaces: [String]?
    /*
     * The family's revocation generation when the record was written: a let-go that moved it to this
     * or below came before the record (nil: a record from before generations were kept).
     */
    public var generation: UInt64?

    public init(owner: AccountOwner, name: String, workspaces: [String]? = nil, generation: UInt64? = nil) {
        self.owner = owner
        self.name = name
        self.workspaces = workspaces
        self.generation = generation
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
 * Every family location's record, and each family's revocation generation (moved by every let-go
 * in any process, never lowered), in `local/files-family-domains.json` (app group, out of backups),
 * written under `local/files-family-domains.lock` by the app and any extension.
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
    var lockPath: String { folder.appendingPathComponent("files-family-domains.lock").path }

    /* The file's contents: the records, and how many times each family was let go of. */
    struct Stored: Codable, Equatable {
        var records: [String: FamilyDomainRecord] = [:]
        var revoked: [String: UInt64] = [:]
    }

    /* Both maps; empty when nothing was ever kept. A file that can't be read throws, never read as none. */
    func stored() throws -> Stored {
        let data: Data
        do {
            data = try Data(contentsOf: file)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile {
            return Stored()
        } catch {
            throw GuardError.unreadable
        }
        if let stored = try? JSONDecoder().decode(Stored.self, from: data) { return stored }
        // This branch's first shape: the records alone.
        if let records = try? JSONDecoder().decode([String: FamilyDomainRecord].self, from: data) { return Stored(records: records) }
        throw GuardError.unreadable
    }

    /* Every record by family. */
    public func read() throws -> [String: FamilyDomainRecord] { try stored().records }

    /* The family's revocation generation now; nil when the store can't be read. */
    public func generation(_ groupId: String) -> UInt64? { (try? stored())?.revoked[groupId.lowercased(), default: 0] }

    /* `body` over what is stored, under the lock, written back when it changed; false when that couldn't be done. */
    @discardableResult
    func update(_ body: (inout Stored) -> Void) -> Bool {
        var done = false
        let locked = (try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)) != nil && FileLock.withLock(lockPath, activity: activity) {
            guard var stored = try? stored() else { return }
            let before = stored
            body(&stored)
            if stored == before {
                done = true
                return
            }
            guard let data = try? JSONEncoder().encode(stored) else { return }
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
        // No record is a let-go whoever asks, nobody signed in included: Files drops the location's items, never asks to sign in for it.
        guard let record = records[groupId.lowercased()] else { return .letGo }
        guard let owner else { return .otherAccount }
        return record.owner == owner ? .admitted : .otherAccount
    }

    /* Every family folder a record names: whose copies may stay in a process's temporary folder. */
    public func recordedWorkspaces() -> Set<String>? {
        guard let records = try? read() else { return nil }
        return Set(records.values.flatMap { $0.workspaces ?? [] }.map { $0.lowercased() })
    }
}

/* The system's family locations, as `FamilyFilesDomains` drives them (a test's own in tests). */
public protocol FamilyDomainManaging: Sendable {
    /* The family locations there are: each one's display name, by identifier. */
    func domains() async throws -> [String: String]
    func add(_ identifier: String, name: String) async throws
    /* Removed with everything Files kept in it (`.removeAll`). */
    func remove(_ identifier: String) async throws
    /* Files is told something changed in it. */
    func signal(_ identifier: String) async
    /* Someone signed in: a location Files paused on `.notAuthenticated` is told it is resolved, then listed again. */
    func resolved(_ identifier: String) async
}

/*
 * The family locations' lifecycle in one process, its system calls one after another. Ordering
 * across processes is the store's: every let-go moves the family's revocation generation under the
 * store's lock, and an acceptance carries the generation it saw before its check began, so one
 * that began before a revocation (in this process or another) never writes the record back.
 */
public final class FamilyFilesDomains: @unchecked Sendable {
    #if canImport(FileProvider)
    public static let shared = FamilyFilesDomains(records: .shared, manager: SystemFamilyDomains())
    #endif

    let records: FamilyDomainRecords
    let manager: any FamilyDomainManaging
    let temporary: URL
    private let lock = NSLock()
    private var tail: Task<Void, Never>?
    /*
     * Let-gos this process couldn't write (the store's lock not had, or the write refused), by family,
     * with whose record they take: written again before anything else is decided about the family, and
     * until then its acceptances add nothing and this process's extension calls refuse.
     */
    private var pending: [String: (owner: AccountOwner?, session: CopySession?, signedIn: SharedKeychain.Session?)] = [:]
    /* The generation each family's pending let-go moved it to once written: what the removal it queued is tagged with. */
    private var landed: [String: UInt64] = [:]

    /* The session stored for every process now (the shared keychain's), as `FamilyFilesSource` reads it. */
    let sharedSession: @Sendable () -> SharedKeychain.Session?

    public init(records: FamilyDomainRecords, manager: any FamilyDomainManaging, temporary: URL = FileManager.default.temporaryDirectory,
                sharedSession: @escaping @Sendable () -> SharedKeychain.Session? = { SharedKeychain.session }) {
        self.records = records
        self.manager = manager
        self.temporary = temporary
        self.sharedSession = sharedSession
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

    /* The family's revocation generation, for a check about to begin (nil: the store can't be read, so nothing it accepts is added). */
    public func generation(_ groupId: String) -> UInt64? { records.generation(groupId) }

    /*
     * A sync of `session` accepted the family, having begun when its revocation generation was
     * `observed`: its record, then its location. Never over another account's record (that location
     * goes at the next `reconcile`), never once the session ended, and never when the family was let
     * go of since the check began, here or in another process.
     */
    @discardableResult
    public func accepted(_ groupId: String, name: String, workspaces: [String] = [], owner: AccountOwner, observed: UInt64?, session: CopySession) -> Task<Void, Never> {
        let groupId = groupId.lowercased()
        return enqueue { [self] in
            guard FamilyRecords.valid(groupId), let observed, session.stands else { return }
            // A let-go this process couldn't write is written first; while it still can't be, nothing is added.
            guard !revocationPending(groupId) else { return }
            var ours = false
            let wrote = records.update { stored in
                guard stored.revoked[groupId, default: 0] <= observed else { return }
                if let record = stored.records[groupId], record.owner != owner { return }
                stored.records[groupId] = FamilyDomainRecord(owner: owner, name: name, workspaces: workspaces.map { $0.lowercased() }.sorted(),
                                                             generation: stored.revoked[groupId, default: 0])
                ours = true
            }
            guard wrote, ours, session.stands else { return }
            let identifier = FamilyFileIds.domain(groupId)
            guard let existing = try? await manager.domains() else { return }
            // Missing, or named otherwise than the family is now (a rename, or one whose add failed before): added, which
            // for an identifier that exists updates its name. Compared with the system's name, never the record's.
            if existing[identifier] != name {
                // Another process may have let the family go while this one waited: asked again, under the store's lock,
                // right before the add, and again after it, when a let-go that landed during the add takes the location back.
                guard stands(groupId, owner: owner, observed: observed, session: session) else { return }
                try? await manager.add(identifier, name: name)
                guard stands(groupId, owner: owner, observed: observed, session: session) else {
                    try? await manager.remove(identifier)
                    return
                }
            }
            await manager.signal(identifier)
        }
    }

    /*
     * Whether an acceptance begun at `observed` still holds, read under the store's lock: its session
     * stands, no let-go is pending here, the record is `owner`'s, and no let-go came since.
     */
    private func stands(_ groupId: String, owner: AccountOwner, observed: UInt64, session: CopySession) -> Bool {
        guard session.stands, !revocationPending(groupId) else { return false }
        var holds = false
        let read = records.update { stored in
            holds = stored.records[groupId]?.owner == owner && stored.revoked[groupId, default: 0] <= observed
        }
        return read && holds
    }

    /*
     * The family was let go of (by whatever process found it): its revocation generation moves and
     * its record goes now, on disk, so every extension call refuses from here on and no acceptance
     * begun before writes it back; this process's copies of its folders go; then its location, with
     * what Files kept of it. Only `owner`'s record (nil: whoever's); the generation moves regardless.
     */
    @discardableResult
    public func letGo(_ groupId: String, owner: AccountOwner?, session: CopySession? = nil, signedIn: SharedKeychain.Session? = nil) -> Task<Void, Never> {
        let groupId = groupId.lowercased()
        // A late let-go of a session that ended (the account signed in again since) touches nothing of the session now.
        if let session, !session.stands { return enqueue {} }
        enum Outcome { case at(UInt64), stale, pending }
        let outcome = lock.withLock { () -> Outcome in
            for _ in 0 ..< 3 {
                switch write(groupId, owner: owner, session: session, signedIn: signedIn) {
                case .at(let generation): return .at(generation)
                case .stale: return .stale
                case .refused: continue
                }
            }
            pending[groupId] = (owner, session, signedIn)
            landed[groupId] = nil
            return .pending
        }
        let wrote: UInt64?
        switch outcome {
        // Its session isn't the one signed in now (here or in another process): nothing of the session now is touched.
        case .stale: return enqueue {}
        case .at(let generation): wrote = generation
        case .pending: wrote = nil
        }
        // The location goes whether or not the store took the let-go (Files drops what it holds of it), unless by then the
        // family's record is someone else's (another account, or a session after this one, added the family since) or was
        // written after the let-go (an acceptance that came once it landed, run while this removal waited its turn).
        return enqueue { [self] in
            // Left pending: the generation its write reached since, if it did (until then nothing is accepted).
            let generation = wrote ?? lock.withLock { landed[groupId] }
            guard mayRemove(groupId, owner: owner, session: session, after: generation) else { return }
            try? await manager.remove(FamilyFileIds.domain(groupId))
        }
    }

    /*
     * Whether a let-go of `owner` and `session`, which moved the family's generation to `generation`,
     * may still remove its location: read under the store's lock, the record is gone, or was written
     * before the let-go and is still `owner`'s while that session stands. A store that can't be read
     * removes it (fail-safe: Files only drops a cache).
     */
    private func mayRemove(_ groupId: String, owner: AccountOwner?, session: CopySession?, after generation: UInt64?) -> Bool {
        var record: FamilyDomainRecord?
        guard records.update({ stored in record = stored.records[groupId] }) else { return true }
        guard let record else { return true }
        // Written at the generation the let-go moved the family to, or later: an acceptance that came after it.
        if let generation, let written = record.generation, written >= generation { return false }
        if let owner, record.owner != owner { return false }
        if let session, !session.stands { return false }
        return true
    }

    /* What writing a let-go came to. */
    private enum Written {
        /* The store couldn't be locked, read or written. */
        case refused
        /* Its session ended: nothing is written over the session now. */
        case stale
        /* Written: the family's generation is now this one. */
        case at(UInt64)
    }

    /*
     * One let-go written: the generation moved and `owner`'s record (nil: whoever's) gone, its copies
     * here with it. Stale, and nothing written, once its session ended in this process, or once the
     * session stored for every process isn't `signedIn` (the same account signed in again elsewhere):
     * both asked under the store's lock, so no acceptance of the session now slips in between.
     */
    private func write(_ groupId: String, owner: AccountOwner?, session: CopySession?, signedIn: SharedKeychain.Session?) -> Written {
        var workspaces: [String] = []
        var stale = false
        var generation: UInt64 = 0
        let wrote = records.update { stored in
            if let session, !session.stands {
                stale = true
                return
            }
            if let signedIn, sharedSession() != signedIn {
                stale = true
                return
            }
            stored.revoked[groupId, default: 0] += 1
            generation = stored.revoked[groupId, default: 0]
            if let record = stored.records[groupId], owner == nil || record.owner == owner {
                workspaces = record.workspaces ?? []
                stored.records[groupId] = nil
            }
        }
        if !workspaces.isEmpty { TemporaryCopies.forgetFamily(workspaces, in: temporary) }
        if stale { return .stale }
        return wrote ? .at(generation) : .refused
    }

    /*
     * Whether a let-go of the family is still unwritten in this process, after trying to write it
     * again: while it is, the family's acceptances add nothing and the extension refuses it.
     */
    public func revocationPending(_ groupId: String) -> Bool {
        let groupId = groupId.lowercased()
        return lock.withLock {
            guard let held = pending[groupId] else { return false }
            // Written as the session it came from: one that ended since is dropped, never written over the next session's.
            switch write(groupId, owner: held.owner, session: held.session, signedIn: held.signedIn) {
            case .at(let generation):
                pending[groupId] = nil
                landed[groupId] = generation
            case .stale: pending[groupId] = nil
            case .refused: break
            }
            return pending[groupId] != nil
        }
    }

    /*
     * Signed in (or found signed in) as `owner`: a family location without a record of this account
     * goes (another account's, or one whose record a revocation took), and another account's records
     * go once their locations have. Those that stay are told the session is back (Files paused them
     * on `.notAuthenticated`, as it does the drive's). Families are added only by an acceptance.
     */
    @discardableResult
    public func reconcile(owner: AccountOwner) -> Task<Void, Never> {
        enqueue { [self] in
            guard let identifiers = (try? await manager.domains()).map({ Array($0.keys) }), let held = try? records.read() else { return }
            var present = Set(identifiers)
            var kept: [String] = []
            for identifier in identifiers {
                let groupId = FamilyFileIds.group(ofDomain: identifier)
                if let groupId, held[groupId]?.owner == owner {
                    kept.append(identifier)
                    continue
                }
                if (try? await manager.remove(identifier)) != nil { present.remove(identifier) }
            }
            records.update { stored in
                stored.records = stored.records.filter { $0.value.owner == owner || present.contains(FamilyFileIds.domain($0.key)) }
            }
            for identifier in kept { await manager.resolved(identifier) }
        }
    }

    /*
     * Sign-out, deletion, another account in: every family location goes, each record only once
     * its location went (one that stays is refused to anyone else). Unknown locations: nothing.
     */
    public func removeAll() async {
        await enqueue { [self] in
            guard let identifiers = (try? await manager.domains()).map({ Array($0.keys) }) else { return }
            var present = Set(identifiers)
            for identifier in identifiers where (try? await manager.remove(identifier)) != nil { present.remove(identifier) }
            records.update { stored in stored.records = stored.records.filter { present.contains(FamilyFileIds.domain($0.key)) } }
        }.value
    }

    /*
     * A family location whose record is another account's met the account signed in now (it outlived
     * a switch): that location goes, and its record once it has, while the record still isn't
     * `current`'s. Nothing of the account signed in now is touched.
     */
    @discardableResult
    public func dropForeign(_ groupId: String, current: AccountOwner) -> Task<Void, Never> {
        let groupId = groupId.lowercased()
        return enqueue { [self] in
            func foreign() -> Bool {
                var record: FamilyDomainRecord?
                guard records.update({ stored in record = stored.records[groupId] }), let record else { return false }
                return record.owner != current
            }
            guard foreign(), (try? await manager.remove(FamilyFileIds.domain(groupId))) != nil else { return }
            records.update { stored in
                if let record = stored.records[groupId], record.owner != current { stored.records[groupId] = nil }
            }
        }
    }

    /* Files is told a family's location changed (the app saw its folders change). */
    public func signal(_ groupId: String) {
        enqueue { [manager] in await manager.signal(FamilyFileIds.domain(groupId)) }
    }

    /*
     * A process starting: copies of family folders no record names (a family let go of while this
     * process was away, or never added) go from its temporary folder. Nothing when the store can't be read.
     */
    @discardableResult
    public func sweepUnrecorded() -> Bool {
        guard let keep = records.recordedWorkspaces() else { return false }
        return TemporaryCopies.sweepFamily(keeping: keep, in: temporary)
    }

    /* Tests: every system call asked for so far, done. */
    func settled() async { await enqueue {}.value }
}

#if canImport(FileProvider)
/* The system's family locations. A new one on iOS starts disabled until the person turns it on in Files, as the drive's. */
struct SystemFamilyDomains: FamilyDomainManaging {
    func domains() async throws -> [String: String] {
        var out: [String: String] = [:]
        for domain in try await NSFileProviderManager.domains() where domain.identifier.rawValue.hasPrefix(FamilyFileIds.prefix) {
            out[domain.identifier.rawValue] = domain.displayName
        }
        return out
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

    func resolved(_ identifier: String) async {
        guard let manager = NSFileProviderManager(for: NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier(identifier), displayName: "")) else { return }
        try? await manager.signalErrorResolved(NSFileProviderError(.notAuthenticated))
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
    /* A key change in the family's folders that this device hasn't followed yet: checked again, then Files asks again. */
    case keyChange
    /* The session ended while the family was checked: the location asks for the sign-in sheet. */
    case signedOut

    /*
     * Whether `error` is a key change met mid-way rather than an answer about the item: the ledger's
     * pending key change, a folder served under a key version or epoch this device hasn't accepted
     * the member list for yet (older or newer), or the server's `rotating` or `stale`.
     */
    static func keyChanging(_ error: Error) -> Bool {
        if KeyChangeWait.meets(error, waited: true) { return true }
        guard let core = error as? CoreError else { return false }
        let message = FamilyWords.message(of: core).lowercased()
        return ["workspace key", "folder key", "key epoch", "keys changed", "key change", "rotation holds"].contains { message.contains($0) }
    }
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
    /* This process's lifecycle: a let-go it couldn't write yet refuses the family here too. */
    let domains: FamilyFilesDomains?
    let owner: AccountOwner
    let now: @Sendable () -> Date
    /* The session this source serves, and the one stored for every process now (the shared keychain's): two that differ refuse. */
    let session: SharedKeychain.Session
    let sharedSession: @Sendable () -> SharedKeychain.Session?
    /* Each folder's feed cursor as read just before the folders held were checked: the anchors Files gets match what it was shown. */
    private var snapshotHeads: [String: Int] = [:]
    /* This process's temporary folder: its `opened/family/<workspace>` holds the family's decrypted copies. */
    let temporary: URL
    private var view: FamilyView?
    private var checkedAt: Date?
    /* Every folder of the family this source has answered for: whose copies go once it is let go of. */
    private var known: Set<String> = []

    static let fresh: TimeInterval = 60

    public init(groupId: String, vault: Vault, sync: FamilySync, records: FamilyDomainRecords = .shared, domains: FamilyFilesDomains? = nil,
                temporary: URL = FileManager.default.temporaryDirectory, now: @escaping @Sendable () -> Date = { Date() },
                sharedSession: @escaping @Sendable () -> SharedKeychain.Session? = { SharedKeychain.session }) {
        self.groupId = groupId.lowercased()
        session = vault.session
        self.sharedSession = sharedSession
        self.vault = vault
        self.sync = sync
        self.records = records
        self.domains = domains ?? sync.filesDomains
        self.temporary = temporary
        owner = AccountOwner(vault.session)
        self.now = now
    }

    /* The family's copies in this process, every one: partial downloads included. */
    private func dropCopies() {
        if !known.isEmpty { TemporaryCopies.forgetFamily(Array(known), in: temporary) }
    }

    /* The record's say, before anything this process holds: a revocation on disk wins, and takes this process's copies. */
    private func admit() throws {
        // The session this source serves ended (signed out, another account): nothing of it is answered.
        guard vault.copySession.stands else {
            view = nil
            throw FamilyFilesError.otherAccount
        }
        // Another process signed out or in meanwhile (the app): this process's view of the session lags, the keychain doesn't.
        // The session ends here, and every copy made for it goes.
        guard sharedSession() == session else {
            view = nil
            TemporaryCopies.endAccount(vault.copySession.account)
            dropCopies()
            throw FamilyFilesError.otherAccount
        }
        // A let-go this process found but couldn't write: the record on disk still stands, the family doesn't.
        if domains?.revocationPending(groupId) == true {
            view = nil
            dropCopies()
            throw FamilyFilesError.letGo
        }
        switch records.admission(groupId, owner: owner) {
        case .admitted: return
        case .letGo:
            view = nil
            dropCopies()
            throw FamilyFilesError.letGo
        case .otherAccount:
            view = nil
            throw FamilyFilesError.otherAccount
        case .unreadable:
            throw GuardError.unreadable
        }
    }

    /*
     * Every answer of family data goes through here, so none can skip the last check: `body` runs
     * (awaiting whatever it needs), then, with nothing awaited after it, the location's record, a
     * pending let-go and the session are asked again, and `gate` (a copy's) is checked. A refusal
     * deletes `copy` if one was made, and every copy of the family once it was let go of. A body that
     * fails is asked about too: a revocation is the answer, whatever else went wrong.
     */
    private func serving<T>(copy: URL? = nil, gate: FamilyCopyGate? = nil, _ body: () async throws -> T) async throws -> T {
        let value: T
        do {
            value = try await body()
        } catch {
            try admit()
            throw keyChangeChecked(error)
        }
        #if DEBUG
        // Tests: what lands during the body's last await (a revocation from another process).
        lastAwait?()
        #endif
        do {
            try admit()
            try gate?.check()
        } catch {
            if let copy { try? FileManager.default.removeItem(at: copy) }
            throw error
        }
        return value
    }

    /*
     * Every read's one classifier for a key change met mid-way (the ledger's, a folder's key or epoch,
     * `rotating`, `stale`, a folder that doesn't open here yet): no verdict about the item, so Files
     * asks again (`.keyChange`, never a corrupt file or a deletion), and the family is checked again
     * on the next call rather than served from a view the key change made stale.
     */
    private func keyChangeChecked(_ error: Error) -> Error {
        guard error as? FamilyFilesError == .keyChange || FamilyFilesError.keyChanging(error) else { return error }
        checkedAt = nil
        return FamilyFilesError.keyChange
    }

    #if DEBUG
    /* Tests: runs as a body's last await ends, right before the final check. */
    var lastAwait: (@Sendable () -> Void)?
    func setLastAwait(_ hook: (@Sendable () -> Void)?) { lastAwait = hook }
    #endif

    /* The family as accepted here, checked again when due. */
    public func admitted() async throws -> FamilyView { try await serving { try await currentView() } }

    private func currentView() async throws -> FamilyView {
        try admit()
        if let view, let checkedAt, now().timeIntervalSince(checkedAt) < Self.fresh { return view }
        return try await check()
    }

    /*
     * Only no answer (offline, a timeout, the server busy or failing) keeps what was accepted; a lost
     * session (401) or any other answer is passed on, so Files offers the sign-in sheet rather than a
     * folder from before.
     */
    private func heldOnNoAnswer(_ error: Error) throws -> FamilyView {
        if Self.endsSession(error) { throw FamilyFilesError.signedOut }
        guard let view, FamilySync.transient(error) else { throw error }
        return view
    }

    static func endsSession(_ error: Error) -> Bool {
        if case DriveAPIError.notAuthenticated = error { return true }
        if case AuthError.sessionEnded = error { return true }
        if let error = error as? GroupsAPIError, error.status == 401 { return true }
        return false
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
            return try heldOnNoAnswer(error)
        }
        // Not listed, but not confirmed gone either: kept as it was until the server says not-member (the caller's
        // final check still asks the record: a let-go whose wipe couldn't finish takes it without naming the family).
        guard let summary = listed.first(where: { $0.id.lowercased() == groupId }) else {
            if let view { return view }
            throw FamilyFilesError.unavailable
        }
        // The cursors first, then the folders: an anchor from them never sits past a change the folders don't show.
        let heads = try? await heads()
        let revised = await sync.syncRevised(summary)
        switch revised.state {
        case .accepted(let accepted):
            view = accepted
            snapshotHeads = heads ?? [:]
            known.formUnion(accepted.areas.map { $0.workspaceId.lowercased() })
            checkedAt = now()
            return accepted
        case .failed(let words) where words == FamilyWords.noAnswer || revised.cause == .noAnswer:
            // No answer, or the server busy or failing: nothing is decided, what was accepted stands.
            if let view { return view }
            throw FamilyFilesError.unavailable
        case .failed where revised.cause == .session:
            // The session ended: the location asks for the sign-in sheet, and keeps what it holds.
            throw FamilyFilesError.signedOut
        default:
            // The sync let it go (its release took the record and asked for the location to go).
            view = nil
            dropCopies()
            throw FamilyFilesError.letGo
        }
    }

    /* The family's folders that open here, as the location's top level. */
    public func folders() async throws -> [FamilyArea] { try await serving { try await openFolders() } }

    private func openFolders() async throws -> [FamilyArea] { Self.open(in: try await currentView()) }

    private static func open(in view: FamilyView) -> [FamilyArea] {
        view.areas.filter(\.openable).sorted { ($0.name ?? "").localizedStandardCompare($1.name ?? "") == .orderedAscending }
    }

    /*
     * The family's folder `ref` is in. One the family still lists that doesn't open here yet (a key
     * change between the member list and the folders, read one after the other) is asked again,
     * never answered as gone: Files would drop what it holds of it.
     */
    private func area(_ ref: NodeRef, in view: FamilyView) throws -> FamilyArea {
        guard let area = view.areas.first(where: { $0.workspaceId.lowercased() == ref.workspaceId }) else { throw FamilyFilesError.notInFamily }
        guard area.openable else { throw FamilyFilesError.keyChange }
        return area
    }

    /* Whether `ref` is a top folder of the family (its parent in Files is the location itself). */
    public func isFolderRoot(_ ref: NodeRef) async throws -> Bool {
        try await serving { try area(ref, in: try await currentView()).root?.id.lowercased() == ref.nodeId }
    }

    /* A folder's children, in one of the family's folders. */
    public func children(of folder: NodeRef) async throws -> [Opened] {
        try await serving {
            _ = try area(folder, in: try await currentView())
            let listing = try await vault.listChildren(of: folder.nodeId, in: folder.workspaceId)
            var out: [Opened] = []
            for child in listing.children where child.ref.workspaceId == folder.workspaceId {
                if let opened = await vault.item(child.ref) { out.append(opened) }
            }
            return out
        }
    }

    /* An item of the family's folders: as held here, or opened by listing the folder it was last seen in. */
    public func item(_ ref: NodeRef) async throws -> Opened { try await serving { try await lookUp(ref) } }

    private func lookUp(_ ref: NodeRef) async throws -> Opened {
        let area = try area(ref, in: try await currentView())
        if let held = await vault.item(ref) { return held }
        if let root = area.root, root.id.lowercased() == ref.nodeId {
            _ = try await vault.listChildren(of: root.id, in: ref.workspaceId)
        } else if let parent = await vault.knownParent(ref.nodeId) {
            _ = try await vault.listChildren(of: parent, in: ref.workspaceId)
        } else {
            throw FamilyFailure(message: FamilyWords.openAgain)
        }
        guard let opened = await vault.item(ref) else { throw DriveAPIError.notFound("This item no longer exists.") }
        return opened
    }

    /*
     * A file's current version, decrypted under the family's copy gate to the process's
     * `opened/family/<workspace>/files/<node>/<version>/content` (where a forget of the family
     * reaches it; a partial there is continued by the next try), handed on only through `serving`:
     * however the download ends, a revocation found then (here or from another process) leaves no
     * copy of the family's folders, partials included.
     */
    public func download(_ ref: NodeRef, progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> (file: URL, item: Opened) {
        known.insert(ref.workspaceId)
        let gate = vault.copyGate(familyWorkspace: ref.workspaceId)
        var made: URL?
        do {
            return try await serving(copy: nil, gate: gate) {
                let item = try await lookUp(ref)
                let file = temporary.appendingPathComponent("opened/family/\(ref.workspaceId)/files/\(ref.nodeId)/\(item.node.currentVersion?.id ?? "none")", isDirectory: true)
                    .appendingPathComponent("content")
                made = file
                try gate.perform { try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true) }
                try await vault.download(ref.nodeId, ref: ref, expectedVersionId: item.node.currentVersion?.id, to: file, gate: gate, progress: progress)
                // The row the bytes are of (`expectedVersionId`), never one a listing learned meanwhile: Files gets one version.
                return (file, item)
            }
        } catch {
            if let made { try? FileManager.default.removeItem(at: made) }
            throw error
        }
    }

    public func thumbnail(_ ref: NodeRef) async throws -> Data? {
        try await serving { try await vault.thumbnail(of: try await lookUp(ref)) }
    }

    /* Where each folder's feed stands now (route 25's change sequences), for a new anchor. */
    public func anchor() async throws -> FamilyAnchor {
        try await serving {
            // The folders Files is shown, with the cursors read with them (none read: from the start, which only repeats).
            let folders = try await openFolders()
            var anchor = FamilyAnchor()
            for area in folders {
                guard let root = area.root else { continue }
                anchor.folders[area.workspaceId.lowercased()] = .init(root: root.id.lowercased(), cursor: snapshotHeads[area.workspaceId.lowercased()] ?? 0)
            }
            return anchor
        }
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
        try await serving { try await changesSince(anchor) }
    }

    private func changesSince(_ anchor: FamilyAnchor) async throws -> FamilyChanges? {
        let view = try await currentView()
        let folders = Self.open(in: view)
        var next = FamilyAnchor()
        var added: [FamilyArea] = []
        var updated: [Opened] = []
        var deleted: [String] = []
        var more = false
        let open = Set(folders.map { $0.workspaceId.lowercased() })
        let listed = Set(view.areas.map { $0.workspaceId.lowercased() })
        for (workspace, folder) in anchor.folders where !open.contains(workspace) {
            // Still listed but not open here yet (a key change between the member list and the folders): nothing of the
            // batch is answered, so the folder keeps its place and its cursor, and the next call checks the family first.
            if listed.contains(workspace) { throw FamilyFilesError.keyChange }
            // No longer the family's: it leaves the location.
            deleted.append(FamilyFileIds.item(NodeRef(workspaceId: workspace, nodeId: folder.root)))
        }
        for area in folders {
            guard let root = area.root else { continue }
            let workspace = area.workspaceId.lowercased()
            guard let held = anchor.folders[workspace], held.root == root.id.lowercased() else {
                if let held = anchor.folders[workspace] { deleted.append(FamilyFileIds.item(NodeRef(workspaceId: workspace, nodeId: held.root))) }
                added.append(area)
                // The cursor read with the folders this item comes from, so nothing between the two is skipped.
                next.folders[workspace] = .init(root: root.id.lowercased(), cursor: snapshotHeads[workspace] ?? 0)
                continue
            }
            // A key change met here answers nothing of the batch: the anchor stays, and the next call checks the family first (`serving`).
            guard let feed = try await vault.familyChanges(in: workspace, since: held.cursor) else { return nil }
            updated += feed.updated
            deleted += feed.deleted.map { FamilyFileIds.item(NodeRef(workspaceId: workspace, nodeId: $0)) }
            more = more || feed.hasMore
            next.folders[workspace] = .init(root: held.root, cursor: feed.nextCursor)
        }
        return FamilyChanges(added: added, updated: updated, deleted: deleted, next: next, hasMore: more)
    }
}

/*
 * Which Files locations have asked for the sign-in sheet since someone last signed in: each asks
 * once (signalling its own working set), whatever another location asked, so a family location
 * that loses its session gets the sheet and not a dead-end alert.
 */
public final class SignInAsks: @unchecked Sendable {
    public static let shared = SignInAsks()
    private let lock = NSLock()
    private var asked: Set<String> = []

    public init() {}

    /* True the first time `domain` asks until the next `reset`. */
    public func first(_ domain: String) -> Bool { lock.withLock { asked.insert(domain).inserted } }

    /* Someone signed in: every location may ask again. */
    public func reset() { lock.withLock { asked = [] } }
}
