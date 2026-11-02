import Foundation
import Testing
@testable import HushOSKit

/*
 * Following a sign-in made in the Files sheet: the last session's family keys must not stay in
 * memory, whether another account signed in or the same account under a new session (each
 * session has its own vault and area ledger). Nothing changed, nothing is dropped.
 */
extension OnFakeDrive {
    @Suite struct SessionForgetTests {
        private func accepted() async throws -> (FamilyFixture, FamilyFixture.Phone)? {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            guard case .accepted = await phone.sync.sync(family.summary) else { phone.done(); Issue.record("not accepted"); return nil }
            return (family, phone)
        }

        @Test func followingAnotherSessionDropsTheLastOnesFamilyKeys() async throws {
            for change in [SessionChange.adopt, .another, .restart] {
                guard let (family, phone) = try await accepted() else { return }
                defer { phone.done(); FamilySync.forget() }
                #expect(phone.vault.areaLedger.isArea(workspaceId: family.workspaceId))
                let held = FamilySync.shared(for: phone.vault)
                change.forgetLastSession(account: CopyEpoch())
                #expect(!phone.vault.areaLedger.isArea(workspaceId: family.workspaceId), "\(change) left the last session's family keys in the ledger")
                #expect(FamilySync.shared(for: phone.vault) !== held, "\(change) kept the last session's family sync")
            }
        }

        /*
         * The same account signs in again from the Files sheet (`adopt`, no sign-out on the way): a
         * sync of the last session that finishes after it deletes nothing the new session wrote, not
         * its opened copy, not its device record. Fails if adopting a new session leaves the last
         * one's cleanup open.
         */
        @Test func anOldSyncThatFinishesAfterAdoptDeletesNothingTheNewSessionWrote() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let account = CopyEpoch()
            let old = try await family.phone(server, account: account)
            defer { old.done(); FamilySync.forget() }
            guard case .accepted = await old.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            SessionChange.adopt.forgetLastSession(account: account)
            let now = try await family.phone(server, records: old.records, guards: old.guards, account: account)
            guard case .accepted = await now.sync.sync(family.summary) else { Issue.record("not accepted again"); return }
            _ = try await now.vault.children(of: family.rootId)
            let folder = try #require(TemporaryCopies.openedFolder(itemId: family.fileId, version: "v1", familyWorkspace: family.workspaceId, in: now.temporary))
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let copy = folder.appendingPathComponent("Recipes.txt")
            try Data("Pancakes".utf8).write(to: copy)
            // The last session's sync, refused and then told not-member, late.
            await old.sync.refuse(family.groupId)
            try? await old.sync.wipe(family.groupId)
            #expect(FileManager.default.fileExists(atPath: copy.path), "the last session's sync deleted the new session's copy")
            #expect(now.records.read(userId: family.member.userId, groupId: family.groupId) != nil, "the last session's sync deleted the new session's record")
        }

