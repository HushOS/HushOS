import Foundation

/* A node with its metadata opened: what every list, row and Files item is built from. */
public struct Opened: Sendable, Identifiable, Hashable {
    public let node: NodeView
    public let metadata: NodeMetadata
    /* The current version's size from its own envelope (suite 2) or row (suite 1). */
    public var contentSize: UInt64?
    public var id: String { node.id }
    public var name: String { metadata.name }
    public var isFolder: Bool { node.isFolder }

    init(node: NodeView, metadata: NodeMetadata, nodeKey: Data?) {
        self.node = node
        self.metadata = metadata
        self.contentSize = nodeKey.flatMap { Opened.contentSize(of: node, nodeKey: $0) }
    }

    /*
     * The current version's size, as the web's contentSize does: the metadata's size
     * belongs to the newest upload, so after an earlier version is restored it is wrong.
     */
    public var size: UInt64? {
        if isFolder { return nil }
        if let contentSize { return contentSize }
        if let text = node.currentVersion?.plaintextSize, let value = UInt64(text) { return value }
        return metadata.size
    }

    /* Metadata written for another version than the current one: a restore since the last upload. */
    var metadataIsStale: Bool {
        guard let contentSize, let sealed = metadata.size else { return false }
        return contentSize != sealed
    }

    /* When the file last changed: the uploaded file's own date, or the restore's when an earlier version came back. */
    public var modified: Date? {
        if metadataIsStale { return parseDate(node.updatedAt) ?? parseDate(metadata.modified) }
        return parseDate(metadata.modified) ?? parseDate(node.updatedAt)
    }

    /* When it last changed in HushOS (an upload, a rename, a move), whatever the file's own date: what Recent goes by, as on the web. */
    public var changed: Date? { parseDate(node.updatedAt) }

    static func contentSize(of node: NodeView, nodeKey: Data) -> UInt64? {
        guard let current = node.currentVersion else { return nil }
        if let text = current.plaintextSize, let value = UInt64(text) { return value }
        guard let envelope = try? base64urlDecode(value: current.contentKeyEnvelope) else { return nil }
        let opened = try? HushOSCore.versionOpen(
            ctx: VersionContext(workspaceId: node.workspaceId, nodeId: node.id, versionId: current.id, objectId: current.objectId),
            suite: current.contentSuite, nodeKey: nodeKey, envelope: envelope, rowSize: nil
        )
        return opened?.plaintextSize
    }
    /* Suites 2 and 3 carry the thumbnail as a trailer of the object; suite 1 never had one. */
    public var hasThumbnail: Bool { !isFolder && (node.currentVersion?.contentSuite ?? 0) >= 2 }
}

public struct OpenedVersion: Sendable {
    public let content: Content
    public let versionId: String
    /* The object's layout by its own suite: under 3 the chunks run past the file into the padding. */
    public var layout: ContentLayout {
        get throws { try contentLayout(suite: content.suite, plaintextSize: content.plaintextSize, thumbnailBytes: content.thumbnailBytes) }
    }

