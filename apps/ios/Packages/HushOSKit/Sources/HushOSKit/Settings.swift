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
    /*
     * How the stored envelope is sealed: 2 under the settings key. A version 1 document (sealed
     * under the identity, which no longer opens) reads as empty settings at its served version,
     * and the next save writes version 2 over it.
     */
    var envelopeVersion: UInt32 = 2
    /* The settings key as the server keeps it, when the account has one. */
    var keyEnvelope: SettingsKeyEnvelope?

    init(json: String, version: UInt64) throws {
        guard let object = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else {
            throw ContactError.message("Unsupported settings document.")
        }
        document = object
        self.version = version
    }

    init(version: UInt64 = 0, keyEnvelope: SettingsKeyEnvelope? = nil) {
        document = ["version": 1, "contacts": [String: Any]()]
        self.version = version
        self.keyEnvelope = keyEnvelope
    }

    /*
     * A served envelope, opened: version 2 under the settings key; version 1 (which the core no
     * longer opens) as empty settings at its served version, so the next save writes version 2
     * over it. A version 2 document that doesn't open is refused, never read as empty: empty
     * settings would drop every pin and the ledger as surely as a rollback.
     */
    static func opened(userId: String, envelope: SettingsEnvelope, settingsKey: Data?) throws -> Settings {
        var settings: Settings
        if let json = try settingsOpen(userId: userId, settingsKey: settingsKey, envelope: envelope) {
            settings = try Settings(json: json, version: envelope.settingsVersion)
        } else {
            settings = Settings(version: envelope.settingsVersion)
        }
        settings.envelopeVersion = envelope.version
        return settings
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
        raw["keyVersion"] = pin.keyVersion.map { NSNumber(value: $0) } ?? NSNull()
        raw["previousSigningKeys"] = pin.previousSigningKeys
        raw["keysReplacedAt"] = pin.keysReplacedAt
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
    /* The settings key out of the envelope the server keeps beside the settings, under the account key; kept for the process. */
    private func openSettingsKey(_ envelope: SettingsKeyEnvelope) throws -> Data {
        if let settingsKey { return settingsKey }
        let key = try settingsKeyOpen(userId: session.userId, accountKey: try unlockAccount(), envelope: envelope)
        settingsKey = key
        return key
    }

    /*
     * The settings key to seal under: the stored one, or a new one stored once. Two devices
     * making one at the same moment: the server keeps the first, and the second opens that.
     */
    private func ensureSettingsKey(_ stored: SettingsKeyEnvelope?) async throws -> Data {
        if let stored { return try openSettingsKey(stored) }
        let made = try settingsKeyCreate(userId: session.userId, accountKey: try unlockAccount())
        do {
            try await Auth.putSettingsKey(made.envelope)
            settingsKey = made.key
            return made.key
        } catch AuthError.conflict {
            guard let raced = try await Auth.settings().key else { throw AuthError.message("Your settings key couldn’t be read. Try again.") }
            return try openSettingsKey(raced)
        }
    }

    /*
     * The settings document, opened and checked against the highest version this device has
     * seen for this account: version 2 under the settings key. A version 1 document no longer
     * opens (it was sealed under a key off the identity, which a stolen identity key
     * reproduces): it reads as empty settings, and the next save starts afresh at version 2.
     */
    func loadSettings() async throws -> Settings {
        let marks = SettingsMarks.shared
        let reply = try await Auth.settings()
        try marks.check(userId: session.userId, served: reply.envelope?.settingsVersion)
        guard let envelope = reply.envelope else { return Settings(keyEnvelope: reply.key) }
        var settings: Settings
        if envelope.version == 2 {
            guard let stored = reply.key else { throw ContactError.message("Your settings key is missing. Try again later.") }
            settings = try Settings.opened(userId: session.userId, envelope: envelope, settingsKey: try openSettingsKey(stored))
        } else {
            settings = try Settings.opened(userId: session.userId, envelope: envelope, settingsKey: nil)
        }
        settings.keyEnvelope = reply.key
        marks.record(userId: session.userId, version: envelope.settingsVersion)
        lastPins = settings.contacts
        return settings
    }

    /*
     * Reads, changes and writes the document one version up, always as version 2 under the
     * settings key (made and stored first if the account has none). Another device writing
     * meanwhile makes the server refuse the stale base: read again and apply the change again.
     */
    @discardableResult
    func updateSettings(_ change: (inout Settings) throws -> Void) async throws -> Settings {
        var attempt = 0
        while true {
            var settings = try await loadSettings()
            try change(&settings)
            let settingsKey = try await ensureSettingsKey(settings.keyEnvelope)
            let sealed = try settingsSeal(userId: session.userId, settingsKey: settingsKey, settingsVersion: settings.version + 1, json: try settings.json())
            do {
                try await Auth.putSettings(expectedVersion: settings.version, envelope: sealed)
                SettingsMarks.shared.record(userId: session.userId, version: settings.version + 1)
                settings.version += 1
                settings.envelopeVersion = sealed.version
                trustedSigners = nil
                return settings
            } catch AuthError.conflict where attempt < 2 {
                attempt += 1
            }
        }
    }

    /* A version 1 document (read as empty) is written over as version 2 under the settings key, which outlives an identity. */
    func ensureSettingsKeyed() async throws {
        let settings = try await loadSettings()
        if settings.version == 0 || settings.envelopeVersion == 2 { return }
        try await updateSettings { _ in }
    }

    /* Everyone pinned as of the last settings read, checked or not, by lowercase id: for offering a check, never for trust. */
    public func knownPins() -> [String: ContactPin] {
        Dictionary(lastPins.values.map { ($0.userId.lowercased(), $0) }, uniquingKeysWith: { a, _ in a })
    }

    /* What this account shared, by its own record. */
    public func sharingLedger() async throws -> SharingLedger { try await loadSettings().ledger }
}
