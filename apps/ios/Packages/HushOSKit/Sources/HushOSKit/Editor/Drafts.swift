import Foundation
import HushOSCore

/*
 * Drafts on the phone (docs/editing-design.md 3, "Draft"; Editing 1c; the web's lib/editor/drafts.ts): the text editor's
 * unsaved text, sealed by the core under a key derived from the account key for this account and file (drafts.rs:
 * HKDF of the root, info ["hushos/drafts/v1",user,workspace,node]; XChaCha20-Poly1305 with the base version, the
 * session's save format and the time bound in), one record per file in `local/drafts`, found by a slot only the
 * unlocked account works out. Out of backups (Unbacked), each record written with complete file protection so a
 * locked phone can't read it, deleted with everything else of the account on sign-out, removal and another account's
 * sign-in (AccountStore.accountFiles), and never sent anywhere.
 *
 * Bounds (the core's draft_limits): 8 MiB of text per draft, 50 drafts (the phone holds one account's data at a
 * time: another account's sign-in wipes it), 30 days. A store that fails never stops editing: the write says so.
 */
public struct DraftPlace: Hashable, Sendable {
    public let userId: String
    public let workspaceId: String
    public let nodeId: String

    public init(userId: String, workspaceId: String, nodeId: String) {
        self.userId = userId.lowercased()
        self.workspaceId = workspaceId.lowercased()
        self.nodeId = nodeId.lowercased()
    }
}

/* A draft lookup's answer: none, no answer (unread: nothing may be written over it), or the draft. */
public enum DraftLookup: Sendable {
    case absent
    case unavailable
    case found(Draft)

    public var draft: Draft? {
        if case .found(let draft) = self { return draft }
        return nil
    }

    public var isAbsent: Bool {
        if case .absent = self { return true }
        return false
    }
}

public struct DraftStore: Sendable {
    let folder: URL
    let now: @Sendable () -> UInt64
    /* Unbacked.protectAll leaves the drafts' complete protection as written (DraftStore.folderName). */
    static let folderName = "drafts"

    public init(folder: URL, now: @escaping @Sendable () -> UInt64 = DraftStore.clock) {
        self.folder = folder
        self.now = now
    }

    public static let clock: @Sendable () -> UInt64 = { UInt64(max(0, Date().timeIntervalSince1970 * 1000)) }

    /* The app's: `local/drafts` in the app group, made out of backups. */
    public static var shared: DraftStore {
        DraftStore(folder: Unbacked.local.appendingPathComponent("drafts", isDirectory: true))
    }

    private func file(_ slot: String) -> URL {
        // Base64url: letters, digits, '-' and '_' only, so a file name as it is.
        folder.appendingPathComponent("\(slot).json")
    }

    private func slot(_ place: DraftPlace, key: Data) throws -> String {
        try draftSlot(accountKey: key, userId: place.userId, workspaceId: place.workspaceId, nodeId: place.nodeId)
    }

    /*
     * Beside the folder, never in it and never deleted: the lock every process takes for a draft write, removal or wipe
     * (the app, and the Files sign-in sheet whose sign-in wipes the account), and the generation every wipe moves under
     * it, kept on disk so a write asked for in one process before a wipe in another keeps nothing.
     */
    private var lockPath: String {
        // Its folder made first: a lock file that can't be opened would stop every write, quietly.
        try? FileManager.default.createDirectory(at: folder.deletingLastPathComponent(), withIntermediateDirectories: true)
        return folder.path + ".lock"
    }
    private var generationFile: URL { URL(fileURLWithPath: folder.path + ".generation") }
    var activity: FileLock.Activity = .system

    /* What a write asked for now carries: a wipe (a sign-out, another account's sign-in) after it moves this. */
    public var generation: UInt64 {
        (try? String(contentsOf: generationFile, encoding: .utf8)).flatMap { UInt64($0) } ?? 0
    }

