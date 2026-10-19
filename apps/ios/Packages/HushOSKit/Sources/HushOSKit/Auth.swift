import Foundation
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
    case sessionEnded

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

    private static func post(_ origin: String, _ path: String, _ body: [String: Any], cookie: String? = nil) async throws -> Reply {
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
            (data, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        } catch {
            if ErrorWords.isCancellation(error) { throw CancellationError() }
            throw AuthError.message(AuthError.unreachable)
        }
        let http = response as? HTTPURLResponse
        let parsed = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        guard let http, (200 ..< 300).contains(http.statusCode) else {
            throw AuthError.message(parsed["message"] as? String ?? "Something went wrong on HushOS. Try again in a moment.")
        }
        return Reply(body: parsed, cookie: sessionToken(setCookie: http.value(forHTTPHeaderField: "Set-Cookie")))
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

    /* Signs in, stores the session and (when needed) a new device memory; returns who signed in. */
    @discardableResult
    public static func signIn(origin: String, email: String, password: String) async throws -> SessionUser {
        let start = try opaqueStartLogin(password: password)
        let started = try await post(origin, "/api/auth/login/start", ["email": email, "startLoginRequest": start.request]).body
        guard let attemptToken = started["attemptToken"] as? String, let loginResponse = started["loginResponse"] as? String else {
            throw AuthError.message("Unexpected reply from HushOS.")
        }
        guard let finish = try opaqueFinishLogin(password: password, state: start.state, loginResponse: loginResponse) else {
            throw AuthError.wrongPassword
        }
        var finishBody: [String: Any] = ["attemptToken": attemptToken, "finishLoginRequest": finish.request]
        // The device key's proof, only for the account it was made for: the same device comes back.
        if let proof = deviceProof(identity: SharedKeychain.deviceIdentity, email: email, attemptToken: attemptToken) {
            finishBody["device"] = proof
        }
        let finished = try await post(origin, "/api/auth/login/finish", finishBody)
        guard let userJson = finished.body["user"] as? [String: Any] else { throw AuthError.message("Signed in, but HushOS returned no account.") }
        let user = try JSONDecoder().decode(SessionUser.self, from: JSONSerialization.data(withJSONObject: userJson))
        guard let envelopeJson = finished.body["envelope"] as? [String: Any] else { throw AuthError.message("Signed in, but HushOS returned no account key.") }
        guard let token = finished.cookie else { throw AuthError.noSession }
        // Another account's data on this phone goes before this one's session exists.
        AccountStore.shared.claim(AccountOwner(userId: user.id, origin: origin))
        try SharedKeychain.write(SharedKeychain.configAccount, SharedKeychain.Config(origin: origin))
        try SharedKeychain.write(SharedKeychain.sessionAccount, SharedKeychain.Session(origin: origin, token: token, userId: user.id))
        // A device the proof did not bring back describes itself and gets a key; a failure waits for the next launch.
        if let device = SessionDevice(json: finished.body["device"] as? [String: Any]) {
            try? await registerDevice(if: device, userId: user.id, email: user.email.isEmpty ? email : user.email)
        }

        let envelope = AccountKeyEnvelope(
            envelopeVersion: UInt32((envelopeJson["envelopeVersion"] as? NSNumber)?.intValue ?? 0),
            keyVersion: (envelopeJson["keyVersion"] as? NSNumber)?.uint64Value ?? 0,
            credentialVersion: (envelopeJson["credentialVersion"] as? NSNumber)?.uint64Value ?? 0,
            wrappingSalt: envelopeJson["wrappingSalt"] as? String ?? "",
            wrappingNonce: envelopeJson["wrappingNonce"] as? String ?? "",
            encryptedKey: envelopeJson["encryptedKey"] as? String ?? ""
        )
        // A remembered device for this user and credential is kept; otherwise make one now.
        if let existing = try? SharedKeychain.device?.open(),
           existing.bundle.userId.lowercased() == user.id.lowercased(),
           existing.bundle.credentialVersion == envelope.credentialVersion {
            return user
        }
        let accountKey = try accountUnlock(userId: user.id, exportKey: finish.exportKey, envelope: envelope)
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

    public static func checkSession() async throws -> SessionCheck {
        guard let session = SharedKeychain.session else { return .ended }
        return try await checkSession(session)
    }

    public static func checkSession(_ session: SharedKeychain.Session) async throws -> SessionCheck {
        guard let url = URL(string: session.origin + "/api/auth/session") else { return .ended }
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = false
        let cookieName = session.origin.hasPrefix("https:") ? "__Host-hushos-session" : "hushos-session"
        request.setValue("\(cookieName)=\(session.token)", forHTTPHeaderField: "Cookie")
        request.setValue(session.origin, forHTTPHeaderField: "Origin")
        request.setValue(DriveAPI.clientHeader, forHTTPHeaderField: "HushOS-Client")
        request.timeoutInterval = 20
        let (data, response) = try await URLSession(configuration: testTransport ?? .ephemeral).data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return .ended }
        return try SessionCheck(body: data)
    }

    /* Who the stored session belongs to, or nil when it is gone. */
    public static func currentUser() async throws -> SessionUser? {
        if case let .signedIn(user, _) = try await checkSession() { return user }
        return nil
    }

    /* Ends the session on the server (best effort) and forgets it here; AccountStore.wipe removes the rest. */
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
