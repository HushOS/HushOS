import Foundation
import HushOSCore

/*
 * The save path on the phone (docs/file-tools-design.md section 2, the web's
 * packages/drive/src/save-runs.ts): how File tools and editing write what they
 * produce. Two modes: a new version of the same file, which a version race ends
 * `stale` (never a conflict copy), and a new file under the next free name in its
 * folder, which never replaces anything.
 *
 * A run asks its destination once whether it may be written (a family folder
 * read-only or whose keys changed refuses; one a key change is still walking
 * takes the run, whose uploads wait it out) and whether its results fit (padded
 * ciphertext, by the core's estimate, against the free space where that is the
 * person's to know). Results upload from memory, never a temporary plaintext
 * file, and never resume. One row of ids per run (SaveRunRow) lets a cancel, a
 * refusal, a 402, a failure or a killed app leave nothing behind: open uploads
 * aborted, what was published deleted forever, or moved to the Trash where the
 * person may not delete forever (an editor in someone else's share).
 */

/* A new version found someone else's version current: nothing was published (Save on top, Save as a copy, Open theirs). */
public struct SaveStale: Error, Equatable, LocalizedError {
    public let currentVersionId: String?
    public init(currentVersionId: String?) { self.currentVersionId = currentVersionId }
    public var errorDescription: String? { "Someone else saved a newer version of this file, so this one wasn’t saved." }
}

/* The ids begin made, handed from the upload's closure to the run. */
final class BegunBox: @unchecked Sendable {
    private let lock = NSLock()
    private var held: Vault.BegunIds?
    var ids: Vault.BegunIds? {
        get { lock.withLock { held } }
        set { lock.withLock { held = newValue } }
    }
}

/* A run's row: ids only, never a name or a byte. `launch` is the process that ran it. */
public struct SaveRunRow: Codable, Equatable, Sendable {
    public let id: String
    public let workspaceId: String
    public var nodeIds: [String]
    public var uploadIds: [String]
    public let at: Date
    public let launch: String
}

/*
 * The rows, in the app group's `state` folder: out of backups, and deleted with the account's
 * files at sign-out (AccountStore.accountFiles).
 */
public final class SaveRunJournal: @unchecked Sendable {
    let url: URL
    private let lock = NSLock()

    public init() { url = Unbacked.state.appendingPathComponent("save-runs.json") }
    init(url: URL) { self.url = url }

    public func list() -> [SaveRunRow] {
        lock.withLock { read() }
    }

    func put(_ row: SaveRunRow) {
        lock.withLock {
            var rows = read().filter { $0.id != row.id }
            rows.append(row)
            write(rows)
        }
    }

    func remove(_ id: String) {
        lock.withLock { write(read().filter { $0.id != id }) }
    }

    private func read() -> [SaveRunRow] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([SaveRunRow].self, from: data)) ?? []
    }

    private func write(_ rows: [SaveRunRow]) {
        if rows.isEmpty { try? FileManager.default.removeItem(at: url); return }
        Unbacked.folder(url.deletingLastPathComponent())
        guard let data = try? JSONEncoder().encode(rows) else { return }
        try? data.write(to: url, options: .atomic)
    }
}

/* Whether a run may write into a target: refused (with why), or allowed, a key change's wait included. */
public enum SaveGate: Sendable, Equatable {
    case writable
    case refused(String)
}

/* What a run asks of the drive. The vault is one; tests stand one in. */
public protocol SaveRunWriter: Sendable {
    func gate(_ target: Opened) async -> SaveGate
    /* Free bytes of a workspace, or nil when they are not this person's to know (someone else's share). */
    func freeSpace(_ workspaceId: String) async throws -> Int64?
    func names(in folder: Opened) async throws -> [String]
    func makeFolder(in folder: Opened, name: String, signing: Signing) async throws -> Opened
    func uploadResult(_ bytes: Data, name: String, mime: String?, in folder: Opened, replacing: Opened?, startedFrom: String?,
                      signing: (metadata: Signing, version: Signing), onBegun: @escaping @Sendable (Vault.BegunIds) -> Void) async throws -> Opened
    /* One pause while an upload waits out a family folder's key change (KeyChangeWait). */
    func keyChangePause(_ workspaceId: String, attempt: Int) async throws
    func abortUpload(_ uploadId: String, in workspaceId: String) async
    func trash(_ ids: [String], in workspaceId: String) async throws
    func purge(_ ids: [String], in workspaceId: String) async throws
    /* Whether the server lets this person delete forever there: a member (their own Drive, a family's folder). */
    func mayPurge(_ workspaceId: String) async -> Bool
}

