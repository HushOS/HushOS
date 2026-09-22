import Foundation

/* A share as received, with its root opened under the key the granter sealed to this identity. */
public struct ShareMount: Sendable, Identifiable {
    public let share: SharedWithMeView
    public let root: Opened?
    public let error: String?
    public var id: String { share.id }
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
        var mounts: [ShareMount] = []
        for share in shares {
            do {
                let ctx = ShareContext(
                    workspaceId: share.workspaceId, nodeId: share.node.id, keyEpoch: UInt64(share.keyEpoch),
                    granteeUserId: session.userId, granterUserId: share.granter.id
                )
                let granterKey = try base64urlDecode(value: share.granter.encryptionPublicKey)
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
                mounts.append(ShareMount(share: share, root: nil, error: (error as? LocalizedError)?.errorDescription ?? error.localizedDescription))
            }
        }
        return mounts
    }
}
