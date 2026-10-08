import Foundation
import HushOSKit
import Observation
import UIKit

/*
 * Who is signed in and the vault that opens their drive. The session lives in
 * the shared keychain so the Files extensions see the same one; signing in
 * registers the Files location and signing out removes it. Links that open the
 * app wait here until someone is signed in to act on them.
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
    var origin: String = SharedKeychain.config?.origin ?? AppModel.defaultOrigin
    /* The last address signed in with, so a sign-in after the session ended starts filled. */
    var lastEmail = UserDefaults.standard.string(forKey: "lastEmail") ?? "" {
        didSet { UserDefaults.standard.set(lastEmail.isEmpty ? nil : lastEmail, forKey: "lastEmail") }
    }
    /* A link that opened the app; acted on once signed in (or right away if already). */
    var pendingLink: URL?

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
            if let user = try await Auth.currentUser() {
                // Signed in before the store recorded owners: what is on the phone is this account's.
                AccountStore.shared.adopt(user.id)
                signedIn(user)
                return
            }
        } catch {
            // Offline: keep the stored session and try the drive anyway.
            if SharedKeychain.session != nil, let session = SharedKeychain.session {
                user = SessionUser(id: session.userId, name: "", email: "", credentialVersion: 0, role: "member")
                vault = Vault.fromKeychain()
                state = .signedIn
                return
            }
        }
        state = .signedOut
    }

    func signIn(email: String, password: String) async throws {
        let previous = AccountStore.shared.owner()
        // Auth.signIn removes another account's data (AccountStore.claim) before the new session is stored.
        let user = try await Auth.signIn(origin: origin, email: email, password: password)
        if previous?.caseInsensitiveCompare(user.id) != .orderedSame {
            // The other account's queued transfers would run under this session; Files forgets its listing.
            await BackgroundTransfers.shared.cancelAll()
            TransferNotices.shared.clear()
            await FilesDomain.reimport()
        }
        signedIn(user)
    }

    private func signedIn(_ user: SessionUser) {
        // The queue opens its own vault from the keychain until the drive hands it the new one.
        BackgroundTransfers.shared.vault = nil
        self.user = user
        if !user.email.isEmpty { lastEmail = user.email }
        vault = Vault.fromKeychain()
        state = .signedIn
        Task { await FilesDomain.register() }
    }

    func signOut() async {
        await BackgroundTransfers.shared.cancelAll()
        await Auth.signOut()
        await FilesDomain.remove()
        // Everything of the account on this phone: kept and opened files, the mirror, the device key, searches.
        AccountStore.shared.wipe()
        TransferNotices.shared.clear()
        lastEmail = ""
        user = nil
        vault = nil
        state = .signedOut
    }

    func setUser(_ user: SessionUser) { self.user = user }

    /* After deletion there is nothing left on the server; forget the Files location too, and say so. */
    func deleted() async {
        await FilesDomain.remove()
        SharedKeychain.delete(SharedKeychain.sessionAccount)
        AccountStore.shared.wipe()
        TransferNotices.shared.clear()
        user = nil
        vault = nil
        lastEmail = ""
        state = .deleted
    }

    func leaveDeleted() { state = .signedOut }

    /* The session died under us (a 401): back to sign-in with the address filled, Files location left until then. */
    func sessionLost() {
        if let email = user?.email, !email.isEmpty { lastEmail = email }
        SharedKeychain.delete(SharedKeychain.sessionAccount)
        user = nil
        vault = nil
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
        let previous = AccountStore.shared.owner()
        let account = try await Auth.recover(enrollment, password: password, phrase: phrase)
        if previous?.caseInsensitiveCompare(account.user.id) != .orderedSame {
            await BackgroundTransfers.shared.cancelAll()
            TransferNotices.shared.clear()
            await FilesDomain.reimport()
        }
        signedIn(account.user)
        return account
    }
}
