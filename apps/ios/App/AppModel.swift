import Foundation
import HushOSKit
import Observation
import UIKit

/*
 * Who is signed in and the vault that opens their drive. The session lives in
 * the shared keychain so the Files extensions see the same one; signing in
 * registers the Files location for that account (replacing another account's)
 * and signing out removes it. Links that open the app wait here until someone is
 * signed in to act on them.
 */
@Observable
@MainActor
final class AppModel {
    enum State: Equatable { case checking, signedOut, signedIn, deleted }

    /* The simulator talks to the dev server on this Mac; a real phone talks to production unless the person changes it. */
    #if targetEnvironment(simulator)
    static let defaultOrigin = "http://localhost:5173"
    #else
    static let defaultOrigin = "https://hushos.com"
    #endif

    private(set) var state: State = .checking
    private(set) var user: SessionUser?
    private(set) var vault: Vault?
    /* The account this model shows (user id and server), to notice a sign-in to another one from the Files sheet. */
    private var owner: AccountOwner?
    var origin: String = SharedKeychain.config?.origin ?? AppModel.defaultOrigin
    /* The last address signed in with, so a sign-in after the session ended starts filled; out of backups (the defaults are not). */
    var lastEmail = LastEmail.load() ?? UserDefaults.standard.string(forKey: "lastEmail") ?? "" {
        didSet { LastEmail.save(lastEmail) }
    }
    /* A link that opened the app; acted on once signed in (or right away if already). */
    var pendingLink: URL?
    /* This phone was removed from the account on another device: sign-in says so, until someone signs in. */
    var removedNotice = false
    private var checkingRemoval = false
    /* Bumped as every sign-in starts: a removal check answered after it clears nothing. */
    private var signInGeneration = 0
    /* A removal wipe under way: a sign-in waits for it, so the wipe never takes the new session. */
    private var wiping: Task<Void, Never>?

    struct OriginProblem: Error { let message: String }

    /*
     * A server address as typed: a bare host gets https://, a trailing slash goes. Only https,
     * except plain http to this Mac or the local network in a debug build (a dev server).
     */
    static func checkedOrigin(_ typed: String) -> Result<String, OriginProblem> {
        // Android's three messages, word for word.
        let notAddress = OriginProblem(message: "That isn’t a web address. It looks like https://hush.example.org.")
        var value = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasSuffix("/") { value.removeLast() }
        if !value.contains("://") { value = "https://" + value }
        guard !value.contains(where: \.isWhitespace), let url = URL(string: value), let host = url.host(), !host.isEmpty,
              host.contains(".") || host == "localhost" else { return .failure(notAddress) }
        guard url.path().isEmpty || url.path() == "/", url.query() == nil, url.fragment() == nil else {
            return .failure(OriginProblem(message: "Use just the server’s address, without a path, like https://hush.example.org."))
        }
        switch url.scheme?.lowercased() {
        case "https":
            return .success(value)
        case "http":
            #if DEBUG
            if isLocal(host) { return .success(value) }
            #endif
            return .failure(OriginProblem(message: "Use an address that starts with https://."))
        default:
            return .failure(notAddress)
        }
    }

    /* This Mac or the local network: localhost, .local names and private IPv4 ranges. */
    static func isLocal(_ host: String) -> Bool {
        if host == "localhost" || host.hasSuffix(".local") || host.hasPrefix("127.") || host.hasPrefix("10.") || host.hasPrefix("192.168.") { return true }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        return parts.count == 4 && parts[0] == 172 && (16...31).contains(parts[1])
    }

    /* The server's host, for "Signing in to …" when it isn't HushOS's own. */
    var selfHostedName: String? {
        guard origin != AppModel.defaultOrigin else { return nil }
        return URL(string: origin)?.host() ?? origin
    }