    /* The account's drafts deleted (AccountStore.wipe), under the lock, so no write asked for before lands after. */
    func wipe() {
        // First, lock or no lock: every write asked for before this is void from now. A writer checks the generation
        // again once its record is in place and takes it back if it moved, so even a wipe that never gets the lock (a
        // process holding it suspended) leaves nothing a writer published around it.
        try? Data(String(generation &+ 1).utf8).write(to: generationFile, options: .atomic)
        let delete = { _ = try? FileManager.default.removeItem(at: folder) }
        if !FileLock.withLock(lockPath, activity: activity, delete) {
            delete()
            FileLock.withLock(lockPath, activity: activity, delete)
        }
    }

    /* Tests only: runs between a writer's first check and its record landing. */
    var beforePublish: (@Sendable () -> Void)?

    static func wipe(folder: URL) { DraftStore(folder: folder).wipe() }

    /*
     * Seals and keeps `draft` for `place`, then keeps the caps; false when it couldn't be kept (past the limit, a full
     * disk, a phone locked under complete protection, a wipe since `asked`). The last draft kept stays then, and nothing
     * else is evicted for a write that didn't land.
     */
    @discardableResult
    public func write(_ draft: Draft, at place: DraftPlace, key: Data, asked: UInt64? = nil) -> Bool {
        let asked = asked ?? generation
        var kept = false
        FileLock.withLock(lockPath, activity: activity) { kept = writeLocked(draft, at: place, key: key, asked: asked) }
        return kept
    }

    private func writeLocked(_ draft: Draft, at place: DraftPlace, key: Data, asked: UInt64) -> Bool {
        guard asked == generation else { return false }
        guard let slot = try? slot(place, key: key),
              let record = try? draftSeal(accountKey: key, userId: place.userId, workspaceId: place.workspaceId,
                                          nodeId: place.nodeId, draft: draft) else { return false }
        beforePublish?()
        Unbacked.folder(folder)
        let files = FileManager.default
        do {
            try Data(record.utf8).write(to: file(slot), options: [.atomic, .completeFileProtection])
        } catch {
            return false
        }
        // A wipe came while this wrote (in this process or another, with the lock or without): what it published goes.
        guard asked == generation else {
            try? files.removeItem(at: file(slot))
            return false
        }
        // When it was written, as the file's own date: the caps read dates, never a record (a protected one can't be
        // read while the phone is locked, and that is no reason to evict it).
        let at = Date(timeIntervalSince1970: TimeInterval(draft.frame.savedAt) / 1000)
        try? files.setAttributes([.modificationDate: at], ofItemAtPath: file(slot).path)
        let kept = (try? files.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let entries: [DraftEntry] = kept.filter { $0.pathExtension == "json" }.compactMap { url in
            // A date that can't be read is no verdict on the draft: it is left alone.
            guard let date = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate else { return nil }
            return DraftEntry(slot: url.deletingPathExtension().lastPathComponent,
                              savedAt: UInt64(max(0, date.timeIntervalSince1970 * 1000)))
        }
        for gone in draftsToDrop(entries: entries, now: now(), keep: slot) { try? files.removeItem(at: file(gone)) }
        return true
    }

    /*
     * The file's draft: `absent` (none, or one that doesn't open here or is too old, deleted since nothing can show it),
     * `unavailable` (the lock not had, the file there but not readable now: no answer, never "none"), or `found`.
     */
    public func read(at place: DraftPlace, key: Data) -> DraftLookup {
        var found = DraftLookup.unavailable
        FileLock.withLock(lockPath, activity: activity) { found = readLocked(at: place, key: key) }
        return found
    }

    private func readLocked(at place: DraftPlace, key: Data) -> DraftLookup {
        guard let slot = try? slot(place, key: key) else { return .unavailable }
        guard FileManager.default.fileExists(atPath: file(slot).path) else { return .absent }
        guard let record = try? String(contentsOf: file(slot), encoding: .utf8) else { return .unavailable }
        guard let draft = try? draftOpen(accountKey: key, userId: place.userId, workspaceId: place.workspaceId,
                                         nodeId: place.nodeId, record: record),
              now() <= draft.frame.savedAt + draftLimits().maxAgeMs else {
            try? FileManager.default.removeItem(at: file(slot))
            return .absent
        }
        return .found(draft)
    }

    public func remove(at place: DraftPlace, key: Data) {
        guard let slot = try? slot(place, key: key) else { return }
        FileLock.withLock(lockPath, activity: activity) { _ = try? FileManager.default.removeItem(at: file(slot)) }
    }

    /* How many drafts are kept (for tests and the wipe's check). */
    public var count: Int {
        ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "json" }.count
    }
}

