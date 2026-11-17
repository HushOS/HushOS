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
    /* The upload whose reservation the abort didn't confirm released: the run keeps its id until one does. */
    public var unreleased: String?
    public init(currentVersionId: String?, unreleased: String? = nil) {
        self.currentVersionId = currentVersionId
        self.unreleased = unreleased
    }
    public var errorDescription: String? { "Someone else saved a newer version of this file, so this one wasn’t saved." }
}

/* An upload refused only because a key change reached its file or folder while it went up: looked up again and sealed afresh. */
public struct SaveRekeyed: Error, Equatable {
    /* As SaveStale's. */
    public var unreleased: String?
    public init(unreleased: String? = nil) { self.unreleased = unreleased }
}

/* The id of a folder whose creation was sent, set from its minted closure. */
final class SentFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var held: String?
    var id: String? {
        get { lock.withLock { held } }
        set { lock.withLock { held = newValue } }
    }
}

/* Ids collected across an await (the clean-up's not-found ones). */
final class SentIds: @unchecked Sendable {
    private let lock = NSLock()
    private var held = Set<String>()
    var ids: Set<String> { lock.withLock { held } }
    func add(_ more: [String]) { lock.withLock { held.formUnion(more) } }
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
    /* The run finished (or its results were kept, or cleaned up) but its row couldn't be removed: never offered, dropped next. */
    public var done: Bool?
    /*
     * Folders whose creation was sent (written with the id, before it went) and not known answered, with when: one a
     * clean-up doesn't find may still be made, so the row stays until a later look finds it or the creation window
     * (SaveRuns.creationWindow) has passed.
     */
    public var uncertain: [String: Date]?
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
    /*
     * Whose rows these are (apps/ios/AGENTS.md, one account at a time): written with every row, and rows another
     * account wrote are dropped unread, so a sign-in through the Files sheet while the app was stopped never hands the
     * last account's runs to the next one's clean-up.
     */
    let owner: AccountOwner?
    /* Who is signed in now, asked before every read and write. */
    private let signedIn: @Sendable () -> SignedInAnswer
    private let born: Int
    /* One lock per file, shared by every journal on it: two runs starting at once never lose each other's row. */
    private let lock: NSLock
    private static let locksLock = NSLock()
    nonisolated(unsafe) private static var locks: [String: NSLock] = [:]
    static func lock(for url: URL) -> NSLock {
        locksLock.withLock {
            let path = url.standardizedFileURL.path
            if let held = locks[path] { return held }
            let made = NSLock()
            locks[path] = made
            return made
        }
    }

