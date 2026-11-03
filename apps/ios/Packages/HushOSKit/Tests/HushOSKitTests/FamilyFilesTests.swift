import Foundation
import Testing
@testable import HushOSKit

/* The system's family locations as a test sees them: what was added and removed, and a removal that can be made to fail. */
final class TestFamilyDomains: FamilyDomainManaging, @unchecked Sendable {
    private let lock = NSLock()
    private var present: [String: String] = [:]
    private(set) var removals: [String] = []
    var removalFails = false

    func domains() async throws -> [String] { lock.withLock { Array(present.keys) } }
    func add(_ identifier: String, name: String) async throws { lock.withLock { present[identifier] = name } }
    func remove(_ identifier: String) async throws {
        try lock.withLock {
            removals.append(identifier)
            if removalFails { throw CocoaError(.fileWriteUnknown) }
            present[identifier] = nil
        }
    }
    func signal(_ identifier: String) async {}

    var names: [String: String] { lock.withLock { present } }
    func put(_ identifier: String, name: String) { lock.withLock { present[identifier] = name } }

    /* A lifecycle over a fresh records folder and this fake, for tests that don't look at it. */
    static func throwaway() -> FamilyFilesDomains {
        FamilyFilesDomains(records: FamilyDomainRecords(folder: FileManager.default.temporaryDirectory.appendingPathComponent("family-domains-\(UUID().uuidString)"), activity: .expired),
                           manager: TestFamilyDomains())
    }
}

/*
 * The families' Files locations (docs/groups-mobile-plan.md, iOS 6): when a location is added and
 * taken, and what the Files extension answers for. Each test fails on the defect it names.
 */
@Suite struct FamilyDomainsTests {
    let manager = TestFamilyDomains()
    let records = FamilyDomainRecords(folder: FileManager.default.temporaryDirectory.appendingPathComponent("family-domains-\(UUID().uuidString)"), activity: .expired)
    var domains: FamilyFilesDomains { FamilyFilesDomains(records: records, manager: manager) }
    static let maya = AccountOwner(userId: UUID().uuidString, origin: "https://hushos.test")
    static let sam = AccountOwner(userId: UUID().uuidString, origin: "https://hushos.test")
    static let group = UUID().uuidString.lowercased()

    /*
     * A let-go takes the record at once, before any system call, and an acceptance from an earlier
     * look that lands after it never brings the location back; a later look does. Fails if a
     * revocation waits on the system, or a late acceptance undoes it.
     */
    @Test func aLetGoTakesTheRecordAtOnceAndAnOlderAcceptanceNeverUndoesIt() async throws {
        let domains = self.domains
        let session = TemporaryCopies.session(CopyEpoch())
        await domains.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, revision: 5, session: session).value
        #expect(try records.read()[Self.group] == FamilyDomainRecord(owner: Self.maya, name: "Lindqvist family"))
        #expect(manager.names[FamilyFileIds.domain(Self.group)] == "Lindqvist family")

        let removal = domains.letGo(Self.group, owner: Self.maya, revision: 7)
        // Gone on disk before the system was asked: every extension call refuses from here.
        #expect(records.admission(Self.group, owner: Self.maya) == .letGo)
        await removal.value
        #expect(manager.names.isEmpty)

