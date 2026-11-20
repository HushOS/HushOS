import Foundation
import HushOSCore

/*
 * Drafts on the phone (docs/editing-design.md 3, "Draft"; Editing 1c; the web's lib/drafts.ts): the text editor's
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

public struct DraftStore: Sendable {
    let folder: URL
    let now: @Sendable () -> UInt64

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

    /* One lock for every draft file in the process, and what every wipe of a folder moves under it. */
    private static let lock = NSLock()
    nonisolated(unsafe) private static var moved: [String: UInt64] = [:]

    /* What a write asked for now carries: a wipe (a sign-out) after it moves this, and the write keeps nothing. */
    public var generation: UInt64 { Self.lock.withLock { Self.moved[folder.standardizedFileURL.path] ?? 0 } }

    /* The account's drafts deleted (AccountStore.wipe), under the lock, so no write asked for before lands after. */
    static func wipe(folder: URL) {
        lock.withLock {
            moved[folder.standardizedFileURL.path, default: 0] += 1
            try? FileManager.default.removeItem(at: folder)
        }
    }

    /*
     * Seals and keeps `draft` for `place`, keeping the caps; false when it couldn't be kept (past the limit, a full disk,
     * a phone locked under complete protection, a wipe since `asked`). The last draft kept stays then.
     */
    @discardableResult
    public func write(_ draft: Draft, at place: DraftPlace, key: Data, asked: UInt64? = nil) -> Bool {
        let asked = asked ?? generation
        return Self.lock.withLock { writeLocked(draft, at: place, key: key, asked: asked) }
    }

    private func writeLocked(_ draft: Draft, at place: DraftPlace, key: Data, asked: UInt64) -> Bool {
        guard asked == Self.moved[folder.standardizedFileURL.path] ?? 0 else { return false }
        do {
            let slot = try slot(place, key: key)
            let record = try draftSeal(accountKey: key, userId: place.userId, workspaceId: place.workspaceId,
                                       nodeId: place.nodeId, draft: draft)
            Unbacked.folder(folder)
            let files = FileManager.default
            let kept = (try? files.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
            let entries = kept.filter { $0.pathExtension == "json" }.map { url in
                DraftEntry(slot: url.deletingPathExtension().lastPathComponent,
                           savedAt: (try? String(contentsOf: url, encoding: .utf8)).flatMap { draftSavedAt(record: $0) })
            }
            for gone in draftsToDrop(entries: entries, now: now(), keep: slot) { try? files.removeItem(at: file(gone)) }
            try Data(record.utf8).write(to: file(slot), options: [.atomic, .completeFileProtection])
            return true
        } catch {
            return false
        }
    }

    /* The file's draft, or nil: none, or one that doesn't open here or is too old, which is deleted (nothing can show it). */
    public func read(at place: DraftPlace, key: Data) -> Draft? {
        Self.lock.withLock { readLocked(at: place, key: key) }
    }

    private func readLocked(at place: DraftPlace, key: Data) -> Draft? {
        guard let slot = try? slot(place, key: key),
              let record = try? String(contentsOf: file(slot), encoding: .utf8) else { return nil }
        guard let draft = try? draftOpen(accountKey: key, userId: place.userId, workspaceId: place.workspaceId,
                                         nodeId: place.nodeId, record: record),
              now() <= draft.frame.savedAt + draftLimits().maxAgeMs else {
            try? FileManager.default.removeItem(at: file(slot))
            return nil
        }
        return draft
    }

    public func remove(at place: DraftPlace, key: Data) {
        guard let slot = try? slot(place, key: key) else { return }
        Self.lock.withLock { _ = try? FileManager.default.removeItem(at: file(slot)) }
    }

    /* How many drafts are kept (for tests and the wipe's check). */
    public var count: Int {
        ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "json" }.count
    }
}

/*
 * The editor's rules for drafts, apart from the screen so they can be held to tests (DraftsTests) as the web's are
 * (lib/drafts.ts createDraftWriter).
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

    public static func step(editable: Bool, offering: Bool, startedFrom: String?, atBaseline: Bool) -> Step {
        guard editable, !offering, startedFrom != nil else { return .none }
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

extension Vault {
    /* Where this account keeps `file`'s draft. */
    public nonisolated func draftPlace(of file: Opened) -> DraftPlace {
        DraftPlace(userId: session.userId, workspaceId: file.ref.workspaceId, nodeId: file.ref.nodeId)
    }

    /* Kept for `file`, on this phone only; false when it couldn't be. One at a time, in order, on the vault. */
    public func writeDraft(_ draft: Draft, of file: Opened, asked: UInt64? = nil, store: DraftStore = .shared) -> Bool {
        guard let key = try? unlockAccount() else { return false }
        return store.write(draft, at: draftPlace(of: file), key: key, asked: asked)
    }

    public func readDraft(of file: Opened, store: DraftStore = .shared) -> Draft? {
        guard let key = try? unlockAccount() else { return nil }
        return store.read(at: draftPlace(of: file), key: key)
    }

    public func removeDraft(of file: Opened, store: DraftStore = .shared) {
        guard let key = try? unlockAccount() else { return }
        store.remove(at: draftPlace(of: file), key: key)
    }
}
