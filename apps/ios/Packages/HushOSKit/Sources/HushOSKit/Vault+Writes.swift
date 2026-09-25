import Foundation

/*
 * Writing to the Drive: folders, renames, moves, trash, restore and uploads.
 * Every envelope is sealed in the Rust core exactly as the web app seals it;
 * the server only ever sees ciphertext and the shape of the tree.
 */
extension Vault {
    private func newId() -> String { UUID().uuidString.lowercased() }

    public func createFolder(in parentId: String, name: String) async throws -> Opened {
        _ = try await loadWorkspace()
        let parent = try await resolve(parentId)
        // Shared folders belong to the granter's workspace; an editor writes there.
        let workspace = Target(workspaceId: parent.node.workspaceId)
        guard let parentKey = nodeKey(parent.node.id) else { throw DriveAPIError.server(500, "Open the containing folder first.") }
        let epochs = try await api.allocateEpochs(workspaceId: workspace.workspaceId, count: 1)
        let id = newId()
        let key = try randomBytes(length: 32)
        let ctx = NodeKeyContext(workspaceId: workspace.workspaceId, nodeId: id, parentId: parent.node.id, parentKeyEpoch: parent.node.keyEpoch, keyEpoch: epochs.from)
        let wrapped = try nodeWrap(ctx: ctx, parentKey: parentKey, nodeKey: key)
        let metadata = NodeMetadata(name: name, mime: nil, size: nil, modified: nil)
        let sealed = try metadataSeal(ctx: MetadataContext(workspaceId: workspace.workspaceId, nodeId: id, metadataVersion: 1), nodeKey: key, metadata: metadata)
        let nodes = try await api.createFolders(workspaceId: workspace.workspaceId, folders: [[
            "id": id, "parentId": parent.node.id, "keyEpoch": epochs.from, "parentKeyEpoch": parent.node.keyEpoch,
            "keyEnvelope": base64urlEncode(bytes: wrapped), "metadataEnvelope": base64urlEncode(bytes: sealed),
        ]])
        guard let node = nodes.first else { throw DriveAPIError.server(500, "No folder returned") }
        return adopt(node, nodeKey: key, metadata: metadata)
    }

    public func rename(_ nodeId: String, to name: String) async throws -> Opened {
        let item = try await resolve(nodeId)
        guard let key = nodeKey(nodeId) else { throw DriveAPIError.server(500, "Node not opened") }
        let metadata = NodeMetadata(name: name, mime: item.metadata.mime, size: item.metadata.size, modified: item.metadata.modified)
        let sealed = try metadataSeal(
            ctx: MetadataContext(workspaceId: item.node.workspaceId, nodeId: nodeId, metadataVersion: item.node.metadataVersion + 1),
            nodeKey: key, metadata: metadata
        )
        let node = try await api.rename(
            nodeId: nodeId, workspaceId: item.node.workspaceId, metadataVersion: item.node.metadataVersion,
            keyEpoch: item.node.keyEpoch, metadataEnvelope: base64urlEncode(bytes: sealed)
        )
        return adopt(node, nodeKey: key, metadata: metadata)
    }

    private func rewrap(_ item: Opened, under parent: Opened) throws -> String {
        guard let key = nodeKey(item.id), let parentKey = nodeKey(parent.id) else { throw DriveAPIError.server(500, "Node not opened") }
        let ctx = NodeKeyContext(workspaceId: item.node.workspaceId, nodeId: item.id, parentId: parent.id, parentKeyEpoch: parent.node.keyEpoch, keyEpoch: item.node.keyEpoch)
        return base64urlEncode(bytes: try nodeWrap(ctx: ctx, parentKey: parentKey, nodeKey: key))
    }

    public func move(_ nodeId: String, to parentId: String) async throws -> Opened {
        let item = try await resolve(nodeId)
        let parent = try await resolve(parentId)
        guard let key = nodeKey(nodeId) else { throw DriveAPIError.server(500, "Node not opened") }
        let node = try await api.move(
            nodeId: nodeId, workspaceId: item.node.workspaceId, parentId: parent.id,
            parentKeyEpoch: parent.node.keyEpoch, keyEnvelope: try rewrap(item, under: parent)
        )
        return adopt(node, nodeKey: key, metadata: item.metadata)
    }

