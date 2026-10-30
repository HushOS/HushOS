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
    /*
     * The document's envelope as the server served it (or as this device last stored it): what
     * the area ledger opens itself (`useSettingsEnvelope`), so no pin it reads comes from this app.
     */
    var served: SettingsEnvelope?

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
        if let firstSeen = pin.firstSeen { raw["firstSeen"] = firstSeen }
        contacts[pin.userId] = raw
        document["contacts"] = contacts
    }

    /* The pin of `userId`, under its id in any letters (the web's pinOf). */
    func pin(of userId: String) -> ContactPin? {
        let id = userId.lowercased()
        let all = contacts
        return all[userId] ?? all.first(where: { $0.key.lowercased() == id })?.value
    }

    /*
     * `pin` written for its person, under the served id (a pin stored under the id in other letters
     * goes), their removal forgotten (they are a contact again), and removals forgotten oldest first
     * for room; refused with `contactsFull` when the document would not seal even without any.
     */
    mutating func setPinOnce(_ pin: ContactPin) throws {
        var next = self
        var contacts = next.rawContacts
        for key in contacts.keys where key != pin.userId && key.lowercased() == pin.userId.lowercased() { contacts[key] = nil }
        next.document["contacts"] = contacts
        next.setPin(pin)
        next.forgetRemoval(pin.userId)
        next.fit()
        guard try next.bytes() <= Self.maxBytes else { throw ContactError.message(Self.contactsFull) }
        self = next
    }

    /* The pin removed and the removal recorded (docs/optional-verification.md 2.8): nothing adds them back on its own. */
    mutating func removeContact(_ userId: String, at: String) {
        let id = userId.lowercased()
        var contacts = rawContacts
        for key in contacts.keys where key.lowercased() == id { contacts[key] = nil }
        document["contacts"] = contacts
        var removed = removals.filter { $0.id != id }
        removed.append((id, at))
        document["removedContacts"] = Dictionary(removed.map { ($0.id, $0.at) }, uniquingKeysWith: { a, _ in a })
        fit()
    }

    /* What a sealed document may hold (the core refuses more), and what adding someone says past it (2.7). */
    static let maxBytes = 64 * 1024
    public static let contactsFull = "Your contacts are full. Remove someone you no longer share with."

    /*
     * The removals the document records (`removedContacts`), oldest first; anything malformed is
     * left out, so an odd value from another client never stops a save.
     */
    var removals: [(id: String, at: String)] {
        guard let removed = document["removedContacts"] as? [String: Any] else { return [] }
        return removed.compactMap { key, value in (value as? String).map { (key.lowercased(), $0) } }
            .sorted { $0.at < $1.at || ($0.at == $1.at && $0.id < $1.id) }
    }

    /* Whether this account removed `userId` and has not added them back. */
    func removed(_ userId: String) -> Bool { removals.contains { $0.id == userId.lowercased() } }

    mutating func forgetRemoval(_ userId: String) {
        guard document["removedContacts"] != nil else { return }
        let kept = removals.filter { $0.id != userId.lowercased() }
        if kept.isEmpty { document["removedContacts"] = nil } else {
            document["removedContacts"] = Dictionary(kept.map { ($0.id, $0.at) }, uniquingKeysWith: { a, _ in a })
        }
    }

    /*
     * Removals count against the room a document has (2.7): the oldest are forgotten first, one at
     * a time, until it seals. A document too large without any is left for the caller to refuse.
     */
    mutating func fit() {
        var removed = removals
        while !removed.isEmpty, ((try? bytes()) ?? 0) > Self.maxBytes {
            removed.removeFirst()
            document["removedContacts"] = removed.isEmpty ? nil : Dictionary(removed.map { ($0.id, $0.at) }, uniquingKeysWith: { a, _ in a })
        }
    }

    /* The sealed document's size, as the core measures it. */
    func bytes() throws -> Int { try json().utf8.count }

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

    /*
     * Each family's cross-device mark (`groups`, as the web writes it; docs/groups-design.md 2.7):
     * the pins that read, by family id. One that doesn't read is left out here and refused by
     * `groupPin(_:)`, so it never passes for no mark at all for its own family.
     */
    var groupPins: [String: GroupPin] {
        var out: [String: GroupPin] = [:]
        for (id, _) in document["groups"] as? [String: Any] ?? [:] {
            if let pin = try? groupPin(id) { out[id] = pin }
        }
        return out
    }

    /* The family's pin, nil when there is none; throws when one is there and doesn't read. */
    func groupPin(_ groupId: String) throws -> GroupPin? {
        let groups = document["groups"] as? [String: Any] ?? [:]
        guard let value = groups[groupId] ?? groups.first(where: { $0.key.lowercased() == groupId.lowercased() })?.value else { return nil }
        guard let raw = value as? [String: Any],
              let first = raw["firstEd25519PublicKey"] as? String, let digest = raw["firstMlDsaPublicKeyDigest"] as? String,
              let checkedAt = raw["checkedAt"] as? String, let keyVersion = (raw["keyVersion"] as? NSNumber)?.uint64Value,
              let groupKeyDigest = raw["groupKeyDigest"] as? String, let rosterVersion = (raw["rosterVersion"] as? NSNumber)?.uint64Value,
              let rosterDigest = raw["rosterDigest"] as? String, let areas = raw["areas"] as? [String: Any]
        else { throw ContactError.message("Invalid group pin.") }
        var marks: [String: UInt64] = [:]
        for (workspaceId, version) in areas {
            guard let version = (version as? NSNumber)?.uint64Value else { throw ContactError.message("Invalid group pin.") }
            marks[workspaceId] = version
        }
        let pin = GroupPin(firstEd25519PublicKey: first, firstMlDsaPublicKeyDigest: digest, checkedAt: checkedAt, keyVersion: keyVersion,
                           groupKeyDigest: groupKeyDigest, rosterVersion: rosterVersion, rosterDigest: rosterDigest, areas: marks)
        // As the web's checkGroupPin: canonical keys and digests, versions in range, lowercase area ids.
        return try groupPinCheck(groupId: groupId, pin: pin)
    }

    /* A family's pin written over what was there, exactly its fields (the web's checkGroupPin refuses any other). */
    mutating func setGroupPin(_ groupId: String, _ pin: GroupPin) {
        var groups = document["groups"] as? [String: Any] ?? [:]
        var raw: [String: Any] = [:]
        raw["firstEd25519PublicKey"] = pin.firstEd25519PublicKey
        raw["firstMlDsaPublicKeyDigest"] = pin.firstMlDsaPublicKeyDigest
        raw["checkedAt"] = pin.checkedAt
        raw["keyVersion"] = NSNumber(value: pin.keyVersion)
        raw["groupKeyDigest"] = pin.groupKeyDigest
        raw["rosterVersion"] = NSNumber(value: pin.rosterVersion)
        raw["rosterDigest"] = pin.rosterDigest
        raw["areas"] = pin.areas.mapValues { NSNumber(value: $0) }
        groups[groupId] = raw
        document["groups"] = groups
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

    /* The first word of the name, as every sentence about them says it ("Maya’s account changed"). */
    public var firstName: String { displayName.split(separator: " ").first.map(String.init) ?? displayName }

    /* The key fields every pin rule reads (the core's `PinKeys`). */
    var keys: PinKeys {
        PinKeys(keyVersion: keyVersion, encryptionPublicKey: encryptionPublicKey, signingPublicKey: signingPublicKey,
                mlDsaPublicKeyHash: mlDsaPublicKeyHash, kemPublicKeyHash: kemPublicKeyHash, fingerprint: fingerprint)
    }

    /* Verified (a words check), seen (first-seen: the keys first met, nobody checked), legacy or invalid: the core's one rule. */
    public var trust: PinTrust { pinTrust(pin: keys) }

    /* The key commitment over its four keys (never `fingerprint`, which every first-seen pin holds as ""); nil when malformed. */
    var commitment: String? { keyCommitment(pin: keys) }

    /* Whether two pins hold the same keys: by key commitment, or for pins without one, by every key field. */
    static func sameKeys(_ a: ContactPin?, _ b: ContactPin?) -> Bool {
        guard let a, let b else { return a == nil && b == nil }
        let (left, right) = (a.commitment, b.commitment)
        if left != nil || right != nil { return left == right }
        return a.encryptionPublicKey == b.encryptionPublicKey && a.signingPublicKey == b.signingPublicKey
            && a.mlDsaPublicKeyHash == b.mlDsaPublicKeyHash && a.kemPublicKeyHash == b.kemPublicKeyHash
    }
}