        await domains.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, revision: 6, session: session).value
        #expect(records.admission(Self.group, owner: Self.maya) == .letGo, "an acceptance from before the removal brought the location back")
        #expect(manager.names.isEmpty)

        await domains.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, revision: 8, session: session).value
        #expect(records.admission(Self.group, owner: Self.maya) == .admitted)
        #expect(manager.names[FamilyFileIds.domain(Self.group)] != nil)
    }

    /*
     * Account isolation: Maya's family location is never answered for Sam, an acceptance of Sam's
     * never takes over Maya's record, and Sam signing in removes Maya's location and then her
     * record, while Maya's own stay for Maya. Fails if a record of one account admits another.
     */
    @Test func anotherAccountsLocationIsNeverAdmittedAndGoesAtSignIn() async throws {
        let domains = self.domains
        let session = TemporaryCopies.session(CopyEpoch())
        await domains.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, revision: 1, session: session).value
        #expect(records.admission(Self.group, owner: Self.sam) == .otherAccount)
        #expect(records.admission(Self.group, owner: nil) == .otherAccount)

        await domains.accepted(Self.group, name: "Holm family", owner: Self.sam, revision: 2, session: session).value
        #expect(try records.read()[Self.group]?.owner == Self.maya, "another account's acceptance took the record over")
        #expect(records.admission(Self.group, owner: Self.sam) == .otherAccount)

        await domains.reconcile(owner: Self.maya).value
        #expect(manager.names[FamilyFileIds.domain(Self.group)] != nil, "the same account's location went at its own sign-in")

        // A location left with no record (its revocation's removal never ran) goes too.
        let orphan = FamilyFileIds.domain(UUID().uuidString.lowercased())
        manager.put(orphan, name: "Old family")
        await domains.reconcile(owner: Self.sam).value
        #expect(manager.names.isEmpty)
        #expect(try records.read().isEmpty)
    }

    /*
     * Sign-out with a location that couldn't be removed keeps its record, so it stays refused to
     * anyone else; records that can't be read are never taken as none. Fails if a record goes
     * before its location, or an unreadable store reads as "let go" or is written over.
     */
    @Test func aLocationThatStaysKeepsItsRecordAndAnUnreadableStoreDecidesNothing() async throws {
        let domains = self.domains
        let session = TemporaryCopies.session(CopyEpoch())
        await domains.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, revision: 1, session: session).value
        manager.removalFails = true
        await domains.removeAll()
        #expect(try records.read()[Self.group]?.owner == Self.maya, "the record went while its location stayed")
        #expect(records.admission(Self.group, owner: Self.sam) == .otherAccount)
        manager.removalFails = false
        await domains.removeAll()
        #expect(try records.read().isEmpty)

        try Data("not json".utf8).write(to: records.file)
        #expect(records.admission(Self.group, owner: Self.maya) == .unreadable)
        await domains.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, revision: 9, session: session).value
        #expect(try Data(contentsOf: records.file) == Data("not json".utf8), "a store that couldn't be read was written over")
    }

    /* An acceptance of a session that ended adds nothing. Fails if a late sync of the last session adds its family's location. */
    @Test func anEndedSessionsAcceptanceAddsNothing() async throws {
        let account = CopyEpoch()
        let session = TemporaryCopies.session(account)
        TemporaryCopies.endAccount(account)
        await domains.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, revision: 1, session: session).value
        #expect(try records.read().isEmpty)
        #expect(manager.names.isEmpty)
    }

    @Test func idsNameOnlyFamiliesAndTheirOwnItems() {
        let ref = NodeRef(workspaceId: UUID().uuidString, nodeId: UUID().uuidString)
        #expect(FamilyFileIds.ref(FamilyFileIds.item(ref)) == ref)
        #expect(FamilyFileIds.ref("rootContainer") == nil)
        #expect(FamilyFileIds.ref("\(ref.workspaceId):../\(ref.nodeId)") == nil)
        #expect(FamilyFileIds.group(ofDomain: FamilyFileIds.domain(Self.group)) == Self.group)
        #expect(FamilyFileIds.group(ofDomain: "com.hushos.app.drive") == nil)
        #expect(FamilyFileIds.group(ofDomain: "com.hushos.app.family.not-an-id") == nil)
    }
}

extension OnFakeDrive {
    /*
     * The Files extension's family source against the stub server, with real rosters and the core's
     * ledger: it lists only the family's folders, and a revocation found anywhere (on disk, by the
     * extension's own sync) wins over what it accepted, with or without an answer from the server.
     */
    @Suite struct FamilyFilesSourceTests {
        final class Clock: @unchecked Sendable {
            var now = Date()
        }

        struct Source {
            let family: FamilyFixture
            let server: FamilyServer
            let phone: FamilyFixture.Phone
            let domains: FamilyFilesDomains
            let manager: TestFamilyDomains
            let records: FamilyDomainRecords
            let clock: Clock
            let source: FamilyFilesSource
            var owner: AccountOwner { AccountOwner(userId: family.member.userId, origin: "https://family.test") }
        }

        /* The member's phone, its family accepted by the app and its location added, and the extension's source over the same vault. */
        static func source() async throws -> Source {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            server.put(family.photo)
            server.objects[try #require(family.photo.currentVersion).id] = family.photoObject
            let manager = TestFamilyDomains()
            let records = FamilyDomainRecords(folder: FileManager.default.temporaryDirectory.appendingPathComponent("family-domains-\(UUID().uuidString)"), activity: .expired)
            let domains = FamilyFilesDomains(records: records, manager: manager)
            let phone = try await family.phone(server, filesDomains: domains)
            let owner = AccountOwner(userId: family.member.userId, origin: "https://family.test")
            await domains.accepted(family.groupId, name: "Lindqvist family", owner: owner, revision: FamilySync.newestLook(), session: phone.vault.copySession).value
            let clock = Clock()
            let source = FamilyFilesSource(groupId: family.groupId, vault: phone.vault, sync: phone.sync, records: records, now: { clock.now })
            return Source(family: family, server: server, phone: phone, domains: domains, manager: manager, records: records, clock: clock, source: source)
        }

        /*
         * The location lists the family's folder, then its file, and opens its bytes; an item of the
         * member's own drive asked of it is refused before anything is sent. Fails if a family
         * location answers for another workspace's item.
         */
        @Test func itListsAndOpensOnlyTheFamilysFolders() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            let folders = try await s.source.folders()
            #expect(folders.map(\.workspaceId) == [s.family.workspaceId])
            let root = NodeRef(workspaceId: s.family.workspaceId, nodeId: s.family.rootId)
            #expect(try await s.source.isFolderRoot(root))
            let children = try await s.source.children(of: root)
            #expect(children.contains { $0.ref == s.family.photo.ref })
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("family-files-\(UUID().uuidString)/content")
            _ = try await s.source.download(s.family.photo.ref, to: file)
            #expect(try Data(contentsOf: file) == s.family.photoBytes)

            let own = NodeRef(workspaceId: s.family.personal, nodeId: s.family.personalRoot.id)
            let before = s.server.count("/api/drive/nodes/\(own.nodeId)/children")
            await #expect(throws: FamilyFilesError.notInFamily) { _ = try await s.source.children(of: own) }
            await #expect(throws: FamilyFilesError.notInFamily) { _ = try await s.source.item(own) }
            #expect(s.server.count("/api/drive/nodes/\(own.nodeId)/children") == before)
        }

