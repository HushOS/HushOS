import Foundation
import HushOSCore

/* A person as `POST /api/auth/contacts/lookup` describes them. */
public struct Contact: Sendable, Equatable {
    public let userId: String
    public let name: String
    public let email: String
    /* Raised by each succession. */
    public var keyVersion: UInt64? = nil
    /* 1 until they sign in after the post-quantum release, 2 after. */
    public let identityVersion: Int
    public let encryptionPublicKey: String
    public let signingPublicKey: String
    public let mlDsaPublicKey: String?
    public let kemPublicKey: String?
    public let keysSignature: String?
    /*
     * Whether their identity is version 2 and its keys statement holds: both signing keys signed
     * all four public keys. The only kind words can be compared over; not by itself a reason to
     * trust anyone, which only the words are.
     */
    public let upgraded: Bool
    /* Ten groups of four hex digits over all four public keys (fingerprint version 3); nil until they upgraded. */
    public let fingerprint: String?
}

/* What a pin keeps of a contact, as the settings document stores it. */
public struct ContactPin: Codable, Sendable, Identifiable, Hashable {
    public let userId: String
    public let email: String
    public let name: String
    public let encryptionPublicKey: String
    public let signingPublicKey: String
    public let fingerprint: String
    public let pinnedAt: String
    /* Hex SHA-256 of their ML-KEM key. */
    public var kemPublicKeyHash: String?
    /* Hex SHA-256 of their ML-DSA key: a pin is version 3 exactly when it has one, and only a version 3 pin trusts anything. */
    public var mlDsaPublicKeyHash: String? = nil
    /* The identity key version the pin is at, so a later change is followed along the succession chain from here; absent on older pins. */
    public var keyVersion: UInt64? = nil
    /* Signing keys this person used before, vouched for by a succession chain the pin followed: what they signed then is still theirs. */
    public var previousSigningKeys: [String]? = nil
    /* When the pin last followed a succession rather than a words check: People says so until the words are compared again. */
    public var keysReplacedAt: String? = nil
    /*
     * Set when the pin followed a succession: what this person shared with them still holds the
     * old keys and waits to be sealed to the new ones (the web clears it once it has). Synced, and
     * written only when set, so a save from here never clears another client's.
     */
    public var resealShares: Bool? = nil
    public var id: String { userId }
}

/* A share as the owner sees it. */
public struct ShareView: Codable, Sendable, Identifiable, Hashable {
    public struct Grantee: Codable, Sendable, Hashable {
        public let id: String
        public let name: String
        public let email: String
    }
    public let id: String
    public let role: String
    public let keyEpoch: UInt64
    public let createdAt: String
    public let suite: Int?
    public let grantee: Grantee
}

struct SharesListResponse: Codable, Sendable { let shares: [ShareView] }
struct ShareCreated: Codable, Sendable { let share: ShareView }

/* The lookup's verdict against the pin, the way the web's contacts page shows it. */
public struct Lookup: Sendable {
    public let contact: Contact
    public let pinned: ContactPin?
    /* The served keys differ from the pin and no followed chain explains them: nothing is trusted until the person re-pins. */
    public let changed: Bool
    /* Pinned over these same X25519 and Ed25519 keys, but the pin vouches for nothing (made before the release): compare the words again. */
    public var recheck: Bool = false
    /* The pin just followed their succession to the keys served now: said quietly, with comparing the words again offered. */
    public var followed: Bool = false
    /* Changed, and the served keys are newer than a version 3 pin's: "Check again" may find a succession their pinned keys signed. */
    public var canFollow: Bool = false
    /* Words can be compared only over an upgraded identity whose keys statement holds. */
    public var upgraded: Bool { contact.upgraded }
}

