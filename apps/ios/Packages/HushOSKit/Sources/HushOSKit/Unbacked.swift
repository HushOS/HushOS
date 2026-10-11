import Foundation

/*
 * What stays on this phone and out of iCloud and computer backups: decrypted files (kept
 * copies, uploads waiting in the queue, Save to HushOS's staging) and the names and ids
 * that describe the drive (the kept and failed lists, the last folder, recent searches,
 * the queue's records, the parents index, the mirror). A backup takes the app group
 * container and the app's Library unless an item is marked, and a restore can drop the
 * mark, so each top folder is marked when it is made and `apply()` marks everything again
 * at every launch of the app and of each extension.
 */
public enum Unbacked {
    static var group: URL {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedKeychain.accessGroup)
            ?? FileManager.default.temporaryDirectory
    }

    /* The app group's items that hold any of it; the SQLite side files come and go with the mirror. */
    static let names = ["offline", "transfers", "share-staging", "state", "files-parents.json", "account-owner",
                        "mirror.sqlite", "mirror.sqlite-wal", "mirror.sqlite-shm"]

    /* The lists the app and its extensions share, as JSON: the group's defaults are a plist that backups take. */
    static var state: URL { group.appendingPathComponent("state", isDirectory: true) }

    /* Makes a folder (with its parents) and keeps it, and everything that will be put in it, out of backups. */
    @discardableResult
    public static func folder(_ url: URL) -> URL {
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        exclude(url)
        return url
    }

    public static func exclude(_ url: URL) {
        var url = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    /* At launch: the mark on everything that exists, and lists left in the defaults by an earlier version moved out. */
    public static func apply() {
        let files = FileManager.default
        for name in names {
            let url = group.appendingPathComponent(name)
            if files.fileExists(atPath: url.path) { exclude(url) }
        }
        migrate()
    }

    static func read<T: Decodable>(_ type: T.Type, _ name: String) -> T? {
        guard let data = try? Data(contentsOf: state.appendingPathComponent(name)) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    /* nil removes the file. */
    static func write<T: Encodable>(_ value: T?, _ name: String) {
        let url = state.appendingPathComponent(name)
        guard let value, let data = try? JSONEncoder().encode(value) else { try? FileManager.default.removeItem(at: url); return }
        folder(state)
        try? data.write(to: url, options: .atomic)
    }

    /* Kept-file lists and the last folder from the group's defaults, and recent searches from the app's. */
    private static func migrate() {
        let shared = Offline.defaults
        for (key, name) in [(Offline.key, Offline.entriesFile), (Offline.foldersKey, Offline.foldersFile), (Offline.failuresKey, Offline.failuresFile)] {
            guard let data = shared.data(forKey: key) else { continue }
            if !FileManager.default.fileExists(atPath: state.appendingPathComponent(name).path) {
                folder(state)
                try? data.write(to: state.appendingPathComponent(name), options: .atomic)
            }
            shared.removeObject(forKey: key)
        }
        if let id = shared.string(forKey: "places.lastFolder") {
            if Places.last() == nil { Places.used(id, name: shared.string(forKey: "places.lastFolderName") ?? "Files") }
            shared.removeObject(forKey: "places.lastFolder")
            shared.removeObject(forKey: "places.lastFolderName")
        }
        if let recent = UserDefaults.standard.string(forKey: "search.recent") {
            if RecentSearches.load().isEmpty { RecentSearches.save(recent.split(separator: "\n").map(String.init)) }
            UserDefaults.standard.removeObject(forKey: "search.recent")
        }
    }
}

/* The last few searches, newest first: the account's words, kept out of backups and gone with the account. */
public enum RecentSearches {
    static let file = "recent-searches.json"

    public static func load() -> [String] { Unbacked.read([String].self, file) ?? [] }

    public static func save(_ terms: [String]) { Unbacked.write(terms.isEmpty ? nil : terms, file) }
}
