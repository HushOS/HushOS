import Foundation
import HushOSCore

/*
 * Subtree rotation, as the web does it after a share is revoked: every node
 * below the root gets a fresh key at the target epoch, parents first; its
 * metadata, versions, and the shares and links the owner's ledger holds (shares
 * only to keys a checked pin vouches for) are sealed again under it. Whatever
 * else the server lists is left out, and the server revokes what was not
 * re-sealed. The server hands out the work in depth order and applies each
 * batch; a node whose parent is not ready yet comes back later.
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
        /* Who signed the envelope being replaced. */
        var signer: Signer? = nil
        var signature: String? = nil
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
        var kdfVersion: Int? = nil
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

/*
 * Someone's public identity as the server serves it (a rotation's grantee, a share's grantee,
 * a report's operator): all four public keys and a version 2 identity's keys statement. A
 * version 1 identity has no ML-DSA key and no statement, and is trusted with nothing; only a
 * version 3 pin vouches for any of these.
 */
public struct ServedIdentity: Codable, Sendable {
    /* Raised by each succession. */
    public var keyVersion: UInt64? = nil
    public var identityVersion: Int? = nil
    public let encryptionPublicKey: String
    public let signingPublicKey: String
    public var mlDsaPublicKey: String? = nil
    public var kemPublicKey: String? = nil
    public var keysSignature: String? = nil
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
    /* Whom this person trusts didn't load: nothing is re-signed blind, and the rotation waits to be tried again. */
    case untrusted
    public var errorDescription: String? {
        switch self {
        case .stuck: "The rotation could not finish. Try again."
        case .untrusted: "HushOS couldn’t check who wrote what’s in it, so its keys weren’t changed yet. It will try again."
        }
    }
}

/* What a rotation did: how many nodes it re-sealed, and why any person's share was not sealed again (each once). */
public struct RotationOutcome: Sendable {
    public var rotated = 0
    public var skipped: [String] = []
}

extension RotationWorkNode {
    /* The shares to seal again: only those the ledger says the owner made on this node. */
    func ledgerShares(_ ledger: SharingLedger) -> [Share] {
        shares.filter { ledger.holdsShare(node: node.id, grantee: $0.granteeUserId) }
    }