/* What a clean-up did with what the run made; `left` when it couldn't reach the server, and the row stays. */
public enum SaveCleanup: Sendable, Equatable { case deleted, trashed, nothing, left }

/* Why a run did not start: nothing was made. */
public struct SaveRefused: Error, Equatable, LocalizedError {
    public enum Reason: Sendable, Equatable { case readOnly, noRoom }
    public let reason: Reason
    public let message: String
    /* In the person's own space (or their family's): what the run needs and what is free. Never for a share. */
    public let needed: UInt64?
    public let free: Int64?
    public var errorDescription: String? { message }
}

/* Why a run stopped after it started, and what its clean-up did. */
public struct SaveRunStopped: Error, Equatable, LocalizedError {
    public enum Reason: Sendable, Equatable { case cancelled, noRoom, failed }
    public let reason: Reason
    public let message: String
    public let cleanup: SaveCleanup
    public var errorDescription: String? { message }
}

public enum VersionSaved: Sendable, Equatable {
    case saved(Opened)
    case stale(currentVersionId: String?)
}

public enum SaveRuns {
    public static let noRoom = "There isn’t enough room for this. Nothing was saved."
    public static let noRoomShared = "There isn’t enough room in this shared folder for this. Nothing was saved."
    public static let cancelled = "Cancelled. Nothing was saved."
    public static let failed = "This couldn’t be saved, so nothing was kept."

    /* This process: a row another launch left is interrupted, one of this launch's is a live run's. */
    static let launch = UUID().uuidString.lowercased()
    nonisolated(unsafe) static var live = Set<String>()
    static let liveLock = NSLock()

    /*
     * What a result is signed as a copy of: record by record, the weakest of its sources' verdicts
     * (the core's weakestCopyPrior). A source saved from a link is `.savedFromLink`.
     */
    public static func signing(sources: [(metadata: Integrity, version: Integrity)]) throws -> (metadata: Signing, version: Signing) {
        (.copy(try weakestCopyPrior(priors: sources.map(\.metadata))), .copy(try weakestCopyPrior(priors: sources.map(\.version))))
    }

    /* Runs another launch left behind, for the next open to offer to delete what they made. */
    public static func interrupted(_ journal: SaveRunJournal = SaveRunJournal()) -> [SaveRunRow] {
        journal.list().filter { $0.launch != launch }
    }

    /* Removes what an interrupted run made, as a cancel would have, then its row. */
    public static func cleanUp(_ row: SaveRunRow, writer: SaveRunWriter, journal: SaveRunJournal = SaveRunJournal()) async -> SaveCleanup {
        for uploadId in row.uploadIds { await writer.abortUpload(uploadId, in: row.workspaceId) }
        let cleanup = await discard(row.nodeIds, in: row.workspaceId, writer: writer)
        if cleanup != .left { journal.remove(row.id) }
        return cleanup
    }

    static func discard(_ ids: [String], in workspaceId: String, writer: SaveRunWriter) async -> SaveCleanup {
        guard !ids.isEmpty else { return .nothing }
        do {
            try await writer.trash(ids, in: workspaceId)
            guard await writer.mayPurge(workspaceId) else { return .trashed }
            try await writer.purge(ids, in: workspaceId)
            return .deleted
        } catch {
            return .left
        }
    }
}

