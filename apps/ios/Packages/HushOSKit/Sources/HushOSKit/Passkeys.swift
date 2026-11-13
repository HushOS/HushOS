import Foundation
import HushOSCore

/*
 * Passkeys and security keys as the second step (docs/two-step-design.md 3, 6, 12): which server
 * this build can use one for, what the app tells a server it can answer (`twoStepMethods`) and
 * when, and the bytes between the core's base64url and what AuthenticationServices takes and hands
 * back. The system's sheet itself is the app's (`App/PasskeySheet.swift`); everything here is
 * plain values, so it is tested without one.
 */

/*
 * Whether this build can use a passkey or security key for `serverOrigin`: only over https, and
 * only for the host the app is associated with (`webcredentials:` in its entitlements, hushos.com
 * for the store build). Apple's providers refuse any other RP ID, so for a self-hosted server, or
 * localhost, the app names no key and is never shown one. A port other than 443 is another origin
 * to the server, and the system's sheet signs for the host alone: refused too.
 */
public func passkeysUsable(serverOrigin: String, linkHost: String?) -> Bool {
    guard let linked = linkHost?.trimmingCharacters(in: .whitespaces).lowercased(), !linked.isEmpty,
          let url = URLComponents(string: serverOrigin), url.scheme?.lowercased() == "https",
          let host = url.host?.lowercased(), host == linked,
          url.port == nil || url.port == 443, url.user == nil, url.password == nil
    else { return false }
    return true
}

public enum Passkeys {
    /*
     * The host this build is associated with, as its Info.plist says it (`HushOSLinkHost`, from the
     * build setting HUSHOS_LINK_HOST the entitlements use). A bundle that carries none (the
     * extensions, the package's tests) can use no passkey.
     */
    public static let linkHost: String? = host(in: Bundle.main.object(forInfoDictionaryKey: "HushOSLinkHost"))

    /* A setting that was never filled in ("$(HUSHOS_LINK_HOST)" left as it is, or empty) names no host. */
    static func host(in value: Any?) -> String? {
        guard let text = (value as? String)?.trimmingCharacters(in: .whitespaces), !text.isEmpty, !text.contains("$") else { return nil }
        return text
    }

    public static func usable(for origin: String) -> Bool { passkeysUsable(serverOrigin: origin, linkHost: linkHost) }

    /* For the server this phone is signed in to; false with nobody signed in. */
    public static var usableNow: Bool { Auth.currentSession.map { usable(for: $0.origin) } ?? false }

    /* The most keys an account can have. */
    public static let limit = 10

    /* The one algorithm Apple's providers make a key with (COSE ES256). */
    public static let es256 = -7

    /* What a security key connects over, as WebAuthn names it and as Apple's descriptors take it. */
    static let securityKeyTransports = ["usb", "nfc", "ble"]

    /*
     * The transports to name for a key in a security-key request: the ones it reported that a
     * security key uses; all of them when it reported none (an older key, or a platform that said
     * nothing); nil when it reported only others (`internal`, `hybrid`: a passkey, which the
     * platform's own request covers).
     */
    public static func securityKeyTransports(_ reported: [String]) -> [String]? {
        if reported.isEmpty { return securityKeyTransports }
        let named = securityKeyTransports.filter(reported.contains)
        return named.isEmpty ? nil : named
    }

    /* What a passkey the phone or a password manager holds is reached over. */
    public static let platformTransports = ["internal", "hybrid"]

    static func data(_ base64url: String) -> Data? {
        guard !base64url.isEmpty, let bytes = try? base64urlDecode(value: base64url), !bytes.isEmpty else { return nil }
        return bytes
    }
}

/* One of the account's keys, in bytes: its credential id and the transports it reported. */
public struct KeyDescriptor: Sendable, Equatable {
    public let id: Data
    public let transports: [String]

    init?(_ key: StepKey) {
        guard let id = Passkeys.data(key.id) else { return nil }
        self.id = id
        transports = key.transports
    }
}

/*
 * What a step asks a key, as AuthenticationServices takes it: the challenge and the credential ids
 * as bytes. Nil when anything in it is not base64url: a key is asked the server's request whole, or
 * not at all.
 */
public struct KeyAsk: Sendable, Equatable {
    public let rpId: String
    public let challenge: Data
    public let keys: [KeyDescriptor]

