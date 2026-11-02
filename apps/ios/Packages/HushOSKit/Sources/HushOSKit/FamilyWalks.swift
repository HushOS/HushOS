import Foundation
import HushOSCore

/*
 * Members' due work (docs/groups-mobile-plan.md iOS 4), as the web's walks.ts and runRotation's
 * family case and Android's FamilyWalks: a key change a manager's member-list change left in a
 * family folder is walked by any member whose device saw it re-key the top folder
 * (FamilyArea.ownReasonToWalk), node by node through the core's rotate_node, never the start route.
 *
 * - Parent first: a batch never holds a node beside its parent (`deferChildren`); the children go
 *   in a later round, once the parent's new key is the server's.
 * - Writes never take a walk's pending keys: the folder's key lock (FamilyLocks.keys) is held from a
 *   batch's first fresh key until each is committed or dropped, and a new node's key or a move's
 *   re-wrap in that folder waits for it.
 * - A parent the walk needs that this vault hasn't opened (a resume, another device's batch first)
 *   is opened by listing it, or through the folder's change feed from its start with no page cap,
 *   so one under a folder in the trash is found too.
 * - The ledger commits only what the server applied (ok or already) and drops the rest; a node it
 *   sent is read again from the server. A batch that fails drops its keys, and the next walk sends
 *   those nodes again under fresh ones.
 * - `checkStop` (an expiring background task) is asked between batches and feed pages, never while
 *   keys are pending.
 */

/* The walk a device has its own reason to run: its folder, and the run route 25 names there. */
public struct WalkTarget: Sendable, Equatable, Hashable {
    public let workspaceId: String
    public let rotationId: String?
    public let nodeId: String
    public let targetEpoch: UInt64

    /* The run's identity: its id, or its top folder and target when the server gave none. */
    public var key: String { "\(workspaceId.lowercased()):" + (rotationId ?? "\(nodeId.lowercased())@\(targetEpoch)") }
}

public enum WalkOutcome: Sendable, Equatable {
    case walked
    /* Route 25 no longer names the run: another device finished it, or it was stopped. */
    case endedElsewhere
}

/* Why a walk stopped short, in the web's words. */
public struct WalkStopped: Error, LocalizedError, Equatable, Sendable {
    public let message: String
    public var errorDescription: String? { message }

    public static let couldNotFinish = WalkStopped(message: "The rotation could not finish. Try again.")
    public static let couldNotSign = WalkStopped(message: "The rotation could not sign what it sealed. Try again.")
    public static let shared = WalkStopped(message: "An item in this family folder has shares or links, which family folders don’t support, so its keys weren’t changed. The key change can finish once they’re stopped.")
    public static let notCarried = WalkStopped(message: "One item in this folder can’t take the new keys. A manager can move it to Trash and delete it forever, then the key change finishes.")
}

/*
 * A lock per family folder for the whole process, waited for without holding a thread: the app's
 * screens, the background task and the upload queue share it. `holding` runs its body on the
 * caller's actor.
 */
public final class FolderLocks: Sendable {
    private actor State {
        var held: Set<String> = []
        var waiting: [String: [CheckedContinuation<Void, Never>]] = [:]

        func acquire(_ key: String) async {
            guard held.contains(key) else {
                held.insert(key)
                return
            }
            await withCheckedContinuation { waiting[key, default: []].append($0) }
        }

        func release(_ key: String) {
            if var queue = waiting[key], !queue.isEmpty {
                // Handed on: the next in line holds it now.
                let next = queue.removeFirst()
                waiting[key] = queue.isEmpty ? nil : queue
                next.resume()
            } else {
                held.remove(key)
            }
        }

        func isFree(_ key: String) -> Bool { !held.contains(key) }
    }

    private let state = State()

    public init() {}

    func holding<T>(_ workspaceId: String, isolation: isolated (any Actor)? = #isolation, _ body: () async throws -> T) async rethrows -> T {
        let key = workspaceId.lowercased()
        await state.acquire(key)
        do {
            let value = try await body()
            await state.release(key)
            return value
        } catch {
            await state.release(key)
            throw error
        }
    }

    /* Whether nobody holds the folder's lock (tests: a stopped walk leaves none held). */
    public func isFree(_ workspaceId: String) async -> Bool { await state.isFree(workspaceId.lowercased()) }
}

public enum FamilyLocks {
    /* One walk per folder in the process: a second caller waits, then finds the run finished. */
    public static let walks = FolderLocks()
    /* A folder's keys while a walk's batch holds fresh ones pending (see the top of this file). */
    public static let keys = FolderLocks()
}

