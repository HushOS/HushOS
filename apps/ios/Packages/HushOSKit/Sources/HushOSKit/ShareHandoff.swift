import Foundation

/*
 * How Save to HushOS (the share extension) hands an upload to the app. The extension
 * seals the file into the app group's transfers folder, as the app's own queue does,
 * gives the parts to its own background session (iOS keeps sending them after the
 * extension closes), and leaves this note beside the parts. The app adopts the note
 * into its queue, which shows it in the transfers list and the Live Activity and
 * finishes it once every part has landed.
 *
 * The two processes never write the same file: the extension writes the note and one
 * small file per landed part ("etag-<n>"); the app only reads them and removes them as
 * it takes them in. When the extension is gone before the parts land, iOS wakes the
 * app for the extension's session instead, and the app's own delegate takes the rest.
 *
 * A note is held while the extension's sheet is open: a small file often lands in that
 * time, and the extension finishes it itself and removes the note (the app might never
 * be woken for it otherwise). Then it releases the rest. The app adopts a released note
 * at once, and a held one only when it is old enough that the extension must be gone.
 */
public struct ShareHandoff: Codable, Sendable, Equatable {
    /* The extension's background session; the app connects to it too, to take what lands after the extension closed. */
    public static let sessionIdentifier = "com.hushos.app.transfers.share"

    public let id: UUID
    public let name: String
    public let folderId: String
    public let mime: String?
    public let size: Int64?
    public let sealed: Vault.SealedUpload
    /* The account whose drive it goes to; the app adopts it only while that account is signed in (TransferOwnership). */
    public let owner: AccountOwner?
    /* The extension is done with it; until then only the extension may finish it. */
    public var released = false

    public init(id: UUID, name: String, folderId: String, mime: String?, size: Int64?, sealed: Vault.SealedUpload, owner: AccountOwner) {
        self.id = id
        self.name = name
        self.folderId = folderId
        self.mime = mime
        self.size = size
        self.sealed = sealed
        self.owner = owner
    }

