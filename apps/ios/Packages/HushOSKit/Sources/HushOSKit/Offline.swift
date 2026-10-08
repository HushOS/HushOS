import Foundation
import os
import HushOSCore

/*
 * "Keep downloaded": the app keeps a decrypted copy of a file in the app
 * group container, so it opens without the network. iOS gives third-party
 * File Providers no pinning, so this is the app's own feature, the way the
 * other drives do it. The list and the names shown offline live in the
 * group's defaults, so the Offline section on Home needs no round trip.
 */
private let offlineLog = Logger(subsystem: "com.hushos.app", category: "offline")

public enum Offline {
    public struct Entry: Codable, Sendable, Identifiable, Equatable {
        public let id: String
        public let name: String
        public let versionId: String
        public let size: UInt64?
        public let mime: String?
        public let keptAt: String
        /* Tells a file of this account's drive from one kept out of a share; entries kept before it was recorded have none. */
        public var workspaceId: String?
        /* The kept folder this file is kept with; nil when it was kept on its own. */
        public var folderId: String?
    }

    /* A folder kept on this phone: every file inside it and its subfolders, now and as they change. */
    public struct KeptFolder: Codable, Sendable, Identifiable, Equatable {
        public let id: String
        public var name: String
        public let workspaceId: String
        public let keptAt: String
    }

    static let foldersKey = "offline.folders"

    /* Every kept folder, newest first. */
    public static func keptFolders() -> [KeptFolder] {
        guard let data = defaults.data(forKey: foldersKey), let list = try? JSONDecoder().decode([KeptFolder].self, from: data) else { return [] }
        return list.sorted { $0.keptAt > $1.keptAt }
    }

    public static func isFolderKept(_ id: String) -> Bool { keptFolders().contains { $0.id == id } }

    /* The kept folder a file is kept with, if it is. */
    public static func keptBy(_ fileId: String) -> KeptFolder? {
        guard let folderId = entries().first(where: { $0.id == fileId })?.folderId else { return nil }
        return keptFolders().first { $0.id == folderId }
    }

    /* The files kept with a folder. */
    public static func entries(keptWith folderId: String) -> [Entry] { entries().filter { $0.folderId == folderId } }

    public static func rememberFolder(_ folder: Opened) {
        var list = keptFolders().filter { $0.id != folder.id }
        list.append(KeptFolder(id: folder.id, name: folder.name, workspaceId: folder.node.workspaceId,
                               keptAt: ISO8601DateFormatter().string(from: Date())))
        defaults.set(try? JSONEncoder().encode(list), forKey: foldersKey)
    }

    /* The folder stops being kept and every file kept with it goes; files kept on their own stay. */
    public static func forgetFolder(_ id: String) {
        defaults.set(try? JSONEncoder().encode(keptFolders().filter { $0.id != id }), forKey: foldersKey)
        for entry in entries(keptWith: id) { forget(entry.id) }
        writeFailures(keepFailures().filter { $0.value.folderId != id })
    }

    /*
     * Kept copies from shares that are no longer shared with this account: the folder and
     * every file kept from that workspace go. `own` is this account's workspace; `shared`
     * the workspaces shares still open. Returns the folders removed, for the notice.
     */
    @discardableResult
    public static func forgetUnshared(own: String, shared: Set<String>) -> [KeptFolder] {
        let gone = keptFolders().filter { $0.workspaceId != own && !shared.contains($0.workspaceId) }
        for folder in gone { forgetFolder(folder.id) }
        for entry in entries() where entry.workspaceId.map({ $0 != own && !shared.contains($0) }) == true { forget(entry.id) }
        return gone
    }

    /* MARK: Files in a kept folder that couldn't be kept */

    /* One file's failed keep: why, how many times, and when to try again. */
    public struct KeepFailure: Codable, Sendable, Equatable {
        public let fileId: String
        public let folderId: String
        public var reason: String
        public var attempts: Int
        public var retryAt: Date
    }

    static let failuresKey = "offline.failures"

    public static func keepFailures() -> [String: KeepFailure] {
        guard let data = defaults.data(forKey: failuresKey), let map = try? JSONDecoder().decode([String: KeepFailure].self, from: data) else { return [:] }
        return map
    }

