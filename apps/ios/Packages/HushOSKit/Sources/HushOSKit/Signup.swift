import Foundation
import HushOSCore

/* A verified sign-up link: the address it confirmed, and the enrollment the server wants back. */
public struct SignupEnrollment: Sendable, Equatable {
    public let email: String
    let origin: String
    let token: String
}

/*
 * Sign-up, as the web's /register: the server emails a link; the link proves the address and
 * leaves an enrollment token (kept in memory only); the password registers with OPAQUE; every
 * key is made on this phone by the core (`accountCreate`) and only sealed halves and public keys
 * are sent. The caller then signs in with the password, as the web does, and reads the phrase back.
 */
extension Auth {
    public static func requestSignupEmail(origin: String, email: String) async throws {
        _ = try await recoveryRequest(origin, "/api/auth/register/email", body: ["email": email])
    }

    /* The emailed link's token, traded for the enrollment; a link meant for a reset says so. */
    public static func verifySignupLink(origin: String, token: String) async throws -> SignupEnrollment {
        let reply = try await recoveryRequest(origin, "/api/auth/register/verify", body: ["token": token])
        let enrollment = reply.body["enrollment"] as? [String: Any]
        guard enrollment?["purpose"] as? String == "register" else {
            throw AuthError.message("This link belongs to a different account flow. Request a new link.")
        }
        guard let email = enrollment?["email"] as? String, let cookie = enrollmentToken(setCookie: reply.setCookie) else {
            throw AuthError.message("Unexpected reply from HushOS.")
        }
        return SignupEnrollment(email: email, origin: origin, token: cookie)
    }

    /* Creates the account; returns its user id. Nothing is stored here: the caller signs in next. */
    public static func register(_ enrollment: SignupEnrollment, name: String, password: String) async throws -> String {
        let origin = enrollment.origin
        let registration = try opaqueStartRegistration(password: password)
        let challenge = try await recoveryRequest(origin, "/api/auth/register/start", body: ["registrationRequest": registration.request],
                                                  enrollment: enrollment.token).body
        guard let userId = challenge["userId"] as? String, let registrationResponse = challenge["registrationResponse"] as? String else {
            throw AuthError.message("Unexpected reply from HushOS.")
        }
        let registered = try opaqueFinishRegistration(password: password, state: registration.state, registrationResponse: registrationResponse)
        let made = try accountCreate(userId: userId, exportKey: registered.exportKey)
        let sealed = made.envelope
        _ = try await recoveryRequest(origin, "/api/auth/register/finish", body: [
            "name": name,
            "registrationRecord": registered.record,
            "envelope": [
                "envelopeVersion": sealed.envelopeVersion, "keyVersion": sealed.keyVersion, "credentialVersion": sealed.credentialVersion,
                "wrappingSalt": sealed.wrappingSalt, "wrappingNonce": sealed.wrappingNonce, "encryptedKey": sealed.encryptedKey,
            ],
            "recovery": json(made.recovery),
            "identity": json(made.identity),
            "workspace": ["id": made.workspaceId, "grant": json(made.grant)],
        ], enrollment: enrollment.token)
        return userId
    }
}

/*
 * What sign-up checks before anything is sent, in the web's words (apps/web/src/lib/form.ts).
 * The password rule matters most: OPAQUE means the server never sees the password, so this is
 * the only check there is. Lengths count UTF-16 units, as JavaScript's `length` does
 * (packages/crypto checkPassword), so a password the web refuses is refused here; Swift's
 * `count` (grapheme clusters) would let a short password of emoji through.
 */
public enum SignupRules {
    public static let passwordMin = 12
    public static let passwordMax = 128
    public static let nameMax = 100

    public static func email(_ value: String) -> String? {
        let address = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let shaped = address.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) != nil
        return address.utf16.count > 254 || !shaped ? "Enter an email address like name@example.com." : nil
    }

    public static func agreed(_ agreed: Bool) -> String? { agreed ? nil : "Agree to the terms to carry on." }

    public static func name(_ value: String) -> String? {
        let name = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return "Enter your name." }
        return name.utf16.count > nameMax ? "Use no more than \(nameMax) characters." : nil
    }

    public static func password(_ value: String) -> String? {
        let length = value.utf16.count
        if length < passwordMin { return "Use at least \(passwordMin) characters." }
        return length > passwordMax ? "Use no more than \(passwordMax) characters." : nil
    }

    public static func confirm(_ password: String, _ confirm: String) -> String? {
        // Swift's == treats differently composed text as equal, as OPAQUE does after it normalises (NFC).
        password == confirm ? nil : "The passwords don’t match."
    }
}

/*
 * A new account's words this phone made and hasn't seen checked: set when the account is
 * created (before any session exists), cleared when the check finishes or the server says the
 * words are saved. In `local/`, not `state/`: signing in to the new account claims the phone for
 * it and wipes `state/`. Keyed by user id, so another account signing in here is never held.
 */
public enum WordsWaiting {
    private static var file: URL { Unbacked.local.appendingPathComponent("words-waiting.json") }

    public static func set(userId: String) {
        guard let data = try? JSONEncoder().encode(userId.lowercased()) else { return }
        try? data.write(to: file, options: .atomic)
    }

    public static func clear() { try? FileManager.default.removeItem(at: file) }

    public static func isWaiting(for userId: String) -> Bool {
        guard let data = try? Data(contentsOf: file), let owner = try? JSONDecoder().decode(String.self, from: data) else { return false }
        return owner == userId.lowercased()
    }
}
