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
    /* Not checked yet, as opposed to checked once and changed since. */
    public var unverified: Bool { if case .unverified = self { true } else { false } }
    public var errorDescription: String? {
        switch self {
        case .unverified(let name): return "Add \(name) in People you share with and check their words to open what they shared."
        case .changed(let name): return "\(name)’s key has changed since you added them. Check it’s them in People you share with before opening what they shared."
        }
    }
}

extension ContactPin {
    /*
     * The key to open a share from this granter with: the pinned one, and only when the server served that
     * same key. Taking the served key of someone not pinned would let a server fake a share "from" anyone
     * with a key of its own, so that is refused, and nothing is pinned here: pinning follows a words check.
     */
    public static func granterKey(_ granter: SharedWithMeView.Granter, pins: [String: ContactPin]) throws -> Data {
        let name = granter.name.isEmpty ? granter.email : granter.name
        guard let pin = pins[granter.id] else { throw GranterTrust.unverified(name: name) }
        guard pin.encryptionPublicKey == granter.encryptionPublicKey else { throw GranterTrust.changed(name: name) }
        return try base64urlDecode(value: pin.encryptionPublicKey)
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
     * What others shared with this account, each root opened with the identity
     * keys and adopted as a root of its own: everything below opens like any
     * other folder, in the granter's workspace.
     */
    public func mountShares() async throws -> [ShareMount] {
        let shares = try await api.sharedWithMe()
        if shares.isEmpty { return [] }
        let keys = try await identityKeys()
        let pins = try await loadSettings().contacts
        var mounts: [ShareMount] = []
        for share in shares {
            do {
                let ctx = ShareContext(
                    workspaceId: share.workspaceId, nodeId: share.node.id, keyEpoch: UInt64(share.keyEpoch),
                    granteeUserId: session.userId, granterUserId: share.granter.id
                )
                let granterKey = try ContactPin.granterKey(share.granter, pins: pins)
                let key: Data
                do {
                    key = try shareOpen(envelope: try base64urlDecode(value: share.shareEnvelope), granterPublicKey: granterKey, grantee: keys, ctx: ctx)
                } catch let first {
                    // Mid-rotation the previous envelope is the one sealed to this identity.
                    guard let prev = share.prevShareEnvelope, let prevEpoch = share.prevKeyEpoch else { throw first }
                    var prevCtx = ctx
                    prevCtx.keyEpoch = UInt64(prevEpoch)
                    key = try shareOpen(envelope: try base64urlDecode(value: prev), granterPublicKey: granterKey, grantee: keys, ctx: prevCtx)
                }
                let metadata = try metadataOpen(
                    ctx: MetadataContext(workspaceId: share.node.workspaceId, nodeId: share.node.id, metadataVersion: share.node.metadataVersion),
                    nodeKey: key, envelope: try base64urlDecode(value: share.node.metadataEnvelope)
                )
                mounts.append(ShareMount(share: share, root: adopt(share.node, nodeKey: key, metadata: metadata), error: nil))
            } catch {
                mounts.append(ShareMount(share: share, root: nil, error: (error as? LocalizedError)?.errorDescription ?? error.localizedDescription, trust: error as? GranterTrust))
            }
        }
        return mounts
    }
}
