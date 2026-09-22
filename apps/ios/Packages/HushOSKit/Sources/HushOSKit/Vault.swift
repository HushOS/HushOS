import Foundation

/* A node with its metadata opened: what every list, row and Files item is built from. */
public struct Opened: Sendable, Identifiable, Hashable {
    public let node: NodeView
    public let metadata: NodeMetadata
    public var id: String { node.id }
    public var name: String { metadata.name }
    public var isFolder: Bool { node.isFolder }
    public var size: UInt64? {
        if isFolder { return nil }
        if let size = metadata.size { return size }
        if let text = node.currentVersion?.plaintextSize, let value = UInt64(text) { return value }
        return nil
    }
    public var modified: Date? { parseDate(metadata.modified) ?? parseDate(node.updatedAt) }
    public var hasThumbnail: Bool { !isFolder && node.currentVersion?.contentSuite == 2 }
}

public struct OpenedVersion: Sendable {
    public let content: Content
    public let versionId: String
    public var layout: ContentLayout { contentLayout(plaintextSize: content.plaintextSize, thumbnailBytes: content.thumbnailBytes) }
}

/*
 * The keys, opened on demand and kept for the life of the process: the
 * account key from the remembered device, the workspace key from the grant,
 * node keys under their parents. Nothing here is written anywhere except the
 * node-to-parent index, which lets a cold process find an item the system
 * asks about by listing the folder it was last seen in.
 */
