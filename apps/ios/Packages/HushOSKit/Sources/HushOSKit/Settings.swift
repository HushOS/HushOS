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
        document = ["version": 2, "contacts": [String: Any]()]
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
        // Absent, not null, on a pin from before the release, as the web leaves it.
        raw["mlDsaPublicKeyHash"] = pin.mlDsaPublicKeyHash
        raw["keyVersion"] = pin.keyVersion.map { NSNumber(value: $0) } ?? NSNull()
        raw["previousSigningKeys"] = pin.previousSigningKeys
        raw["keysReplacedAt"] = pin.keysReplacedAt
        if pin.resealShares == true { raw["resealShares"] = true }
        // Known here: a words check (no origin) clears a group's; a followed pin carries it on.
        if let via = pin.trustedVia { raw["trustedVia"] = via } else { raw.removeValue(forKey: "trustedVia") }
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

    /* The document as sealed: compact, keys sorted, version 2 (read as 1 or 2; the only one that may hold version 3 pins). */
    func json() throws -> String {
        var out = document
        out["version"] = 2
        if out["contacts"] == nil { out["contacts"] = [String: Any]() }
        let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys, .withoutEscapingSlashes])
        return String(decoding: data, as: UTF8.self)
    }
}

extension ContactPin {
    /*
     * A version 3 pin made after a words check: it holds the ML-DSA and ML-KEM digests, and its
     * fingerprint is the version 3 one over the X25519 and Ed25519 keys and both digests. A pin
     * from before the post-quantum release (no ML-DSA digest), or one someone edited, vouches
     * for nothing whatever the server serves (docs/identity-pq-design.md 2).
     */
    public var verified: Bool {
        pinVerified(encryptionPublicKey: encryptionPublicKey, signingPublicKey: signingPublicKey,
                    mlDsaPublicKeyHash: mlDsaPublicKeyHash, kemPublicKeyHash: kemPublicKeyHash, fingerprint: fingerprint)
    }

    var displayName: String { name.isEmpty ? email : name }

    /*
     * The keys a share to this person is sealed to, given what the server serves for them: the
     * pinned X25519 key and the served ML-KEM key, only when the comparison is `same` (so the
     * ML-KEM and ML-DSA keys are the ones the version 3 pin's digests name). Never X25519 alone.
     */
    func sealKeys(_ served: ServedContactKeys) throws -> (publicKey: Data, kem: Data) {
        guard verified else { throw ContactError.recheck(displayName) }
        switch compare(served) {
        case .same: break
        case .recheck: throw ContactError.recheck(displayName)
        case .succession, .changed: throw ContactError.changed
        }
        guard let kemPublicKey = served.kemPublicKey, let kem = try? base64urlDecode(value: kemPublicKey) else { throw ContactError.changed }
        return (try base64urlDecode(value: encryptionPublicKey), kem)
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
        // The stored sequence decides, document or not: below the mark is a rollback, a version 1 row included.
        try marks.check(userId: session.userId, served: reply.version)
        var settings: Settings
        if let envelope = reply.envelope {
            guard envelope.settingsVersion == reply.version else { throw ContactError.message("Your settings didn’t add up. Try again later.") }
            if envelope.version == 2 {
                guard let stored = reply.key else { throw ContactError.message("Your settings key is missing. Try again later.") }
                settings = try Settings.opened(userId: session.userId, envelope: envelope, settingsKey: try openSettingsKey(stored))
            } else {
                settings = try Settings.opened(userId: session.userId, envelope: envelope, settingsKey: nil)
            }
        } else {
            // No row (0), or a version 1 row served as none: empty settings at its sequence, written over as version 2 at the next save.
            settings = Settings(version: reply.version)
            settings.envelopeVersion = reply.version == 0 ? 2 : 1
        }
        settings.keyEnvelope = reply.key
        marks.record(userId: session.userId, version: reply.version)
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
            // Named by the stored sequence (a version 1 row's too) and sealed one above it, where the server stores it.
            let sealed = try settingsSeal(userId: session.userId, settingsKey: settingsKey, settingsVersion: settings.version + 1, json: try settings.json())
            do {
                let stored = try await Auth.putSettings(expectedVersion: settings.version, envelope: sealed)
                guard stored == sealed.settingsVersion else { throw ContactError.message("Your settings couldn’t be saved. Try again later.") }
                SettingsMarks.shared.record(userId: session.userId, version: stored)
                settings.version = stored
                settings.envelopeVersion = sealed.version
                forgetSigners()
                return settings
            } catch AuthError.conflict where attempt < 2 {
                attempt += 1
            }
        }
    }

    /* A version 1 row (read as empty) is written over as version 2 under the settings key, which outlives an identity. */
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