public enum ContactError: Error, LocalizedError, Equatable {
    case unpinned, changed, message(String)
    /* A pin that vouches for nothing (from before the release, or edited): its words must be compared again. */
    case recheck(String)
    /* Their identity is not version 2 yet, or its keys statement does not hold: no words to compare, nothing to seal to. */
    case notUpgraded(String)
    public var errorDescription: String? {
        switch self {
        case .unpinned: return "Add them to your contacts before sharing with them."
        case .changed: return "Their account changed since you added them. Check it’s them in People you share with before you share."
        case .recheck(let name): return "\(name)’s keys were upgraded. Compare words with them again in People you share with before you share."
        case .notUpgraded(let name): return "\(name) needs to sign in to HushOS once more before you can compare words."
        case .message(let text): return text
        }
    }
}

/*
 * Whether a served identity is version 2 and its keys statement holds (the core checks both
 * halves of the hybrid signature over all four keys, the account and the key version).
 */
func keysHold(userId: String, _ served: ServedContactKeys, identityVersion: Int?, keysSignature: String?) -> Bool {
    guard identityVersion == 2, let version = served.keyVersion, let mlDsa = served.mlDsaPublicKey, let kem = served.kemPublicKey,
          let keysSignature else { return false }
    return identityVerifyKeys(userId: userId, identity: PublicIdentity(
        keyVersion: version, encryptionPublicKey: served.encryptionPublicKey, signingPublicKey: served.signingPublicKey,
        mlDsaPublicKey: mlDsa, kemPublicKey: kem, keysSignature: keysSignature
    ))
}

extension Auth {
    static func lookupContact(email: String) async throws -> Contact {
        // In the body, not the query: an address in a URL ends up in logs along the way.
        let reply = try await call("/api/auth/contacts/lookup", method: "POST", body: ["email": email])
        guard let json = reply["contact"] as? [String: Any], let userId = json["userId"] as? String,
              let encryption = json["encryptionPublicKey"] as? String, let signing = json["signingPublicKey"] as? String
        else { throw ContactError.message("No HushOS account uses that email.") }
        let keyVersion = (json["keyVersion"] as? NSNumber)?.uint64Value
        let identityVersion = (json["identityVersion"] as? NSNumber)?.intValue ?? 1
        let mlDsa = json["mlDsaPublicKey"] as? String
        let kem = json["kemPublicKey"] as? String
        let keysSignature = json["keysSignature"] as? String
        let served = ServedContactKeys(keyVersion: keyVersion, encryptionPublicKey: encryption, signingPublicKey: signing,
                                       mlDsaPublicKey: mlDsa, kemPublicKey: kem)
        let upgraded = keysHold(userId: userId, served, identityVersion: identityVersion, keysSignature: keysSignature)
        var fingerprint: String?
        if upgraded, let mlDsa, let kem {
            fingerprint = try identityFingerprintOfKeys(
                encryptionPublicKey: try base64urlDecode(value: encryption), signingPublicKey: try base64urlDecode(value: signing),
                mlDsaPublicKey: try base64urlDecode(value: mlDsa), kemPublicKey: try base64urlDecode(value: kem)
            )
        }
        return Contact(
            userId: userId, name: json["name"] as? String ?? "", email: json["email"] as? String ?? email, keyVersion: keyVersion,
            identityVersion: identityVersion, encryptionPublicKey: encryption, signingPublicKey: signing, mlDsaPublicKey: mlDsa,
            kemPublicKey: kem, keysSignature: keysSignature, upgraded: upgraded, fingerprint: fingerprint
        )
    }

    /*
     * The settings envelope (nil for no row, and for a version 1 row, which no longer opens),
     * the settings key beside it, and the stored sequence: always the row's, version 1 or 2,
     * 0 when there is none. A save names that sequence and is sealed one above it.
     */
    static func settings() async throws -> (envelope: SettingsEnvelope?, key: SettingsKeyEnvelope?, version: UInt64) {
        let reply = try await call("/api/auth/settings")
        let envelope = (reply["settings"] as? [String: Any]).map { json in
            SettingsEnvelope(
                version: UInt32((json["version"] as? NSNumber)?.intValue ?? 0), settingsVersion: (json["settingsVersion"] as? NSNumber)?.uint64Value ?? 0,
                nonce: json["nonce"] as? String ?? "", ciphertext: json["ciphertext"] as? String ?? ""
            )
        }
        let key = (reply["settingsKey"] as? [String: Any]).map { settingsKeyEnvelope(from: $0) }
        let version = (reply["settingsVersion"] as? NSNumber)?.uint64Value ?? envelope?.settingsVersion ?? 0
        return (envelope, key, version)
    }

