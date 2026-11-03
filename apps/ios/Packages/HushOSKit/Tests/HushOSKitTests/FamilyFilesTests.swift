import Foundation
import Testing
@testable import HushOSKit

/* The system's family locations as a test sees them: what was added and removed, and a removal that can be made to fail. */
final class TestFamilyDomains: FamilyDomainManaging, @unchecked Sendable {
    private let lock = NSLock()
    private var present: [String: String] = [:]
    private(set) var removals: [String] = []
    var removalFails = false

    /* Run as the system is asked for its locations, and as a location is added: what another process does meanwhile. */
    var duringDomains: (@Sendable () -> Void)?
    /* Awaited before the added location appears: another process's whole let-go, its removal included, can land first. */
    var duringAdd: (@Sendable () async -> Void)?
    private(set) var adds: [String] = []

    func domains() async throws -> [String] {
        let hook = lock.withLock { () -> (@Sendable () -> Void)? in defer { duringDomains = nil }; return duringDomains }
        hook?()
        return lock.withLock { Array(present.keys) }
    }
    func add(_ identifier: String, name: String) async throws {
        let hook = lock.withLock { () -> (@Sendable () async -> Void)? in defer { duringAdd = nil }; return duringAdd }
        await hook?()
        lock.withLock {
            present[identifier] = name
            adds.append(identifier)
        }
    }
    func remove(_ identifier: String) async throws {
        try lock.withLock {
            removals.append(identifier)
            if removalFails { throw CocoaError(.fileWriteUnknown) }
            present[identifier] = nil
        }
    }
    func signal(_ identifier: String) async {}
    private(set) var resolutions: [String] = []
    func resolved(_ identifier: String) async { lock.withLock { resolutions.append(identifier) } }

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
     * A let-go takes the record at once, before any system call, and an acceptance whose check
     * began before it never brings the location back, even when the let-go came from another
     * process (another lifecycle over the same store: the extension's); one that began after does.
     * Fails if revocations are ordered only within one process, or a revocation waits on the system.
     */
    @Test func aLetGoInAnyProcessBeatsAnAcceptanceThatBeganBeforeIt() async throws {
        let app = self.domains
        let extensionProcess = FamilyFilesDomains(records: records, manager: manager)
        let session = TemporaryCopies.session(CopyEpoch())
        await app.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, observed: records.generation(Self.group), session: session).value
        #expect(try records.read()[Self.group]?.owner == Self.maya)
        #expect(manager.names[FamilyFileIds.domain(Self.group)] == "Lindqvist family")

        // The app's next check begins, then the extension finds the family let go of.
        let stale = records.generation(Self.group)
        let removal = extensionProcess.letGo(Self.group, owner: Self.maya)
        // Gone on disk before the system was asked: every extension call refuses from here.
        #expect(records.admission(Self.group, owner: Self.maya) == .letGo)
        await removal.value
        #expect(manager.names.isEmpty)

        await app.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, observed: stale, session: session).value
        #expect(records.admission(Self.group, owner: Self.maya) == .letGo, "an acceptance begun before the removal brought the record back")
        #expect(manager.names.isEmpty, "an acceptance begun before the removal brought the location back")
        // Without a generation taken before the check (a join's, a member check's), nothing is added.
        await app.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, observed: nil, session: session).value
        #expect(manager.names.isEmpty)

        await app.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, observed: records.generation(Self.group), session: session).value
        #expect(records.admission(Self.group, owner: Self.maya) == .admitted)
        #expect(manager.names[FamilyFileIds.domain(Self.group)] != nil)
    }

    /*
     * Signing in as the same account keeps its family locations and tells each that the session is
     * back, as the drive's is; another account's goes and is told nothing. Fails if a kept family
     * location stays paused on "not signed in".
     */
    @Test func aSignInTellsTheKeptFamilyLocationsTheSessionIsBack() async throws {
        let domains = self.domains
        let session = TemporaryCopies.session(CopyEpoch())
        await domains.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, observed: records.generation(Self.group), session: session).value
        let other = FamilyFileIds.domain(UUID().uuidString.lowercased())
        manager.put(other, name: "Old family")
        await domains.reconcile(owner: Self.maya).value
        #expect(manager.resolutions == [FamilyFileIds.domain(Self.group)])
    }

    /*
     * Copies of family folders: a let-go takes this process's copies of the folders its record
     * named, and a process starting sweeps every family folder no record names, keeping those one
     * does. A store that can't be read sweeps nothing. Fails if plaintext of a family let go of
     * outlives it in a process's temporary folder.
     */
    @Test func copiesOfFamiliesNoRecordNamesGo() async throws {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("family-tmp-\(UUID().uuidString)", isDirectory: true)
        let domains = FamilyFilesDomains(records: records, manager: manager, temporary: temporary)
        let (kept, stray, revoked) = (UUID().uuidString.lowercased(), UUID().uuidString.lowercased(), UUID().uuidString.lowercased())
        func copy(_ workspace: String) throws -> URL {
            let folder = temporary.appendingPathComponent("opened/family/\(workspace)/files/x/y", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent("content.part")
            try Data("plaintext".utf8).write(to: file)
            return file
        }
        let session = TemporaryCopies.session(CopyEpoch())
        let other = UUID().uuidString.lowercased()
        await domains.accepted(Self.group, name: "Lindqvist family", workspaces: [kept], owner: Self.maya, observed: records.generation(Self.group), session: session).value
        await domains.accepted(other, name: "Holm family", workspaces: [revoked], owner: Self.maya, observed: records.generation(other), session: session).value
        let (keptCopy, strayCopy, revokedCopy) = (try copy(kept), try copy(stray), try copy(revoked))

        _ = domains.letGo(other, owner: Self.maya)
        #expect(!FileManager.default.fileExists(atPath: revokedCopy.path), "a let-go left this process's copies of the family")

        try Data("not json".utf8).write(to: records.file)
        #expect(!domains.sweepUnrecorded())
        #expect(FileManager.default.fileExists(atPath: strayCopy.path), "an unreadable store swept copies")
        try FileManager.default.removeItem(at: records.file)
        await domains.accepted(Self.group, name: "Lindqvist family", workspaces: [kept], owner: Self.maya, observed: records.generation(Self.group), session: session).value
        #expect(domains.sweepUnrecorded())
        #expect(!FileManager.default.fileExists(atPath: strayCopy.path), "a copy of a family no record names survived the sweep")
        #expect(FileManager.default.fileExists(atPath: keptCopy.path), "a recorded family's copy was swept")
    }

    /*
     * A let-go from a session that ended (an old sync answering after the same account signed in
     * again) touches nothing of the session now: its record, generation and location stay. Fails if
     * a late refusal of the last session takes the new session's location.
     */
    @Test func aLateLetGoOfAnEndedSessionTouchesNothing() async throws {
        let domains = self.domains
        let account = CopyEpoch()
        let old = TemporaryCopies.session(account)
        TemporaryCopies.endAccount(account)
        let now = TemporaryCopies.session(account)
        await domains.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, observed: records.generation(Self.group), session: now).value
        let generation = records.generation(Self.group)
        await domains.letGo(Self.group, owner: Self.maya, session: old).value
        #expect(records.admission(Self.group, owner: Self.maya) == .admitted, "an ended session's let-go took the record")
        #expect(records.generation(Self.group) == generation)
        #expect(manager.removals.isEmpty, "an ended session's let-go removed the location")
        await domains.letGo(Self.group, owner: Self.maya, session: now).value
        #expect(records.admission(Self.group, owner: Self.maya) == .letGo)
    }

    /*
     * The store's lock can't be had when a let-go comes: the location still goes, the let-go is kept
     * in this process and written before anything else is decided, so an acceptance begun before it
     * is refused once the lock frees, and nothing is added while it is pending. Fails if a let-go the
     * store refused is simply lost.
     */
    @Test func aLetGoTheStoreRefusesIsKeptUntilItIsWritten() async throws {
        let domains = self.domains
        let session = TemporaryCopies.session(CopyEpoch())
        await domains.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, observed: records.generation(Self.group), session: session).value
        let before = records.generation(Self.group)
        let held = open(records.lockPath, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        #expect(flock(held, LOCK_EX | LOCK_NB) == 0)
        await domains.letGo(Self.group, owner: Self.maya).value
        #expect(manager.removals == [FamilyFileIds.domain(Self.group)], "the location stayed because the store refused the let-go")
        #expect(try records.read()[Self.group] != nil, "the lock was taken after all")
        #expect(domains.revocationPending(Self.group))
        await domains.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, observed: records.generation(Self.group), session: session).value
        #expect(manager.names.isEmpty, "a location was added while a let-go was pending")
        flock(held, LOCK_UN)
        close(held)
        await domains.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, observed: before, session: session).value
        #expect(!domains.revocationPending(Self.group))
        #expect(records.admission(Self.group, owner: Self.maya) == .letGo, "an acceptance begun before the pending let-go wrote the record back")
        #expect(manager.names.isEmpty)
    }

    /*
     * Another process lets the family go while this one waits on the system for its locations, or
     * while the location is being added: the acceptance adds nothing, or takes back what it added.
     * Fails if an acceptance checked only before it waited re-adds a revoked family's location.
     */
    @Test func aLetGoWhileTheLocationIsBeingAddedLeavesNoLocation() async throws {
        let app = self.domains
        let extensionProcess = FamilyFilesDomains(records: records, manager: manager)
        let session = TemporaryCopies.session(CopyEpoch())
        let (group, maya) = (Self.group, Self.maya)
        manager.duringDomains = { _ = extensionProcess.letGo(group, owner: maya) }
        await app.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: session).value
        await extensionProcess.settled()
        #expect(manager.adds.isEmpty, "a location was added after another process let the family go")
        #expect(manager.names.isEmpty)

        manager.duringAdd = { await extensionProcess.letGo(group, owner: maya).value }
        await app.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: session).value
        await extensionProcess.settled()
        #expect(manager.adds.count == 1)
        #expect(manager.names.isEmpty, "a location added while another process let the family go stayed")
        #expect(records.admission(group, owner: maya) == .letGo)
    }

    /* A renamed family's location takes the new name. Fails if an existing location keeps the old one. */
    @Test func aRenamedFamilysLocationTakesTheNewName() async throws {
        let domains = self.domains
        let session = TemporaryCopies.session(CopyEpoch())
        await domains.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, observed: records.generation(Self.group), session: session).value
        await domains.accepted(Self.group, name: "The Lindqvists", owner: Self.maya, observed: records.generation(Self.group), session: session).value
        #expect(manager.names[FamilyFileIds.domain(Self.group)] == "The Lindqvists")
        #expect(try records.read()[Self.group]?.name == "The Lindqvists")
    }

    /*
     * The sign-in sheet: each Files location asks once until someone signs in, whatever another
     * asked. Fails if a family location can't ask because the drive's (or another family's) did.
     */
    @Test func eachLocationAsksForTheSignInSheetOnce() {
        let asks = SignInAsks()
        let drive = "com.hushos.app.drive", family = FamilyFileIds.domain(Self.group)
        #expect(asks.first(drive))
        #expect(asks.first(family), "a family location couldn't ask because the drive's had")
        #expect(!asks.first(family))
        #expect(!asks.first(drive))
        asks.reset()
        #expect(asks.first(family))
    }

    /*
     * Account isolation: Maya's family location is never answered for Sam, an acceptance of Sam's
     * never takes over Maya's record, and Sam signing in removes Maya's location and then her
     * record, while Maya's own stay for Maya. Fails if a record of one account admits another.
     */
    @Test func anotherAccountsLocationIsNeverAdmittedAndGoesAtSignIn() async throws {
        let domains = self.domains
        let session = TemporaryCopies.session(CopyEpoch())
        await domains.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, observed: records.generation(Self.group), session: session).value
        #expect(records.admission(Self.group, owner: Self.sam) == .otherAccount)
        #expect(records.admission(Self.group, owner: nil) == .otherAccount)

        await domains.accepted(Self.group, name: "Holm family", owner: Self.sam, observed: records.generation(Self.group), session: session).value
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
        await domains.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, observed: records.generation(Self.group), session: session).value
        manager.removalFails = true
        await domains.removeAll()
        #expect(try records.read()[Self.group]?.owner == Self.maya, "the record went while its location stayed")
        #expect(records.admission(Self.group, owner: Self.sam) == .otherAccount)
        manager.removalFails = false
        await domains.removeAll()
        #expect(try records.read().isEmpty)

        try Data("not json".utf8).write(to: records.file)
        #expect(records.admission(Self.group, owner: Self.maya) == .unreadable)
        await domains.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, observed: records.generation(Self.group), session: session).value
        #expect(try Data(contentsOf: records.file) == Data("not json".utf8), "a store that couldn't be read was written over")
    }

    /* An acceptance of a session that ended adds nothing. Fails if a late sync of the last session adds its family's location. */
    @Test func anEndedSessionsAcceptanceAddsNothing() async throws {
        let account = CopyEpoch()
        let session = TemporaryCopies.session(account)
        TemporaryCopies.endAccount(account)
        await domains.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, observed: records.generation(Self.group), session: session).value
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
            let temporary: URL
            var owner: AccountOwner { AccountOwner(userId: family.member.userId, origin: "https://family.test") }
        }

        /* The member's phone, its family accepted by the app and its location added, and the extension's source over the same vault. */
        static func source(account: CopyEpoch = CopyEpoch()) async throws -> Source {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            server.put(family.photo)
            server.objects[try #require(family.photo.currentVersion).id] = family.photoObject
            let manager = TestFamilyDomains()
            let records = FamilyDomainRecords(folder: FileManager.default.temporaryDirectory.appendingPathComponent("family-domains-\(UUID().uuidString)"), activity: .expired)
            let domains = FamilyFilesDomains(records: records, manager: manager)
            let phone = try await family.phone(server, account: account, filesDomains: domains)
            let owner = AccountOwner(userId: family.member.userId, origin: "https://family.test")
            await domains.accepted(family.groupId, name: "Lindqvist family", workspaces: [family.workspaceId], owner: owner, observed: records.generation(family.groupId),
                                   session: phone.vault.copySession).value
            let clock = Clock()
            let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("family-src-\(UUID().uuidString)", isDirectory: true)
            let source = FamilyFilesSource(groupId: family.groupId, vault: phone.vault, sync: phone.sync, records: records, temporary: temporary, now: { clock.now })
            return Source(family: family, server: server, phone: phone, domains: domains, manager: manager, records: records, clock: clock, source: source, temporary: temporary)
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
            let (file, _) = try await s.source.download(s.family.photo.ref)
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
            _ = s.domains.letGo(s.family.groupId, owner: s.owner)
            let root = NodeRef(workspaceId: s.family.workspaceId, nodeId: s.family.rootId)
            let before = s.server.count("/api/drive/nodes/\(s.family.rootId)/children")
            await #expect(throws: FamilyFilesError.letGo) { _ = try await s.source.folders() }
            await #expect(throws: FamilyFilesError.letGo) { _ = try await s.source.children(of: root) }
            await #expect(throws: FamilyFilesError.letGo) { _ = try await s.source.download(s.family.photo.ref) }
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
            await s.phone.vault.setBeforeChunk { _ in _ = domains.letGo(group, owner: owner) }
            await #expect(throws: FamilyFilesError.letGo) { _ = try await s.source.download(s.family.photo.ref) }
            let copies = s.temporary.appendingPathComponent("opened/family/\(s.family.workspaceId)")
            #expect(!FileManager.default.fileExists(atPath: copies.path), "a copy outlived the revocation")
        }

        /*
         * A key change lands in the family's folder while Files reads its feed: nothing is called
         * deleted and the batch fails with the anchor where it was; the next read checks the family
         * first and brings the items back. Fails if a key change mid-feed is taken for a deletion.
         */
        @Test func aKeyChangeMidFeedDeletesNothingAndTheItemsComeBack() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            _ = try await s.source.folders()
            let anchor = FamilyAnchor(folders: [s.family.workspaceId: .init(root: s.family.rootId, cursor: 0)])
            try s.server.replaceKeys()
            do {
                let changes = try await s.source.changes(since: anchor)
                Issue.record("a key change mid-feed answered \(changes?.deleted.count ?? -1) deletions")
            } catch {
                #expect(error as? FamilyFilesError == .keyChange)
            }
            let again = try #require(try await s.source.changes(since: anchor))
            #expect(again.deleted.isEmpty, "items were deleted after the key change")
            #expect(again.updated.contains { $0.ref == s.family.photo.ref })
        }

        /*
         * The sync of a session that ended (the account signed in again) finds the family let go of
         * late: the hook it carries touches nothing of the session now. Fails if a sync's let-go
         * isn't bound to the session it was made in.
         */
        @Test func aLateLetGoFromAnEndedSessionsSyncKeepsTheNewSessionsLocation() async throws {
            let account = CopyEpoch()
            let s = try await Self.source(account: account)
            defer { s.phone.done() }
            TemporaryCopies.endAccount(account)
            await s.domains.accepted(s.family.groupId, name: "Lindqvist family", owner: s.owner, observed: s.records.generation(s.family.groupId),
                                     session: TemporaryCopies.session(account)).value
            s.phone.sync.releases.post(s.family.groupId, FamilySync.Revised(state: .wiped, revision: FamilySync.newestLook()))
            await s.domains.settled()
            #expect(s.records.admission(s.family.groupId, owner: s.owner) == .admitted, "an ended session's sync took the new session's location")
            #expect(s.manager.removals.isEmpty)
        }

        /*
         * The family is let go of while the extension checks it again, but the check answers neither
         * a removal nor an acceptance (route 2 stops listing it while route 3 still serves it, or
         * route 2 doesn't answer): the view held from before is never served once the record is
         * gone. Fails if a cached fallback skips the record after an await.
         */
        @Test func aCachedViewIsNeverServedPastALetGoDuringTheCheck() async throws {
            for unanswered in [false, true] {
                let s = try await Self.source()
                defer { s.phone.done() }
                _ = try await s.source.folders()
                let other = FamilyFilesDomains(records: s.records, manager: s.manager)
                let (group, owner, server) = (s.family.groupId, s.owner, s.server)
                server.lock.withLock {
                    if unanswered { server.groupsFail = true } else { server.listed = false }
                    server.manage.beforeAnswer = { method, path in
                        guard method == "GET", path == "/api/groups" else { return }
                        server.lock.withLock { server.manage.beforeAnswer = nil }
                        _ = other.letGo(group, owner: owner)
                    }
                }
                s.clock.now = s.clock.now.addingTimeInterval(120)
                await #expect(throws: FamilyFilesError.letGo) { _ = try await s.source.folders() }
            }
        }

        /*
         * The session the source serves ended (a sign-out, another account): even a fresh view held
         * from a moment ago isn't served. Fails if admission asks only the record.
         */
        @Test func anEndedSessionsSourceServesNothing() async throws {
            let account = CopyEpoch()
            let s = try await Self.source(account: account)
            defer { s.phone.done() }
            _ = try await s.source.folders()
            TemporaryCopies.endAccount(account)
            await #expect(throws: FamilyFilesError.otherAccount) { _ = try await s.source.folders() }
        }

        /*
         * A let-go this process couldn't write keeps the extension refusing the family, though the
         * record on disk still stands. Fails if the extension admits by the record alone.
         */
        @Test func aPendingLetGoRefusesTheExtension() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            _ = try await s.source.folders()
            let held = open(s.records.lockPath, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
            #expect(flock(held, LOCK_EX | LOCK_NB) == 0)
            defer { flock(held, LOCK_UN); close(held) }
            await s.domains.letGo(s.family.groupId, owner: s.owner).value
            #expect(try s.records.read()[s.family.groupId] != nil)
            await #expect(throws: FamilyFilesError.letGo) { _ = try await s.source.folders() }
        }

        /*
         * Another process revokes the family while a file comes down, and the transfer then fails
         * (here it is cancelled): nothing of the file stays, not even the partial a retry would
         * continue. Fails if a failed transfer skips the revocation check and keeps its `.part`.
         */
        @Test func aRevocationDuringADownloadThatThenFailsLeavesNoPlaintext() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            let root = NodeRef(workspaceId: s.family.workspaceId, nodeId: s.family.rootId)
            _ = try await s.source.children(of: root)
            let extensionProcess = FamilyFilesDomains(records: s.records, manager: s.manager)
            let (group, owner) = (s.family.groupId, s.owner)
            let copies = s.temporary.appendingPathComponent("opened/family/\(s.family.workspaceId)")
            await s.phone.vault.setBeforeChunk { _ in
                // Something of the file is already on disk, as a partial a retry would continue.
                let partial = copies.appendingPathComponent("files/partial.part")
                try? FileManager.default.createDirectory(at: partial.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? Data("decrypted bytes".utf8).write(to: partial)
                _ = extensionProcess.letGo(group, owner: owner)
                withUnsafeCurrentTask { $0?.cancel() }
            }
            await #expect(throws: (any Error).self) { _ = try await s.source.download(s.family.photo.ref) }
            #expect(!FileManager.default.fileExists(atPath: copies.path), "plaintext outlived a revocation whose transfer failed")
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
            await s.domains.accepted(s.family.groupId, name: "Lindqvist family", owner: other, observed: s.records.generation(s.family.groupId), session: s.phone.vault.copySession).value
            await #expect(throws: FamilyFilesError.otherAccount) { _ = try await s.source.folders() }
        }
    }
}
