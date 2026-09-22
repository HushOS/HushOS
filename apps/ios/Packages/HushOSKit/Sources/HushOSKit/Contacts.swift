import Foundation
import HushOSCore

/* A person as `GET /api/auth/contacts/lookup` describes them. */
public struct Contact: Sendable, Equatable {
    public struct Kem: Sendable, Equatable {
        public let publicKey: String
        public let signature: String
    }
    public let userId: String
    public let name: String
    public let email: String
    public let encryptionPublicKey: String
    public let signingPublicKey: String
    public let kem: Kem?
    /* Ten groups of four hex digits, to compare over another channel. */
    public let fingerprint: String
    /* Whether the post-quantum key carries a signature by this identity. */
    public let kemSigned: Bool
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
    public var kemPublicKeyHash: String?
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
    /* The served key differs from the pin: nothing is trusted until the person re-pins. */
    public let changed: Bool
}

public enum ContactError: Error, LocalizedError {
    case unpinned, changed, message(String)
    public var errorDescription: String? {
        switch self {
        case .unpinned: return "Pin this contact before sharing with them."
        case .changed: return "This contact's key changed since you pinned it. Check the fingerprint and pin it again."
        case .message(let text): return text
        }
    }
}

extension Auth {
    static func lookupContact(email: String) async throws -> Contact {
        var components = URLComponents(string: "/api/auth/contacts/lookup")!
        components.queryItems = [URLQueryItem(name: "email", value: email)]
        let reply = try await call(components.string ?? "/api/auth/contacts/lookup")
        guard let json = reply["contact"] as? [String: Any], let userId = json["userId"] as? String,
              let encryption = json["encryptionPublicKey"] as? String, let signing = json["signingPublicKey"] as? String
        else { throw ContactError.message("No HushOS account uses that email.") }
        let kem = (json["kem"] as? [String: Any]).map { Contact.Kem(publicKey: $0["publicKey"] as? String ?? "", signature: $0["signature"] as? String ?? "") }
        let signed = kem.map { kemBindingVerify(userId: userId, encryptionPublicKey: encryption, signingPublicKey: signing, kemPublicKey: $0.publicKey, signature: $0.signature) } ?? false
        return Contact(
            userId: userId, name: json["name"] as? String ?? "", email: json["email"] as? String ?? email,
            encryptionPublicKey: encryption, signingPublicKey: signing, kem: kem,
            fingerprint: try identityFingerprint(encryptionPublicKey: try base64urlDecode(value: encryption)), kemSigned: signed
        )
    }

    static func settings() async throws -> SettingsEnvelope? {
        let reply = try await call("/api/auth/settings")
        guard let json = reply["settings"] as? [String: Any] else { return nil }
        return SettingsEnvelope(
            version: UInt32((json["version"] as? NSNumber)?.intValue ?? 0), settingsVersion: (json["settingsVersion"] as? NSNumber)?.uint64Value ?? 0,
            nonce: json["nonce"] as? String ?? "", ciphertext: json["ciphertext"] as? String ?? ""
        )
    }

