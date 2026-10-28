import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * A node's attributes (a folder's colour, and keys a newer client added that this app doesn't
 * know) ride along whenever the phone seals its record again: a rename, a copy of a file or a
 * folder, a rotation, and a new version, finished here or by a later launch from the stored
 * upload. Against the fake Drive server with A, F and G sealed with attributes; each record the
 * phone writes is opened as a reader would and must carry its source's. Each test fails if its
 * path builds the record from the known fields alone.
 */
extension OnFakeDrive {
@Suite struct AttributesTests {
    func readyVault(_ server: FakeDrive) async throws -> Vault {
        FakeDrive.current = server
        let vault = Vault(api: DriveAPI(session: server.session, configuration: FakeDrive.configuration), session: server.session)
        await vault.adopt(workspace: WorkspaceView(workspaceId: server.workspace, changeSeq: nil, grant: nil, root: server.nodes[server.root]), key: server.workspaceKey)
        await vault.adopt(identity: server.identity)
        await vault.adopt(signers: try server.ownerTrusts())
        _ = try await vault.listChildren(of: server.root)
        _ = try await vault.listChildren(of: server.a)
        _ = try await vault.listChildren(of: server.b)
        return vault
    }

    /* The record the server holds for `id`, opened with the key the vault holds for it now. */
    func record(_ id: String, _ server: FakeDrive, _ vault: Vault) async throws -> NodeMetadata {
        let node = try #require(server.nodes[id])
        let key = try #require(await vault.nodeKey(id))
        return try metadataOpen(ctx: MetadataContext(workspaceId: node.workspaceId, nodeId: id, metadataVersion: node.metadataVersion), nodeKey: key,
                                envelope: try base64urlDecode(value: node.metadataEnvelope))
    }

    func file(_ bytes: Int = 300) throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("attributes-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("g.txt")
        try Data((0 ..< bytes).map { UInt8($0 % 251) }).write(to: url)
        return url
    }

    @Test func aRenameKeepsEveryAttribute() async throws {
        let server = try FakeDrive(attributed: true)
        let vault = try await readyVault(server)
        _ = try await vault.rename(server.a, to: "A renamed")
        let renamed = try await record(server.a, server, vault)
        #expect(renamed.name == "A renamed")
        #expect(renamed.attributes == FakeDrive.attributes["A"])
    }

    @Test func aCopyOfAFileOrAFolderKeepsEachSourcesAttributes() async throws {
        let server = try FakeDrive(attributed: true)
        let vault = try await readyVault(server)
        let ofG = try await vault.copy(server.g, to: server.a)
        #expect(try await record(ofG.id, server, vault).attributes == FakeDrive.attributes["g.txt"])
        // A folder node by node: the folder made, and the file copied into it, each keep their own source's.
        let ofA = try await vault.copy(server.a, to: server.b, name: "A copy")
        #expect(try await record(ofA.id, server, vault).attributes == FakeDrive.attributes["A"])
        let inside = try await vault.children(of: ofA.id)
        let ofF = try #require(inside.first { $0.name == "f.txt" })
        #expect(try await record(ofF.id, server, vault).attributes == FakeDrive.attributes["f.txt"])
    }

    @Test func aRotationReSealsEveryRecordWithItsAttributes() async throws {
        let server = try FakeDrive(attributed: true)
        let vault = try await readyVault(server)
        let before = try #require(server.nodes[server.a]?.metadataEnvelope)
        _ = try await vault.rotate(try await vault.resolve(server.a))
        #expect(server.nodes[server.a]?.keyEpoch == 2 && server.nodes[server.a]?.metadataEnvelope != before)
        // Read again under the fresh keys.
        _ = try await vault.listChildren(of: server.root)
        _ = try await vault.listChildren(of: server.a)
        #expect(try await record(server.a, server, vault).attributes == FakeDrive.attributes["A"])
        #expect(try await record(server.f, server, vault).attributes == FakeDrive.attributes["f.txt"])
    }

    @Test func aNewVersionKeepsTheFilesAttributesHereAndAfterARelaunch() async throws {
        let server = try FakeDrive(attributed: true)
        let vault = try await readyVault(server)
        let g = try #require(await vault.item(server.g))
        _ = try await vault.upload(fileURL: try file(), name: "g.txt", mime: "text/plain", in: server.b, replacing: g)
        let replaced = try await record(server.g, server, vault)
        #expect(server.nodes[server.g]?.metadataVersion == 2)
        #expect(replaced.size == 300)
        #expect(replaced.attributes == FakeDrive.attributes["g.txt"])

        // Sealed for the background queue, kept across a launch as JSON, finished by a fresh process.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sealed-" + UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let again = try #require(await vault.item(server.g))
        let sealed = try await vault.sealUpload(fileURL: try file(500), name: "g.txt", mime: "text/plain", in: server.b, replacing: again,
                                                thumbnail: nil, into: directory)
        let kept = try JSONDecoder().decode(Vault.SealedUpload.self, from: JSONEncoder().encode(sealed))
        let relaunched = try await readyVault(server)
        let etags = Dictionary(uniqueKeysWithValues: (1 ... kept.partCount).map { ($0, "\"part\"") })
        _ = try await relaunched.finishUpload(kept, etags: etags)
        let finished = try await record(server.g, server, relaunched)
        #expect(server.nodes[server.g]?.metadataVersion == 3)
        #expect(finished.size == 500)
        #expect(finished.attributes == FakeDrive.attributes["g.txt"])
    }
}
}
