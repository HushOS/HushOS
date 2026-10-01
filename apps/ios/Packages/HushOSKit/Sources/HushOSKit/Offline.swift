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

    static func remember(_ item: Opened) {
        var list = entries().filter { $0.id != item.id }
        list.append(Entry(id: item.id, name: item.name, versionId: item.node.currentVersion?.id ?? "", size: item.size, mime: item.metadata.mime,
                          keptAt: ISO8601DateFormatter().string(from: Date()), workspaceId: item.node.workspaceId))
        write(list)
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
}

extension Vault {
    /* Keeps a file: downloads its current version into the offline store and records it. */
    public func keepDownloaded(_ item: Opened, progress: @Sendable (Double) -> Void = { _ in }) async throws {
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
        Offline.remember(item)
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
    public func assembleKeep(_ plan: KeepPlan, from directory: URL) async throws {
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
        Offline.remember(item)
    }
}
