import Foundation

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

public enum AuthError: Error, LocalizedError, Sendable {
    case message(String)
    case wrongPassword
    case noSession

    public var errorDescription: String? {
        switch self {
        case .message(let text): return text
        case .wrongPassword: return "Unable to sign in. Check your email and password."
        case .noSession: return "Signed in, but the session was not returned."
        }
    }
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
        request.setValue("ios/2", forHTTPHeaderField: "HushOS-Client")
        if let cookie { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 30
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        } catch {
            throw AuthError.message("Could not reach HushOS. Check your connection.")
        }
        let http = response as? HTTPURLResponse
        let parsed = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        guard let http, (200 ..< 300).contains(http.statusCode) else {
            throw AuthError.message(parsed["message"] as? String ?? "Please try again.")
        }
        var cookie: String? = nil
        if let header = http.value(forHTTPHeaderField: "Set-Cookie") {
            for part in header.split(separator: ";") {
                let pair = part.trimmingCharacters(in: .whitespaces)
                if pair.hasPrefix("hushos-session=") || pair.hasPrefix("__Host-hushos-session=") {
                    cookie = String(pair.split(separator: "=", maxSplits: 1)[1])
                }
            }
        }
        return Reply(body: parsed, cookie: cookie)
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
        let finished = try await post(origin, "/api/auth/login/finish", [
            "attemptToken": attemptToken, "finishLoginRequest": finish.request,
        ])
        guard let userJson = finished.body["user"] as? [String: Any] else { throw AuthError.message("Signed in, but HushOS returned no account.") }
        let user = try JSONDecoder().decode(SessionUser.self, from: JSONSerialization.data(withJSONObject: userJson))
        guard let envelopeJson = finished.body["envelope"] as? [String: Any] else { throw AuthError.message("Signed in, but HushOS returned no account key.") }
        guard let token = finished.cookie else { throw AuthError.noSession }
        try SharedKeychain.write(SharedKeychain.configAccount, SharedKeychain.Config(origin: origin))
        try SharedKeychain.write(SharedKeychain.sessionAccount, SharedKeychain.Session(origin: origin, token: token, userId: user.id))

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

    /* Who the stored session belongs to, or nil when it is gone. */
    public static func currentUser() async throws -> SessionUser? {
        guard let session = SharedKeychain.session, let url = URL(string: session.origin + "/api/auth/session") else { return nil }
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = false
        let cookieName = session.origin.hasPrefix("https:") ? "__Host-hushos-session" : "hushos-session"
        request.setValue("\(cookieName)=\(session.token)", forHTTPHeaderField: "Cookie")
        request.setValue(session.origin, forHTTPHeaderField: "Origin")
        request.setValue("ios/2", forHTTPHeaderField: "HushOS-Client")
        request.timeoutInterval = 20
        let (data, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
        struct Body: Decodable { let user: SessionUser? }
        return try JSONDecoder().decode(Body.self, from: data).user
    }

    /* Ends the session on the server (best effort) and forgets it here. The device memory stays for the next sign-in. */
    public static func signOut() async {
        if let session = SharedKeychain.session {
            let cookieName = session.origin.hasPrefix("https:") ? "__Host-hushos-session" : "hushos-session"
            _ = try? await post(session.origin, "/api/auth/logout", [:], cookie: "\(cookieName)=\(session.token)")
        }
        SharedKeychain.delete(SharedKeychain.sessionAccount)
    }
}