    static var defaultURL: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("HushOS", isDirectory: true).appendingPathComponent("save-runs.json")
    }

    public init(owner: AccountOwner? = AccountOwner.signedIn, signedIn: @escaping @Sendable () -> SignedInAnswer = { AccountOwner.signedInAnswer }) {
        url = Self.defaultURL
        epoch = Self.account
        self.owner = owner
        self.signedIn = signedIn
        born = epoch.current
        lock = Self.lock(for: url)
        lock.withLock { Self.dropStaging(url) }
    }

    /* Tests: its own file, and by default an account of its own that stays signed in. */
    init(url: URL, epoch: Epoch = SaveRunJournal.account, owner: AccountOwner? = AccountOwner(userId: "tests", origin: "https://drive.test"),
         signedIn: (@Sendable () -> SignedInAnswer)? = nil) {
        self.url = url
        self.epoch = epoch
        self.owner = owner
        self.signedIn = signedIn ?? { .account(owner) }
        born = epoch.current
        lock = Self.lock(for: url)
        lock.withLock { Self.dropStaging(url) }
    }

    /* The file a write stages its rows in before renaming it over the journal. */
    static func staging(_ url: URL) -> URL { url.appendingPathExtension("next") }
    /* A staging file a write left (it failed, or the process died mid-write) never outlives it. */
    private static func dropStaging(_ url: URL) { try? FileManager.default.removeItem(at: staging(url)) }

    /* Sign-out, deletion, removal: the rows go, a staging file with them, and no journal opened before writes again. */
    public static func endAccount() {
        account.end()
        lock(for: defaultURL).withLock {
            try? FileManager.default.removeItem(at: defaultURL)
            dropStaging(defaultURL)
        }
    }

    /* Whether this journal still belongs to the session it was opened in. */
    var live: Bool { born == epoch.current }

    /* Tests only: runs before each write with the rows it would write, and a throw refuses it as a full disk would. */
    var fault: (@Sendable ([SaveRunRow]) throws -> Void)?

    /* Every row, those of finished runs (`done`) included. */
    public func list() -> [SaveRunRow] {
        lock.withLock { read() }
    }

    /*
     * Writes the row, once more if the first write is refused (rows are whole), and throws
     * SaveUnrecorded when that one is too: the run then stops, publishing nothing it doesn't name.
     * After a sign-out it writes nothing and throws nothing (the run is abandoned).
     */
    func put(_ row: SaveRunRow) throws {
        try lock.withLock {
            guard live else { return }
            var rows = read().filter { $0.id != row.id }
            rows.append(row)
            do { try write(rows) } catch {
                do { try write(rows) } catch { throw SaveUnrecorded() }
            }
            // Signed out while it was written (endAccount doesn't wait for this lock): the row goes again.
            if !live { try? write(read().filter { $0.id != row.id }) }
        }
    }

    /*
     * A run's row goes: removed, asked again once; if the disk still refuses, marked `done` so no open offers
     * what a finished run made for deletion (and the next open drops it). False when neither was written: the
     * row stays as it was, and the caller says so rather than call it retired.
     */
    @discardableResult
    func retire(_ row: SaveRunRow) -> Bool {
        lock.withLock {
            guard live else { return true }
            let others = read().filter { $0.id != row.id }
            if (try? write(others)) != nil || (try? write(others)) != nil { return true }
            var done = row
            done.done = true
            return (try? write(others + [done])) != nil || (try? write(others + [done])) != nil
        }
    }

    /* Rows of finished runs that couldn't be removed then, removed now. */
    func dropDone() {
        lock.withLock {
            guard live else { return }
            let rows = read()
            if rows.contains(where: { $0.done == true }) { try? write(rows.filter { $0.done != true }) }
        }
    }

    /* The rows on disk with their owner. */
    private struct Stored: Codable {
        let owner: AccountOwner?
        let rows: [SaveRunRow]
    }

    /*
     * Whether this journal's account is the one signed in now: with nobody signed in (the same account may sign back
     * in), or another, it reads nothing, writes nothing and deletes nothing.
     */
    private var signedInHere: Bool {
        guard let owner else { return false }
        switch signedIn() {
        case .account(let now): return now == owner
        // A keychain read that failed is no sign-out: a journal opened signed in stays its account's.
        case .unreadable: return true
        }
    }

    /* Not this account's journal now: a write is refused (a run stops rather than publish what no row names). */
    struct NotSignedIn: Error {}

    /*
     * This journal's account's rows. Another account's (or an unowned file's) are dropped unread, and only when this
     * account is the one signed in (AccountOwner's rule: nobody signed in waits, another account drops).
     */
    private func read() -> [SaveRunRow] {
        guard signedInHere, let data = try? Data(contentsOf: url) else { return [] }
        guard let stored = try? JSONDecoder().decode(Stored.self, from: data), stored.owner == owner else {
            try? FileManager.default.removeItem(at: url)
            return []
        }
        return stored.rows
    }

    /*
     * On disk before it returns, through a power loss too: the rows go to a file beside the journal, flushed,
     * renamed over it, and the folder flushed so the rename holds (the web's strict durability).
     */
    private func write(_ rows: [SaveRunRow]) throws {
        // Two accounts' journals in one process never write over each other's rows.
        guard signedInHere else { throw NotSignedIn() }
        try fault?(rows)
        let folder = url.deletingLastPathComponent()
        if rows.isEmpty {
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            Self.flush(folder: folder)
            return
        }
        Unbacked.folder(folder)
        let next = Self.staging(url)
        guard FileManager.default.createFile(atPath: next.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
        do {
            let handle = try FileHandle(forWritingTo: next)
            do {
                try handle.write(contentsOf: try JSONEncoder().encode(Stored(owner: owner, rows: rows)))
                // To stable storage: fsync alone leaves it in the drive's cache on Apple platforms (F_FULLFSYNC).
                if fcntl(handle.fileDescriptor, F_FULLFSYNC) == -1 { try handle.synchronize() }
                try handle.close()
            } catch {
                try? handle.close()
                throw error
            }
            guard rename(next.path, url.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
        } catch {
            // A write that failed leaves no staging file behind.
            Self.dropStaging(url)
            throw error
        }
        Self.flush(folder: folder)
    }

    private static func flush(folder: URL) {
        let descriptor = open(folder.path, O_RDONLY)
        guard descriptor >= 0 else { return }
        if fcntl(descriptor, F_FULLFSYNC) == -1 { fsync(descriptor) }
        close(descriptor)
    }
}

/* A finished run (or kept results) whose record this device would not update: not retired, and asking again may. */
public struct SaveRecordNotUpdated: Error, Equatable, LocalizedError {
    public init() {}
    public var errorDescription: String? { "This was saved, but this device couldn’t update its record of it. Try again." }
}

/* Work a run can't take (it finished, or a result it wasn't planned for): nothing was sent and nothing cleaned up. */
public struct SaveRunRefusal: Error, Equatable, LocalizedError {
    public let message: String
    public var errorDescription: String? { message }
}

/* This device would not keep a run's record (its storage full): the run stops rather than publish what no row names. */
public struct SaveUnrecorded: Error, Equatable, LocalizedError {
    public init() {}
    public var errorDescription: String? { SaveRuns.unrecorded }
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
    /* `minted` hears the folder's id before its creation is sent (the run records it first); a throw sends nothing. */
    func makeFolder(in folder: Opened, name: String, signing: Signing, minted: @escaping @Sendable (String) throws -> Void) async throws -> Opened
    func uploadResult(_ bytes: Data, name: String, mime: String?, in folder: Opened, replacing: Opened?, startedFrom: String?, thumbnail: Data?,
                      signing: (metadata: Signing, version: Signing), onBegun: @escaping @Sendable (Vault.BegunIds) throws -> Void,
                      onCompleting: @escaping @Sendable (String) throws -> Void) async throws -> Opened
    /* `file` as the server lists its folder now (its keys after a key change), or nil when it is no longer there. */
    func fresh(_ file: Opened, in folder: Opened) async throws -> Opened?
    /* `id` as the server lists it in `folder` now, or nil: a creation answered 409 for its own id. */
    func listed(_ id: String, in folder: Opened) async throws -> Opened?
    /* `folder` and the chain above it as the server holds them now (a family's checked again first), to seal afresh under. */
    func refreshFolder(_ folder: Opened) async throws -> Opened
    /* One pause while an upload waits out a family folder's key change (KeyChangeWait). */
    func keyChangePause(_ workspaceId: String, attempt: Int) async throws
    /* Never `finishing`: an upload still completing is asked about again, then `unknown` (it may land yet). */
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

/*
 * Why a run stopped after it started, what its clean-up did, how many new versions had landed and were
 * kept, and how many may have (no answer to their abort, or still finishing: they may land yet).
 */
public struct SaveRunStopped: Error, Equatable, LocalizedError {
    public enum Reason: Sendable, Equatable { case cancelled, noRoom, failed, signedOut }
    public let reason: Reason
    public let message: String
    public let cleanup: SaveCleanup
    public var keptVersions = 0
    public var uncertainVersions = 0
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
    public static let unrecorded = "This device couldn’t keep a record of this save."

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

    /* What a stopped run says: never "nothing was saved" once a new version landed, or while one may (the web's stoppedWords). */
    static func words(_ reason: SaveRunStopped.Reason, shared: Bool, failure: String?, kept: Int, uncertain: Int = 0,
                      remains: SaveCleanup? = nil) -> String {
        // New files or folders that may still be there: the row kept for the next launch (`left`), or out of reach.
        // `.nothing` here: after a sign-out, what may stay with nothing more to ask.
        let left = remains == .left ? " Some of what was made may still be there. You’ll be asked about it next time."
            : remains == .noAccess ? " Some of what was made may still be there, and you can no longer remove it."
            : remains == .nothing ? " Some of what was made may still be there." : ""
        let opening: String
        switch reason {
        case .cancelled: opening = "Cancelled."
        case .noRoom: opening = shared ? "There isn’t enough room in this shared folder for this." : "There isn’t enough room for this."
        case .signedOut: opening = "You signed out before this was saved."
        case .failed: opening = sentence(failure ?? "This couldn’t be saved.")
        }
        if kept == 0, uncertain == 0, left.isEmpty { return reason == .failed && failure == nil ? failed : "\(opening) Nothing was saved." }
        let versions = kept == 0 ? "" : kept == 1 ? " The new version saved before that was kept." : " The \(kept) new versions saved before that were kept."
        let maybe = uncertain == 0 ? ""
            : uncertain == 1 ? " \(kept == 0 ? "A" : "Another") new version may have been saved."
            : " \(uncertain) \(kept == 0 ? "" : "other ")new versions may have been saved."
        return "\(opening)\(versions)\(maybe)\(left.isEmpty ? " Nothing else was saved." : left)"
    }

    /* A reason as a sentence: trimmed, and ended with a full stop when it has none. */
    static func sentence(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = trimmed.last else { return trimmed }
        return ".!?…".contains(last) ? trimmed : trimmed + "."
    }

    static let alreadySaved = "This was already saved, so it was kept."

    static func signedOut() -> SaveRunStopped {
        SaveRunStopped(reason: .signedOut, message: words(.signedOut, shared: false, failure: nil, kept: 0), cleanup: .nothing)
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
        // A finished run whose row couldn't be removed is never offered, and goes now.
        journal.dropDone()
        var offered: [SaveRunRow] = []
        for row in journal.list() where row.launch != launch && row.done != true {
            // Nothing made to ask about: one with no uploads either goes; one with reservations to let go is settled
            // quietly (settleUploads), never offered.
            if row.nodeIds.isEmpty {
                if row.uploadIds.isEmpty { journal.retire(row) }
                continue
            }
            offered.append(row)
        }
        return offered
    }

    /*
     * Rows another launch left with nothing made, only reservations to let go (a finished run's stale version, or a
     * version run that ended mid-upload): each aborted, and the row goes once none is left without an answer.
     */
    public static func settleUploads(writer: SaveRunWriter, journal: SaveRunJournal = SaveRunJournal()) async {
        await settleUploads(writer: writer, journal: journal, launch: launch)
    }

    static func settleUploads(writer: SaveRunWriter, journal: SaveRunJournal, launch: String) async {
        for row in journal.list() where row.launch != launch && row.done != true && row.nodeIds.isEmpty && !row.uploadIds.isEmpty {
            var left: [String] = []
            for uploadId in row.uploadIds {
                if await writer.abortUpload(uploadId, in: row.workspaceId) == .unknown { left.append(uploadId) }
            }
            if left.isEmpty { journal.retire(row) } else if left.count < row.uploadIds.count {
                var next = row
                next.uploadIds = left
                try? journal.put(next)
            }
        }
    }

    /*
     * How long a folder creation that got no answer may still be made: the server's own upload window (packages/drive
     * UPLOAD_TTL_HOURS). Within it, a clean-up that doesn't find the folder keeps the row; past it, one still not there
     * was never made.
     */
    public static let creationWindow: TimeInterval = 24 * 60 * 60

    /*
     * Removes what an interrupted run made, as a cancel would have, then its row. A folder the row still holds
     * uncertain, not found, may still be made: the row stays until a later open finds it or creationWindow has passed.
     */
    public static func cleanUp(_ row: SaveRunRow, writer: SaveRunWriter, journal: SaveRunJournal = SaveRunJournal(),
                               now: Date = Date()) async -> SaveCleanup {
        let mayExist = Set((row.uncertain ?? [:]).filter { now.timeIntervalSince($0.value) < creationWindow }.keys)
        return await clean(row, writer: writer, journal: journal, versions: [], completing: nil, published: nil, mayExist: mayExist).cleanup
    }

    /*
     * Keeps what an interrupted run made: its row always goes. Its open uploads are still asked to abort;
     * one with no answer (offline, an older server) is left to the server, which lets an open upload go
     * once it expires, and one still finishing lands and is kept, as asked.
     */
    public static func keep(_ row: SaveRunRow, writer: SaveRunWriter, journal: SaveRunJournal = SaveRunJournal()) async throws {
        for uploadId in row.uploadIds { _ = await writer.abortUpload(uploadId, in: row.workspaceId) }
        // The disk refusing to let it go: still offered, and Keep may be asked again.
        guard journal.retire(row) else { throw SaveRecordNotUpdated() }
    }

    /* Aborts every upload the row names, removes its nodes; the row goes unless something is left. */
    /*
     * `completing`: the uploads whose completion was sent (nil for an interrupted run: any may have been); only those
     * can land after an abort that got no answer. `remains`: new files or folders that may still be there.
     */
    static func clean(_ row: SaveRunRow, writer: SaveRunWriter, journal: SaveRunJournal, versions: Set<String>,
                      completing: Set<String>?, published: Set<String>?, asked: [String: DriveAPI.AbortFate] = [:],
                      mayExist: Set<String> = []) async -> (cleanup: SaveCleanup, kept: Int, uncertain: Int, remains: SaveCleanup?) {
        var unsettled = false
        var denied = false
        var kept = 0
        var uncertain = 0
        var othersMayLand = false
        for uploadId in row.uploadIds {
            let answered = asked[uploadId].flatMap { $0 == .unknown || $0 == .finishing ? nil : $0 }
            let fate: DriveAPI.AbortFate
            if let answered { fate = answered } else { fate = await writer.abortUpload(uploadId, in: row.workspaceId) }
            switch fate {
            case .unknown, .finishing:
                // No answer: once its completion was sent it may land yet, and a new version is never said not to have.
                unsettled = true
                guard completing?.contains(uploadId) ?? true else { break }
                if versions.contains(uploadId) { uncertain += 1 } else { othersMayLand = true }
            case .denied:
                // No longer this person's to ask: once its completion was sent it may have landed.
                denied = true
                guard completing?.contains(uploadId) ?? true else { break }
                if versions.contains(uploadId) { uncertain += 1 } else { othersMayLand = true }
            case .finished: if versions.contains(uploadId) { kept += 1 }
            case .gone where versions.contains(uploadId) && (completing?.contains(uploadId) ?? false):
                // A version whose completion was sent, and the upload not found: the share may have ended (a 404 for
                // lost access), not the upload gone. It may have landed.
                unsettled = true
                uncertain += 1
            default: break
            }
        }
        let notFound = SentIds()
        let discarded = await discard(row.nodeIds, in: row.workspaceId, writer: writer, notFound: notFound)
        // A folder whose creation got no answer, not found now: the server may still be making it. The row stays.
        if !mayExist.isDisjoint(with: notFound.ids) {
            unsettled = true
            othersMayLand = true
        }
        var cleanup = discarded
        if unsettled { cleanup = .left } else if denied, cleanup == .nothing || cleanup == .noAccess { cleanup = .noAccess }
        // Not removed: only what was sent to be published may still be there.
        let unremoved = (discarded == .left || discarded == .noAccess) && row.nodeIds.contains { published?.contains($0) ?? true }
        let someRemain = othersMayLand || unremoved
        // A row the disk won't retire stays as it was: the clean-up is left for the next open.
        if cleanup != .left, !journal.retire(row) { cleanup = .left }
        return (cleanup, kept, uncertain, someRemain ? (cleanup == .left ? .left : .noAccess) : nil)
    }

    static func discard(_ ids: [String], in workspaceId: String, writer: SaveRunWriter, notFound: SentIds? = nil) async -> SaveCleanup {
        guard !ids.isEmpty else { return .nothing }
        do {
            let trashed = try await writer.trash(ids, in: workspaceId)
            notFound?.add(ids.filter { trashed[$0] == .gone })
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

    /*
     * A creation that may have been made: no answer (no network, a timeout, a 5xx, cancelled on its way), or a plain 409
     * (the server's `conflict`, its id already there: minted here, so only an earlier send of the same request made it,
     * one URLSession may send again by itself when a reused connection drops). Any other refusal the server explained
     * (a 4xx) settles that it wasn't.
     */
    /* A creation refused with a plain 409: its id (minted here) already there, as the server's `conflict` says. */
    static func ownIdTaken(_ error: Error) -> Bool {
        if case DriveAPIError.server(409, _) = error { return true }
        return false
    }

    static func noAnswer(_ error: Error) -> Bool {
        switch error {
        case DriveAPIError.server(let status, _): return status == 0 || status >= 500 || status == 409
        case DriveAPIError.notAuthenticated, DriveAPIError.notFound, DriveAPIError.trashed, DriveAPIError.rotating, DriveAPIError.stale,
             DriveAPIError.conflicted, DriveAPIError.forbidden: return false
        default: return true
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
    /* Uploads whose completion was sent: only these can land after a stop that got no answer. */
    private var completingHere = Set<String>()
    /* Nodes whose publication was sent (a folder's creation, a file's completion) or that landed. */
    private var publishedHere = Set<String>()
    /* New files' nodes, by their upload: what a completion publishes. */
    private var nodeOfUpload: [String: String] = [:]
    /* After a stop: what landed or was made too late to go with it and then couldn't be removed. */
    private var lateRow: SaveRunRow?
    let journal: SaveRunJournal

    init(row: SaveRunRow, journal: SaveRunJournal) {
        self.row = row
        self.journal = journal
    }

    var snapshot: SaveRunRow { lock.withLock { row } }

    /* Begin landed: its upload (and a new file's node) are in the row, on disk, before anything is sent. */
    func begun(_ ids: Vault.BegunIds, tracked: Bool, version: Bool) throws {
        try lock.withLock {
            guard !settledUploads.contains(ids.uploadId) else { return }
            // Begun after the run stopped (or its account signed out): nothing is sent, the vault aborts it.
            guard !sealed else { throw CancellationError() }
            nodeOfUpload[ids.uploadId] = ids.nodeId
            if version { versionUploads.insert(ids.uploadId) }
            if !row.uploadIds.contains(ids.uploadId) { row.uploadIds.append(ids.uploadId) }
            if tracked, !row.nodeIds.contains(ids.nodeId) { row.nodeIds.append(ids.nodeId) }
            try journal.put(row)
        }
    }

    /*
     * Folder creations sent and not yet answered: a stop's clean-up waits for them. Counted in the same locked turn
     * that checks `sealed` and records the id (recordFolder, sending), so a stop either refuses the creation or sees it.
     */
    private var creatingHere = 0
    /* Folders whose creation got no answer: one the clean-up doesn't find may still be made, so its row stays. */
    private var mayExistHere = Set<String>()
    /* A creation's answer came, or none will: one with none may still be made. */
    func creationEnded(_ id: String, mayExist: Bool) {
        lock.withLock {
            if mayExist { mayExistHere.insert(id) }
            creatingHere -= 1
        }
    }
    var mayExist: Set<String> { lock.withLock { mayExistHere } }
    /*
     * A creation answered (made, or refused with a reason): no longer uncertain in the row, written while the run may
     * still write (after a stop sealed it the mark stays, which only keeps a row a little longer than it needs).
     */
    func answered(_ id: String) {
        lock.withLock {
            guard row.uncertain?.removeValue(forKey: id) != nil, !sealed else { return }
            try? journal.put(row)
        }
    }
    /*
     * An upload whose completion was refused and whose abort didn't confirm the reservation released: its id stays in
     * the row (asked again by a stop, by finish, or by the next open), and it can no longer land.
     */
    func keepUnreleased(_ uploadId: String) {
        lock.withLock {
            settledUploads.insert(uploadId)
            completingHere.remove(uploadId)
        }
    }
    func creationsSettled() async {
        while lock.withLock({ creatingHere }) > 0 { try? await Task.sleep(for: .milliseconds(5)) }
    }

    /* A completion is about to be sent; once the run stopped it is not sent (the vault aborts the upload). */
    func completing(_ uploadId: String) throws {
        try lock.withLock {
            guard !sealed else { throw CancellationError() }
            completingHere.insert(uploadId)
            if let node = nodeOfUpload[uploadId] { publishedHere.insert(node) }
        }
    }
    var completingUploads: Set<String> { lock.withLock { completingHere } }
    var published: Set<String> { lock.withLock { publishedHere } }

    /* Uncertain new versions and whether new nodes may stay, from what was sent: what a sign-out leaves. */
    func leftBehind(versions: Set<String>) -> (uncertain: Int, stays: Bool) {
        lock.withLock {
            let uncertain = completingHere.filter { versions.contains($0) && row.uploadIds.contains($0) }.count
            return (uncertain, row.nodeIds.contains { publishedHere.contains($0) })
        }
    }
    var nodeCount: Int { lock.withLock { row.nodeIds.count } }

    /*
     * A new folder's id, minted and on disk before its creation is sent; a run stopping (sealed) or a refused write
     * throws, and the creation is not sent.
     */
    func recordFolder(_ id: String, at: Date = Date()) throws {
        try lock.withLock {
            guard !sealed else { throw CancellationError() }
            row.nodeIds.append(id)
            // Uncertain until answered: an open after a crash finds it so.
            row.uncertain = (row.uncertain ?? [:]).merging([id: at]) { _, new in new }
            try journal.put(row)
            publishedHere.insert(id)
            creatingHere += 1
        }
    }

    /* A folder inside one the run made: no row of its own, but its creation is about to be sent. */
    func sending(_ id: String) throws {
        try lock.withLock {
            guard !sealed else { throw CancellationError() }
            publishedHere.insert(id)
            creatingHere += 1
        }
    }

    /* An upload is over: its id leaves the row; a new file that landed under another node is kept by that one. */
    func settled(_ ids: Vault.BegunIds?, landed: String?, tracked: Bool) throws {
        guard let ids else { return }
        try lock.withLock {
            settledUploads.insert(ids.uploadId)
            if let landed { publishedHere.insert(landed) }
            guard !sealed else { return }
            row.uploadIds.removeAll { $0 == ids.uploadId }
            if tracked, let landed, landed != ids.nodeId {
                row.nodeIds.removeAll { $0 == ids.nodeId }
                if !row.nodeIds.contains(landed) { row.nodeIds.append(landed) }
            }
            try journal.put(row)
        }
    }

    /*
     * After the stop, a new file or folder that landed too late to go with the rest and then couldn't be
     * removed: a row names it for the next open, the one the stop kept (its clean-up left things too) or,
     * when that one went, a row of its own. Every late one joins the same row.
     */
    func keepLate(_ nodeId: String, stopKeptRow: Bool) {
        lock.withLock {
            guard !abandonedHere else { return }
            var late = lateRow ?? (stopKeptRow ? row
                : SaveRunRow(id: row.id, workspaceId: row.workspaceId, nodeIds: [], uploadIds: [], at: row.at, launch: row.launch))
            if !late.nodeIds.contains(nodeId) { late.nodeIds.append(nodeId) }
            lateRow = late
            try? journal.put(late)
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
        // A sign-out while it starts (abandonAll can't reach a run not yet live): it never starts.
        guard journal.live else { throw SaveRuns.signedOut() }
        let needed = try runEstimate(results: results)
        let room = try await writer.room(workspaceId)
        guard journal.live else { throw SaveRuns.signedOut() }
        let free: Int64?
        switch room {
        case .own(let known), .family(let known): free = known
        case .shared: free = nil
        }
        if let free, Int64(clamping: needed) > free {
            throw SaveRefused(reason: .noRoom, message: SaveRuns.noRoom, needed: needed, free: max(0, free))
        }
        let row = SaveRunRow(id: UUID().uuidString.lowercased(), workspaceId: workspaceId, nodeIds: [], uploadIds: [], at: now(), launch: SaveRuns.launch)
        do {
            try journal.put(row)
        } catch {
            throw SaveRunStopped(reason: .failed, message: SaveRuns.unrecorded, cleanup: .nothing)
        }
        let thumbnails = results.filter {
            switch $0 {
            case .known(_, let thumbnail), .fromSources(_, let thumbnail): return thumbnail
            }
        }.count
        let run = SaveRun(writer: writer, state: RunState(row: row, journal: journal), first: first, shared: room == .shared,
                          thumbnails: thumbnails, pause: pause, now: now)
        SaveRuns.register(run)
        // Signed out as it was registered: abandoned, its row gone with the journal (or never written).
        guard journal.live else {
            run.state.abandon()
            await run.abandon()
            throw SaveRuns.signedOut()
        }
        return run
    }

    /*
     * New work only while the run is open: one handed in during a stop is refused with it, and one handed in
     * after its account's session ended abandons it (a sign-out that didn't reach it).
     */
    private func open() async throws {
        if stopped == nil, stopping == nil, !state.journal.live { abandon() }
        if let stopping { throw await stopping.value }
        if let stopped { throw stopped }
        if finished { throw SaveRunRefusal(message: "This save has finished.") }
    }

    private func takeThumbnail(_ thumbnail: Data?) throws -> Data? {
        guard let thumbnail, !thumbnail.isEmpty else { return nil }
        guard thumbnails > 0 else { throw SaveRunRefusal(message: "This result was planned without a thumbnail.") }
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
        do {
            return try await makeFolder(name, into: into, signing: signing.metadata)
        } catch {
            throw await failed(error)
        }
    }

    /*
     * A failure on the run's own way to a result (a folder's listing, a folder's creation): the run stops and cleans up
     * as an upload's failure does, all or nothing. A stale version stays what it is.
     */
    private func failed(_ error: Error) async -> Error {
        if error is SaveRunStopped || error is SaveStale { return error }
        if let stopping { return await stopping.value }
        if let stopped { return stopped }
        return await stop(.failed, error is SaveUnrecorded ? SaveRuns.unrecorded : error.localizedDescription)
    }

    private func makeFolder(_ name: String, into: Opened, signing: Signing) async throws -> Opened {
        let given = try await claim(name, in: into)
        try await open()
        // A folder inside one the run made goes with it and needs no row of its own.
        let recordIt = !madeFolders.contains(into.id)
        let state = self.state
        // A destination a key change is still walking takes the run: its folders wait it out as its uploads do,
        // the folder looked up again before each try.
        var parentNow = into
        var since: Date?
        var attempt = 0
        var made: Opened
        while true {
            do {
                // Its id on disk before its creation is sent, or the creation is not sent.
                let sent = SentFlag()
                let at = now()
                do {
                    made = try await writer.makeFolder(in: parentNow, name: given, signing: signing) { id in
                        if recordIt { try state.recordFolder(id, at: at) } else if !state.journal.live { throw CancellationError() } else { try state.sending(id) }
                        sent.id = id
                    }
                } catch {
                    // Answered 409 for its own id: an earlier send of the same request made it (URLSession sent it again
                    // by itself). There, it is the folder asked for.
                    if let id = sent.id, SaveRuns.ownIdTaken(error), let found = try? await writer.listed(id, in: parentNow) {
                        state.answered(id)
                        state.creationEnded(id, mayExist: false)
                        made = found
                        break
                    }
                    // No answer: the server may still be making it (noted before the count drops, so a waiting stop sees it).
                    if let id = sent.id {
                        let unanswered = recordIt && SaveRuns.noAnswer(error)
                        if !unanswered { state.answered(id) }
                        state.creationEnded(id, mayExist: unanswered)
                    }
                    throw error
                }
                if let id = sent.id {
                    state.answered(id)
                    state.creationEnded(id, mayExist: false)
                }
                break
            } catch where KeyChangeWait.meets(error, waited: since != nil) {
                if let stopping { throw await stopping.value }
                let start = since ?? now()
                since = start
                if now().timeIntervalSince(start) >= KeyChangeWait.giveUp { throw await stop(.failed, KeyChangeWait.gaveUp) }
                attempt += 1
                try await waitOut(into.node.workspaceId, attempt)
                parentNow = try await refreshed(parentNow, replacing: nil, since: &since, attempt: &attempt).folder
            }
        }
        if stopped == nil, stopping == nil, !state.journal.live { abandon() }
        if let stopping {
            // Made while the run stopped: it goes the way the rest went, and if it cannot, a row names it (keepLate).
            let done = await stopping.value
            if !state.abandoned, await SaveRuns.discard([made.id], in: state.snapshot.workspaceId, writer: writer) == .left {
                state.keepLate(made.id, stopKeptRow: done.cleanup == .left)
            }
            throw done
        }
        // Signed out meanwhile: nothing is asked of the server or written for that account.
        if let stopped { throw stopped }
        madeFolders.insert(made.id)
        claimed[made.id] = []
        return made
    }

    /* A key change's pause; one cut short (the task cancelled) stops the run as any other failure does. */
    private func waitOut(_ workspaceId: String, _ attempt: Int) async throws {
        do {
            if let pause { try await pause(attempt) } else { try await writer.keyChangePause(workspaceId, attempt: attempt) }
        } catch {
            throw await failed(error)
        }
    }

    /*
     * After a pause for a key change: the folder and the chain above it as the server holds them now, and the
     * file replaced. A refresh the key change still holds up pauses again (until KeyChangeWait.giveUp); a file
     * gone is `stale`; anything else stops the run.
     */
    private func refreshed(_ folder: Opened, replacing: Opened?, since: inout Date?,
                           attempt: inout Int) async throws -> (folder: Opened, replacing: Opened?) {
        while true {
            do {
                let folderNow = try await writer.refreshFolder(folder)
                guard let file = replacing else { return (folderNow, nil) }
                guard let fresh = try await writer.fresh(file, in: folderNow) else { throw SaveStale(currentVersionId: nil) }
                return (folderNow, fresh)
            } catch let stale as SaveStale {
                throw stale
            } catch where KeyChangeWait.meets(error, waited: true) {
                if let stopping { throw await stopping.value }
                if let stopped { throw stopped }
                let start = since ?? now()
                since = start
                if now().timeIntervalSince(start) >= KeyChangeWait.giveUp { throw await stop(.failed, KeyChangeWait.gaveUp) }
                attempt += 1
                try await waitOut(folder.node.workspaceId, attempt)
            } catch {
                if let stopping { throw await stopping.value }
                throw await stop(.failed, error.localizedDescription)
            }
        }
    }

    /* A new file under the next free name in its folder; never replaces anything. */
    public func file(_ bytes: Data, name: String, mime: String?, sources: SaveSources, thumbnail: Data? = nil, in folder: Opened? = nil) async throws -> Opened {
        try await open()
        let signing = try SaveRuns.signing(sources)
        let thumb = try takeThumbnail(thumbnail)
        let into = folder ?? first
        let given: String
        do { given = try await claim(name, in: into) } catch { throw await failed(error) }
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
                // The begin's ids are on disk before a part is sent (a refused write aborts the upload there).
                let landed = try await writer.uploadResult(bytes, name: name, mime: mime, in: folderNow, replacing: replacing, startedFrom: startedFrom,
                                                           thumbnail: thumbnail, signing: signing,
                                                           onBegun: { ids in begun.ids = ids; try state.begun(ids, tracked: tracked, version: version) },
                                                           onCompleting: { try state.completing($0) })
                if version { keptVersions += 1 }
                let recorded = (try? state.settled(begun.ids, landed: landed.id, tracked: tracked)) != nil
                if stopped != nil || stopping != nil {
                    // Landed while the run stopped or after: a new file goes the way the rest went, and if it
                    // can't, a row names it for the next open (keepLate).
                    let done: SaveRunStopped
                    if let stopping { done = await stopping.value } else { done = stopped! }
                    // Not after a sign-out: the session that could is ending, and nothing is deleted for it.
                    if tracked, !state.abandoned,
                       await SaveRuns.discard([landed.id], in: state.snapshot.workspaceId, writer: writer) == .left {
                        state.keepLate(landed.id, stopKeptRow: done.cleanup == .left)
                    }
                    throw done
                }
                // Landed, but the row naming it wasn't written: the run stops and removes it with the rest.
                if !recorded { throw await stop(.failed, SaveRuns.unrecorded) }
                return landed
            } catch let stale as SaveStale {
                if let id = stale.unreleased { state.keepUnreleased(id) } else { try? state.settled(begun.ids, landed: nil, tracked: false) }
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
                    if let id = (error as? SaveRekeyed)?.unreleased { state.keepUnreleased(id) } else { try? state.settled(begun.ids, landed: nil, tracked: false) }
                    if rekeyed {
                        rekeys += 1
                        if rekeys > 3 { throw await stop(.failed, error.localizedDescription) }
                    } else {
                        let start = since ?? now()
                        since = start
                        if now().timeIntervalSince(start) >= KeyChangeWait.giveUp { throw await stop(.failed, KeyChangeWait.gaveUp) }
                        attempt += 1
                        try await waitOut(folderNow.node.workspaceId, attempt)
                    }
                    // The destination and the chain above it as the server holds them now (a family's checked again
                    // first), and the file replaced, so nothing is sealed again under keys the change replaced.
                    (folderNow, replacing) = try await refreshed(folderNow, replacing: replacing, since: &since, attempt: &attempt)
                    continue
                }
                // Kept in the row: the stop aborts its upload and removes its node, whatever got that far.
                if let ids = begun.ids { try? state.begun(ids, tracked: tracked, version: version) }
                if error is SaveUnrecorded { throw await stop(.failed, SaveRuns.unrecorded) }
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
        // Sealed now, in this turn: a version landing from here on stays in the row the clean-up asks about (its abort
        // answers finished, and it is counted there), never dropped from the row after `keptBefore` was taken.
        let row = state.seal()
        let task = Task<SaveRunStopped, Never> {
            // The run's uploads are aborted first, so none keeps sending parts while the stop waits (one answered here
            // isn't asked again in the clean-up; one that got no answer is).
            var asked: [String: DriveAPI.AbortFate] = [:]
            for uploadId in row.uploadIds { asked[uploadId] = await writer.abortUpload(uploadId, in: row.workspaceId) }
            // Folder creations already sent settle next (a lost answer included): one the server creates after the
            // clean-up looked would otherwise be left with its row gone.
            await state.creationsSettled()
            let (cleanup, kept, uncertain, remains) = await SaveRuns.clean(row, writer: writer, journal: state.journal, versions: state.versionUploads,
                                                                           completing: state.completingUploads, published: state.published,
                                                                           asked: asked, mayExist: state.mayExist)
            let total = keptBefore + kept
            var done = SaveRunStopped(reason: reason, message: SaveRuns.words(reason, shared: shared, failure: failure, kept: total, uncertain: uncertain,
                                                                              remains: remains),
                                      cleanup: cleanup)
            done.keptVersions = total
            done.uncertainVersions = uncertain
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
        guard inFlight == 0 else { throw SaveRunRefusal(message: "Some results are still being saved.") }
        finished = true
        let row = state.seal()
        // Only uploads whose reservation wasn't confirmed released are left in the row: asked again now. One still
        // unanswered stays in a row of its own with no nodes (what was saved stays, never offered), which the next
        // open settles (settleUploads).
        var loose: [String] = []
        if state.journal.live {
            for uploadId in row.uploadIds {
                if await writer.abortUpload(uploadId, in: row.workspaceId) == .unknown { loose.append(uploadId) }
            }
        }
        if !loose.isEmpty {
            var left = row
            left.nodeIds = []
            left.uploadIds = loose
            left.uncertain = nil
            do { try state.journal.put(left) } catch { throw SaveRecordNotUpdated() }
            return
        }
        // Not retired: nothing more is taken in (`finished`), and finish may be asked again.
        guard state.journal.retire(row) else { throw SaveRecordNotUpdated() }
    }

    /*
     * Stops the run and removes the new files and folders it made (the caller cancels the task saving a
     * result; one that lands afterwards is removed as it lands). A new version that landed is kept.
     */
    public func cancel() async -> SaveRunStopped {
        if finished {
            // What it made was saved and stays: said so when there was any.
            var done = SaveRunStopped(reason: .cancelled, message: keptVersions > 0 || state.nodeCount > 0 ? SaveRuns.alreadySaved : SaveRuns.cancelled,
                                      cleanup: .nothing)
            done.keptVersions = keptVersions
            return done
        }
        return await stop(.cancelled)
    }

    /* A sign-out: the run stops writing at once, asking nothing of the server (the session is ending). */
    public func abandon() {
        guard stopped == nil else { return }
        state.abandon()
        // Nothing is removed after a sign-out: what was sent to be published may stay.
        let (uncertain, stays) = state.leftBehind(versions: state.versionUploads)
        var done = SaveRunStopped(reason: .signedOut, message: SaveRuns.words(.signedOut, shared: shared, failure: nil, kept: keptVersions,
                                                                              uncertain: uncertain, remains: stays ? .nothing : nil), cleanup: .left)
        done.keptVersions = keptVersions
        done.uncertainVersions = uncertain
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

    /* From the server itself, never the catalogue, which may not have heard of another device's new file yet. */
    public func names(in folder: Opened) async throws -> [String] {
        // Each row as the listing opened it (listChildren's openChain and remember, as children(of:) reads them).
        try await listChildren(of: folder.id, in: folder.node.workspaceId).children.compactMap { opened[$0.ref]?.name }
    }

    public func makeFolder(in folder: Opened, name: String, signing: Signing, minted: @escaping @Sendable (String) throws -> Void) async throws -> Opened {
        try await createFolder(in: folder.id, name: name, signing: signing, onMinted: minted)
    }

    public func uploadResult(_ bytes: Data, name: String, mime: String?, in folder: Opened, replacing: Opened?, startedFrom: String?, thumbnail: Data?,
                             signing: (metadata: Signing, version: Signing), onBegun: @escaping @Sendable (BegunIds) throws -> Void,
                             onCompleting: @escaping @Sendable (String) throws -> Void) async throws -> Opened {
        try await uploadResult(bytes, name: name, mime: mime, in: folder.id, replacing: replacing, startedFrom: startedFrom, thumbnail: thumbnail,
                               signing: signing, onBegun: onBegun, onCompleting: onCompleting)
    }

    /* From the server itself, never the catalogue (which may not have heard of a key change or another device's save yet). */
    public func listed(_ id: String, in folder: Opened) async throws -> Opened? {
        let listing = try await listChildren(of: folder.id, in: folder.node.workspaceId)
        guard let row = listing.children.first(where: { $0.id == id }) else { return nil }
        return try open(row, replacing: true)
    }

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

    /*
     * An upload still finishing is asked about again for about ten seconds, then `unknown`, never finished:
     * the server publishes its node only once the store has completed it, so it may land yet, and the row
     * naming it stays for the next open.
     */
    public func abortUpload(_ uploadId: String, in workspaceId: String) async -> DriveAPI.AbortFate {
        await abortUpload(uploadId, in: workspaceId, pause: .seconds(2))
    }

    func abortUpload(_ uploadId: String, in workspaceId: String, pause: Duration) async -> DriveAPI.AbortFate {
        for asked in 1 ... 5 {
            let fate = await api.abortUploadFate(uploadId: uploadId, workspaceId: workspaceId)
            guard fate == .finishing else { return fate }
            if asked < 5 { try? await Task.sleep(for: pause) }
        }
        return .unknown
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
