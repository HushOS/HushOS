import Foundation
import HushOSKit
import Observation

/*
 * Who is signed in and the vault that opens their drive. The session lives in
 * the shared keychain so the Files extensions see the same one; signing in
 * registers the Files location and signing out removes it.
 */
@Observable
@MainActor
final class AppModel {
    enum State: Equatable { case checking, signedOut, signedIn }

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
    var pendingNode: String?

    func start() async {
        do {
            if let user = try await Auth.currentUser() {
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
        let user = try await Auth.signIn(origin: origin, email: email, password: password)
        signedIn(user)
    }

    private func signedIn(_ user: SessionUser) {
        self.user = user
        vault = Vault.fromKeychain()
        state = .signedIn
        Task { await FilesDomain.register() }
    }

    func signOut() async {
        await BackgroundTransfers.shared.cancelAll()
        await Auth.signOut()
        await FilesDomain.remove()
        user = nil
        vault = nil
        state = .signedOut
    }

    func setUser(_ user: SessionUser) { self.user = user }

    /* After deletion there is nothing left on the server; forget the Files location too. */
    func deleted() async {
        await FilesDomain.remove()
        user = nil
        vault = nil
        state = .signedOut
    }

    /* The session died under us (a 401): back to the sheet, Files location left in place until sign-in. */
    func sessionLost() {
        SharedKeychain.delete(SharedKeychain.sessionAccount)
        user = nil
        vault = nil
        state = .signedOut
    }

    /* hushos://node/<id> opens a folder or file once signed in. */
    func open(_ url: URL) {
        guard url.scheme == "hushos", url.host == "node" else { return }
        pendingNode = url.lastPathComponent
    }
}
