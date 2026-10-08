import Foundation

/*
 * Everything this phone holds for one account (Android's AccountStore, the same rule):
 * decrypted files kept on the phone, the transfer queue's copies, the parents index, files
 * opened or fetched (the app's temporary folder: opened files, link files, recovery kits,
 * staged uploads), the tree mirror with its sealed thumbnails and documents, the remembered
 * device that opens the account key, and recent searches. It belongs to the account that
 * signed in, recorded by user id in the app group, and goes on sign-out, on account
 * deletion, and before a different account signs in, so nothing of one account shows to
 * the next: Home, On this phone, Search, the Files app.
 *
 * Plain directories and a closure for the rest, so a test can hold the rule to the files.
 */
public struct AccountStore: Sendable {
    /* The app group container: shared with the Files extensions. */
    let root: URL
    /* This process's temporary folder. */
    let temporary: URL
    /* What lives outside files: preferences, the keychain, SQLite. */
    let forgetStores: @Sendable () -> Void

    /* Under the group container: kept files, the queue's copies, the node-to-parent index. */
    static let accountFiles = ["offline", "transfers", "files-parents.json"]

    private var ownerFile: URL { root.appendingPathComponent("account-owner") }

    init(root: URL, temporary: URL, forgetStores: @escaping @Sendable () -> Void = {}) {
        self.root = root
        self.temporary = temporary
        self.forgetStores = forgetStores
    }

    /* The account whose data is on the phone, or nil when none is recorded. */
    public func owner() -> String? {
        guard let text = try? String(contentsOf: ownerFile, encoding: .utf8) else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /*
     * Before `userId` signs in: another account's data, or data nobody is recorded as owning
     * (kept before this store existed), is removed first. The same account signing in again
     * (after its session ended) keeps what it kept. Returns whether anything was removed.
     */
    @discardableResult
    public func claim(_ userId: String) -> Bool {
        let owner = owner()
        let other = owner == nil || owner?.caseInsensitiveCompare(userId) != .orderedSame
        if other { wipe() }
        record(userId)
        return other
    }

    /* A session already signed in when this store first runs: its data is its own. */
    public func adopt(_ userId: String) {
        if owner() == nil { record(userId) }
    }

    /* Sign-out and account deletion: every account file, decrypted or not, and the owner. */
    public func wipe() {
        let files = FileManager.default
        for name in Self.accountFiles { try? files.removeItem(at: root.appendingPathComponent(name)) }
        for item in (try? files.contentsOfDirectory(at: temporary, includingPropertiesForKeys: nil)) ?? [] {
            try? files.removeItem(at: item)
        }
        forgetStores()
        try? files.removeItem(at: ownerFile)
    }

    private func record(_ userId: String) {
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try? Data(userId.utf8).write(to: ownerFile, options: .atomic)
    }

    /* This app's (or extension's) store: the group container, its temporary folder, and the stores behind them. */
    public static var shared: AccountStore {
        let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedKeychain.accessGroup)
            ?? FileManager.default.temporaryDirectory.appendingPathComponent("group", isDirectory: true)
        return AccountStore(root: group, temporary: FileManager.default.temporaryDirectory) {
            Offline.forgetAll()
            Places.forget()
            // Emptied and vacuumed, so ids and sealed rows don't linger in free pages or the WAL.
            Mirror(url: group.appendingPathComponent("mirror.sqlite"))?.wipe()
            // The remembered device opens this account's key; the next account makes its own.
            SharedKeychain.delete(SharedKeychain.deviceAccount)
            // Recent searches and the address the sign-in screen offers.
            UserDefaults.standard.removeObject(forKey: "search.recent")
            UserDefaults.standard.removeObject(forKey: "lastEmail")
        }
    }
}