extension FamilySync {
    /*
     * Walks `target` to its end, unless route 25 no longer names it (another device finished it).
     * `progress`: the nodes this walk re-keyed so far. Throws why it stopped short.
     */
    public func walk(_ groupId: String, _ target: WalkTarget, progress: @escaping @Sendable (Int) -> Void = { _ in },
                     checkStop: @escaping @Sendable () throws -> Void = {}) async throws -> WalkOutcome {
        try await FamilyLocks.walks.holding(target.workspaceId) {
            try checkStop()
            guard Self.stillRunning(try await api.spaces(), groupId: groupId, target: target) else { return .endedElsewhere }
            do {
                try await vault.walkFamilyFolder(target, progress: progress, checkStop: checkStop)
                return .walked
            } catch DriveAPIError.notFound(let words) {
                // "No rotation is running here": finished meanwhile, unless route 25 still names it.
                if !Self.stillRunning(try await api.spaces(), groupId: groupId, target: target) { return .endedElsewhere }
                throw DriveAPIError.notFound(words)
            }
        }
    }

    /* Whether route 25 still names the run in the family's folder. */
    static func stillRunning(_ spaces: [SpaceList.Entry], groupId: String, target: WalkTarget) -> Bool {
        let areas = spaces.filter { $0.space.kind == "group" && $0.space.groupId?.lowercased() == groupId.lowercased() }.flatMap(\.areas)
        guard let area = areas.first(where: { $0.workspaceId.lowercased() == target.workspaceId.lowercased() }), let rotation = area.rotation else {
            return false
        }
        if let id = target.rotationId { return rotation.id == id }
        return rotation.nodeId.lowercased() == target.nodeId.lowercased() && rotation.targetEpoch == target.targetEpoch
    }

    /*
     * Whether a failure is worth trying again by itself: no answer, a timeout, too many requests or a
     * server error, from either the groups or the drive routes. Anything else waits for a change.
     */
    public static func transient(_ error: Error) -> Bool {
        if unanswered(error) { return true }
        if let error = error as? GroupsAPIError { return [408, 429].contains(error.status) || error.status >= 500 }
        if case DriveAPIError.server(let status, _) = error { return [408, 429].contains(status) || status >= 500 }
        return false
    }
}

extension Vault {
    /*
     * One walk of `target`'s run to its end, as a write into the family folder (its entry decision is
     * the final gate's): under the ledger's keys only, the folder's write rules checked at every
     * batch, every batch through DriveAPI's final gate.
     */
    func walkFamilyFolder(_ target: WalkTarget, progress: @Sendable (Int) -> Void, checkStop: @Sendable () throws -> Void) async throws {
        try await writing {
            let workspaceId = target.workspaceId.lowercased()
            let rootId = target.nodeId
            let epoch = target.targetEpoch
            guard try familyTarget(workspaceId) else { throw FamilyFailure(message: FamilyWords.couldntCheckKeys) }
            let seed = try await identityKeys().signingSeed
            // The top folder at the target, through the ledger.
            _ = try await listChildren(of: rootId, in: workspaceId)
            var cursor: String?
            var idle = 0
            var done = 0
            var shared = false
            var notCarried = false
            while true {
                try checkStop()
                // Let go of meanwhile (a refusal, a fork, a removal): stops here, never under keys it no longer holds.
                _ = try familyTarget(workspaceId)
                let work = try await api.rotationWork(workspaceId: workspaceId, nodeId: rootId, after: cursor)
                if work.done { break }
                guard work.rotation.targetEpoch == epoch else { throw WalkStopped.couldNotFinish }
                if work.nodes.isEmpty {
                    cursor = nil
                    idle += 1
                    if idle > 3 { throw Self.stuck(shared: shared, notCarried: notCarried) }
                    continue
                }
                guard work.nodes.allSatisfy({ $0.node.workspaceId.lowercased() == workspaceId }) else {
                    throw DriveAPIError.server(502, "HushOS answered with nodes of another drive.")
                }
                // Each parent the batch is wrapped under, at the target, before any of its children is re-keyed.
                let inWork = Set(work.nodes.map { $0.node.id.lowercased() })
                for parent in Set(work.nodes.compactMap { $0.node.parentId?.lowercased() }).sorted()
                    where !inWork.contains(parent) && areaLedger.nodeKey(workspaceId: workspaceId, nodeId: parent)?.epoch != epoch {
                    try await openWalkParent(parent, in: workspaceId, checkStop: checkStop)
                }
                let unshared = work.nodes.filter { $0.shares.isEmpty && $0.links.isEmpty }
                if unshared.count < work.nodes.count { shared = true }
                let sending = deferChildren(unshared)
                let kept = try await FamilyLocks.keys.holding(workspaceId) {
                    try await sendBatch(sending, rootId: rootId, epoch: epoch, workspaceId: workspaceId, seed: seed,
                                        notCarried: &notCarried, shared: &shared)
                }
                done += kept.count
                progress(done)
                idle = kept.isEmpty ? idle + 1 : 0
                if idle > 3 { throw Self.stuck(shared: shared, notCarried: notCarried) }
                // Anything refused or held back starts again from the top, so parents come first.
                cursor = kept.count == work.nodes.count ? work.nextCursor : nil
            }
        }
    }

