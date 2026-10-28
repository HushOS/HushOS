import Foundation
import HushOSCore

/*
 * Writing to the Drive: folders, renames, moves, trash, restore and uploads.
 * Every envelope is sealed in the Rust core exactly as the web app seals it;
 * the server only ever sees ciphertext and the shape of the tree. In a family
 * folder every key a write wraps, seals under or re-wraps comes from the area
 * ledger (`new_node_key`, `writable_node_key`, `rewrap_node`), which refuses a
 * key not rooted at the folder's current key (KEY_CHANGE_PENDING), and records
 * signed again are judged by the family's member list (`copy_form`).
 */
extension Vault {
    /*
     * A new id for what is made in `workspace`, and the seed it is derived from: the create
     * sends both, and the server refuses an id the seed doesn't derive for that workspace.
     */
    func mint(_ kind: IdKind, in workspace: String) throws -> NewId { try HushOSCore.newId(kind: kind, scopeId: workspace) }

    /*
     * A new folder; `signing` is `.own` for one this person makes, and a copy's verdict for a copied folder's name.
     * `attributes` are a copied folder's source's, carried whole (keys this app doesn't know included); none for a new one.
     */
    public func createFolder(in parentId: String, name: String, signing: Signing = .own, attributes: [String: String] = [:]) async throws -> Opened {
        _ = try await loadWorkspace()
        let parent = try await resolve(parentId)
        let family = try familyTarget(parent.node.workspaceId)
        // Shared folders belong to the granter's workspace; an editor writes there.
        let workspace = Target(workspaceId: parent.node.workspaceId)
        let epochs = try await api.allocateEpochs(workspaceId: workspace.workspaceId, count: 1)
        let made = try mint(.node, in: workspace.workspaceId)
        let id = made.id
        let (key, wrapped) = try newKey(id, under: parent, keyEpoch: epochs.from, family: family)
        do {
            let metadata = NodeMetadata(name: name, mime: nil, size: nil, modified: nil, attributes: attributes)
            let sealed = try metadataSeal(ctx: MetadataContext(workspaceId: workspace.workspaceId, nodeId: id, metadataVersion: 1), nodeKey: key, metadata: metadata)
            let signature = try await signMetadata(workspaceId: workspace.workspaceId, nodeId: id, kind: .folder, version: 1, envelope: sealed, signing: signing)
            let nodes = try await api.createFolders(workspaceId: workspace.workspaceId, folders: [[
                "id": id, "idSeed": made.seed, "parentId": parent.node.id, "keyEpoch": epochs.from, "parentKeyEpoch": parent.node.keyEpoch,
                "keyEnvelope": base64urlEncode(bytes: wrapped), "metadataEnvelope": base64urlEncode(bytes: sealed), "metadataSignature": signature,
            ]])
            guard let node = nodes.first else { throw DriveAPIError.server(500, "No folder returned") }
            return try adopt(node, nodeKey: key, metadata: metadata, in: workspace.workspaceId)
        } catch {
            // The server didn't take it: the key the ledger made for it goes (the web's forgetNodeKey).
            if family { areaLedger.forgetNodeKey(workspaceId: workspace.workspaceId, nodeId: id) }
            throw error
        }
    }

    /*
     * A new node's key and its envelope under `parent`: in a family folder made and wrapped by the
     * ledger, never under a parent key it doesn't hold rooted at the folder's write version; in
     * any other drive under the parent's key as this process opened it.
     */
    private func newKey(_ id: String, under parent: Opened, keyEpoch: UInt64, family: Bool) throws -> (key: Data, envelope: Data) {
        let workspaceId = parent.node.workspaceId
        if family {
            let made = try areaLedger.newNodeKey(workspaceId: workspaceId, nodeId: id, parentId: parent.id, parentKeyEpoch: parent.node.keyEpoch, keyEpoch: keyEpoch)
            return (made.key, made.keyEnvelope)
        }
        guard let parentKey = nodeKey(of: parent) else { throw DriveAPIError.server(500, "Open the containing folder first.") }
        let key = try randomBytes(length: 32)
        let ctx = NodeKeyContext(workspaceId: workspaceId, nodeId: id, parentId: parent.id, parentKeyEpoch: parent.node.keyEpoch, keyEpoch: keyEpoch)
        return (key, try nodeWrap(ctx: ctx, parentKey: parentKey, nodeKey: key))
    }

    /* The form a record written again in place is signed with: by the family's member list in a family folder, else the trust set. */
    private func priorMetadata(of node: NodeView, family: Bool) async throws -> Integrity {
        if family { return try await familyPrior(FamilySync.metadataRecord(of: node), in: node.workspaceId, copying: false) }
        return try await changeSigners().metadata(of: node)
    }

    public func rename(_ nodeId: String, to name: String) async throws -> Opened {
        let item = try await resolve(nodeId)
        let family = try familyTarget(item.node.workspaceId)
        let key: Data
        if family {
            key = try writableKey(of: item)
        } else {
            guard let opened = nodeKey(of: item) else { throw DriveAPIError.server(500, "Node not opened") }
            key = opened
        }
        // Everything but the name as it was, attributes this app doesn't know included.
        let metadata = NodeMetadata(name: name, mime: item.metadata.mime, size: item.metadata.size, modified: item.metadata.modified,
                                    attributes: item.metadata.attributes)
        let sealed = try metadataSeal(
            ctx: MetadataContext(workspaceId: item.node.workspaceId, nodeId: nodeId, metadataVersion: item.node.metadataVersion + 1),
            nodeKey: key, metadata: metadata
        )
        // The new name goes out beside the record's other fields (type, size, date), which this signature vouches for
        // too: ordinary only when the record verified as it was, re-sealed otherwise, and nothing sent without the check.
        let prior = try await priorMetadata(of: item.node, family: family)
        let signature = try await signMetadata(workspaceId: item.node.workspaceId, nodeId: nodeId, kind: item.isFolder ? .folder : .file,
                                               version: item.node.metadataVersion + 1, envelope: sealed, signing: .after(prior))
        let node = try await api.rename(
            nodeId: nodeId, workspaceId: item.node.workspaceId, metadataVersion: item.node.metadataVersion,
            keyEpoch: item.node.keyEpoch, metadataEnvelope: base64urlEncode(bytes: sealed), metadataSignature: signature
        )
        return try adopt(node, nodeKey: key, metadata: metadata, in: item.node.workspaceId)
    }

