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

    /* The upload and keep queue's folder: its records, each upload's plaintext and sealed parts, each keep's chunks. */
    public static var transfers: URL { group.appendingPathComponent("transfers", isDirectory: true) }

    /* The lists the app and its extensions share, as JSON: the group's defaults are a plist that backups take. */
    static var state: URL { group.appendingPathComponent("state", isDirectory: true) }

    /*
     * Files that are not lists the account shares between processes: the parents index, the
     * owner record, the mirror and its side files, and the settings marks. Made marked, so
     * whatever is written in it later is covered by the folder's mark.
     */
    static var local: URL { folder(group.appendingPathComponent("local", isDirectory: true)) }

    /*
     * Makes a folder (with its parents) and keeps it, and everything that will be put in it, out
     * of backups, under an explicit file protection class (see `protection`).
     */
    @discardableResult
    public static func folder(_ url: URL) -> URL {
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.protectionKey: protection])
        exclude(url)
        protect(url)
        return url
    }

    /*
     * The protection class for everything here, stated rather than left to the default. Not
     * `.complete`: the background URLSession reads sealed parts from `transfers` and finishes
     * keeps into `offline` while the phone is locked, the queue relaunches the app in the
     * background to complete them, and the Files extension and background refresh read the
     * mirror; all of that would fail once the keys are evicted at lock. So the files are
     * unreadable from boot until the first unlock, and readable after it.
     */
    public static let protection = FileProtectionType.completeUntilFirstUserAuthentication

    /*
     * A file moved into one of these folders keeps the class it was made with (a move carries its
     * attributes): the queue's plaintext, moved in from a picker's copy, is given the folder's class.
     */
    public static func protectFile(_ url: URL) { protect(url) }

    /* Sets the class on one item; files made in a folder later take the folder's class. */
    static func protect(_ url: URL) {
        let files = FileManager.default
        guard (try? files.attributesOfItem(atPath: url.path)[.protectionKey] as? FileProtectionType) != protection else { return }
        try? files.setAttributes([.protectionKey: protection], ofItemAtPath: url.path)
    }

    /* The class on a folder and everything already in it, for what an earlier version wrote without one. */
    static func protectAll(_ url: URL) {
        protect(url)
        guard let walk = FileManager.default.enumerator(at: url, includingPropertiesForKeys: nil) else { return }
        for case let item as URL in walk { protect(item) }
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
            if files.fileExists(atPath: url.path) {
                exclude(url)
                protectAll(url)
            }
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
 * Plaintext a temporary folder can be left holding, which iOS empties when it likes rather
 * than when the app would. Run at launch of the app and of the Files extension, before
 * anything new is written there, so nothing found belongs to work in flight:
 * - always removed: a recovery kit a share sheet never finished with (the phrase in plain
 *   text), uploads staged from a picker or the camera (`<uuid>/<name>`, `picked-*`) that a
 *   name prompt or a quit left behind, and the working folders of a copy (`copy-*`) or a
 *   save from a link (`save-*`);
 * - removed after a day: files opened (`opened/`), fetched through a link (`links/`), and the
 *   Files extension's decrypted downloads and their partials (`downloads/`), each
 *   `<node>/<version>/<file>`, which a reopen within the day reuses; a family folder's opened
 *   copies are `opened/family/<workspace>/<node>/<version>/<file>` (`openedFolder`).
 */
public enum TemporaryCopies {
    static let maxAge: TimeInterval = 24 * 3600

    static let alwaysPrefixes = ["kit-", "picked-", "copy-", "save-"]
    static let cachedFolders = ["opened", "links", "downloads"]

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
            if alwaysPrefixes.contains(where: name.hasPrefix) || UUID(uuidString: name) != nil {
                try? files.removeItem(at: entry)
                continue
            }
            guard cachedFolders.contains(name) else { continue }
            // <folder>/<node>/<version>/<file>: a version's folder is as old as the copy in it.
            func sweepNodes(_ folder: URL) {
                for node in contents(folder) {
                    for version in contents(node) where old(version) { try? files.removeItem(at: version) }
                    if contents(node).isEmpty { try? files.removeItem(at: node) }
                }
            }
            for node in contents(entry) {
                // opened/family/<workspace>/<node>/<version>/<file>: the same, a workspace at a time.
                if name == "opened", node.lastPathComponent == familyFolder {
                    for workspace in contents(node) {
                        sweepNodes(workspace)
                        if contents(workspace).isEmpty { try? files.removeItem(at: workspace) }
                    }
                    continue
                }
                for version in contents(node) where old(version) { try? files.removeItem(at: version) }
                if contents(node).isEmpty { try? files.removeItem(at: node) }
            }
        }
    }

    /*
     * Where an opened copy of an item goes: `opened/<item>/<version>/`, and a family folder's item
     * under its workspace, `opened/family/<workspace>/<item>/<version>/`, so forgetting the family
     * removes every copy of it whatever this session listed. Nil for a family workspace id that
     * isn't a UUID: no copy is made where it couldn't be found again.
     */
    public static func openedFolder(itemId: String, version: String, familyWorkspace: String?,
                                    in temporary: URL = FileManager.default.temporaryDirectory) -> URL? {
        let opened = temporary.appendingPathComponent("opened", isDirectory: true)
        if let familyWorkspace {
            guard let workspace = UUID(uuidString: familyWorkspace) else { return nil }
            return opened.appendingPathComponent(familyFolder, isDirectory: true).appendingPathComponent(workspace.uuidString.lowercased(), isDirectory: true)
                .appendingPathComponent(itemId, isDirectory: true).appendingPathComponent(version, isDirectory: true)
        }
        return opened.appendingPathComponent(itemId, isDirectory: true).appendingPathComponent(version, isDirectory: true)
    }

    /*
     * Every opened copy of these family folders, gone (a family forgotten on this phone): ids that
     * aren't UUIDs name none. Under the lock every family copy's writes take (`FamilyCopyGate`), and
     * each folder's forget generation moves: a download begun before never writes after.
     */
    public static func forgetFamily(_ workspaces: [String], in temporary: URL = FileManager.default.temporaryDirectory) {
        let family = temporary.appendingPathComponent("opened", isDirectory: true).appendingPathComponent(familyFolder, isDirectory: true)
        forgetLock.withLock {
            for id in workspaces {
                guard let workspace = UUID(uuidString: id) else { continue }
                let key = workspace.uuidString.lowercased()
                forgotten[key, default: 0] += 1
                try? FileManager.default.removeItem(at: family.appendingPathComponent(key, isDirectory: true))
            }
        }
    }

    static let forgetLock = NSLock()
    nonisolated(unsafe) static var forgotten: [String: UInt64] = [:]

    /*
     * A copy about to be made of an item, kept to the account's session now and, for a family
     * folder's, the family's forget generation (FamilyCopyGate). Taken before anything is awaited
     * for it (the version, its address), so a session that ends meanwhile is seen.
     */
    public static func copyGate(familyWorkspace: String?, account: CopyEpoch = .process) -> FamilyCopyGate {
        forgetLock.withLock {
            let epoch = account.value
            guard let familyWorkspace, let workspace = UUID(uuidString: familyWorkspace) else {
                return FamilyCopyGate(workspace: nil, generation: 0, account: account, epoch: epoch)
            }
            let key = workspace.uuidString.lowercased()
            return FamilyCopyGate(workspace: key, generation: forgotten[key, default: 0], account: account, epoch: epoch)
        }
    }

    /*
     * The account's session ended (sign-out, deletion, a removal, a lost session, another account in):
     * under the lock every copy's writes take, so a download begun before, family or personal, never
     * writes again, even one still waiting on its address. Before anything is wiped.
     */
    public static func endAccount(_ account: CopyEpoch = .process) {
        forgetLock.withLock { account.value &+= 1 }
    }

    /* `opened/family/`: family folders' copies by workspace; never an item id (those are UUIDs). */
    static let familyFolder = "family"

    static let ownerMarker = "account-owner"

    /*
     * This process's temporary folder holds decrypted copies (opened files, Files' downloads not
     * moved into place yet) and records whose they are. Another account in, or nobody: all of it
     * goes before anything is answered, so one account's copies are never served to the next.
     * Each process runs it for its own folder: the app at sign-in, the Files extension whenever
     * the account it serves changes. A marker an older version wrote (a bare user id) is no owner.
     */
    public static func claim(_ owner: AccountOwner?, in temporary: URL = FileManager.default.temporaryDirectory, account: CopyEpoch = .process) {
        let files = FileManager.default
        let marker = temporary.appendingPathComponent(ownerMarker)
        let recorded = (try? Data(contentsOf: marker)).flatMap { try? JSONDecoder().decode(AccountOwner.self, from: $0) }
        if let owner, recorded == owner { return }
        // A download the last account began writes nothing into the folder emptied here.
        endAccount(account)
        for item in (try? files.contentsOfDirectory(at: temporary, includingPropertiesForKeys: nil)) ?? [] {
            try? files.removeItem(at: item)
        }
        guard let owner, let data = try? JSONEncoder().encode(owner) else { return }
        try? files.createDirectory(at: temporary, withIntermediateDirectories: true)
        try? data.write(to: marker, options: .atomic)
    }
}

