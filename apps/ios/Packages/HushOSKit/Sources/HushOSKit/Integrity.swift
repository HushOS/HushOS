import Foundation
import HushOSCore

/*
 * Who wrote an item, as far as this person can tell (docs/integrity-design.md,
 * "Writer signatures" and "Round 3"). Every node's metadata and every version carries
 * the writer's Ed25519 signature; the server names the writer by id alone, and only
 * keys this person trusts for that account count: their own and a verified pin's,
 * each with its current key (which alone verifies) and the keys it replaced (which
 * only ever say "retired"). Anything else is Unverified: a warning, never a lock.
 */

/* Who a verdict names, from this person's own pins only: the server sends an id and nothing else. */
public enum Writer: Sendable, Equatable, Hashable {
    case you
    /* A contact whose words this person checked, by the name on the pin. */
    case contact(String)
    /* Anyone else, or nobody named. */
    case unchecked

    /* The writer mid-sentence: "you", "Maya", "someone you haven’t checked". */
    public var phrase: String {
        switch self {
        case .you: "you"
        case .contact(let name): name
        case .unchecked: "someone you haven’t checked"
        }
    }
}

public enum Provenance: Sendable, Equatable, Hashable {
    /* Signed in the name of someone trusted, and the signature doesn't hold. */
    case badSignature(Writer)
    /* It holds only under a signing key its writer has since replaced. */
    case retiredKey(Writer)
    /* Signed by nobody this person has checked; the id is the account the server names, for a check where one makes sense. */
    case unknownSigner(signerId: String?)
    /* Re-locked by someone trusted, who vouches for nothing more than that. */
    case resealed(Writer)
    /* No signature: written before signatures, or stripped. Said exactly like any other unconfirmed record. */
    case unsigned
    /* The check could not run: whom this person trusts didn't load, or the check failed. Never shown as clean. */
    case unchecked

    /* Worst first, for a node whose metadata and current version say different things. */
    var rank: Int {
        switch self {
        case .badSignature: 6
        case .retiredKey: 5
        case .unknownSigner: 4
        case .resealed: 3
        case .unsigned: 2
        case .unchecked: 1
        }
    }

    /* The words for the explanation, as every client says them. */
    public var explanation: String {
        switch self {
        case .badSignature(.you):
            "The signature doesn’t match your keys. Don’t trust this item."
        case .badSignature(.contact(let name)):
            "The signature doesn’t match \(name)’s keys. Don’t trust this item."
        case .badSignature(.unchecked):
            "The signature doesn’t match the writer’s keys. Don’t trust this item."
        case .retiredKey(.you):
            "Signed with keys you have since replaced."
        case .retiredKey(let writer):
            "Signed with keys \(writer.phrase) has since replaced."
        case .unknownSigner:
            "HushOS can’t confirm who wrote this. It was added or last changed by someone you haven’t checked."
        case .resealed(let writer):
            "Re-locked by \(writer.phrase); HushOS couldn’t confirm who wrote it before."
        case .unsigned:
            "HushOS can’t confirm who wrote this."
        case .unchecked:
            Self.couldNotCheck
        }
    }

    public static let couldNotCheck = "HushOS couldn’t check who wrote this. Try again later."

    /* The more serious of two verdicts; nil (verified) yields to anything. */
    static func worst(_ a: Provenance?, _ b: Provenance?) -> Provenance? {
        switch (a, b) {
        case (nil, let other), (let other, nil): other
        case (let a?, let b?): b.rank > a.rank ? b : a
        }
    }
}

/* A trust set that can't be read in full is refused whole: checking against part of it would pass records off as clean. */
public enum SignersError: Error, LocalizedError, Equatable {
    case unreadableKey
    public var errorDescription: String? { "A key of someone you trust could not be read, so nothing was checked." }
}

/*
 * The signing keys this person trusts, by account: what every integrity verdict is made
 * against. Built by the vault; pure from here on, so the decisions are testable.
 */
