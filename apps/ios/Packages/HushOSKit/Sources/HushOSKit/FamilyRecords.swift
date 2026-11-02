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
        /*
         * True when `areas` holds only folders proven this family's (route 25 and the folder id derived
         * under it). Absent on records an earlier version wrote, which saved every folder a member list
         * named, a received share's among them: those areas are hints that never clear, block or let
         * go of anything (`owned`).
         */
        public let areasProven: Bool?

        public init(envelope: String, rosterVersion: UInt64, areas: [String], areasProven: Bool? = nil) {
            self.envelope = envelope
            self.rosterVersion = rosterVersion
            self.areas = areas
            self.areasProven = areasProven
        }

        /* The folders this record proves the family's: none from a record an earlier version wrote. */
        public var ownedAreas: [String] { areasProven == true ? areas : [] }
    }

    let folder: URL
    var activity: FileLock.Activity = .system
    /* The session writes and deletions are kept to: none once it ended (CopySession). Nil: unbound. */
    var session: CopySession?

    /* The same store, writing and deleting only while `session` stands. */
    func bound(to session: CopySession) -> FamilyRecords {
        var bound = self
        bound.session = session
        return bound
    }

    /* `body` while the session stands (under the copies' lock), or always when unbound; nil when it ended. */
    private func whileOpen<T>(_ body: () throws -> T) rethrows -> T? {
        guard let session else { return try body() }
        return try session.whileOpen(body)
    }

    public static var shared: FamilyRecords { FamilyRecords(folder: Unbacked.local.appendingPathComponent("groups", isDirectory: true)) }

    init(folder: URL, activity: FileLock.Activity = .system) {
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
        // An ended session writes nothing: the record there now may be the next session's.
        guard whileOpen({
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
        }) != nil else { throw RecordsError.busy }
        return try outcome.get()
    }

    /* The families this account holds a device record of on this phone, by the record files' names. */
    public func groups(userId: String) -> [String] {
        let prefix = "\(userId.lowercased())_"
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        return names.compactMap { name in
            guard name.hasPrefix(prefix), name.hasSuffix(".json") else { return nil }
            let groupId = String(name.dropFirst(prefix.count).dropLast(".json".count))
            return Self.valid(groupId) ? groupId : nil
        }
    }

    // MARK: Joining

    /*
     * Beside each family's record, two sealed strings only the core reads (the web keeps both in
     * IndexedDB beside its chains, store.ts): the joins record (`joins`), kept only between "They
     * match" and the end of the join, so a relaunch finishes it without asking again; and the
     * join check's escalation (`holds`), which a wrong pair leaves and every check replaces, so a
     * relaunch hides the same two words and keeps the alarm. Neither is a mark or a record: they
     * are written last-wins, under the folder's lock like the record.
     */
    public enum Kept: String, Sendable {
        case joins, holds
    }

    private func file(_ userId: String, _ groupId: String, _ kept: Kept) -> URL? {
        guard Self.valid(userId.lowercased()), Self.valid(groupId) else { return nil }
        return folder.appendingPathComponent("\(userId.lowercased())_\(groupId).\(kept.rawValue)")
    }

    public func read(_ kept: Kept, userId: String, groupId: String) -> String? {
        guard let url = file(userId, groupId, kept), let data = try? Data(contentsOf: url) else { return nil }
        return String(data: data, encoding: .utf8).flatMap { $0.isEmpty ? nil : $0 }
    }

    /* Throws when the lock or the write failed: a joins record that may not be on disk must not be followed by its acceptance. */
    public func put(_ kept: Kept, userId: String, groupId: String, _ value: String) throws {
        guard let url = file(userId, groupId, kept) else { throw RecordsError.busy }
        Unbacked.folder(folder)
        var outcome: Result<Void, Error> = .failure(RecordsError.busy)
        guard whileOpen({
            FileLock.withLock(lockPath, activity: activity) {
                outcome = Result { try Data(value.utf8).write(to: url, options: .atomic) }
            }
        }) != nil else { throw RecordsError.busy }
        try outcome.get()
    }

    public func delete(_ kept: Kept, userId: String, groupId: String) {
        guard let url = file(userId, groupId, kept) else { return }
        // An ended session deletes nothing: the file there now may be the next session's.
        _ = whileOpen {
            if !FileLock.withLock(lockPath, activity: activity, { try? FileManager.default.removeItem(at: url) }) {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    public func delete(userId: String, groupId: String) {
        guard let url = file(userId, groupId) else { return }
        // A wipe goes through even when the lock can't be had: nothing it removes is a mark another write needs. An ended
        // session deletes nothing: the record there now may be the next session's.
        _ = whileOpen {
            if !FileLock.withLock(lockPath, activity: activity, { try? FileManager.default.removeItem(at: url) }) {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    enum RecordsError: Error, LocalizedError {
        case busy
        var errorDescription: String? { "This device couldn’t save its check of the family. Try again." }
    }
}
