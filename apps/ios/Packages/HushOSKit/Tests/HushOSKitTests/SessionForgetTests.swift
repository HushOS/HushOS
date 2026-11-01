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