        /*
         * The app lets the family go (its record goes on disk) while the extension still holds an
         * accepted family from a moment ago: every call refuses at once, nothing is sent, and the
         * server going quiet changes nothing. Fails if a cached acceptance outlives a revocation, or
         * no answer brings it back.
         */
        @Test func aRevocationOnDiskWinsOverWhatTheExtensionAcceptedEvenWithNoAnswer() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            _ = try await s.source.folders()
            _ = s.domains.letGo(s.family.groupId, owner: s.owner, revision: FamilySync.newestLook())
            let root = NodeRef(workspaceId: s.family.workspaceId, nodeId: s.family.rootId)
            let before = s.server.count("/api/drive/nodes/\(s.family.rootId)/children")
            await #expect(throws: FamilyFilesError.letGo) { _ = try await s.source.folders() }
            await #expect(throws: FamilyFilesError.letGo) { _ = try await s.source.children(of: root) }
            await #expect(throws: FamilyFilesError.letGo) { _ = try await s.source.download(s.family.photo.ref, to: FileManager.default.temporaryDirectory.appendingPathComponent("x-\(UUID().uuidString)")) }
            #expect(s.server.count("/api/drive/nodes/\(s.family.rootId)/children") == before, "a revoked location asked the server")
            s.server.groupsFail = true
            s.clock.now = s.clock.now.addingTimeInterval(120)
            await #expect(throws: FamilyFilesError.letGo) { _ = try await s.source.folders() }
        }

        /*
         * No answer after the family was accepted keeps the folders, read only; the server's
         * not-member, found by the extension's own sync, takes the record and asks for the location
         * to go, so the next call refuses without asking again. Fails if a removal found in the
         * extension leaves the location answering, or no answer is taken as a removal.
         */
        @Test func noAnswerKeepsTheFolderAndARemovalTheExtensionFindsTakesIt() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            _ = try await s.source.folders()
            s.server.groupsFail = true
            s.clock.now = s.clock.now.addingTimeInterval(120)
            #expect(try await s.source.folders().count == 1, "no answer was taken as a removal")

            s.server.groupsFail = false
            s.server.notMember = true
            s.clock.now = s.clock.now.addingTimeInterval(120)
            await #expect(throws: FamilyFilesError.letGo) { _ = try await s.source.folders() }
            #expect(s.records.admission(s.family.groupId, owner: s.owner) == .letGo)
            await s.domains.settled()
            #expect(s.manager.removals.contains(FamilyFileIds.domain(s.family.groupId)))
            let traffic = s.server.count("/api/groups")
            s.server.notMember = false
            await #expect(throws: FamilyFilesError.letGo) { _ = try await s.source.folders() }
            #expect(s.server.count("/api/groups") == traffic, "a let-go location asked the server again")
        }

        /*
         * A revocation that lands while a file comes down leaves no copy behind. Fails if the
         * decrypted file is handed on (or kept) once the location's record is gone.
         */
        @Test func aDownloadARevocationLandsDuringLeavesNothing() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            let root = NodeRef(workspaceId: s.family.workspaceId, nodeId: s.family.rootId)
            _ = try await s.source.children(of: root)
            let (domains, group, owner) = (s.domains, s.family.groupId, s.owner)
            await s.phone.vault.setBeforeChunk { _ in _ = domains.letGo(group, owner: owner, revision: FamilySync.newestLook()) }
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("family-files-\(UUID().uuidString)/content")
            await #expect(throws: FamilyFilesError.letGo) { _ = try await s.source.download(s.family.photo.ref, to: file) }
            #expect(!FileManager.default.fileExists(atPath: file.path), "a copy outlived the revocation")
        }

        /*
         * Another account's session over this family's location: refused. Fails if the record's
         * owner isn't checked against the session the source serves.
         */
        @Test func anotherAccountsLocationRefusesThisSession() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            await s.domains.removeAll()
            let other = AccountOwner(userId: UUID().uuidString, origin: "https://family.test")
            await s.domains.accepted(s.family.groupId, name: "Lindqvist family", owner: other, revision: FamilySync.newestLook(), session: s.phone.vault.copySession).value
            await #expect(throws: FamilyFilesError.otherAccount) { _ = try await s.source.folders() }
        }
    }
}