        /*
         * The same account signs in again inside the app (after Change password or Rotate account
         * key, which end every session): a sync of the last session that finishes after the new
         * sign-in deletes nothing the new session wrote. Fails if an in-app sign-in leaves the last
         * session's cleanup open.
         */
        @Test func anOldSyncThatFinishesAfterAnInAppSignInDeletesNothingTheNewSessionWrote() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let account = CopyEpoch()
            let old = try await family.phone(server, account: account)
            defer { old.done(); FamilySync.forget() }
            guard case .accepted = await old.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            // What Auth.signIn runs before it stores the new session.
            SessionChange.closeLastSession(account: account)
            let now = try await family.phone(server, records: old.records, guards: old.guards, account: account)
            guard case .accepted = await now.sync.sync(family.summary) else { Issue.record("not accepted again"); return }
            _ = try await now.vault.children(of: family.rootId)
            let folder = try #require(TemporaryCopies.openedFolder(itemId: family.fileId, version: "v1", familyWorkspace: family.workspaceId, in: now.temporary))
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let copy = folder.appendingPathComponent("Recipes.txt")
            try Data("Pancakes".utf8).write(to: copy)
            await old.sync.refuse(family.groupId)
            try? await old.sync.wipe(family.groupId)
            #expect(FileManager.default.fileExists(atPath: copy.path), "the last session's sync deleted the new session's copy")
            #expect(now.records.read(userId: family.member.userId, groupId: family.groupId) != nil, "the last session's sync deleted the new session's record")
        }

        /*
         * A family request of the last session that runs after the sign-in (`inFamily` queued
         * behind it) asks for a sync of the last session's vault: none is handed out, the new
         * session's stays, and a sync made for that vault anyway is kept to that vault's own
         * session, so its start (which sweeps every family copy) and its cleanup delete nothing the
         * new session opened or wrote. Fails if a sync takes the session open when it is made rather
         * than its vault's, or if the registry hands out or swaps in a sync for a replaced vault.
         */
        @Test func aSyncMadeForTheLastSessionsVaultAfterASignInDeletesNothing() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let account = CopyEpoch()
            let old = try await family.phone(server, account: account)
            defer { old.done(); FamilySync.forget() }
            guard case .accepted = await old.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            SessionChange.closeLastSession(account: account)
            // Asked first, while no sync is held (the sign-in let the last one go): still none for the last session's vault.
            #expect(FamilySync.shared(for: old.vault) == nil, "a sync was made for the last session's vault after the sign-in")
            let now = try await family.phone(server, records: old.records, guards: old.guards, account: account)
            guard case .accepted = await now.sync.sync(family.summary) else { Issue.record("not accepted again"); return }
            _ = try await now.vault.children(of: family.rootId)
            let folder = try #require(TemporaryCopies.openedFolder(itemId: family.fileId, version: "v1", familyWorkspace: family.workspaceId, in: now.temporary))
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let copy = folder.appendingPathComponent("Recipes.txt")
            try Data("Pancakes".utf8).write(to: copy)
            // The new session's copy of the folder as a share's (opened before it was proven a family's), where a vault's
            // forget looks: the process's temporary folder, under this test's own workspace id.
            let shares = FileManager.default.temporaryDirectory.appendingPathComponent("opened/share/\(family.workspaceId.lowercased())", isDirectory: true)
            defer { try? FileManager.default.removeItem(at: shares) }
            let shared = shares.appendingPathComponent("\(family.fileId)/v1/Recipes.txt")
            try FileManager.default.createDirectory(at: shared.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("Pancakes".utf8).write(to: shared)
            let held = try #require(FamilySync.shared(for: now.vault))
            #expect(FamilySync.shared(for: old.vault) == nil, "a sync was handed out for the last session's vault")
            #expect(FamilySync.shared(for: now.vault) === held, "the last session's vault displaced the new session's sync")
            let stale = FamilySync(vault: old.vault, api: GroupsAPI(drive: old.vault.api), records: old.records, temporary: now.temporary)
            await stale.refuse(family.groupId)
            try? await stale.wipe(family.groupId)
            #expect(FileManager.default.fileExists(atPath: copy.path), "a sync made for the last session's vault deleted the new session's copy")
            #expect(FileManager.default.fileExists(atPath: shared.path), "the last session's vault deleted the new session's share copy")
            #expect(now.records.read(userId: family.member.userId, groupId: family.groupId) != nil, "a sync made for the last session's vault deleted the new session's record")
        }

        /*
         * A vault made earlier in the same session epoch (one the keychain's vault replaced without a
         * sign-out between) asks for a sync after the later one has its own: none is handed out, and
         * the later vault keeps its sync. Fails if an earlier vault can swap the registry's sync,
         * which drops the later session's checked families and makes its next sync start over.
         */
        @Test func anEarlierVaultNeverTakesALaterOnesPlace() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let account = CopyEpoch()
            let earlier = try await family.phone(server, account: account)
            let later = try await family.phone(server, records: earlier.records, guards: earlier.guards, account: account)
            defer { later.done(); earlier.done(); FamilySync.forget() }
            let held = try #require(FamilySync.shared(for: later.vault))
            #expect(FamilySync.shared(for: earlier.vault) == nil, "a sync was handed out for a vault a later one replaced")
            #expect(FamilySync.shared(for: later.vault) === held, "an earlier vault took the later one's sync")
        }

        /*
         * A family photo open in the viewer when the same account signs in again from Files: once the
         * family is checked again under the new vault, the photo comes down before any listing of its
         * folder lands, since the fetch lists that folder under the new vault itself. Fails if a copy of
         * a row the new vault doesn't hold waits on the screens' listings (the viewer stays on its error).
         */
        @Test func aFamilyFileOnScreenComesDownUnderTheNewVaultWithoutWaitingForAListing() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            server.put(family.photo)
            let version = try #require(family.photo.currentVersion)
            server.objects[version.id] = family.photoObject
            let account = CopyEpoch()
            let old = try await family.phone(server, account: account)
            defer { old.done(); FamilySync.forget() }
            guard case .accepted = await old.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await old.vault.children(of: family.rootId)
            // The viewer's row, from the last session's vault.
            let shown = try #require(await old.vault.item(family.photo.ref))
            SessionChange.closeLastSession(account: account)
            let now = try await family.phone(server, records: old.records, guards: old.guards, account: account)
            guard case .accepted = await now.sync.sync(family.summary) else { Issue.record("not accepted again"); return }
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("held-\(UUID().uuidString)", isDirectory: true)
            defer { try? FileManager.default.removeItem(at: folder) }
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            // As DriveStore.fetch asks: held first, then the copy.
            try await now.vault.holdForCopy(shown)
            let (copied, file) = try await now.vault.downloadCurrent(shown) { _ in folder.appendingPathComponent("photo") }
            #expect(copied.ref == family.photo.ref)
            #expect(try Data(contentsOf: file) == family.photoBytes, "the photo didn't come down under the new vault")
        }

        /*
         * The same, for a photo in a folder inside the family folder: the new vault has opened only the
         * top folder (the family's sync opens no more), and neither the photo's folder nor anything
         * under it. The folder is listed in the photo's own workspace, opening it on the way down.
         * Fails if the listing asks where an unknown folder is looked for (the own drive), which the
         * server answers with no such folder.
         */
        @Test func aNestedFamilyFileComesDownUnderTheNewVaultWithNoListing() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let version = try #require(family.photo.currentVersion)
            let nested = try FamilyFixture.node(id: family.photo.id, in: family.workspaceId, parent: family.docs.id, parentKey: family.docsKey, key: family.photoKey,
                                                kind: .file, name: "Beach.jpg", writer: family.creator, keyEpoch: 3, parentKeyEpoch: 2).with(version: version)
            server.put(family.docs, nested)
            server.objects[version.id] = family.photoObject
            let account = CopyEpoch()
            let old = try await family.phone(server, account: account)
            defer { old.done(); FamilySync.forget() }
            guard case .accepted = await old.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await old.vault.children(of: family.rootId)
            _ = try await old.vault.children(of: family.docs.id)
            let shown = try #require(await old.vault.item(family.photo.ref))
            #expect(shown.node.parentId == family.docs.id)
            SessionChange.closeLastSession(account: account)
            let now = try await family.phone(server, records: old.records, guards: old.guards, account: account)
            guard case .accepted = await now.sync.sync(family.summary) else { Issue.record("not accepted again"); return }
            #expect(await now.vault.item(NodeRef(workspaceId: family.workspaceId, nodeId: family.docs.id)) == nil, "the new vault opened the folder already")
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("nested-\(UUID().uuidString)", isDirectory: true)
            defer { try? FileManager.default.removeItem(at: folder) }
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try await now.vault.holdForCopy(shown)
            let (_, file) = try await now.vault.downloadCurrent(shown) { _ in folder.appendingPathComponent("photo") }
            #expect(try Data(contentsOf: file) == family.photoBytes, "the nested photo didn't come down under the new vault")
        }

        @Test func theSameSessionKeepsItsFamily() async throws {
            guard let (family, phone) = try await accepted() else { return }
            defer { phone.done(); FamilySync.forget() }
            let held = FamilySync.shared(for: phone.vault)
            SessionChange.none.forgetLastSession(account: CopyEpoch())
            #expect(phone.vault.areaLedger.isArea(workspaceId: family.workspaceId))
            #expect(FamilySync.shared(for: phone.vault) === held)
        }
    }
}