    /*
     * A copy under `parentId`: the server keeps the object and its chunks; only
     * the envelopes change hands, resealed here under a fresh node key. A folder
     * is copied node by node, since the server holds no key to rewrap a subtree.
     */
    public func copy(_ nodeId: String, to parentId: String, name: String? = nil, progress: @Sendable (Int) -> Void = { _ in }) async throws -> Opened {
        let source = try await resolve(nodeId)
        let parent = try await resolve(parentId)
        _ = try await loadWorkspace()
        let workspace = Target(workspaceId: parent.node.workspaceId)
        guard let parentKey = nodeKey(parent.id) else { throw DriveAPIError.server(500, "Open the containing folder first.") }
        let newName = try checkName(name: name ?? source.name)
        var done = 0
        if source.isFolder {
            let made = try await createFolder(in: parent.id, name: newName)
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
        let id = newId()
        let versionId = newId()
        let key = try randomBytes(length: 32)
        let ctx = NodeKeyContext(workspaceId: workspace.workspaceId, nodeId: id, parentId: parent.id, parentKeyEpoch: parent.node.keyEpoch, keyEpoch: epochs.from)
        let keyEnvelope = try nodeWrap(ctx: ctx, parentKey: parentKey, nodeKey: key)
        let metadata = NodeMetadata(name: newName, mime: source.metadata.mime, size: source.metadata.size, modified: source.metadata.modified)
        let metadataEnvelope = try metadataSeal(ctx: MetadataContext(workspaceId: workspace.workspaceId, nodeId: id, metadataVersion: 1), nodeKey: key, metadata: metadata)
        let contentKeyEnvelope = try versionReseal(
            ctx: VersionContext(workspaceId: workspace.workspaceId, nodeId: id, versionId: versionId, objectId: version.objectId),
            suite: version.contentSuite, nodeKey: key,
            content: ContentKey(key: opened.content.key, plaintextSize: opened.content.plaintextSize, thumbnailBytes: opened.content.thumbnailBytes)
        )
        let node = try await api.copy(sourceNodeId: source.id, workspaceId: workspace.workspaceId, body: [
            "sourceVersionId": version.id,
            "node": ["id": id, "parentId": parent.id, "parentKeyEpoch": parent.node.keyEpoch, "keyEpoch": epochs.from,
                     "keyEnvelope": base64urlEncode(bytes: keyEnvelope), "metadataEnvelope": base64urlEncode(bytes: metadataEnvelope)],
            "versionId": versionId,
            "contentKeyEnvelope": base64urlEncode(bytes: contentKeyEnvelope),
        ])
        progress(done + 1)
        return adopt(node, nodeKey: key, metadata: metadata)
    }

    public func trash(_ nodeId: String) async throws {
        let item = try await resolve(nodeId)
        _ = try await api.trash(nodeId: nodeId, workspaceId: item.node.workspaceId)
        forget(nodeId)
    }

    /* Back where it was, or under the root when its old folder is in the trash too. */
    public func restore(_ item: Opened, parentTrashed: Bool) async throws -> Opened {
        guard let key = nodeKey(item.id) else { throw DriveAPIError.server(500, "Node not opened") }
        var toRoot: (UInt64, String)? = nil
        if parentTrashed {
            let root = try await resolve(try rootId())
            toRoot = (root.node.keyEpoch, try rewrap(item, under: root))
        }
        let node = try await api.restore(nodeId: item.id, workspaceId: item.node.workspaceId, toRoot: toRoot)
        return adopt(node, nodeKey: key, metadata: item.metadata)
    }

    public func purge(_ nodeId: String) async throws {
        let workspace = try await loadWorkspace()
        try await api.purge(nodeId: nodeId, workspaceId: workspace.workspaceId)
        forget(nodeId)
    }

    public func emptyTrash() async throws -> EmptyTrashResult {
        try await api.emptyTrash(workspaceId: try workspaceId())
    }

    public func restoreVersion(_ version: VersionListView, of nodeId: String) async throws -> Opened {
        let item = try await resolve(nodeId)
        guard let key = nodeKey(nodeId) else { throw DriveAPIError.server(500, "Node not opened") }
        let node = try await api.restoreVersion(version.id, workspaceId: item.node.workspaceId)
        return adopt(node, nodeKey: key, metadata: item.metadata)
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
    }

    private func begin(fileURL: URL, name: String, mime: String?, parentId: String, replacing: Opened?, thumbnailBytes: UInt32) async throws -> Begun {
        _ = try await loadWorkspace()
        let workspace = Target(workspaceId: try await workspaceId(of: parentId))
        let attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        let plaintextSize = (attributes[.size] as? NSNumber)?.uint64Value ?? 0
        let modified = ISO8601DateFormatter().string(from: (attributes[.modificationDate] as? Date) ?? Date())
        let versionId = newId()
        let objectId = newId()
        let contentKey = try randomBytes(length: 32)
        let contentNonce = try randomBytes(length: 16)

        let nodeId: String
        let nodeKey: Data
        var nodeInput: [String: Any]
        let final: NodeMetadata
        if let replacing {
            nodeId = replacing.id
            guard let key = self.nodeKey(nodeId) else { throw DriveAPIError.server(500, "Node not opened") }
            nodeKey = key
            nodeInput = ["existing": true, "id": nodeId, "keyEpoch": replacing.node.keyEpoch,
                         "expectedVersionId": replacing.node.currentVersion?.id ?? NSNull()]
            // A new version has a new size and date; the sealed metadata says so too, as the lists read it.
            final = NodeMetadata(name: replacing.metadata.name, mime: mime ?? replacing.metadata.mime, size: plaintextSize, modified: modified)
        } else {
            let parent = try await resolve(parentId)
            guard let parentKey = self.nodeKey(parent.id) else { throw DriveAPIError.server(500, "Open the containing folder first.") }
            let epochs = try await api.allocateEpochs(workspaceId: workspace.workspaceId, count: 1)
            nodeId = newId()
            nodeKey = try randomBytes(length: 32)
            let ctx = NodeKeyContext(workspaceId: workspace.workspaceId, nodeId: nodeId, parentId: parent.id, parentKeyEpoch: parent.node.keyEpoch, keyEpoch: epochs.from)
            let wrapped = try nodeWrap(ctx: ctx, parentKey: parentKey, nodeKey: nodeKey)
            final = NodeMetadata(name: try checkName(name: name), mime: mime, size: plaintextSize, modified: modified)
            let sealed = try metadataSeal(ctx: MetadataContext(workspaceId: workspace.workspaceId, nodeId: nodeId, metadataVersion: 1), nodeKey: nodeKey, metadata: final)
            nodeInput = ["existing": false, "id": nodeId, "parentId": parent.id, "keyEpoch": epochs.from,
                         "parentKeyEpoch": parent.node.keyEpoch, "keyEnvelope": base64urlEncode(bytes: wrapped),
                         "metadataEnvelope": base64urlEncode(bytes: sealed)]
        }

        let version = try versionSeal(
            ctx: VersionContext(workspaceId: workspace.workspaceId, nodeId: nodeId, versionId: versionId, objectId: objectId),
            nodeKey: nodeKey, contentKey: contentKey, plaintextSize: plaintextSize, thumbnailBytes: thumbnailBytes
        )
        let content = Content(
            workspaceId: workspace.workspaceId, objectId: objectId, suite: 2, key: contentKey, nonce: contentNonce,
            plaintextSize: plaintextSize, thumbnailBytes: thumbnailBytes
        )
        let layout = version.layout
        let begun = try await api.beginUpload(workspaceId: workspace.workspaceId, body: [
            "node": nodeInput, "versionId": versionId, "objectId": objectId,
            "contentKeyEnvelope": base64urlEncode(bytes: version.envelope), "contentNonce": base64urlEncode(bytes: contentNonce),
            "contentSuite": 2, "chunkCount": Int(layout.chunkCount), "ciphertextSize": String(layout.ciphertextSize),
        ])
        var urls: [Int: PartUrl] = [:]
        for part in begun.parts { urls[part.partNumber] = part }
        return Begun(
            workspaceId: workspace.workspaceId, uploadId: begun.upload.id, nodeId: nodeId, parentId: parentId, nodeKey: nodeKey,
            content: content, chunkCount: layout.chunkCount, chunkBytes: layout.chunkBytes, plaintextSize: plaintextSize,
            urls: urls, final: final, replacing: replacing != nil
        )
    }

    /* One part's sealed bytes: the chunk's ciphertext, and on the last the thumbnail trailer. */
    private func sealPart(_ begun: Begun, index: UInt64, from handle: FileHandle, thumbnail: Data?) throws -> Data {
        let length = chunkLength(plaintextSize: begun.plaintextSize, index: index)
        try handle.seek(toOffset: index * begun.chunkBytes)
        let plaintext = try handle.read(upToCount: Int(length)) ?? Data()
        if UInt64(plaintext.count) != length { throw DriveAPIError.server(500, "The file changed while uploading.") }
        var sealed = try chunkEncrypt(content: begun.content, index: index, plaintext: plaintext)
        if index == begun.chunkCount - 1, let thumbnail, begun.content.thumbnailBytes > 0 {
            sealed.append(try thumbnailEncrypt(content: begun.content, thumbnail: thumbnail))
        }
        return sealed
    }

    /* Completes on the server with every part's ETag; a replacement's metadata is sealed again with its new size and date. */
    private func complete(uploadId: String, workspaceId: String, nodeId: String, parentId: String, replacing: Bool,
                          final: NodeMetadata, nodeKey knownKey: Data?, etags: [Int: String]) async throws -> Opened {
        // Built here, not passed in: a dictionary of Any made in this call can be handed to the API; a parameter could not.
        let parts: [[String: Any]] = etags.keys.sorted().map { ["partNumber": $0, "etag": etags[$0]!] }
        let completed = try await api.completeUpload(uploadId: uploadId, workspaceId: workspaceId, parts: parts)
        guard var node = completed.node else { throw DriveAPIError.server(500, "Upload completed without a node") }
        if replacing {
            var key = knownKey ?? self.nodeKey(nodeId)
            if key == nil { _ = try await resolve(nodeId); key = self.nodeKey(nodeId) }
            guard let nodeKey = key else { throw DriveAPIError.server(500, "Node not opened") }
            let sealed = try metadataSeal(
                ctx: MetadataContext(workspaceId: workspaceId, nodeId: nodeId, metadataVersion: node.metadataVersion + 1),
                nodeKey: nodeKey, metadata: final
            )
            node = try await api.rename(nodeId: nodeId, workspaceId: workspaceId, metadataVersion: node.metadataVersion, keyEpoch: node.keyEpoch, metadataEnvelope: base64urlEncode(bytes: sealed))
            return adopt(node, nodeKey: nodeKey, metadata: final)
        }
        if let knownKey { return adopt(node, nodeKey: knownKey, metadata: final) }
        // Finished by another launch: the node key comes from the parent's, which the tree opens.
        _ = try await resolve(parentId)
        return try open(node)
    }

    public func upload(
        fileURL: URL, name: String, mime: String?, in parentId: String, replacing: Opened?,
        thumbnail: Data? = nil, progress: @Sendable (Double) -> Void = { _ in }
    ) async throws -> Opened {
        let begun = try await begin(fileURL: fileURL, name: name, mime: mime, parentId: parentId, replacing: replacing,
                                    thumbnailBytes: UInt32(thumbnail?.count ?? 0))
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
                progress(Double(index + 1) / Double(begun.chunkCount))
            }
        } catch {
            await api.abortUpload(uploadId: begun.uploadId, workspaceId: begun.workspaceId)
            throw error
        }
        return try await complete(uploadId: begun.uploadId, workspaceId: begun.workspaceId, nodeId: begun.nodeId, parentId: begun.parentId,
                                  replacing: begun.replacing, final: begun.final, nodeKey: begun.nodeKey, etags: etags)
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
        /* Presigned PUT addresses by part number; refreshed when they expire. */
        public var urls: [Int: String]
    }

    public func sealUpload(fileURL: URL, name: String, mime: String?, in parentId: String, replacing: Opened?,
                           thumbnail: Data?, into directory: URL) async throws -> SealedUpload {
        let begun = try await begin(fileURL: fileURL, name: name, mime: mime, parentId: parentId, replacing: replacing,
                                    thumbnailBytes: UInt32(thumbnail?.count ?? 0))
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
                urls: urls.mapValues(\.url)
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
                                  final: NodeMetadata(name: sealed.name, mime: sealed.mime, size: sealed.size, modified: sealed.modified),
                                  nodeKey: nil, etags: etags)
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
                if let opened = try? await resolve(node.id) { updated.append(opened) } else { deleted.append(node.id) }
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
    /*
     * A copy into another workspace (a shared folder): the server keeps objects
     * per workspace, so the file is fetched and uploaded again, thumbnail and
     * all. Folders go node by node.
     */
    public func copyAcross(_ nodeId: String, to parentId: String, progress: @Sendable (Double) -> Void = { _ in }) async throws -> Opened {
        let source = try await resolve(nodeId)
        if source.isFolder {
            let made = try await createFolder(in: parentId, name: source.name)
            for child in try await children(of: source.id) { _ = try await copyAcross(child.id, to: made.id, progress: progress) }
            return made
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("copy-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent(source.name)
        try await download(source.id, to: file) { progress($0 / 2) }
        let thumbnail = try? await thumbnail(source.id)
        return try await upload(fileURL: file, name: source.name, mime: source.metadata.mime, in: parentId, replacing: nil, thumbnail: thumbnail) { progress(0.5 + $0 / 2) }
    }
}