    /* The links to seal again: only those the ledger says were made for this node. */
    func ledgerLinks(_ ledger: SharingLedger) -> [Link] {
        links.filter { ledger.holdsLink($0.id, node: node.id) }
    }
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
     * Rotates the subtree under `item`. Shares the pins no longer vouch for are left out and
     * named in the outcome, so the person sees who lost access, rather than sealing to X25519
     * alone or to a key nobody checked.
     */
    public func rotate(_ item: Opened, progress: @Sendable (Int) -> Void = { _ in }) async throws -> RotationOutcome {
        let ws = item.node.workspaceId
        // A family folder's walk goes only through the area ledger (iOS 4): never this personal rotation.
        try refuseFamilyWrite(ws)
        let rootId = item.id
        // Every record is checked as it was before it is signed again: without whom to trust, nothing starts.
        let trusted: TrustedSigners
        do { trusted = try await signers() } catch { throw RotationError.untrusted }
        let started = try await api.startRotation(workspaceId: ws, nodeId: rootId)
        let target = started.targetEpoch
        // The root's chain must be open: its parent key is what the new root key wraps under.
        if item.isFolder { _ = try await listChildren(of: rootId) } else if let parent = item.node.parentId { _ = try await listChildren(of: parent) }
        // The identity, the pins and the ledger are only needed for shares and links: a subtree with none never asks for them.
        var sharing: (keys: IdentityKeys, pins: [String: ContactPin], ledger: SharingLedger)?
        var epochs: [String: UInt64] = opened.values(in: ws).mapValues { $0.node.keyEpoch }
        var previous: [String: (epoch: UInt64, key: Data)] = [:]
        var outcome = RotationOutcome()
        var cursor: String? = nil
        var idle = 0
        var touched: Set<String> = [rootId]
        func ref(_ id: String) -> NodeRef { NodeRef(workspaceId: ws, nodeId: id) }

        func parentKey(_ parentId: String?, at epoch: UInt64) -> Data? {
            guard let parentId else { return workspaceKeyData() }
            if epochs[parentId] == epoch, let key = nodeKeys[ref(parentId)] { return key }
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
            for parentId in Set(work.nodes.compactMap(\.node.parentId)) where !inBatch.contains(parentId) && opened[ref(parentId)] == nil {
                _ = try? await listChildren(of: parentId)
                if let known = opened[ref(parentId)] { epochs[parentId] = known.node.keyEpoch }
            }
            var batch: [[String: Any]] = []
            for entry in work.nodes {
                let node = entry.node
                // Work for another workspace is not this subtree's.
                guard node.workspaceId.lowercased() == ws.lowercased() else { continue }
                touched.insert(node.id)
                let newParentEpoch = node.id == rootId ? node.parentKeyEpoch : target
                guard let wrappedUnder = parentKey(node.parentId, at: node.parentKeyEpoch),
                      let wrapUnder = parentKey(node.parentId, at: newParentEpoch) else { continue }
                let old: Data
                if epochs[node.id] == node.keyEpoch, let cached = nodeKeys[ref(node.id)] {
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
                    nodeKeys[ref(node.id)] = old
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
                // Re-sealed here, so signed here: by the account running the rotation, over the unchanged metadata version,
                // ordinary only when the record verified as it was and re-sealed otherwise, so a rotation launders nothing.
                let metadataSignature = try await signMetadata(workspaceId: ws, nodeId: node.id, kind: node.isFolder ? .folder : .file,
                                                               version: node.metadataVersion, envelope: metadataEnvelope,
                                                               signing: .after(trusted.metadata(of: node)))
                var versions: [[String: Any]] = []
                for version in entry.versions {
                    let ctx = VersionContext(workspaceId: ws, nodeId: node.id, versionId: version.id, objectId: version.objectId)
                    let content = try versionOpen(ctx: ctx, suite: version.contentSuite, nodeKey: old, envelope: try base64urlDecode(value: version.contentKeyEnvelope), rowSize: version.plaintextSize.flatMap { UInt64($0) })
                    let resealed = try versionReseal(ctx: ctx, suite: version.contentSuite, nodeKey: fresh, content: content)
                    let prior = trusted.version(id: version.id, objectId: version.objectId, contentSuite: version.contentSuite,
                                                contentKeyEnvelope: version.contentKeyEnvelope, signer: version.signer, signature: version.signature, of: node)
                    let signature = try await signVersion(workspaceId: ws, nodeId: node.id, versionId: version.id, objectId: version.objectId,
                                                          suite: version.contentSuite, envelope: resealed, signing: .after(prior))
                    versions.append(["id": version.id, "contentKeyEnvelope": base64urlEncode(bytes: resealed), "signature": signature])
                }
                var shares: [[String: Any]] = []
                if (!entry.shares.isEmpty || !entry.links.isEmpty) && sharing == nil {
                    let settings = try await loadSettings()
                    sharing = (try await identityKeys(), settings.contacts, settings.ledger)
                }
                for share in sharing.map({ entry.ledgerShares($0.ledger) }) ?? [] {
                    // Sealed only to the pinned keys: a grantee whose served keys moved on is left out until this person checks again.
                    guard let (keys, pins, _) = sharing else { continue }
                    let sealing: (publicKey: Data, kem: Data)
                    do {
                        guard let pin = pins[share.granteeUserId] else { throw ContactError.unpinned }
                        sealing = try pin.sealKeys(share.grantee.served)
                    } catch {
                        let reason = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                        if !outcome.skipped.contains(reason) { outcome.skipped.append(reason) }
                        continue
                    }
                    let ctx = ShareContext(workspaceId: ws, nodeId: node.id, keyEpoch: target, granteeUserId: share.granteeUserId, granterUserId: session.userId)
                    let sealed = try shareSeal(ctx: ctx, nodeKey: fresh, granter: keys, granteePublicKey: sealing.publicKey, granteeKemPublicKey: sealing.kem)
                    shares.append(["id": share.id, "shareEnvelope": base64urlEncode(bytes: sealed)])
                }
                var links: [[String: Any]] = []
                var unsealable: [String] = []
                for link in sharing.map({ entry.ledgerLinks($0.ledger) }) ?? [] {
                    // A row that names an older derivation is ended; one that names none is tried, and its secret decides.
                    guard let sealedSecret = link.secretEnvelope, link.kdfVersion.map({ $0 == Int(linkKdfVersion()) }) ?? true else {
                        unsealable.append(link.id)
                        continue
                    }
                    let oldCtx = LinkContext(workspaceId: ws, nodeId: node.id, keyEpoch: node.keyEpoch, linkId: link.id)
                    let newCtx = LinkContext(workspaceId: ws, nodeId: node.id, keyEpoch: target, linkId: link.id)
                    // A secret that no longer opens (an older derivation, a damaged row) is a link to end, not a rotation to fail.
                    guard let owned = try? linkSecretOpen(ctx: oldCtx, nodeKey: old, envelope: try base64urlDecode(value: sealedSecret)) else {
                        unsealable.append(link.id)
                        continue
                    }
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
                wire["rotated"] = ["metadataEnvelope": base64urlEncode(bytes: metadataEnvelope), "metadataSignature": metadataSignature,
                                   "versions": versions, "shares": shares, "links": links, "unsealableLinks": unsealable]
                // From here the node's key is the fresh one; the old one stays reachable for its unrotated children.
                previous[node.id] = (node.keyEpoch, old)
                nodeKeys[ref(node.id)] = fresh
                epochs[node.id] = target
                batch.append(wire)
            }
            var applied = 0
            if !batch.isEmpty {
                let results = try await api.rotateNodes(workspaceId: ws, nodeId: rootId, nodes: batch)
                applied = results.filter { $0.status == "ok" || $0.status == "already" }.count
            }
            outcome.rotated += applied
            progress(outcome.rotated)
            idle = applied > 0 ? 0 : idle + 1
            if idle > 3 { throw RotationError.stuck }
            // Everything applied: continue past the batch; otherwise start over so parents come first.
            cursor = applied == work.nodes.count ? work.nextCursor : nil
        }
        // Envelopes changed in the subtree: those items are opened again from the server, under
        // their fresh keys. Everything else stays as it was, so lists outside it keep their rows.
        // The catalogue holds the old rows too; the next sync rebuilds it from the feed.
        for id in touched { opened[ref(id)] = nil }
        catalogueState = .idle
        return outcome
    }
}
