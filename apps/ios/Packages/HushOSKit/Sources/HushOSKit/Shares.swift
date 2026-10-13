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

/* Why a received share stays shut until the person acts in People you share with, or the granter does. */
public enum GranterTrust: Error, LocalizedError, Sendable, Equatable {
    case unverified(name: String), changed(name: String)
    /* Pinned, but not with a current fingerprint over both keys: as good as not checked. */
    case recheck(name: String)
    /*
     * Signed with keys the granter has since replaced (the pin followed their succession): an
     * earlier key vouches for nothing any more, so it waits for the granter to seal it again.
     */
    case reseal(name: String)
    /* Not checked yet (or not in a way that counts), as opposed to checked once and changed since. */
    public var unverified: Bool {
        switch self {
        case .unverified, .recheck: true
        case .changed, .reseal: false
        }
    }
    /* The person can do something about it here: check the granter, or check again after a change. */
    public var actionable: Bool { self != .reseal(name: name) }
    public var name: String {
        switch self {
        case .unverified(let name), .changed(let name), .recheck(let name), .reseal(let name): name
        }
    }
    public var errorDescription: String? {
        switch self {
        case .unverified(let name): return "Add \(name) in People you share with and check their words to open what they shared."
        case .recheck(let name): return "Check \(name)’s words again in People you share with to open what they shared."
        case .changed(let name): return "\(name)’s key has changed since you added them. Check again in People you share with before opening what they shared."
        case .reseal(let name): return "Ask \(name) to share it again."
        }
    }
}

/* The granter's keys a received share is opened with: from the pin, never the server. */
public struct PinnedGranter: Sendable, Equatable {
    /* Ed25519, the pin's current key: a share must be signed by it. Keys the granter replaced open nothing. */
    public let signingPublicKey: Data
    /* The pin followed a succession: a share that fails under the current key likely awaits the granter's re-seal. */
    public let replacedKeys: Bool
    public let name: String
}

extension ContactPin {
    /*
     * The key to open a share from this granter with: the pinned one, and only when the server served
     * that same key. Taking the served keys of someone not pinned would let a server fake a share "from"
     * anyone with a key of its own, so that is refused, and nothing is pinned or followed here: pinning
     * follows a words check, and following a succession follows the person asking.
     */
    public static func granter(_ granter: SharedWithMeView.Granter, pins: [String: ContactPin]) throws -> PinnedGranter {
        let name = granter.name.isEmpty ? granter.email : granter.name
        guard let pin = pins[granter.id] else { throw GranterTrust.unverified(name: name) }
        guard pin.verified else { throw GranterTrust.recheck(name: pin.displayName) }
        guard pin.matches(granter.served) else { throw GranterTrust.changed(name: pin.displayName) }
        return PinnedGranter(signingPublicKey: try base64urlDecode(value: pin.signingPublicKey),
                             replacedKeys: !(pin.previousSigningKeys ?? []).isEmpty, name: pin.displayName)
    }
}

/*
 * Opens a share envelope (suite 3 only) with the granter's current signing key, checked before
 * anything else, and each identity this account holds, the current one first, since a share
 * sealed before this account's own succession opens only with the identity it was sealed to.
 */
public enum ShareOpener {
    public static func open(_ envelope: Data, ctx: ShareContext, granter: PinnedGranter, identities: [IdentityKeys]) throws -> Data {
        var first: Error?
        for identity in identities {
            do {
                return try shareOpen(envelope: envelope, granterSigningPublicKey: granter.signingPublicKey, grantee: identity, ctx: ctx)
            } catch {
                first = first ?? error
            }
        }
        // Signed, but not by the key the granter holds now, after they replaced theirs: it waits for their re-seal.
        if granter.replacedKeys, let core = first as? CoreError, case .Sealed(_) = core { throw GranterTrust.reseal(name: granter.name) }
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
        let pins = try await loadSettings().contacts
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
