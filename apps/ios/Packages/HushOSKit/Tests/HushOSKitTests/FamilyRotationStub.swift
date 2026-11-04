import Foundation
import HushOSCore
@testable import HushOSKit

/*
 * The family stub server's side of a key change, as Android's FakeDrive: a manager's member-list
 * change re-keys a family folder's top folder (`replaceKeys`), and members walk the rest through
 * the rotation routes. The server keeps every node's key it can unwrap from the area key (`keyOf`),
 * the keys nodes had before (`previousKeys`), and judges each node of a batch on its own (stale,
 * parent-not-ready), so a batch can land in part. Also route 20 (leave), the change feed and the
 * trash's refusals the walk's parent opening meets.
 */
final class RotationStub: @unchecked Sendable {
    struct Run {
        let id: String
        let workspaceId: String
        let target: UInt64
        var applied: Set<String>
        var finished = false
    }

    var runs: [String: Run] = [:]
    /* The family folder's area key by key version (1 the fixture's, 2 after replaceKeys). */
    var areaKeys: [UInt64: Data] = [:]
    /* A node's key at an epoch it has left, by "id@epoch": its unreached children are still wrapped under it. */
    var previousKeys: [String: Data] = [:]
    /* How many nodes the work route hands out at once (nil: all). */
    var rotationBatch: Int?
    /* Sends (counted from 1) answered 500 before anything is applied, and sends applied whose answer is lost (500 after). */
    var failRotationSends: Set<Int> = []
    var loseRotationAnswers: Set<Int> = []
    /* Runs as a batch arrives, before any of it is applied (another device's batch landing first). */
    var beforeRotationSend: (@Sendable ([String]) -> Void)?
    /*
     * The answer to the batch holding this node, held off the loading thread until `release` is
     * signalled (`arrived` is signalled as it is held): the phone goes on meanwhile, as it would
     * while a slow answer is on its way.
     */
    var holdSendWith: String?
    var holding = false
    let arrived = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    /* The ids of every batch sent, in order. */
    var batches: [[String]] = []
    var sends = 0
    /* The change feed's page size (nil: as asked). */
    var changesPage: Int?
    var feedRequests = 0
    /* The server's change order: every change takes the next. */
    var seq = 100
    /* Route 20: what each leave sent as `endsLapsed`, and a refusal to answer with instead of leaving. */
    var leaves: [[String]] = []
    var leaveRefusal: (Int, [String: Any])?
}