    static func writeFailures(_ map: [String: KeepFailure]) {
        defaults.set(try? JSONEncoder().encode(map), forKey: failuresKey)
    }

    /* Half a minute after the first failure, doubling to an hour: a file that keeps failing doesn't fail every sync. */
    public static func keepRetryDelay(attempts: Int) -> TimeInterval {
        min(3600, 30 * pow(2, Double(max(0, attempts - 1))))
    }

    /* A file in a kept folder that couldn't be kept: the rest of the folder stays kept. */
    @discardableResult
    public static func recordKeepFailure(_ fileId: String, folder folderId: String, reason: String, now: Date = Date()) -> KeepFailure {
        var map = keepFailures()
        let attempts = (map[fileId]?.attempts ?? 0) + 1
        let failure = KeepFailure(fileId: fileId, folderId: folderId, reason: reason, attempts: attempts,
                                  retryAt: now.addingTimeInterval(keepRetryDelay(attempts: attempts)))
        map[fileId] = failure
        writeFailures(map)
        return failure
    }

    /* Whether a file may be tried now: never failed, or its wait is over. */
    public static func isKeepDue(_ fileId: String, now: Date = Date()) -> Bool {
        guard let failure = keepFailures()[fileId] else { return true }
        return failure.retryAt <= now
    }

    /* Retry asked for, or the file came down: it starts again from no failures. */
    public static func clearKeepFailure(_ fileId: String) {
        var map = keepFailures()
        guard map.removeValue(forKey: fileId) != nil else { return }
        writeFailures(map)
    }

    public static func keepFailures(in folderId: String) -> [KeepFailure] {
        keepFailures().values.filter { $0.folderId == folderId }
    }

    static let group = "group.com.hushos.app"
    static let key = "offline.entries"

    static var defaults: UserDefaults { UserDefaults(suiteName: group) ?? .standard }

    /* Everything kept, newest first. */
    public static func entries() -> [Entry] {
        guard let data = defaults.data(forKey: key), let list = try? JSONDecoder().decode([Entry].self, from: data) else { return [] }
        return list.sorted { $0.keptAt > $1.keptAt }
    }

    public static func isKept(_ id: String) -> Bool { entries().contains { $0.id == id } }

    static func write(_ list: [Entry]) {
        defaults.set(try? JSONEncoder().encode(list), forKey: key)
    }

    static func root() -> URL {
        let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("offline", isDirectory: true)
    }

    /* Where a version's plaintext lives: one folder per version, so a replaced file never shows stale bytes. */
    public static func file(for item: Opened) -> URL? {
        guard let version = item.node.currentVersion else { return nil }
        return root().appendingPathComponent(item.id, isDirectory: true).appendingPathComponent(version.id, isDirectory: true).appendingPathComponent(item.name)
    }

    /* A kept entry's file, for the Offline list when the item itself is not loaded. */
    public static func file(for entry: Entry) -> URL {
        root().appendingPathComponent(entry.id, isDirectory: true).appendingPathComponent(entry.versionId, isDirectory: true).appendingPathComponent(entry.name)
    }

    /* The local copy, when it is the current version. */
    public static func localCopy(of item: Opened) -> URL? {
        guard let url = file(for: item), FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }

    /* `folder`: the kept folder it comes with. A refresh passes none and keeps what was recorded. */
    static func remember(_ item: Opened, folder: String? = nil) {
        let existing = entries().first { $0.id == item.id }
        var list = entries().filter { $0.id != item.id }
        // Kept on its own before: it stays its own, and outlives the folder.
        let keptWith = existing.map { $0.folderId } ?? folder
        list.append(Entry(id: item.id, name: item.name, versionId: item.node.currentVersion?.id ?? "", size: item.size, mime: item.metadata.mime,
                          keptAt: existing?.keptAt ?? ISO8601DateFormatter().string(from: Date()), workspaceId: item.node.workspaceId,
                          folderId: keptWith))
        write(list)
        clearKeepFailure(item.id)
    }

    /* Fills in the workspace of an entry kept before it was recorded, once the item is open. */
    static func recordWorkspace(_ item: Opened) {
        var list = entries()
        guard let index = list.firstIndex(where: { $0.id == item.id && $0.workspaceId == nil }) else { return }
        list[index].workspaceId = item.node.workspaceId
        write(list)
    }

