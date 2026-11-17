import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * One settings read serves the readers that only look (`Vault.settingsToLook`: a family sync's
 * steps, the ledger the upgrade pass reads, the contacts list) for a short while, as on the web
 * (lib/contacts.settings-reads.test.ts) and Android (SettingsReuseTest). Through the real vault,
 * marks and family sync against the family stub: what must never come of it is a copy kept across
 * a guard write or a save, a save built on a copy, a copy older than the marks another vault of
 * this phone raised, a rollback a fresh read would refuse, or the folders asked for per family.
 */
extension OnFakeDrive {
    @Suite struct SettingsReuseTests {
        /* A clock the test moves, for the window one read serves. */
        final class Clock: @unchecked Sendable {
            private let lock = NSLock()
            private var now = ContinuousClock.now
            var instant: ContinuousClock.Instant { lock.withLock { now } }
            func pass(_ duration: Duration) { lock.withLock { now = now.advanced(by: duration) } }
        }

        static func marker(_ name: String) -> ContactPin {
            ContactPin(userId: "marker", email: "marker@example.com", name: name, encryptionPublicKey: "e", signingPublicKey: "s",
                       fingerprint: "f", pinnedAt: "2026-10-01T00:00:00Z", kemPublicKeyHash: nil)
        }

        func setUp() async throws -> (FamilyFixture, FamilyServer, FamilyFixture.Phone, Clock) {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            try server.editSettings { $0.setPin(Self.marker("first")) }
            let phone = try await family.phone(server)
            let clock = Clock()
            await phone.vault.useSettingsClock { clock.instant }
            return (family, server, phone, clock)
        }

        /* Looking readers read once, each with a value of its own. Fails if every step fetches. */
        @Test func lookingReadersShareOneRead() async throws {
            let (_, server, phone, _) = try await setUp()
            defer { phone.done() }
            _ = try await phone.vault.markerLooked()
            let reads = server.count("/api/auth/settings")
            _ = try await phone.vault.markerLooked()
            _ = try await phone.vault.familyChecked("anything")
            _ = try await phone.vault.contacts()
            #expect(server.count("/api/auth/settings") == reads)
        }

        /* One family sync reads the settings once, and a pass asks route 25 once for every family it syncs. */
        @Test func aSyncReadsTheSettingsOnceAndAPassAsksForTheFoldersOnce() async throws {
            let (family, server, phone, clock) = try await setUp()
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            // The next sync, past the window, with nothing to save.
            clock.pass(Vault.settingsReuse)
            server.clearRequests()
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted again"); return }
            #expect(server.count("/api/auth/settings") == 1)
            server.clearRequests()
            let pass = await phone.sync.beginPass()
            _ = await phone.sync.sync(family.summary)
            _ = await phone.sync.sync(family.summary)
            await phone.sync.endPass(pass)
            #expect(server.count("/api/drive/spaces") == 1)
            server.clearRequests()
            _ = await phone.sync.sync(family.summary)
            _ = await phone.sync.sync(family.summary)
            #expect(server.count("/api/drive/spaces") == 2)
        }

        /* A guard write in this process (ContactGuardStore.commit moves the generation) drops the copy. */
        @Test func aGuardWriteDropsTheCopy() async throws {
            let (_, server, phone, _) = try await setUp()
            defer { phone.done() }
            #expect(try await phone.vault.markerLooked() == "first")
            try server.editSettings { $0.setPin(Self.marker("after the guard moved")) }
            #expect(try await phone.vault.markerLooked() == "first")
            await phone.vault.contactGuard.generation.bump()
            #expect(try await phone.vault.markerLooked() == "after the guard moved")
        }

        /* A save reads its base now, never the copy (one PUT, never refused), and the copy is gone after it. */
        @Test func aSaveReadsItsBaseNowAndDropsTheCopy() async throws {
            let (_, server, phone, _) = try await setUp()
            defer { phone.done() }
            _ = try await phone.vault.markerLooked()
            try server.editSettings { $0.setPin(Self.marker("another device")) }
            server.clearRequests()
            try await phone.vault.saveLink("link-1", node: "node-a")
            #expect(server.count("/api/auth/settings", method: "PUT") == 1)
            try server.editSettings { $0.ledger.addLink("link-2", node: "node-b") }
            #expect(try await phone.vault.markerLooked() == "another device")
            #expect(try await phone.vault.linksLooked() == ["link-1": "node-a", "link-2": "node-b"])
        }

        /* Later settings another vault of this phone read (the Files app's, a share's) are met by the marks at once. */
        @Test func anotherVaultsLaterReadIsMetByTheMarks() async throws {
            let (family, server, phone, _) = try await setUp()
            defer { phone.done() }
            _ = try await phone.vault.markerLooked()
            try server.editSettings { $0.setPin(Self.marker("read elsewhere")) }
            let other = try await family.phone(server, guards: phone.guards)
            _ = try await other.vault.markerNow()
            #expect(try await phone.vault.markerLooked() == "read elsewhere")
        }

        /* A rollback: refused by a fresh read, and then by every looking reader too. Fails if the copy hides it. */
        @Test func aRollbackIsRefusedByAFreshReadAndNoCopyOutlivesIt() async throws {
            let (_, server, phone, _) = try await setUp()
            defer { phone.done() }
            let older = server.settingsSnapshot()
            try server.editSettings { $0.setPin(Self.marker("newer")) }
            #expect(try await phone.vault.markerLooked() == "newer")
            older()
            // Within the window a looking reader is never handed the older copy.
            #expect(try await phone.vault.markerLooked() == "newer")
            await #expect(throws: (any Error).self) { _ = try await phone.vault.markerNow() }
            await #expect(throws: (any Error).self) { _ = try await phone.vault.markerLooked() }
        }
    }
}

/* What the tests read of the settings, as Sendable values: the marker contact's name and the ledger's links. */
extension Vault {
    func markerLooked() async throws -> String? { try await settingsToLook().contacts["marker"]?.name }
    func markerNow() async throws -> String? { try await loadSettings().contacts["marker"]?.name }
    func linksLooked() async throws -> [String: String] { try await settingsToLook().ledger.links }
    func saveLink(_ id: String, node: String) async throws { _ = try await updateSettings { $0.ledger.addLink(id, node: node) } }
}
