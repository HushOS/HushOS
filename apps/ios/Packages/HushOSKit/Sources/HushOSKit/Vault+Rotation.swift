import Foundation
import HushOSCore

/*
 * Subtree rotation, as the web does it after a share is revoked: every node
 * below the root gets a fresh key at the target epoch, parents first; its
 * metadata, versions, live shares (to keys the pins vouch for) and links are
 * sealed again under it. The server hands out the work in depth order and
 * applies each batch; a node whose parent is not ready yet comes back later.
 */
struct RotationView: Codable, Sendable {
    let nodeId: String
    let targetEpoch: UInt64
}

struct RotationStarted: Codable, Sendable { let rotation: RotationView }

struct RotationWorkNode: Decodable, Sendable {
    struct Version: Decodable, Sendable {
        let id: String
        let objectId: String
        let contentKeyEnvelope: String
        let contentSuite: UInt32
        let plaintextSize: String?
    }
    struct Share: Decodable, Sendable {
        let id: String
        let granteeUserId: String
        let grantee: ServedIdentity
    }
    struct Link: Decodable, Sendable {
        let id: String
        let hasPassword: Bool
        let secretEnvelope: String?
    }
    let node: NodeView
    let depth: Int
    let versions: [Version]
    let shares: [Share]
    let links: [Link]

    private enum Keys: String, CodingKey { case depth, versions, shares, links }

    init(from decoder: Decoder) throws {
        node = try NodeView(from: decoder)
        let extras = try decoder.container(keyedBy: Keys.self)
        depth = try extras.decodeIfPresent(Int.self, forKey: .depth) ?? 0
        versions = try extras.decodeIfPresent([Version].self, forKey: .versions) ?? []
        shares = try extras.decodeIfPresent([Share].self, forKey: .shares) ?? []
        links = try extras.decodeIfPresent([Link].self, forKey: .links) ?? []
    }
}

public struct ServedIdentity: Decodable, Sendable {
    public struct Kem: Decodable, Sendable {
        public let publicKey: String
        public let signature: String
    }
    public let encryptionPublicKey: String
    public let signingPublicKey: String
    public let kem: Kem?
}

struct RotationWork: Decodable, Sendable {
    let rotation: RotationView
    let nodes: [RotationWorkNode]
    let nextCursor: String?
    let done: Bool
}

struct RotationResults: Decodable, Sendable {
    struct Result: Decodable, Sendable {
        let id: String
        let status: String
    }
    let results: [Result]
}

public enum RotationError: Error, LocalizedError {
    case stuck
    public var errorDescription: String? { "The rotation could not finish. Try again." }
}

extension DriveAPI {
    func startRotation(workspaceId: String, nodeId: String) async throws -> RotationView {
        try await performPublic(try mutationPublic("/nodes/\(nodeId)/rotation", body: ["workspaceId": workspaceId]), as: RotationStarted.self).rotation
    }

    func rotationWork(workspaceId: String, nodeId: String, after: String?) async throws -> RotationWork {
        var query = [URLQueryItem(name: "workspaceId", value: workspaceId)]
        if let after { query.append(URLQueryItem(name: "after", value: after)) }
        return try await performPublic(try requestPublic("/nodes/\(nodeId)/rotation/work", query: query), as: RotationWork.self)
    }

    func rotateNodes(workspaceId: String, nodeId: String, nodes: [[String: Any]]) async throws -> [RotationResults.Result] {
        try await performPublic(try mutationPublic("/nodes/\(nodeId)/rotation/nodes", body: ["workspaceId": workspaceId, "nodes": nodes]), as: RotationResults.self).results
    }
}

extension Vault {
    /*
     * The keys a grantee's share is sealed to, by the pin: no pin or a changed
     * X25519 key drops the share (it keeps its old envelope, which the rotation
     * leaves unopenable); a served post-quantum key is used when the pin knows
     * it, or when it is signed and the pin has none yet.
     */
    private func trustedKeys(for share: RotationWorkNode.Share, pins: [String: ContactPin]) -> (Data, Data?)? {
        guard let pin = pins[share.granteeUserId], pin.encryptionPublicKey == share.grantee.encryptionPublicKey,
              let publicKey = try? base64urlDecode(value: pin.encryptionPublicKey) else { return nil }
        guard let kem = share.grantee.kem, let kemBytes = try? base64urlDecode(value: kem.publicKey) else {
            return pin.kemPublicKeyHash == nil ? (publicKey, nil) : nil
        }
        let digest = keyDigest(publicKey: kemBytes)
        if let known = pin.kemPublicKeyHash { return known == digest ? (publicKey, kemBytes) : nil }
        let signed = kemBindingVerify(userId: share.granteeUserId, encryptionPublicKey: share.grantee.encryptionPublicKey,
                                      signingPublicKey: share.grantee.signingPublicKey, kemPublicKey: kem.publicKey, signature: kem.signature)
        return (publicKey, signed ? kemBytes : nil)
    }

