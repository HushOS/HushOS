import Foundation

/*
 * What stays on this phone and out of iCloud and computer backups: decrypted files (kept
 * copies, uploads waiting in the queue, Save to HushOS's staging) and the names and ids
 * that describe the drive (the kept and failed lists, the last folder, recent searches,
 * the queue's records, the parents index, the mirror). A backup takes the app group
 * container and the app's Library unless an item is marked, and a restore can drop the
 * mark, so each top folder is marked when it is made and `apply()` marks everything again
 * at every launch of the app and of each extension. Only folders are marked: an atomic
 * write replaces a file and its mark with it, and SQLite makes its side files when it
 * likes, so loose files (the parents index, the owner, the mirror) live in `local`.
 */
public enum Unbacked {
    static var group: URL {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedKeychain.accessGroup)
            ?? FileManager.default.temporaryDirectory
    }

    /* The app group's folders that hold any of it. */
    static let names = ["offline", "transfers", "share-staging", "state", "local"]

    /* Loose files that once sat at the top of the group, unmarked after any atomic write; moved into `local` once. */
    static let looseFiles = ["files-parents.json", "account-owner", "mirror.sqlite", "mirror.sqlite-wal", "mirror.sqlite-shm"]

    /* The lists the app and its extensions share, as JSON: the group's defaults are a plist that backups take. */
    static var state: URL { group.appendingPathComponent("state", isDirectory: true) }

    /*
     * Files that are not lists the account shares between processes: the parents index, the
     * owner record, the mirror and its side files, and the settings marks. Made marked, so
     * whatever is written in it later is covered by the folder's mark.
     */
    static var local: URL { folder(group.appendingPathComponent("local", isDirectory: true)) }

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
        moveLooseFiles(in: group)
        migrate()
    }

    /*
     * The loose files an earlier version kept at the top of the group, moved into `local` once:
     * the mirror with its side files together, or not at all (a half-moved database is worse than
     * a rebuilt one, which is all a mirror lost here costs).
     */
    static func moveLooseFiles(in group: URL) {
        let files = FileManager.default
        let local = folder(group.appendingPathComponent("local", isDirectory: true))
        for name in looseFiles {
            let old = group.appendingPathComponent(name)
            guard files.fileExists(atPath: old.path) else { continue }
            let new = local.appendingPathComponent(name)
            if files.fileExists(atPath: new.path) || (try? files.moveItem(at: old, to: new)) == nil {
                try? files.removeItem(at: old)
            }
        }
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
        if let email = UserDefaults.standard.string(forKey: "lastEmail") {
            if LastEmail.load() == nil { LastEmail.save(email) }
            UserDefaults.standard.removeObject(forKey: "lastEmail")
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

/* The address the sign-in screen offers again: the account's, so out of backups and gone with the account. */
public enum LastEmail {
    static let file = "last-email.json"

    public static func load() -> String? { Unbacked.read(String.self, file) }

    public static func save(_ email: String?) { Unbacked.write(email?.isEmpty == false ? email : nil, file) }
}

/*
 * Plaintext the app's temporary folder can be left holding, which iOS empties when it likes
 * rather than when the app would: a recovery kit a share sheet never finished with (always
 * removed, it is the phrase in plain text), and files opened, or fetched through a link, more
 * than a day ago. Run at launch, before anything new is written there.
 */
public enum TemporaryCopies {
    static let maxAge: TimeInterval = 24 * 3600

    public static func sweep(in temporary: URL = FileManager.default.temporaryDirectory, now: Date = Date()) {
        let files = FileManager.default
        func contents(_ url: URL) -> [URL] {
            (try? files.contentsOfDirectory(at: url, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        }
        func old(_ url: URL) -> Bool {
            let touched = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return now.timeIntervalSince(touched) > maxAge
        }
        for entry in contents(temporary) {
            let name = entry.lastPathComponent
            if name.hasPrefix("kit-") { try? files.removeItem(at: entry); continue }
            guard name == "opened" || name == "links" else { continue }
            // opened/<node>/<version>/<file>: a version's folder is as old as the copy in it.
            for node in contents(entry) {
                for version in contents(node) where old(version) { try? files.removeItem(at: version) }
                if contents(node).isEmpty { try? files.removeItem(at: node) }
            }
        }
    }
}
