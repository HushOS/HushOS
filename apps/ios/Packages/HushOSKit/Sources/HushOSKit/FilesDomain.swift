import Foundation
#if canImport(FileProvider)
import FileProvider
#endif

/*
 * Whose the Files location is: the account (user id and server) it was added for, in the
 * group's `local` folder so the app and both Files extensions read the same record. Every
 * account shares one domain identifier, and a domain keeps what Files cached and what it has
 * not synced yet (a folder made offline, a file saved into it), so a domain is only ever
 * answered for, or written from, by the account it was added for.
 */
public struct FilesDomainOwner: Sendable {
    let file: URL

    public init(file: URL) { self.file = file }

    public static var shared: FilesDomainOwner {
        FilesDomainOwner(file: Unbacked.local.appendingPathComponent("files-domain-owner.json"))
    }

    /* The account the location was added for; nil when none is recorded (added by an older version, or never). */
    public func read() -> AccountOwner? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        return try? JSONDecoder().decode(AccountOwner.self, from: data)
    }

    func write(_ owner: AccountOwner) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(owner).write(to: file, options: .atomic)
    }

    func clear() { try? FileManager.default.removeItem(at: file) }

    /* What signing in does with the location. */
    public enum Plan: Equatable, Sendable {
        /* The same account's location: kept, with what Files cached and what it has yet to sync. */
        case keep
        /* Another account's, or nobody's on record: removed with everything in it, then added anew. */
        case replace
        /* None yet. */
        case add
    }

    public static func plan(domainExists: Bool, recorded: AccountOwner?, signingIn: AccountOwner) -> Plan {
        guard domainExists else { return .add }
        return recorded == signingIn ? .keep : .replace
    }

    /*
     * The Files extension's check before it lists, reads or writes anything: the session in
     * the keychain must belong to the account the location was added for. Signed out, a
     * location nobody is recorded as owning, or one added for another account (a sign-in to
     * someone else, here or from the Files sheet, before the app has replaced it): refused,
     * so what Files holds for one account is never sent under another's session.
     */
    public static func admit(recorded: AccountOwner?, session: SharedKeychain.Session?) -> SharedKeychain.Session? {
        guard let session, let recorded, recorded == AccountOwner(session) else { return nil }
        return session
    }
}

#if canImport(FileProvider)
/*
 * The extension's way to its vault: admitted by `FilesDomainOwner.admit` on every call, so a
 * vault made for one account is never handed out once the location or the session belongs to
 * another. `changed` runs whenever the account served changes (nil: nobody is), before
 * anything is answered, so the extension can drop what it decrypted for the last one.
 */
public final class FilesGate<Value>: @unchecked Sendable {
    private let owner: () -> AccountOwner?
    private let session: () -> SharedKeychain.Session?
    private let make: (SharedKeychain.Session) -> Value?
    private let changed: (AccountOwner?) -> Void
    private let lock = NSLock()
    private var cached: (session: SharedKeychain.Session, value: Value)?

    public init(owner: @escaping () -> AccountOwner?, session: @escaping () -> SharedKeychain.Session?,
                changed: @escaping (AccountOwner?) -> Void = { _ in }, make: @escaping (SharedKeychain.Session) -> Value?) {
        self.owner = owner
        self.session = session
        self.changed = changed
        self.make = make
    }

    public func open() throws -> Value {
        lock.lock()
        defer { lock.unlock() }
        guard let admitted = FilesDomainOwner.admit(recorded: owner(), session: session()) else {
            if cached != nil { cached = nil }
            changed(nil)
            throw NSFileProviderError(.notAuthenticated)
        }
        if let cached, cached.session == admitted { return cached.value }
        cached = nil
        changed(AccountOwner(admitted))
        guard let value = make(admitted) else { throw NSFileProviderError(.notAuthenticated) }
        cached = (admitted, value)
        return value
    }
}

/* The HushOS location in the Files app: one replicated domain, added at sign-in for that account and removed at sign-out. */
public enum FilesDomain {
    public static let identifier = NSFileProviderDomainIdentifier("com.hushos.app.drive")

    /*
     * The location for `owner`, who just signed in (or was found signed in at launch). The
     * same account's location is kept, so what Files cached stays. Anyone else's, or one
     * nobody is recorded as owning, is removed with `.removeAll` first: what Files holds in it
     * (cached files, folders made offline, edits not synced) belongs to that account, and a
     * reimport would hand it to this one's extension to create in this one's drive. The new
     * owner is recorded only once the old location is gone, so the extension refuses the old
     * one's pending work until then.
     *
     * A new domain on iOS starts disabled until the person turns it on in Files (Browse, the
     * ... menu, Edit). Simulator debug builds skip that step through the testing mode, which
     * needs the testing-mode entitlement the app carries.
     */
    public static func register(for owner: AccountOwner, record: FilesDomainOwner = .shared) async {
        // Unknown is not "none": adding over a domain that exists would keep it, whatever it holds.
        guard let existing = try? await NSFileProviderManager.domains() else { return }
        let ours = existing.first { $0.identifier == identifier }
        switch FilesDomainOwner.plan(domainExists: ours != nil, recorded: record.read(), signingIn: owner) {
        case .keep:
            await signedIn()
            return
        case .replace:
            guard let ours, await removeAll(ours) else { return }
        case .add:
            break
        }
        for stale in existing where stale.identifier != identifier { _ = await removeAll(stale) }
        guard (try? record.write(owner)) != nil else { return }
        let domain = NSFileProviderDomain(identifier: identifier, displayName: "HushOS")
        #if DEBUG && targetEnvironment(simulator)
        domain.testingModes = .alwaysEnabled
        #endif
        try? await NSFileProviderManager.add(domain)
        await signedIn()
    }

    /*
     * Someone signed in: Files paused the location ("Syncing with HushOS Paused", read only) when
     * the extension refused with `.notAuthenticated`, and resumes it only when told the error is
     * resolved. Then everything is listed again, so Files shows the folders without a pull.
     */
    private static func signedIn() async {
        let domain = NSFileProviderDomain(identifier: identifier, displayName: "HushOS")
        if let manager = NSFileProviderManager(for: domain) {
            try? await manager.signalErrorResolved(NSFileProviderError(.notAuthenticated))
        }
        signal()
    }

    /*
     * Sign-out and account deletion: the location goes, and with it every copy Files kept of
     * the account's files. The record goes only with it: a location that failed to go stays
     * its account's, refused to anyone else.
     */
    public static func remove(record: FilesDomainOwner = .shared) async {
        if await removeAll(NSFileProviderDomain(identifier: identifier, displayName: "HushOS")) { record.clear() }
    }

    /* Removes a domain and everything Files kept in it; whether it went. (`.removeAll` preserves nothing, so its URL is always nil.) */
    private static func removeAll(_ domain: NSFileProviderDomain) async -> Bool {
        do {
            _ = try await NSFileProviderManager.remove(domain, mode: .removeAll)
            return true
        } catch {
            return false
        }
    }

    /* Tells Files something changed; it re-enumerates through the change feed. */
    public static func signal(folderId: String? = nil) {
        let domain = NSFileProviderDomain(identifier: identifier, displayName: "HushOS")
        guard let manager = NSFileProviderManager(for: domain) else { return }
        manager.signalEnumerator(for: .workingSet) { _ in }
        manager.signalEnumerator(for: .rootContainer) { _ in }
        if let folderId { manager.signalEnumerator(for: NSFileProviderItemIdentifier(folderId)) { _ in } }
    }
}
#endif