public actor SaveRun {
    public nonisolated let id: String
    public nonisolated let signing: (metadata: Signing, version: Signing)
    let writer: SaveRunWriter
    let journal: SaveRunJournal
    let first: Opened
    /* Whether the destination's free space is not this person's to know: a 402 then says so without figures. */
    let shared: Bool
    let pause: (@Sendable (Int) async throws -> Void)?
    let now: @Sendable () -> Date
    var row: SaveRunRow
    var madeFolders = Set<String>()
    var claimed: [String: Set<String>] = [:]
    var stopped: SaveRunStopped?
    var finished = false
    var inFlight = 0
    /* Uploads already over: a begin heard late (its note runs after the upload's answer) adds nothing back. */
    var settledUploads = Set<String>()

    init(writer: SaveRunWriter, journal: SaveRunJournal, row: SaveRunRow, first: Opened, shared: Bool,
         signing: (metadata: Signing, version: Signing), pause: (@Sendable (Int) async throws -> Void)?, now: @escaping @Sendable () -> Date) {
        self.id = row.id
        self.writer = writer
        self.journal = journal
        self.row = row
        self.first = first
        self.shared = shared
        self.signing = signing
        self.pause = pause
        self.now = now
    }

    /*
     * Starts a run writing into `targets` (folders for new files, files for new versions; one
     * workspace), signed as `signing` (SaveRuns.signing of its sources, or `.own` for the person's
     * own writing). Throws SaveRefused before anything is made.
     */
    public static func start(writer: SaveRunWriter, targets: [Opened], results: [PlannedResult],
                             signing: (metadata: Signing, version: Signing), journal: SaveRunJournal = SaveRunJournal(),
                             pause: (@Sendable (Int) async throws -> Void)? = nil,
                             now: @escaping @Sendable () -> Date = { Date() }) async throws -> SaveRun {
        guard let first = targets.first else { throw SaveRefused(reason: .readOnly, message: "There’s nowhere to save this.", needed: nil, free: nil) }
        let workspaceId = first.node.workspaceId
        guard targets.allSatisfy({ $0.node.workspaceId == workspaceId }) else {
            throw SaveRefused(reason: .readOnly, message: "Save into one place at a time.", needed: nil, free: nil)
        }
        // Once for the run, not per result.
        for target in targets {
            if case .refused(let why) = await writer.gate(target) { throw SaveRefused(reason: .readOnly, message: why, needed: nil, free: nil) }
        }
        let needed = try runEstimate(results: results)
        let free = try await writer.freeSpace(workspaceId)
        if let free, Int64(clamping: needed) > free {
            throw SaveRefused(reason: .noRoom, message: SaveRuns.noRoom, needed: needed, free: max(0, free))
        }
        let row = SaveRunRow(id: UUID().uuidString.lowercased(), workspaceId: workspaceId, nodeIds: [], uploadIds: [], at: now(), launch: SaveRuns.launch)
        journal.put(row)
        SaveRuns.liveLock.withLock { _ = SaveRuns.live.insert(row.id) }
        return SaveRun(writer: writer, journal: journal, row: row, first: first, shared: free == nil, signing: signing, pause: pause, now: now)
    }

    private func check() throws {
        if let stopped { throw stopped }
        if finished { throw SaveRunStopped(reason: .failed, message: "This save has finished.", cleanup: .nothing) }
    }

    private func claim(_ name: String, in folder: Opened) async throws -> String {
        var taken: Set<String>
        if let held = claimed[folder.id] {
            taken = held
        } else if madeFolders.contains(folder.id) {
            taken = []
        } else {
            taken = Set(try await writer.names(in: folder))
            // Another result may have claimed names here while this one listed the folder.
            taken.formUnion(claimed[folder.id] ?? [])
        }
        let given = UploadNames.freeName(name, among: Array(taken))
        taken.insert(given)
        claimed[folder.id] = taken
        return given
    }

    /* A new folder for results under the next free name in `parent` (the run's first target by default). */
    public func folder(_ name: String, in parent: Opened? = nil) async throws -> Opened {
        try check()
        let into = parent ?? first
        let given = try await claim(name, in: into)
        let made = try await writer.makeFolder(in: into, name: given, signing: signing.metadata)
        if let stopped {
            _ = await SaveRuns.discard([made.id], in: row.workspaceId, writer: writer)
            throw stopped
        }
        madeFolders.insert(made.id)
        claimed[made.id] = []
        if !madeFolders.contains(into.id) {
            row.nodeIds.append(made.id)
            journal.put(row)
        }
        return made
    }

    /* A new file under the next free name in its folder; never replaces anything. */
    public func file(_ bytes: Data, name: String, mime: String?, in folder: Opened? = nil) async throws -> Opened {
        try check()
        let into = folder ?? first
        let given = try await claim(name, in: into)
        return try await upload(bytes, name: given, mime: mime, in: into, replacing: nil, startedFrom: nil, tracked: !madeFolders.contains(into.id))
    }

    /* A new version of `file` (in `folder`), unless someone else saved since the work started from `startedFrom`. */
    public func version(_ bytes: Data, of file: Opened, in folder: Opened, startedFrom: String?, mime: String? = nil) async throws -> VersionSaved {
        try check()
        do {
            return .saved(try await upload(bytes, name: file.name, mime: mime ?? file.metadata.mime, in: folder, replacing: file,
                                           startedFrom: startedFrom, tracked: false))
        } catch let stale as SaveStale {
            return .stale(currentVersionId: stale.currentVersionId)
        }
    }

    private func upload(_ bytes: Data, name: String, mime: String?, in folder: Opened, replacing: Opened?, startedFrom: String?,
                        tracked: Bool) async throws -> Opened {
        inFlight += 1
        defer { inFlight -= 1 }
        let begun = BegunBox()
        var since: Date?
        var attempt = 0
        while true {
            do {
                let landed = try await writer.uploadResult(bytes, name: name, mime: mime, in: folder, replacing: replacing, startedFrom: startedFrom,
                                                           signing: signing, onBegun: { ids in begun.ids = ids; Task { await self.begun(ids, tracked: tracked) } })
                await settled(begun.ids, landed: landed.id, tracked: tracked)
                if let stopped {
                    // Landed after the run was cancelled: it goes the way the rest went.
                    if tracked { _ = await SaveRuns.discard([landed.id], in: row.workspaceId, writer: writer) }
                    throw stopped
                }
                return landed
            } catch let stale as SaveStale {
                await settled(begun.ids, landed: nil, tracked: false)
                throw stale
            } catch where KeyChangeWait.meets(error, waited: since != nil) && stopped == nil {
                await settled(begun.ids, landed: nil, tracked: false)
                begun.ids = nil
                // A family folder a key change hasn't reached: the run waits it out, as the queue does.
                let start = since ?? now()
                since = start
                if now().timeIntervalSince(start) >= KeyChangeWait.giveUp { throw await stop(.failed, KeyChangeWait.gaveUp) }
                attempt += 1
                if let pause { try await pause(attempt) } else { try await writer.keyChangePause(folder.node.workspaceId, attempt: attempt) }
            } catch let stopped as SaveRunStopped {
                throw stopped
            } catch {
                // Kept in the row: the stop aborts its upload and removes its node, whatever got that far.
                if let ids = begun.ids { self.begun(ids, tracked: tracked) }
                if let stopped { throw stopped }
                let noRoom = Self.isNoRoom(error)
                throw await stop(noRoom ? .noRoom : .failed, noRoom ? (shared ? SaveRuns.noRoomShared : SaveRuns.noRoom) : error.localizedDescription)
            }
        }
    }

    static func isNoRoom(_ error: Error) -> Bool {
        if case DriveAPIError.server(402, _) = error { return true }
        return false
    }

    private func begun(_ ids: Vault.BegunIds, tracked: Bool) {
        guard stopped == nil, !finished, !settledUploads.contains(ids.uploadId) else { return }
        if !row.uploadIds.contains(ids.uploadId) { row.uploadIds.append(ids.uploadId) }
        if tracked, !row.nodeIds.contains(ids.nodeId) { row.nodeIds.append(ids.nodeId) }
        journal.put(row)
    }

    /* An upload is over: its id leaves the row; a new file that landed under another node is kept by that one. */
    private func settled(_ ids: Vault.BegunIds?, landed: String?, tracked: Bool) {
        guard let ids else { return }
        settledUploads.insert(ids.uploadId)
        row.uploadIds.removeAll { $0 == ids.uploadId }
        if tracked {
            if !row.nodeIds.contains(ids.nodeId) { row.nodeIds.append(ids.nodeId) }
            if let landed, landed != ids.nodeId {
                row.nodeIds.removeAll { $0 == ids.nodeId }
                row.nodeIds.append(landed)
            }
        }
        if stopped == nil, !finished { journal.put(row) }
    }

    @discardableResult
    private func stop(_ reason: SaveRunStopped.Reason, _ message: String) async -> SaveRunStopped {
        if let stopped { return stopped }
        let placeholder = SaveRunStopped(reason: reason, message: message, cleanup: .nothing)
        stopped = placeholder
        for uploadId in row.uploadIds { await writer.abortUpload(uploadId, in: row.workspaceId) }
        let cleanup = await SaveRuns.discard(row.nodeIds, in: row.workspaceId, writer: writer)
        if cleanup != .left { journal.remove(row.id) }
        SaveRuns.liveLock.withLock { _ = SaveRuns.live.remove(row.id) }
        let done = SaveRunStopped(reason: reason, message: message, cleanup: cleanup)
        stopped = done
        return done
    }

    /* Every result is in: the row goes. Refused while one is still on its way. */
    public func finish() throws {
        if let stopped { throw stopped }
        guard inFlight == 0 else { throw SaveRunStopped(reason: .failed, message: "Some results are still being saved.", cleanup: .nothing) }
        finished = true
        journal.remove(row.id)
        SaveRuns.liveLock.withLock { _ = SaveRuns.live.remove(row.id) }
    }

    /*
     * Stops the run and removes what it made (the caller cancels the task saving a result; one that
     * lands afterwards is removed as it lands).
     */
    public func cancel() async -> SaveCleanup {
        if finished { return .nothing }
        return await stop(.cancelled, SaveRuns.cancelled).cleanup
    }

    /* Results on their way: the app asks before it lets a run's screen go. */
    public func waiting() -> Int { inFlight }
}

