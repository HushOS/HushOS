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
    /*
     * Where the check of an ended session stands. "You've been signed out" waits for `kept`: while
     * the server is asked whether this phone was removed it says nothing, and a removal shows only
     * "This iPhone was removed" (sign-in), never the alert over it.
     */
    enum SessionCheck { case none, checking, kept }
    var sessionCheck: SessionCheck = .none
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
        defer { if let url = deferredSignup { deferredSignup = nil; open(url) } }
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
                // Offline too, words this phone made and nobody checked come before the drive.
                wordsWaiting = WordsWaiting.isWaiting(for: session.userId)
                state = .signedIn
                return
            }
        }
        // A session still stored but refused: coming back on screen doesn't ask about it again.
        declinedToken = SharedKeychain.session?.token
        if let ended = SharedKeychain.session { lastOwner = AccountOwner(ended) }
        state = .signedOut
    }

    /* A sign-up link that arrived while `start` was still checking the stored session. */
    private var deferredSignup: URL?

    /* The stored session `start` last found ended, so `checkAccount` only follows a new one. */
    private var declinedToken: String?

    /*
     * A sign-in stopped at the account's second step (docs/two-step-design.md 4): the step screen is
     * on the sign-in stack until it is answered, given up, or over. What the password opened waits
     * in it, in memory only.
     */
    private(set) var pendingStep: PendingSignIn?
    /* Why the last step went back to the password, in the server's words; sign-in shows it once. */
    var stepNotice = ""

    /*
     * This phone's own rotation, from the request that ends its session to the sign-in after the new
     * words (HushOSKit's OwnChange): while it mutes, nothing signs the app out from under the words,
     * and the words' check is recorded at the sign-in that is theirs.
     */
    var ownChange = OwnChange()

    /*
     * Returns whether the app is signed in: false when the account asked for its second step. With
     * `stepLater` the step is not shown and nothing changes (the caller still has something on screen
     * that the step screen would replace, and signs in again when it is done).
     */
    @discardableResult
    /* `holding`: new recovery words this phone still has in memory, which answer a second step that names them (`Auth.signInHolding`). */
    func signIn(email: String, password: String, stepLater: Bool = false, holding: (phrase: String, recoverySalt: String)? = nil) async throws -> Bool {
        removedNotice = false
        signInGeneration += 1
        await wiping?.value
        let previous = AccountStore.shared.owner()
        // The session is stored only once signed in; another account's data goes then (AccountStore.claim).
        let taken = if let holding {
            try await Auth.signInHolding(origin: origin, email: email, password: password, phrase: holding.phrase, recoverySalt: holding.recoverySalt)
        } else {
            try await Auth.startSignIn(origin: origin, email: email, password: password)
        }
        switch taken {
        case .signedIn(let user):
            await anotherAccount(since: previous)
            signedIn(user)
            return true
        case .step(let pending):
            if !stepLater { awaitStep(pending) }
            return false
        }
    }

    /*
     * The account asks for its second step. Signed out, the step screen goes on the sign-in stack.
     * Signed in, this is the sign-in after this phone's own password change or rotation: the server
     * ended every session with it, so the app goes to sign-in as it does when a session ends (the
     * address filled, what the phone holds kept) and asks for the step there.
     */
    private func awaitStep(_ pending: PendingSignIn) {
        if state == .signedIn {
            sessionClosed()
            if let email = user?.email, !email.isEmpty { lastEmail = email }
            lastOwner = owner
            SharedKeychain.delete(SharedKeychain.sessionAccount)
            user = nil
            vault = nil
            owner = nil
            state = .signedOut
        }
        if lastEmail.isEmpty { lastEmail = pending.email }
        stepNotice = ""
        pendingStep = pending
        // Left unanswered, the step and what the password opened are dropped six minutes after it arrived, on the clock
        // since boot (`PendingSignIn.dropIn`): the date on the phone, right or wrong, has no say in it.
        let token = pending.challenge.token
        Task { [weak self] in
            try? await Task.sleep(for: max(.zero, pending.dropIn()), clock: .continuous)
            guard let self, self.pendingStep?.challenge.token == token else { return }
            self.cancelStep(StepWords.over)
        }
    }

    /* The step's answer: on a right one the app is signed in, as a sign-in without a step leaves it. */
    func answerStep(_ proof: StepProof) async throws {
        guard let pending = pendingStep, pending.dropIn() > .zero else { throw StepError.refused(.expired, StepWords.over) }
        signInGeneration += 1
        await wiping?.value
        let previous = AccountStore.shared.owner()
        let user = try await Auth.answerStep(pending, proof: proof)
        await anotherAccount(since: previous)
        signedIn(user)
    }

    /* Back to the password: the person chose to start again (no reason), or the step is over (the server's reason). */
    func cancelStep(_ reason: String = "") {
        stepNotice = reason
        pendingStep = nil
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
        // A step left waiting (answered now, or passed over by a sign-in from the Files sheet) is done with.
        pendingStep = nil
        stepNotice = ""
        sessionCheck = .none
        lastOwner = nil
        // The queue opens its own vault from the keychain until the drive hands it the new one.
        BackgroundTransfers.shared.vault = nil
        self.user = user
        if !user.email.isEmpty { lastEmail = user.email }
        owner = AccountOwner.signedIn
        // Decrypted copies this process kept for another account go before this one opens anything, and before its
        // vault is made: a claim ends the copies' session, and a vault keeps to the session it was made in.
        TemporaryCopies.claim(owner)
        vault = Vault.fromKeychain()
        // A new account (or a recovery) whose words this phone made and nobody checked yet: they come before the drive.
        wordsWaiting = WordsWaiting.isWaiting(for: user.id)
        state = .signedIn
        if let owner { Task { await FilesDomain.register(for: owner) } }
        // Words checked with no session to say so (a rotation's, a reset's): recorded now, if they were this sign-in's.
        // Best effort: unrecorded, they are only asked about again. The server refuses any version but the current one.
        if let version = ownChange.signedIn(userId: user.id, origin: origin) {
            Task { try? await Auth.confirmRecovery(recoveryVersion: version) }
        }
        // Notifications this account turned on here: the token again, in case iOS replaced it, then what no push showed.
        Task {
            await PhonePush.shared.refresh()
            await PhonePush.shared.catchUp()
        }
    }

    /*
     * Back on screen: someone may have signed in from the Files sheet meanwhile (the same
     * account after its session ended, another account, or anyone while the app showed
     * sign-in), or the session went. `SessionChange` decides; the same account's new session
     * is adopted in place, another account's start stops the last one's queue and notices.
     */
    func checkAccount() async {
        guard state == .signedIn || state == .signedOut, wiping == nil else { return }
        let shown = state == .signedIn ? vault?.api.session : nil
        let change = SessionChange.decide(shown: shown, last: owner ?? lastOwner, stored: SharedKeychain.session, declined: declinedToken)
        // The last session's family sync, ledger keys and vault go before anything follows the new one, and the last
        // session is closed as a sign-out closes it (its late syncs delete nothing, its downloads write nothing), the same
        // account's new session (`adopt`) included.
        change.forgetLastSession()
        switch change {
        case .none:
            return
        case .adopt:
            // The drive takes the new session (DriveStore.adopt, through MainView) and keeps what it shows, with the
            // account as the new session describes it. No vault for it, or a session already over: start again instead.
            guard let next = Vault.fromKeychain() else { break }
            let check = try? await Auth.checkSession()
            if check == .ended || check == .removed { break }
            if case let .signedIn(fresh, _)? = check { setUser(fresh) }
            vault = next
            if let owner { await FilesDomain.register(for: owner) }
            return
        case .another:
            await BackgroundTransfers.shared.cancelAll()
            TransferNotices.shared.clear()
        case .restart:
            break
        }
        // Another account, or a start over: the shown session ended.
        sessionClosed()
        user = nil
        vault = nil
        self.owner = nil
        state = .checking
        await start()
    }

    /* The account shown before the app went to sign-in (a session that ended), whose queue and notices may still be here. */
    private var lastOwner: AccountOwner?

    /*
     * The signed-in screens' store, while there is one: every end of the session (sign-out, deletion,
     * a lost session) resets its families and cancels their work in flight (DriveStore.resetFamilies).
     * Tied to these transitions only: a view leaving the screen (a file opened full screen) is no end.
     */
    @ObservationIgnored weak var driveStore: DriveStore?

    private func sessionClosed() {
        // Before the vault goes: no download of the session, family or personal, writes again (TemporaryCopies.endAccount).
        TemporaryCopies.endAccount()
        // The session's family check goes with it: nothing of it runs for the next one.
        FamilyWalkTasks.cancel()
        driveStore?.resetFamilies()
        driveStore = nil
    }

    func signOut() async {
        sessionClosed()
        await BackgroundTransfers.shared.cancelAll()
        await Auth.signOut()
        await FilesDomain.remove()
        // Everything of the account on this phone: kept and opened files, the mirror, the device key, searches.
        AccountStore.shared.wipe()
        TransferNotices.shared.clear()
        // The families' sync and its ledger keys go with the session.
        FamilySync.forget()
        lastEmail = ""
        lastOwner = nil
        user = nil
        vault = nil
        owner = nil
        state = .signedOut
    }

    func setUser(_ user: SessionUser) { self.user = user }

    /* After deletion there is nothing left on the server; forget the Files location too, and say so. */
    func deleted() async {
        sessionClosed()
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
    func sessionLost(ended: SharedKeychain.Session? = nil) {
        guard !ownChange.mutesSessionEnd else { return }
        // The session said to have ended is no longer the one stored (a sign-in since replaced it): nothing of the
        // stored one goes. The account is looked at again instead, which adopts the stored session.
        if let ended, let stored = SharedKeychain.session, stored != ended {
            Task { await checkAccount() }
            return
        }
        sessionClosed()
        if let email = user?.email, !email.isEmpty { lastEmail = email }
        lastOwner = owner
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
        // A rotation of this phone's own is under way, or its new words are on screen (ownChange): "You've been signed out" would take them away, and the
        // sign-in that follows them is already planned. The check stays unanswered, so its alert never shows.
        guard !ownChange.mutesSessionEnd else { return }
        guard !checkingRemoval else { return }
        guard let ended = SharedKeychain.session else {
            sessionCheck = .kept
            return
        }
        checkingRemoval = true
        defer { checkingRemoval = false }
        sessionCheck = await forgetIfRemoved(ended) ? .none : .kept
    }

    /*
     * Asks whether `ended` was removed and, if so and nothing has changed since, wipes. A sign-in
     * started while the question was out (the generation moved) keeps everything. From the answer
     * to `wiping` being set nothing suspends, so a sign-in that starts after finds the wipe and
     * waits for it rather than racing it.
     */
    /* True when this phone was removed and its data wiped. */
    @discardableResult
    private func forgetIfRemoved(_ ended: SharedKeychain.Session) async -> Bool {
        let generation = signInGeneration
        guard (try? await Auth.checkSession(ended)) == .removed,
              generation == signInGeneration,
              Devices.mayForgetRemoved(ended: ended, current: SharedKeychain.session, owner: AccountStore.shared.owner())
        else { return false }
        let wipe = Task { await forgetRemovedDevice() }
        wiping = wipe
        await wipe.value
        wiping = nil
        removedNotice = true
        return true
    }

    /*
     * The server says this phone was removed from the account: what it kept for the account goes
     * (kept files, the mirror, the remembered account key, the device key), as on sign-out, without
     * asking the server for anything more. Housekeeping, not a guarantee: whatever was copied off
     * the phone before stays where it went.
     */
    private func forgetRemovedDevice() async {
        sessionClosed()
        await BackgroundTransfers.shared.cancelAll()
        await FilesDomain.remove()
        SharedKeychain.delete(SharedKeychain.sessionAccount)
        // Everything of the account, the families' join checks included, as on sign-out (AccountStore).
        AccountStore.shared.wipeAfterRemoval()
        TransferNotices.shared.clear()
        // The old session's sync and the ledger keys it held leave memory.
        FamilySync.forget()
        lastOwner = nil
        user = nil
        vault = nil
        owner = nil
        state = .signedOut
    }

    /* Universal links, hushos:// links, and hushos://node/<id>: kept until the drive can open them. */
    func open(_ url: URL) {
        switch AppLinks.parse(url, server: origin) {
        // Not over an account being made (it signs in and shows its words as it finishes): this link waits for it.
        // (The guard on each pattern: a `where` binds only to the pattern it follows.)
        case .success(.recover) where creatingAccount, .success(.register) where creatingAccount:
            linkAfterCreating = url
        // Nor over a reset that is under way, or whose new words are on screen with no session: they are in this
        // screen's memory only, and a link that replaced it would be the end of them. It opens once they are saved.
        case .success(.recover) where resetHolds, .success(.register) where resetHolds:
            linkAfterReset = url
        // The emailed reset link opens the reset here, signed in or not.
        case let .success(.recover(token)):
            signingUp = false
            signupLink = nil
            recoveryLink = token
            recovering = true
        // The emailed sign-up link carries sign-up on here, wherever it began. Signed in, it isn't used (the web asks to
        // sign out first), so the link stays good for later.
        case let .success(.register(token)):
            // A link that started the app comes before start() has restored any session: decided once it has, so a
            // signed-in phone never spends the one-use link.
            if state == .checking { deferredSignup = url; return }
            if state == .signedIn {
                let who = user.map { $0.email.isEmpty ? "" : " as \($0.email)" } ?? ""
                NoticeCenter.shared.show("You’re signed in\(who). To create another account, sign out, then open the link again.")
                return
            }
            recovering = false
            recoveryLink = nil
            signupLink = token
            signingUp = true
        default:
            pendingLink = url
        }
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
        // The reset's words are saved (or the reset was left before it began): a link that waited for them opens now.
        resetReleased()
    }

    /* Create an account, in the app: shown over sign-in (or opened by the emailed link). Never over a signed-in drive. */
    var signingUp = false
    /* The emailed sign-up link's token, until the sign-up screen trades it for the enrollment. */
    var signupLink: String?
    /* Signed in with words this phone made that wait to be checked (WordsWaiting): the kit shows before the drive. */
    private(set) var wordsWaiting = false

    func startSignup() { signingUp = true }

    /*
     * A phrase reset from its request until its new words are saved and its screen is done with (`recover`,
     * `recoveryDone`), and a sign-up or reset link that arrived meanwhile, opened after it.
     */
    private(set) var resetHolds = false
    private var linkAfterReset: URL?
    /* Counts each time the reset screen must start over for a link that waited: its identity, so nothing of the reset before it stays on screen. */
    private(set) var recoveryRun = 0

    private func resetReleased() {
        resetHolds = false
        if let url = linkAfterReset {
            linkAfterReset = nil
            recoveryRun += 1
            open(url)
        }
    }

    /* An account being made (createAccount), and a sign-up or reset link that arrived meanwhile, opened after it. */
    private var creatingAccount = false
    private var linkAfterCreating: URL?

    func signupDone() {
        signingUp = false
        signupLink = nil
    }

    /*
     * The account, then a sign-in with its password as the web does. The words wait from before any session exists, so
     * a sign-in that fails here, or an app stopped before the check, still shows them first next time. Returns false
     * when the account exists but the sign-in didn't happen.
     */
    func createAccount(_ enrollment: SignupEnrollment, name: String, password: String) async throws -> Bool {
        creatingAccount = true
        defer {
            creatingAccount = false
            if let url = linkAfterCreating { linkAfterCreating = nil; open(url) }
        }
        signInGeneration += 1
        await wiping?.value
        let previous = AccountStore.shared.owner()
        // Marks the words as waiting (WordsWaiting) before the account is sent, not after its answer.
        _ = try await Auth.register(enrollment, name: name, password: password)
        let user: SessionUser
        do {
            user = try await Auth.signIn(origin: origin, email: enrollment.email, password: password)
        } catch {
            return false
        }
        await anotherAccount(since: previous)
        signupDone()
        signedIn(user)
        return true
    }

    /* The words were checked (here or, as the server says, anywhere): the drive opens. */
    func wordsChecked() {
        WordsWaiting.clear()
        wordsWaiting = false
    }

    /*
     * Rotates the account key, and leaves the app signed in under it when the rotation's own sign-in
     * went through (`Auth.rotateKeysKit`, which answers a second step with the new phrase).
     */
    func rotateKeys(password: String, twoStep: StepAnswer?) async throws -> Auth.RotatedKeys {
        guard let email = user?.email else { throw AuthError.message(ErrorWords.generic) }
        signInGeneration += 1
        let previous = AccountStore.shared.owner()
        let made = try await Auth.rotateKeysKit(email: email, password: password, twoStep: twoStep)
        if let user = made.user {
            await anotherAccount(since: previous)
            signedIn(user)
        }
        return made
    }

    /* The reset, then the app signed in under the new password, as a sign-in leaves it. */
    func recover(_ enrollment: RecoveryEnrollment, password: String, phrase: [String]) async throws -> RecoveredAccount {
        signInGeneration += 1
        await wiping?.value
        let previous = AccountStore.shared.owner()
        // From here the reset's screen may come to hold the account's only phrase: no link replaces it (`open`).
        resetHolds = true
        // And the session this phone has is ended by the reset: its end is this phone's own doing from here, so no
        // "You've been signed out" takes the reset's screen, and the words on it, away (`ownChange`).
        ownChange.begin()
        let account: RecoveredAccount
        do {
            account = try await Auth.recover(enrollment, password: password, phrase: phrase)
        } catch {
            ownChange.ended()
            resetReleased()
            throw error
        }
        // The new words wait to be checked even if the app is stopped before they are (the drive shows them first).
        WordsWaiting.set(userId: account.userId)
        // Not signed in (the sign-in after the reset failed, twice): the words are shown from here all the same, and
        // held until they are saved (`recoveredSignedOut`).
        if let user = account.user {
            await anotherAccount(since: previous)
            signedIn(user)
        } else {
            ownChange.hold()
        }
        // Either way the words are on the reset's screen now, and a link still waits until they are saved (`recoveryDone`).
        return account
    }

    /*
     * The new words of a reset that left the app signed out were saved and checked: on to sign-in,
     * with the address filled and what to do said. The check is recorded at that sign-in, if it is
     * this account's on this server.
     */
    func recoveredSignedOut(_ account: RecoveredAccount) async {
        WordsWaiting.clear()
        wordsWaiting = false
        // A session this phone still shows is left before sign-in comes up, or the app would go back to the drive it
        // had. The recovered account's own was ended by the reset (what the phone holds is kept, as when a session
        // ends). Another account's is ended now, as signing in over it would have: properly, on the server too.
        if state == .signedIn {
            if let user, user.id.lowercased() == account.userId.lowercased() {
                sessionClosed()
                lastOwner = owner
                SharedKeychain.delete(SharedKeychain.sessionAccount)
                self.user = nil
                vault = nil
                owner = nil
                state = .signedOut
            } else {
                await signOut()
            }
        }
        ownChange.wordsChecked(CheckedWords(userId: account.userId, origin: origin, recoveryVersion: account.certain ? account.recoveryVersion : 0))
        ownChange.settled()
        lastEmail = account.email
        recoveryDone()
        // Only a reset that is known to have been made says the password changed.
        NoticeCenter.shared.show(account.certain ? StepWords.signInAfterReset : StepWords.signInAfterUncertainReset, important: true)
    }
}