/*
 * Which session of the account a copy belongs to: moved under the copies' lock whenever the
 * session ends (TemporaryCopies.endAccount). The process's own in the app, a test's own in a test.
 */
public final class CopyEpoch: @unchecked Sendable {
    public static let process = CopyEpoch()
    /* Read and moved only under TemporaryCopies.forgetLock. */
    var value: UInt64 = 0
    public init() {}
}

/*
 * An item's plaintext copy, kept to the session it was begun in and, for a family item, the
 * family it was begun under: making its folder, writing each chunk and moving it into place run
 * under the lock a sign-out and forgetting a family move under, and only while neither happened
 * since, so a wipe that lands mid-download leaves nothing behind and nothing is handed on.
 */
public struct FamilyCopyGate: Sendable {
    let workspace: String?
    let generation: UInt64
    let account: CopyEpoch
    let epoch: UInt64

    /* `body` under the copies' lock, while the session and the family stand; refused when either ended since. */
    public func perform<T>(_ body: () throws -> T) throws -> T {
        try TemporaryCopies.forgetLock.withLock {
            guard account.value == epoch else { throw CancellationError() }
            if let workspace, TemporaryCopies.forgotten[workspace, default: 0] != generation { throw FamilyFailure(message: FamilyWords.openAgain) }
            return try body()
        }
    }

    /* Whether the copy may still be handed on: throws when its family was forgotten since. */
    public func check() throws { try perform {} }
}