public struct TrustedSigners: Sendable, Equatable {
    struct Keys: Sendable, Equatable {
        var current: Data
        var retired: [Data]
    }

    /* Account id (lowercase) to its current signing key and the ones it replaced. */
    private(set) var keys: [String: Keys] = [:]
    /* Account id (lowercase) to how a verdict names them. */
    private(set) var writers: [String: Writer] = [:]

    public init() {}

    /*
     * This account's own identities (the current one first, then the earlier ones) and every
     * verified pin's signing key, with the earlier ones a succession chain vouched for as
     * retired. A pin that needs its words checked again vouches for nobody. Throws when a key
     * that should count doesn't read.
     */
    public init(userId: String, identities: [IdentityKeys], pins: some Sequence<ContactPin>) throws {
        for pin in pins where pin.verified && pin.userId.lowercased() != userId.lowercased() {
            try trust(pin.userId, current: pin.signingPublicKey, retired: pin.previousSigningKeys ?? [], as: .contact(pin.displayName))
        }
        if let current = identities.first {
            try trust(userId, current: current.signingPublicKey, retired: identities.dropFirst().map(\.signingPublicKey), as: .you)
        }
    }

    /* Trusts `current` (base64url, 32 bytes) for `userId`, and `retired` as keys it replaced. */
    public mutating func trust(_ userId: String, current: String, retired: [String] = [], as writer: Writer) throws {
        func key(_ value: String) throws -> Data {
            guard let bytes = try? base64urlDecode(value: value), bytes.count == 32 else { throw SignersError.unreadableKey }
            return bytes
        }
        let now = try key(current)
        var earlier: [Data] = []
        for value in retired {
            let bytes = try key(value)
            if bytes != now && !earlier.contains(bytes) { earlier.append(bytes) }
        }
        let id = userId.lowercased()
        keys[id] = Keys(current: now, retired: earlier)
        writers[id] = writer
    }

    func trusted(_ signer: Signer?) -> TrustedKeys? {
        guard let signer, let keys = keys[signer.id.lowercased()] else { return nil }
        return TrustedKeys(current: keys.current, retired: keys.retired)
    }

    /* How a verdict names the account the server says signed: only from this person's own pins. */
    public func writer(_ signer: Signer?) -> Writer {
        guard let signer else { return .unchecked }
        return writers[signer.id.lowercased()] ?? .unchecked
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
            trusted: trusted(node.metadataSigner),
            statement: MetadataStatement(workspaceId: node.workspaceId, nodeId: node.id, kind: node.isFolder ? .folder : .file, metadataVersion: node.metadataVersion),
            metadataEnvelope: envelope, signature: Self.signature(node.metadataSignature)
        )
    }

    /* A version's verdict, by its own fields: the current one on a node, an earlier one in the list, one a rotation re-seals. */
    public func version(id: String, objectId: String, contentSuite: UInt32, contentKeyEnvelope: String, signer: Signer?, signature: String?, of node: NodeView) -> Integrity {
        let envelope = (try? base64urlDecode(value: contentKeyEnvelope)) ?? Data()
        return versionIntegrity(
            trusted: trusted(signer),
            statement: VersionStatement(workspaceId: node.workspaceId, nodeId: node.id, versionId: id, objectId: objectId, contentSuite: contentSuite),
            contentKeyEnvelope: envelope, signature: Self.signature(signature)
        )
    }

    public func version(_ version: VersionView, of node: NodeView) -> Integrity {
        self.version(id: version.id, objectId: version.objectId, contentSuite: version.contentSuite, contentKeyEnvelope: version.contentKeyEnvelope,
                     signer: version.signer, signature: version.signature, of: node)
    }

    public func version(_ version: VersionListView, of node: NodeView) -> Integrity {
        self.version(id: version.id, objectId: version.objectId, contentSuite: version.contentSuite, contentKeyEnvelope: version.contentKeyEnvelope,
                     signer: version.signer, signature: version.signature, of: node)
    }

    func provenance(_ integrity: Integrity, signer: Signer?) -> Provenance? {
        switch integrity {
        case .verified: nil
        case .unknownSigner: .unknownSigner(signerId: signer?.id)
        case .badSignature: .badSignature(writer(signer))
        case .unsigned: .unsigned
        case .resealed: .resealed(writer(signer))
        case .retiredKey: .retiredKey(writer(signer))
        case .unchecked: .unchecked
        }
    }

    /*
     * The mark a node carries: nil when its metadata (and, for a file, its current version)
     * verify; otherwise the worst of the two, naming the writer of that record.
     */
    public func provenance(of node: NodeView) -> Provenance? {
        let metadata = provenance(metadata(of: node), signer: node.metadataSigner)
        guard !node.isFolder, let current = node.currentVersion else { return metadata }
        return Provenance.worst(metadata, provenance(version(current, of: node), signer: current.signer))
    }

    /* An earlier (or the current) version in the versions list: its own signature, beside the node's metadata. */
    public func provenance(of version: VersionListView, in node: NodeView) -> Provenance? {
        Provenance.worst(provenance(metadata(of: node), signer: node.metadataSigner), provenance(self.version(version, of: node), signer: version.signer))
    }
}