    private func rewrap(_ item: Opened, under parent: Opened) throws -> String {
        // One drive only: the server moves within a workspace, and a key is wrapped under a parent of its own.
        guard item.node.workspaceId.lowercased() == parent.node.workspaceId.lowercased() else {
            throw DriveAPIError.server(400, "Items can only move within one drive.")
        }
        // A family folder's item is re-wrapped by the ledger, under a parent rooted at the folder's current key only.
        if try familyTarget(item.node.workspaceId) {
            return base64urlEncode(bytes: try areaLedger.rewrapNode(workspaceId: item.node.workspaceId, nodeId: item.id, parentId: parent.id,
                                                                    parentKeyEpoch: parent.node.keyEpoch, keyEpoch: item.node.keyEpoch))
        }
        guard let key = nodeKey(of: item), let parentKey = nodeKey(of: parent) else { throw DriveAPIError.server(500, "Node not opened") }
        let ctx = NodeKeyContext(workspaceId: item.node.workspaceId, nodeId: item.id, parentId: parent.id, parentKeyEpoch: parent.node.keyEpoch, keyEpoch: item.node.keyEpoch)
        return base64urlEncode(bytes: try nodeWrap(ctx: ctx, parentKey: parentKey, nodeKey: key))
    }

    /* Whether moving `nodeId` under `parentId` crosses spaces (another workspace: a family folder, someone's share, one's own files). */
    public func movesAcross(_ nodeId: String, to parentId: String) async throws -> Bool {
        let item = try await resolve(nodeId)
        let parent = try await resolve(parentId)
        return item.node.workspaceId.lowercased() != parent.node.workspaceId.lowercased()
    }

    /*
     * Move, wherever it goes: within one space the item is re-parented (one key re-wrapped, through
     * the ledger in a family folder); across spaces (a family folder and one's own files, either
     * way, or someone's share) the server can't move it, since it copies and moves within one
     * workspace only, so it is uploaded again under the destination's keys and the original goes
     * to the Trash. Older versions, and the original's writer signature, stay behind
     * (docs/families-shared-pool.md 3.8; the server's pool-neutral `moveOf` isn't built yet).
     */
    public func relocate(_ nodeId: String, to parentId: String, progress: @Sendable (Double) -> Void = { _ in }) async throws -> (item: Opened, across: Bool) {
        guard try await movesAcross(nodeId, to: parentId) else { return (try await move(nodeId, to: parentId), false) }
        // A family folder that may not be written now gives nothing up: checked before anything is copied out of it.
        let source = try await resolve(nodeId)
        _ = try familyTarget(source.node.workspaceId)
        let copied = try await copyAcross(nodeId, to: parentId, progress: progress)
        do {
            try await trash(nodeId)
        } catch {
            // The copy landed: said as such, never as a move that failed and changed nothing.
            let why = ErrorWords.say(error, otherwise: "Try again.") ?? "Try again."
            throw DriveAPIError.server(409, "Copied, but the original couldn’t be moved to the Trash. \(why)")
        }
        return (copied, true)
    }

    public func move(_ nodeId: String, to parentId: String) async throws -> Opened {
        let item = try await resolve(nodeId)
        let parent = try await resolve(parentId)
        // Within one family folder through the ledger (see `rewrap`); across spaces the store copies and trashes instead.
        _ = try familyTarget(item.node.workspaceId)
        _ = try familyTarget(parent.node.workspaceId)
        guard let key = nodeKey(of: item) else { throw DriveAPIError.server(500, "Node not opened") }
        let node = try await api.move(
            nodeId: nodeId, workspaceId: item.node.workspaceId, parentId: parent.id,
            parentKeyEpoch: parent.node.keyEpoch, keyEnvelope: try rewrap(item, under: parent)
        )
        return try adopt(node, nodeKey: key, metadata: item.metadata, in: item.node.workspaceId)
    }

    /*
     * A copy under `parentId`: the server keeps the object and its chunks; only
     * the envelopes change hands, resealed here under a fresh node key. A folder
     * is copied node by node, since the server holds no key to rewrap a subtree.
     * Each record is checked as it was first and signed by that verdict (see
     * `Signing`): a copy never makes a record this person vouches for out of one
     * they couldn't confirm. Without whom to trust, nothing is copied.
     */
    public func copy(_ nodeId: String, to parentId: String, name: String? = nil, progress: @Sendable (Int) -> Void = { _ in }) async throws -> Opened {
        let source = try await resolve(nodeId)
        let parent = try await resolve(parentId)
        // A family folder's records are judged by its member list, not the personal trust set; the server copies
        // within one workspace, so a family folder's item is copied in place only within that folder.
        let sourceFamily = isFamilyWorkspace(source.node.workspaceId)
        let family = try familyTarget(parent.node.workspaceId)
        if sourceFamily || family, source.node.workspaceId.lowercased() != parent.node.workspaceId.lowercased() {
            throw DriveAPIError.server(400, "Items can only be copied within one drive here.")
        }
        let trusted: TrustedSigners? = family ? nil : try await copySigners()
        func prior(_ record: ServedRecord, _ personal: (TrustedSigners) -> Integrity) async throws -> Integrity {
            if let trusted { return personal(trusted) }
            return try await familyPrior(record, in: source.node.workspaceId, copying: true)
        }
        _ = try await loadWorkspace()
        let workspace = Target(workspaceId: parent.node.workspaceId)
        let newName = try checkName(name: name ?? source.name)
        var done = 0
        if source.isFolder {
            let made = try await createFolder(in: parent.id, name: newName, signing: .copy(try await prior(FamilySync.metadataRecord(of: source.node)) { $0.metadata(of: source.node) }),
                                              attributes: source.metadata.attributes)
            done += 1
            progress(done)
            for child in try await children(of: source.id) {
                _ = try await copy(child.id, to: made.id) { _ in }
                done += 1
                progress(done)
            }
            return made
        }
        guard let version = source.node.currentVersion else { throw DriveAPIError.notFound("This file has no content yet.") }
        let opened = try openVersion(source)
        let epochs = try await api.allocateEpochs(workspaceId: workspace.workspaceId, count: 1)
        // The object stays the source's (the server shares it), so only the node and version are new.
        let made = try mint(.node, in: workspace.workspaceId)
        let madeVersion = try mint(.version, in: workspace.workspaceId)
        let (id, versionId) = (made.id, madeVersion.id)
        let metadataPrior = try await prior(FamilySync.metadataRecord(of: source.node)) { $0.metadata(of: source.node) }
        let versionPrior = try await prior(FamilySync.versionRecord(version, of: source.node)) { $0.version(version, of: source.node) }
        let (key, keyEnvelope) = try newKey(id, under: parent, keyEpoch: epochs.from, family: family)
        defer { if family, self.opened[NodeRef(workspaceId: workspace.workspaceId, nodeId: id)] == nil { areaLedger.forgetNodeKey(workspaceId: workspace.workspaceId, nodeId: id) } }
        let metadata = NodeMetadata(name: newName, mime: source.metadata.mime, size: source.metadata.size, modified: source.metadata.modified,
                                    attributes: source.metadata.attributes)
        let metadataEnvelope = try metadataSeal(ctx: MetadataContext(workspaceId: workspace.workspaceId, nodeId: id, metadataVersion: 1), nodeKey: key, metadata: metadata)
        let contentKeyEnvelope = try versionReseal(
            ctx: VersionContext(workspaceId: workspace.workspaceId, nodeId: id, versionId: versionId, objectId: version.objectId),
            suite: version.contentSuite, nodeKey: key,
            content: ContentKey(key: opened.content.key, plaintextSize: opened.content.plaintextSize, thumbnailBytes: opened.content.thumbnailBytes)
        )
        // Signed where they land: the copy's node and version, over the source's object and its suite, by the source's verdicts.
        let metadataSignature = try await signMetadata(workspaceId: workspace.workspaceId, nodeId: id, kind: .file, version: 1, envelope: metadataEnvelope,
                                                       signing: .copy(metadataPrior))
        let versionSignature = try await signVersion(workspaceId: workspace.workspaceId, nodeId: id, versionId: versionId, objectId: version.objectId,
                                                     suite: version.contentSuite, envelope: contentKeyEnvelope,
                                                     signing: .copy(versionPrior))
        let node = try await api.copy(sourceNodeId: source.id, workspaceId: workspace.workspaceId, body: [
            "sourceVersionId": version.id,
            "node": ["id": id, "idSeed": made.seed, "parentId": parent.id, "parentKeyEpoch": parent.node.keyEpoch, "keyEpoch": epochs.from,
                     "keyEnvelope": base64urlEncode(bytes: keyEnvelope), "metadataEnvelope": base64urlEncode(bytes: metadataEnvelope),
                     "metadataSignature": metadataSignature],
            "versionId": versionId, "versionIdSeed": madeVersion.seed,
            "contentKeyEnvelope": base64urlEncode(bytes: contentKeyEnvelope),
            "versionSignature": versionSignature,
        ])
        progress(done + 1)
        return try adopt(node, nodeKey: key, metadata: metadata, in: workspace.workspaceId)
    }

