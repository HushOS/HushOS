import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * Info beside the list must never show a name or a place the item no longer has, nor offer Share,
 * Tags or Move on an item that is gone: trashed itself, or inside a folder trashed here or on
 * another device. Nor may it close on a row only being read again (a key rotation, a catalogue
 * update), which would shut Info under the person's hand. The vault's rows decide it, not the
 * lists' caches: a trashed folder's descendants stay in cached folder lists with no trashedAt of
 * their own, which kept Info open on them.
 */
struct InfoFollowTests {
    let session = SharedKeychain.Session(origin: "https://drive.test", token: "token", userId: UUID().uuidString.lowercased())
    let workspace = UUID().uuidString.lowercased()
    let rootId = UUID().uuidString.lowercased()
    let folderId = UUID().uuidString.lowercased()
    let fileId = UUID().uuidString.lowercased()

    func row(_ id: String, parent: String?, kind: String, parentKey: Data, key: Data, name: String, trashed: String? = nil) throws -> NodeView {
        let ctx = NodeKeyContext(workspaceId: workspace, nodeId: id, parentId: parent ?? workspace, parentKeyEpoch: 1, keyEpoch: 1)
        let metadata = try metadataSeal(ctx: MetadataContext(workspaceId: workspace, nodeId: id, metadataVersion: 1), nodeKey: key,
                                        metadata: NodeMetadata(name: name, mime: nil, size: nil, modified: nil, attributes: [:]))
        return NodeView(id: id, workspaceId: workspace, parentId: parent, kind: kind, keyEpoch: 1, parentKeyEpoch: 1,
                        keyEnvelope: base64urlEncode(bytes: try nodeWrap(ctx: ctx, parentKey: parentKey, nodeKey: key)),
                        metadataVersion: 1, metadataEnvelope: base64urlEncode(bytes: metadata), currentVersion: nil,
                        trashedAt: trashed, changeSeq: 1, createdAt: nil, updatedAt: nil)
    }

    struct Drive {
        let vault: Vault
        let folder: NodeView
        let file: NodeView
        let folderKey: Data
        let fileKey: Data
        let rootKey: Data
    }

