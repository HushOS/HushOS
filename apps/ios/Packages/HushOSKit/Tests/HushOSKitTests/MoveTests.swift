import Foundation
import Testing
@testable import HushOSKit

/*
 * A move must take the item out of the folder it left at once, not after the change feed:
 * the source folder kept listing moved files until the catalogue was rebuilt. A move the
 * server refuses must leave both folders as they were.
 */
extension OnFakeDrive {
@Suite struct MoveTests {
    private func readyVault(_ server: FakeDrive) async throws -> Vault {
        FakeDrive.current = server
        let vault = Vault(api: DriveAPI(session: server.session, configuration: FakeDrive.configuration), session: server.session)
        await vault.adopt(workspace: WorkspaceView(workspaceId: server.workspace, changeSeq: nil, grant: nil, root: server.nodes[server.root]), key: server.workspaceKey)
        _ = try await vault.listChildren(of: server.root)
        _ = try await vault.listChildren(of: server.a)
        _ = try await vault.listChildren(of: server.b)
        await vault.markCatalogueReady()
        return vault
    }

    @Test func aMovedFileLeavesItsOldFolderAndShowsInTheNewOneBeforeAnySync() async throws {
        let server = try FakeDrive()
        let vault = try await readyVault(server)
        #expect(await vault.catalogueChildren(of: server.b)?.map(\.id) == [server.g])

        _ = try await vault.move(server.g, to: server.a)

        #expect(server.nodes[server.g]?.parentId == server.a)
        #expect(await vault.catalogueChildren(of: server.b)?.map(\.id) == [])
        #expect(Set(await vault.catalogueChildren(of: server.a)?.map(\.id) ?? []) == [server.f, server.g])
        // And back again (Undo): the same item, in the folder it came from, nowhere else.
        _ = try await vault.move(server.g, to: server.b)
        #expect(await vault.catalogueChildren(of: server.b)?.map(\.id) == [server.g])
        #expect(await vault.catalogueChildren(of: server.a)?.map(\.id) == [server.f])
    }

    @Test func aRefusedMoveLeavesBothFoldersAsTheyWere() async throws {
        let server = try FakeDrive()
        let vault = try await readyVault(server)
        server.failMoves = true

        await #expect(throws: (any Error).self) { _ = try await vault.move(server.g, to: server.a) }

        #expect(await vault.catalogueChildren(of: server.b)?.map(\.id) == [server.g])
        #expect(await vault.catalogueChildren(of: server.a)?.map(\.id) == [server.f])
        #expect(await vault.item(server.g)?.node.parentId == server.b)
    }
}
}