    static func stuck(shared: Bool, notCarried: Bool) -> WalkStopped {
        if shared { return .shared }
        if notCarried { return .notCarried }
        return .couldNotFinish
    }

    /*
     * One batch, under the folder's key lock: fresh keys made pending by the core, the batch sent,
     * then each committed if the server applied it and dropped if not, whatever happened in between.
     * The ids the server kept (ok or already).
     */
    private func sendBatch(_ sending: [RotationWorkNode], rootId: String, epoch: UInt64, workspaceId: String, seed: Data,
                           notCarried: inout Bool, shared: inout Bool) async throws -> Set<String> {
        var made: [String] = []
        var kept: Set<String> = []
        var sent = false
        defer {
            let landed = made.filter { kept.contains($0.lowercased()) }
            _ = areaLedger.rotateCommit(workspaceId: workspaceId, nodeIds: landed)
            _ = areaLedger.rotateDrop(workspaceId: workspaceId, nodeIds: made.filter { !kept.contains($0.lowercased()) })
            // What was sent is read again from the server, through the ledger at the key it applied.
            if sent { forgetRows(made, in: workspaceId) }
        }
        var batch: [[String: Any]] = []
        for entry in sending {
            let rotated: RotatedNode
            do {
                rotated = try areaLedger.rotateNode(workspaceId: workspaceId, node: Self.rotating(entry, rootId: rootId, epoch: epoch, workspaceId: workspaceId),
                                                    targetEpoch: epoch, signingSeed: seed)
            } catch let error as CoreError {
                let message = FamilyWords.message(of: error)
                if message.hasPrefix("This item was added under a key the key change replaces") { notCarried = true }
                if message.hasPrefix("This item has shares or links") { shared = true }
                continue
            }
            made.append(entry.node.id)
            if !rotated.rewrap, let metadata = rotated.metadata, metadata.signature == nil, metadata.rekey == nil { throw WalkStopped.couldNotSign }
            batch.append(Self.wire(entry, rotated, rootId: rootId, epoch: epoch))
        }
        guard !batch.isEmpty else { return [] }
        // The folder's write rules as they stand now, right before the send (DriveAPI's final gate checks again).
        _ = try familyTarget(workspaceId)
        sent = true
        let results = try await api.rotateNodes(workspaceId: workspaceId, nodeId: rootId, nodes: batch)
        kept = Set(results.filter { $0.status == "ok" || $0.status == "already" }.map { $0.id.lowercased() })
        return kept
    }

    /* Rows a walk sent: read again from the server, so nothing answers from the key before. */
    private func forgetRows(_ ids: [String], in workspaceId: String) {
        for id in ids {
            let ref = NodeRef(workspaceId: workspaceId, nodeId: id)
            opened[ref] = nil
            nodeKeys[ref] = nil
            ledgerOpened.remove(ref)
        }
    }