    /* The own top folder, a folder in it and a file in that folder, all opened; requests go to DriveStub. */
    func drive() async throws -> Drive {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DriveStub.self]
        let vault = Vault(api: DriveAPI(session: session, configuration: configuration), session: session)
        let workspaceKey = try randomBytes(length: 32), rootKey = try randomBytes(length: 32)
        let folderKey = try randomBytes(length: 32), fileKey = try randomBytes(length: 32)
        let root = try row(rootId, parent: nil, kind: "folder", parentKey: workspaceKey, key: rootKey, name: "Files")
        await vault.adopt(workspace: WorkspaceView(workspaceId: workspace, changeSeq: nil, grant: nil, root: root), key: workspaceKey)
        try await vault.open(root)
        let folder = try row(folderId, parent: rootId, kind: "folder", parentKey: rootKey, key: folderKey, name: "Lisbon 2026")
        try await vault.open(folder)
        let file = try row(fileId, parent: folderId, kind: "file", parentKey: folderKey, key: fileKey, name: "Trip plan.md")
        try await vault.open(file)
        return Drive(vault: vault, folder: folder, file: file, folderKey: folderKey, fileKey: fileKey, rootKey: rootKey)
    }

    func opened(_ drive: Drive) async throws -> (InfoFollow, NodeRef) {
        let item = try #require(await drive.vault.item(fileId))
        return (InfoFollow(item), NodeRef(workspaceId: workspace, nodeId: fileId))
    }

    /* The reported bug: the folder goes to the Trash from here; the file inside it has no trashedAt of its own. */
    @Test func aFileWhoseFolderIsTrashedHereClosesInfo() async throws {
        let drive = try await drive()
        var (follow, ref) = try await opened(drive)
        try await drive.vault.trash(folderId)
        #expect(await drive.vault.standing(of: ref) == .removed)
        #expect(follow.update(await drive.vault.standing(of: ref), outOfReach: false) == .close)
    }

    /* The same folder trashed on another device: the feed brings its row back with trashedAt set. */
    @Test func aFileWhoseFolderIsTrashedElsewhereClosesInfo() async throws {
        let drive = try await drive()
        var (follow, ref) = try await opened(drive)
        await drive.vault.forget(folderId)
        try await drive.vault.open(try row(folderId, parent: rootId, kind: "folder", parentKey: drive.rootKey, key: drive.folderKey,
                                           name: "Lisbon 2026", trashed: "2026-10-30T09:00:00Z"))
        #expect(follow.update(await drive.vault.standing(of: ref), outOfReach: false) == .close)
    }

    @Test func aFileTrashedHereClosesInfo() async throws {
        let drive = try await drive()
        var (follow, ref) = try await opened(drive)
        try await drive.vault.trash(fileId)
        #expect(follow.update(await drive.vault.standing(of: ref), outOfReach: false) == .close)
    }

    /* A rotation or a re-read drops the row before the lists reload: Info keeps what it showed. */
    @Test func aRowOnlyBeingReadAgainKeepsTheLastOneShown() async throws {
        let drive = try await drive()
        var (follow, ref) = try await opened(drive)
        await drive.vault.forget(fileId)
        await drive.vault.forget(folderId)
        #expect(follow.update(await drive.vault.standing(of: ref), outOfReach: false) == .hold)
        #expect(follow.item.name == "Trip plan.md")
    }

    @Test func aRenameShowsTheNewName() async throws {
        let drive = try await drive()
        var (follow, ref) = try await opened(drive)
        await drive.vault.forget(fileId)
        try await drive.vault.open(try row(fileId, parent: folderId, kind: "file", parentKey: drive.folderKey, key: drive.fileKey, name: "Lisbon plan.md"))
        #expect(follow.update(await drive.vault.standing(of: ref), outOfReach: false) == .show)
        #expect(follow.item.name == "Lisbon plan.md")
    }

    /* A removal is a verdict on that row only until the server serves it again (a restore, Undo). */
    @Test func aFolderRestoredAfterItsTrashIsLiveAgain() async throws {
        let drive = try await drive()
        let ref = NodeRef(workspaceId: workspace, nodeId: fileId)
        try await drive.vault.trash(folderId)
        try await drive.vault.open(drive.folder)
        #expect(await drive.vault.standing(of: ref) == .live(try #require(await drive.vault.item(fileId))))
    }

    /* A share stopped or revoked: its workspace is no longer listed, so Info closes even on a row still held. */
    @Test func aWorkspaceOutOfReachClosesInfoOnALiveRow() async throws {
        let drive = try await drive()
        var (follow, ref) = try await opened(drive)
        #expect(follow.update(await drive.vault.standing(of: ref), outOfReach: true) == .close)
    }

    /*
     * A selection to the Trash: the lists let go of the rows first (`moved`) and the vault marks them gone
     * after, so a look at Info from `moved` still finds the file live. Once trashMany returns the removal is
     * recorded, which is when the store looks again; it fails if the mark comes later than that.
     */
    @Test func aSelectionTrashedHereIsRecordedGoneByTheTimeTheBatchReturns() async throws {
        let drive = try await drive()
        let (start, ref) = try await opened(drive)
        var follow = start
        let vault = drive.vault
        let duringMove = Box()
        let outcomes = await vault.trashMany([folderId]) { _ in await duringMove.set(await vault.standing(of: ref)) }
        #expect(outcomes.count == 1)
        #expect(await duringMove.value == .live(start.item))
        #expect(await vault.standing(of: ref) == .removed)
        #expect(follow.update(await vault.standing(of: ref), outOfReach: false) == .close)
    }

    /* A received share: its top folder `shareRoot`, a file and a subfolder in it, opened from a listing. */
    struct Share {
        let vault: Vault
        let workspace: String
        let root: NodeView
        let file: NodeView
        let sub: NodeView
        let key: Data
    }

    func share() async throws -> Share {
        let drive = try await drive()
        let theirs = UUID().uuidString.lowercased(), granter = try randomBytes(length: 32), key = try randomBytes(length: 32)
        let shareRoot = UUID().uuidString.lowercased(), file = UUID().uuidString.lowercased(), sub = UUID().uuidString.lowercased()
        func sealed(_ id: String, parent: String?, kind: String, parentKey: Data, key: Data, name: String) throws -> NodeView {
            let ctx = NodeKeyContext(workspaceId: theirs, nodeId: id, parentId: parent ?? theirs, parentKeyEpoch: 1, keyEpoch: 1)
            let metadata = try metadataSeal(ctx: MetadataContext(workspaceId: theirs, nodeId: id, metadataVersion: 1), nodeKey: key,
                                            metadata: NodeMetadata(name: name, mime: nil, size: nil, modified: nil, attributes: [:]))
            return NodeView(id: id, workspaceId: theirs, parentId: parent, kind: kind, keyEpoch: 1, parentKeyEpoch: 1,
                            keyEnvelope: base64urlEncode(bytes: try nodeWrap(ctx: ctx, parentKey: parentKey, nodeKey: key)),
                            metadataVersion: 1, metadataEnvelope: base64urlEncode(bytes: metadata), currentVersion: nil,
                            trashedAt: nil, changeSeq: 1, createdAt: nil, updatedAt: nil)
        }
        let root = try sealed(shareRoot, parent: nil, kind: "folder", parentKey: granter, key: key, name: "Shared to me")
        _ = try await drive.vault.adopt(root, nodeKey: key, metadata: NodeMetadata(name: "Shared to me", mime: nil, size: nil, modified: nil, attributes: [:]), in: theirs)
        let fileRow = try sealed(file, parent: shareRoot, kind: "file", parentKey: key, key: try randomBytes(length: 32), name: "Menu.pdf")
        let subRow = try sealed(sub, parent: shareRoot, kind: "folder", parentKey: key, key: try randomBytes(length: 32), name: "Photos")
        DriveStub.list(shareRoot, Listing(folder: root, ancestors: [], children: [fileRow, subRow], nextCursor: nil))
        DriveStub.list(sub, Listing(folder: subRow, ancestors: [root], children: [], nextCursor: nil))
        _ = try await drive.vault.children(of: shareRoot)
        return Share(vault: drive.vault, workspace: theirs, root: root, file: fileRow, sub: subRow, key: key)
    }

    /*
     * A file in a received share, trashed on the granter's device: there is no feed here for their drive,
     * so the share's folder listed again without it is the server's word that it is gone. Fails if the
     * re-list leaves the earlier row standing, which kept Info open on it while the share existed.
     */
    @Test func aSharesFileMissingFromItsFolderListedAgainClosesInfo() async throws {
        let share = try await share()
        let ref = NodeRef(workspaceId: share.workspace, nodeId: share.file.id)
        var follow = InfoFollow(try #require(await share.vault.item(share.file.id)))
        DriveStub.list(share.root.id, Listing(folder: share.root, ancestors: [], children: [share.sub], nextCursor: nil))
        _ = try await share.vault.children(of: share.root.id)
        #expect(follow.update(await share.vault.standing(of: ref), outOfReach: false) == .close)
    }

    /* Another folder's listing says nothing about the file: Info stays on it. */
    @Test func anotherFolderListedAgainKeepsInfoOpen() async throws {
        let share = try await share()
        let ref = NodeRef(workspaceId: share.workspace, nodeId: share.file.id)
        var follow = InfoFollow(try #require(await share.vault.item(share.file.id)))
        _ = try await share.vault.children(of: share.sub.id)
        #expect(follow.update(await share.vault.standing(of: ref), outOfReach: false) == .show)
        #expect(follow.item.name == "Menu.pdf")
    }

    /* Android's rule, case by case (ui/Adaptive.kt `infoLookup`): the clients close Info on the same events. */
    @Test func theRuleIsAndroidsRule() {
        #expect(InfoLookup.decide(live: true, held: false, removed: true, outOfReach: false, seen: true) == .close)
        #expect(InfoLookup.decide(live: true, held: false, removed: false, outOfReach: false, seen: false) == .show)
        #expect(InfoLookup.decide(live: false, held: true, removed: false, outOfReach: false, seen: true) == .close)
        #expect(InfoLookup.decide(live: false, held: false, removed: false, outOfReach: false, seen: true) == .hold)
        #expect(InfoLookup.decide(live: false, held: false, removed: false, outOfReach: false, seen: false) == .find)
    }
}

actor Box {
    var value: RowStanding?
    func set(_ standing: RowStanding) { value = standing }
}

/*
 * The Drive routes these tests use: POST /nodes/<id>/trash answers that node trashed, POST
 * /workspaces/<ws>/trash-batch answers every id trashed, and GET /nodes/<id>/children answers the
 * listing a test set for that folder (`list`); each test uses its own ids, so they run side by side.
 */
final class DriveStub: URLProtocol {
    nonisolated(unsafe) private static var listings: [String: Data] = [:]
    private static let lock = NSLock()

    static func list(_ folderId: String, _ listing: Listing) {
        let data = try? JSONEncoder().encode(listing)
        lock.withLock { listings[folderId.lowercased()] = data }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    private func body() -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            stream.close()
        }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    override func startLoading() {
        let parts = request.url?.path.split(separator: "/").map(String.init) ?? []
        var reply: Data?
        if parts.last == "trash", parts.count >= 2 {
            let node: [String: Any] = [
                "id": parts[parts.count - 2], "workspaceId": "w", "parentId": NSNull(), "kind": "folder", "keyEpoch": 1, "parentKeyEpoch": 1,
                "keyEnvelope": "", "metadataVersion": 1, "metadataEnvelope": "", "currentVersion": NSNull(),
                "trashedAt": "2026-10-30T09:00:00Z", "changeSeq": 2, "createdAt": NSNull(), "updatedAt": NSNull(),
            ]
            reply = try? JSONSerialization.data(withJSONObject: ["node": node])
        } else if parts.last == "trash-batch" {
            let ids = body()["nodeIds"] as? [String] ?? []
            let results = ids.map { ["id": $0, "status": "trashed", "trashedAt": "2026-10-30T09:00:00Z", "changeSeq": 2] as [String: Any] }
            reply = try? JSONSerialization.data(withJSONObject: ["results": results])
        } else if parts.last == "children", parts.count >= 2 {
            reply = Self.lock.withLock { Self.listings[parts[parts.count - 2].lowercased()] }
        }
        guard let reply else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