    static func settingsKeyEnvelope(from json: [String: Any]) -> SettingsKeyEnvelope {
        SettingsKeyEnvelope(nonce: json["nonce"] as? String ?? "", ciphertext: json["ciphertext"] as? String ?? "")
    }

    static func json(_ key: SettingsKeyEnvelope) -> [String: Any] { ["nonce": key.nonce, "ciphertext": key.ciphertext] }

    /* The settings version the server stored the document as. */
    @discardableResult
    static func putSettings(expectedVersion: UInt64, envelope: SettingsEnvelope) async throws -> UInt64 {
        let reply = try await call("/api/auth/settings", method: "PUT", body: [
            "expectedVersion": expectedVersion, "version": envelope.version, "nonce": envelope.nonce, "ciphertext": envelope.ciphertext,
        ])
        return (reply["settingsVersion"] as? NSNumber)?.uint64Value ?? envelope.settingsVersion
    }

    /* Stored once; 409 (`AuthError.conflict`) when another device stored one first. */
    static func putSettingsKey(_ key: SettingsKeyEnvelope) async throws {
        _ = try await call("/api/auth/settings-key", method: "PUT", body: json(key))
    }
}

extension DriveAPI {
    public func shares(of nodeId: String, workspaceId: String) async throws -> [ShareView] {
        try await performPublic(try requestPublic("/nodes/\(nodeId)/shares", query: [URLQueryItem(name: "workspaceId", value: workspaceId)]), as: SharesListResponse.self).shares
    }

    public func createShare(nodeId: String, body: [String: Any]) async throws -> ShareView {
        try await performPublic(try mutationPublic("/nodes/\(nodeId)/shares", body: body), as: ShareCreated.self).share
    }

    public func revokeShare(_ shareId: String, workspaceId: String) async throws {
        struct Revoked: Decodable { let revoked: Bool }
        _ = try await performPublic(try mutationPublic("/shares/\(shareId)", method: "DELETE", body: ["workspaceId": workspaceId]), as: Revoked.self)
    }
}

extension Vault {
    /* Everyone pinned, newest first. */
    public func contacts() async throws -> [ContactPin] {
        try await loadSettings().contacts.values.sorted { $0.pinnedAt > $1.pinnedAt }
    }

    /*
     * This account's own fingerprint, for the other person to check: version 3, over the four
     * public keys the core re-derived from the private halves it opened, never the served ones.
     */
    public func ownFingerprint() async throws -> String {
        let keys = try await identityKeys()
        guard let mlDsa = keys.mlDsaPublicKey, let kem = keys.kemPublicKey else { throw AuthError.message("Your keys couldn’t be upgraded. Try again.") }
        return try identityFingerprintOfKeys(
            encryptionPublicKey: try base64urlDecode(value: keys.encryptionPublicKey), signingPublicKey: try base64urlDecode(value: keys.signingPublicKey),
            mlDsaPublicKey: try base64urlDecode(value: mlDsa), kemPublicKey: try base64urlDecode(value: kem)
        )
    }

    /*
     * A person by email, with what the pin says about them (`ContactPin.compare`). A pin whose
     * served keys moved on is not followed here: that asks the server for their chain, which
     * only "Check again" does.
     */
    public func lookup(email: String) async throws -> Lookup {
        let contact = try await Auth.lookupContact(email: email)
        let pinned = try await loadSettings().contacts[contact.userId]
        let comparison = pinned?.compare(contact.served)
        return Lookup(contact: contact, pinned: pinned, changed: comparison == .changed || comparison == .succession,
                      recheck: comparison == .recheck, canFollow: comparison == .succession)
    }

