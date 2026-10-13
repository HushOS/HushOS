import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * Ids derived from a seed and the workspace (docs/integrity-design.md, "Ids derived from a
 * seed and a scope") and saved copies signed by where they came from. Against the fake
 * Drive server, which refuses an id its seed doesn't derive for the workspace as the real
 * one does, and records which statement each stored signature is over.
 */
extension OnFakeDrive {
@Suite struct ScopedIdTests {
    func readyVault(_ server: FakeDrive) async throws -> Vault {
        FakeDrive.current = server
        let vault = Vault(api: DriveAPI(session: server.session, configuration: FakeDrive.configuration), session: server.session)
        await vault.adopt(workspace: WorkspaceView(workspaceId: server.workspace, changeSeq: nil, grant: nil, root: server.nodes[server.root]), key: server.workspaceKey)
        await vault.adopt(identity: server.identity)
        await vault.adopt(signers: try server.ownerTrusts())
        return vault
    }

    func file(_ name: String = "notes.txt", bytes: Int = 300) throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ids-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(name)
        try Data((0 ..< bytes).map { UInt8($0 % 251) }).write(to: url)
        return url
    }

    @Test func everyCreateSendsEachIdWithAFreshSeedThatDerivesItForThisWorkspace() async throws {
        let server = try FakeDrive()
        let vault = try await readyVault(server)
        _ = try await vault.listChildren(of: server.root)
        _ = try await vault.listChildren(of: server.b)

        // Each of these is refused by the server unless every id it names came with the seed that derives it here.
        let folder = try await vault.createFolder(in: server.root, name: "New")
        let uploaded = try await vault.upload(fileURL: try file(), name: "notes.txt", mime: "text/plain", in: folder.id, replacing: nil)
        let copied = try await vault.copy(server.g, to: folder.id)

        let version = try #require(uploaded.node.currentVersion)
        // A folder's node; an upload's node, version and object; a copy's node and version (its object stays the source's).
        #expect(server.minted.map(\.kind) == [.node, .node, .version, .object, .node, .version])
        #expect(server.minted.map(\.id) == [folder.id, uploaded.id, version.id, version.objectId, copied.id, try #require(copied.node.currentVersion?.id)])
        // A seed is drawn per id: one used twice would make the second create a conflict with the first.
        #expect(Set(server.minted.map(\.seed)).count == server.minted.count)
        for made in server.minted { #expect(try base64urlDecode(value: made.seed).count == 16) }
    }

    @Test func aSealedUploadFinishedAfterARelaunchCreatesNothingAgain() async throws {
        let server = try FakeDrive()
        let vault = try await readyVault(server)
        _ = try await vault.listChildren(of: server.root)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sealed-" + UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let sealed = try await vault.sealUpload(fileURL: try file("a.bin"), name: "a.bin", mime: nil, in: server.root, replacing: nil,
                                                thumbnail: nil, into: directory)

        // What the transfer queue keeps across launches, finished by a fresh process: the create already happened, with its seeds.
        let kept = try JSONDecoder().decode(Vault.SealedUpload.self, from: JSONEncoder().encode(sealed))
        let relaunched = try await readyVault(server)
        _ = try await relaunched.listChildren(of: server.root)
        let etags = Dictionary(uniqueKeysWithValues: (1 ... kept.partCount).map { ($0, "\"part\"") })
        let landed = try await relaunched.finishUpload(kept, etags: etags)

        #expect(server.begins.count == 1)
        #expect(landed.id == (server.begins.first?["node"] as? [String: Any])?["id"] as? String)
        #expect(landed.name == "a.bin")
        #expect(server.minted.filter { $0.kind == .node }.map(\.id) == [landed.id])
    }

    @Test func aSaveFromALinkSignsTheSavedStatementsAndShowsNoMark() async throws {
        let server = try FakeDrive()
        let vault = try await readyVault(server)
        _ = try await vault.listChildren(of: server.root)
        // As "Save a copy" from a link does: the folder it makes, then each file uploaded into it.
        let folder = try await vault.createFolder(in: server.root, name: "From a link", signing: .savedFromLink)
        let saved = try await vault.upload(fileURL: try file(), name: "notes.txt", mime: "text/plain", in: folder.id, replacing: nil,
                                           signing: (.savedFromLink, .savedFromLink))
        let version = try #require(saved.node.currentVersion)
        #expect(server.statements[folder.id] == "saved")
        #expect(server.statements[saved.id] == "saved" && server.statements["version:" + version.id] == "saved")

        let reader = try server.ownerTrusts()
        for id in [folder.id, saved.id] {
            let node = try #require(server.nodes[id])
            #expect(reader.provenance(of: node) == nil)
            #expect(reader.savedCopy(of: node) == SavedCopy(writer: .you))
        }
    }

    @Test func aSavedCopyStaysSavedThroughACopyAndARename() async throws {
        let server = try FakeDrive()
        let vault = try await readyVault(server)
        _ = try await vault.listChildren(of: server.root)
        _ = try await vault.listChildren(of: server.a)
        let saved = try await vault.upload(fileURL: try file(), name: "kept.txt", mime: nil, in: server.root, replacing: nil,
                                           signing: (.savedFromLink, .savedFromLink))
        // It verified as saved: a copy of it says the same, and is not laundered into an ordinary one or warned about.
        let copied = try await vault.copy(saved.id, to: server.a)
        #expect(server.statements[copied.id] == "saved")
        #expect(server.statements["version:" + (copied.node.currentVersion?.id ?? "")] == "saved")
        _ = try await vault.rename(saved.id, to: "kept, renamed.txt")
        #expect(server.statements["rename:" + saved.id] == "saved")
        #expect(try server.ownerTrusts().savedCopy(of: try #require(server.nodes[saved.id])) == SavedCopy(writer: .you))
    }
}
}