    /* The queue's folder in the app group, the same one BackgroundTransfers keeps. */
    public static var transfers: URL {
        let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedKeychain.accessGroup)
            ?? FileManager.default.temporaryDirectory
        return group.appendingPathComponent("transfers", isDirectory: true)
    }

    public static func directory(_ id: UUID) -> URL { transfers.appendingPathComponent(id.uuidString, isDirectory: true) }

    /* Where the extension copies what it was handed, one folder per sheet, until Save seals it into `transfers`. */
    public static var staging: URL { transfers.deletingLastPathComponent().appendingPathComponent("share-staging", isDirectory: true) }

    /* How long a note may be held before its extension must be gone. */
    static let heldAge: TimeInterval = 120
    /* A queue folder with no note, no transfer and no owner on record: left a day before it is taken for abandoned. */
    static let unclaimedAge: TimeInterval = 86400
    /* A staging folder whose sheet left no owner (an older version): kept an hour. */
    static let unownedStagingAge: TimeInterval = 3600
    /* No sheet stays open a day: past that an owner's process id is taken for reused. */
    static let ownedStagingAge: TimeInterval = 86400

    /*
     * A folder the extension is working in (a sheet's staging folder, a file it is sealing into
     * the queue's folder) belongs to the extension process that made it: the folder names it
     * (`owner`, the process id), and the sweeps leave it while that process may still run, however
     * long it is suspended. A plain marker, never a lock: a process suspended holding a lock in the
     * group container is killed (0xdead10cc).
     */
    public static func claim(_ folder: URL, pid: Int32 = getpid()) {
        try? Data(String(pid).utf8).write(to: folder.appendingPathComponent("owner"), options: .atomic)
    }

    /*
     * Plaintext copies a sheet left behind: an extension killed before it closed never removed its
     * folder. A folder whose owning process is gone goes at once; one whose process still runs stays
     * (a day at most); one with no owner on record goes after an hour. Sign-out takes the rest (AccountStore).
     */
    public static func sweepStaging(now: Date = Date(), in root: URL = staging, running: (Int32) -> Bool = processRuns) {
        let files = FileManager.default
        for folder in (try? files.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
            let age = now.timeIntervalSince(lastTouched(folder))
            let owner = owner(of: folder)
            let stale: Bool
            if let owner { stale = !running(owner) || age > ownedStagingAge } else { stale = age > unownedStagingAge }
            if stale { try? files.removeItem(at: folder) }
        }
    }

    /*
     * Whether a process may still be alive: only "no such process" (ESRCH) says it is gone. A
     * process this one may not signal (EPERM) exists, and anything else can't be ruled out.
     */
    public static func processRuns(_ pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        return kill(pid, 0) == 0 || errno != ESRCH
    }

    /*
     * Folders under `transfers` nothing owns: no note beside them and no queued transfer of that
     * id. One the extension claimed goes only once its process is gone (it was killed while
     * sealing, leaving the plaintext in `content`), or after a day (a reused process id). One
     * nobody claimed goes after a day. Age alone said nothing: a sheet suspended mid-seal writes
     * nothing for minutes, and its folder held the only copy of the file. The queue's records stay.
     */
    public static func sweepOrphans(keeping queued: Set<UUID>, now: Date = Date(), in root: URL = transfers,
                                    running: (Int32) -> Bool = processRuns) {
        let files = FileManager.default
        for folder in (try? files.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] {
            guard let id = UUID(uuidString: folder.lastPathComponent), !queued.contains(id),
                  !files.fileExists(atPath: folder.appendingPathComponent("handoff.json").path)
            else { continue }
            let age = now.timeIntervalSince(lastTouched(folder))
            let abandoned = owner(of: folder).map { !running($0) } ?? false
            if abandoned || age > unclaimedAge { try? files.removeItem(at: folder) }
        }
    }

    static func owner(of folder: URL) -> Int32? {
        (try? String(contentsOf: folder.appendingPathComponent("owner"), encoding: .utf8))
            .flatMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }

    /* The latest change to a folder or anything directly in it: a seal writing parts keeps it fresh. */
    static func lastTouched(_ folder: URL) -> Date {
        let key: Set<URLResourceKey> = [.contentModificationDateKey]
        let own = (try? folder.resourceValues(forKeys: key).contentModificationDate) ?? .distantPast
        let inside = ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: Array(key))) ?? [])
            .compactMap { try? $0.resourceValues(forKeys: key).contentModificationDate }
        return ([own] + inside).max() ?? own
    }

    private static func note(_ id: UUID, in root: URL = transfers) -> URL {
        root.appendingPathComponent(id.uuidString, isDirectory: true).appendingPathComponent("handoff.json")
    }

    /* Written once the parts are sealed on disk, before they go to the session; written again to release it. */
    public func write() throws {
        try JSONEncoder().encode(self).write(to: Self.note(id), options: .atomic)
    }

    /* Notes the app may adopt: released ones, and held ones older than any extension lives. */
    public static func waiting(now: Date = Date()) -> [ShareHandoff] {
        let folders = (try? FileManager.default.contentsOfDirectory(at: transfers, includingPropertiesForKeys: nil)) ?? []
        return folders.compactMap { folder in
            let file = folder.appendingPathComponent("handoff.json")
            guard let data = try? Data(contentsOf: file), let note = try? JSONDecoder().decode(ShareHandoff.self, from: data) else { return nil }
            if note.released { return note }
            let written = (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? now
            return now.timeIntervalSince(written) > heldAge ? note : nil
        }
    }

    /*
     * Notes taken into the queue, each with the parts it was adopted with: the queue's records are
     * written first (`persist`), and only once they are on disk do the notes and those parts' files
     * go, so a note is never adopted twice nor lost. Killed in between, the note is still there and
     * the queue, finding its record, only removes it. The other way round, a killed app left an
     * upload with neither note nor record, and the next sweep took it.
     */
    @discardableResult
    public static func adopt(_ taken: [UUID: [Int]], in root: URL = transfers, persist: () -> Bool) -> Bool {
        guard persist() else { return false }
        for (id, parts) in taken {
            try? FileManager.default.removeItem(at: note(id, in: root))
            for part in parts {
                try? FileManager.default.removeItem(at: root.appendingPathComponent(id.uuidString, isDirectory: true).appendingPathComponent("etag-\(part)"))
            }
        }
        return true
    }

    /* The parts the extension saw land, read and left in place (`adopt` removes them once recorded). */
    public static func landedParts(_ id: UUID, in root: URL = transfers) -> [Int: String] {
        let folder = root.appendingPathComponent(id.uuidString, isDirectory: true)
        var found: [Int: String] = [:]
        for file in (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        where file.lastPathComponent.hasPrefix("etag-") {
            guard let part = Int(file.lastPathComponent.dropFirst("etag-".count)),
                  let etag = try? String(contentsOf: file, encoding: .utf8), !etag.isEmpty else { continue }
            found[part] = etag
        }
        return found
    }

    /* A part the extension saw land. */
    public static func landed(_ id: UUID, part: Int, etag: String) {
        try? Data(etag.utf8).write(to: directory(id).appendingPathComponent("etag-\(part)"), options: .atomic)
    }

    /* The parts the extension saw land since the last look, taken (their files removed). */
    public static func takeLanded(_ id: UUID) -> [Int: String] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory(id), includingPropertiesForKeys: nil)) ?? []
        var found: [Int: String] = [:]
        for file in files where file.lastPathComponent.hasPrefix("etag-") {
            guard let part = Int(file.lastPathComponent.dropFirst("etag-".count)),
                  let etag = try? String(contentsOf: file, encoding: .utf8), !etag.isEmpty else { continue }
            found[part] = etag
            try? FileManager.default.removeItem(at: file)
        }
        return found
    }
}