extension Vault {
    /* The settings key out of the envelope the server keeps beside the settings, under the account key; kept for the process. */
    private func openSettingsKey(_ envelope: SettingsKeyEnvelope) throws -> Data {
        if let settingsKey { return settingsKey }
        let key = try settingsKeyOpen(userId: session.userId, accountKey: try unlockAccount(), envelope: envelope)
        settingsKey = key
        settingsKeyEnvelope = envelope
        return key
    }

    /*
     * The settings key the rollback marks are sealed under (RollbackMarks): the envelope kept
     * beside them when it opens under the account key (it does until a master-key rotation), else
     * the one this process opened, else the server's (`served` when the caller has just read it).
     * With `create`, an account with none gets one; without, nil.
     */
    func marksKey(kept: SettingsKeyEnvelope?, create: Bool, served: SettingsKeyEnvelope? = nil) async throws -> MarksKey? {
        if let kept, let key = try? settingsKeyOpen(userId: session.userId, accountKey: try unlockAccount(), envelope: kept) {
            return MarksKey(key: key, envelope: kept)
        }
        if let settingsKey, let settingsKeyEnvelope { return MarksKey(key: settingsKey, envelope: settingsKeyEnvelope) }
        var stored = served
        if stored == nil { stored = try await Auth.settings(as: session).key }
        if let stored { return MarksKey(key: try openSettingsKey(stored), envelope: settingsKeyEnvelope ?? stored) }
        guard create else { return nil }
        let key = try await ensureSettingsKey(nil)
        guard let settingsKeyEnvelope else { return nil }
        return MarksKey(key: key, envelope: settingsKeyEnvelope)
    }