    /* "Check again" from a lookup: follows the pinned keys along the chain to the served ones, then looks them up afresh. */
    public func checkAgain(_ found: Lookup) async throws -> Lookup {
        guard let pin = found.pinned else { return found }
        let decision = try await checkAgain(pin, served: found.contact.served)
        var next = try await lookup(email: found.contact.email)
        if case .followed = decision { next.followed = true }
        return next
    }

    /*
     * Trusts the keys shown now: what the person does after comparing the words. Writes a
     * version 3 pin from the served keys (X25519, Ed25519, the digests of ML-DSA and ML-KEM, and
     * the fingerprint over all four), and only for an upgraded identity whose keys statement held.
     */
    public func pin(_ contact: Contact) async throws {
        guard contact.upgraded else { throw ContactError.notUpgraded(contact.name.isEmpty ? contact.email : contact.name) }
        var pin = try ContactPin.of(contact.served, userId: contact.userId, email: contact.email, name: contact.name,
                                    pinnedAt: ISO8601DateFormatter().string(from: Date()))
        try await updateSettings { settings in
            // The same keys checked again keep what a succession chain vouched for; brand-new keys start afresh.
            if let stored = settings.contacts[contact.userId], stored.signingPublicKey == pin.signingPublicKey,
               stored.encryptionPublicKey == pin.encryptionPublicKey {
                pin.previousSigningKeys = stored.previousSigningKeys
                pin.keysReplacedAt = stored.keysReplacedAt
            }
            settings.setPin(pin)
        }
        ReplacedKeysSeen.acknowledge(pin)
        // Shares to them still in an older suite can be sealed in suite 4 now that a version 3 pin vouches for their keys.
        Task { _ = try? await self.upgradeShares() }
    }

    public func unpin(_ pin: ContactPin) async throws {
        try await updateSettings { $0.removePin(pin.userId) }
    }

    public func shares(of item: Opened) async throws -> [ShareView] {
        try await api.shares(of: item.id, workspaceId: item.node.workspaceId)
    }

    /*
     * Shares an item with a pinned, checked contact: the served keys must be the ones the
     * version 3 pin vouches for (see `ContactPin.sealKeys`), then the node key is sealed to them
     * in suite 4, signed with both of this identity's signing keys, and the share joins the ledger.
     */
    public func share(_ item: Opened, with pin: ContactPin, role: String) async throws -> ShareView {
        guard let nodeKey = nodeKey(of: item) else { throw DriveAPIError.server(500, "Node not opened") }
        guard pin.verified else { throw ContactError.recheck(pin.displayName) }
        let contact = try await Auth.lookupContact(email: pin.email)
        guard contact.userId == pin.userId else { throw ContactError.changed }
        let sealing = try pin.sealKeys(contact.served)
        let keys = try await identityKeys()
        let ctx = ShareContext(workspaceId: item.node.workspaceId, nodeId: item.id, keyEpoch: item.node.keyEpoch, granteeUserId: pin.userId, granterUserId: session.userId)
        let envelope = try shareSeal(ctx: ctx, nodeKey: nodeKey, granter: keys, granteePublicKey: sealing.publicKey, granteeKemPublicKey: sealing.kem)
        let share = try await api.createShare(nodeId: item.id, body: [
            "workspaceId": item.node.workspaceId, "granteeUserId": pin.userId, "role": role, "keyEpoch": item.node.keyEpoch,
            "shareEnvelope": base64urlEncode(bytes: envelope),
        ])
        try await updateSettings { $0.ledger.addShare(node: item.id, grantee: pin.userId) }
        return share
    }