/*
 * The editor's rules for drafts, apart from the screen so they can be held to tests (DraftsTests) as the web's are
 * (lib/editor/drafts.ts createDraftWriter).
 */
public enum DraftRules {
    /* About two seconds after a change, and no more often while typing. */
    public static let writeDelay: Duration = .seconds(2)

    /* What a write turn does with the text as it is. */
    public enum Step: Equatable {
        /* Nothing may be written: no editable text, the offer unanswered, no version to start from. */
        case none
        /* Back at what was last opened or saved: the draft goes. */
        case remove
        case write
    }

    /*
     * Back at the baseline the turn asks for a removal; whether it happens is decided in the lane, after the writes before
     * it (DraftSession.remove): only a draft the session owns goes. `unread`: a lookup that couldn't answer, so nothing is
     * written over the draft it may have missed.
     */
    public static func step(editable: Bool, offering: Bool, unread: Bool, startedFrom: String?, atBaseline: Bool) -> Step {
        guard editable, !offering, !unread, startedFrom != nil else { return .none }
        return atBaseline ? .remove : .write
    }

    /* What reopening does with the draft (the core's draft_offer, held to the web by fixtures/drafts.json). */
    public static func offer(_ draft: Draft, openedVersionId: String?, openedText: String) -> DraftOffer {
        draftOffer(draftBaseVersionId: draft.frame.baseVersionId, draftText: draft.text, openedVersionId: openedVersionId,
                   openedText: openedText)
    }

    /* "2:14 PM" today, "Nov 19, 2:14 PM" on another day, in the person's locale. */
    public static func when(_ savedAt: UInt64, now: Date = Date(), locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        let at = Date(timeIntervalSince1970: TimeInterval(savedAt) / 1000)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        calendar.locale = locale
        var time = Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, calendar: calendar)
        time.timeZone = timeZone
        if calendar.isDate(at, inSameDayAs: now) { return at.formatted(time) }
        var date = Date.FormatStyle(locale: locale, calendar: calendar).month(.abbreviated).day()
        if !calendar.isDate(at, equalTo: now, toGranularity: .year) { date = date.year() }
        date.timeZone = timeZone
        return "\(at.formatted(date)), \(at.formatted(time))"
    }
}

/*
 * A write turn about two seconds after the first change, carrying every change until it runs, so typing writes at most
 * once per turn and the last change within one. `flush` runs it now (backgrounding, a park, a close).
 */
@MainActor public final class DraftTimer {
    private let delay: Duration
    private var pending: Task<Void, Never>?

    public init(delay: Duration = DraftRules.writeDelay) {
        self.delay = delay
    }

    public func changed(_ turn: @escaping @MainActor () -> Void) {
        guard pending == nil else { return }
        let delay = delay
        pending = Task { @MainActor [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, !Task.isCancelled else { return }
            self.pending = nil
            turn()
        }
    }

    public func flush(_ turn: @MainActor () -> Void) {
        cancel()
        turn()
    }

    public func cancel() {
        pending?.cancel()
        pending = nil
    }

    public var scheduled: Bool { pending != nil }
}

/*
 * Every draft write and removal in this process, one after another in the order asked (the editor's turns, a confirmed loss
 * of access's removal): a removal asked for after a write never runs before it.
 */
@MainActor public enum DraftLane {
    private static var chain: Task<Void, Never>?