    public func trash(_ nodeId: String) async throws {
        try await sendTrash(nodeId)
        forget(nodeId)
    }

    /* The single route's trash, without forgetting the row: the caller forgets it once the lists let go. */
    private func sendTrash(_ nodeId: String) async throws {
        let item = try await resolve(nodeId)
        // Nothing is sealed, but a family folder takes it only while this device may write there.
        _ = try familyTarget(item.node.workspaceId)
        _ = try await api.trash(nodeId: nodeId, workspaceId: item.node.workspaceId)
    }

    /*
     * Move to Trash for many, one outcome per id in order, `moved` told of each id as its request's
     * answer lands: the one place a selection reaches the server. The batch route, 200 ids a
     * request and a request per workspace (TrashBatch.trashInBatches); one request an item on a
     * server without it. A family folder takes it only while this device may write there.
     */
    public func trashMany(_ ids: [String], moved: @escaping @Sendable ([String]) async -> Void = { _ in }) async -> [Result<TrashBatch.Move, Error>] {
        var items: [(id: String, workspace: String)] = []
        for id in ids {
            let workspace: String
            if let known = opened[id] { workspace = known.node.workspaceId }
            else if let found = try? await resolve(id) { workspace = found.node.workspaceId }
            else { workspace = (try? await loadWorkspace().workspaceId) ?? "" }
            items.append((id, workspace))
        }
        // The folders each sits in, as far as this device knows, read before anything is forgotten.
        let chains = Dictionary(ids.map { id in (id, opened[id].map { ancestorIds(of: $0) } ?? []) }, uniquingKeysWith: { a, _ in a })
        return await TrashBatch.trashInBatches(
            items,
            send: { workspace, chunk in try await self.sendTrashBatch(workspace, chunk) },
            // One request an item: each row leaves the lists, then this device forgets it, as for a batch.
            sequential: { chunk in
                await TrashBatch.trashEach(chunk, trash: { id in try await self.sendTrash(id) }, moved: { id in await moved([id]); await self.forget([id]) })
                    .map { $0.map { TrashBatch.Move.trashed } }
            },
            ancestors: { chains[$0] ?? [] },
            // Called after `moved`: the row leaves the lists first, then this device forgets it.
            forget: { ids in await self.forget(ids) },
            moved: { landed in await moved(landed.map(\.id)) }
        )
    }

    private func sendTrashBatch(_ workspace: String, _ ids: [String]) async throws -> [TrashBatch.Answer] {
        _ = try familyTarget(workspace)
        return try await api.trashBatch(workspaceId: workspace, ids: ids)
    }

    /* Forgets each of these rows: what a batch moved, once the lists let go of them. */
    func forget(_ ids: [String]) { for id in ids { forget(id) } }

    /*
     * Undo for trashMany: the items back in place through the batch route (folders before what is
     * in them, `parent-trashed` tried again once the rest landed), or one request an item on a
     * server without it. One outcome per item in order, the restored row on success.
     */
    public func restoreMany(_ items: [Opened]) async -> [Result<Opened, Error>] {
        let given = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let depths = Dictionary(items.map { item in (item.id, ancestorIds(of: item).filter { given[$0] != nil }.count) }, uniquingKeysWith: { a, _ in a })
        let outcomes = await TrashBatch.restoreInBatches(
            items.map { ($0.id, $0.node.workspaceId) },
            depth: { depths[$0] ?? 0 },
            send: { workspace, chunk in try await self.sendRestoreBatch(workspace, chunk, given: given) },
            sequential: { chunk in
                var results: [Result<Void, Error>] = []
                for id in chunk {
                    do { _ = try await self.restore(given[id]!, parentTrashed: false); results.append(.success(())) } catch { results.append(.failure(error)) }
                }
                return results
            }
        )
        return zip(items, outcomes).map { item, outcome in
            outcome.map { opened[item.id] ?? item }
        }
    }