extension FamilyServer {
    func node(json node: NodeView) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(node))) as? [String: Any] ?? [:]
    }

    /* `id`'s row changed through its JSON, at the server's next change order. Under the lock. */
    func change(_ id: String, _ edit: (inout [String: Any]) throws -> Void) rethrows {
        guard let held = tree[id] else { return }
        var json = node(json: held)
        try edit(&json)
        rotations.seq += 1
        json["changeSeq"] = rotations.seq
        tree[id] = try! JSONDecoder().decode(NodeView.self, from: JSONSerialization.data(withJSONObject: json))
    }

    /*
     * The key of `id` as the server can unwrap it from the area key down; nil when it can't (a node
     * sealed under a key nobody kept). Under the lock.
     */
    func keyOf(_ id: String) -> Data? {
        guard let node = tree[id] else { return nil }
        let workspaceId = node.workspaceId
        let parentKey: Data?
        if let parent = node.parentId, parent != workspaceId {
            parentKey = keyAt(parent, node.parentKeyEpoch)
        } else {
            parentKey = rotations.areaKeys[node.parentKeyEpoch] ?? family.areaKey
        }
        guard let parentKey, let envelope = try? base64urlDecode(value: node.keyEnvelope) else { return nil }
        return try? nodeOpen(ctx: NodeKeyContext(workspaceId: workspaceId, nodeId: id, parentId: node.parentId ?? workspaceId,
                                                 parentKeyEpoch: node.parentKeyEpoch, keyEpoch: node.keyEpoch),
                             parentKey: parentKey, keyEnvelope: envelope)
    }

    /* `id`'s key at `epoch`: its key now, or the one it had then. Under the lock. */
    func keyAt(_ id: String, _ epoch: UInt64) -> Data? {
        if tree[id]?.keyEpoch == epoch { return keyOf(id) }
        return rotations.previousKeys["\(id)@\(epoch)"]
    }

    /* A node's name as the server's keys open it: what a test reads after a walk. */
    func name(of id: String) -> String? {
        lock.withLock {
            guard let node = tree[id], let key = keyOf(id) else { return nil }
            return try? metadataOpen(ctx: MetadataContext(workspaceId: node.workspaceId, nodeId: id, metadataVersion: node.metadataVersion),
                                     nodeKey: key, envelope: base64urlDecode(value: node.metadataEnvelope)).name
        }
    }

    /* Whether the run from `nodeId` is still running (route 25 names it), and what it re-keyed so far. */
    func running(_ nodeId: String) -> Bool { lock.withLock { rotations.runs[nodeId]?.finished == false } }
    func applied(in nodeId: String) -> Set<String> { lock.withLock { rotations.runs[nodeId]?.applied ?? [] } }
    var rotationBatches: [[String]] { lock.withLock { rotations.batches } }

    /* Route 25's `rotation` for the family folder: the run from its top folder while it runs. Under the lock. */
    func rotationJSON() -> Any {
        guard let run = rotations.runs[family.rootId], !run.finished else { return NSNull() }
        return ["id": run.id, "nodeId": family.rootId, "targetEpoch": run.target]
    }

    /*
     * Sam changes the family folder's keys with the member list, as a removal does (groups-server 8,
     * option A): the next roster lists the folder at key version 2 with its top folder's new key,
     * Maya gets a grant of version 2, and the top folder is re-keyed at `target` under the new area
     * key, its previous key wrapped under it too; everything below is still under the old keys, a
     * key change from the top folder for any member to walk. The new chain.
     */
    @discardableResult
    func replaceKeys(target: UInt64 = 100) throws -> [SignedGroupStatement] {
        let f = family
        let held = lock.withLock { chain }
        guard case .accepted(let accepted) = try acceptRosters(groupId: f.groupId, firstKeys: try f.firstKeys, anchor: .created, pins: [], rosters: held,
                                                              successions: [], mlDsaKeys: try f.signerKeys, me: f.creator.own, cache: nil)
        else { throw FamilyFailure(message: "the creator's chain didn't accept") }
        let newArea = try randomBytes(length: 32)
        let newRoot = try randomBytes(length: 32)
        let roster = try rosterNext(chain: accepted, members: accepted.roster().members, signerUserId: f.creator.userId,
                                    areaKeys: [AreaKey(workspaceId: f.workspaceId, workspaceKey: newArea, rootKey: newRoot)], retireAreas: nil, format: nil)
        let next = try rosterSign(roster: roster, groupSeed: f.groupSeed, signer: f.creator.keys)
        guard case .accepted(let chain3) = try acceptRosters(groupId: f.groupId, firstKeys: try f.firstKeys, anchor: .created, pins: [], rosters: held + [next],
                                                            successions: [], mlDsaKeys: try f.signerKeys, me: f.creator.own, cache: nil)
        else { throw FamilyFailure(message: "the creator's next chain didn't accept") }
        let digest = rosterDigest(statement: next.statement)
        let envelope = try areaGrantSeal(
            workspaceKey: newArea,
            ctx: AreaGrantContext(groupId: f.groupId, workspaceId: f.workspaceId, workspaceKeyVersion: 2, granteeUserId: f.member.userId,
                                  granteeKeyVersion: f.member.keys.keyVersion, granterUserId: f.creator.userId, rosterVersion: roster.rosterVersion,
                                  rosterDigest: digest),
            chain: chain3, areaIdSeed: f.workspaceSeed, granteeKemPublicKey: try base64urlDecode(value: f.member.keys.kemPublicKey!), granter: f.creator.keys
        )
        try lock.withLock {
            if rotations.areaKeys[1] == nil { rotations.areaKeys[1] = f.areaKey }
            let root = tree[f.rootId]!
            let oldKey = keyOf(f.rootId)!
            rotations.previousKeys["\(f.rootId)@\(root.keyEpoch)"] = oldKey
            let ctx = MetadataContext(workspaceId: f.workspaceId, nodeId: f.rootId, metadataVersion: root.metadataVersion)
            let metadata = try metadataOpen(ctx: ctx, nodeKey: oldKey, envelope: try base64urlDecode(value: root.metadataEnvelope))
            let sealed = try metadataSeal(ctx: ctx, nodeKey: newRoot, metadata: metadata)
            let signature = try metadataSign(signingSeed: f.creator.keys.signingSeed,
                                             statement: MetadataStatement(workspaceId: f.workspaceId, nodeId: f.rootId, kind: .folder, metadataVersion: root.metadataVersion),
                                             metadataEnvelope: sealed)
            let previous = try previousRootKeyWrap(ctx: NodeKeyContext(workspaceId: f.workspaceId, nodeId: f.rootId, parentId: f.workspaceId, parentKeyEpoch: 2,
                                                                       keyEpoch: root.keyEpoch), areaKey: newArea, rootKey: oldKey)
            let wrapped = try nodeWrap(ctx: NodeKeyContext(workspaceId: f.workspaceId, nodeId: f.rootId, parentId: f.workspaceId, parentKeyEpoch: 2, keyEpoch: target),
                                       parentKey: newArea, nodeKey: newRoot)
            rotations.areaKeys[2] = newArea
            change(f.rootId) { json in
                json["prevKeyEnvelope"] = base64urlEncode(bytes: previous)
                json["prevKeyEpoch"] = root.keyEpoch
                json["prevParentKeyEpoch"] = 2
                json["keyEnvelope"] = base64urlEncode(bytes: wrapped)
                json["keyEpoch"] = target
                json["parentKeyEpoch"] = 2
                json["metadataEnvelope"] = base64urlEncode(bytes: sealed)
                json["metadataSignature"] = base64urlEncode(bytes: signature)
                json["metadataSigner"] = ["id": f.creator.userId]
            }
            rotations.runs[f.rootId] = RotationStub.Run(id: UUID().uuidString.lowercased(), workspaceId: f.workspaceId, target: target, applied: [f.rootId])
            areaVersion = 2
            areaGrant = (roster.rosterVersion, digest, envelope)
            chain = held + [next]
        }
        return held + [next]
    }

    /*
     * Another device of the creator, walking the run from `runRoot`, re-keys `id` first, as its own
     * batch would: a fresh key wrapped under its parent's key at the target, its name sealed again
     * under it and signed by the creator. Its children stay under its key before.
     */
    func rekeyedElsewhere(_ runRoot: String, _ id: String) {
        lock.withLock {
            let run = rotations.runs[runRoot]!
            let node = tree[id]!
            let old = keyOf(id)!
            rotations.previousKeys["\(id)@\(node.keyEpoch)"] = old
            let fresh = try! randomBytes(length: 32)
            let parentEpoch = id == runRoot ? node.parentKeyEpoch : run.target
            let parentKey = (node.parentId.map { keyAt($0, parentEpoch) } ?? rotations.areaKeys[parentEpoch])!
            let ctx = MetadataContext(workspaceId: node.workspaceId, nodeId: id, metadataVersion: node.metadataVersion)
            let metadata = try! metadataOpen(ctx: ctx, nodeKey: old, envelope: try! base64urlDecode(value: node.metadataEnvelope))
            let sealed = try! metadataSeal(ctx: ctx, nodeKey: fresh, metadata: metadata)
            let signature = try! metadataSign(signingSeed: family.creator.keys.signingSeed,
                                              statement: MetadataStatement(workspaceId: node.workspaceId, nodeId: id, kind: node.isFolder ? .folder : .file,
                                                                           metadataVersion: node.metadataVersion),
                                              metadataEnvelope: sealed)
            let wrapped = try! nodeWrap(ctx: NodeKeyContext(workspaceId: node.workspaceId, nodeId: id, parentId: node.parentId ?? node.workspaceId,
                                                            parentKeyEpoch: parentEpoch, keyEpoch: run.target), parentKey: parentKey, nodeKey: fresh)
            change(id) { json in
                if json["prevKeyEnvelope"] == nil || json["prevKeyEnvelope"] is NSNull {
                    json["prevKeyEnvelope"] = node.keyEnvelope
                    json["prevKeyEpoch"] = node.keyEpoch
                    json["prevParentKeyEpoch"] = node.parentKeyEpoch
                }
                json["keyEnvelope"] = base64urlEncode(bytes: wrapped)
                json["keyEpoch"] = run.target
                json["parentKeyEpoch"] = parentEpoch
                json["metadataEnvelope"] = base64urlEncode(bytes: sealed)
                json["metadataSignature"] = base64urlEncode(bytes: signature)
                json["metadataSigner"] = ["id": family.creator.userId]
                json["metadataRekey"] = NSNull()
            }
            rotations.runs[runRoot]!.applied.insert(id)
        }
    }

    /* The subtree under `id`, breadth first: what a run walks, parents first. Under the lock. */
    func subtree(_ id: String) -> [NodeView] {
        var out: [NodeView] = []
        var queue = [id]
        while !queue.isEmpty {
            let next = queue.removeFirst()
            guard let node = tree[next] else { continue }
            out.append(node)
            queue += tree.values.filter { $0.parentId == next }.sorted { $0.id < $1.id }.map(\.id)
        }
        return out
    }

    /* Whether `id` or a folder above it is in the trash. Under the lock. */
    func underTrash(_ id: String) -> Bool {
        var cursor: String? = id
        while let current = cursor, let node = tree[current] {
            if node.trashedAt != nil { return true }
            cursor = node.parentId
        }
        return false
    }

    /* The rotation, change-feed and leave routes; nil for anything else. */
    func rotationRoute(method: String, path: String, sent: [String: Any], query: [URLQueryItem]) -> (Int, Any)? {
        let f = family
        let parts = path.split(separator: "/").map(String.init)
        if method == "POST", path == "/api/groups/\(f.groupId)/leave" {
            return lock.withLock {
                if notMember { return (404, ["code": "not-member", "message": "You are not in this group."]) }
                rotations.leaves.append(sent["endsLapsed"] as? [String] ?? [])
                if let refusal = rotations.leaveRefusal { return refusal }
                // Left: from now on the server answers not-member and lists the family nowhere.
                notMember = true
                listed = false
                return (200, ["state": "left"])
            }
        }
        guard parts.count >= 4, parts[0] == "api", parts[1] == "drive" else { return nil }
        let rest = Array(parts.dropFirst(2))
        if method == "GET", rest.count == 3, rest[0] == "workspaces", rest[2] == "changes" {
            return lock.withLock {
                rotations.feedRequests += 1
                if rotations.feedRequests > 2000 { return (500, ["message": "Too many feed requests."]) }
                let since = Int(query.first { $0.name == "since" }?.value ?? "0") ?? 0
                let asked = Int(query.first { $0.name == "limit" }?.value ?? "500") ?? 500
                let limit = min(asked, rotations.changesPage ?? Int.max)
                // State, not a log: every row of the folder in change order, a page from `since`.
                let all = tree.values.filter { $0.workspaceId.lowercased() == rest[1].lowercased() }
                    .sorted { ($0.changeSeq ?? 0, $0.id) < ($1.changeSeq ?? 0, $1.id) }
                let page = Array(all.dropFirst(since).prefix(limit))
                let next = since + page.count
                return (200, ["changes": page.map { ["kind": "node", "changeSeq": $0.changeSeq ?? 0, "node": node(json: $0)] },
                              "resync": false, "nextCursor": next, "hasMore": next < all.count])
            }
        }
        guard rest.count == 4, rest[0] == "nodes", rest[2] == "rotation" else { return nil }
        let runRoot = rest[1]
        if method == "GET", rest[3] == "work" {
            return lock.withLock {
                guard var run = rotations.runs[runRoot], !run.finished else { return (404, ["code": "not-found", "message": "No rotation is running here."]) }
                let todo = subtree(runRoot).filter { !run.applied.contains($0.id) }
                if todo.isEmpty {
                    run.finished = true
                    rotations.runs[runRoot] = run
                }
                let batch = rotations.rotationBatch.map { Array(todo.prefix($0)) } ?? todo
                let work = batch.map { node -> [String: Any] in
                    var json = self.node(json: node)
                    json["depth"] = 0
                    json["versions"] = node.currentVersion.map { version -> [[String: Any]] in
                        [["id": version.id, "objectId": version.objectId, "contentSuite": version.contentSuite, "contentKeyEnvelope": version.contentKeyEnvelope,
                          "plaintextSize": NSNull(), "signer": version.signer.map { ["id": $0.id] } ?? NSNull(),
                          "signature": version.signature ?? NSNull(), "rekey": (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(version.rekey))) ?? NSNull()]]
                    } ?? []
                    json["shares"] = [Any]()
                    json["links"] = [Any]()
                    return json
                }
                return (200, ["rotation": ["nodeId": runRoot, "targetEpoch": run.target], "nodes": work,
                              "nextCursor": batch.count < todo.count ? "more" : NSNull(), "done": todo.isEmpty])
            }
        }
        guard method == "POST", rest[3] == "nodes" else { return nil }
        let wires = sent["nodes"] as? [[String: Any]] ?? []
        let (send, hook) = lock.withLock { () -> (Int, (@Sendable ([String]) -> Void)?) in
            rotations.sends += 1
            rotations.batches.append(wires.compactMap { $0["id"] as? String })
            if let held = rotations.holdSendWith, wires.contains(where: { $0["id"] as? String == held }) {
                rotations.holdSendWith = nil
                rotations.holding = true
            }
            return (rotations.sends, rotations.beforeRotationSend)
        }
        if lock.withLock({ rotations.failRotationSends.contains(send) }) { return (500, ["message": "The connection dropped"]) }
        hook?(wires.compactMap { $0["id"] as? String })
        return lock.withLock {
            guard let run = rotations.runs[runRoot] else { return (404, ["code": "not-found", "message": "No rotation is running here."]) }
            var results: [[String: Any]] = []
            for wire in wires {
                guard let id = wire["id"] as? String, let node = tree[id] else { continue }
                // Sent at a change order the server has moved past (another device's walk applied it): stale.
                if let seq = wire["changeSeq"] as? Int, seq != node.changeSeq {
                    results.append(["id": id, "status": "stale"])
                    continue
                }
                // Below the run's top: the parent re-keyed already, at the epoch the node was wrapped under. Each node on its own.
                if id != runRoot, let parentId = node.parentId, let parent = tree[parentId] {
                    if parent.keyEpoch < run.target {
                        results.append(["id": id, "status": "parent-not-ready"])
                        continue
                    }
                    if parent.keyEpoch != (wire["parentKeyEpoch"] as? NSNumber)?.uint64Value {
                        results.append(["id": id, "status": "stale"])
                        continue
                    }
                }
                let rotated = wire["rotated"] as? [String: Any]
                if rotated != nil { rotations.previousKeys["\(id)@\(node.keyEpoch)"] = keyOf(id) }
                change(id) { json in
                    if rotated != nil, json["prevKeyEnvelope"] == nil || json["prevKeyEnvelope"] is NSNull {
                        json["prevKeyEnvelope"] = node.keyEnvelope
                        json["prevKeyEpoch"] = node.keyEpoch
                        json["prevParentKeyEpoch"] = node.parentKeyEpoch
                    }
                    json["parentKeyEpoch"] = wire["parentKeyEpoch"]
                    json["keyEnvelope"] = wire["keyEnvelope"]
                    guard let rotated else { return }
                    json["keyEpoch"] = run.target
                    // A re-keyed record keeps its writer's origin (carried from an earlier walk, or the record as it was).
                    func origin(_ kept: RekeyView?, envelope: String, signer: String?, signature: String?, sent: [String: Any]) -> Any {
                        let origin: [String: Any] = kept.map { ["envelope": $0.origin.envelope, "signer": $0.origin.signer.map { ["id": $0.id] } ?? NSNull(),
                                                                "signature": $0.origin.signature] }
                            ?? ["envelope": envelope, "signer": signer.map { ["id": $0] } ?? NSNull(), "signature": signature ?? ""]
                        var out = origin
                        out["keyEnvelope"] = sent["originKeyEnvelope"]
                        return ["origin": out, "signature": sent["signature"] ?? ""]
                    }
                    if let sent = rotated["metadataRekey"] as? [String: Any] {
                        json["metadataRekey"] = origin(node.metadataRekey, envelope: node.metadataEnvelope, signer: node.metadataSigner?.id,
                                                       signature: node.metadataSignature, sent: sent)
                    } else {
                        json["metadataRekey"] = NSNull()
                    }
                    json["metadataEnvelope"] = rotated["metadataEnvelope"]
                    json["metadataSignature"] = rotated["metadataSignature"] is NSNull ? NSNull() : rotated["metadataSignature"]
                    json["metadataSigner"] = ["id": family.member.userId]
                    if let version = node.currentVersion, var current = json["currentVersion"] as? [String: Any],
                       let sentVersion = (rotated["versions"] as? [[String: Any]])?.first(where: { $0["id"] as? String == version.id }) {
                        if let rekey = sentVersion["rekey"] as? [String: Any] {
                            current["rekey"] = origin(version.rekey, envelope: version.contentKeyEnvelope, signer: version.signer?.id,
                                                      signature: version.signature, sent: rekey)
                        } else {
                            current["rekey"] = NSNull()
                        }
                        current["contentKeyEnvelope"] = sentVersion["contentKeyEnvelope"]
                        current["signature"] = sentVersion["signature"] is NSNull ? NSNull() : sentVersion["signature"]
                        current["signer"] = ["id": family.member.userId]
                        json["currentVersion"] = current
                    }
                }
                rotations.runs[runRoot]!.applied.insert(id)
                results.append(["id": id, "status": "ok"])
            }
            if rotations.loseRotationAnswers.contains(send) { return (500, ["message": "The connection dropped"]) }
            return (200, ["results": results])
        }
    }
}