    /* The marks' key, asked of this vault (`served`: the settings key envelope just read, if any). */
    func marksKeys(served: SettingsKeyEnvelope? = nil) -> MarksKeys {
        { kept, create in try await self.marksKey(kept: kept, create: create, served: served) }
    }

    /*
     * The settings key to seal under: the stored one, or a new one stored once. Two devices
     * making one at the same moment: the server keeps the first, and the second opens that.
     */
    private func ensureSettingsKey(_ stored: SettingsKeyEnvelope?) async throws -> Data {
        if let stored { return try openSettingsKey(stored) }
        let made = try settingsKeyCreate(userId: session.userId, accountKey: try unlockAccount())
        do {
            // Under this vault's own session: a key is stored once and for good, so never into another account.
            try await Auth.putSettingsKey(made.envelope, as: session)
            settingsKey = made.key
            settingsKeyEnvelope = made.envelope
            return made.key
        } catch AuthError.conflict {
            guard let raced = try await Auth.settings(as: session).key else { throw AuthError.message("Your settings key couldn’t be read. Try again.") }
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
        let marks = RollbackMarkStore.shared(session: session.token)
        let reply = try await Auth.settings(as: session)
        let document = reply.envelope?.version == 2
        // The stored sequence decides, document or not: below the mark is a rollback, a version 1 row included;
        // and once a version 2 document was seen here, anything else is.
        try SettingsMarks.check(try await marks.read(userId: session.userId, keys: marksKeys(served: reply.key)), served: reply.version, document: document)
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
        settings.served = reply.envelope
        // Taken only with its mark kept: a later visit could not tell an older copy from it otherwise. Checked
        // again against what the write found, for a newer sequence another read recorded meanwhile.
        let kept = try await marks.raise(userId: session.userId, to: RollbackMarks(settings: reply.version, settingsDocument: document, identity: 0, identityVersion: 0), keys: marksKeys(served: reply.key))
        try SettingsMarks.check(kept, served: reply.version, document: document)
        lastPins = settings.contacts
        // The area ledger takes the families' marks from every settings read, as the web's worker does.
        try? useForFamilies(settings)
        return settings
    }

    /*
     * Reads, changes and writes the document one version up, always as version 2 under the
     * settings key (made and stored first if the account has none). Another device writing
     * meanwhile makes the server refuse the stale base: read again and apply the change again.
     */
    @discardableResult
    func updateSettings(_ change: (inout Settings) throws -> Void, beforeSend: ((_ base: UInt64) throws -> Void)? = nil) async throws -> Settings {
        var attempt = 0
        while true {
            var settings = try await loadSettings()
            try change(&settings)
            // Removals count against the room the document has: the oldest go first (docs/optional-verification.md 2.7).
            settings.fit()
            let settingsKey = try await ensureSettingsKey(settings.keyEnvelope)
            // Each attempt names the sequence it lands over (a contact act's pending record), before it is sent.
            try beforeSend?(settings.version)
            // Named by the stored sequence (a version 1 row's too) and sealed one above it, where the server stores it.
            let sealed = try settingsSeal(userId: session.userId, settingsKey: settingsKey, settingsVersion: settings.version + 1, json: try settings.json())
            do {
                let stored = try await Auth.putSettings(expectedVersion: settings.version, envelope: sealed, as: session)
                guard stored == sealed.settingsVersion else { throw ContactError.message("Your settings couldn’t be saved. Try again later.") }
                try await RollbackMarkStore.shared(session: session.token).raise(userId: session.userId, to: RollbackMarks(settings: stored, settingsDocument: true, identity: 0, identityVersion: 0), keys: marksKeys())
                settings.version = stored
                settings.envelopeVersion = sealed.version
                settings.served = sealed
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