    public static func forget(_ id: String) {
        write(entries().filter { $0.id != id })
        try? FileManager.default.removeItem(at: root().appendingPathComponent(id, isDirectory: true))
    }

    /*
     * Kept copies are decrypted files: they belong to the account that kept them and
     * nobody else (AccountStore removes them with the rest of the account's data).
     */
    public static func forgetAll() {
        defaults.removeObject(forKey: key)
        defaults.removeObject(forKey: foldersKey)
        defaults.removeObject(forKey: failuresKey)
        // Left by an earlier version that recorded the owner here (AccountStore records it now).
        defaults.removeObject(forKey: "offline.owner")
        try? FileManager.default.removeItem(at: root())
    }
}

extension Vault {
    /* Keeps a file: downloads its current version into the offline store and records it. */
    public func keepDownloaded(_ item: Opened, folder: String? = nil, progress: @Sendable (Double) -> Void = { _ in }) async throws {
        guard !item.isFolder, let destination = Offline.file(for: item) else { throw DriveAPIError.server(400, "Only files can be kept downloaded.") }
        try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: destination.path) {
            // Renamed elsewhere: the same version is already here under its old name, so move it rather than fetch it again.
            let folder = destination.deletingLastPathComponent()
            let earlier = ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []).first { $0.pathExtension != "part" }
            let moved = earlier.map { (try? FileManager.default.moveItem(at: $0, to: destination)) != nil } ?? false
            if !moved {
                do {
                    try await download(item.id, to: destination, progress: progress)
                } catch {
                    // A first keep that failed is nobody's to resume: its partial goes. A kept file's stays for the next refresh.
                    if !Offline.isKept(item.id) { try? FileManager.default.removeItem(at: Offline.root().appendingPathComponent(item.id, isDirectory: true)) }
                    throw error
                }
            }
        }
        // Older versions of the same file go; only the current one is kept.
        let versions = destination.deletingLastPathComponent().deletingLastPathComponent()
        for entry in (try? FileManager.default.contentsOfDirectory(at: versions, includingPropertiesForKeys: nil)) ?? [] where entry.lastPathComponent != item.node.currentVersion?.id {
            try? FileManager.default.removeItem(at: entry)
        }
        Offline.remember(item, folder: folder)
    }

    /* Every file in a folder and its subfolders, not in the trash: what keeping the folder keeps. */
    public func filesUnder(_ folderId: String) async throws -> [Opened] {
        var files: [Opened] = []
        var queue = [folderId]
        var seen: Set<String> = []
        while let id = queue.first {
            queue.removeFirst()
            guard seen.insert(id).inserted else { continue }
            for child in try await children(of: id) where child.node.trashedAt == nil {
                if child.isFolder { queue.append(child.id) } else if child.node.currentVersion != nil { files.append(child) }
            }
        }
        return files
    }

    /* Brings the named kept files up to their current version (replaced elsewhere: fetched again; trashed: forgotten); returns the ids that failed. */
    /*
     * Brings kept copies up to the current version; returns the ones that could not be, with why.
     * A file gone from this account's drive loses its copy: trashed, or purged and so missing from
     * a catalogue the server sent this session (its tombstone went by once, then nothing names it).
     * A file kept out of a share this session has not opened is left alone until it is.
     */
    public func refreshOffline(_ ids: Set<String>, progress: @Sendable @escaping (String, Double) -> Void = { _, _ in }) async -> [String: Error] {
        var failed: [String: Error] = [:]
        let own = try? await workspaceId()
        for entry in Offline.entries() where ids.contains(entry.id) {
            // Entries from before the workspace was recorded count as this drive's: kept shares were rare, and a copy
            // wrongly dropped comes down again, while one of a purged file would stay readable here for good.
            let mine = own != nil && (entry.workspaceId ?? own) == own
            let item: Opened
            if let known = opened[entry.id] {
                item = known
            } else if !mine {
                // Only this drive's answers are proof: a share's folder asked for under this account's workspace is a 404 too.
                continue
            } else {
                do {
                    item = try await resolve(entry.id)
                } catch DriveAPIError.notFound {
                    Offline.forget(entry.id)
                    continue
                } catch {
                    if cataloguePulled { Offline.forget(entry.id) }
                    continue
                }
            }
            Offline.recordWorkspace(item)
            if item.isFolder || item.node.trashedAt != nil { Offline.forget(entry.id); continue }
            if Offline.localCopy(of: item) != nil { continue }
            do {
                try await keepDownloaded(item) { progress(entry.id, $0) }
            } catch {
                offlineLog.warning("refreshing the kept copy of \(entry.id, privacy: .public) failed: \(String(describing: error), privacy: .public)")
                failed[entry.id] = error
            }
        }
        return failed
    }

    /* Whether a kept file's current version needs fetching: not on the phone under any name. */
    public func keptVersionMissing(_ id: String) -> Bool {
        guard let item = opened[id], let version = item.node.currentVersion, item.node.trashedAt == nil else { return false }
        let folder = Offline.root().appendingPathComponent(id, isDirectory: true).appendingPathComponent(version.id, isDirectory: true)
        return !((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []).contains { $0.pathExtension != "part" }
    }
}

