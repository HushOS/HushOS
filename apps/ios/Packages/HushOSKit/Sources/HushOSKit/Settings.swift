import Foundation
import HushOSCore

/*
 * The owner's own record of what they shared, kept sealed in the settings document
 * (`sharing`, as the web writes it): the people each node was shared with and the
 * links they made. The server lists shares and links on every rotation, and its list
 * is only a claim: sealing again what it names would hand a node key to anyone it
 * added, or revive what the owner stopped. Only what the ledger holds is sealed again,
 * and a stop leaves the ledger before it reaches the server.
 */
public struct SharingLedger: Equatable, Sendable {
    /* Node id to the grantees it was shared with. */
    public var shares: [String: [String]] = [:]
    /* Link id to the node it opens. */
    public var links: [String: String] = [:]

    public init(shares: [String: [String]] = [:], links: [String: String] = [:]) {
        self.shares = shares
        self.links = links
    }

    public func holdsShare(node nodeId: String, grantee: String) -> Bool {
        shares[nodeId.lowercased()]?.contains(grantee.lowercased()) == true
    }

    public func holdsLink(_ linkId: String, node nodeId: String) -> Bool {
        links[linkId.lowercased()] == nodeId.lowercased()
    }

    mutating func addShare(node nodeId: String, grantee: String) {
        let (node, person) = (nodeId.lowercased(), grantee.lowercased())
        if shares[node]?.contains(person) != true { shares[node, default: []].append(person) }
    }

    mutating func removeShare(node nodeId: String, grantee: String) {
        let node = nodeId.lowercased()
        shares[node]?.removeAll { $0 == grantee.lowercased() }
        if shares[node]?.isEmpty == true { shares[node] = nil }
    }

    mutating func addLink(_ linkId: String, node nodeId: String) { links[linkId.lowercased()] = nodeId.lowercased() }

    mutating func removeLink(_ linkId: String) { links[linkId.lowercased()] = nil }
}

/*
 * The settings document, opened, kept whole: the web and later versions write fields this
 * version does not know (inside a pin too), and a save must hand them back untouched. So
 * the JSON object is the state, and pins and the ledger are read from it and written into it.
 */
struct Settings {
    var document: [String: Any]
    /* The version the server holds; 0 when there is no document yet. */
    var version: UInt64

    init(json: String, version: UInt64) throws {
        guard let object = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else {
            throw ContactError.message("Unsupported settings document.")
        }
        document = object
        self.version = version
    }

    init(version: UInt64 = 0) {
        document = ["version": 1, "contacts": [String: Any]()]
        self.version = version
    }

    private var rawContacts: [String: Any] { document["contacts"] as? [String: Any] ?? [:] }

    var contacts: [String: ContactPin] {
        var out: [String: ContactPin] = [:]
        for (id, value) in rawContacts {
            guard let raw = value as? [String: Any], let data = try? JSONSerialization.data(withJSONObject: raw),
                  let pin = try? JSONDecoder().decode(ContactPin.self, from: data) else { continue }
            out[id] = pin
        }
        return out
    }

    /* A pin written over what was there: known fields replaced, unknown ones kept. */
    mutating func setPin(_ pin: ContactPin) {
        var contacts = rawContacts
        var raw = contacts[pin.userId] as? [String: Any] ?? [:]
        raw["userId"] = pin.userId
        raw["email"] = pin.email
        raw["name"] = pin.name
        raw["encryptionPublicKey"] = pin.encryptionPublicKey
        raw["signingPublicKey"] = pin.signingPublicKey
        raw["fingerprint"] = pin.fingerprint
        raw["pinnedAt"] = pin.pinnedAt
        raw["kemPublicKeyHash"] = pin.kemPublicKeyHash ?? NSNull()
        contacts[pin.userId] = raw
        document["contacts"] = contacts
    }

    mutating func removePin(_ userId: String) {
        var contacts = rawContacts
        contacts[userId] = nil
        document["contacts"] = contacts
    }

    var ledger: SharingLedger {
        get {
            let sharing = document["sharing"] as? [String: Any] ?? [:]
            var ledger = SharingLedger()
            for (node, people) in sharing["shares"] as? [String: Any] ?? [:] {
                let ids = (people as? [Any] ?? []).compactMap { ($0 as? String)?.lowercased() }
                if !ids.isEmpty { ledger.shares[node.lowercased()] = ids }
            }
            for (link, node) in sharing["links"] as? [String: Any] ?? [:] {
                if let node = node as? String { ledger.links[link.lowercased()] = node.lowercased() }
            }
            return ledger
        }
        set {
            // Fields beside `shares` and `links` that a later version adds stay as they were.
            var sharing = document["sharing"] as? [String: Any] ?? [:]
            sharing["shares"] = newValue.shares
            sharing["links"] = newValue.links
            document["sharing"] = sharing
        }
    }

    /* The document as sealed: compact, keys sorted, version 1. */
    func json() throws -> String {
        var out = document
        out["version"] = 1
        if out["contacts"] == nil { out["contacts"] = [String: Any]() }
        let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys, .withoutEscapingSlashes])
        return String(decoding: data, as: UTF8.self)
    }
}

/*
 * The highest settings version this device has seen, per account and identity key. The
 * server could otherwise hand back an older document (a pin since replaced, a share
 * since stopped in the ledger) and every client would take it. Kept on this phone only,
 * and kept across sign-outs, since a rollback is likeliest right after signing in again;
 * the key is a digest, so the file names no account.
 */
