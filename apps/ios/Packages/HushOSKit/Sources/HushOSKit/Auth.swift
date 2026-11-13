import Foundation
import HushOSCore
#if canImport(UIKit)
import UIKit
#endif

public struct SessionUser: Codable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let email: String
    public let credentialVersion: UInt64
    public let role: String

    public init(id: String, name: String, email: String, credentialVersion: UInt64, role: String) {
        self.id = id
        self.name = name
        self.email = email
        self.credentialVersion = credentialVersion
        self.role = role
    }

    /* The login reply and the session route agree on `id`, `name` and `email`; the rest may be absent. */
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
        email = try container.decodeIfPresent(String.self, forKey: .email) ?? ""
        credentialVersion = try container.decodeIfPresent(UInt64.self, forKey: .credentialVersion) ?? 0
        role = try container.decodeIfPresent(String.self, forKey: .role) ?? "member"
    }
}

public enum AuthError: Error, LocalizedError, Sendable, Equatable {
    /* What a request that got no answer says: callers that must tell no answer from a refusal compare with it. */
    public static let unreachable = "We couldn’t reach HushOS. Check your connection, then try again."

    case message(String)
    case wrongPassword
    case noSession
    /* The server refused a write based on a version that is no longer current (409). */
    case conflict(String)
    /* The server no longer knows this session (401): signed out elsewhere, a password change, or expiry. */
    case sessionEnded(session: String? = nil)

    public var errorDescription: String? {
        switch self {
        case .message(let text): return text
        case .wrongPassword: return "That email and password don’t match. Check them and try again."
        case .noSession: return "Signed in, but the session was not returned."
        case .conflict(let text): return text
        case .sessionEnded: return "Your session ended. Sign in again."
        }
    }
}

/* The session a refusal (a 401) was for, by its tag; nil when the error isn't one or doesn't say. */
public func refusedSession(_ error: Error) -> String? {
    switch error {
    case DriveAPIError.notAuthenticated(let session): return session
    case AuthError.sessionEnded(let session): return session
    default: return nil
    }
}

/*
 * Whether a failure ends `current`, the session in use now: a 401 sent under another session (one
 * that ended before this one began, answering late) is stale and ends nothing; one that doesn't
 * say which session it was for is taken as this one's.
 */
public func endsSession(_ error: Error, current: SharedKeychain.Session?) -> Bool {
    guard endsSession(error) else { return false }
    guard let refused = refusedSession(error), let current else { return true }
    return refused == current.tag
}

/* Whether a request failed because the session is gone (a 401 from the Drive API or the account API): sign-in, not a retry. */
public func endsSession(_ error: Error) -> Bool {
    if case DriveAPIError.notAuthenticated = error { return true }
    if case AuthError.sessionEnded = error { return true }
    return false
}

/*
 * OPAQUE sign-in against the HushOS API, entirely native: the Rust core runs
 * the client steps; the session cookie the server sets goes to the shared
 * keychain; a device bundle is made when there is none for this user and
 * credential, so the Files extensions can open the account key afterwards.
 */
public enum Auth {
    private struct Reply {
        let body: [String: Any]
        let cookie: String?
    }

    /* A reply as it arrived: the status, the body as text for the core to read, and the session cookie if one came. */
    struct RawReply {
        let status: Int
        let text: String
        let body: [String: Any]
        let cookie: String?
    }

    /* Sends and returns whatever came back, any status; throws only when nothing did. */
    static func send(_ origin: String, _ path: String, _ body: [String: Any], cookie: String? = nil) async throws -> RawReply {
        guard let url = URL(string: origin + path) else { throw AuthError.message("Bad HushOS address.") }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(origin, forHTTPHeaderField: "Origin")
        request.setValue(DriveAPI.clientHeader, forHTTPHeaderField: "HushOS-Client")
        if let cookie { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 30
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession(configuration: testTransport ?? .ephemeral).data(for: request)
        } catch {
            if ErrorWords.isCancellation(error) { throw CancellationError() }
            throw AuthError.message(AuthError.unreachable)
        }
        let http = response as? HTTPURLResponse
        let parsed = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        return RawReply(
            status: http?.statusCode ?? 0, text: String(data: data, encoding: .utf8) ?? "", body: parsed,
            cookie: sessionToken(setCookie: http?.value(forHTTPHeaderField: "Set-Cookie"))
        )
    }

