import Foundation

/*
 * What this phone keeps of each family it checked: the device record the core sealed after an
 * accepted member list (the chain cache and this device's own pin, under a key from the account
 * root, bound to the account and the family), the twin of the web's `chains` store
 * (apps/web/src/lib/groups/store.ts). Beside the sealed record sit only hints in the clear: the
 * roster version the next fetch continues from (a wrong one only makes the core fetch from
 * version 1) and the family folders a wipe forgets.
 *
 * In `local/groups/`, out of backups with the rest of `local` (Unbacked), one file per account
 * and family. The app and its extensions share the folder, so every write is one
 * read-compare-write under the folder's lock: **records reach disk in commit order**, and a
 * record never replaces one at a later roster version (an acceptance that finished late, in
 * this process or another, would otherwise put back a record the next sync accepts a rollback
 * from).
 */
public struct FamilyRecords: Sendable {
    public struct Row: Codable, Sendable, Equatable {
        public let envelope: String
        public let rosterVersion: UInt64
        public let areas: [String]

        public init(envelope: String, rosterVersion: UInt64, areas: [String]) {
            self.envelope = envelope
            self.rosterVersion = rosterVersion
            self.areas = areas
        }
    }

    let folder: URL
    var activity: HighWaterMarks.Activity = .system

    public static var shared: FamilyRecords { FamilyRecords(folder: Unbacked.local.appendingPathComponent("groups", isDirectory: true)) }

    init(folder: URL, activity: HighWaterMarks.Activity = .system) {
        self.folder = folder
        self.activity = activity
    }

    /* A lowercase UUID: the only thing a server-given id may be before it names a file or a path. */
    public static func valid(_ id: String) -> Bool {
        id.wholeMatch(of: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) != nil
    }

    private func file(_ userId: String, _ groupId: String) -> URL? {
        guard Self.valid(userId.lowercased()), Self.valid(groupId) else { return nil }
        return folder.appendingPathComponent("\(userId.lowercased())_\(groupId).json")
    }

    private var lockPath: String { folder.appendingPathComponent(".lock").path }

    public func read(userId: String, groupId: String) -> Row? {
        guard let url = file(userId, groupId), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Row.self, from: data)
    }

    /*
     * Writes `row` unless a record at a later roster version is stored, comparing under the
     * lock. False when it kept the later one; throws when the lock or the write failed, since a
     * record that may not be on disk must not be followed by a settings pin.
     */
    @discardableResult
    public func put(userId: String, groupId: String, _ row: Row) throws -> Bool {
        guard let url = file(userId, groupId) else { throw RecordsError.busy }
        // Out of backups like the rest of `local`, made again if a sign-out removed it.
        Unbacked.folder(folder)
        var outcome: Result<Bool, Error> = .failure(RecordsError.busy)
        FileLock.withLock(lockPath, activity: activity) {
            if let stored = read(userId: userId, groupId: groupId), stored.rosterVersion > row.rosterVersion {
                outcome = .success(false)
                return
            }
            do {
                try JSONEncoder().encode(row).write(to: url, options: .atomic)
                outcome = .success(true)
            } catch {
                outcome = .failure(error)
            }
        }
        return try outcome.get()
    }

    public func delete(userId: String, groupId: String) {
        guard let url = file(userId, groupId) else { return }
        // A wipe goes through even when the lock can't be had: nothing it removes is a mark another write needs.
        if !FileLock.withLock(lockPath, activity: activity, { try? FileManager.default.removeItem(at: url) }) {
            try? FileManager.default.removeItem(at: url)
        }
    }

    enum RecordsError: Error, LocalizedError {
        case busy
        var errorDescription: String? { "This device couldn’t save its check of the family. Try again." }
    }
}