/*
 * Whom this person trusts, as far as the app got: still loading, loaded, or failed. A
 * failure (the identity history, the settings with the pins, or settings refused as
 * rolled back) marks every record "Couldn't check": never clean because a request failed.
 */
public enum TrustState: Sendable, Equatable {
    case pending
    case loaded(TrustedSigners)
    case failed(String)

    /* Runs the load; anything it throws is a failure the marks show, not an absence of marks. */
    public static func load(_ body: @Sendable () async throws -> TrustedSigners) async -> TrustState {
        do { return .loaded(try await body()) } catch {
            return .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
    }

    public var signers: TrustedSigners? {
        if case .loaded(let signers) = self { return signers }
        return nil
    }
}

/*
 * Verdicts kept per record, since rows ask on every draw. The stamp covers everything a
 * verdict depends on, the envelopes included: a server swapping an envelope under the same
 * signature and versions must be checked again, not answered from the cache.
 */
public struct VerdictCache: Sendable {
    private var entries: [String: (stamp: String, value: Provenance?)] = [:]

    public init() {}

    static func stamp(of node: NodeView) -> String {
        let current = node.currentVersion
        return [node.kind, String(node.metadataVersion), node.metadataEnvelope, node.metadataSignature ?? "-", node.metadataSigner?.id ?? "-",
                current?.id ?? "-", current?.objectId ?? "-", current.map { String($0.contentSuite) } ?? "-", current?.contentKeyEnvelope ?? "-",
                current?.signature ?? "-", current?.signer?.id ?? "-"].joined(separator: "|")
    }

    /* Nil while whom to trust is still loading; "Couldn't check" for every record once that failed. */
    public mutating func provenance(of node: NodeView, under state: TrustState) -> Provenance? {
        switch state {
        case .pending: return nil
        case .failed: return .unchecked
        case .loaded(let signers):
            let key = node.workspaceId.lowercased() + "/" + node.id.lowercased()
            let stamp = Self.stamp(of: node)
            if let cached = entries[key], cached.stamp == stamp { return cached.value }
            let value = signers.provenance(of: node)
            entries[key] = (stamp, value)
            return value
        }
    }

    public mutating func reset() { entries = [:] }
}

extension TrustState {
    /* An earlier version's mark in the list and the viewer; not cached, since a list is drawn once. */
    public func provenance(of version: VersionListView, in node: NodeView) -> Provenance? {
        switch self {
        case .pending: nil
        case .failed: .unchecked
        case .loaded(let signers): signers.provenance(of: version, in: node)
        }
    }
}
