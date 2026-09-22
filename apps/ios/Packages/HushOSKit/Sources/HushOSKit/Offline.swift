import Foundation
import HushOSCore

/*
 * "Keep downloaded": the app keeps a decrypted copy of a file in the app
 * group container, so it opens without the network. iOS gives third-party
 * File Providers no pinning, so this is the app's own feature, the way the
 * other drives do it. The list and the names shown offline live in the
 * group's defaults, so the Offline section on Home needs no round trip.
 */
public enum Offline {
    public struct Entry: Codable, Sendable, Identifiable, Equatable {
        public let id: String
        public let name: String
        public let versionId: String
        public let size: UInt64?
        public let mime: String?
        public let keptAt: String
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
                          keptAt: ISO8601DateFormatter().string(from: Date())))
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
            try await download(item.id, to: destination, progress: progress)
        }
        // Older versions of the same file go; only the current one is kept.
        let versions = destination.deletingLastPathComponent().deletingLastPathComponent()
        for entry in (try? FileManager.default.contentsOfDirectory(at: versions, includingPropertiesForKeys: nil)) ?? [] where entry.lastPathComponent != item.node.currentVersion?.id {
            try? FileManager.default.removeItem(at: entry)
        }
        Offline.remember(item)
    }

    /* Brings every kept file up to its current version; what was replaced elsewhere is fetched again, what was trashed is forgotten. */
    public func refreshOffline(progress: @Sendable @escaping (String, Double) -> Void = { _, _ in }) async {
        for entry in Offline.entries() {
            guard let item = try? await resolve(entry.id) else { continue }
            if item.isFolder || item.node.trashedAt != nil { Offline.forget(entry.id); continue }
            if Offline.localCopy(of: item) == nil { try? await keepDownloaded(item) { progress(entry.id, $0) } }
        }
    }
}