    /* Out of the ledger first, so the rotation that follows never seals to them again. */
    public func revokeShare(_ share: ShareView, for item: Opened) async throws {
        try await updateSettings { $0.ledger.removeShare(node: item.id, grantee: share.grantee.id) }
        try await api.revokeShare(share.id, workspaceId: item.node.workspaceId)
    }
}

/* One row of "shared by me": a share or a link, and the item it points at once its name is opened. */
public struct SharedByMe: Sendable, Identifiable {
    public let id: String
    public let item: Opened?
    public let node: NodeView
    public let share: ShareView?
    public let link: LinkView?
}

struct SharedByMeResponse: Codable, Sendable {
    struct Share: Codable, Sendable {
        let id: String
        let role: String
        let keyEpoch: UInt64
        let createdAt: String
        let suite: Int?
        let grantee: ShareView.Grantee
        let node: NodeView
        /* The grantee's identity as served now: what a re-seal is checked against the pin with. */
        var granteeIdentity: ServedIdentity? = nil
    }
    struct Link: Codable, Sendable {
        let id: String
        let keyEpoch: UInt64
        let secretEnvelope: String?
        let hasPassword: Bool
        let expiresAt: String?
        let useCount: Int
        let lastUsedAt: String?
        let createdAt: String
        var kdfVersion: Int? = nil
        let node: NodeView
    }
    let shares: [Share]
    let links: [Link]
}

extension Vault {
    /* Opens a node of this workspace by listing the folder it sits in, which opens the whole chain above. */
    func openAnywhere(_ node: NodeView) async -> Opened? {
        if let done = opened[node.ref] { return done }
        if let parent = node.parentId {
            _ = try? await listChildren(of: parent)
        } else if let root = try? await rootId() {
            _ = try? await listChildren(of: root)
        }
        return opened[node.ref] ?? (try? open(node))
    }

    /* Everything this account shared out: to people, and by link. */
    public func sharedByMe() async throws -> [SharedByMe] {
        let reply = try await api.performPublic(try api.requestPublic("/shares/mine"), as: SharedByMeResponse.self)
        var rows: [SharedByMe] = []
        for share in reply.shares {
            let item = await openAnywhere(share.node)
            let view = ShareView(id: share.id, role: share.role, keyEpoch: share.keyEpoch, createdAt: share.createdAt, suite: share.suite, grantee: share.grantee)
            rows.append(SharedByMe(id: "share-" + share.id, item: item, node: share.node, share: view, link: nil))
        }
        for link in reply.links {
            let item = await openAnywhere(link.node)
            let view = LinkView(id: link.id, keyEpoch: link.keyEpoch, secretEnvelope: link.secretEnvelope, hasPassword: link.hasPassword, expiresAt: link.expiresAt, useCount: link.useCount, lastUsedAt: link.lastUsedAt, createdAt: link.createdAt, kdfVersion: link.kdfVersion)
            rows.append(SharedByMe(id: "link-" + link.id, item: item, node: link.node, share: nil, link: view))
        }
        return rows
    }
}

/* Who can open each of one's own shared items: the people on it and how many links open it. Names are the server's; nothing is opened. */
public struct SharingIndex: Sendable {
    public struct Entry: Sendable {
        public var people: [ShareView.Grantee] = []
        /* Grantee id to role ("viewer" or "editor"). */
        public var roles: [String: String] = [:]
        public var links = 0
    }
    public var entries: [String: Entry] = [:]
}

extension Vault {
    /* The same answer as `sharedByMe`, keyed by node, without opening any node: cheap enough to ask on every refresh. */
    public func sharingIndex() async throws -> SharingIndex {
        let reply = try await api.performPublic(try api.requestPublic("/shares/mine"), as: SharedByMeResponse.self)
        var index = SharingIndex()
        for share in reply.shares {
            index.entries[share.node.id, default: .init()].people.append(share.grantee)
            index.entries[share.node.id, default: .init()].roles[share.grantee.id] = share.role
        }
        for link in reply.links { index.entries[link.node.id, default: .init()].links += 1 }
        return index
    }
}
