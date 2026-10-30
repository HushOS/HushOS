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

/*
 * Why a received share waits (docs/optional-verification.md 6.4), said calmly on its row: for the
 * person's Open (someone they removed, or whose signed succession this phone hasn't followed), for
 * Review (an account that changed), for Try again (the guard couldn't be read), for the granter
 * (someone who can't be added yet, or a share sealed with keys they since replaced).
 */
public enum GranterTrust: Error, LocalizedError, Sendable, Equatable {
    /* Open adds them back, or follows them: the words say which. */
    case waiting(String)
    /* "Maya’s account changed": Review. */
    case changed(AccountChange)
    /* Nothing the person can do here yet (they need to sign in once more, contacts are full). */
    case unverified(String)
    /* This phone's guard couldn't be read: never first use. */
    case unchecked
    /* Signed with keys the granter has since replaced: it waits for the granter to seal it again. */
    case reseal(name: String)

    public var errorDescription: String? {
        switch self {
        case .waiting(let words), .unverified(let words): return words
        case .changed(let change): return "\(change.firstName)’s account changed. Review to open this."
        case .unchecked: return GuardWords.unreadable
        case .reseal(let name): return "Ask \(name) to share it again."
        }
    }
}

/* The granter's keys a received share is opened with: vouched for by the pin, never by the server alone. */
public struct PinnedGranter: Sendable, Equatable {
    /* Ed25519, the pin's current key: a share must be signed by it. Keys the granter replaced open nothing. */
    public let signingPublicKey: Data
    /* ML-DSA-65, as served, and only because its digest is the pin's: the other half of the share's signature. */
    public let mlDsaPublicKey: Data
    /* The pin followed a succession: a share that fails under the current key likely awaits the granter's re-seal. */
    public let replacedKeys: Bool
    public let name: String
}

/*
 * Opens a share envelope (suite 4 only) once both halves of its signature verify under the
 * granter's pinned keys, checked before anything else, with each identity this account holds,
 * the current one first, since a share sealed before this account's own succession opens only
 * with the identity it was sealed to.
 */
public enum ShareOpener {
    public static func open(_ envelope: Data, ctx: ShareContext, granter: PinnedGranter, identities: [IdentityKeys]) throws -> Data {
        var first: Error?
        let keys = HybridPublicKey(signingPublicKey: granter.signingPublicKey, mlDsaPublicKey: granter.mlDsaPublicKey)
        for identity in identities {
            do {
                return try shareOpen(envelope: envelope, granter: keys, grantee: identity, ctx: ctx)
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
    public static func identity(as owner: SharedKeychain.Session? = nil) async throws -> IdentityEnvelope {
        let reply = try await call("/api/auth/identity", as: owner)
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
        var mounts: [ShareMount] = []
        for share in shares {
            do {
                try Self.checkReceived(share, ownWorkspace: own)
                let ctx = ShareContext(
                    workspaceId: share.workspaceId, nodeId: share.node.id, keyEpoch: UInt64(share.keyEpoch),
                    granteeUserId: session.userId, granterUserId: share.granter.id
                )
                let granter: PinnedGranter
                do {
                    granter = try await trustGranter(share.granter, explicit: false)
                } catch GuardError.unreadable {
                    throw GranterTrust.unchecked
                }
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
                mounts.append(ShareMount(share: share, root: nil, error: ErrorWords.say(error, otherwise: "This couldn’t be opened. Try again.") ?? "This couldn’t be opened. Try again.", trust: error as? GranterTrust))
            }
        }
        return mounts
    }

    /*
     * Open on a row that waits (6.4): the person's own act, so someone removed is added back (the
     * removal forgotten) and a signed succession is followed; then everything they shared opens on
     * the next listing. A change met on the way throws `GranterTrust.changed`.
     */
    public func openWaiting(_ granter: SharedWithMeView.Granter) async throws {
        do {
            _ = try await trustGranter(granter, explicit: true)
        } catch GuardError.unreadable {
            throw GranterTrust.unchecked
        }
    }
}
