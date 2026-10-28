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
    /* What this process raised of the rollback marks: the process's own in the app, a store's own in a test. */
    let marksFloor: MarkFloor

    /* Under the group container: kept files, the queue's copies, Save to HushOS's staged copies, the
     * lists of kept files, the last folder, recent searches and the last email (`Unbacked.state`), the
     * node-to-parent index, the families' records, and the rollback marks (sealed, and the plaintext
     * files earlier versions kept across sign-outs): a phone signed back in trusts the server as a new
     * device does, the cost the web accepted too (docs/integrity-design.md, "Rollback marks"). */
    static let accountFiles = [
        "offline", "transfers", "share-staging", "state", "local/files-parents.json", "local/groups", "local/marks",
        "local/settings-marks.json", "local/settings-marks.json.lock", "local/identity-marks.json", "local/identity-marks.json.lock",
    ]

    private var ownerFile: URL { root.appendingPathComponent("local/account-owner") }

    init(root: URL, temporary: URL, marksFloor: MarkFloor = MarkFloor(), forgetStores: @escaping @Sendable () -> Void = {}) {
        self.root = root
        self.temporary = temporary
        self.marksFloor = marksFloor
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

    /*
     * Sign-out, account deletion, a removal, and another account's sign-in: every account file,
     * decrypted or not, and the owner. The families' join checks (`local/groups/<user>_<group>.holds`)
     * go too, as the web's do (owner, 2026-10-28): kept, their names said which account and family
     * used the phone. The cost, recorded and accepted: a server that falsely answers "removed" resets
     * a join's escalation on this phone (docs/groups-mobile-plan.md).
     */
    public func wipe() {
        let files = FileManager.default
        // Under the marks' lock, so a raise from before the sign-out can't write them back after.
        RollbackMarkStore(folder: root.appendingPathComponent("local/marks", isDirectory: true), floor: marksFloor).deleteAll()
        for name in Self.accountFiles { try? files.removeItem(at: root.appendingPathComponent(name)) }
        for item in (try? files.contentsOfDirectory(at: temporary, includingPropertiesForKeys: nil)) ?? [] {
            try? files.removeItem(at: item)
        }
        forgetStores()
        try? files.removeItem(at: ownerFile)
    }

    /* The server says this phone was removed from the account: the same as a sign-out. */
    public func wipeAfterRemoval() { wipe() }

    private func record(_ owner: AccountOwner) {
        try? FileManager.default.createDirectory(at: ownerFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONEncoder().encode(owner).write(to: ownerFile, options: .atomic)
    }

    /* This app's (or extension's) store: the group container, its temporary folder, and the stores behind them. */
    public static var shared: AccountStore {
        let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedKeychain.accessGroup)
            ?? FileManager.default.temporaryDirectory.appendingPathComponent("group", isDirectory: true)
        return AccountStore(root: group, temporary: FileManager.default.temporaryDirectory, marksFloor: .process) {
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
