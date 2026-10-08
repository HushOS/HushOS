import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * An account that never opened Drive has no top folder; the vault makes it as the web
 * does. Against a stub server: what is sent, and which root is adopted.
 */
@Suite(.serialized)
struct RootTests {
    let session = SharedKeychain.Session(origin: "https://drive.test", token: "token", userId: UUID().uuidString.lowercased())
    let workspace = UUID().uuidString.lowercased()

    func view(root: NodeView?, keyVersion: UInt64 = 3) -> WorkspaceView {
        let grant = GrantView(version: 1, workspaceId: workspace, keyVersion: 1, workspaceKeyVersion: keyVersion,
                              wrappingSalt: "", wrappingNonce: "", encryptedKey: "")
        return WorkspaceView(workspaceId: workspace, changeSeq: 7, grant: grant, root: root)
    }

    func vault(_ server: RootServer) -> Vault {
        RootServer.current = server
        return Vault(api: DriveAPI(session: session, configuration: RootServer.configuration), session: session)
    }

    func node(_ id: String, keyEpoch: UInt64, parentKeyEpoch: UInt64, keyEnvelope: String = "", metadataEnvelope: String = "") -> NodeView {
        NodeView(id: id, workspaceId: workspace, parentId: nil, kind: "folder", keyEpoch: keyEpoch, parentKeyEpoch: parentKeyEpoch,
                 keyEnvelope: keyEnvelope, metadataVersion: 1, metadataEnvelope: metadataEnvelope, currentVersion: nil,
                 trashedAt: nil, changeSeq: 8, createdAt: nil, updatedAt: nil)
    }

    @Test func noRootAllocatesOneEpochAndCreatesItOnceUnderTheWorkspaceKey() async throws {
        let server = RootServer(epoch: 41)
        let vault = vault(server)
        let key = try randomBytes(length: 32)
        await vault.adopt(workspace: view(root: nil), key: key)
        let made = try await vault.ensureRoot(view(root: nil))

        #expect(server.allocations == [1])
        #expect(server.created.count == 1)
        let sent = try #require(server.created.first)
        let id = try #require(sent["id"] as? String)
        #expect(sent["keyEpoch"] as? UInt64 == 41)
        #expect(sent["parentKeyEpoch"] as? UInt64 == 3)
        #expect(made.root?.id == id)
        #expect(made.changeSeq == 7)

        // Sealed as the web seals it: the key opens under the workspace key with the workspace as parent,
        // and the metadata names it "Drive".
        let nodeKey = try nodeOpen(
            ctx: NodeKeyContext(workspaceId: workspace, nodeId: id, parentId: workspace, parentKeyEpoch: 3, keyEpoch: 41),
            parentKey: key, keyEnvelope: try base64urlDecode(value: try #require(sent["keyEnvelope"] as? String))
        )
        let metadata = try metadataOpen(ctx: MetadataContext(workspaceId: workspace, nodeId: id, metadataVersion: 1), nodeKey: nodeKey,
                                        envelope: try base64urlDecode(value: try #require(sent["metadataEnvelope"] as? String)))
        #expect(metadata.name == "Drive")
    }

    @Test func aWorkspaceWithARootCreatesNothing() async throws {
        let server = RootServer(epoch: 5)
        let vault = vault(server)
        await vault.adopt(workspace: view(root: nil), key: try randomBytes(length: 32))
        let existing = node(UUID().uuidString.lowercased(), keyEpoch: 2, parentKeyEpoch: 3)
        let opened = try await vault.ensureRoot(view(root: existing))
        #expect(opened.root?.id == existing.id)
        #expect(server.allocations.isEmpty)
        #expect(server.created.isEmpty)
    }

    @Test func whenAnotherDeviceWonTheRaceItsRootIsAdopted() async throws {
        let winner = UUID().uuidString.lowercased()
        let server = RootServer(epoch: 9, winner: node(winner, keyEpoch: 8, parentKeyEpoch: 3))
        let vault = vault(server)
        await vault.adopt(workspace: view(root: nil), key: try randomBytes(length: 32))
        let made = try await vault.ensureRoot(view(root: nil))
        #expect(server.created.count == 1)
        #expect(made.root?.id == winner)
        #expect(made.root?.id != server.created.first?["id"] as? String)
    }
}

/* Answers epochs and root creation; records what it was sent. */
final class RootServer: @unchecked Sendable {
    nonisolated(unsafe) static var current: RootServer?
    static var configuration: URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RootServerProtocol.self]
        return configuration
    }

    let epoch: UInt64
    let winner: NodeView?
    private let lock = NSLock()
    private(set) var allocations: [Int] = []
    private(set) var created: [[String: Any]] = []

    init(epoch: UInt64, winner: NodeView? = nil) {
        self.epoch = epoch
        self.winner = winner
    }

    func answer(_ request: URLRequest, body: [String: Any]) throws -> (Int, Any) {
        lock.lock()
        defer { lock.unlock() }
        let path = request.url?.path ?? ""
        if path.hasSuffix("/epochs") {
            allocations.append(body["count"] as? Int ?? -1)
            return (200, ["from": epoch, "to": epoch])
        }
        if path.hasSuffix("/root") {
            created.append(body)
            let root: NodeView = winner ?? NodeView(
                id: body["id"] as? String ?? "", workspaceId: path.split(separator: "/").dropLast().last.map(String.init) ?? "",
                parentId: nil, kind: "folder", keyEpoch: (body["keyEpoch"] as? NSNumber)?.uint64Value ?? 0,
                parentKeyEpoch: (body["parentKeyEpoch"] as? NSNumber)?.uint64Value ?? 0, keyEnvelope: body["keyEnvelope"] as? String ?? "",
                metadataVersion: 1, metadataEnvelope: body["metadataEnvelope"] as? String ?? "", currentVersion: nil, trashedAt: nil,
                changeSeq: 8, createdAt: nil, updatedAt: nil
            )
            let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(root))
            return (200, ["created": winner == nil, "root": json])
        }
        return (404, ["message": "Not here"])
    }
}

final class RootServerProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
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
        do {
            guard let server = RootServer.current else { throw URLError(.cannotConnectToHost) }
            let body = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            let (status, reply) = try server.answer(request, body: body)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: reply))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