    /*
     * A parent the walk needs at the target that this vault hasn't opened (a resume, or another
     * device's batch landed first): listed, or, when a listing refuses it (in or under the trash),
     * found with every folder above it through the folder's change feed, read from its start with no
     * page cap, and opened from the top down. A row that won't open leaves its children to wait.
     */
    func openWalkParent(_ parentId: String, in workspaceId: String, checkStop: @Sendable () throws -> Void) async throws {
        do {
            _ = try await listChildren(of: parentId, in: workspaceId)
            return
        } catch {
            if case DriveAPIError.notAuthenticated = error { throw error }
            if FamilySync.unanswered(error) { throw error }
        }
        var rows: [String: NodeView] = [:]
        func line() -> [NodeView]? {
            var out: [NodeView] = []
            var id = parentId.lowercased()
            while out.count <= rows.count {
                guard let row = rows[id] else { return nil }
                out.append(row)
                guard let up = row.parentId?.lowercased(), up != workspaceId.lowercased() else { break }
                // A folder whose own parent the ledger holds at the epoch it was wrapped under: the line opens from there.
                if areaLedger.nodeKey(workspaceId: workspaceId, nodeId: up)?.epoch == row.parentKeyEpoch { break }
                id = up
            }
            return out.reversed()
        }
        var cursor = 0
        while true {
            try checkStop()
            let page: ChangeFeed
            do {
                page = try await api.changes(workspaceId: workspaceId, since: cursor)
            } catch {
                if case DriveAPIError.notAuthenticated = error { throw error }
                if FamilySync.unanswered(error) { throw error }
                return
            }
            for change in page.changes {
                if let node = change.node, node.workspaceId.lowercased() == workspaceId.lowercased() { rows[node.id.lowercased()] = node }
            }
            if line() != nil || !page.hasMore || page.nextCursor <= cursor { break }
            cursor = page.nextCursor
        }
        for row in line() ?? [] { _ = try? open(row, replacing: true) }
    }

    /* A work node as the core re-keys it (RotatingNode). */
    static func rotating(_ entry: RotationWorkNode, rootId: String, epoch: UInt64, workspaceId: String) -> RotatingNode {
        let node = entry.node
        let root = node.id.lowercased() == rootId.lowercased()
        return RotatingNode(
            nodeId: node.id, parentId: node.parentId ?? workspaceId, parentKeyEpoch: root ? node.parentKeyEpoch : epoch,
            keyEpoch: node.keyEpoch, wrappedParentKeyEpoch: node.parentKeyEpoch,
            keyEnvelope: (try? base64urlDecode(value: node.keyEnvelope)) ?? Data(), kind: node.isFolder ? .folder : .file,
            metadataVersion: node.metadataVersion, metadataEnvelope: (try? base64urlDecode(value: node.metadataEnvelope)) ?? Data(),
            metadataSigner: node.metadataSigner?.id, metadataSignature: FamilySync.signature(node.metadataSignature),
            metadataRekey: FamilySync.rekey(node.metadataRekey),
            versions: entry.versions.map { version in
                RotatingVersion(versionId: version.id, objectId: version.objectId, contentSuite: version.contentSuite,
                                envelope: (try? base64urlDecode(value: version.contentKeyEnvelope)) ?? Data(), signer: version.signer?.id,
                                signature: FamilySync.signature(version.signature), rekey: FamilySync.rekey(version.rekey))
            },
            shareIds: entry.shares.map(\.id), linkIds: entry.links.map(\.id)
        )
    }

    /* One element of a batch's `nodes`, as runRotation's family case sends it. */
    static func wire(_ entry: RotationWorkNode, _ rotated: RotatedNode, rootId: String, epoch: UInt64) -> [String: Any] {
        let node = entry.node
        let root = node.id.lowercased() == rootId.lowercased()
        var out: [String: Any] = ["id": node.id, "changeSeq": node.changeSeq ?? 0, "parentKeyEpoch": root ? node.parentKeyEpoch : epoch,
                                  "keyEnvelope": base64urlEncode(bytes: rotated.keyEnvelope)]
        func rekey(_ value: RekeyOut?) -> Any {
            value.map { ["originKeyEnvelope": base64urlEncode(bytes: $0.originKeyEnvelope), "signature": base64urlEncode(bytes: $0.signature)] } ?? NSNull()
        }
        guard !rotated.rewrap, let metadata = rotated.metadata else {
            out["rotated"] = NSNull()
            return out
        }
        var sealed: [String: Any] = [
            "metadataEnvelope": base64urlEncode(bytes: metadata.envelope),
            "metadataSignature": metadata.signature.map { base64urlEncode(bytes: $0) } ?? NSNull(),
            "metadataRekey": rekey(metadata.rekey),
            "versions": rotated.versions.map { version -> [String: Any] in
                var out: [String: Any] = ["id": version.versionId, "contentKeyEnvelope": base64urlEncode(bytes: version.record.envelope),
                                          "signature": version.record.signature.map { base64urlEncode(bytes: $0) } ?? NSNull(),
                                          "rekey": rekey(version.record.rekey)]
                if version.record.dropOrigin { out["dropOrigin"] = true }
                return out
            },
            "shares": [Any](), "links": [Any](), "unsealableLinks": [Any](),
        ]
        if metadata.dropOrigin { sealed["metadataDropOrigin"] = true }
        out["rotated"] = sealed
        return out
    }
}