    /* The bytes to fetch for chunk `index`; the last runs to the end of the object, padding and trailer included. */
    public func range(_ index: UInt64) throws -> ByteRange {
        try chunkRange(suite: content.suite, plaintextSize: content.plaintextSize, thumbnailBytes: content.thumbnailBytes, index: index)
    }
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
    var workspace: WorkspaceView? {
        didSet { nodeKeys.own = workspace?.workspaceId; opened.own = workspace?.workspaceId }
    }
    private var workspaceKey: Data?
    /* By workspace and node (see NodeTable): a received share's key never answers for one of the account's own nodes. */
    var nodeKeys = NodeTable<Data>()
    var opened = NodeTable<Opened>()
    /*
     * Rows the server confirmed gone (trashed from here, a feed tombstone, a purge), by workspace and
     * node: `remove`, never `forget`, which only drops a row to be read again. Info beside the list
     * closes on these (RowStanding); a row opened again (a restore, a sync) is no longer gone.
     */
    var removedRows = Set<NodeRef>()
    /* The identity in use, and the earlier ones (newest first) that shares sealed before a succession still need; see Vault+Identity. */
    var identity: IdentityKeys?
    var earlierIdentities: [IdentityKeys]?
    /* The envelope `identity` was opened from, as served: what a later serving is compared with (see signingSeed). */
    var identityEnvelope: IdentityEnvelope?
    /* When the identity in use was last compared with the one the server serves (see signingSeed). */
    var identityCheckedAt: Date?
    /* The identity being opened (and upgraded), so callers that arrive meanwhile wait for it instead of upgrading twice. */
    var openingIdentity: Task<IdentityKeys, Error>?
    /* Raised by `forgetIdentity`: an open that began before it neither caches nor returns what it opened. */
    var identityGeneration: UInt64 = 0
    /* The settings key, opened under the account key (see Settings). */
    var settingsKey: Data?
    /* The envelope `settingsKey` came out of, as the server keeps it: kept beside the rollback marks. */
    var settingsKeyEnvelope: SettingsKeyEnvelope?
    /* The contact guard (ContactGuard.swift): the app group's for this session, or a test's own. */
    var guardStore: ContactGuardStore?
    /* The settings key the guard is sealed under, resolved at the start of each guard turn. */
    var guardKey: MarksKey?
    /* The guard's turn (`withGuardTurn`): whether an act holds it, and who waits for it, in order. */
    var guardBusy = false
    var guardWaiting: [CheckedContinuation<Void, Never>] = []
    /* People found changed this session (`accountChanges`), by lowercased id. */
    var noticedChanges: [String: AccountChange] = [:]
    /* The pins as the last settings read had them (see `knownPins`). */
    var lastPins: [String: ContactPin] = [:]
    /* Whose signatures this person can check, built from the identities and the verified pins (see Integrity); a load that fails is not kept. */
    var trustedSigners: TrustedSigners?
    /* Raised by `forgetSigners` (and so by `forgetIdentity`): a set built from what was forgotten meanwhile is not kept. */
    var signersGeneration: UInt64 = 0
    var parents: [String: String]
    private let indexURL: URL?
    /* The tree mirror on disk and the catalogue built from it (see Vault+Catalogue). */
    let mirror: Mirror?
    public var catalogueState: CatalogueState = .idle
    /* The catalogue holds what the server sent this session, not only what the phone had: a node missing from it is gone. */
    var cataloguePulled = false
    var catalogueChildren: [String: Set<String>] = [:]
    /* The build in flight, so a second caller waits for it rather than returning before it is done. */
    var catalogueBuilding: Task<Bool, Never>?
    /* Which workspace a node not opened yet lives in, when the caller knows (a kept folder in a share, after a relaunch). */
    var workspaceHints: [String: String] = [:]
    public func hint(workspace: String, for nodeId: String) { workspaceHints[nodeId] = workspace }

    /* The top folder being made, so callers that arrive meanwhile wait for it instead of making a second. */
    var makingRoot: Task<WorkspaceView, Error>?

    /*
     * The family write rules and keys (the core's `AreaLedger`, one per unlocked session in this
     * process): every family folder node opens through it, so a family folder is read only under
     * a member list the core accepted (FamilySync), and every write there takes its keys from it.
     */
    public nonisolated let areaLedger = AreaLedger()
    /* Every family folder route 25 named this session, lowercased: refused by the personal key path whatever the ledger holds. */
    var familyWorkspaces: Set<String> = []
    /* The family's sync, for the forms family records are signed again with (weak: it holds this vault). */
    weak var familyJudge: (any FamilyJudge)?

