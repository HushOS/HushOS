import Foundation
import HushOSCore

/* A person as `POST /api/auth/contacts/lookup` describes them. */
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
    /* Ten groups of four hex digits over both public keys, to compare over another channel. */
    public let fingerprint: String
    /* Whether the post-quantum key carries a signature by the signing key served with it. Vouches only for a
     * contact not pinned yet, whose words cover that signing key; a pinned contact's KEM key is checked against the pin. */
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
    /* Pinned, but the pin vouches for nothing (no current fingerprint over both keys): compare the words again. */
    public var recheck: Bool = false
}

public enum ContactError: Error, LocalizedError, Equatable {
    case unpinned, changed, message(String)
    /* A pin without a current fingerprint over both keys: made before the words covered the signing key, or edited. */
    case recheck(String)
    /* Never sealed to X25519 alone: no post-quantum key, a different one than pinned, or one their identity did not sign. */
    case noKem(String), kemChanged(String), kemUnsigned(String)
    public var errorDescription: String? {
        switch self {
        case .unpinned: return "Add them to your contacts before sharing with them."
        case .changed: return "Their account changed since you added them. Check it’s them in People you share with before you share."
        case .recheck(let name): return "Check \(name)’s words again in People you share with before you share with them."
        case .noKem(let name): return "\(name) hasn’t set up post-quantum keys yet."
        case .kemChanged(let name): return "\(name)’s post-quantum key has changed since you pinned it. Check with them before sharing."
        case .kemUnsigned(let name): return "\(name)’s post-quantum key is not signed by their identity."
        case .message(let text): return text
        }
    }
}

extension Auth {
    static func lookupContact(email: String) async throws -> Contact {
        // In the body, not the query: an address in a URL ends up in logs along the way.
        let reply = try await call("/api/auth/contacts/lookup", method: "POST", body: ["email": email])
        guard let json = reply["contact"] as? [String: Any], let userId = json["userId"] as? String,
              let encryption = json["encryptionPublicKey"] as? String, let signing = json["signingPublicKey"] as? String
        else { throw ContactError.message("No HushOS account uses that email.") }
        let kem = (json["kem"] as? [String: Any]).map { Contact.Kem(publicKey: $0["publicKey"] as? String ?? "", signature: $0["signature"] as? String ?? "") }
        let signed = kem.map { kemBindingVerify(userId: userId, encryptionPublicKey: encryption, signingPublicKey: signing, kemPublicKey: $0.publicKey, signature: $0.signature) } ?? false
        return Contact(
            userId: userId, name: json["name"] as? String ?? "", email: json["email"] as? String ?? email,
            encryptionPublicKey: encryption, signingPublicKey: signing, kem: kem,
            fingerprint: try identityFingerprint(encryptionPublicKey: try base64urlDecode(value: encryption), signingPublicKey: try base64urlDecode(value: signing)),
            kemSigned: signed
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

extension Vault {
    /* Everyone pinned, newest first. */
    public func contacts() async throws -> [ContactPin] {
        try await loadSettings().contacts.values.sorted { $0.pinnedAt > $1.pinnedAt }
    }

    /* This account's own fingerprint, for the other person to check. */
    public func ownFingerprint() async throws -> String {
        let keys = try await identityKeys()
        return try identityFingerprint(encryptionPublicKey: try base64urlDecode(value: keys.encryptionPublicKey), signingPublicKey: try base64urlDecode(value: keys.signingPublicKey))
    }

    /* A person by email, with what the pin says about them. */
    public func lookup(email: String) async throws -> Lookup {
        let contact = try await Auth.lookupContact(email: email)
        let pinned = try await loadSettings().contacts[contact.userId]
        var changed = false
        if let pinned {
            // Any of the three keys differing from the pin is a changed account: the words no longer vouch for it.
            if pinned.encryptionPublicKey != contact.encryptionPublicKey || pinned.signingPublicKey != contact.signingPublicKey { changed = true }
            if let hash = pinned.kemPublicKeyHash, contact.kem.map({ keyDigest(publicKey: (try? base64urlDecode(value: $0.publicKey)) ?? Data()) }) != hash { changed = true }
        }
        return Lookup(contact: contact, pinned: pinned, changed: changed, recheck: pinned.map { !$0.verified } ?? false)
    }

    /* Trusts the keys shown now: what the person does after checking the fingerprint. Re-pinning writes a current fingerprint. */
    public func pin(_ contact: Contact) async throws {
        let hash = contact.kemSigned ? contact.kem.map { keyDigest(publicKey: (try? base64urlDecode(value: $0.publicKey)) ?? Data()) } : nil
        let pin = ContactPin(
            userId: contact.userId, email: contact.email, name: contact.name, encryptionPublicKey: contact.encryptionPublicKey,
            signingPublicKey: contact.signingPublicKey, fingerprint: contact.fingerprint, pinnedAt: ISO8601DateFormatter().string(from: Date()), kemPublicKeyHash: hash
        )
        try await updateSettings { $0.setPin(pin) }
    }

    public func unpin(_ pin: ContactPin) async throws {
        try await updateSettings { $0.removePin(pin.userId) }
    }

    public func shares(of item: Opened) async throws -> [ShareView] {
        try await api.shares(of: item.id, workspaceId: item.node.workspaceId)
    }

    /* Remembers the first post-quantum key a person's pinned signing key vouched for, so a different one later is refused. */
    func rememberKem(_ digest: String, for userId: String) async throws {
        try await updateSettings { settings in
            guard var stored = settings.contacts[userId], stored.kemPublicKeyHash == nil else { return }
            stored.kemPublicKeyHash = digest
            settings.setPin(stored)
        }
    }

    /*
     * Shares an item with a pinned, checked contact: the served keys must match the pin and
     * carry a post-quantum key the pin vouches for (see `ContactPin.sealKeys`), then the node
     * key is sealed to them with this identity's private key, and the share joins the ledger.
     */
    public func share(_ item: Opened, with pin: ContactPin, role: String) async throws -> ShareView {
        guard let nodeKey = nodeKey(of: item) else { throw DriveAPIError.server(500, "Node not opened") }
        guard pin.verified else { throw ContactError.recheck(pin.displayName) }
        let contact = try await Auth.lookupContact(email: pin.email)
        guard contact.userId == pin.userId else { throw ContactError.changed }
        let sealing = try pin.sealKeys(encryptionPublicKey: contact.encryptionPublicKey, kemPublicKey: contact.kem?.publicKey, kemSignature: contact.kem?.signature)
        if let digest = sealing.newDigest { try await rememberKem(digest, for: pin.userId) }
        let keys = try await identityKeys()
        let ctx = ShareContext(workspaceId: item.node.workspaceId, nodeId: item.id, keyEpoch: item.node.keyEpoch, granteeUserId: pin.userId, granterUserId: session.userId)
        let envelope = try shareSeal(ctx: ctx, nodeKey: nodeKey, granterPrivateKey: keys.encryptionPrivateKey, granteePublicKey: sealing.publicKey, granteeKemPublicKey: sealing.kem)
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
