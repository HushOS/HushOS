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
                change.forgetLastSession()
                #expect(!phone.vault.areaLedger.isArea(workspaceId: family.workspaceId), "\(change) left the last session's family keys in the ledger")
                #expect(FamilySync.shared(for: phone.vault) !== held, "\(change) kept the last session's family sync")
            }
        }

        @Test func theSameSessionKeepsItsFamily() async throws {
            guard let (family, phone) = try await accepted() else { return }
            defer { phone.done(); FamilySync.forget() }
            let held = FamilySync.shared(for: phone.vault)
            SessionChange.none.forgetLastSession()
            #expect(phone.vault.areaLedger.isArea(workspaceId: family.workspaceId))
            #expect(FamilySync.shared(for: phone.vault) === held)
        }
    }
}