    public init?(_ request: StepKeyRequest) {
        guard !request.rpId.isEmpty, let challenge = Passkeys.data(request.challenge) else { return nil }
        let keys = request.keys.compactMap(KeyDescriptor.init)
        guard !keys.isEmpty, keys.count == request.keys.count else { return nil }
        rpId = request.rpId
        self.challenge = challenge
        self.keys = keys
    }

    /*
     * The keys a security-key request names, each with the transports to name. Empty when every
     * key is a passkey: the request is then left out, since one that names no key would take any.
     */
    public var securityKeys: [KeyDescriptor] { Self.securityKeys(keys) }

    static func securityKeys(_ keys: [KeyDescriptor]) -> [KeyDescriptor] {
        keys.compactMap { key in Passkeys.securityKeyTransports(key.transports).map { KeyDescriptor(id: key.id, transports: $0) } }
    }
}

private extension KeyDescriptor {
    init(id: Data, transports: [String]) {
        self.id = id
        self.transports = transports
    }
}

/* What a new key is asked, as AuthenticationServices takes it. Nil when the server offers no algorithm Apple's providers make. */
public struct KeyMake: Sendable, Equatable {
    public let rpId: String
    public let challenge: Data
    public let userId: Data
    public let userName: String
    public let userDisplayName: String
    /* COSE identifiers, the server's that this phone can make. */
    public let algorithms: [Int]
    /* The account's keys, so the same one is not added twice. */
    public let exclude: [KeyDescriptor]

    public init?(_ creation: KeyCreation) {
        guard !creation.rpId.isEmpty, let challenge = Passkeys.data(creation.challenge), let userId = Passkeys.data(creation.userId) else { return nil }
        let algorithms = creation.algorithms.filter { $0 == Int64(Passkeys.es256) }.map { Int($0) }
        let exclude = creation.exclude.compactMap(KeyDescriptor.init)
        guard !algorithms.isEmpty, exclude.count == creation.exclude.count else { return nil }
        rpId = creation.rpId
        self.challenge = challenge
        self.userId = userId
        userName = creation.userName
        userDisplayName = creation.userDisplayName
        self.algorithms = algorithms
        self.exclude = exclude
    }

    public var securityKeysExcluded: [KeyDescriptor] { KeyAsk.securityKeys(exclude) }
}

public extension KeyAssertion {
    /* A key's answer as the system hands it back, cut down to what the server checks: each base64url without padding. */
    init(credentialID: Data, rawClientDataJSON: Data, rawAuthenticatorData: Data, signature: Data) {
        self.init(
            credentialId: base64urlEncode(bytes: credentialID), clientDataJson: base64urlEncode(bytes: rawClientDataJSON),
            authenticatorData: base64urlEncode(bytes: rawAuthenticatorData), signature: base64urlEncode(bytes: signature)
        )
    }
}

public extension KeyRegistration {
    /* A new key as the system hands it back, with the transports it is reached over. */
    init(credentialID: Data, rawClientDataJSON: Data, rawAttestationObject: Data, transports: [String]) {
        self.init(
            credentialId: base64urlEncode(bytes: credentialID), clientDataJson: base64urlEncode(bytes: rawClientDataJSON),
            attestationObject: base64urlEncode(bytes: rawAttestationObject), transports: transports
        )
    }
}

/* Asks a key what a step asks it: the app's is the system's sheet, a test's is whatever it likes. */
public typealias KeyAsker = @Sendable (StepKeyRequest) async throws -> KeyAssertion
/* Makes a new key for the account. */
public typealias KeyMaker = @Sendable (KeyCreation) async throws -> KeyRegistration

/*
 * A key that was asked and did not answer: the sheet was closed, no key was there, the system
 * refused. Nothing was sent, so the step, or the setup, is as it was.
 */
public struct KeyUnused: Error, WordedError, Equatable, Sendable {
    public let message: String
    public var errorDescription: String? { message }

    public static let atStep = KeyUnused(message: StepWords.keyUnused)
    public static let adding = KeyUnused(message: StepWords.keyNotAdded)
}

/*
 * A key's ceremony, held to the session it was asked under. The system's sheet can stay open for
 * minutes, and the app can be signed out meanwhile (the device removed, the session ended, another
 * account signed in). What the key hands back then is not sent: it would add a key, or answer a
 * step, for a screen that is gone, under whatever session is there now. It is `unused`, as a closed
 * sheet is: nothing went out. A sign-in's step has no session before or after, and passes.
 */