    public static func enqueue(_ work: @escaping @MainActor () async -> Void) {
        let previous = chain
        chain = Task {
            await previous?.value
            await work()
        }
    }

    /* Waits for everything asked so far (tests). */
    public static func settled() async { await chain?.value }
}

/* Where a copy's version verdict can't be told: the text came from a version not read now (a restored draft's). */
extension TextEditing {
    /*
     * The header's mark over text restored from another version than the one read: never the read version's clean verdict,
     * at least Couldn't check (a worse one stands).
     */
    public static func headerProvenance(_ read: Provenance?, contentKnown: Bool) -> Provenance? {
        // A row with a mark keeps it (it already warns); a clean one (no mark) shows Couldn't check.
        contentKnown ? read : (read ?? .unchecked)
    }

    public static func contentUnknown(_ source: SaveSource) -> SaveSource {
        guard case let .file(metadata, _, fromLink) = source else { return source }
        return .file(metadata: metadata, version: .unchecked, fromLink: fromLink)
    }
}

/*
 * One editing session's hold on its draft, shared by the screens that show it (EditorState carries it across a rebuild,
 * so a write that lands after an unfold counts for the editor presented again). `owns`: this session wrote the stored draft,
 * or the person restored it; only then does a removal it asks for go. `unread`: its lookup couldn't answer, so nothing is
 * written until one does. Writes and removals go through DraftLane, a removal deciding after the writes before it.
 */
@MainActor public final class DraftSession {
    public private(set) var owns = false
    public var unread = false
    /*
     * The store's wipe generation when this editor opened (`opened`), carried through a rebuild with the session: every
     * write it asks for carries it, so once a wipe moves it (a sign-out, another account signed in from the Files sheet
     * while the app was away) nothing this editor writes is kept, whatever the store's generation is by then.
     */
    public private(set) var generation: UInt64?

    public init() {}

    /* The editor opened its file: the generation it writes under, from now on. */
    public func opened(_ store: DraftStore = .shared) {
        if generation == nil { generation = store.generation }
    }

    /* What a write asks under: the generation at the open, never a later one. */
    public func asked(_ store: DraftStore = .shared) -> UInt64 {
        generation ?? store.generation
    }

    /* The person restored the stored draft: this session's to remove from here. */
    public func adopt() { owns = true }

    public func write(_ work: @escaping @MainActor () async -> Bool, kept: @escaping @MainActor (Bool) -> Void = { _ in }) {
        DraftLane.enqueue { [self] in
            let written = await work()
            if written { owns = true }
            kept(written)
        }
    }

    /* Removed once the writes asked before have landed, if this session owns the draft then, or `force`. */
    public func remove(force: Bool = false, _ work: @escaping @MainActor () async -> Void) {
        DraftLane.enqueue { [self] in
            guard force || owns else { return }
            owns = false
            await work()
        }
    }
}

extension Vault {
    /* Where this account keeps `file`'s draft. */
    public nonisolated func draftPlace(of file: Opened) -> DraftPlace {
        DraftPlace(userId: session.userId, workspaceId: file.ref.workspaceId, nodeId: file.ref.nodeId)
    }

    /* Kept for `file`, on this phone only; false when it couldn't be. One at a time, in order, on the vault. */
    public func writeDraft(_ draft: Draft, of file: Opened, asked: UInt64?, store: DraftStore = .shared) -> Bool {
        guard let key = try? unlockAccount() else { return false }
        return store.write(draft, at: draftPlace(of: file), key: key, asked: asked)
    }

    public func readDraft(of file: Opened, store: DraftStore = .shared) -> DraftLookup {
        guard let key = try? unlockAccount() else { return .unavailable }
        return store.read(at: draftPlace(of: file), key: key)
    }

    public func removeDraft(of file: Opened, store: DraftStore = .shared) {
        guard let key = try? unlockAccount() else { return }
        store.remove(at: draftPlace(of: file), key: key)
    }
}