    private func sendRestoreBatch(_ workspace: String, _ ids: [String], given: [String: Opened]) async throws -> [TrashBatch.Answer] {
        if isFamilyWorkspace(workspace) { _ = try familyTarget(workspace) }
        let answers = try await api.restoreBatch(workspaceId: workspace, ids: ids)
        for case .restored(let id, let changeSeq) in answers {
            guard let item = given[id], let key = nodeKey(of: item) else { continue }
            _ = try? adopt(item.node.restored(changeSeq: changeSeq), nodeKey: key, metadata: item.metadata, in: workspace)
        }
        return answers
    }

    /* The folders above an item, nearest first, as far as this device knows them. */
    func ancestorIds(of item: Opened) -> [String] {
        var chain: [String] = []
        var cursor = item.node.parentId
        while let current = cursor, chain.count < 256 {
            chain.append(current)
            cursor = opened[current]?.node.parentId ?? parents[current]
        }
        return chain
    }

    /* Back where it was, or under the root when its old folder is in the trash too. */
    public func restore(_ item: Opened, parentTrashed: Bool) async throws -> Opened {
        // In a family folder only back where it was (a trash's Undo): under the top folder would re-wrap under the family's root.
        if isFamilyWorkspace(item.node.workspaceId) {
            if parentTrashed { throw FamilyWriteError.unavailable }
            _ = try familyTarget(item.node.workspaceId)
        }
        guard let key = nodeKey(of: item) else { throw DriveAPIError.server(500, "Node not opened") }
        var toRoot: (UInt64, String)? = nil
        if parentTrashed {
            let root = try await resolve(try rootId())
            toRoot = (root.node.keyEpoch, try rewrap(item, under: root))
        }
        let node = try await api.restore(nodeId: item.id, workspaceId: item.node.workspaceId, toRoot: toRoot)
        return try adopt(node, nodeKey: key, metadata: item.metadata, in: item.node.workspaceId)
    }

    public func purge(_ nodeId: String) async throws {
        let workspace = try await loadWorkspace()
        try await api.purge(nodeId: nodeId, workspaceId: workspace.workspaceId)
        forget(nodeId)
    }

    public func emptyTrash() async throws -> EmptyTrashResult {
        try await api.emptyTrash(workspaceId: try workspaceId())
    }

    /* What fills the space beside the files: the trash and earlier versions, as the server counts them. */
    public func storageBreakdown() async throws -> StorageBreakdown {
        try await api.storage(workspaceId: try workspaceId())
    }

    public func discardEarlierVersions() async throws -> EmptyTrashResult {
        try await api.discardSuperseded(workspaceId: try workspaceId())
    }

    public func restoreVersion(_ version: VersionListView, of nodeId: String) async throws -> Opened {
        let item = try await resolve(nodeId)
        try refuseFamilyWrite(item.node.workspaceId)
        guard let key = nodeKey(of: item) else { throw DriveAPIError.server(500, "Node not opened") }
        let node = try await api.restoreVersion(version.id, workspaceId: item.node.workspaceId)
        return try adopt(node, nodeKey: key, metadata: item.metadata, in: item.node.workspaceId)
    }

    /*
     * A file's bytes, as a new node under `parentId` or as a new version of
     * `replacing`. Chunks are read from the file one at a time, encrypted here
     * and PUT to the store; a thumbnail, when given, rides after the last chunk.
     */
    /* What an upload settles before its first byte: the node (new, or the one replaced), the sealed version, the server's upload. */
    private struct Begun {
        let workspaceId: String
        let uploadId: String
        let nodeId: String
        let parentId: String
        let nodeKey: Data
        let content: Content
        let chunkCount: UInt64
        let chunkBytes: UInt64
        let plaintextSize: UInt64
        let urls: [Int: PartUrl]
        /* The metadata to show once it lands: a replacement's own, with the new size and date. */
        let final: NodeMetadata
        let replacing: Bool
        /* What a replacement's name record may be re-signed against once it lands (`Landing`). */
        let landing: Landing?
    }

    /*
     * A new version as begun: its own version id, and the name record it replaces (the metadata
     * version the file had). A completion answers with the node as it is when the answer is made,
     * which for a repeated completion (the first answer lost, or the app gone before it saved) may be
     * after another member renamed the file or put a newer version on it. The name record is
     * re-signed only while this version is current and the record is still the one replaced.
     */
    public struct Landing: Codable, Sendable, Equatable {
        public let versionId: String
        public let metadataVersion: UInt64
        public init(versionId: String, metadataVersion: UInt64) {
            self.versionId = versionId
            self.metadataVersion = metadataVersion
        }

        func holds(_ node: NodeView) -> Bool { node.currentVersion?.id == versionId && node.metadataVersion == metadataVersion }
    }