public struct SettingsMarks: Sendable {
    let file: URL

    public static let rolledBack = "The server sent older settings than this device has seen. Nothing was changed."

    static var shared: SettingsMarks { SettingsMarks(file: Unbacked.local.appendingPathComponent("settings-marks.json")) }

    static func key(userId: String, encryptionPublicKey: String) -> String {
        keyDigest(publicKey: Data("\(userId.lowercased())\n\(encryptionPublicKey)".utf8))
    }

    private func load() -> [String: UInt64] {
        guard let data = try? Data(contentsOf: file) else { return [:] }
        return (try? JSONDecoder().decode([String: UInt64].self, from: data)) ?? [:]
    }

    func mark(_ key: String) -> UInt64 { load()[key] ?? 0 }

    /* A served document (nil when the server says there is none) checked against the mark. */
    func check(_ key: String, served: UInt64?) throws {
        let seen = mark(key)
        guard seen > 0 else { return }
        guard let served, served >= seen else { throw ContactError.message(Self.rolledBack) }
    }

    /* Raised, never lowered: two processes writing at once keep the higher. */
    func record(_ key: String, version: UInt64) {
        var marks = load()
        guard version > marks[key] ?? 0 else { return }
        marks[key] = version
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(marks) { try? data.write(to: file, options: .atomic) }
    }
}

extension ContactPin {
    /*
     * A pin made after a words check: it has the signing key the words cover, and its
     * fingerprint is the current one over both keys. Pins from before the signing key
     * joined the fingerprint, or a document someone edited, vouch for nothing.
     */
    public var verified: Bool {
        guard !signingPublicKey.isEmpty, let encryption = try? base64urlDecode(value: encryptionPublicKey),
              let signing = try? base64urlDecode(value: signingPublicKey),
              let print = try? identityFingerprint(encryptionPublicKey: encryption, signingPublicKey: signing) else { return false }
        return print == fingerprint
    }

    var displayName: String { name.isEmpty ? email : name }

    /*
     * The keys a share to this person is sealed to, given what the server served for them:
     * the pinned X25519 key and a post-quantum key the pin vouches for, never X25519 alone.
     * A KEM key seen for the first time is taken when the pinned signing key signed it; its
     * digest comes back to be remembered on the pin.
     */
    func sealKeys(encryptionPublicKey served: String, kemPublicKey: String?, kemSignature: String?) throws -> (publicKey: Data, kem: Data, newDigest: String?) {
        guard verified else { throw ContactError.recheck(displayName) }
        guard served == encryptionPublicKey else { throw ContactError.changed }
        let publicKey = try base64urlDecode(value: encryptionPublicKey)
        guard let kemPublicKey, let kem = try? base64urlDecode(value: kemPublicKey) else {
            throw ContactError.noKem(displayName)
        }
        let digest = keyDigest(publicKey: kem)
        if let known = kemPublicKeyHash {
            guard known == digest else { throw ContactError.kemChanged(displayName) }
            return (publicKey, kem, nil)
        }
        // Only the pinned signing key may vouch: the words compared cover it, the served one could be anyone's.
        guard let kemSignature, kemBindingVerify(userId: userId, encryptionPublicKey: encryptionPublicKey, signingPublicKey: signingPublicKey,
                                                 kemPublicKey: kemPublicKey, signature: kemSignature) else {
            throw ContactError.kemUnsigned(displayName)
        }
        return (publicKey, kem, digest)
    }
}

extension Vault {
    private var marksKey: String {
        get async throws {
            let keys = try await identityKeys()
            return SettingsMarks.key(userId: session.userId, encryptionPublicKey: keys.encryptionPublicKey)
        }
    }

    /* The settings document, opened and checked against the highest version this device has seen. */
    func loadSettings() async throws -> Settings {
        let keys = try await identityKeys()
        let marks = SettingsMarks.shared
        let key = try await marksKey
        let envelope = try await Auth.settings()
        try marks.check(key, served: envelope?.settingsVersion)
        guard let envelope else { return Settings() }
        let json = try settingsOpen(identityPrivateKey: keys.encryptionPrivateKey, userId: session.userId, envelope: envelope)
        let settings = try Settings(json: json, version: envelope.settingsVersion)
        marks.record(key, version: envelope.settingsVersion)
        return settings
    }

    /*
     * Reads, changes and writes the document one version up. Another device writing meanwhile
     * makes the server refuse the stale base: read again and apply the change again.
     */
    @discardableResult
    func updateSettings(_ change: (inout Settings) throws -> Void) async throws -> Settings {
        var attempt = 0
        while true {
            var settings = try await loadSettings()
            try change(&settings)
            let keys = try await identityKeys()
            let sealed = try settingsSeal(identityPrivateKey: keys.encryptionPrivateKey, userId: session.userId,
                                          settingsVersion: settings.version + 1, json: try settings.json())
            do {
                try await Auth.putSettings(expectedVersion: settings.version, envelope: sealed)
                SettingsMarks.shared.record(try await marksKey, version: settings.version + 1)
                settings.version += 1
                return settings
            } catch AuthError.conflict where attempt < 2 {
                attempt += 1
            }
        }
    }

    /* What this account shared, by its own record. */
    public func sharingLedger() async throws -> SharingLedger { try await loadSettings().ledger }
}