public enum KeySession {
    /* Under the session this phone holds now. */
    public static func held<Made: Sendable>(unused: KeyUnused, _ ceremony: () async throws -> Made) async throws -> Made {
        try await held(unused: unused, session: { Auth.currentSession?.tag }, ceremony)
    }

    static func held<Made: Sendable>(
        unused: KeyUnused, session: @Sendable () -> String?, _ ceremony: () async throws -> Made
    ) async throws -> Made {
        let asked = session()
        let made = try await ceremony()
        guard session() == asked else { throw unused }
        return made
    }
}

/* Whether a server said it reads `twoStepMethods`, as far as this phone knows. */
public enum StepAdvert: Sendable, Equatable {
    /* Its last `login/start` reply said so: the field is sent. */
    case advertised
    /* It did not, or it refused the field since: the field is not sent. */
    case notAdvertised
    /* A session from before this build knew to look: the field is sent once, and a refusal remembered. */
    case neverSeen
}

/*
 * What each server said, kept across launches: a session lasts 30 days, and its changes name
 * methods too. One entry per server origin, in the account's own state (`state/`), so it goes with
 * the account at sign-out; every sign-in hears it again from `login/start`.
 *
 * "Does not read it" is believed for a day and no longer (`noFor`). A server is updated while
 * sessions on it live on, and a session that went on believing the old answer would never be
 * offered its passkey at a change. After a day the server counts as never heard: the field is
 * tried once more, and a refusal remembered again.
 */
public struct StepAdverts: Sendable {
    /* What is kept for one server: its answer, and when it was heard. */
    public struct Kept: Codable, Equatable, Sendable {
        public let advertised: Bool
        public let at: Date
    }

    /* How long "does not read it" is believed. */
    public static let noFor: TimeInterval = 24 * 60 * 60

    let load: @Sendable () -> [String: Kept]
    let save: @Sendable ([String: Kept]) -> Void
    let now: @Sendable () -> Date

    init(load: @escaping @Sendable () -> [String: Kept], save: @escaping @Sendable ([String: Kept]) -> Void, now: @escaping @Sendable () -> Date = { Date() }) {
        self.load = load
        self.save = save
        self.now = now
    }

    static let file = "step-methods.json"
    public static let stored = StepAdverts(load: { Unbacked.read([String: Kept].self, file) ?? [:] }, save: { Unbacked.write($0, file) })

    public func state(for origin: String) -> StepAdvert {
        guard let kept = load()[origin] else { return .neverSeen }
        if kept.advertised { return .advertised }
        // A time from the future is a clock that moved: not believed, and tried again.
        let age = now().timeIntervalSince(kept.at)
        return age >= 0 && age < Self.noFor ? .notAdvertised : .neverSeen
    }

    public func remember(_ advertised: Bool, for origin: String) {
        var all = load()
        // The same answer again is kept as first heard, while it still stands: a "no" heard a
        // day ago and heard again now starts its day over.
        if let kept = all[origin], kept.advertised == advertised, advertised || state(for: origin) == .notAdvertised { return }
        all[origin] = Kept(advertised: advertised, at: now())
        save(all)
    }
}

/*
 * `twoStepMethods` on a request (docs/two-step-design.md 12, "Older apps and servers"): sent to a
 * server that says it reads it and to one never heard either way, never to one that does not. A
 * server whose schema refuses the field (422, or the 400 its auth routes answer a body they cannot
 * read with) looked at nothing else, so the same request goes once more without it.
 */
enum StepMethodsField {
    static let name = "twoStepMethods"

    struct Sent<Reply> {
        let reply: Reply
        /* The field was refused and the same request without it was not: this server does not read it. */
        let unread: Bool
    }

    static func send<Reply>(
        advert: StepAdvert, named: [String], body: [String: Any], status: (Reply) -> Int, _ send: ([String: Any]) async throws -> Reply
    ) async throws -> Sent<Reply> {
        guard advert != .notAdvertised else { return Sent(reply: try await send(body), unread: false) }
        var with = body
        with[name] = named
        let first = try await send(with)
        guard stepMethodsRefused(status: UInt16(clamping: status(first))) else { return Sent(reply: first, unread: false) }
        let second = try await send(body)
        // Refused without the field too: it was never the field, and nothing is learnt about it.
        return Sent(reply: second, unread: !stepMethodsRefused(status: UInt16(clamping: status(second))))
    }
}
