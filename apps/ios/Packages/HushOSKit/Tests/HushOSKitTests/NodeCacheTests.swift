import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * A received share names its own node id and workspace, and the server picks both. Before
 * the caches were keyed by workspace, a share whose node id was one of the account's own
 * folders replaced that folder's key, and the next upload into it was sealed under a key the
 * server held. These hold the caches to: own keys are never replaced or answered for by a
 * received one, and a share into the account's own drive is refused before anything opens.
 */
struct NodeCacheTests {
    let session = SharedKeychain.Session(origin: "https://drive.test", token: "token", userId: UUID().uuidString.lowercased())
    let own = UUID().uuidString.lowercased()
    let foreign = UUID().uuidString.lowercased()

    func sealed(_ id: String, workspace: String, parent: String?, parentKey: Data, key: Data, suite: Int? = nil) throws -> NodeView {
        let ctx = NodeKeyContext(workspaceId: workspace, nodeId: id, parentId: parent ?? workspace, parentKeyEpoch: 1, keyEpoch: 1)
        let metadata = try metadataSeal(ctx: MetadataContext(workspaceId: workspace, nodeId: id, metadataVersion: 1), nodeKey: key,
                                        metadata: NodeMetadata(name: id, mime: nil, size: nil, modified: nil))
        return NodeView(id: id, workspaceId: workspace, parentId: parent, kind: "folder", keyEpoch: 1, parentKeyEpoch: 1,
                        keyEnvelope: base64urlEncode(bytes: try nodeWrap(ctx: ctx, parentKey: parentKey, nodeKey: key)),
                        metadataVersion: 1, metadataEnvelope: base64urlEncode(bytes: metadata), currentVersion: nil,
                        trashedAt: nil, changeSeq: 1, createdAt: nil, updatedAt: nil, envelopeSuite: suite)
    }

    func received(workspace: String, node: NodeView) -> SharedWithMeView {
        SharedWithMeView(id: "share-1", workspaceId: workspace, role: "editor", keyEpoch: 1, shareEnvelope: "", prevShareEnvelope: nil,
                         prevKeyEpoch: nil, createdAt: "", granter: .init(id: "eve", name: "Eve", email: "eve@example.com", encryptionPublicKey: ""),
                         node: node)
    }

    /* A vault holding the own top folder `root`, opened under the workspace key. */
    func vault() async throws -> (Vault, root: NodeView, rootKey: Data) {
        let vault = Vault(api: DriveAPI(session: session), session: session)
        let workspaceKey = try randomBytes(length: 32)
        let rootKey = try randomBytes(length: 32)
        let root = try sealed("root", workspace: own, parent: nil, parentKey: workspaceKey, key: rootKey)
        await vault.adopt(workspace: WorkspaceView(workspaceId: own, changeSeq: nil, grant: nil, root: root), key: workspaceKey)
        try await vault.open(root)
        return (vault, root, rootKey)
    }

    @Test func aReceivedKeyUnderAnOwnNodesIdNeitherReplacesNorAnswersForIt() async throws {
        let (vault, _, rootKey) = try await vault()
        let serverKey = try randomBytes(length: 32)
        // The server's share: same id as the own top folder, in a workspace it controls.
        let fake = try sealed("root", workspace: foreign, parent: nil, parentKey: serverKey, key: serverKey)
        _ = try await vault.adopt(fake, nodeKey: serverKey, metadata: NodeMetadata(name: "Drive", mime: nil, size: nil, modified: nil), in: foreign)

        #expect(await vault.nodeKey("root") == rootKey)
        #expect(await vault.item("root")?.node.workspaceId == own)

        // A child of the own folder opens under the own key, and one wrapped under the server's key does not.
        let child = try sealed("child", workspace: own, parent: "root", parentKey: rootKey, key: try randomBytes(length: 32))
        #expect(try await vault.open(child).node.workspaceId == own)
        let planted = try sealed("planted", workspace: own, parent: "root", parentKey: serverKey, key: try randomBytes(length: 32))
        await #expect(throws: CoreError.self) { try await vault.open(planted) }
    }

    @Test func aWriteAnsweredForAnotherWorkspaceIsNotCached() async throws {
        let (vault, _, rootKey) = try await vault()
        let serverKey = try randomBytes(length: 32)
        // A reply claiming the own drive for a write made into a received folder: refused, own key kept.
        let reply = try sealed("root", workspace: own, parent: nil, parentKey: serverKey, key: serverKey)
        await #expect(throws: DriveAPIError.self) {
            _ = try await vault.adopt(reply, nodeKey: serverKey, metadata: NodeMetadata(name: "x", mime: nil, size: nil, modified: nil), in: foreign)
        }
        #expect(await vault.nodeKey("root") == rootKey)
    }

    @Test func aShareIntoTheOwnDriveOrNotMatchingItsNodeIsRefusedBeforeOpening() throws {
        let key = try randomBytes(length: 32)
        let ownNode = try sealed("root", workspace: own, parent: nil, parentKey: key, key: key)
        #expect(throws: DriveAPIError.self) { try Vault.checkReceived(received(workspace: own, node: ownNode), ownWorkspace: own) }
        // Names another workspace, but its node is the own one.
        #expect(throws: DriveAPIError.self) { try Vault.checkReceived(received(workspace: foreign, node: ownNode), ownWorkspace: own.uppercased()) }
        let theirs = try sealed("theirs", workspace: foreign, parent: nil, parentKey: key, key: key)
        try Vault.checkReceived(received(workspace: foreign, node: theirs), ownWorkspace: own)
    }

    @Test func aRowSealedInANewerEnvelopeSuiteIsNotOpened() async throws {
        let (vault, _, rootKey) = try await vault()
        let newer = try sealed("newer", workspace: own, parent: "root", parentKey: rootKey, key: try randomBytes(length: 32), suite: 2)
        await #expect { try await vault.open(newer) } throws: { error in
            if case DriveAPIError.newerEnvelope = error { true } else { false }
        }
        let current = try sealed("current", workspace: own, parent: "root", parentKey: rootKey, key: try randomBytes(length: 32), suite: 1)
        #expect(try await vault.open(current).id == "current")
    }
}