/*
 * A keep split for a background transfer: planned here (the chunk ranges and a
 * presigned address), fetched by the system's background session into
 * `chunk-N` files while the app may be closed, then decrypted here into the
 * kept copy. The chunk files are ciphertext; the key is opened only to decrypt.
 */
public struct KeepPlan: Codable, Sendable, Equatable {
    public let nodeId: String
    public let versionId: String
    public let name: String
    public let chunkCount: Int
    /* Inclusive byte ranges by chunk index, as the Range header takes them. */
    public let ranges: [Int: [UInt64]]
    public var url: String
}

extension Vault {
    public func planKeep(_ item: Opened) async throws -> KeepPlan {
        guard !item.isFolder, let current = item.node.currentVersion else { throw DriveAPIError.server(400, "Only files can be kept downloaded.") }
        let opened = try openVersion(item)
        let url = try await api.versionURL(opened.versionId, workspaceId: item.node.workspaceId)
        var ranges: [Int: [UInt64]] = [:]
        for index in 0 ..< opened.layout.chunkCount {
            let range = chunkRange(plaintextSize: opened.content.plaintextSize, index: index)
            ranges[Int(index)] = [range.start, range.end]
        }
        return KeepPlan(nodeId: item.id, versionId: current.id, name: item.name, chunkCount: Int(opened.layout.chunkCount), ranges: ranges, url: url.url)
    }

    /* A fresh address when the plan's expired. */
    public func keepAddress(_ plan: KeepPlan) async throws -> String {
        let item = try await resolve(plan.nodeId)
        return try await api.versionURL(plan.versionId, workspaceId: item.node.workspaceId).url
    }

    /* Decrypts the fetched `chunk-N` files in `directory` into the kept copy and records it; a replaced file is refused. */
    public func assembleKeep(_ plan: KeepPlan, from directory: URL, folder: String? = nil) async throws {
        let item = try await resolve(plan.nodeId)
        guard item.node.currentVersion?.id == plan.versionId, let destination = Offline.file(for: item) else {
            throw DriveAPIError.server(409, "“\(plan.name)” changed while it was being kept; it will be fetched again.")
        }
        let opened = try openVersion(item)
        let files = FileManager.default
        try files.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        let partial = destination.appendingPathExtension("part")
        files.createFile(atPath: partial.path, contents: nil)
        let handle = try FileHandle(forWritingTo: partial)
        do {
            for index in 0 ..< plan.chunkCount {
                let ciphertext = try Data(contentsOf: directory.appendingPathComponent("chunk-\(index)"))
                try handle.write(contentsOf: try chunkDecrypt(content: opened.content, index: UInt64(index), ciphertext: ciphertext))
            }
            try handle.close()
        } catch {
            try? handle.close()
            try? files.removeItem(at: partial)
            throw error
        }
        if files.fileExists(atPath: destination.path) { try files.removeItem(at: destination) }
        try files.moveItem(at: partial, to: destination)
        // Older versions of the same file go; only the current one is kept.
        let versions = destination.deletingLastPathComponent().deletingLastPathComponent()
        for entry in (try? files.contentsOfDirectory(at: versions, includingPropertiesForKeys: nil)) ?? [] where entry.lastPathComponent != plan.versionId {
            try? files.removeItem(at: entry)
        }
        Offline.remember(item, folder: folder)
    }
}
