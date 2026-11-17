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
 * refusal, a 402, a failure or a killed app leave no new file behind: open uploads
 * aborted, what was published deleted forever, or moved to the Trash where the
 * person may not delete forever (an editor in someone else's share). A new version
 * that already landed is kept, never rolled back, and the run says so.
 *
 * Each result is signed by its own sources (the weakest of them, the core's
 * weakestCopyPrior), or as the person's own writing (`.ownWriting`).
 */

/* A new version found someone else's version current (or its file gone): nothing was published (Save on top, Save as a copy, Open theirs). */
public struct SaveStale: Error, Equatable, LocalizedError {
    public let currentVersionId: String?
    public init(currentVersionId: String?) { self.currentVersionId = currentVersionId }
    public var errorDescription: String? { "Someone else saved a newer version of this file, so this one wasn’t saved." }
}

/* An upload refused only because a key change reached its file or folder while it went up: looked up again and sealed afresh. */
public struct SaveRekeyed: Error, Equatable {
    public init() {}
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

/*
 * What a result was made from. A folder counts with what was read from inside it
 * (`within`), since a result made from a folder carries its contents' marks as well
 * as the folder's name record. `fromLink`: saved from a link, signed as saved.
 */
public indirect enum SaveSource: Sendable, Equatable {
    case file(metadata: Integrity, version: Integrity, fromLink: Bool)
    case folder(metadata: Integrity, fromLink: Bool, within: [SaveSource])
}

/* A result's sources, or the person's own writing (ordinary statements). */
public enum SaveSources: Sendable, Equatable {
    case ownWriting
    case from([SaveSource])
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
 * The rows, in this process's own Application Support (never the app group: an
 * extension must not read the app's live run as interrupted, nor two processes
 * write one file), out of backups. A sign-out ends the account's journal
 * (`endAccount`, from AccountStore.wipe): the file goes, and a journal opened
 * before it writes nothing more.
 */
public final class SaveRunJournal: @unchecked Sendable {
    /* Which account session journals belong to: moved on by every sign-out. */
    final class Epoch: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        var current: Int { lock.withLock { value } }
        func end() { lock.withLock { value += 1 } }
    }
    static let account = Epoch()

    let url: URL
    let epoch: Epoch
    private let born: Int
    private let lock = NSLock()

    static var defaultURL: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("HushOS", isDirectory: true).appendingPathComponent("save-runs.json")
    }

    public init() {
        url = Self.defaultURL
        epoch = Self.account
        born = epoch.current
    }

    init(url: URL, epoch: Epoch = SaveRunJournal.account) {
        self.url = url
        self.epoch = epoch
        born = epoch.current
    }

    /* Sign-out, deletion, removal: the rows go, and no journal opened before writes again. */
    public static func endAccount() {
        account.end()
        try? FileManager.default.removeItem(at: defaultURL)
    }

    /* Whether this journal still belongs to the session it was opened in. */
    var live: Bool { born == epoch.current }

    public func list() -> [SaveRunRow] {
        lock.withLock { read() }
    }

    func put(_ row: SaveRunRow) {
        lock.withLock {
            guard live else { return }
            var rows = read().filter { $0.id != row.id }
            rows.append(row)
            write(rows)
        }
    }

    func remove(_ id: String) {
        lock.withLock {
            guard live else { return }
            write(read().filter { $0.id != id })
        }
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

/*
 * Whose space a destination is: the person's own Drive or their family's, with its
 * free bytes as the server checks them (nil when not known), or someone else's
 * share, whose owner's free space is never revealed.
 */
public enum SaveRoom: Sendable, Equatable {
    case own(Int64?)
    case family(Int64?)
    case shared
}

/* The server's answer for one item: in the Trash or deleted (`done`), not found, refused, or the space no longer this person's. */
public enum SaveItemFate: Sendable, Equatable { case done, gone, refused, denied }

/* What a run asks of the drive. The vault is one; tests stand one in. */
public protocol SaveRunWriter: Sendable {
    func gate(_ target: Opened) async -> SaveGate
    func room(_ workspaceId: String) async throws -> SaveRoom
    func names(in folder: Opened) async throws -> [String]
    func makeFolder(in folder: Opened, name: String, signing: Signing) async throws -> Opened
    func uploadResult(_ bytes: Data, name: String, mime: String?, in folder: Opened, replacing: Opened?, startedFrom: String?, thumbnail: Data?,
                      signing: (metadata: Signing, version: Signing), onBegun: @escaping @Sendable (Vault.BegunIds) -> Void) async throws -> Opened
    /* `file` as the server lists its folder now (its keys after a key change), or nil when it is no longer there. */
    func fresh(_ file: Opened, in folder: Opened) async throws -> Opened?
    /* `folder` and the chain above it as the server holds them now (a family's checked again first), to seal afresh under. */
    func refreshFolder(_ folder: Opened) async throws -> Opened
    /* One pause while an upload waits out a family folder's key change (KeyChangeWait). */
    func keyChangePause(_ workspaceId: String, attempt: Int) async throws
    /* Never `finishing`: an upload still completing is asked about again, then taken as finished. */
    func abortUpload(_ uploadId: String, in workspaceId: String) async -> DriveAPI.AbortFate
    /* Each item's fate; throws only when the request as a whole got no answer. */
    func trash(_ ids: [String], in workspaceId: String) async throws -> [String: SaveItemFate]
    func purge(_ ids: [String], in workspaceId: String) async throws -> [String: SaveItemFate]
    /* Whether the server lets this person delete forever there: a member (their own Drive, a family's folder). */
    func mayPurge(_ workspaceId: String) async -> Bool
}

/*
 * What a clean-up did with what the run made; `left` when it couldn't finish (no
 * answer, an item refused), and the row stays; `noAccess` when the space is no
 * longer the person's, and the row goes.
 */
public enum SaveCleanup: Sendable, Equatable { case deleted, trashed, nothing, left, noAccess }

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

/* Why a run stopped after it started, what its clean-up did, and how many new versions had landed and were kept. */
public struct SaveRunStopped: Error, Equatable, LocalizedError {
    public enum Reason: Sendable, Equatable { case cancelled, noRoom, failed, signedOut }
    public let reason: Reason
    public let message: String
    public let cleanup: SaveCleanup
    public var keptVersions = 0
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

    /* Runs live in this process, held weakly: a sign-out abandons them (abandonAll). */
    private static let liveLock = NSLock()
    nonisolated(unsafe) private static var live = NSHashTable<SaveRun>.weakObjects()
    static func register(_ run: SaveRun) { liveLock.withLock { live.add(run) } }

    /*
     * A sign-out (AccountStore.wipe, beside SaveRunJournal.endAccount): every run stops at once, writing
     * nothing more and deleting nothing afterwards (the session that could is ending).
     */
    public static func abandonAll() { abandonAll(SaveRunJournal.account) }

    /* The runs of one account session (its journals' epoch): a test's own session is never another's sign-out. */
    static func abandonAll(_ epoch: SaveRunJournal.Epoch) {
        let runs = liveLock.withLock { live.allObjects }.filter { $0.state.journal.epoch === epoch }
        for run in runs {
            run.state.abandon()
            Task { await run.abandon() }
        }
    }

    /* What a stopped run says: never "nothing was saved" once a new version landed (the web's stoppedWords). */
    static func words(_ reason: SaveRunStopped.Reason, shared: Bool, failure: String?, kept: Int) -> String {
        let opening: String
        switch reason {
        case .cancelled: opening = "Cancelled."
        case .noRoom: opening = shared ? "There isn’t enough room in this shared folder for this." : "There isn’t enough room for this."
        case .signedOut: opening = "You signed out before this was saved."
        case .failed: opening = (failure ?? "This couldn’t be saved.").trimmingCharacters(in: .whitespaces)
        }
        if kept == 0 { return reason == .failed && failure == nil ? failed : "\(opening) Nothing was saved." }
        let versions = kept == 1 ? "The new version saved before that was kept." : "The \(kept) new versions saved before that were kept."
        return "\(opening) \(versions) Nothing else was saved."
    }

    /*
     * What a result is signed with: record by record, the weakest of its sources' verdicts (the core's
     * weakestCopyPrior), a folder with everything read from inside it, a source saved from a link as
     * saved; or ordinary for the person's own writing.
     */
    public static func signing(_ sources: SaveSources) throws -> (metadata: Signing, version: Signing) {
        guard case .from(let list) = sources else { return (.own, .own) }
        var metadata: [Integrity] = []
        var version: [Integrity] = []
        func visit(_ each: [SaveSource]) {
            for source in each {
                switch source {
                case let .file(m, v, fromLink):
                    metadata.append(fromLink ? .savedFromLink : m)
                    version.append(fromLink ? .savedFromLink : v)
                case let .folder(m, fromLink, within):
                    metadata.append(fromLink ? .savedFromLink : m)
                    version.append(fromLink ? .savedFromLink : m)
                    visit(within)
                }
            }
        }
        visit(list)
        return (.copy(try weakestCopyPrior(priors: metadata)), .copy(try weakestCopyPrior(priors: version)))
    }

    /* Runs another launch left behind, for the next open to offer to delete or keep what they made. */
    public static func interrupted(_ journal: SaveRunJournal = SaveRunJournal()) -> [SaveRunRow] {
        journal.list().filter { $0.launch != launch }
    }

    /* Removes what an interrupted run made, as a cancel would have, then its row. */
    public static func cleanUp(_ row: SaveRunRow, writer: SaveRunWriter, journal: SaveRunJournal = SaveRunJournal()) async -> SaveCleanup {
        await clean(row, writer: writer, journal: journal, versions: []).cleanup
    }

    /* Keeps what an interrupted run made: its row goes, its open uploads aborted (without an answer, the row stays). */
    public static func keep(_ row: SaveRunRow, writer: SaveRunWriter, journal: SaveRunJournal = SaveRunJournal()) async -> Bool {
        for uploadId in row.uploadIds where await writer.abortUpload(uploadId, in: row.workspaceId) == .unknown { return false }
        journal.remove(row.id)
        return true
    }

    /* Aborts every upload the row names, removes its nodes; the row goes unless something is left. */
    static func clean(_ row: SaveRunRow, writer: SaveRunWriter, journal: SaveRunJournal, versions: Set<String>) async -> (cleanup: SaveCleanup, kept: Int) {
        var unsettled = false
        var denied = false
        var kept = 0
        for uploadId in row.uploadIds {
            switch await writer.abortUpload(uploadId, in: row.workspaceId) {
            case .unknown: unsettled = true
            case .denied: denied = true
            case .finished: if versions.contains(uploadId) { kept += 1 }
            default: break
            }
        }
        var cleanup = await discard(row.nodeIds, in: row.workspaceId, writer: writer)
        if unsettled { cleanup = .left } else if denied, cleanup == .nothing || cleanup == .noAccess { cleanup = .noAccess }
        if cleanup != .left { journal.remove(row.id) }
        return (cleanup, kept)
    }

    static func discard(_ ids: [String], in workspaceId: String, writer: SaveRunWriter) async -> SaveCleanup {
        guard !ids.isEmpty else { return .nothing }
        do {
            let trashed = try await writer.trash(ids, in: workspaceId)
            let fates = ids.map { trashed[$0] ?? .refused }
            if fates.allSatisfy({ $0 == .denied }) { return .noAccess }
            if fates.contains(where: { $0 == .refused || $0 == .denied }) { return .left }
            let inTrash = ids.filter { trashed[$0] == .done }
            if inTrash.isEmpty { return .nothing }
            guard await writer.mayPurge(workspaceId) else { return .trashed }
            let purged = try await writer.purge(inTrash, in: workspaceId)
            return inTrash.allSatisfy { purged[$0] == .done || purged[$0] == .gone } ? .deleted : .left
        } catch {
            return .left
        }
    }

    static func isNoRoom(_ error: Error) -> Bool {
        if case DriveAPIError.server(402, _) = error { return true }
        return false
    }
}

/*
 * A run's row, held under a lock so the upload's begin note lands at once (not
 * through a hop that a stop could overtake). Once sealed (the stop's clean-up,
 * or the run's finish) nothing more is written.
 */
final class RunState: @unchecked Sendable {
    private let lock = NSLock()
    private var row: SaveRunRow
    private var sealed = false
    private var abandonedHere = false
    private var settledUploads = Set<String>()
    private(set) var versionUploads = Set<String>()
    let journal: SaveRunJournal

    init(row: SaveRunRow, journal: SaveRunJournal) {
        self.row = row
        self.journal = journal
    }

    var snapshot: SaveRunRow { lock.withLock { row } }

    func change(_ body: (inout SaveRunRow) -> Void) {
        lock.withLock {
            guard !sealed else { return }
            body(&row)
            journal.put(row)
        }
    }

    /* Begin landed: its upload (and a new file's node) are in the row before anything is sent. */
    func begun(_ ids: Vault.BegunIds, tracked: Bool, version: Bool) {
        lock.withLock {
            guard !sealed, !settledUploads.contains(ids.uploadId) else { return }
            if version { versionUploads.insert(ids.uploadId) }
            if !row.uploadIds.contains(ids.uploadId) { row.uploadIds.append(ids.uploadId) }
            if tracked, !row.nodeIds.contains(ids.nodeId) { row.nodeIds.append(ids.nodeId) }
            journal.put(row)
        }
    }

    /* An upload is over: its id leaves the row; a new file that landed under another node is kept by that one. */
    func settled(_ ids: Vault.BegunIds?, landed: String?, tracked: Bool) {
        guard let ids else { return }
        lock.withLock {
            settledUploads.insert(ids.uploadId)
            guard !sealed else { return }
            row.uploadIds.removeAll { $0 == ids.uploadId }
            if tracked, let landed, landed != ids.nodeId {
                row.nodeIds.removeAll { $0 == ids.nodeId }
                if !row.nodeIds.contains(landed) { row.nodeIds.append(landed) }
            }
            journal.put(row)
        }
    }

    /* A sign-out: nothing is written, cleaned up or deleted for this run again. */
    func abandon() {
        lock.withLock {
            sealed = true
            abandonedHere = true
        }
    }
    var abandoned: Bool { lock.withLock { abandonedHere } }

    /* No write after this: the row as it stands, for the clean-up. */
    func seal() -> SaveRunRow {
        lock.withLock {
            sealed = true
            return row
        }
    }
}

public actor SaveRun {
    public nonisolated let id: String
    let writer: SaveRunWriter
    nonisolated let state: RunState
    let first: Opened
    /* Whether the destination is someone else's share: a 402 then says so without figures. */
    let shared: Bool
    let pause: (@Sendable (Int) async throws -> Void)?
    let now: @Sendable () -> Date
    var madeFolders = Set<String>()
    var claimed: [String: Set<String>] = [:]
    var thumbnails: Int
    var keptVersions = 0
    var stopped: SaveRunStopped?
    var stopping: Task<SaveRunStopped, Never>?
    var finished = false
    var inFlight = 0

    init(writer: SaveRunWriter, state: RunState, first: Opened, shared: Bool, thumbnails: Int,
         pause: (@Sendable (Int) async throws -> Void)?, now: @escaping @Sendable () -> Date) {
        self.id = state.snapshot.id
        self.writer = writer
        self.state = state
        self.first = first
        self.shared = shared
        self.thumbnails = thumbnails
        self.pause = pause
        self.now = now
    }

    /*
     * Starts a run writing into `targets` (folders for new files, files for new versions; one
     * workspace). Each result names its own sources. Throws SaveRefused before anything is made.
     */
    public static func start(writer: SaveRunWriter, targets: [Opened], results: [PlannedResult],
                             journal: SaveRunJournal = SaveRunJournal(),
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
        let room = try await writer.room(workspaceId)
        let free: Int64?
        switch room {
        case .own(let known), .family(let known): free = known
        case .shared: free = nil
        }
        if let free, Int64(clamping: needed) > free {
            throw SaveRefused(reason: .noRoom, message: SaveRuns.noRoom, needed: needed, free: max(0, free))
        }
        let row = SaveRunRow(id: UUID().uuidString.lowercased(), workspaceId: workspaceId, nodeIds: [], uploadIds: [], at: now(), launch: SaveRuns.launch)
        journal.put(row)
        let thumbnails = results.filter {
            switch $0 {
            case .known(_, let thumbnail), .fromSources(_, let thumbnail): return thumbnail
            }
        }.count
        let run = SaveRun(writer: writer, state: RunState(row: row, journal: journal), first: first, shared: room == .shared,
                          thumbnails: thumbnails, pause: pause, now: now)
        SaveRuns.register(run)
        return run
    }

    /* New work only while the run is open: one handed in during a stop is refused with it. */
    private func open() async throws {
        if let stopping { throw await stopping.value }
        if let stopped { throw stopped }
        if finished { throw SaveRunStopped(reason: .failed, message: "This save has finished.", cleanup: .nothing) }
    }

    private func takeThumbnail(_ thumbnail: Data?) throws -> Data? {
        guard let thumbnail, !thumbnail.isEmpty else { return nil }
        guard thumbnails > 0 else { throw SaveRunStopped(reason: .failed, message: "This result was planned without a thumbnail.", cleanup: .nothing) }
        thumbnails -= 1
        return thumbnail
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
    public func folder(_ name: String, in parent: Opened? = nil, sources: SaveSources) async throws -> Opened {
        try await open()
        let signing = try SaveRuns.signing(sources)
        let into = parent ?? first
        let given = try await claim(name, in: into)
        try await open()
        // A destination a key change is still walking takes the run: its folders wait it out as its uploads do,
        // the folder looked up again before each try.
        var parentNow = into
        var since: Date?
        var attempt = 0
        var made: Opened
        while true {
            do {
                made = try await writer.makeFolder(in: parentNow, name: given, signing: signing.metadata)
                break
            } catch where KeyChangeWait.meets(error, waited: since != nil) {
                if let stopping { throw await stopping.value }
                let start = since ?? now()
                since = start
                if now().timeIntervalSince(start) >= KeyChangeWait.giveUp { throw await stop(.failed, KeyChangeWait.gaveUp) }
                attempt += 1
                if let pause { try await pause(attempt) } else { try await writer.keyChangePause(into.node.workspaceId, attempt: attempt) }
                parentNow = try await writer.refreshFolder(parentNow)
            }
        }
        if let stopping {
            // Made while the run stopped: it goes the way the rest went, and if it cannot, a row names it: added to the
            // row the stop kept (its clean-up left things too), or a row of its own when the stop's went.
            let done = await stopping.value
            if !state.abandoned, await SaveRuns.discard([made.id], in: state.snapshot.workspaceId, writer: writer) == .left {
                var row = state.snapshot
                if done.cleanup == .left {
                    row.nodeIds.append(made.id)
                } else {
                    row.nodeIds = [made.id]
                    row.uploadIds = []
                }
                state.journal.put(row)
            }
            throw done
        }
        madeFolders.insert(made.id)
        claimed[made.id] = []
        if !madeFolders.contains(into.id) { state.change { $0.nodeIds.append(made.id) } }
        return made
    }

    /* A new file under the next free name in its folder; never replaces anything. */
    public func file(_ bytes: Data, name: String, mime: String?, sources: SaveSources, thumbnail: Data? = nil, in folder: Opened? = nil) async throws -> Opened {
        try await open()
        let signing = try SaveRuns.signing(sources)
        let thumb = try takeThumbnail(thumbnail)
        let into = folder ?? first
        let given = try await claim(name, in: into)
        try await open()
        return try await upload(bytes, name: given, mime: mime, in: into, replacing: nil, startedFrom: nil, thumbnail: thumb,
                                signing: signing, tracked: !madeFolders.contains(into.id))
    }

    /* A new version of `file` (in `folder`), unless someone else saved since the work started from `startedFrom`. */
    public func version(_ bytes: Data, of file: Opened, in folder: Opened, startedFrom: String?, sources: SaveSources,
                        mime: String? = nil, thumbnail: Data? = nil) async throws -> VersionSaved {
        try await open()
        let signing = try SaveRuns.signing(sources)
        let thumb = try takeThumbnail(thumbnail)
        do {
            return .saved(try await upload(bytes, name: file.name, mime: mime ?? file.metadata.mime, in: folder, replacing: file,
                                           startedFrom: startedFrom, thumbnail: thumb, signing: signing, tracked: false))
        } catch let stale as SaveStale {
            return .stale(currentVersionId: stale.currentVersionId)
        }
    }

    private func upload(_ bytes: Data, name: String, mime: String?, in folder: Opened, replacing given: Opened?, startedFrom: String?,
                        thumbnail: Data?, signing: (metadata: Signing, version: Signing), tracked: Bool) async throws -> Opened {
        inFlight += 1
        defer { inFlight -= 1 }
        var replacing = given
        var folderNow = folder
        var since: Date?
        var attempt = 0
        var rekeys = 0
        while true {
            let begun = BegunBox()
            let state = self.state
            let version = replacing != nil
            do {
                let landed = try await writer.uploadResult(bytes, name: name, mime: mime, in: folderNow, replacing: replacing, startedFrom: startedFrom,
                                                           thumbnail: thumbnail, signing: signing,
                                                           onBegun: { ids in begun.ids = ids; state.begun(ids, tracked: tracked, version: version) })
                state.settled(begun.ids, landed: landed.id, tracked: tracked)
                if version { keptVersions += 1 }
                if stopped != nil || stopping != nil {
                    // Landed while the run stopped or after: a new file goes the way the rest went.
                    let done: SaveRunStopped
                    if let stopping { done = await stopping.value } else { done = stopped! }
                    // Not after a sign-out: the session that could is ending, and nothing is deleted for it.
                    if tracked, !state.abandoned { _ = await SaveRuns.discard([landed.id], in: state.snapshot.workspaceId, writer: writer) }
                    throw done
                }
                return landed
            } catch let stale as SaveStale {
                state.settled(begun.ids, landed: nil, tracked: false)
                throw stale
            } catch let stopped as SaveRunStopped {
                throw stopped
            } catch {
                if let stopping { throw await stopping.value }
                let rekeyed = error is SaveRekeyed
                if rekeyed || KeyChangeWait.meets(error, waited: since != nil) {
                    // A key change reached the file or its folder: what this upload began is over, the file is looked
                    // up again (its keys as the server holds them now; startedFrom kept for the version check), and
                    // it is sealed afresh, after a pause when the change is still walking.
                    state.settled(begun.ids, landed: nil, tracked: false)
                    if rekeyed {
                        rekeys += 1
                        if rekeys > 3 { throw await stop(.failed, error.localizedDescription) }
                    } else {
                        let start = since ?? now()
                        since = start
                        if now().timeIntervalSince(start) >= KeyChangeWait.giveUp { throw await stop(.failed, KeyChangeWait.gaveUp) }
                        attempt += 1
                        if let pause { try await pause(attempt) } else { try await writer.keyChangePause(folderNow.node.workspaceId, attempt: attempt) }
                    }
                    // The destination and the chain above it as the server holds them now (a family's checked again
                    // first), and the file replaced, so nothing is sealed again under keys the change replaced.
                    folderNow = try await writer.refreshFolder(folderNow)
                    if let file = replacing {
                        guard let fresh = try await writer.fresh(file, in: folderNow) else { throw SaveStale(currentVersionId: nil) }
                        replacing = fresh
                    }
                    continue
                }
                // Kept in the row: the stop aborts its upload and removes its node, whatever got that far.
                if let ids = begun.ids { state.begun(ids, tracked: tracked, version: version) }
                let noRoom = SaveRuns.isNoRoom(error)
                throw await stop(noRoom ? .noRoom : .failed, noRoom ? nil : error.localizedDescription)
            }
        }
    }

    /* Stops the run once: every caller, concurrent ones included, gets the same outcome. */
    @discardableResult
    private func stop(_ reason: SaveRunStopped.Reason, _ failure: String? = nil) async -> SaveRunStopped {
        if let stopped { return stopped }
        if let stopping { return await stopping.value }
        if state.abandoned { abandon(); return stopped! }
        let writer = self.writer
        let state = self.state
        let shared = self.shared
        let keptBefore = keptVersions
        let task = Task<SaveRunStopped, Never> {
            let row = state.seal()
            let (cleanup, kept) = await SaveRuns.clean(row, writer: writer, journal: state.journal, versions: state.versionUploads)
            let total = keptBefore + kept
            var done = SaveRunStopped(reason: reason, message: SaveRuns.words(reason, shared: shared, failure: failure, kept: total), cleanup: cleanup)
            done.keptVersions = total
            return done
        }
        stopping = task
        let done = await task.value
        stopped = done
        return done
    }

    /* Every result is in: the row goes. Refused while one is still on its way, or once stopped. */
    public func finish() async throws {
        if let stopping { throw await stopping.value }
        if let stopped { throw stopped }
        guard inFlight == 0 else { throw SaveRunStopped(reason: .failed, message: "Some results are still being saved.", cleanup: .nothing) }
        finished = true
        let row = state.seal()
        state.journal.remove(row.id)
    }

    /*
     * Stops the run and removes the new files and folders it made (the caller cancels the task saving a
     * result; one that lands afterwards is removed as it lands). A new version that landed is kept.
     */
    public func cancel() async -> SaveRunStopped {
        if finished {
            var done = SaveRunStopped(reason: .cancelled, message: SaveRuns.cancelled, cleanup: .nothing)
            done.keptVersions = keptVersions
            return done
        }
        return await stop(.cancelled)
    }

    /* A sign-out: the run stops writing at once, asking nothing of the server (the session is ending). */
    public func abandon() {
        guard stopped == nil else { return }
        state.abandon()
        var done = SaveRunStopped(reason: .signedOut, message: SaveRuns.words(.signedOut, shared: shared, failure: nil, kept: keptVersions), cleanup: .left)
        done.keptVersions = keptVersions
        stopped = done
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

    /*
     * The account's own Drive, a family folder, or a share. Free bytes as the server checks a begin
     * (packages/db/src/pool.ts): on an own allowance `availableBytes`; in a family's pool, the server's
     * own figure for the person's files (`own.freeBytes`, the web's roomOf; an older server without it
     * leaves the shown one, never more than there is); a family folder is whole GiB on both sides.
     */
    public func room(_ workspaceId: String) async throws -> SaveRoom {
        let id = workspaceId.lowercased()
        let group = familyAreaGroup[id]
        let storage = try? await Auth.storage()
        guard let storage else { return group != nil ? .family(nil) : (try await ownWorkspace(id) ? .own(nil) : .shared) }
        if id == storage.workspaceId.lowercased() {
            guard storage.pool != nil, let free = storage.ownFreeBytes.flatMap(Int64.init) else { return .own(storage.free) }
            return .own(max(0, free))
        }
        guard let group else { return .shared }
        if let pool = storage.pool, pool.groupId.lowercased() == group.lowercased() { return .family(storage.free) }
        return .family(nil)
    }

    private func ownWorkspace(_ id: String) async throws -> Bool {
        (try? await loadWorkspace().workspaceId.lowercased()) == id
    }

    public func names(in folder: Opened) async throws -> [String] {
        try await children(of: folder.id, in: folder.node.workspaceId).map(\.name)
    }

    public func makeFolder(in folder: Opened, name: String, signing: Signing) async throws -> Opened {
        try await createFolder(in: folder.id, name: name, signing: signing)
    }

    public func uploadResult(_ bytes: Data, name: String, mime: String?, in folder: Opened, replacing: Opened?, startedFrom: String?, thumbnail: Data?,
                             signing: (metadata: Signing, version: Signing), onBegun: @escaping @Sendable (BegunIds) -> Void) async throws -> Opened {
        try await uploadResult(bytes, name: name, mime: mime, in: folder.id, replacing: replacing, startedFrom: startedFrom, thumbnail: thumbnail,
                               signing: signing, onBegun: onBegun)
    }

    /* From the server itself, never the catalogue (which may not have heard of a key change or another device's save yet). */
    public func fresh(_ file: Opened, in folder: Opened) async throws -> Opened? {
        let listing = try await listChildren(of: folder.id, in: folder.node.workspaceId)
        guard let row = listing.children.first(where: { $0.id == file.id }) else { return nil }
        return try open(row, replacing: true)
    }

    public func refreshFolder(_ folder: Opened) async throws -> Opened {
        let workspaceId = folder.node.workspaceId
        if isFamilyWorkspace(workspaceId) { await familyJudge?.recheck(workspaceId) }
        // The listing opens the folder and everything above it again, as the server holds them now (openChain).
        let listing = try await listChildren(of: folder.id, in: workspaceId)
        return try open(listing.folder, replacing: true)
    }

    public func keyChangePause(_ workspaceId: String, attempt: Int) async throws {
        try await Task.sleep(for: .seconds(KeyChangeWait.delay(attempt)))
        await familyJudge?.recheck(workspaceId)
    }

    /* An upload still finishing is asked about again for about ten seconds, then taken as finished: it lands. */
    public func abortUpload(_ uploadId: String, in workspaceId: String) async -> DriveAPI.AbortFate {
        for asked in 1 ... 5 {
            let fate = await api.abortUploadFate(uploadId: uploadId, workspaceId: workspaceId)
            guard fate == .finishing else { return fate }
            if asked < 5 { try? await Task.sleep(for: .seconds(2)) }
        }
        return .finished
    }

    public func trash(_ ids: [String], in workspaceId: String) async throws -> [String: SaveItemFate] {
        var fates: [String: SaveItemFate] = [:]
        for start in stride(from: 0, to: ids.count, by: TrashBatch.maxBatch) {
            let batch = Array(ids[start ..< min(ids.count, start + TrashBatch.maxBatch)])
            let answers: [TrashBatch.Answer]
            do {
                answers = try await api.trashBatch(workspaceId: workspaceId, ids: batch)
            } catch DriveAPIError.notFound, DriveAPIError.forbidden {
                for id in batch { fates[id] = .denied }
                continue
            }
            for answer in answers {
                switch answer {
                case .trashed, .covered: fates[answer.id] = .done
                case let .refused(id, reason, _): fates[id] = reason == "trashed" ? .done : reason == "not-found" ? .gone : .refused
                case .restored: fates[answer.id] = .refused
                }
            }
        }
        return fates
    }

    public func purge(_ ids: [String], in workspaceId: String) async throws -> [String: SaveItemFate] {
        var fates: [String: SaveItemFate] = [:]
        for id in ids {
            do {
                try await api.purge(nodeId: id, workspaceId: workspaceId)
                remove(id, in: workspaceId)
                fates[id] = .done
            } catch DriveAPIError.notFound {
                fates[id] = .gone
            } catch DriveAPIError.forbidden {
                fates[id] = .denied
            } catch DriveAPIError.transport(let why) {
                throw DriveAPIError.transport(why)
            } catch {
                fates[id] = .refused
            }
        }
        return fates
    }

    public func mayPurge(_ workspaceId: String) async -> Bool {
        let id = workspaceId.lowercased()
        if isFamilyWorkspace(id) { return true }
        return (try? await loadWorkspace().workspaceId.lowercased()) == id
    }
}