    func start() async {
        do {
            let check = try await Auth.checkSession()
            if case let .signedIn(user, device) = check, let session = SharedKeychain.session {
                // Signed in before the store recorded owners: what is on the phone is this account's (another's goes).
                AccountStore.shared.adopt(AccountOwner(session))
                signedIn(user)
                // A session from before devices describes this phone and gets its key.
                if let device { Task { try? await Auth.registerDevice(if: device, userId: user.id, email: user.email) } }
                return
            }
            if check == .removed {
                await forgetRemovedDevice()
                removedNotice = true
                return
            }
        } catch {
            // Offline: keep the stored session and try the drive anyway.
            if SharedKeychain.session != nil, let session = SharedKeychain.session {
                user = SessionUser(id: session.userId, name: "", email: "", credentialVersion: 0, role: "member")
                vault = Vault.fromKeychain()
                owner = AccountOwner(session)
                state = .signedIn
                return
            }
        }
        state = .signedOut
    }

    func signIn(email: String, password: String) async throws {
        removedNotice = false
        signInGeneration += 1
        await wiping?.value
        let previous = AccountStore.shared.owner()
        // Auth.signIn removes another account's data (AccountStore.claim) before the new session is stored.
        let user = try await Auth.signIn(origin: origin, email: email, password: password)
        await anotherAccount(since: previous)
        signedIn(user)
    }

    /*
     * Another account (or the same user id on another server) than the one whose data was on
     * the phone: the queue's transfers were its, and stop. The Files location is replaced by
     * `signedIn` (FilesDomain.register), never reimported: a reimport hands what Files cached
     * for the last account to this one's extension, which would create it in this drive.
     */
    private func anotherAccount(since previous: AccountOwner?) async {
        guard previous != AccountOwner.signedIn else { return }
        await BackgroundTransfers.shared.cancelAll()
        TransferNotices.shared.clear()
    }

    private func signedIn(_ user: SessionUser) {
        // The queue opens its own vault from the keychain until the drive hands it the new one.
        BackgroundTransfers.shared.vault = nil
        self.user = user
        if !user.email.isEmpty { lastEmail = user.email }
        vault = Vault.fromKeychain()
        owner = AccountOwner.signedIn
        // Decrypted copies this process kept for another account go before this one opens anything.
        TemporaryCopies.claim(owner)
        state = .signedIn
        if let owner { Task { await FilesDomain.register(for: owner) } }
    }

    /*
     * Back on screen: someone may have signed in from the Files sheet meanwhile (another
     * account, or the session ended). The drive this model shows is that account's no longer,
     * so it starts again from the keychain: the new account's drive and Files location, or
     * sign-in.
     */
    func checkAccount() async {
        guard state == .signedIn, let owner, AccountOwner.signedIn != owner else { return }
        user = nil
        vault = nil
        self.owner = nil
        state = .checking
        await start()
    }

    func signOut() async {
        await BackgroundTransfers.shared.cancelAll()
        await Auth.signOut()
        await FilesDomain.remove()
        // Everything of the account on this phone: kept and opened files, the mirror, the device key, searches.
        AccountStore.shared.wipe()
        TransferNotices.shared.clear()
        // The families' sync and its ledger keys go with the session.
        FamilySync.forget()
        lastEmail = ""
        user = nil
        vault = nil
        owner = nil
        state = .signedOut
    }

    func setUser(_ user: SessionUser) { self.user = user }

    /* After deletion there is nothing left on the server; forget the Files location too, and say so. */
    func deleted() async {
        await FilesDomain.remove()
        SharedKeychain.delete(SharedKeychain.sessionAccount)
        AccountStore.shared.wipe()
        TransferNotices.shared.clear()
        FamilySync.forget()
        user = nil
        vault = nil
        owner = nil
        lastEmail = ""
        state = .deleted
    }

    func leaveDeleted() { state = .signedOut }

