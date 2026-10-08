import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * Turning a link off or stopping a share rotates the keys under that item. What the
 * device already listed outside the rotated subtree must stay listed: emptying every
 * cached folder left Files on its loading skeleton for good. Runs the real rotation
 * against a small in-memory Drive server.
 */
/* Suites that talk to the one FakeDrive (`FakeDrive.current`) run one at a time. */
@Suite(.serialized) enum OnFakeDrive {}

extension OnFakeDrive {
@Suite struct RotationTests {
    @Test func rotationForgetsOnlyTheSubtreeAndMarksTheCatalogueForRebuild() async throws {
        let server = try FakeDrive()
        FakeDrive.current = server
        let vault = Vault(api: DriveAPI(session: server.session, configuration: FakeDrive.configuration), session: server.session)
        await vault.adopt(workspace: WorkspaceView(workspaceId: server.workspace, changeSeq: nil, grant: nil, root: server.nodes[server.root]), key: server.workspaceKey)

        // What Files had on screen: the root, the shared folder A and the untouched folder B.
        _ = try await vault.listChildren(of: server.root)
        _ = try await vault.listChildren(of: server.a)
        _ = try await vault.listChildren(of: server.b)
        await vault.markCatalogueReady()
        let oldFileKey = try #require(await vault.nodeKey(server.f))

        let rotated = try await vault.rotate(try #require(await vault.item(server.a)))
        #expect(rotated == 2)

        // The server now holds A and F at the new epoch; nothing outside the subtree changed.
        #expect(server.nodes[server.a]?.keyEpoch == 2)
        #expect(server.nodes[server.f]?.keyEpoch == 2)
        #expect(server.nodes[server.b]?.keyEpoch == 1)
        #expect(server.nodes[server.g]?.keyEpoch == 1)

        // Outside the subtree the opened items survive, so their folders keep listing.
        #expect(await vault.item(server.root) != nil)
        #expect(await vault.item(server.b) != nil)
        #expect(await vault.item(server.g)?.name == "g.txt")
        // Inside it, the stale items are dropped so they are read again under the fresh keys.
        #expect(await vault.item(server.a) == nil)
        #expect(await vault.item(server.f) == nil)
        // The catalogue is marked for a rebuild from the feed, not emptied in the meantime.
        #expect(await vault.catalogueState == .idle)
        #expect(await vault.catalogueChildren[server.root] == [server.a, server.b])
        #expect(await vault.catalogueChildren[server.b] == [server.g])

        // Read again, the rotated file opens under its new key with its name intact.
        let listing = try await vault.listChildren(of: server.a)
        #expect(listing.children.map(\.id) == [server.f])
        #expect(await vault.item(server.f)?.name == "f.txt")
        let newFileKey = try #require(await vault.nodeKey(server.f))
        #expect(newFileKey != oldFileKey)
    }
}
}

extension Vault {
    /* As a finished catalogue build leaves it: every opened folder's children filed. */
    func markCatalogueReady() {
        catalogueChildren = [:]
        for item in opened.values {
            if let parent = item.node.parentId { catalogueChildren[parent, default: []].insert(item.id) }
        }
        catalogueState = .ready
    }
}

/*
 * A Drive server with five nodes: root ─ A (rotated) ─ F, and root ─ B ─ G. It answers
 * listings, starts a rotation, hands out the work and applies the re-sealed nodes.
 */
final class FakeDrive: @unchecked Sendable {
    nonisolated(unsafe) static var current: FakeDrive?
    static var configuration: URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FakeDriveProtocol.self]
        return configuration
    }

    let session = SharedKeychain.Session(origin: "https://drive.test", token: "token", userId: UUID().uuidString.lowercased())
    let workspace = UUID().uuidString.lowercased()
    let workspaceKey: Data
    let root = UUID().uuidString.lowercased()
    let a = UUID().uuidString.lowercased()
    let b = UUID().uuidString.lowercased()
    let f = UUID().uuidString.lowercased()
    let g = UUID().uuidString.lowercased()
    var nodes: [String: NodeView] = [:]
    var failMoves = false
    private let lock = NSLock()
    private var target: UInt64 = 0

    init() throws {
        workspaceKey = try randomBytes(length: 32)
        var keys: [String: Data] = [:]
        // Parents first, so each key wraps under its parent's.
        for (id, parent, kind, name) in [(root, nil, "folder", "Files"), (a, root, "folder", "A"), (b, root, "folder", "B"), (f, a, "file", "f.txt"), (g, b, "file", "g.txt")] as [(String, String?, String, String)] {
            let key = try randomBytes(length: 32)
            keys[id] = key
            let parentKey = parent.flatMap { keys[$0] } ?? workspaceKey
            let envelope = try nodeWrap(ctx: NodeKeyContext(workspaceId: workspace, nodeId: id, parentId: parent ?? workspace, parentKeyEpoch: 1, keyEpoch: 1), parentKey: parentKey, nodeKey: key)
            let metadata = try metadataSeal(ctx: MetadataContext(workspaceId: workspace, nodeId: id, metadataVersion: 1), nodeKey: key,
                                            metadata: NodeMetadata(name: name, mime: nil, size: nil, modified: nil))
            nodes[id] = NodeView(id: id, workspaceId: workspace, parentId: parent, kind: kind, keyEpoch: 1, parentKeyEpoch: 1,
                                 keyEnvelope: base64urlEncode(bytes: envelope), metadataVersion: 1, metadataEnvelope: base64urlEncode(bytes: metadata),
                                 currentVersion: nil, trashedAt: nil, changeSeq: 1, createdAt: nil, updatedAt: nil)
        }
    }

    private func json(_ value: some Encodable) throws -> Any { try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) }

    private func ancestors(of id: String) -> [NodeView] {
        var out: [NodeView] = []
        var cursor = nodes[id]?.parentId
        while let current = cursor, let node = nodes[current] { out.insert(node, at: 0); cursor = node.parentId }
        return out
    }

    private func subtree(_ id: String) -> [NodeView] {
        guard let node = nodes[id] else { return [] }
        return [node] + nodes.values.filter { $0.parentId == id }.sorted { $0.id < $1.id }.flatMap { subtree($0.id) }
    }

    func answer(_ request: URLRequest, body: Data?) throws -> (Int, Any) {
        lock.lock()
        defer { lock.unlock() }
        let parts = (request.url?.path ?? "").split(separator: "/").map(String.init) // api, drive, nodes, <id>, …
        guard parts.count >= 5, parts[2] == "nodes" else { return (404, ["message": "Not here"]) }
        let id = parts[3]
        switch (request.httpMethod ?? "GET", Array(parts.dropFirst(4))) {
        case ("GET", ["children"]):
            guard let folder = nodes[id] else { return (404, ["message": "Not here"]) }
            let children = nodes.values.filter { $0.parentId == id }.sorted { $0.id < $1.id }
            return (200, ["folder": try json(folder), "ancestors": try ancestors(of: id).map(json), "children": try children.map(json)])
        case ("POST", ["parent"]):
            // A move: the node takes its new parent and envelope, unless the test made moves fail.
            if failMoves { return (409, ["message": "Not now"]) }
            let sent = try JSONSerialization.jsonObject(with: body ?? Data()) as? [String: Any] ?? [:]
            guard let old = nodes[id], let parent = sent["parentId"] as? String else { return (404, ["message": "Not here"]) }
            let moved = NodeView(
                id: old.id, workspaceId: old.workspaceId, parentId: parent, kind: old.kind, keyEpoch: old.keyEpoch,
                parentKeyEpoch: (sent["parentKeyEpoch"] as? NSNumber)?.uint64Value ?? old.parentKeyEpoch,
                keyEnvelope: sent["keyEnvelope"] as? String ?? old.keyEnvelope, metadataVersion: old.metadataVersion,
                metadataEnvelope: old.metadataEnvelope, currentVersion: nil, trashedAt: nil,
                changeSeq: (old.changeSeq ?? 0) + 1, createdAt: nil, updatedAt: nil
            )
            nodes[id] = moved
            return (200, ["node": try json(moved)])
        case ("POST", ["rotation"]):
            target = (nodes[id]?.keyEpoch ?? 1) + 1
            return (200, ["rotation": ["nodeId": id, "targetEpoch": target]])
        case ("GET", ["rotation", "work"]):
            let due = subtree(id).filter { $0.keyEpoch < target }
            var work: [Any] = []
            for node in due {
                var entry = try json(node) as? [String: Any] ?? [:]
                entry["depth"] = ancestors(of: node.id).count
                work.append(entry)
            }
            return (200, ["rotation": ["nodeId": id, "targetEpoch": target], "nodes": work, "nextCursor": NSNull(), "done": due.isEmpty])
        case ("POST", ["rotation", "nodes"]):
            let sent = (try JSONSerialization.jsonObject(with: body ?? Data()) as? [String: Any])?["nodes"] as? [[String: Any]] ?? []
            var results: [[String: String]] = []
            for wire in sent {
                guard let nodeId = wire["id"] as? String, let old = nodes[nodeId] else { continue }
                let rotated = wire["rotated"] as? [String: Any]
                nodes[nodeId] = NodeView(
                    id: old.id, workspaceId: old.workspaceId, parentId: old.parentId, kind: old.kind,
                    keyEpoch: rotated == nil ? old.keyEpoch : target, parentKeyEpoch: (wire["parentKeyEpoch"] as? NSNumber)?.uint64Value ?? old.parentKeyEpoch,
                    keyEnvelope: wire["keyEnvelope"] as? String ?? old.keyEnvelope, metadataVersion: old.metadataVersion,
                    metadataEnvelope: rotated?["metadataEnvelope"] as? String ?? old.metadataEnvelope,
                    currentVersion: nil, trashedAt: nil, changeSeq: (old.changeSeq ?? 0) + 1, createdAt: nil, updatedAt: nil
                )
                results.append(["id": nodeId, "status": "ok"])
            }
            return (200, ["results": results])
        default:
            return (404, ["message": "Not here"])
        }
    }
}

final class FakeDriveProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        // URLSession hands a protocol the body as a stream.
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            stream.close()
            body = data
        }
        do {
            guard let server = FakeDrive.current else { throw URLError(.cannotConnectToHost) }
            let (status, reply) = try server.answer(request, body: body)
            let data = try JSONSerialization.data(withJSONObject: reply)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