public actor Vault {
    public nonisolated let api: DriveAPI
    let session: SharedKeychain.Session
    private var accountKey: Data?
    var workspace: WorkspaceView?
    private var workspaceKey: Data?
    var nodeKeys: [String: Data] = [:]
    var opened: [String: Opened] = [:]
    private var identity: IdentityKeys?
    var parents: [String: String]
    private let indexURL: URL?
    /* The tree mirror on disk and the catalogue built from it (see Vault+Catalogue). */
    let mirror: Mirror?
    public var catalogueState: CatalogueState = .idle
    var catalogueChildren: [String: Set<String>] = [:]
    /* The build in flight, so a second caller waits for it rather than returning before it is done. */
    var catalogueBuilding: Task<Bool, Never>?

    public init(api: DriveAPI, session: SharedKeychain.Session) {
        self.api = api
        self.session = session
        let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedKeychain.accessGroup)
        indexURL = container?.appendingPathComponent("files-parents.json")
        mirror = container.flatMap { Mirror(url: $0.appendingPathComponent("mirror.sqlite")) }
        if let indexURL, let data = try? Data(contentsOf: indexURL),
           let saved = try? JSONDecoder().decode([String: String].self, from: data) {
            parents = saved
        } else {
            parents = [:]
        }
    }

    public static func fromKeychain() -> Vault? {
        guard let session = SharedKeychain.session else { return nil }
        return Vault(api: DriveAPI(session: session), session: session)
    }

    private func saveIndex() {
        guard let indexURL, let data = try? JSONEncoder().encode(parents) else { return }
        try? data.write(to: indexURL, options: .atomic)
    }

    private func remember(_ listing: Listing) {
        var changed = false
        for child in listing.children where parents[child.id] != listing.folder.id {
            parents[child.id] = listing.folder.id
            changed = true
        }
        for node in listing.ancestors + [listing.folder] {
            if let parent = node.parentId, parents[node.id] != parent {
                parents[node.id] = parent
                changed = true
            }
        }
        if changed { saveIndex() }
    }

    func rememberParent(_ id: String, parent: String) {
        guard parents[id] != parent else { return }
        parents[id] = parent
        saveIndex()
    }

    private func unlockAccount() throws -> Data {
        if let accountKey { return accountKey }
        guard let device = try SharedKeychain.device?.open() else { throw DriveAPIError.notAuthenticated }
        let key = try deviceRestore(bundle: device.bundle, deviceKey: device.key)
        accountKey = key
        return key
    }

    public func loadWorkspace() async throws -> WorkspaceView {
        if let workspace { return workspace }
        // Kept sealed in the mirror, so a start without network still opens the drive.
        let key = "workspace:\(session.userId)"
        let view: WorkspaceView
        do {
            view = try await api.workspace()
            if let data = try? JSONEncoder().encode(view) { mirror?.putDocument(key, data) }
        } catch DriveAPIError.transport(let message) {
            guard let data = mirror?.document(key), let cached = try? JSONDecoder().decode(WorkspaceView.self, from: data) else { throw DriveAPIError.transport(message) }
            view = cached
        }
        guard let grant = view.grant else { throw DriveAPIError.server(404, "No workspace grant") }
        workspaceKey = try workspaceOpen(userId: session.userId, accountKey: try unlockAccount(), grant: grant.grant)
        workspace = view
        return view
    }

    public func rootId() async throws -> String {
        guard let root = try await loadWorkspace().root else { throw DriveAPIError.notFound("This drive has no root yet.") }
        return root.id
    }

    public func workspaceId() async throws -> String { try await loadWorkspace().workspaceId }

    func workspaceKeyData() -> Data? { workspaceKey }

    /* The identity's private keys, opened once under the account key. */
    func identityKeys() async throws -> IdentityKeys {
        if let identity { return identity }
        let envelope = try await Auth.identity()
        let keys = try identityOpen(userId: session.userId, accountKey: try unlockAccount(), envelope: envelope)
        identity = keys
        return keys
    }

    /* The 24 words again, for someone who holds the account key and wants to check their copy. */
    public func recoveryPhrase() async throws -> String {
        let (envelope, _) = try await Auth.recoveryKey()
        return try HushOSCore.recoveryPhrase(userId: session.userId, accountKey: try unlockAccount(), envelope: envelope)
    }

    /* The workspace a node lives in: a share's subtree belongs to the granter's. */
    public func workspaceId(of nodeId: String) async throws -> String {
        if let known = opened[nodeId] { return known.node.workspaceId }
        return try await loadWorkspace().workspaceId
    }

    func parentKey(for node: NodeView) throws -> Data {
        let parentId = node.parentId ?? node.workspaceId
        if parentId == node.workspaceId {
            guard let workspaceKey else { throw DriveAPIError.server(500, "Workspace not opened") }
            return workspaceKey
        }
        guard let key = nodeKeys[parentId] else { throw DriveAPIError.server(500, "Open the containing folder first.") }
        return key
    }

    /* Opens one node under its parent's key (the workspace key at the root); parents first. */
    @discardableResult
    public func open(_ node: NodeView) throws -> Opened {
        if let done = opened[node.id] { return done }
        let ctx = NodeKeyContext(
            workspaceId: node.workspaceId, nodeId: node.id, parentId: node.parentId ?? node.workspaceId,
            parentKeyEpoch: node.parentKeyEpoch, keyEpoch: node.keyEpoch
        )
        let key = try nodeOpen(ctx: ctx, parentKey: try parentKey(for: node), keyEnvelope: try base64urlDecode(value: node.keyEnvelope))
        nodeKeys[node.id] = key
        let metadata = try metadataOpen(
            ctx: MetadataContext(workspaceId: node.workspaceId, nodeId: node.id, metadataVersion: node.metadataVersion),
            nodeKey: key, envelope: try base64urlDecode(value: node.metadataEnvelope)
        )
        let result = Opened(node: node, metadata: metadata)
        opened[node.id] = result
        return result
    }

    func openChain(_ listing: Listing) throws {
        // Above a share's root the keys are the granter's; those ancestors stay closed.
        for ancestor in listing.ancestors { _ = try? open(ancestor) }
        try open(listing.folder)
        for child in listing.children { try open(child) }
    }

    public func item(_ id: String) -> Opened? { opened[id] }
    public func nodeKey(_ id: String) -> Data? { nodeKeys[id] }

    /* A node the server just returned, opened with a key this process already holds. */
    func adopt(_ node: NodeView, nodeKey key: Data, metadata: NodeMetadata) -> Opened {
        nodeKeys[node.id] = key
        let result = Opened(node: node, metadata: metadata)
        opened[node.id] = result
        if let parent = node.parentId { rememberParent(node.id, parent: parent) }
        return result
    }

    public func forget(_ id: String) {
        opened[id] = nil
    }

    /* Fetches a folder's listing, opening every key along the way; all pages. */
    public func listChildren(of folderId: String) async throws -> Listing {
        let workspaceId = try await workspaceId(of: folderId)
        var after: String? = nil
        var all: [NodeView] = []
        var first: Listing? = nil
        repeat {
            let page = try await api.children(of: folderId, workspaceId: workspaceId, after: after)
            try openChain(page)
            remember(page)
            all.append(contentsOf: page.children)
            first = first ?? page
            after = page.nextCursor
        } while after != nil
        guard let base = first else { throw DriveAPIError.notFound("This folder no longer exists.") }
        return Listing(folder: base.folder, ancestors: base.ancestors, children: all, nextCursor: nil)
    }

    /* A folder's children, opened and sorted folders first. */
    public func children(of folderId: String) async throws -> [Opened] {
        // The catalogue answers first when it can, so a folder draws before the server is asked.
        if let fast = catalogueChildren(of: folderId) { return fast }
        let listing = try await listChildren(of: folderId)
        return listing.children.compactMap { opened[$0.id] }.sorted(by: Opened.byName)
    }

    /* A node this process has not opened yet: listing the folder it was last seen in opens it and everything above. */
    public func resolve(_ nodeId: String) async throws -> Opened {
        if let done = opened[nodeId] { return done }
        let workspace = try await loadWorkspace()
        if let root = workspace.root, root.id == nodeId {
            _ = try await listChildren(of: root.id)
        } else if let parent = parents[nodeId] {
            _ = try await listChildren(of: parent)
        } else {
            throw DriveAPIError.server(500, "This item has not been seen yet; open its folder first.")
        }
        guard let done = opened[nodeId] else { throw DriveAPIError.notFound("This item no longer exists.") }
        return done
    }

    /* The content key and sizes of a file's version (the current one by default). */
    public func openVersion(_ item: Opened, version: VersionListView? = nil) throws -> OpenedVersion {
        guard let nodeKey = nodeKeys[item.node.id] else { throw DriveAPIError.server(500, "Node not opened") }
        let id: String, objectId: String, envelope: String, suite: UInt32, nonce: String, rowSize: String?
        if let version {
            (id, objectId, envelope, suite, nonce, rowSize) = (version.id, version.objectId, version.contentKeyEnvelope, version.contentSuite, version.contentNonce, version.plaintextSize)
        } else if let current = item.node.currentVersion {
            (id, objectId, envelope, suite, nonce, rowSize) = (current.id, current.objectId, current.contentKeyEnvelope, current.contentSuite, current.contentNonce, current.plaintextSize)
        } else {
            throw DriveAPIError.notFound("This file has no content yet.")
        }
        let opened = try HushOSCore.versionOpen(
            ctx: VersionContext(workspaceId: item.node.workspaceId, nodeId: item.node.id, versionId: id, objectId: objectId),
            suite: suite, nodeKey: nodeKey, envelope: try base64urlDecode(value: envelope), rowSize: rowSize.flatMap { UInt64($0) }
        )
        let content = Content(
            workspaceId: item.node.workspaceId, objectId: objectId, suite: suite, key: opened.key,
            nonce: try base64urlDecode(value: nonce), plaintextSize: opened.plaintextSize, thumbnailBytes: opened.thumbnailBytes
        )
        return OpenedVersion(content: content, versionId: id)
    }

    /* Downloads and decrypts a file's version to `destination`, chunk by chunk. */
    public func download(_ nodeId: String, version: VersionListView? = nil, to destination: URL, progress: @Sendable (Double) -> Void = { _ in }) async throws {
        let item = try await resolve(nodeId)
        let opened = try openVersion(item, version: version)
        let url = try await api.versionURL(opened.versionId, workspaceId: item.node.workspaceId)
        guard let objectURL = URL(string: url.url) else { throw DriveAPIError.server(500, "Bad object URL") }
        let layout = opened.layout
        // Written beside the destination and moved into place whole: a download cut off
        // partway never leaves a truncated file that a later open or keep takes as done.
        let partial = destination.appendingPathExtension("part")
        FileManager.default.createFile(atPath: partial.path, contents: nil)
        let handle = try FileHandle(forWritingTo: partial)
        defer { try? handle.close(); try? FileManager.default.removeItem(at: partial) }
        for index in 0 ..< layout.chunkCount {
            try Task.checkCancellation()
            let ciphertext = try await api.range(objectURL, chunkRange(plaintextSize: opened.content.plaintextSize, index: index))
            let plaintext = try chunkDecrypt(content: opened.content, index: index, ciphertext: ciphertext)
            try handle.write(contentsOf: plaintext)
            progress(Double(index + 1) / Double(layout.chunkCount))
        }
        try handle.close()
        if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
        try FileManager.default.moveItem(at: partial, to: destination)
    }

    /* The sealed thumbnail trailer of a file's current version, decrypted; nil when it has none. */
    public func thumbnail(_ nodeId: String) async throws -> Data? {
        let item = try await resolve(nodeId)
        guard item.hasThumbnail, let version = item.node.currentVersion else { return nil }
        let opened = try openVersion(item)
        guard opened.content.thumbnailBytes > 0 else { return nil }
        _ = version
        guard let ciphertext = try await sealedThumbnail(for: item, opened: opened) else { return nil }
        return try thumbnailDecrypt(content: opened.content, ciphertext: ciphertext)
    }

    /* Every page of the trash, opened; items whose parent is also trashed are marked. */
    public func trash() async throws -> [(item: Opened, parentTrashed: Bool)] {
        if let fast = catalogueTrash() { return fast }
        let workspace = try await loadWorkspace()
        var after: String? = nil
        var result: [(Opened, Bool)] = []
        repeat {
            let page = try await api.trashListing(workspaceId: workspace.workspaceId, after: after)
            for entry in page.items {
                for ancestor in entry.ancestors { try? open(ancestor) }
                forget(entry.node.id)
                if let opened = try? open(entry.node) { result.append((opened, entry.parentTrashed)) }
            }
            after = page.nextCursor
        } while after != nil
        return result.map { (item: $0.0, parentTrashed: $0.1) }
    }

    /* The most recently changed files, from the tail of the change feed. */
    public func recents(limit: Int = 60) async throws -> [Opened] {
        if let fast = catalogueRecents(limit: limit) { return fast }
        let workspace = try await loadWorkspace()
        let seq = workspace.changeSeq ?? 0
        let feed = try await api.changes(workspaceId: workspace.workspaceId, since: max(0, seq - 400), limit: 400)
        var latest: [String: NodeView] = [:]
        for change in feed.changes where change.kind == "node" {
            guard let node = change.node, !node.isFolder, node.trashedAt == nil, node.currentVersion != nil else {
                if let id = change.node?.id { latest[id] = nil }
                continue
            }
            latest[node.id] = node
        }
        var items: [Opened] = []
        for node in latest.values {
            if let parent = node.parentId { rememberParent(node.id, parent: parent) }
            forget(node.id)
            if let opened = try? await resolve(node.id) { items.append(opened) }
        }
        return items.sorted { ($0.modified ?? .distantPast) > ($1.modified ?? .distantPast) }.prefix(limit).map { $0 }
    }

    public func versions(of nodeId: String) async throws -> [VersionListView] {
        let item = try await resolve(nodeId)
        return try await api.versions(of: nodeId, workspaceId: item.node.workspaceId)
    }
}

extension Opened {
    public static func byName(_ a: Opened, _ b: Opened) -> Bool {
        if a.isFolder != b.isFolder { return a.isFolder }
        return a.name.localizedStandardCompare(b.name) == .orderedAscending
    }
}