    private func begin(fileURL: URL, name: String, mime: String?, parentId: String, replacing given: Opened?, thumbnailBytes: UInt32,
                       signing: (metadata: Signing, version: Signing), attributes: [String: String] = [:], waited: Bool = false) async throws -> Begun {
        _ = try await loadWorkspace()
        var replacing = given
        // The drive the parent (or the file replaced) lives in: a shared folder's is the granter's.
        let workspace: Target
        if let replacing { workspace = Target(workspaceId: replacing.node.workspaceId) } else { workspace = Target(workspaceId: try await resolve(parentId).node.workspaceId) }
        let family = try familyTarget(workspace.workspaceId)
        if family {
            // Looked up afresh before a node or a content key is made: the folder (and the file replaced) as the server serves
            // them now, which a walk may have re-keyed since they were listed (the web's openNodes before every seal).
            try await lookAgain(parentId)
            if let given {
                guard let fresh = opened[given.ref] else { throw DriveAPIError.notFound("This item no longer exists.") }
                // A file someone replaced while this upload waited is never overwritten: their version stays current.
                if waited, fresh.node.currentVersion?.id != given.node.currentVersion?.id { throw DriveAPIError.server(409, KeyChangeWait.versionMoved) }
                replacing = fresh
            }
        }
        let onDisk = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        let plaintextSize = (onDisk[.size] as? NSNumber)?.uint64Value ?? 0
        let modified = ISO8601DateFormatter().string(from: (onDisk[.modificationDate] as? Date) ?? Date())
        let madeVersion = try mint(.version, in: workspace.workspaceId)
        let madeObject = try mint(.object, in: workspace.workspaceId)
        let (versionId, objectId) = (madeVersion.id, madeObject.id)
        let contentKey = try randomBytes(length: 32)
        let contentNonce = try randomBytes(length: 16)

        let nodeId: String
        let nodeKey: Data
        var nodeInput: [String: Any]
        let final: NodeMetadata
        // A new node's key the ledger made: dropped unless the server takes the begin (the web's forgetNodeKey).
        var madeKey: String?
        var begunHere = false
        defer { if let madeKey, !begunHere { areaLedger.forgetNodeKey(workspaceId: workspace.workspaceId, nodeId: madeKey) } }
        if let replacing {
            // The replacement re-signs the record's name when it completes (see `complete`): without whom to trust, nothing is
            // sent. In a family folder that is the family's judgement, asked at completion.
            if !family { _ = try await changeSigners() }
            nodeId = replacing.id
            // In a family folder the file's key only as the ledger holds it rooted at the folder's current key (KEY_CHANGE_PENDING otherwise).
            if family {
                nodeKey = try writableKey(of: replacing)
            } else {
                guard let key = self.nodeKey(of: replacing) else { throw DriveAPIError.server(500, "Node not opened") }
                nodeKey = key
            }
            nodeInput = ["existing": true, "id": nodeId, "keyEpoch": replacing.node.keyEpoch,
                         "expectedVersionId": replacing.node.currentVersion?.id ?? NSNull()]
            // A new version has a new size and date; the sealed metadata says so too, as the lists read it.
            final = NodeMetadata(name: replacing.metadata.name, mime: mime ?? replacing.metadata.mime, size: plaintextSize, modified: modified,
                                 attributes: replacing.metadata.attributes)
        } else {
            let parent = try await resolve(parentId)
            // The folder's key as the ledger holds it, before anything is asked of the server: a key change that hasn't
            // reached the folder is a wait (KEY_CHANGE_PENDING), not an epoch allocated for nothing.
            if family { _ = try areaLedger.writableNodeKey(workspaceId: workspace.workspaceId, nodeId: parent.id) }
            let epochs = try await api.allocateEpochs(workspaceId: workspace.workspaceId, count: 1)
            let made = try mint(.node, in: workspace.workspaceId)
            nodeId = made.id
            let wrapped: Data
            (nodeKey, wrapped) = try newKey(nodeId, under: parent, keyEpoch: epochs.from, family: family)
            madeKey = family ? nodeId : nil
            final = NodeMetadata(name: try checkName(name: name), mime: mime, size: plaintextSize, modified: modified, attributes: attributes)
            let sealed = try metadataSeal(ctx: MetadataContext(workspaceId: workspace.workspaceId, nodeId: nodeId, metadataVersion: 1), nodeKey: nodeKey, metadata: final)
            nodeInput = ["existing": false, "id": nodeId, "idSeed": made.seed, "parentId": parent.id, "keyEpoch": epochs.from,
                         "parentKeyEpoch": parent.node.keyEpoch, "keyEnvelope": base64urlEncode(bytes: wrapped),
                         "metadataEnvelope": base64urlEncode(bytes: sealed),
                         "metadataSignature": try await signMetadata(workspaceId: workspace.workspaceId, nodeId: nodeId, kind: .file, version: 1, envelope: sealed,
                                                                     signing: signing.metadata)]
        }

        let version = try versionSeal(
            ctx: VersionContext(workspaceId: workspace.workspaceId, nodeId: nodeId, versionId: versionId, objectId: objectId),
            nodeKey: nodeKey, contentKey: contentKey, plaintextSize: plaintextSize, thumbnailBytes: thumbnailBytes
        )
        // Suite 3: the object is padded to a Padmé bucket, so its size says the file's only to within a few percent.
        let suite = HushOSCore.contentSuite()
        let content = Content(
            workspaceId: workspace.workspaceId, objectId: objectId, suite: suite, key: contentKey, nonce: contentNonce,
            plaintextSize: plaintextSize, thumbnailBytes: thumbnailBytes
        )
        let layout = try contentLayout(suite: suite, plaintextSize: plaintextSize, thumbnailBytes: thumbnailBytes)
        let versionSignature = try await signVersion(workspaceId: workspace.workspaceId, nodeId: nodeId, versionId: versionId, objectId: objectId,
                                                     suite: suite, envelope: version.envelope, signing: signing.version)
        let begun = try await api.beginUpload(workspaceId: workspace.workspaceId, body: [
            "node": nodeInput, "versionId": versionId, "versionIdSeed": madeVersion.seed, "objectId": objectId, "objectIdSeed": madeObject.seed,
            "contentKeyEnvelope": base64urlEncode(bytes: version.envelope), "versionSignature": versionSignature,
            "contentNonce": base64urlEncode(bytes: contentNonce),
            "contentSuite": Int(suite), "chunkCount": Int(layout.chunkCount), "ciphertextSize": String(layout.ciphertextSize),
        ])
        begunHere = true
        var urls: [Int: PartUrl] = [:]
        for part in begun.parts { urls[part.partNumber] = part }
        return Begun(
            workspaceId: workspace.workspaceId, uploadId: begun.upload.id, nodeId: nodeId, parentId: parentId, nodeKey: nodeKey,
            content: content, chunkCount: layout.chunkCount, chunkBytes: layout.chunkBytes, plaintextSize: plaintextSize,
            urls: urls, final: final, replacing: replacing != nil,
            landing: replacing.map { Landing(versionId: versionId, metadataVersion: $0.node.metadataVersion) }
        )
    }

    /* One part's sealed bytes: the chunk's ciphertext, and on the last the thumbnail trailer. */
    private func sealPart(_ begun: Begun, index: UInt64, from handle: FileHandle, thumbnail: Data?) throws -> Data {
        let length = chunkLength(plaintextSize: begun.plaintextSize, index: index)
        try handle.seek(toOffset: index * begun.chunkBytes)
        // In its own pool: FileHandle hands back autoreleased data, which would otherwise pile up until the async
        // caller returns, the whole file in memory (fatal in Save to HushOS, whose limit is about 120 MB).
        let plaintext = try autoreleasepool { try handle.read(upToCount: Int(length)) ?? Data() }
        if UInt64(plaintext.count) != length { throw DriveAPIError.server(500, "The file changed while uploading.") }
        var sealed = try chunkEncrypt(content: begun.content, index: index, plaintext: plaintext)
        if index == begun.chunkCount - 1, let thumbnail, begun.content.thumbnailBytes > 0 {
            sealed.append(try thumbnailEncrypt(content: begun.content, thumbnail: thumbnail))
        }
        return sealed
    }

