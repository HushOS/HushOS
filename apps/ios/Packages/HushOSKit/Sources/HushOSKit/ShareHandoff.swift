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
 * small file per landed part ("etag-<upload>-<n>", naming the server's upload it landed in);
 * the app only reads them and removes them as it takes them in. A part of an upload since
 * aborted and sealed again (a family folder's, after a key change) names the old upload, so
 * neither its file nor its session callback (`<id>|<piece>|<upload>`) is ever taken for one of
 * the new upload's parts. When the extension is gone before the parts land, iOS wakes the
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
    /*
     * A family folder's: its family and the folder's workspace, sealed with the area ledger's keys (FamilyUploads) and its
     * plaintext kept in the folder. The app adopts it as the queue's family upload, which finishes (or seals again) through
     * FamilyUploads. Nil for your own drive's.
     */
    public let family: FamilyUpload.Family?
    /* The extension is done with it; until then only the extension may finish it. */
    public var released = false

    public init(id: UUID, name: String, folderId: String, mime: String?, size: Int64?, sealed: Vault.SealedUpload, owner: AccountOwner,
                family: FamilyUpload.Family? = nil) {
        self.id = id
        self.name = name
        self.folderId = folderId
        self.mime = mime
        self.size = size
        self.sealed = sealed
        self.owner = owner
        self.family = family
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

    /* A part's session task, as the app's queue names its own: the upload's id, the piece (part - 1) and the server's upload. */
    public static func taskDescription(_ id: UUID, part: Int, upload: String) -> String { "\(id.uuidString)|\(part - 1)|\(upload)" }

    /* A part's task described by `taskDescription`; nil for any other (one with no upload named is never taken). */
    public static func landing(_ description: String) -> (id: UUID, part: Int, upload: String)? {
        let fields = description.split(separator: "|")
        guard fields.count == 3, let id = UUID(uuidString: String(fields[0])), let piece = Int(fields[1]), valid(String(fields[2])) else { return nil }
        return (id, piece + 1, String(fields[2]))
    }

    /* A server's upload id as a file name may hold it. */
    static func valid(_ upload: String) -> Bool {
        !upload.isEmpty && upload.count <= 64 && upload.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
    }

    private static func etagFile(_ upload: String, part: Int) -> String { "etag-\(upload)-\(part)" }

    /*
     * Notes taken into the queue, each with the parts it was adopted with: the queue's records are
     * written first (`persist`), and only once they are on disk do the notes and those parts' files
     * go, so a note is never adopted twice nor lost. Killed in between, the note is still there and
     * the queue, finding its record, only removes it. The other way round, a killed app left an
     * upload with neither note nor record, and the next sweep took it.
     */
    @discardableResult
    public static func adopt(_ taken: [UUID: (upload: String, parts: [Int])], in root: URL = transfers, persist: () -> Bool) -> Bool {
        guard persist() else { return false }
        for (id, landed) in taken {
            try? FileManager.default.removeItem(at: note(id, in: root))
            for part in landed.parts {
                try? FileManager.default.removeItem(at: root.appendingPathComponent(id.uuidString, isDirectory: true).appendingPathComponent(etagFile(landed.upload, part: part)))
            }
        }
        return true
    }

    /* The parts of `upload` the extension saw land, read and left in place (`adopt` removes them once recorded); another upload's are none. */
    public static func landedParts(_ id: UUID, upload: String, in root: URL = transfers) -> [Int: String] {
        parts(of: upload, in: root.appendingPathComponent(id.uuidString, isDirectory: true)).mapValues(\.etag)
    }

    /* A part of `upload` the extension saw land. */
    public static func landed(_ id: UUID, part: Int, etag: String, upload: String, in root: URL = transfers) {
        guard valid(upload) else { return }
        try? Data(etag.utf8).write(to: root.appendingPathComponent(id.uuidString, isDirectory: true).appendingPathComponent(etagFile(upload, part: part)), options: .atomic)
    }

    /* The parts of `upload` the extension saw land since the last look, taken (their files removed); another upload's stay unread. */
    public static func takeLanded(_ id: UUID, upload: String, in root: URL = transfers) -> [Int: String] {
        let found = parts(of: upload, in: root.appendingPathComponent(id.uuidString, isDirectory: true))
        for (_, landed) in found { try? FileManager.default.removeItem(at: landed.file) }
        return found.mapValues(\.etag)
    }

    private static func parts(of upload: String, in folder: URL) -> [Int: (etag: String, file: URL)] {
        guard valid(upload) else { return [:] }
        let prefix = "etag-\(upload)-"
        var found: [Int: (etag: String, file: URL)] = [:]
        for file in (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        where file.lastPathComponent.hasPrefix(prefix) {
            guard let part = Int(file.lastPathComponent.dropFirst(prefix.count)),
                  let etag = try? String(contentsOf: file, encoding: .utf8), !etag.isEmpty else { continue }
            found[part] = (etag, file)
        }
        return found
    }
}