extension Vault: SaveRunWriter {
    public func gate(_ target: Opened) async -> SaveGate {
        do {
            _ = try familyTarget(target.node.workspaceId)
            return .writable
        } catch where KeyChangeWait.meets(error, waited: false) {
            // A key change still walking the folder: the run's uploads wait for it.
            return .writable
        } catch {
            return .refused(error.localizedDescription)
        }
    }

    /* Known for the account's own Drive, and for a family folder whose family's pool the figures are; never for a share. */
    public func freeSpace(_ workspaceId: String) async throws -> Int64? {
        let storage = try await Auth.storage()
        let id = workspaceId.lowercased()
        if id == storage.workspaceId.lowercased() { return storage.free }
        if let group = familyAreaGroup[id], let pool = storage.pool, pool.groupId.lowercased() == group.lowercased() { return storage.free }
        return nil
    }

    public func names(in folder: Opened) async throws -> [String] {
        try await children(of: folder.id, in: folder.node.workspaceId).map(\.name)
    }

    public func makeFolder(in folder: Opened, name: String, signing: Signing) async throws -> Opened {
        try await createFolder(in: folder.id, name: name, signing: signing)
    }

    public func uploadResult(_ bytes: Data, name: String, mime: String?, in folder: Opened, replacing: Opened?, startedFrom: String?,
                             signing: (metadata: Signing, version: Signing), onBegun: @escaping @Sendable (BegunIds) -> Void) async throws -> Opened {
        try await uploadResult(bytes, name: name, mime: mime, in: folder.id, replacing: replacing, startedFrom: startedFrom, signing: signing, onBegun: onBegun)
    }

    public func keyChangePause(_ workspaceId: String, attempt: Int) async throws {
        try await Task.sleep(for: .seconds(KeyChangeWait.delay(attempt)))
        await familyJudge?.recheck(workspaceId)
    }

    public func abortUpload(_ uploadId: String, in workspaceId: String) async {
        await api.abortUpload(uploadId: uploadId, workspaceId: workspaceId)
    }

    public func trash(_ ids: [String], in workspaceId: String) async throws {
        for start in stride(from: 0, to: ids.count, by: TrashBatch.maxBatch) {
            _ = try await api.trashBatch(workspaceId: workspaceId, ids: Array(ids[start ..< min(ids.count, start + TrashBatch.maxBatch)]))
        }
    }

    public func purge(_ ids: [String], in workspaceId: String) async throws {
        for id in ids {
            do { try await api.purge(nodeId: id, workspaceId: workspaceId) } catch DriveAPIError.notFound { continue }
            remove(id, in: workspaceId)
        }
    }

    public func mayPurge(_ workspaceId: String) async -> Bool {
        let id = workspaceId.lowercased()
        if isFamilyWorkspace(id) { return true }
        return (try? await loadWorkspace().workspaceId.lowercased()) == id
    }
}