    /* Rotates the subtree under `item`; returns how many nodes were re-sealed. */
    public func rotate(_ item: Opened, progress: @Sendable (Int) -> Void = { _ in }) async throws -> Int {
        let ws = item.node.workspaceId
        let rootId = item.id
        let started = try await api.startRotation(workspaceId: ws, nodeId: rootId)
        let target = started.targetEpoch
        // The root's chain must be open: its parent key is what the new root key wraps under.
        if item.isFolder { _ = try await listChildren(of: rootId) } else if let parent = item.node.parentId { _ = try await listChildren(of: parent) }
        let keys = try await identityKeys()
        let pins = try await loadSettings().contacts
        var epochs: [String: UInt64] = opened.mapValues { $0.node.keyEpoch }
        var previous: [String: (epoch: UInt64, key: Data)] = [:]
        var done = 0
        var cursor: String? = nil
        var idle = 0

        func parentKey(_ parentId: String?, at epoch: UInt64) -> Data? {
            guard let parentId else { return workspaceKeyData() }
            if epochs[parentId] == epoch, let key = nodeKeys[parentId] { return key }
            if let prev = previous[parentId], prev.epoch == epoch { return prev.key }
            return nil
        }

        while true {
            let work = try await api.rotationWork(workspaceId: ws, nodeId: rootId, after: cursor)
            if work.done { break }
            if work.nodes.isEmpty {
                cursor = nil
                idle += 1
                if idle > 3 { throw RotationError.stuck }
                continue
            }
            let inBatch = Set(work.nodes.map(\.node.id))
            for parentId in Set(work.nodes.compactMap(\.node.parentId)) where !inBatch.contains(parentId) && opened[parentId] == nil {
                _ = try? await listChildren(of: parentId)
                if let known = opened[parentId] { epochs[parentId] = known.node.keyEpoch }
            }
            var batch: [[String: Any]] = []
            for entry in work.nodes {
                let node = entry.node
                let newParentEpoch = node.id == rootId ? node.parentKeyEpoch : target
                guard let wrappedUnder = parentKey(node.parentId, at: node.parentKeyEpoch),
                      let wrapUnder = parentKey(node.parentId, at: newParentEpoch) else { continue }
                let old: Data
                if epochs[node.id] == node.keyEpoch, let cached = nodeKeys[node.id] {
                    old = cached
                } else {
                    old = try nodeOpen(
                        ctx: NodeKeyContext(workspaceId: ws, nodeId: node.id, parentId: node.parentId ?? ws, parentKeyEpoch: node.parentKeyEpoch, keyEpoch: node.keyEpoch),
                        parentKey: wrappedUnder, keyEnvelope: try base64urlDecode(value: node.keyEnvelope)
                    )
                }
                var wire: [String: Any] = ["id": node.id, "changeSeq": node.changeSeq ?? 0, "parentKeyEpoch": newParentEpoch]
                if node.keyEpoch >= target {
                    // Already at the target, only wrapped under an unrotated parent: the same key, rewrapped.
                    let envelope = try nodeWrap(
                        ctx: NodeKeyContext(workspaceId: ws, nodeId: node.id, parentId: node.parentId ?? ws, parentKeyEpoch: newParentEpoch, keyEpoch: node.keyEpoch),
                        parentKey: wrapUnder, nodeKey: old
                    )
                    wire["keyEnvelope"] = base64urlEncode(bytes: envelope)
                    wire["rotated"] = NSNull()
                    nodeKeys[node.id] = old
                    epochs[node.id] = node.keyEpoch
                    batch.append(wire)
                    continue
                }
                let fresh = try randomBytes(length: 32)
                let envelope = try nodeWrap(
                    ctx: NodeKeyContext(workspaceId: ws, nodeId: node.id, parentId: node.parentId ?? ws, parentKeyEpoch: newParentEpoch, keyEpoch: target),
                    parentKey: wrapUnder, nodeKey: fresh
                )
                let metaCtx = MetadataContext(workspaceId: ws, nodeId: node.id, metadataVersion: node.metadataVersion)
                let metadata = try metadataOpen(ctx: metaCtx, nodeKey: old, envelope: try base64urlDecode(value: node.metadataEnvelope))
                let metadataEnvelope = try metadataSeal(ctx: metaCtx, nodeKey: fresh, metadata: metadata)
                var versions: [[String: Any]] = []
                for version in entry.versions {
                    let ctx = VersionContext(workspaceId: ws, nodeId: node.id, versionId: version.id, objectId: version.objectId)
                    let content = try versionOpen(ctx: ctx, suite: version.contentSuite, nodeKey: old, envelope: try base64urlDecode(value: version.contentKeyEnvelope), rowSize: version.plaintextSize.flatMap { UInt64($0) })
                    versions.append(["id": version.id, "contentKeyEnvelope": base64urlEncode(bytes: try versionReseal(ctx: ctx, suite: version.contentSuite, nodeKey: fresh, content: content))])
                }
                var shares: [[String: Any]] = []
                for share in entry.shares {
                    guard let (publicKey, kem) = trustedKeys(for: share, pins: pins) else { continue }
                    let ctx = ShareContext(workspaceId: ws, nodeId: node.id, keyEpoch: target, granteeUserId: share.granteeUserId, granterUserId: session.userId)
                    let sealed = try shareSeal(ctx: ctx, nodeKey: fresh, granterPrivateKey: keys.encryptionPrivateKey, granteePublicKey: publicKey, granteeKemPublicKey: kem)
                    shares.append(["id": share.id, "shareEnvelope": base64urlEncode(bytes: sealed)])
                }
                var links: [[String: Any]] = []
                var unsealable: [String] = []
                for link in entry.links {
                    guard let sealedSecret = link.secretEnvelope else { unsealable.append(link.id); continue }
                    let oldCtx = LinkContext(workspaceId: ws, nodeId: node.id, keyEpoch: node.keyEpoch, linkId: link.id)
                    let newCtx = LinkContext(workspaceId: ws, nodeId: node.id, keyEpoch: target, linkId: link.id)
                    let owned = try linkSecretOpen(ctx: oldCtx, nodeKey: old, envelope: try base64urlDecode(value: sealedSecret))
                    // A password link sealed before the password key was kept cannot be re-sealed without the password.
                    if link.hasPassword && owned.fromPassword == nil { unsealable.append(link.id); continue }
                    let stretched = owned.fromPassword ?? Data(repeating: 0, count: 32)
                    links.append([
                        "id": link.id,
                        "linkEnvelope": base64urlEncode(bytes: try linkSeal(ctx: newCtx, nodeKey: fresh, secret: owned.secret, fromPassword: stretched)),
                        "secretEnvelope": base64urlEncode(bytes: try linkSecretSeal(ctx: newCtx, nodeKey: fresh, secret: owned.secret, token: owned.token, fromPassword: stretched)),
                    ])
                }
                wire["keyEnvelope"] = base64urlEncode(bytes: envelope)
                wire["rotated"] = ["metadataEnvelope": base64urlEncode(bytes: metadataEnvelope), "versions": versions, "shares": shares, "links": links, "unsealableLinks": unsealable]
                // From here the node's key is the fresh one; the old one stays reachable for its unrotated children.
                previous[node.id] = (node.keyEpoch, old)
                nodeKeys[node.id] = fresh
                epochs[node.id] = target
                batch.append(wire)
            }
            var applied = 0
            if !batch.isEmpty {
                let results = try await api.rotateNodes(workspaceId: ws, nodeId: rootId, nodes: batch)
                applied = results.filter { $0.status == "ok" || $0.status == "already" }.count
            }
            done += applied
            progress(done)
            idle = applied > 0 ? 0 : idle + 1
            if idle > 3 { throw RotationError.stuck }
            // Everything applied: continue past the batch; otherwise start over so parents come first.
            cursor = applied == work.nodes.count ? work.nextCursor : nil
        }
        // Envelopes changed under every folder: what this device listed is stale.
        opened.removeAll()
        return done
    }
}