    public init(api: DriveAPI, session: SharedKeychain.Session) {
        self.api = api
        self.session = session
        // In the group's `local` folder, which is out of backups however these files are rewritten.
        let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedKeychain.accessGroup).map { _ in Unbacked.local }
        indexURL = container?.appendingPathComponent("files-parents.json")
        mirror = container.flatMap { Mirror(url: $0.appendingPathComponent("mirror.sqlite")) }
        if let indexURL, let data = try? Data(contentsOf: indexURL),
           let saved = try? JSONDecoder().decode([String: String].self, from: data) {
            parents = saved
        } else {
            parents = [:]
        }
    }

    /*
     * The vault of the keychain's session: one per session per process, whoever asks (the app's
     * model, the background queue, an extension). Two vaults for one session would hold two area
     * ledgers and, through `FamilySync.shared(for:)`, two family syncs, so a join, a sync and a
     * queued family upload would no longer take turns per family.
     */
    public static func fromKeychain() -> Vault? {
        guard let session = SharedKeychain.session else { return nil }
        return current.vault(for: session)
    }

    /* Sign-out, deletion, a removed device: the session's vault (and the keys it holds) is let go. */
    public static func forgetCurrent() { current.forget() }

    static let current = Current()

    final class Current: @unchecked Sendable {
        private let lock = NSLock()
        private var held: Vault?

        func vault(for session: SharedKeychain.Session) -> Vault {
            lock.withLock {
                if let held, held.session == session { return held }
                let made = Vault(api: DriveAPI(session: session), session: session)
                held = made
                return made
            }
        }

        func forget() { lock.withLock { held = nil } }
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

    /* Family folder ids leave the index on disk when their family is forgotten here. */
    func forgetParents(_ ids: Set<String>) {
        guard !ids.isEmpty else { return }
        let before = parents.count
        parents = parents.filter { !ids.contains($0.key.lowercased()) && !ids.contains($0.value.lowercased()) }
        if parents.count != before { saveIndex() }
    }

    func rememberParent(_ id: String, parent: String) {
        guard parents[id] != parent else { return }
        parents[id] = parent
        saveIndex()
    }

    func unlockAccount() throws -> Data {
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
        // An account that never opened Drive has no top folder yet: made here, once, for the app,
        // the Files app and background transfers alike, as the web makes it on first open.
        let ready = try await ensureRoot(view)
        if ready.root != view.root, let data = try? JSONEncoder().encode(ready) { mirror?.putDocument(key, data) }
        workspace = ready
        return ready
    }

    /* The web's ROOT_NAME (packages/drive/src/protocol.ts): what the top folder's sealed metadata says. */
    static let rootName = "Drive"

    /*
     * The top folder of a workspace that has none: a node under the workspace key at a
     * freshly allocated epoch, sealed as the web seals it. The server settles a race
     * between devices and returns the root that won, which is the one adopted.
     */
    func ensureRoot(_ view: WorkspaceView) async throws -> WorkspaceView {
        guard view.root == nil else { return view }
        if let makingRoot { return try await makingRoot.value }
        let task = Task { try await self.makeRoot(view) }
        makingRoot = task
        defer { makingRoot = nil }
        return try await task.value
    }

    private func makeRoot(_ view: WorkspaceView) async throws -> WorkspaceView {
        guard let grant = view.grant, let workspaceKey else { throw DriveAPIError.server(404, "No workspace grant") }
        let epochs = try await api.allocateEpochs(workspaceId: view.workspaceId, count: 1)
        let minted = try mint(.node, in: view.workspaceId)
        let id = minted.id
        let key = try randomBytes(length: 32)
        let parentKeyEpoch = grant.workspaceKeyVersion
        let ctx = NodeKeyContext(workspaceId: view.workspaceId, nodeId: id, parentId: view.workspaceId, parentKeyEpoch: parentKeyEpoch, keyEpoch: epochs.from)
        let wrapped = try nodeWrap(ctx: ctx, parentKey: workspaceKey, nodeKey: key)
        let sealed = try metadataSeal(
            ctx: MetadataContext(workspaceId: view.workspaceId, nodeId: id, metadataVersion: 1), nodeKey: key,
            metadata: NodeMetadata(name: Self.rootName, mime: nil, size: nil, modified: nil, attributes: [:])
        )
        let signature = try await signMetadata(workspaceId: view.workspaceId, nodeId: id, kind: .folder, version: 1, envelope: sealed)
        let made = try await api.createRoot(workspaceId: view.workspaceId, root: [
            "id": id, "idSeed": minted.seed, "keyEpoch": epochs.from, "parentKeyEpoch": parentKeyEpoch,
            "keyEnvelope": base64urlEncode(bytes: wrapped), "metadataEnvelope": base64urlEncode(bytes: sealed),
            "metadataSignature": signature,
        ])
        return WorkspaceView(workspaceId: view.workspaceId, changeSeq: view.changeSeq, grant: view.grant, root: made.root)
    }

    public func rootId() async throws -> String {
        guard let root = try await loadWorkspace().root else { throw DriveAPIError.notFound("This drive has no root yet.") }
        return root.id
    }

    public func workspaceId() async throws -> String { try await loadWorkspace().workspaceId }

    func workspaceKeyData() -> Data? { workspaceKey }

    /* Tests: a workspace already opened, without the account key from this device's keychain. */
    func adopt(workspace view: WorkspaceView, key: Data) {
        workspace = view
        workspaceKey = key
    }

    /*
     * The identity's private keys, opened once under the account key. An identity served as
     * current with a lower key version than this device has opened is refused: those are keys
     * the account replaced, and a server handing them back wants them used again. So is a
     * version 1 identity once this device has opened version 2 (see `IdentityMarks`).
     *
     * A version 1 identity is upgraded here, before anything is signed with it
     * (docs/identity-pq-design.md 2): the core adds an ML-DSA key (re-opening the wrapped seed
     * and refusing one that does not open) and signs the keys statement; the server stores it
     * in place, and a device that lost the race to another (409) opens the one stored.
     */
    func identityKeys() async throws -> IdentityKeys {
        while true {
            if let identity { return identity }
            let generation = identityGeneration
            let task: Task<IdentityKeys, Error>
            if let openingIdentity {
                task = openingIdentity
            } else {
                task = Task { try await self.openIdentity(generation: generation) }
                openingIdentity = task
            }
            let result = await task.result
            if openingIdentity == task { openingIdentity = nil }
            // Forgotten while it opened (a succession, another device's): what it read may be the replaced identity.
            guard generation == identityGeneration else { continue }
            return try result.get()
        }
    }

    /*
     * Forgets the identity in use and the earlier ones, and invalidates an open already under
     * way: on the actor, where opening and caching happen, so an open that read the identity
     * before it was replaced never caches it again.
     */
    func forgetIdentity() {
        identityGeneration &+= 1
        openingIdentity = nil
        identity = nil
        identityEnvelope = nil
        earlierIdentities = nil
        forgetSigners()
    }

    private func openIdentity(generation: UInt64) async throws -> IdentityKeys {
        let marks = RollbackMarkStore.shared(session: session.token)
        let accountKey = try unlockAccount()
        var envelope = try await Auth.identity(as: session)
        let seen = try await marks.read(userId: session.userId, keys: marksKeys())
        try IdentityMarks.check(seen, keyVersion: envelope.keyVersion, identityVersion: envelope.version)
        var keys = try identityOpen(userId: session.userId, accountKey: accountKey, envelope: envelope)
        if keys.identityVersion == 1 {
            let upgraded = try identityUpgrade(userId: session.userId, accountKey: accountKey, envelope: envelope)
            do {
                envelope = try await Auth.upgradeIdentity(upgraded, as: session)
            } catch AuthError.conflict {
                // Another device upgraded first: open the identity it stored, never a second ML-DSA key.
                envelope = try await Auth.identity(as: session)
            }
            keys = try identityOpen(userId: session.userId, accountKey: accountKey, envelope: envelope)
        }
        guard keys.identityVersion >= 2, keys.mlDsaPublicKey != nil, keys.kemPublicKey != nil else {
            throw AuthError.message("Your keys couldn’t be upgraded. Try again.")
        }
        // The stored identity must still be the one this device has used: same keys, version not lowered. Read
        // again, since the upgrade waited on the server while another process could raise a mark.
        try IdentityMarks.check(try await marks.read(userId: session.userId, keys: marksKeys()), keyVersion: keys.keyVersion, identityVersion: keys.identityVersion)
        // Kept before the identity is: one whose mark could not be kept is not taken. A settings mark an
        // earlier version kept under this identity's key becomes the account's in the same write.
        let kept = try await marks.raise(
            userId: session.userId,
            to: RollbackMarks(settings: 0, settingsDocument: false, identity: keys.keyVersion, identityVersion: UInt64(keys.identityVersion)),
            encryptionPublicKeys: [keys.encryptionPublicKey],
            keys: marksKeys()
        )
        // And against what the write found, for a mark raised between that read and this write.
        try IdentityMarks.check(kept, keyVersion: keys.keyVersion, identityVersion: keys.identityVersion)
        // Replaced while this opened: the caller opens again rather than cache what this read.
        guard generation == identityGeneration else { return keys }
        identity = keys
        identityEnvelope = envelope
        identityCheckedAt = Date()
        return keys
    }

    /* Opens (and on the first unlock after the post-quantum release, upgrades) the identity, before anything is written. */
    public func prepareIdentity() async throws {
        _ = try await identityKeys()
    }

    /* Tests: the account key, without this device's keychain. */
    func adopt(accountKey key: Data) { accountKey = key }

    /* Tests: an identity already opened, without the account key from this device's keychain. */
    func adopt(identity keys: IdentityKeys, earlier: [IdentityKeys] = [], envelope: IdentityEnvelope? = nil) {
        identity = keys
        identityEnvelope = envelope
        identityCheckedAt = Date()
        earlierIdentities = earlier
        forgetSigners()
    }

    /* The 24 words again, for someone who holds the account key and wants to check their copy. */
    public func recoveryPhrase() async throws -> String {
        let (envelope, _) = try await Auth.recoveryKey(as: session)
        return try HushOSCore.recoveryPhrase(userId: session.userId, accountKey: try unlockAccount(), envelope: envelope)
    }

    /* The workspace a node lives in: a share's subtree belongs to the granter's. */
    public func workspaceId(of nodeId: String) async throws -> String {
        if let known = opened[nodeId] { return known.node.workspaceId }
        if let hinted = workspaceHints[nodeId] { return hinted }
        return try await loadWorkspace().workspaceId
    }

    func parentKey(for node: NodeView) throws -> Data {
        // A family folder's keys come from the area ledger alone (see `open`): never under a key cached here.
        if areaLedger.isArea(workspaceId: node.workspaceId) || familyWorkspaces.contains(node.workspaceId.lowercased()) {
            throw DriveAPIError.server(500, FamilyWords.openAgain)
        }
        let parentId = node.parentId ?? node.workspaceId
        if parentId == node.workspaceId {
            // The workspace key is this account's own: it opens only its own top folder.
            guard let workspaceKey, node.workspaceId.lowercased() == workspace?.workspaceId.lowercased() else {
                throw DriveAPIError.server(500, "Workspace not opened")
            }
            return workspaceKey
        }
        // The parent in the node's own workspace, exactly: never a same-id node of another.
        guard let key = nodeKeys[NodeRef(workspaceId: node.workspaceId, nodeId: parentId)] else {
            throw DriveAPIError.server(500, "Open the containing folder first.")
        }
        return key
    }

    /*
     * Opens one node under its parent's key (the workspace key at the root); parents first. A
     * node in a family folder opens only through the area ledger, which holds what its path is
     * rooted at and refuses a top level whose key is not the one the member list committed to.
     */
    @discardableResult
    public func open(_ node: NodeView) throws -> Opened {
        let family = areaLedger.isArea(workspaceId: node.workspaceId) || familyWorkspaces.contains(node.workspaceId.lowercased())
        // A family folder row served differently (a walk re-keyed it, its root moved to the next key) opens through the ledger
        // again, so what the ledger holds of its path is what the server serves now, never what this process saw first.
        if let done = opened[node.ref], !family || done.node == node { return done }
        try node.checkEnvelopeSuite()
        let key: Data
        if family {
            // A family shown differently or refused since: the ledger holds its keys back until it is accepted again.
            key = try areaLedger.openListedNode(workspaceId: node.workspaceId, node: node.servedKey())
        } else {
            let ctx = NodeKeyContext(
                workspaceId: node.workspaceId, nodeId: node.id, parentId: node.parentId ?? node.workspaceId,
                parentKeyEpoch: node.parentKeyEpoch, keyEpoch: node.keyEpoch
            )
            key = try nodeOpen(ctx: ctx, parentKey: try parentKey(for: node), keyEnvelope: try base64urlDecode(value: node.keyEnvelope))
        }
        nodeKeys[node.ref] = key
        let metadata = try metadataOpen(
            ctx: MetadataContext(workspaceId: node.workspaceId, nodeId: node.id, metadataVersion: node.metadataVersion),
            nodeKey: key, envelope: try base64urlDecode(value: node.metadataEnvelope)
        )
        let result = Opened(node: node, metadata: metadata, nodeKey: key)
        opened[node.ref] = result
        removedRows.remove(node.ref)
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
    /* The key of exactly this item, in its own workspace. */
    func nodeKey(of item: Opened) -> Data? { nodeKeys[item.ref] }

    /*
     * A node the server just returned, opened with a key this process already holds, for a
     * write into `workspaceId` (the parent's): a reply naming another workspace is refused,
     * or a key made for one drive would be filed under the other.
     */
    func adopt(_ node: NodeView, nodeKey key: Data, metadata: NodeMetadata, in workspaceId: String) throws -> Opened {
        guard node.workspaceId.lowercased() == workspaceId.lowercased() else {
            throw DriveAPIError.server(500, "HushOS answered for a different drive.")
        }
        try node.checkEnvelopeSuite()
        let previous = opened[node.ref]?.node.parentId
        nodeKeys[node.ref] = key
        let result = Opened(node: node, metadata: metadata, nodeKey: key)
        opened[node.ref] = result
        removedRows.remove(node.ref)
        if let parent = node.parentId { rememberParent(node.id, parent: parent) }
        /*
         * A write the server answered (a move, a copy, a new folder) is filed in the catalogue
         * now, under its new parent and out of its old one. Waiting for the feed was not enough:
         * by then `opened` already held the new parent, so the sync never saw a move and the
         * item stayed listed in the folder it left.
         */
        if let previous, previous != node.parentId { catalogueChildren[previous]?.remove(node.id) }
        if let parent = node.parentId, node.workspaceId == workspace?.workspaceId, catalogueState == .ready {
            catalogueChildren[parent, default: []].insert(node.id)
        }
        return result
    }

    /* Drops a row to be read again: no verdict on whether it still exists. */
    public func forget(_ id: String) {
        opened.remove(id: id)
    }

    /*
     * Drops a row the server confirmed gone, and marks it so (`removedRows`): exactly that workspace's row,
     * never another workspace's row under the same id (a share's node id is the server's to pick).
     */
    func remove(_ ref: NodeRef) {
        removedRows.insert(ref)
        opened[ref] = nil
    }

    /* `remove` by id: in `workspaceId` when known, else the workspace this process holds the id in (its own first). */
    func remove(_ id: String, in workspaceId: String? = nil) {
        guard let ref = workspaceId.map({ NodeRef(workspaceId: $0, nodeId: id) }) ?? opened.ref(for: id)
                ?? workspace.map({ NodeRef(workspaceId: $0.workspaceId, nodeId: id) }) else { return }
        remove(ref)
    }

    /*
     * Where a row stands now, for Info beside the list (InfoFollow): live with its current record;
     * held but not live (trashed, or a trashed folder above it in its own workspace); removed (it, or
     * a folder above it, confirmed gone); or absent (dropped to be read again, or never opened here).
     */
    public func standing(of ref: NodeRef) -> RowStanding {
        if removedRows.contains(ref) { return .removed }
        guard let row = opened[ref] else { return .absent }
        var cursor = row
        for _ in 0 ..< 256 {
            if cursor.node.trashedAt != nil { return .held }
            guard let parentId = cursor.node.parentId else { break }
            let parent = NodeRef(workspaceId: ref.workspaceId, nodeId: parentId)
            if removedRows.contains(parent) { return .removed }
            // A folder above that this process doesn't hold (above a share's root, or being read again): no verdict.
            guard let next = opened[parent] else { break }
            cursor = next
        }
        return .live(row)
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
        return listing.children.compactMap { opened[$0.ref] }.sorted(by: Opened.byName)
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
        guard let nodeKey = nodeKeys[item.ref] else { throw DriveAPIError.server(500, "Node not opened") }
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
        guard var objectURL = URL(string: url.url) else { throw DriveAPIError.server(500, "Bad object URL") }
        // Resumable: a dropped chunk is fetched again, an expired address renewed, and a `.part`
        // an earlier try left is continued from its last whole chunk; it moves into place whole.
        // Every chunk, the padding's too, so the fetches never tell the store where the file ends;
        // the core hands back only the file's bytes (none for a chunk of padding alone).
        let layout = try opened.layout
        try await Resumable.download(
            to: destination, count: layout.chunkCount, chunkBytes: layout.chunkBytes, size: opened.content.plaintextSize,
            onExpired: { if let fresh = URL(string: (try await api.versionURL(opened.versionId, workspaceId: item.node.workspaceId)).url) { objectURL = fresh } },
            progress: progress
        ) { index in
            let ciphertext = try await api.range(objectURL, try opened.range(index))
            return try chunkDecrypt(content: opened.content, index: index, ciphertext: ciphertext)
        }
    }

    /* The sealed thumbnail trailer of a file's current version, decrypted; nil when it has none. */
    public func thumbnail(_ nodeId: String) async throws -> Data? {
        try await thumbnail(of: try await resolve(nodeId))
    }

    /*
     * The same for a row the caller already holds (a list's), never looked up again: a row a
     * batch just forgot, still on screen for a moment, would otherwise list its folder once more.
     * Its key outlives the forget (`forget` drops only the opened row).
     */
    public func thumbnail(of item: Opened) async throws -> Data? {
        guard item.hasThumbnail, item.node.currentVersion != nil else { return nil }
        let opened = try openVersion(item)
        guard opened.content.thumbnailBytes > 0 else { return nil }
        guard let ciphertext = try await sealedThumbnail(for: item, opened: opened) else { return nil }
        return try thumbnailDecrypt(content: opened.content, fetched: ciphertext)
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
        return items.sorted(by: Opened.byRecent).prefix(limit).map { $0 }
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

    /*
     * Recent: newest first; things changed in the same moment by name, then id, as the web orders
     * them, so the list never reshuffles between loads.
     */
    public static func byRecent(_ a: Opened, _ b: Opened) -> Bool {
        let (x, y) = (a.changed ?? .distantPast, b.changed ?? .distantPast)
        if x != y { return x > y }
        let names = a.name.localizedCompare(b.name)
        if names != .orderedSame { return names == .orderedAscending }
        return a.id < b.id
    }

    /* Newest in the trash first, as the server lists it; the id breaks ties so the order holds between loads. */
    public static func byTrashed(_ a: Opened, _ b: Opened) -> Bool {
        let (x, y) = (a.node.trashedAt ?? "", b.node.trashedAt ?? "")
        return x != y ? x > y : a.id < b.id
    }
}