    /* Completes on the server with every part's ETag; a replacement's metadata is sealed again with its new size and date. */
    private func complete(uploadId: String, workspaceId: String, nodeId: String, parentId: String, replacing: Bool,
                          final: NodeMetadata, nodeKey knownKey: Data?, etags: [Int: String], landing: Landing?) async throws -> Opened {
        // Built here, not passed in: a dictionary of Any made in this call can be handed to the API; a parameter could not.
        let parts: [[String: Any]] = etags.keys.sorted().map { ["partNumber": $0, "etag": etags[$0]!] }
        // A family folder's replacement is checked before the version goes live: the file's key as the ledger holds it and the
        // family's judgement of the name it carries over, so a key change or a refusal never leaves a version without its metadata.
        let family = replacing ? try familyTarget(workspaceId) : false
        var familyName: (key: Data, prior: Integrity)?
        if replacing, family {
            let item = try await resolve(nodeId)
            familyName = (try knownKey ?? writableKey(of: item), try await priorMetadata(of: item.node, family: true))
        }
        let completed = try await api.completeUpload(uploadId: uploadId, workspaceId: workspaceId, parts: parts)
        guard let node = completed.node else { throw DriveAPIError.server(500, "Upload completed without a node") }
        if replacing {
            // Another member renamed the file or put a newer version on it before this answer (a repeated completion): this
            // version landed, and their name record is theirs. Nothing is re-signed. An upload sealed before the landing was
            // kept (an older record) has nothing to check against and is re-signed as before.
            if let landing, !landing.holds(node) { throw UploadLanded() }
            // The version is live from here: whatever refuses the name record now (a key change, a newer rename, no answer)
            // leaves an upload that landed, with its name to repair, never one to fail, abort or seal again.
            do {
                let ref = NodeRef(workspaceId: workspaceId, nodeId: nodeId)
                var key = familyName?.key ?? knownKey ?? nodeKeys[ref]
                if key == nil { _ = try await resolve(nodeId); key = nodeKeys[ref] }
                guard let nodeKey = key else { throw DriveAPIError.server(500, "Node not opened") }
                // The name kept from the record as the server holds it now: vouched for again only if that verified.
                let prior: Integrity
                if let familyName { prior = familyName.prior } else { prior = try await priorMetadata(of: node, family: false) }
                return try await resignLanded(node, nodeKey: nodeKey, prior: prior, final: final)
            } catch {
                throw UploadLanded(published: Published(metadataVersion: node.metadataVersion, versionId: node.currentVersion?.id))
            }
        }
        if let knownKey { return try adopt(node, nodeKey: knownKey, metadata: final, in: workspaceId) }
        // Finished by another launch: the node key comes from the parent's, which the tree opens. The upload has landed
        // either way: a row that doesn't open here now is not an upload to fail, retry or abort.
        do {
            _ = try await resolve(parentId)
            return try open(node)
        } catch {
            throw UploadLanded()
        }
    }

    /*
     * `signing` is `.own` for what this person uploads; a copy that travels as an upload (into
     * another drive, or saved from a link or a share) passes the verdicts it is signed by, and its
     * source's `attributes`. A new version keeps the replaced file's attributes whatever is passed.
     */
    public func upload(
        fileURL: URL, name: String, mime: String?, in parentId: String, replacing: Opened?,
        thumbnail: Data? = nil, signing: (metadata: Signing, version: Signing) = (.own, .own), attributes: [String: String] = [:],
        progress: @Sendable (Double) -> Void = { _ in }
    ) async throws -> Opened {
        let begun = try await begin(fileURL: fileURL, name: name, mime: mime, parentId: parentId, replacing: replacing,
                                    thumbnailBytes: UInt32(thumbnail?.count ?? 0), signing: signing, attributes: attributes)
        var urls = begun.urls
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        var etags: [Int: String] = [:]
        do {
            for index in 0 ..< begun.chunkCount {
                try Task.checkCancellation()
                let partNumber = Int(index) + 1
                if urls[partNumber] == nil {
                    let more = try await api.partUrls(uploadId: begun.uploadId, workspaceId: begun.workspaceId, from: partNumber, count: 64)
                    for part in more.parts { urls[part.partNumber] = part }
                }
                guard let part = urls[partNumber], let url = URL(string: part.url) else {
                    throw DriveAPIError.server(500, "No URL for part \(partNumber)")
                }
                let sealed = try sealPart(begun, index: index, from: handle, thumbnail: thumbnail)
                // A part the network dropped is sent again; an expired address is fetched fresh first.
                var partURL = url
                let etag = try await Resumable.run(onExpired: {
                    let more = try await api.partUrls(uploadId: begun.uploadId, workspaceId: begun.workspaceId, from: partNumber, count: 64)
                    for part in more.parts { urls[part.partNumber] = part }
                    if let fresh = urls[partNumber].flatMap({ URL(string: $0.url) }) { partURL = fresh }
                }) {
                    try await api.putPart(partURL, data: sealed)
                }
                etags[partNumber] = etag
                progress(FileProgress.fraction(size: begun.plaintextSize, through: index + 1))
            }
        } catch {
            await api.abortUpload(uploadId: begun.uploadId, workspaceId: begun.workspaceId)
            throw error
        }
        do {
            return try await complete(uploadId: begun.uploadId, workspaceId: begun.workspaceId, nodeId: begun.nodeId, parentId: begun.parentId,
                                      replacing: begun.replacing, final: begun.final, nodeKey: begun.nodeKey, etags: etags, landing: begun.landing)
        } catch let landed as UploadLanded {
            // Here and now there is no queue to come back: the name is repaired once if it can be, and the item is
            // answered as the server holds it (a caller such as Files must never take a landed version for a failure and
            // send it again). Only a row that can't be looked up at all is thrown, still as landed.
            if let published = landed.published {
                _ = try? await repairLanded(nodeId: begun.nodeId, workspaceId: begun.workspaceId, final: begun.final, published: published)
            }
            try? await lookAgain(begun.parentId)
            guard let item = opened[NodeRef(workspaceId: begun.workspaceId, nodeId: begun.nodeId)] else { throw landed }
            return item
        }
    }

    // MARK: - Uploads another process sends

