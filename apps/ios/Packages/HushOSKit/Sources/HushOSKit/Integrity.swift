import Foundation
import HushOSCore

/*
 * Who wrote an item, as far as this person can tell (docs/integrity-design.md,
 * "Writer signatures"). Every node's metadata and every version carries the
 * writer's Ed25519 signature; the server names the writer, and only keys this
 * person trusts for that account count: their own (current and earlier) and a
 * verified pin's (with the earlier keys a succession chain vouched for).
 * Anything else is Unverified: a warning on the row, never a lock.
 */
public enum Provenance: Sendable, Equatable, Hashable {
    /* Signed, by someone this person hasn't checked (or the server named nobody). */
    case unknownSigner(Signer?)
    /* Signed in the name of someone checked, and the signature doesn't hold. */
    case badSignature(Signer?)
    /* Made before HushOS signed changes. */
    case unsigned

    /* Worst first: a forged signature outranks a stranger's, which outranks none at all. */
    var rank: Int {
        switch self {
        case .badSignature: 3
        case .unknownSigner: 2
        case .unsigned: 1
        }
    }

    public var signer: Signer? {
        switch self {
        case .unknownSigner(let signer), .badSignature(let signer): signer
        case .unsigned: nil
        }
    }

    /* The words for the explanation, as every client says them. */
    public var explanation: String {
        switch self {
        case .unknownSigner(let signer?):
            "Added or last changed by \(signer.name.isEmpty ? signer.email : signer.name) (\(signer.email)), whom you haven’t checked yet."
        case .unknownSigner(nil):
            "Added or last changed by someone you haven’t checked yet."
        case .badSignature(let signer?):
            "The signature doesn’t match \(signer.displayName)’s keys. Don’t trust this item."
        case .badSignature(nil):
            "The signature doesn’t match the writer’s keys. Don’t trust this item."
        case .unsigned:
            "Made before HushOS signed changes."
        }
    }
}

/*
 * The signing keys this person trusts, by account: what every integrity verdict is
 * made against. Built by the vault; pure from here on, so the decisions are testable.
 */
public struct TrustedSigners: Sendable, Equatable {
    /* Account id (lowercase) to the Ed25519 public keys trusted for it. */
    public private(set) var keys: [String: [Data]] = [:]

    public init() {}

    /*
     * This account's own identities (current and earlier) and every verified pin's signing key,
     * with the earlier ones a succession chain vouched for. A pin that needs its words checked
     * again vouches for nobody.
     */
    public init(userId: String, identities: [IdentityKeys], pins: some Sequence<ContactPin>) {
        for identity in identities { trust(userId, key: identity.signingPublicKey) }
        for pin in pins where pin.verified {
            trust(pin.userId, key: pin.signingPublicKey)
            for earlier in pin.previousSigningKeys ?? [] { trust(pin.userId, key: earlier) }
        }
    }

    /* Trusts `key` (base64url, 32 bytes) for `userId`; anything that is not a key trusts nothing. */
    public mutating func trust(_ userId: String, key: String) {
        guard let bytes = try? base64urlDecode(value: key), bytes.count == 32 else { return }
        let id = userId.lowercased()
        if keys[id]?.contains(bytes) != true { keys[id, default: []].append(bytes) }
    }

    func keys(for signer: Signer?) -> [Data] {
        guard let signer else { return [] }
        return keys[signer.id.lowercased()] ?? []
    }

    /* Present but unreadable is a signature that cannot hold, as the web reads it. */
    private static func signature(_ value: String?) -> Data? {
        guard let value else { return nil }
        return (try? base64urlDecode(value: value)) ?? Data()
    }

    public func metadata(of node: NodeView) -> Integrity {
        // An envelope that doesn't decode is signed by nobody: it can only fail against a trusted key.
        let envelope = (try? base64urlDecode(value: node.metadataEnvelope)) ?? Data()
        return metadataIntegrity(
            trustedKeys: keys(for: node.metadataSigner),
            statement: MetadataStatement(workspaceId: node.workspaceId, nodeId: node.id, kind: node.isFolder ? .folder : .file, metadataVersion: node.metadataVersion),
            metadataEnvelope: envelope, signature: Self.signature(node.metadataSignature)
        )
    }

    public func version(_ version: VersionView, of node: NodeView) -> Integrity {
        let envelope = (try? base64urlDecode(value: version.contentKeyEnvelope)) ?? Data()
        return versionIntegrity(
            trustedKeys: keys(for: version.signer),
            statement: VersionStatement(workspaceId: node.workspaceId, nodeId: node.id, versionId: version.id, objectId: version.objectId, contentSuite: version.contentSuite),
            contentKeyEnvelope: envelope, signature: Self.signature(version.signature)
        )
    }

    static func provenance(_ integrity: Integrity, signer: Signer?) -> Provenance? {
        switch integrity {
        case .verified: nil
        case .unknownSigner: .unknownSigner(signer)
        case .badSignature: .badSignature(signer)
        case .unsigned: .unsigned
        }
    }

    /*
     * The mark a node carries: nil when its metadata (and, for a file, its current version)
     * verify; otherwise the worst of the two, naming the writer of that record.
     */
    public func provenance(of node: NodeView) -> Provenance? {
        let metadata = Self.provenance(metadata(of: node), signer: node.metadataSigner)
        guard !node.isFolder, let current = node.currentVersion else { return metadata }
        let content = Self.provenance(version(current, of: node), signer: current.signer)
        switch (metadata, content) {
        case (nil, let other), (let other, nil): return other
        case (let a?, let b?): return b.rank > a.rank ? b : a
        }
    }
}