    /*
     * The session died under us (a 401): back to sign-in with the address filled, Files location
     * left until then. If it died because this phone was removed from the account, everything of
     * the account on the phone goes as well, as on sign-out.
     */
    func sessionLost() {
        if let email = user?.email, !email.isEmpty { lastEmail = email }
        let ended = SharedKeychain.session
        SharedKeychain.delete(SharedKeychain.sessionAccount)
        user = nil
        vault = nil
        owner = nil
        state = .signedOut
        if let ended { Task { await forgetIfRemoved(ended) } }
    }

    /*
     * A request just answered 401: ask at once, with the session still stored, whether this phone
     * was removed rather than signed out. Removed, everything of the account on the phone goes and
     * sign-in says why; otherwise the "signed out" alert stays for the person to act on. Nothing is
     * cleared if anyone signed in meanwhile.
     */
    func sessionEnded() async {
        guard !checkingRemoval, let ended = SharedKeychain.session else { return }
        checkingRemoval = true
        defer { checkingRemoval = false }
        await forgetIfRemoved(ended)
    }

    /*
     * Asks whether `ended` was removed and, if so and nothing has changed since, wipes. A sign-in
     * started while the question was out (the generation moved) keeps everything. From the answer
     * to `wiping` being set nothing suspends, so a sign-in that starts after finds the wipe and
     * waits for it rather than racing it.
     */
    private func forgetIfRemoved(_ ended: SharedKeychain.Session) async {
        let generation = signInGeneration
        guard (try? await Auth.checkSession(ended)) == .removed,
              generation == signInGeneration,
              Devices.mayForgetRemoved(ended: ended, current: SharedKeychain.session, owner: AccountStore.shared.owner())
        else { return }
        let wipe = Task { await forgetRemovedDevice() }
        wiping = wipe
        await wipe.value
        wiping = nil
        removedNotice = true
    }

    /*
     * The server says this phone was removed from the account: what it kept for the account goes
     * (kept files, the mirror, the remembered account key, the device key), as on sign-out, without
     * asking the server for anything more. Housekeeping, not a guarantee: whatever was copied off
     * the phone before stays where it went.
     */
    private func forgetRemovedDevice() async {
        await BackgroundTransfers.shared.cancelAll()
        await FilesDomain.remove()
        SharedKeychain.delete(SharedKeychain.sessionAccount)
        AccountStore.shared.wipe()
        TransferNotices.shared.clear()
        user = nil
        vault = nil
        owner = nil
        state = .signedOut
    }

    /* Universal links, hushos:// links, and hushos://node/<id>: kept until the drive can open them. */
    func open(_ url: URL) {
        // The emailed reset link opens the reset here, signed in or not.
        if case let .success(.recover(token)) = AppLinks.parse(url, server: origin) {
            recoveryLink = token
            recovering = true
            return
        }
        pendingLink = url
    }

    /* A family invitation's link waits for sign-in (it carries its token only in memory, never to disk). */
    var invitationWaiting: Bool {
        guard let pendingLink else { return false }
        switch AppLinks.parse(pendingLink, server: origin) {
        case .success(.join), .success(.incompleteInvite): return true
        default: return false
        }
    }

    /* Forgot your password, in the app: shown over sign-in (or the drive, when the emailed link opens it). */
    var recovering = false
    /* The emailed link's token, until the reset screen trades it for the enrollment. */
    var recoveryLink: String?

    func startRecovery() { recovering = true }

    func recoveryDone() {
        recovering = false
        recoveryLink = nil
    }

    /* The reset, then the app signed in under the new password, as a sign-in leaves it. */
    func recover(_ enrollment: RecoveryEnrollment, password: String, phrase: [String]) async throws -> RecoveredAccount {
        signInGeneration += 1
        await wiping?.value
        let previous = AccountStore.shared.owner()
        let account = try await Auth.recover(enrollment, password: password, phrase: phrase)
        await anotherAccount(since: previous)
        signedIn(account.user)
        return account
    }
}