    /*
     * An upload split for a background transfer: sealed here (the server's upload
     * begun, every part encrypted into `directory` as `part-N`), sent by whoever
     * holds the parts (the system's background session), finished here. No key is
     * kept between the two: parts are ciphertext, and finishing needs only ETags.
     */
    public struct SealedUpload: Codable, Sendable, Equatable {
        public let uploadId: String
        public let workspaceId: String
        public let nodeId: String
        public let parentId: String
        public let partCount: Int
        public let replacing: Bool
        /* The metadata to show once it lands (stored field by field: the core's type is not Codable). */
        public let name: String
        public let mime: String?
        public let size: UInt64?
        public let modified: String?
        /* The record's attributes, carried whole; nil for none (and for an upload stored before attributes). */
        public var attributes: [String: String]? = nil
        /* Presigned PUT addresses by part number; refreshed when they expire. */
        public var urls: [Int: String]
        /* A replacement's version and the name record it replaces (nil for a new file, or a record kept before it was stored). */
        public var landing: Landing? = nil

        /* The record this upload seals when it lands, attributes and all. */
        var final: NodeMetadata { NodeMetadata(name: name, mime: mime, size: size, modified: modified, attributes: attributes ?? [:]) }
    }

    /*
     * `waiting`: how an upload into a family folder waits out a key change (KeyChangeWait): the
     * folder looked up again and the upload sealed afresh after each pause, the family checked
     * again between, until it goes or half an hour from `since` has passed. Nothing refused is sent
     * again: its envelopes were under keys the change replaces. Without it, the wait is an error.
     */
    public func sealUpload(fileURL: URL, name: String, mime: String?, in parentId: String, replacing: Opened?,
                           thumbnail: Data?, into directory: URL, waiting: KeyChangeWait.Policy? = nil) async throws -> SealedUpload {
        let target: String
        if let replacing { target = replacing.node.workspaceId } else { target = try await resolve(parentId).node.workspaceId }
        var since = waiting?.since
        var attempt = 0
        while true {
            do {
                return try await sealUploadOnce(fileURL: fileURL, name: name, mime: mime, in: parentId, replacing: replacing,
                                                thumbnail: thumbnail, into: directory, waited: since != nil)
            } catch {
                guard let waiting, isFamilyWorkspace(target), KeyChangeWait.meets(error, waited: since != nil) else { throw error }
                let start = since ?? waiting.now()
                since = start
                waiting.waiting(start)
                if waiting.now().timeIntervalSince(start) >= KeyChangeWait.giveUp { throw DriveAPIError.server(409, KeyChangeWait.gaveUp) }
                attempt += 1
                try await waiting.pause(attempt)
                if waiting.now().timeIntervalSince(start) >= KeyChangeWait.giveUp { throw DriveAPIError.server(409, KeyChangeWait.gaveUp) }
                // The family checked again: a walk's roster (the folder's next key) is accepted before the next look.
                await familyJudge?.recheck(target)
            }
        }
    }

    private func sealUploadOnce(fileURL: URL, name: String, mime: String?, in parentId: String, replacing: Opened?,
                                thumbnail: Data?, into directory: URL, waited: Bool) async throws -> SealedUpload {
        let begun = try await begin(fileURL: fileURL, name: name, mime: mime, parentId: parentId, replacing: replacing,
                                    thumbnailBytes: UInt32(thumbnail?.count ?? 0), signing: (.own, .own), waited: waited)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let handle = try FileHandle(forReadingFrom: fileURL)
            defer { try? handle.close() }
            for index in 0 ..< begun.chunkCount {
                try Task.checkCancellation()
                let sealed = try sealPart(begun, index: index, from: handle, thumbnail: thumbnail)
                try sealed.write(to: directory.appendingPathComponent("part-\(index + 1)"), options: .atomic)
            }
            var urls = begun.urls
            if urls.count < Int(begun.chunkCount) {
                var from = urls.count + 1
                while from <= Int(begun.chunkCount) {
                    let more = try await api.partUrls(uploadId: begun.uploadId, workspaceId: begun.workspaceId, from: from, count: 64)
                    for part in more.parts { urls[part.partNumber] = part }
                    from += max(more.parts.count, 1)
                }
            }
            return SealedUpload(
                uploadId: begun.uploadId, workspaceId: begun.workspaceId, nodeId: begun.nodeId, parentId: begun.parentId,
                partCount: Int(begun.chunkCount), replacing: begun.replacing,
                name: begun.final.name, mime: begun.final.mime, size: begun.final.size, modified: begun.final.modified,
                attributes: begun.final.attributes.isEmpty ? nil : begun.final.attributes,
                urls: urls.mapValues(\.url), landing: begun.landing
            )
        } catch {
            await api.abortUpload(uploadId: begun.uploadId, workspaceId: begun.workspaceId)
            throw error
        }
    }

    /* Fresh addresses for parts whose address expired. */
    public func partAddresses(for sealed: SealedUpload, parts: [Int]) async throws -> [Int: String] {
        var fresh: [Int: String] = [:]
        for part in parts.sorted() where fresh[part] == nil {
            let more = try await api.partUrls(uploadId: sealed.uploadId, workspaceId: sealed.workspaceId, from: part, count: 64)
            for url in more.parts { fresh[url.partNumber] = url.url }
        }
        return fresh
    }

    public func finishUpload(_ sealed: SealedUpload, etags: [Int: String]) async throws -> Opened {
        try await complete(uploadId: sealed.uploadId, workspaceId: sealed.workspaceId, nodeId: sealed.nodeId, parentId: sealed.parentId,
                                  replacing: sealed.replacing,
                                  final: sealed.final, nodeKey: nil, etags: etags, landing: sealed.landing)
    }

    /* A new version as the server published it: its name record is repaired only while both are still these. */
    public struct Published: Codable, Sendable, Equatable {
        public let metadataVersion: UInt64
        public let versionId: String?
        public init(metadataVersion: UInt64, versionId: String?) {
            self.metadataVersion = metadataVersion
            self.versionId = versionId
        }
    }

    /*
     * The name record of a new version that went live while re-signing it was refused (`UploadLanded`),
     * sealed again with the new size and date through the same path, under the keys and the
     * judgement the item has now. Nothing is written once someone else changed the file or its name
     * since (their record is newer than this one would be): `false`.
     */
    @discardableResult
    public func repairLanded(_ sealed: SealedUpload, published: Published) async throws -> Bool {
        try await repairLanded(nodeId: sealed.nodeId, workspaceId: sealed.workspaceId,
                               final: sealed.final, published: published)
    }

    func repairLanded(nodeId: String, workspaceId: String, final: NodeMetadata, published: Published) async throws -> Bool {
        let item = try await resolve(nodeId)
        guard item.node.metadataVersion == published.metadataVersion, item.node.currentVersion?.id == published.versionId else { return false }
        let family = try familyTarget(workspaceId)
        let ref = NodeRef(workspaceId: workspaceId, nodeId: nodeId)
        guard let nodeKey = family ? try writableKey(of: item) : nodeKeys[ref] else { throw DriveAPIError.server(500, "Node not opened") }
        let prior = try await priorMetadata(of: item.node, family: family)
        _ = try await resignLanded(item.node, nodeKey: nodeKey, prior: prior, final: final)
        return true
    }

    /* A new version's name record sealed again with its size and date, after the record it carries over. */
    private func resignLanded(_ node: NodeView, nodeKey: Data, prior: Integrity, final: NodeMetadata) async throws -> Opened {
        let sealed = try metadataSeal(
            ctx: MetadataContext(workspaceId: node.workspaceId, nodeId: node.id, metadataVersion: node.metadataVersion + 1),
            nodeKey: nodeKey, metadata: final
        )
        let signature = try await signMetadata(workspaceId: node.workspaceId, nodeId: node.id, kind: .file, version: node.metadataVersion + 1, envelope: sealed,
                                               signing: .after(prior))
        let renamed = try await api.rename(nodeId: node.id, workspaceId: node.workspaceId, metadataVersion: node.metadataVersion, keyEpoch: node.keyEpoch,
                                           metadataEnvelope: base64urlEncode(bytes: sealed), metadataSignature: signature)
        return try adopt(renamed, nodeKey: nodeKey, metadata: final, in: node.workspaceId)
    }

    public func abortUpload(_ sealed: SealedUpload) async {
        await api.abortUpload(uploadId: sealed.uploadId, workspaceId: sealed.workspaceId)
    }

    // MARK: - Changes

    public struct Changes: Sendable {
        public let updated: [Opened]
        public let deleted: [String]
        public let nextCursor: Int
        public let hasMore: Bool
    }

    /* The workspace's change feed since `cursor`: nodes to update (opened) and ids that are gone; nil means resync. */
    public func changes(since cursor: Int) async throws -> Changes? {
        let workspace = try await loadWorkspace()
        let feed = try await api.changes(workspaceId: workspace.workspaceId, since: cursor)
        if feed.resync { return nil }
        var updated: [Opened] = []
        var deleted: [String] = []
        for change in feed.changes {
            switch change.kind {
            case "node":
                guard let node = change.node else { continue }
                forget(node.id)
                if node.trashedAt != nil {
                    deleted.append(node.id)
                    continue
                }
                if let parent = node.parentId { rememberParent(node.id, parent: parent) }
                do {
                    updated.append(try await resolve(node.id))
                } catch DriveAPIError.notFound, DriveAPIError.trashed, is CoreError {
                    // Gone, under a trashed folder, or no longer openable here: it leaves the Files location.
                    deleted.append(node.id)
                }
                // Anything else (no network, a busy server, keys mid-rotation, an ended session) is no verdict on
                // the node: it fails the batch and Files asks again, rather than deleting the item there.
            case "tombstone":
                if let id = change.nodeId {
                    deleted.append(id)
                    forget(id)
                }
            default:
                break
            }
        }
        return Changes(updated: updated, deleted: deleted, nextCursor: feed.nextCursor, hasMore: feed.hasMore)
    }
}

