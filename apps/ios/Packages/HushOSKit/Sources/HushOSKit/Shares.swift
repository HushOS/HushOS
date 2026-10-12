import Foundation

/* A share as received, with its root opened under the key the granter sealed to this identity. */
public struct ShareMount: Sendable, Identifiable {
    public let share: SharedWithMeView
    public let root: Opened?
    public let error: String?
    /* Set when the granter's key is what kept it shut: not checked yet, or changed since. */
    public var trust: GranterTrust? = nil
    public var id: String { share.id }
}

/* Why a received share stays shut until the person acts in People you share with. */
public enum GranterTrust: Error, LocalizedError, Sendable, Equatable {
    case unverified(name: String), changed(name: String)
    /* Pinned, but not with a current fingerprint over both keys: as good as not checked. */
    case recheck(name: String)
    /* Not checked yet (or not in a way that counts), as opposed to checked once and changed since. */
    public var unverified: Bool {
        switch self {
        case .unverified, .recheck: true
        case .changed: false
        }
    }
    public var errorDescription: String? {
        switch self {
        case .unverified(let name): return "Add \(name) in People you share with and check their words to open what they shared."
        case .recheck(let name): return "Check \(name)’s words again in People you share with to open what they shared."
        case .changed(let name): return "\(name)’s key has changed since you added them. Check it’s them in People you share with before opening what they shared."
        }
    }
}

/* The granter's keys a received share is opened with: all from the pin, none from the server. */
public struct PinnedGranter: Sendable, Equatable {
    /* X25519: what suites 1 and 2 open with. */
    public let encryptionPublicKey: Data
    /* Ed25519, the pinned key first, then earlier ones a succession chain vouched for: a suite 3 share must be signed by one. */
    public let signingPublicKeys: [Data]
}

extension ContactPin {
    /*
     * The keys to open a share from this granter with: the pinned ones, and only when the server served
     * those same keys. Taking the served keys of someone not pinned would let a server fake a share "from"
     * anyone with a key of its own, so that is refused, and nothing is pinned here: pinning follows a words check.
     */
    public static func granter(_ granter: SharedWithMeView.Granter, pins: [String: ContactPin]) throws -> PinnedGranter {
        let name = granter.name.isEmpty ? granter.email : granter.name
        guard let pin = pins[granter.id] else { throw GranterTrust.unverified(name: name) }
        guard pin.verified else { throw GranterTrust.recheck(name: name) }
        guard pin.matches(granter.served) else { throw GranterTrust.changed(name: name) }
        let signing = ([pin.signingPublicKey] + (pin.previousSigningKeys ?? [])).compactMap { try? base64urlDecode(value: $0) }
        return PinnedGranter(encryptionPublicKey: try base64urlDecode(value: pin.encryptionPublicKey), signingPublicKeys: signing)
    }

    /* The pinned X25519 key alone, as older callers want it. */
    public static func granterKey(_ granter: SharedWithMeView.Granter, pins: [String: ContactPin]) throws -> Data {
        try Self.granter(granter, pins: pins).encryptionPublicKey
    }
}

/*
 * Opens a share envelope with what the pin vouches for: the granter's signing keys (a suite 3
 * share opens only if one of them signed it; the signature is checked before anything else) and
 * each identity this account holds, the current one first, since a share sealed before a
 * succession opens only with the identity it was sealed to.
 */
public enum ShareOpener {
    public static func open(_ envelope: Data, ctx: ShareContext, granter: PinnedGranter, identities: [IdentityKeys]) throws -> Data {
        // Only suite 3 carries a signature; older suites open with the X25519 key, whichever signing key is named.
        let signing: [Data?] = envelope.count == 1256 ? granter.signingPublicKeys.map { $0 } : [granter.signingPublicKeys.first]
        var first: Error?
        for key in signing.isEmpty ? [nil] : signing {
            for identity in identities {
                do {
                    return try shareOpen(envelope: envelope, granter: ShareGranter(encryptionPublicKey: granter.encryptionPublicKey, signingPublicKey: key),
                                         grantee: identity, ctx: ctx)
                } catch {
                    first = first ?? error
                }
            }
        }
        throw first ?? ContactError.message("This share couldn’t be opened.")
    }
}

extension Auth {
    /* The identity envelope the server keeps for this account. */
    public static func identity() async throws -> IdentityEnvelope {
        let reply = try await call("/api/auth/identity")
        guard let json = reply["identity"] as? [String: Any] else { throw AuthError.message("HushOS returned no identity.") }
        return identityEnvelope(from: json)
    }
}

extension Vault {
    /*
     * Whether a received share may be mounted at all, before any key is opened: it must point
     * into another account's workspace, and its node must be in the workspace it names. A
     * share into this account's own drive would file a key the granter (or the server, if it
     * made one up) holds under one of this account's own folders.
     */
    static func checkReceived(_ share: SharedWithMeView, ownWorkspace: String) throws {
        guard share.workspaceId.lowercased() != ownWorkspace.lowercased() else {
            throw DriveAPIError.server(400, "This share points into your own drive and was refused.")
        }
        guard share.node.workspaceId.lowercased() == share.workspaceId.lowercased() else {
            throw DriveAPIError.server(400, "This share doesn’t match the folder it names and was refused.")
        }
        try share.node.checkEnvelopeSuite()
    }

    /*
     * What others shared with this account, each root opened with the identity
     * keys and adopted as a root of its own: everything below opens like any
     * other folder, in the granter's workspace.
     */
    public func mountShares() async throws -> [ShareMount] {
        let shares = try await api.sharedWithMe()
        if shares.isEmpty { return [] }
        let own = try await loadWorkspace().workspaceId
        let identities = try await allIdentities()
        var pins = try await loadSettings().contacts
        // A granter who replaced their keys by a succession their pinned keys signed: the pin follows first.
        var served: [String: ServedContactKeys] = [:]
        for share in shares { served[share.granter.id] = share.granter.served }
        pins = await followAll(pins, served: served)
        var mounts: [ShareMount] = []
        for share in shares {
            do {
                try Self.checkReceived(share, ownWorkspace: own)
                let ctx = ShareContext(
                    workspaceId: share.workspaceId, nodeId: share.node.id, keyEpoch: UInt64(share.keyEpoch),
                    granteeUserId: session.userId, granterUserId: share.granter.id
                )
                let granter = try ContactPin.granter(share.granter, pins: pins)
                let key: Data
                do {
                    key = try ShareOpener.open(try base64urlDecode(value: share.shareEnvelope), ctx: ctx, granter: granter, identities: identities)
                } catch let first {
                    // Mid-rotation the previous envelope is the one sealed to this identity.
                    guard let prev = share.prevShareEnvelope, let prevEpoch = share.prevKeyEpoch else { throw first }
                    var prevCtx = ctx
                    prevCtx.keyEpoch = UInt64(prevEpoch)
                    key = try ShareOpener.open(try base64urlDecode(value: prev), ctx: prevCtx, granter: granter, identities: identities)
                }
                let metadata = try metadataOpen(
                    ctx: MetadataContext(workspaceId: share.node.workspaceId, nodeId: share.node.id, metadataVersion: share.node.metadataVersion),
                    nodeKey: key, envelope: try base64urlDecode(value: share.node.metadataEnvelope)
                )
                mounts.append(ShareMount(share: share, root: try adopt(share.node, nodeKey: key, metadata: metadata, in: share.workspaceId), error: nil))
            } catch {
                mounts.append(ShareMount(share: share, root: nil, error: (error as? LocalizedError)?.errorDescription ?? error.localizedDescription, trust: error as? GranterTrust))
            }
        }
        return mounts
    }
}
