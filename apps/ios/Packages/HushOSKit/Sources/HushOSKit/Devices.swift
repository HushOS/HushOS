import Foundation

/*
 * The account's devices (docs/devices-design.md, step 1): the list, this
 * phone's registration, rename, and removal, over the session cookie as every
 * account call goes. Rename is PUT; removal is DELETE carrying a password proof
 * (an OPAQUE exchange started at /api/auth/devices/reauth), the same routes the
 * web and Android use.
 */

/* The session's device: which one, and whether it has described itself yet. */
public struct SessionDevice: Codable, Sendable, Equatable {
    public let id: String
    public let registered: Bool

    public init(id: String, registered: Bool) {
        self.id = id
        self.registered = registered
    }

    init?(json: [String: Any]?) {
        guard let json, let id = json["id"] as? String else { return nil }
        self.init(id: id, registered: json["registered"] as? Bool ?? false)
    }
}

/* One of the account's devices, as the list shows it. Kind and name are null for a device that never described itself. */
public struct AccountDevice: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let kind: String?
    public let name: String?
    public let approvedBy: String?
    public let approvedByDeviceId: String?
    public let createdAt: String
    public let lastSeenAt: String
    public let current: Bool
    public let signedIn: Bool

    /* What the list calls it: its name, else what it is, else an unknown device. */
    public var label: String {
        if let name, !name.isEmpty { return name }
        switch kind {
        case "ios": return "iPhone"
        case "android": return "Android phone"
        case "web": return "A web browser"
        default: return "Unknown device"
        }
    }

    /* How it got in, in the words the web uses. */
    public var approval: String? {
        switch approvedBy {
        case "enrolment": return "Where you created your account"
        case "password": return "Signed in with your password"
        case "existing": return "Already signed in when HushOS began listing devices"
        case "device": return "Approved by another of your devices"
        case "phrase": return "Approved with your recovery phrase"
        case "email-wait": return "Approved after the email wait"
        case "guardian": return "Approved by a guardian"
        default: return nil
        }
    }
}

extension Auth.SessionCheck {
    /* `/api/auth/session`'s answer: a user and its device, or none, and then whether its device was removed. */
    init(body: Data) throws {
        struct Body: Decodable {
            let user: SessionUser?
            let device: SessionDevice?
            let removed: Bool?
        }
        let decoded = try JSONDecoder().decode(Body.self, from: body)
        if let user = decoded.user { self = .signedIn(user, decoded.device) }
        else { self = decoded.removed == true ? .removed : .ended }
    }
}

public enum Devices {
    private static func decode<T: Decodable>(_ type: T.Type, _ json: Any?) throws -> T {
        guard let json else { throw AuthError.message("Unexpected reply from HushOS.") }
        return try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: json))
    }

    /* The account's devices, this one first. */
    public static func list() async throws -> [AccountDevice] {
        try decode([AccountDevice].self, try await Auth.call("/api/auth/devices")["devices"])
    }

    /* This phone describes itself, once: its kind, its name and its key (32 bytes, base64url). */
    @discardableResult
    public static func register(kind: String, name: String, signingPublicKey: String?) async throws -> AccountDevice {
        var body: [String: Any] = ["kind": kind, "name": name]
        if let signingPublicKey { body["signingPublicKey"] = signingPublicKey }
        return try decode(AccountDevice.self, try await Auth.call("/api/auth/devices", method: "POST", body: body)["device"])
    }

    @discardableResult
    public static func rename(_ id: String, to name: String) async throws -> AccountDevice {
        try decode(AccountDevice.self, try await Auth.call("/api/auth/devices/\(id)", method: "PUT", body: ["name": name])["device"])
    }

    /*
     * Removing devices proves the password again (OPAQUE in the core, bound to this session), so a
     * session alone cannot sign the other devices out and have them clear what they kept.
     */
    private static func passwordProof(_ password: String) async throws -> [String: Any] {
        let login = try opaqueStartLogin(password: password)
        let started = try await Auth.call("/api/auth/devices/reauth", method: "POST", body: ["startLoginRequest": login.request])
        guard let attemptToken = started["attemptToken"] as? String, let loginResponse = started["loginResponse"] as? String else {
            throw AuthError.message("Unexpected reply from HushOS.")
        }
        guard let finish = try opaqueFinishLogin(password: password, state: login.state, loginResponse: loginResponse) else {
            throw AuthError.message("That password isn’t right. Check it and try again.")
        }
        return ["attemptToken": attemptToken, "finishLoginRequest": finish.request]
    }

    /* Signs another device out at once; the server refuses this phone (sign out instead). */
    public static func remove(_ id: String, password: String) async throws {
        _ = try await Auth.call("/api/auth/devices/\(id)", method: "DELETE", body: try await passwordProof(password))
    }

    /* Every device but this one. Returns how many were removed. */
    @discardableResult
    public static func removeOthers(password: String) async throws -> Int {
        try await Auth.call("/api/auth/devices/others", method: "DELETE", body: try await passwordProof(password))["removed"] as? Int ?? 0
    }

    /*
     * Whether a "removed" answer about `ended` may still clear the phone: only while nobody has
     * signed in since (the session stored is still `ended`, or none is) and what the phone holds is
     * still that account's. The check is out on the network while sign-in may already be on screen;
     * a person who signed in again meanwhile, or someone else who did, must keep what they have.
     */
    public static func mayForgetRemoved(ended: SharedKeychain.Session, current: SharedKeychain.Session?, owner: AccountOwner?) -> Bool {
        (current == nil || current == ended) && owner == AccountOwner(ended)
    }
}