/* The workspace a write lands in: the parent's, which is the granter's inside a share. */
private struct Target { let workspaceId: String }

extension Vault {
    /* Whom to trust for a copy's verdicts; a copy stops rather than sign records it couldn't check. */
    func copySigners() async throws -> TrustedSigners {
        do { return try await signers() } catch {
            throw DriveAPIError.server(503, "HushOS couldn’t check who wrote this, so it wasn’t copied. Try again.")
        }
    }

    /* The same for a write that signs an existing record again (a rename, a replacement's name): it stops rather than vouch blind. */
    func changeSigners() async throws -> TrustedSigners {
        do { return try await signers() } catch {
            throw DriveAPIError.server(503, "HushOS couldn’t check who wrote this, so it wasn’t changed. Try again.")
        }
    }

    /*
     * A copy into another workspace (a shared folder, or this person's own drive
     * out of someone's share): the server keeps objects per workspace, so the
     * file is fetched and uploaded again, thumbnail and all. Folders go node by
     * node. Signed by each record's verdict as a copy is: a share from a checked
     * contact that verifies is copied as this person's own, anything else is
     * re-sealed, and without whom to trust nothing is copied.
     */
    public func copyAcross(_ nodeId: String, to parentId: String, name: String? = nil,
                           progress: @Sendable (Double) -> Void = { _ in }) async throws -> Opened {
        let source = try await resolve(nodeId)
        // Out of a family folder each record is judged by the family's member list (`copy_form`): a former member's
        // file, or keys that don't match, is re-sealed as the copier's and never vouched for. Elsewhere by the trust set.
        let family = isFamilyWorkspace(source.node.workspaceId)
        let trusted: TrustedSigners? = family ? nil : try await copySigners()
        let metadata: Signing
        if let trusted {
            metadata = .copy(trusted.metadata(of: source.node))
        } else {
            metadata = .copy(try await familyPrior(FamilySync.metadataRecord(of: source.node), in: source.node.workspaceId, copying: true))
        }
        if source.isFolder {
            let made = try await createFolder(in: parentId, name: name ?? source.name, signing: metadata, attributes: source.metadata.attributes)
            for child in try await children(of: source.id) { _ = try await copyAcross(child.id, to: made.id, progress: progress) }
            return made
        }
        // A file without a version has nothing to vouch for: whatever it is, it isn't verified.
        let version: Signing
        if let current = source.node.currentVersion {
            if let trusted {
                version = .copy(trusted.version(current, of: source.node))
            } else {
                version = .copy(try await familyPrior(FamilySync.versionRecord(current, of: source.node), in: source.node.workspaceId, copying: true))
            }
        } else {
            version = .copy(.unsigned)
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("copy-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent(source.name)
        try await download(source.id, to: file) { progress($0 / 2) }
        let thumbnail = try? await thumbnail(source.id)
        return try await upload(fileURL: file, name: name ?? source.name, mime: source.metadata.mime, in: parentId, replacing: nil, thumbnail: thumbnail,
                                signing: (metadata, version), attributes: source.metadata.attributes) { progress(0.5 + $0 / 2) }
    }
}
