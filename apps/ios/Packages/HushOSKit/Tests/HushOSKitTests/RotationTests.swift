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
    /* A vault on the fake server, whose owner trusts only their own keys. */
    func readyVault(_ server: FakeDrive, trusting: Bool = true) async throws -> Vault {
        FakeDrive.current = server
        let vault = Vault(api: DriveAPI(session: server.session, configuration: FakeDrive.configuration), session: server.session)
        await vault.adopt(workspace: WorkspaceView(workspaceId: server.workspace, changeSeq: nil, grant: nil, root: server.nodes[server.root]), key: server.workspaceKey)
        await vault.adopt(identity: server.identity)
        if trusting { await vault.adopt(signers: try server.ownerTrusts()) }
        return vault
    }

    @Test func rotationForgetsOnlyTheSubtreeAndMarksTheCatalogueForRebuild() async throws {
        let server = try FakeDrive()
        let vault = try await readyVault(server)

        // What Files had on screen: the root, the shared folder A and the untouched folder B.
        _ = try await vault.listChildren(of: server.root)
        _ = try await vault.listChildren(of: server.a)
        _ = try await vault.listChildren(of: server.b)
        await vault.markCatalogueReady()
        let oldFileKey = try #require(await vault.nodeKey(server.f))

        let rotated = try await vault.rotate(try #require(await vault.item(server.a))).rotated
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

    @Test func rotationReSignsOnlyWhatVerifiedAndReSealsTheRest() async throws {
        let server = try FakeDrive()
        let vault = try await readyVault(server)
        _ = try await vault.listChildren(of: server.root)
        _ = try await vault.rotate(try await vault.resolve(server.a))

        // A was the owner's own and verified: signed again with the ordinary statement, and still clean.
        #expect(server.statements[server.a] == "ordinary")
        let reader = try server.ownerTrusts()
        #expect(reader.provenance(of: try #require(server.nodes[server.a])) == nil)
        // F was planted by a stranger and its version unsigned: re-sealed, so the rotation launders neither into the owner's own.
        #expect(server.statements[server.f] == "resealed")
        #expect(server.statements["version:" + server.fVersion] == "resealed")
        #expect(reader.provenance(of: try #require(server.nodes[server.f])) == .resealed(.you))
    }

    @Test func aRotationWithoutWhomToTrustStartsNothing() async throws {
        let server = try FakeDrive()
        let vault = try await readyVault(server, trusting: false)
        _ = try await vault.listChildren(of: server.root)
        let a = try await vault.resolve(server.a)
        // The settings with the pins can't be read: the rotation must not re-sign blind, or start and leave work half done.
        Auth.testSession = server.session
        Auth.testTransport = FakeDrive.configuration
        defer { Auth.testSession = nil; Auth.testTransport = nil }
        await #expect(throws: RotationError.self) { try await vault.rotate(a) }
        #expect(!server.rotationStarted)
        #expect(server.nodes[server.a]?.keyEpoch == 1 && server.nodes[server.f]?.keyEpoch == 1)
    }

    @Test func aCopySignsEachRecordByWhatItVerifiedAs() async throws {
        let server = try FakeDrive()
        let vault = try await readyVault(server)
        _ = try await vault.listChildren(of: server.a)
        _ = try await vault.listChildren(of: server.b)
        // G is the owner's own: its copy is vouched for again. F was planted and unsigned: its copy is re-sealed.
        let ofG = try await vault.copy(server.g, to: server.a)
        let ofF = try await vault.copy(server.f, to: server.b)
        #expect(server.statements[ofG.id] == "ordinary" && server.statements["version:" + (ofG.node.currentVersion?.id ?? "")] == "ordinary")
        #expect(server.statements[ofF.id] == "resealed" && server.statements["version:" + (ofF.node.currentVersion?.id ?? "")] == "resealed")
        let reader = try server.ownerTrusts()
        #expect(reader.provenance(of: try #require(server.nodes[ofG.id])) == nil)
        #expect(reader.provenance(of: try #require(server.nodes[ofF.id])) == .resealed(.you))
    }

    /* A rename re-signs the record's other fields beside the new name: a planted one is re-sealed, never vouched for. */
    @Test func aRenameVouchesOnlyForARecordThatVerified() async throws {
        let server = try FakeDrive()
        let vault = try await readyVault(server)
        _ = try await vault.listChildren(of: server.root)
        _ = try await vault.listChildren(of: server.a)
        _ = try await vault.listChildren(of: server.b)
        _ = try await vault.rename(server.g, to: "g renamed.txt")
        _ = try await vault.rename(server.f, to: "f renamed.txt")
        #expect(server.statements["rename:" + server.g] == "ordinary")
        #expect(server.statements["rename:" + server.f] == "resealed")
        let reader = try server.ownerTrusts()
        #expect(reader.provenance(of: try #require(server.nodes[server.f])) == .resealed(.you))
    }

    @Test func aRenameWithoutWhomToTrustSendsNothing() async throws {
        let server = try FakeDrive()
        let vault = try await readyVault(server, trusting: false)
        Auth.testSession = server.session
        Auth.testTransport = FakeDrive.configuration
        defer { Auth.testSession = nil; Auth.testTransport = nil }
        _ = try await vault.listChildren(of: server.root)
        _ = try await vault.listChildren(of: server.a)
        await #expect(throws: (any Error).self) { try await vault.rename(server.f, to: "f renamed.txt") }
        #expect(server.nodes[server.f]?.metadataVersion == 1 && server.statements["rename:" + server.f] == nil)
    }

    @Test func aCopyWithoutWhomToTrustSendsNothing() async throws {
        let server = try FakeDrive()
        let vault = try await readyVault(server, trusting: false)
        Auth.testSession = server.session
        Auth.testTransport = FakeDrive.configuration
        defer { Auth.testSession = nil; Auth.testTransport = nil }
        _ = try await vault.listChildren(of: server.a)
        let before = server.nodes.count
        await #expect(throws: (any Error).self) { try await vault.copy(server.f, to: server.a) }
        #expect(server.nodes.count == before)
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
    /* The account running the rotation: its signing key is what the server checks every re-sealed record against. */
    let identity: IdentityKeys
    var writer: Signer { Signer(id: session.userId) }
    /* Someone the owner never checked, who planted F. */
    let stranger: IdentityKeys
    let strangerId = UUID().uuidString.lowercased()
    /* Which statement each stored signature is over, by node id (and "version:<id>"): what a re-seal chose. */
    var statements: [String: String] = [:]
    var rotationStarted = false
    var fVersion = UUID().uuidString.lowercased()
    let root = UUID().uuidString.lowercased()
    let a = UUID().uuidString.lowercased()
    let b = UUID().uuidString.lowercased()
    let f = UUID().uuidString.lowercased()
    let g = UUID().uuidString.lowercased()
    var nodes: [String: NodeView] = [:]
    var failMoves = false
    /* Every client-chosen id a create sent, with its kind and seed, in order: what the server derived and compared. */
    var minted: [(kind: IdKind, id: String, seed: String)] = []
    /* Upload begins as sent, and the uploads they started. */
    var begins: [[String: Any]] = []
    var uploads: [String: [String: Any]] = [:]
    var completed: [String] = []
    private let lock = NSLock()
    private var target: UInt64 = 0
    /* What A, F and G carry beside their names when made `attributed`: a colour, and keys no client knows yet. */
    static let attributes: [String: [String: String]] = [
        "A": ["colour": "blue", "zz-unknown": "from a newer client"],
        "f.txt": ["zz-unknown": "kept"],
        "g.txt": ["colour": "red", "later_feature": "{\"x\":1}"],
    ]

    init(attributed: Bool = false) throws {
        workspaceKey = try randomBytes(length: 32)
        let accountKey = try randomBytes(length: 32)
        identity = try identityOpen(userId: session.userId, accountKey: accountKey, envelope: try identityCreate(userId: session.userId, accountKey: accountKey, keyVersion: 1))
        let strangerRoot = try randomBytes(length: 32)
        stranger = try identityOpen(userId: strangerId, accountKey: strangerRoot, envelope: try identityCreate(userId: strangerId, accountKey: strangerRoot, keyVersion: 1))
        var keys: [String: Data] = [:]
        // Parents first, so each key wraps under its parent's.
        for (id, parent, kind, name) in [(root, nil, "folder", "Files"), (a, root, "folder", "A"), (b, root, "folder", "B"), (f, a, "file", "f.txt"), (g, b, "file", "g.txt")] as [(String, String?, String, String)] {
            let key = try randomBytes(length: 32)
            keys[id] = key
            let parentKey = parent.flatMap { keys[$0] } ?? workspaceKey
            let envelope = try nodeWrap(ctx: NodeKeyContext(workspaceId: workspace, nodeId: id, parentId: parent ?? workspace, parentKeyEpoch: 1, keyEpoch: 1), parentKey: parentKey, nodeKey: key)
            let metadata = try metadataSeal(ctx: MetadataContext(workspaceId: workspace, nodeId: id, metadataVersion: 1), nodeKey: key,
                                            metadata: NodeMetadata(name: name, mime: nil, size: nil, modified: nil,
                                                                   attributes: attributed ? Self.attributes[name] ?? [:] : [:]))
            // Files carry a version: F's unsigned, G's the owner's.
            var version: VersionView?
            if kind == "file" {
                let versionId = id == f ? fVersion : UUID().uuidString.lowercased()
                let objectId = UUID().uuidString.lowercased()
                let sealed = try versionSeal(ctx: VersionContext(workspaceId: workspace, nodeId: id, versionId: versionId, objectId: objectId), nodeKey: key,
                                             contentKey: try randomBytes(length: 32), plaintextSize: 10, thumbnailBytes: 0)
                version = VersionView(id: versionId, objectId: objectId, contentKeyEnvelope: base64urlEncode(bytes: sealed.envelope), status: "ready",
                                      contentSuite: 3, chunkCount: 1, contentNonce: base64urlEncode(bytes: try randomBytes(length: 16)),
                                      plaintextSize: nil, ciphertextSize: nil, readyAt: nil)
                if id == g {
                    version?.signer = writer
                    version?.signature = base64urlEncode(bytes: try versionSign(
                        signingSeed: identity.signingSeed,
                        statement: VersionStatement(workspaceId: workspace, nodeId: id, versionId: versionId, objectId: objectId, contentSuite: 3),
                        contentKeyEnvelope: sealed.envelope))
                }
            }
            nodes[id] = NodeView(id: id, workspaceId: workspace, parentId: parent, kind: kind, keyEpoch: 1, parentKeyEpoch: 1,
                                 keyEnvelope: base64urlEncode(bytes: envelope), metadataVersion: 1, metadataEnvelope: base64urlEncode(bytes: metadata),
                                 currentVersion: version, trashedAt: nil, changeSeq: 1, createdAt: nil, updatedAt: nil)
            // A and G are the owner's own; F was planted by a stranger; the root and B were written before signatures.
            let signedBy: IdentityKeys? = id == a || id == g ? identity : id == f ? stranger : nil
            if let signedBy {
                nodes[id]?.metadataSigner = Signer(id: signedBy == stranger ? strangerId : session.userId)
                nodes[id]?.metadataSignature = base64urlEncode(bytes: try metadataSign(
                    signingSeed: signedBy.signingSeed, statement: MetadataStatement(workspaceId: workspace, nodeId: id, kind: kind == "folder" ? .folder : .file, metadataVersion: 1),
                    metadataEnvelope: metadata))
            }
        }
    }

    /* The owner's own keys: whom the owner trusts, and the only key the server takes signatures under. */
    func ownerTrusts() throws -> TrustedSigners { try TrustedSigners(userId: session.userId, identities: [identity], pins: []) }

    /* As the server checks a signed write: the ordinary statement, then the re-sealed one, under the writer's current key. */
    private func statement(metadata envelope: String, signature: String?, node: (workspace: String, id: String, kind: String, version: UInt64)) throws -> String? {
        guard let signature else { return nil }
        let statement = MetadataStatement(workspaceId: node.workspace, nodeId: node.id, kind: node.kind == "folder" ? .folder : .file, metadataVersion: node.version)
        let key = try base64urlDecode(value: identity.signingPublicKey)
        let (bytes, sig) = (try base64urlDecode(value: envelope), try base64urlDecode(value: signature))
        if metadataVerify(signingPublicKey: key, statement: statement, metadataEnvelope: bytes, signature: sig) { return "ordinary" }
        if metadataSavedVerify(signingPublicKey: key, statement: statement, metadataEnvelope: bytes, signature: sig) { return "saved" }
        if metadataResealedVerify(signingPublicKey: key, statement: statement, metadataEnvelope: bytes, signature: sig) { return "resealed" }
        return nil
    }

    private func statement(version envelope: String, signature: String?, statement: VersionStatement) throws -> String? {
        guard let signature else { return nil }
        let key = try base64urlDecode(value: identity.signingPublicKey)
        let (bytes, sig) = (try base64urlDecode(value: envelope), try base64urlDecode(value: signature))
        if versionVerify(signingPublicKey: key, statement: statement, contentKeyEnvelope: bytes, signature: sig) { return "ordinary" }
        if versionSavedVerify(signingPublicKey: key, statement: statement, contentKeyEnvelope: bytes, signature: sig) { return "saved" }
        if versionResealedVerify(signingPublicKey: key, statement: statement, contentKeyEnvelope: bytes, signature: sig) { return "resealed" }
        return nil
    }

    private func json(_ value: some Encodable) throws -> Any { try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) }

    /* As the server checks every create before anything else: the seed must derive the id for this workspace and kind. */
    private func made(_ kind: IdKind, _ id: Any?, _ seed: Any?) -> Bool {
        guard let id = id as? String, let seed = seed as? String,
              let derived = try? deriveId(kind: kind, scopeId: workspace, seed: seed), derived == id else { return false }
        minted.append((kind, id, seed))
        return true
    }

    private static var notMade: (Int, Any) { (400, ["code": "invalid", "message": "This id was not made for this workspace"]) }

    /* A new node as the server stores it from a create, signed by the owner. */
    private func store(_ wire: [String: Any], id: String, kind: String, version: VersionView?) -> NodeView {
        var node = NodeView(id: id, workspaceId: workspace, parentId: wire["parentId"] as? String, kind: kind,
                            keyEpoch: (wire["keyEpoch"] as? NSNumber)?.uint64Value ?? 1, parentKeyEpoch: (wire["parentKeyEpoch"] as? NSNumber)?.uint64Value ?? 1,
                            keyEnvelope: wire["keyEnvelope"] as? String ?? "", metadataVersion: 1, metadataEnvelope: wire["metadataEnvelope"] as? String ?? "",
                            currentVersion: version, trashedAt: nil, changeSeq: 1, createdAt: nil, updatedAt: nil)
        node.metadataSigner = writer
        node.metadataSignature = wire["metadataSignature"] as? String
        nodes[id] = node
        return node
    }

    /* Folders, upload begin, parts and completion: the creates that are not a node's own routes. */
    private func answerCreate(_ request: URLRequest, parts: [String], body: Data?) throws -> (Int, Any)? {
        let sent = (try? JSONSerialization.jsonObject(with: body ?? Data()) as? [String: Any]) ?? [:]
        switch (request.httpMethod ?? "GET", Array(parts.dropFirst(2))) {
        case ("POST", ["folders"]):
            var made: [Any] = []
            for wire in sent["folders"] as? [[String: Any]] ?? [] {
                guard self.made(.node, wire["id"], wire["idSeed"]), let id = wire["id"] as? String else { return Self.notMade }
                guard let kind = try statement(metadata: wire["metadataEnvelope"] as? String ?? "", signature: wire["metadataSignature"] as? String,
                                               node: (workspace, id, "folder", 1))
                else { return (400, ["message": "This change was not signed by your keys"]) }
                statements[id] = kind
                made.append(try json(store(wire, id: id, kind: "folder", version: nil)))
            }
            return (200, ["nodes": made])
        case ("POST", ["uploads"]) where (sent["node"] as? [String: Any])?["existing"] as? Bool == true:
            // A new version of a file there is: its version and object are new, the node and its record stay until it completes.
            guard let wire = sent["node"] as? [String: Any], let nodeId = wire["id"] as? String, nodes[nodeId] != nil,
                  made(.version, sent["versionId"], sent["versionIdSeed"]), made(.object, sent["objectId"], sent["objectIdSeed"]),
                  let versionId = sent["versionId"] as? String, let objectId = sent["objectId"] as? String
            else { return Self.notMade }
            let suite = (sent["contentSuite"] as? NSNumber)?.uint32Value ?? 0
            guard let versionKind = try statement(version: sent["contentKeyEnvelope"] as? String ?? "", signature: sent["versionSignature"] as? String,
                                                  statement: VersionStatement(workspaceId: workspace, nodeId: nodeId, versionId: versionId, objectId: objectId, contentSuite: suite))
            else { return (400, ["message": "This change was not signed by your keys"]) }
            statements["version:" + versionId] = versionKind
            begins.append(sent)
            let uploadId = UUID().uuidString.lowercased()
            uploads[uploadId] = sent
            let count = (sent["chunkCount"] as? Int) ?? 1
            let urls = (1 ... max(count, 1)).map { ["partNumber": $0, "length": 0, "url": "https://drive.test/store/\(uploadId)/\($0)"] as [String: Any] }
            return (200, ["upload": ["id": uploadId, "nodeId": nodeId, "versionId": versionId, "status": "pending", "chunkCount": count],
                          "parts": urls, "urlExpiresAt": "2099-01-01T00:00:00Z"])
        case ("POST", ["uploads"]):
            guard let wire = sent["node"] as? [String: Any], wire["existing"] as? Bool == false, let nodeId = wire["id"] as? String else { return (400, ["message": "Bad upload"]) }
            guard made(.node, nodeId, wire["idSeed"]), made(.version, sent["versionId"], sent["versionIdSeed"]),
                  made(.object, sent["objectId"], sent["objectIdSeed"]),
                  let versionId = sent["versionId"] as? String, let objectId = sent["objectId"] as? String
            else { return Self.notMade }
            let suite = (sent["contentSuite"] as? NSNumber)?.uint32Value ?? 0
            guard let metadataKind = try statement(metadata: wire["metadataEnvelope"] as? String ?? "", signature: wire["metadataSignature"] as? String,
                                                   node: (workspace, nodeId, "file", 1)),
                  let versionKind = try statement(version: sent["contentKeyEnvelope"] as? String ?? "", signature: sent["versionSignature"] as? String,
                                                  statement: VersionStatement(workspaceId: workspace, nodeId: nodeId, versionId: versionId, objectId: objectId, contentSuite: suite))
            else { return (400, ["message": "This change was not signed by your keys"]) }
            statements[nodeId] = metadataKind
            statements["version:" + versionId] = versionKind
            begins.append(sent)
            let uploadId = UUID().uuidString.lowercased()
            uploads[uploadId] = sent
            let count = (sent["chunkCount"] as? Int) ?? 1
            let urls = (1 ... max(count, 1)).map { ["partNumber": $0, "length": 0, "url": "https://drive.test/store/\(uploadId)/\($0)"] as [String: Any] }
            return (200, ["upload": ["id": uploadId, "nodeId": nodeId, "versionId": versionId, "status": "pending", "chunkCount": count],
                          "parts": urls, "urlExpiresAt": "2099-01-01T00:00:00Z"])
        case ("POST", let rest) where rest.count == 3 && rest[0] == "uploads" && rest[2] == "complete":
            guard let begun = uploads[rest[1]], let wire = begun["node"] as? [String: Any], let nodeId = wire["id"] as? String,
                  let versionId = begun["versionId"] as? String, let objectId = begun["objectId"] as? String else { return (404, ["message": "No upload"]) }
            if completed.contains(rest[1]) { return (409, ["message": "This upload is ready."]) }
            completed.append(rest[1])
            var version = VersionView(id: versionId, objectId: objectId, contentKeyEnvelope: begun["contentKeyEnvelope"] as? String ?? "", status: "ready",
                                      contentSuite: (begun["contentSuite"] as? NSNumber)?.uint32Value ?? 0, chunkCount: (begun["chunkCount"] as? Int) ?? 1,
                                      contentNonce: begun["contentNonce"] as? String ?? "", plaintextSize: nil, ciphertextSize: nil, readyAt: nil)
            version.signer = writer
            version.signature = begun["versionSignature"] as? String
            if wire["existing"] as? Bool == true, let old = nodes[nodeId] {
                // The version goes live under the record as it was; the client re-signs the record next.
                var updated = NodeView(id: old.id, workspaceId: old.workspaceId, parentId: old.parentId, kind: old.kind, keyEpoch: old.keyEpoch,
                                       parentKeyEpoch: old.parentKeyEpoch, keyEnvelope: old.keyEnvelope, metadataVersion: old.metadataVersion,
                                       metadataEnvelope: old.metadataEnvelope, currentVersion: version, trashedAt: nil,
                                       changeSeq: (old.changeSeq ?? 0) + 1, createdAt: nil, updatedAt: nil)
                updated.metadataSigner = old.metadataSigner
                updated.metadataSignature = old.metadataSignature
                nodes[nodeId] = updated
                return (200, ["status": "ready", "node": try json(updated)])
            }
            return (200, ["status": "ready", "node": try json(store(wire, id: nodeId, kind: "file", version: version))])
        default:
            return nil
        }
    }

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
        if parts.first == "store", request.httpMethod == "PUT" { return (200, [:]) }
        if let answer = try answerCreate(request, parts: parts, body: body) { return answer }
        if parts.count == 5, parts[2] == "workspaces", parts[4] == "epochs" {
            target = max(target, 1) + 1
            return (200, ["from": target, "to": target])
        }
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
        case ("POST", ["copy"]):
            // A copy: stored only under the owner's valid signature, ordinary or re-sealed, as the server checks it.
            let sent = try JSONSerialization.jsonObject(with: body ?? Data()) as? [String: Any] ?? [:]
            guard made(.node, (sent["node"] as? [String: Any])?["id"], (sent["node"] as? [String: Any])?["idSeed"]),
                  made(.version, sent["versionId"], sent["versionIdSeed"]) else { return Self.notMade }
            guard let source = nodes[id], let wire = sent["node"] as? [String: Any], let newId = wire["id"] as? String,
                  let sourceVersion = source.currentVersion, let versionId = sent["versionId"] as? String,
                  let contentKeyEnvelope = sent["contentKeyEnvelope"] as? String, let metadataEnvelope = wire["metadataEnvelope"] as? String
            else { return (400, ["message": "Bad copy"]) }
            guard let metadataKind = try statement(metadata: metadataEnvelope, signature: wire["metadataSignature"] as? String, node: (workspace, newId, source.kind, 1)),
                  let versionKind = try statement(version: contentKeyEnvelope, signature: sent["versionSignature"] as? String,
                                                  statement: VersionStatement(workspaceId: workspace, nodeId: newId, versionId: versionId, objectId: sourceVersion.objectId,
                                                                              contentSuite: sourceVersion.contentSuite))
            else { return (400, ["message": "This change was not signed by your keys"]) }
            statements[newId] = metadataKind
            statements["version:" + versionId] = versionKind
            var version = VersionView(id: versionId, objectId: sourceVersion.objectId, contentKeyEnvelope: contentKeyEnvelope, status: "ready",
                                      contentSuite: sourceVersion.contentSuite, chunkCount: 1, contentNonce: sourceVersion.contentNonce,
                                      plaintextSize: nil, ciphertextSize: nil, readyAt: nil)
            version.signer = writer
            version.signature = sent["versionSignature"] as? String
            var copied = NodeView(id: newId, workspaceId: workspace, parentId: wire["parentId"] as? String, kind: source.kind,
                                  keyEpoch: (wire["keyEpoch"] as? NSNumber)?.uint64Value ?? 1, parentKeyEpoch: (wire["parentKeyEpoch"] as? NSNumber)?.uint64Value ?? 1,
                                  keyEnvelope: wire["keyEnvelope"] as? String ?? "", metadataVersion: 1, metadataEnvelope: metadataEnvelope,
                                  currentVersion: version, trashedAt: nil, changeSeq: 1, createdAt: nil, updatedAt: nil)
            copied.metadataSigner = writer
            copied.metadataSignature = wire["metadataSignature"] as? String
            nodes[newId] = copied
            return (200, ["node": try json(copied)])
        case ("POST", ["metadata"]):
            // A rename: stored only under the owner's valid signature over the next metadata version, as the server checks it.
            let sent = try JSONSerialization.jsonObject(with: body ?? Data()) as? [String: Any] ?? [:]
            guard let old = nodes[id], let envelope = sent["metadataEnvelope"] as? String,
                  (sent["metadataVersion"] as? NSNumber)?.uint64Value == old.metadataVersion else { return (409, ["message": "Changed"]) }
            guard let kind = try statement(metadata: envelope, signature: sent["metadataSignature"] as? String,
                                           node: (workspace, id, old.kind, old.metadataVersion + 1))
            else { return (400, ["message": "This change was not signed by your keys"]) }
            statements["rename:" + id] = kind
            var renamed = NodeView(id: old.id, workspaceId: old.workspaceId, parentId: old.parentId, kind: old.kind, keyEpoch: old.keyEpoch,
                                   parentKeyEpoch: old.parentKeyEpoch, keyEnvelope: old.keyEnvelope, metadataVersion: old.metadataVersion + 1,
                                   metadataEnvelope: envelope, currentVersion: old.currentVersion, trashedAt: nil,
                                   changeSeq: (old.changeSeq ?? 0) + 1, createdAt: nil, updatedAt: nil)
            renamed.metadataSigner = writer
            renamed.metadataSignature = sent["metadataSignature"] as? String
            nodes[id] = renamed
            return (200, ["node": try json(renamed)])
        case ("POST", ["rotation"]):
            rotationStarted = true
            target = (nodes[id]?.keyEpoch ?? 1) + 1
            return (200, ["rotation": ["nodeId": id, "targetEpoch": target]])
        case ("GET", ["rotation", "work"]):
            let due = subtree(id).filter { $0.keyEpoch < target }
            var work: [Any] = []
            for node in due {
                var entry = try json(node) as? [String: Any] ?? [:]
                entry["depth"] = ancestors(of: node.id).count
                if let version = node.currentVersion {
                    var row: [String: Any] = ["id": version.id, "objectId": version.objectId, "contentKeyEnvelope": version.contentKeyEnvelope,
                                              "contentSuite": version.contentSuite, "plaintextSize": NSNull()]
                    if let signer = version.signer { row["signer"] = ["id": signer.id] }
                    if let signature = version.signature { row["signature"] = signature }
                    entry["versions"] = [row]
                }
                work.append(entry)
            }
            return (200, ["rotation": ["nodeId": id, "targetEpoch": target], "nodes": work, "nextCursor": NSNull(), "done": due.isEmpty])
        case ("POST", ["rotation", "nodes"]):
            let sent = (try JSONSerialization.jsonObject(with: body ?? Data()) as? [String: Any])?["nodes"] as? [[String: Any]] ?? []
            var results: [[String: String]] = []
            for wire in sent {
                guard let nodeId = wire["id"] as? String, let old = nodes[nodeId] else { continue }
                let rotated = wire["rotated"] as? [String: Any]
                // As the server does: a re-sealed envelope is stored only under its writer's valid signature, ordinary or re-sealed.
                var signature: String?
                var version = old.currentVersion
                if let rotated {
                    signature = rotated["metadataSignature"] as? String
                    guard let kind = try statement(metadata: rotated["metadataEnvelope"] as? String ?? "", signature: signature,
                                                   node: (old.workspaceId, old.id, old.kind, old.metadataVersion)) else {
                        results.append(["id": nodeId, "status": "bad-signature"])
                        continue
                    }
                    statements[nodeId] = kind
                    var refused = false
                    for sent in rotated["versions"] as? [[String: Any]] ?? [] {
                        guard let current = version, sent["id"] as? String == current.id, let envelope = sent["contentKeyEnvelope"] as? String,
                              let kind = try statement(version: envelope, signature: sent["signature"] as? String,
                                                       statement: VersionStatement(workspaceId: old.workspaceId, nodeId: old.id, versionId: current.id,
                                                                                   objectId: current.objectId, contentSuite: current.contentSuite))
                        else { refused = true; break }
                        statements["version:" + current.id] = kind
                        version = VersionView(id: current.id, objectId: current.objectId, contentKeyEnvelope: envelope, status: current.status,
                                              contentSuite: current.contentSuite, chunkCount: current.chunkCount, contentNonce: current.contentNonce,
                                              plaintextSize: nil, ciphertextSize: nil, readyAt: nil, signer: writer, signature: sent["signature"] as? String)
                    }
                    if refused {
                        results.append(["id": nodeId, "status": "bad-signature"])
                        continue
                    }
                }
                nodes[nodeId] = NodeView(
                    id: old.id, workspaceId: old.workspaceId, parentId: old.parentId, kind: old.kind,
                    keyEpoch: rotated == nil ? old.keyEpoch : target, parentKeyEpoch: (wire["parentKeyEpoch"] as? NSNumber)?.uint64Value ?? old.parentKeyEpoch,
                    keyEnvelope: wire["keyEnvelope"] as? String ?? old.keyEnvelope, metadataVersion: old.metadataVersion,
                    metadataEnvelope: rotated?["metadataEnvelope"] as? String ?? old.metadataEnvelope,
                    currentVersion: version, trashedAt: nil, changeSeq: (old.changeSeq ?? 0) + 1, createdAt: nil, updatedAt: nil
                )
                if let signature {
                    nodes[nodeId]?.metadataSigner = writer
                    nodes[nodeId]?.metadataSignature = signature
                } else {
                    nodes[nodeId]?.metadataSigner = old.metadataSigner
                    nodes[nodeId]?.metadataSignature = old.metadataSignature
                }
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
            // A part's PUT answers with the ETag completion needs.
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json", "ETag": "\"part\""])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