    static func putSettings(expectedVersion: UInt64, envelope: SettingsEnvelope) async throws {
        _ = try await call("/api/auth/settings", method: "PUT", body: ["expectedVersion": expectedVersion, "nonce": envelope.nonce, "ciphertext": envelope.ciphertext])
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

/* The settings document, opened: the pins by user id and the version the server holds. */
struct Settings {
    var contacts: [String: ContactPin]
    var version: UInt64
}

extension Vault {
    func loadSettings() async throws -> Settings {
        let keys = try await identityKeys()
        guard let envelope = try await Auth.settings() else { return Settings(contacts: [:], version: 0) }
        let json = try settingsOpen(identityPrivateKey: keys.encryptionPrivateKey, userId: session.userId, envelope: envelope)
        struct Document: Decodable { let contacts: [String: ContactPin] }
        let document = try JSONDecoder().decode(Document.self, from: Data(json.utf8))
        return Settings(contacts: document.contacts, version: envelope.settingsVersion)
    }

    private func saveSettings(_ settings: Settings) async throws {
        let keys = try await identityKeys()
        struct Document: Encodable { let version = 1; let contacts: [String: ContactPin] }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let json = String(decoding: try encoder.encode(Document(contacts: settings.contacts)), as: UTF8.self)
        let sealed = try settingsSeal(identityPrivateKey: keys.encryptionPrivateKey, userId: session.userId, settingsVersion: settings.version + 1, json: json)
        try await Auth.putSettings(expectedVersion: settings.version, envelope: sealed)
    }

    /* Everyone pinned, newest first. */
    public func contacts() async throws -> [ContactPin] {
        try await loadSettings().contacts.values.sorted { $0.pinnedAt > $1.pinnedAt }
    }

    /* This account's own fingerprint, for the other person to check. */
    public func ownFingerprint() async throws -> String {
        try identityFingerprint(encryptionPublicKey: try base64urlDecode(value: try await identityKeys().encryptionPublicKey))
    }

    /* A person by email, with what the pin says about them. */
    public func lookup(email: String) async throws -> Lookup {
        let contact = try await Auth.lookupContact(email: email)
        let pinned = try await loadSettings().contacts[contact.userId]
        var changed = false
        if let pinned {
            if pinned.encryptionPublicKey != contact.encryptionPublicKey { changed = true }
            if let hash = pinned.kemPublicKeyHash, contact.kem.map({ keyDigest(publicKey: (try? base64urlDecode(value: $0.publicKey)) ?? Data()) }) != hash { changed = true }
        }
        return Lookup(contact: contact, pinned: pinned, changed: changed)
    }

    /* Trusts the keys shown now: what the person does after checking the fingerprint. */
    public func pin(_ contact: Contact) async throws {
        var settings = try await loadSettings()
        let hash = contact.kemSigned ? contact.kem.map { keyDigest(publicKey: (try? base64urlDecode(value: $0.publicKey)) ?? Data()) } : nil
        settings.contacts[contact.userId] = ContactPin(
            userId: contact.userId, email: contact.email, name: contact.name, encryptionPublicKey: contact.encryptionPublicKey,
            signingPublicKey: contact.signingPublicKey, fingerprint: contact.fingerprint, pinnedAt: ISO8601DateFormatter().string(from: Date()), kemPublicKeyHash: hash
        )
        do {
            try await saveSettings(settings)
        } catch {
            // Changed on another device meanwhile: read again and retry once.
            var latest = try await loadSettings()
            latest.contacts[contact.userId] = settings.contacts[contact.userId]
            try await saveSettings(latest)
        }
    }

    public func unpin(_ pin: ContactPin) async throws {
        var settings = try await loadSettings()
        settings.contacts[pin.userId] = nil
        try await saveSettings(settings)
    }

    public func shares(of item: Opened) async throws -> [ShareView] {
        try await api.shares(of: item.id, workspaceId: item.node.workspaceId)
    }

    /*
     * Shares an item with a pinned contact: the served keys must match the pin
     * (a first, signed post-quantum key is accepted and remembered), then the
     * node key is sealed to them with this identity's private key.
     */
    public func share(_ item: Opened, with pin: ContactPin, role: String) async throws -> ShareView {
        guard let nodeKey = nodeKeys[item.id] else { throw DriveAPIError.server(500, "Node not opened") }
        let contact = try await Auth.lookupContact(email: pin.email)
        guard contact.userId == pin.userId, contact.encryptionPublicKey == pin.encryptionPublicKey else { throw ContactError.changed }
        var kemPublic: Data? = nil
        if let kem = contact.kem, contact.kemSigned {
            let bytes = try base64urlDecode(value: kem.publicKey)
            let hash = keyDigest(publicKey: bytes)
            if let known = pin.kemPublicKeyHash {
                guard known == hash else { throw ContactError.changed }
            } else {
                var settings = try await loadSettings()
                if var stored = settings.contacts[pin.userId] {
                    stored.kemPublicKeyHash = hash
                    settings.contacts[pin.userId] = stored
                    try await saveSettings(settings)
                }
            }
            kemPublic = bytes
        } else if pin.kemPublicKeyHash != nil {
            throw ContactError.changed
        }
        let keys = try await identityKeys()
        let ctx = ShareContext(workspaceId: item.node.workspaceId, nodeId: item.id, keyEpoch: item.node.keyEpoch, granteeUserId: pin.userId, granterUserId: session.userId)
        let envelope = try shareSeal(ctx: ctx, nodeKey: nodeKey, granterPrivateKey: keys.encryptionPrivateKey, granteePublicKey: try base64urlDecode(value: pin.encryptionPublicKey), granteeKemPublicKey: kemPublic)
        return try await api.createShare(nodeId: item.id, body: [
            "workspaceId": item.node.workspaceId, "granteeUserId": pin.userId, "role": role, "keyEpoch": item.node.keyEpoch,
            "shareEnvelope": base64urlEncode(bytes: envelope),
        ])
    }

    public func revokeShare(_ share: ShareView, for item: Opened) async throws {
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
        let node: NodeView
    }
    let shares: [Share]
    let links: [Link]
}

extension Vault {
    /* Opens a node of this workspace by listing the folder it sits in, which opens the whole chain above. */
    func openAnywhere(_ node: NodeView) async -> Opened? {
        if let done = opened[node.id] { return done }
        if let parent = node.parentId {
            _ = try? await listChildren(of: parent)
        } else if let root = try? await rootId() {
            _ = try? await listChildren(of: root)
        }
        return opened[node.id] ?? (try? open(node))
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
            let view = LinkView(id: link.id, keyEpoch: link.keyEpoch, secretEnvelope: link.secretEnvelope, hasPassword: link.hasPassword, expiresAt: link.expiresAt, useCount: link.useCount, lastUsedAt: link.lastUsedAt, createdAt: link.createdAt)
            rows.append(SharedByMe(id: "link-" + link.id, item: item, node: link.node, share: nil, link: view))
        }
        return rows
    }
}
