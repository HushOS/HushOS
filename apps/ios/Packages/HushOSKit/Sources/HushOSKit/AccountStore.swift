import Foundation

/*
 * Everything this phone holds for one account (Android's AccountStore, the same rule):
 * decrypted files kept on the phone, the transfer queue's copies, the parents index, files
 * opened or fetched (the app's temporary folder: opened files, link files, recovery kits,
 * staged uploads), the tree mirror with its sealed thumbnails and documents, the remembered
 * device that opens the account key, and recent searches. It belongs to the account that
 * signed in, recorded by user id and server (`AccountOwner`) in the app group, and goes on
 * sign-out, on account deletion, and before a different account signs in, so nothing of one
 * account shows to the next: Home, On this phone, Search, the Files app. The same user id on
 * another server is a different account.
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

    /* Under the group container: kept files, the queue's copies, Save to HushOS's staged copies, the
     * lists of kept files, the last folder, recent searches and the last email (`Unbacked.state`), the
     * node-to-parent index. The settings marks in `local` stay: they belong to no account's data and
     * are what catches a server handing an account older settings after it signs in again. */
    static let accountFiles = ["offline", "transfers", "share-staging", "state", "local/files-parents.json"]

    private var ownerFile: URL { root.appendingPathComponent("local/account-owner") }

    init(root: URL, temporary: URL, forgetStores: @escaping @Sendable () -> Void = {}) {
        self.root = root
        self.temporary = temporary
        self.forgetStores = forgetStores
    }

    /* What the owner file says: nothing, a bare user id (an older version, no server), or the account. */
    private enum Recorded: Equatable {
        case none
        case legacy(String)
        case owner(AccountOwner)
    }

    private func recorded() -> Recorded {
        guard let data = try? Data(contentsOf: ownerFile) else { return .none }
        if let owner = try? JSONDecoder().decode(AccountOwner.self, from: data) { return .owner(owner) }
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? .none : .legacy(text.lowercased())
    }

    /* The account whose data is on the phone, or nil when none is recorded (or only a user id, without its server). */
    public func owner() -> AccountOwner? {
        if case let .owner(owner) = recorded() { return owner }
        return nil
    }

    /*
     * Before `owner` signs in: another account's data (another user, or the same user id on
     * another server), or data nobody is recorded as owning (kept before this store existed,
     * or recorded without its server), is removed first. The same account signing in again
     * (after its session ended) keeps what it kept. Returns whether anything was removed.
     */
    @discardableResult
    public func claim(_ owner: AccountOwner) -> Bool {
        let other = recorded() != .owner(owner)
        if other { wipe() }
        record(owner)
        return other
    }

    /*
     * A session already signed in when this store first runs: its data is its own, and an
     * older version's bare user id is completed with the server. Anything recorded for
     * another account is claimed (removed) instead.
     */
    public func adopt(_ owner: AccountOwner) {
        switch recorded() {
        case .none:
            record(owner)
        case let .legacy(userId) where userId == owner.userId:
            record(owner)
        case let .owner(existing) where existing == owner:
            break
        default:
            claim(owner)
        }
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

    private func record(_ owner: AccountOwner) {
        try? FileManager.default.createDirectory(at: ownerFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONEncoder().encode(owner).write(to: ownerFile, options: .atomic)
    }

    /* This app's (or extension's) store: the group container, its temporary folder, and the stores behind them. */
    public static var shared: AccountStore {
        let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedKeychain.accessGroup)
            ?? FileManager.default.temporaryDirectory.appendingPathComponent("group", isDirectory: true)
        return AccountStore(root: group, temporary: FileManager.default.temporaryDirectory) {
            Offline.forgetAll()
            Places.forget()
            // Emptied and vacuumed, so ids and sealed rows don't linger in free pages or the WAL.
            Mirror(url: Unbacked.local.appendingPathComponent("mirror.sqlite"))?.wipe()
            // The remembered device opens this account's key; the next account makes its own.
            SharedKeychain.delete(SharedKeychain.deviceAccount)
            // The device key belongs to this account's device row; another account makes its own.
            SharedKeychain.delete(SharedKeychain.deviceIdentityAccount)
            // What an earlier version kept in the defaults: recent searches and the address the sign-in screen offers.
            UserDefaults.standard.removeObject(forKey: "search.recent")
            UserDefaults.standard.removeObject(forKey: "lastEmail")
        }
    }
}