    private static func post(_ origin: String, _ path: String, _ body: [String: Any], cookie: String? = nil) async throws -> Reply {
        let reply = try await send(origin, path, body, cookie: cookie)
        guard (200 ..< 300).contains(reply.status) else {
            throw AuthError.message(reply.body["message"] as? String ?? "Something went wrong on HushOS. Try again in a moment.")
        }
        return Reply(body: reply.body, cookie: reply.cookie)
    }

    /*
     * The session token in a Set-Cookie header, or nil. Several cookies arrive joined by
     * commas; attributes follow a semicolon. Sign-out answers with the cookie cleared
     * ("hushos-session="): an empty value is no session.
     */
    static func sessionToken(setCookie header: String?) -> String? {
        guard let header else { return nil }
        var token: String?
        for cookie in header.components(separatedBy: ",") {
            // The name=value pair comes first; anything after the first semicolon is an attribute.
            guard let pair = cookie.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false).first else { continue }
            let trimmed = pair.trimmingCharacters(in: .whitespaces)
            guard let equals = trimmed.firstIndex(of: "=") else { continue }
            let name = trimmed[..<equals]
            guard name == "hushos-session" || name == "__Host-hushos-session" else { continue }
            let value = trimmed[trimmed.index(after: equals)...].trimmingCharacters(in: .whitespaces)
            token = value.isEmpty ? nil : value
        }
        return token
    }

    /*
     * Signs in, stores the session and (when needed) a new device memory; returns who signed in.
     * For callers with no step screen (the Files sign-in sheet, a new account's first sign-in): an
     * account that asks for a second step is told to sign in from the app.
     */
    @discardableResult
    public static func signIn(origin: String, email: String, password: String) async throws -> SessionUser {
        switch try await startSignIn(origin: origin, email: email, password: password) {
        case .signedIn(let user): return user
        case .step: throw AuthError.message(StepWords.openApp)
        }
    }

    /* Where a sign-in stands after the password: signed in, or stopped at the account's second step. */
    public enum SignIn: Sendable {
        case signedIn(SessionUser)
        case step(PendingSignIn)
    }

    /*
     * The password's half of a sign-in (docs/two-step-design.md 4). `twoStep: 1` says this build can
     * answer a second step; an account that has one gets no session, no cookie and no envelope here,
     * only the step, and what the password opened waits in `PendingSignIn` for the answer. The reply
     * is read whole by the core: one that is neither the session nor the step is `StepError.lost`.
     */
    public static func startSignIn(origin: String, email: String, password: String) async throws -> SignIn {
        switch try await passwordHalf(origin: origin, email: email, password: password) {
        case .session(let reply, let exportKey):
            return .signedIn(try await openSession(origin: origin, email: email, exportKey: exportKey, reply: reply))
        case .step(let pending):
            return .step(pending)
        }
    }

    /*
     * A sign-in by a phone that holds the account's newest recovery phrase in memory (after its own
     * rotation or reset): a second step that names that phrase's recovery key is answered with it, so
     * nobody is sent to a step they would need those words for. A step that names another key is left
     * for the person, and so is one whose answer did not come back as a session.
     */
    public static func signInHolding(origin: String, email: String, password: String, phrase: String, recoveryVersion: UInt64) async throws -> SignIn {
        await holding(try await startSignIn(origin: origin, email: email, password: password), phrase: phrase, recoveryVersion: recoveryVersion) { pending, proof in
            try await answerStep(pending, proof: proof)
        }
    }

    static func holding(_ taken: SignIn, phrase: String, recoveryVersion: UInt64, answer: (PendingSignIn, StepProof) async throws -> SessionUser) async -> SignIn {
        guard case .step(let pending) = taken, let signing = pending.challenge.phrase, signing.recoveryVersion == recoveryVersion,
              pending.challenge.methods.contains(.phrase),
              let signature = try? twoStepPhraseSign(phrase: phrase, wrappingSalt: signing.wrappingSalt, userId: signing.userId, stepToken: pending.challenge.token),
              let user = try? await answer(pending, .phrase(signature: signature))
        else { return taken }
        return .signedIn(user)
    }

    /* What the password's half met, with nothing stored yet: the session's reply (whole, with its cookie), or the step. */
    enum Met {
        case session(RawReply, exportKey: Data)
        case step(PendingSignIn)
    }

    static func passwordHalf(origin: String, email: String, password: String) async throws -> Met {
        let start = try opaqueStartLogin(password: password)
        let started = try await post(origin, "/api/auth/login/start", ["email": email, "startLoginRequest": start.request]).body
        guard let attemptToken = started["attemptToken"] as? String, let loginResponse = started["loginResponse"] as? String else {
            throw AuthError.message("Unexpected reply from HushOS.")
        }
        guard let finish = try opaqueFinishLogin(password: password, state: start.state, loginResponse: loginResponse) else {
            throw AuthError.wrongPassword
        }
        // The device key's proof, only for the account it was made for: the same device comes back.
        let proof = deviceProof(identity: SharedKeychain.deviceIdentity, email: email, attemptToken: attemptToken)
        let reply = try await send(origin, "/api/auth/login/finish", finishBody(attemptToken: attemptToken, finishRequest: finish.request, device: proof))
        switch signInReplyRead(status: UInt16(clamping: reply.status), body: reply.text) {
        case .done:
            // The session is its body and its cookie: without the cookie nothing was handed over, whatever the body says.
            guard reply.cookie != nil else { throw StepError.lost(StepWords.lostSignIn) }
            return .session(reply, exportKey: finish.exportKey)
        case .step(let challenge):
            return .step(PendingSignIn(origin: origin, email: email, challenge: challenge, exportKey: finish.exportKey))
        case .refused(let refusal, let message):
            // A wrong password and the limiter's 429 are a sign-in's own refusals, in the server's words as before.
            throw refusal == .other || refusal == .busy ? AuthError.message(message) : StepError.refused(refusal, message)
        case .lost:
            throw StepError.lost(StepWords.lostSignIn)
        }
    }

    /*
     * What `login/finish` is sent. `twoStep: 1` says this build can answer a second step: without it
     * the server tells an account that has one to update, and nobody with the step could sign in here.
     */
    static func finishBody(attemptToken: String, finishRequest: String, device: [String: String]?) -> [String: Any] {
        var body: [String: Any] = ["attemptToken": attemptToken, "finishLoginRequest": finishRequest, "twoStep": 1]
        if let device { body["device"] = device }
        return body
    }

    /*
     * The step's answer: on a right one the server answers exactly what `login/finish` answers
     * without a step, and the envelope opens under what the password gave. A wrong answer, an ended
     * step and a lost reply are thrown as `StepError`; `StepOutcome` says what the screen does next.
     */
    public static func answerStep(_ pending: PendingSignIn, proof: StepProof) async throws -> SessionUser {
        let body = try StepAnswer(token: pending.challenge.token, proof: proof).json()
        let reply = try await send(pending.origin, "/api/auth/login/two-step", body)
        switch signInReplyRead(status: UInt16(clamping: reply.status), body: reply.text) {
        case .done:
            guard reply.cookie != nil else { throw StepError.lost(StepWords.lostStep) }
            return try await openSession(origin: pending.origin, email: pending.email, exportKey: pending.exportKey, reply: reply)
        case .refused(let refusal, let message):
            throw StepError.refused(refusal, message)
        case .step, .lost:
            // Another step in place of the session is not this route's answer either.
            throw StepError.lost(StepWords.lostStep)
        }
    }

    /* The session's reply, whole (the core checked): the session and the device memory are stored, and the account returned. */
    static func openSession(origin: String, email: String, exportKey: Data, reply: RawReply) async throws -> SessionUser {
        guard let userJson = reply.body["user"] as? [String: Any] else { throw AuthError.message("Signed in, but HushOS returned no account.") }
        let user = try JSONDecoder().decode(SessionUser.self, from: JSONSerialization.data(withJSONObject: userJson))
        guard let envelopeJson = reply.body["envelope"] as? [String: Any] else { throw AuthError.message("Signed in, but HushOS returned no account key.") }
        guard let token = reply.cookie else { throw AuthError.noSession }
        let envelope = AccountKeyEnvelope(
            envelopeVersion: UInt32((envelopeJson["envelopeVersion"] as? NSNumber)?.intValue ?? 0),
            keyVersion: (envelopeJson["keyVersion"] as? NSNumber)?.uint64Value ?? 0,
            credentialVersion: (envelopeJson["credentialVersion"] as? NSNumber)?.uint64Value ?? 0,
            wrappingSalt: envelopeJson["wrappingSalt"] as? String ?? "",
            wrappingNonce: envelopeJson["wrappingNonce"] as? String ?? "",
            encryptedKey: envelopeJson["encryptedKey"] as? String ?? ""
        )
        // Another account's data on this phone goes before this one's session exists, and that account's session goes
        // first, so nothing still at work for it (a rollback mark, in this process or an extension) writes after the wipe.
        let owner = AccountOwner(userId: user.id, origin: origin)
        if AccountStore.shared.owner() != owner { SharedKeychain.delete(SharedKeychain.sessionAccount) }
        AccountStore.shared.claim(owner)
        // The session this one replaces (a re-sign-in after Change password or Rotate account key included) is closed first.
        SessionChange.closeLastSession()
        try SharedKeychain.write(SharedKeychain.configAccount, SharedKeychain.Config(origin: origin))
        try SharedKeychain.write(SharedKeychain.sessionAccount, SharedKeychain.Session(origin: origin, token: token, userId: user.id))
        // A device the proof did not bring back describes itself and gets a key; a failure waits for the next launch.
        if let device = SessionDevice(json: reply.body["device"] as? [String: Any]) {
            try? await registerDevice(if: device, userId: user.id, email: user.email.isEmpty ? email : user.email)
        }
        // A remembered device for this user and credential is kept; otherwise make one now.
        if let existing = try? SharedKeychain.device?.open(),
           existing.bundle.userId.lowercased() == user.id.lowercased(),
           existing.bundle.credentialVersion == envelope.credentialVersion {
            return user
        }
        let accountKey = try accountUnlock(userId: user.id, exportKey: exportKey, envelope: envelope)
        let memory = try deviceRemember(
            userId: user.id, accountKey: accountKey, keyVersion: envelope.keyVersion,
            credentialVersion: envelope.credentialVersion, deviceKeyId: UUID().uuidString.lowercased()
        )
        try SharedKeychain.write(SharedKeychain.deviceAccount, SharedKeychain.Device(memory: memory))
        return user
    }

    /*
     * The device key's proof for `attemptToken`, when `identity` was made for the email being
     * signed in with; nil otherwise, so a phone shared by two people never tells the server that
     * one person's device is signing in as the other.
     */
    static func deviceProof(identity: SharedKeychain.DeviceIdentity?, email: String, attemptToken: String) -> [String: String]? {
        guard let identity, identity.emailHash == deviceEmailHash(email: email),
              let seed = try? base64urlDecode(value: identity.seed),
              let signature = try? deviceSessionSign(seed: seed, userId: identity.userId, deviceId: identity.deviceId, attemptToken: attemptToken)
        else { return nil }
        return ["id": identity.deviceId, "signature": signature]
    }

    /* The model's name ("iPhone 16 Pro", see DeviceModel), never the name its owner gave it. */
    static func deviceName() async -> String {
        #if canImport(UIKit)
        let pad = await MainActor.run { UIDevice.current.userInterfaceIdiom == .pad }
        #else
        let pad = false
        #endif
        return DeviceModel.name(identifier: DeviceModel.identifier(), pad: pad)
    }

    /* Registers the session's device with a new key when it has not described itself yet, and keeps the key. */
    public static func registerDevice(if device: SessionDevice, userId: String, email: String) async throws {
        guard !device.registered else { return }
        let key = try deviceSigningCreate()
        let registered = try await Devices.register(kind: "ios", name: await deviceName(), signingPublicKey: base64urlEncode(bytes: key.publicKey))
        try SharedKeychain.write(SharedKeychain.deviceIdentityAccount, SharedKeychain.DeviceIdentity(
            userId: userId, emailHash: deviceEmailHash(email: email), deviceId: registered.id, seed: base64urlEncode(bytes: key.seed)
        ))
    }

    /* What the server says about the stored session: whose it is and its device, gone, or gone because its device was removed. */
    public enum SessionCheck: Sendable, Equatable {
        case signedIn(SessionUser, SessionDevice?)
        case ended
        case removed
    }

    /*
     * An answer other than 200. The server answers every session, dead or removed included, with 200
     * (`user: null` when it's over), so anything else came from something in the way: an error on its
     * side, a deploy, a proxy or CDN. Thrown, as when HushOS can't be reached, so callers keep the
     * stored session and the drive as if offline, as the web does: nothing but the server's own
     * answer signs anyone out.
     */
    public struct SessionUnavailable: Error, Equatable {
        public let status: Int
    }

    public static func checkSession() async throws -> SessionCheck {
        guard let session = SharedKeychain.session else { return .ended }
        return try await checkSession(session)
    }

    public static func checkSession(_ session: SharedKeychain.Session, transport: URLSessionConfiguration? = nil) async throws -> SessionCheck {
        guard let url = URL(string: session.origin + "/api/auth/session") else { return .ended }
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = false
        let cookieName = session.origin.hasPrefix("https:") ? "__Host-hushos-session" : "hushos-session"
        request.setValue("\(cookieName)=\(session.token)", forHTTPHeaderField: "Cookie")
        request.setValue(session.origin, forHTTPHeaderField: "Origin")
        request.setValue(DriveAPI.clientHeader, forHTTPHeaderField: "HushOS-Client")
        request.timeoutInterval = 20
        let (data, response) = try await URLSession(configuration: transport ?? testTransport ?? .ephemeral).data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard http.statusCode == 200 else { throw SessionUnavailable(status: http.statusCode) }
        return try SessionCheck(body: data)
    }

    /* Who the stored session belongs to, or nil when it is gone. */
    public static func currentUser() async throws -> SessionUser? {
        if case let .signedIn(user, _) = try await checkSession() { return user }
        return nil
    }

    /* Ends the session on the server (best effort) and forgets it here; AccountStore.wipe removes the rest. */
    /* Ends a session by its token alone, touching nothing this phone has stored. Best effort: it runs out by itself otherwise. */
    static func endSession(origin: String, token: String) async {
        let cookieName = origin.hasPrefix("https:") ? "__Host-hushos-session" : "hushos-session"
        _ = try? await send(origin, "/api/auth/logout", [:], cookie: "\(cookieName)=\(token)")
    }

    public static func signOut() async {
        if let session = SharedKeychain.session {
            let cookieName = session.origin.hasPrefix("https:") ? "__Host-hushos-session" : "hushos-session"
            _ = try? await post(session.origin, "/api/auth/logout", [:], cookie: "\(cookieName)=\(session.token)")
        }
        SharedKeychain.delete(SharedKeychain.sessionAccount)
        // Signing out removes this device on the server; its key goes too, so the next sign-in is a new device.
        SharedKeychain.delete(SharedKeychain.deviceIdentityAccount)
    }
}
