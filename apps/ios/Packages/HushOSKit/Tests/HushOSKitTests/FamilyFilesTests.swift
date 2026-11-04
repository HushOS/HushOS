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
    var duringDomains: (@Sendable () async -> Void)?
    /* Awaited before the added location appears: another process's whole let-go, its removal included, can land first. */
    var duringAdd: (@Sendable () async -> Void)?
    private(set) var adds: [String] = []

    var addFails = false

    func domains() async throws -> [String: String] {
        let hook = lock.withLock { () -> (@Sendable () async -> Void)? in defer { duringDomains = nil }; return duringDomains }
        await hook?()
        return lock.withLock { present }
    }
    func add(_ identifier: String, name: String) async throws {
        let hook = lock.withLock { () -> (@Sendable () async -> Void)? in defer { duringAdd = nil }; return duringAdd }
        await hook?()
        try lock.withLock {
            adds.append(identifier)
            if addFails { throw CocoaError(.fileWriteUnknown) }
            present[identifier] = name
        }
    }
    /* Awaited before a removal takes effect: what another process does while the system removes the location. */
    var duringRemove: (@Sendable () async -> Void)?

    func remove(_ identifier: String) async throws {
        let hook = lock.withLock { () -> (@Sendable () async -> Void)? in defer { duringRemove = nil }; return duringRemove }
        await hook?()
        try lock.withLock {
            removals.append(identifier)
            if removalFails { throw CocoaError(.fileWriteUnknown) }
            present[identifier] = nil
        }
    }
    private(set) var signals: [String] = []
    func signal(_ identifier: String) async { lock.withLock { signals.append(identifier) } }
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
    /* The shared keychain as every lifecycle of the suite reads it: who is signed in. */
    let keychain = OnFakeDrive.FamilyFilesSourceTests.Shared(nil)
    var domains: FamilyFilesDomains { FamilyFilesDomains(records: records, manager: manager, sharedSession: { [keychain] in keychain.session }) }

    /* `owner` signed in, as the app is before it reconciles. */
    func signIn(_ owner: AccountOwner) { keychain.session = SharedKeychain.Session(origin: owner.origin, token: owner.userId, userId: owner.userId) }
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
        signIn(Self.maya)
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
            let folder = temporary.appendingPathComponent("opened/family/\(workspace)/x/y", isDirectory: true)
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

    /*
     * The same account signs in again (a new token) while the extension still serves the old
     * session: the old session ends here as the new one is admitted, so a late let-go of the old
     * session's sync touches nothing of the new location. Fails if a token change keeps the old
     * session standing.
     */
    @Test func aNewTokenForTheSameAccountEndsTheOldSessionInTheExtension() async throws {
        let account = CopyEpoch()
        let owner = AccountOwner(userId: Self.maya.userId, origin: Self.maya.origin)
        final class Current: @unchecked Sendable { var session: SharedKeychain.Session; init(session: SharedKeychain.Session) { self.session = session } }
        let current = Current(session: SharedKeychain.Session(origin: Self.maya.origin, token: "old", userId: Self.maya.userId))
        let gate = FilesGate<CopySession>(owner: { owner }, session: { current.session }, account: account) { _ in TemporaryCopies.session(account) }
        let old = try gate.open()
        #expect(old.stands)
        current.session = SharedKeychain.Session(origin: Self.maya.origin, token: "new", userId: Self.maya.userId)
        let now = try gate.open()
        #expect(!old.stands, "the old token's session still stands in the extension")
        #expect(now.stands)
        let domains = self.domains
        await domains.accepted(Self.group, name: "Lindqvist family", owner: owner, observed: records.generation(Self.group), session: now).value
        await domains.letGo(Self.group, owner: owner, session: old).value
        #expect(records.admission(Self.group, owner: owner) == .admitted, "the old session's let-go took the new session's location")
        #expect(manager.removals.isEmpty)
        // The same session asked again changes nothing.
        _ = try gate.open()
        #expect(now.stands)
    }

    /*
     * A rename whose system call fails is tried again by the next acceptance, though the record
     * already holds the new name. Fails if the name is compared with the record, not the location.
     */
    @Test func aRenameWhoseAddFailedIsTriedAgain() async throws {
        let domains = self.domains
        let session = TemporaryCopies.session(CopyEpoch())
        let identifier = FamilyFileIds.domain(Self.group)
        await domains.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, observed: records.generation(Self.group), session: session).value
        manager.addFails = true
        await domains.accepted(Self.group, name: "The Lindqvists", owner: Self.maya, observed: records.generation(Self.group), session: session).value
        #expect(manager.names[identifier] == "Lindqvist family")
        manager.addFails = false
        await domains.accepted(Self.group, name: "The Lindqvists", owner: Self.maya, observed: records.generation(Self.group), session: session).value
        #expect(manager.names[identifier] == "The Lindqvists", "a rename whose add failed was never tried again")
    }

    /*
     * What lets a family's Files location go: a removal, a fork, a family waiting or unchecked, a
     * definite refusal; never no answer or a lost session. Fails if a recoverable failure takes the
     * location (and with it what Files holds), or a definite one keeps it.
     */
    @Test func onlyADefiniteLetGoTakesTheLocation() {
        func revised(_ state: FamilyState, _ cause: FamilySync.FailureCause? = nil) -> FamilySync.Revised { .init(state: state, revision: 1, cause: cause) }
        #expect(!revised(.failed("HushOS is temporarily unavailable."), .noAnswer).letsFilesGo)
        #expect(!revised(.failed("You were signed out. Sign in again, then retry."), .session).letsFilesGo)
        #expect(!revised(.failed(FamilyWords.noAnswer)).letsFilesGo)
        #expect(revised(.failed("This member list doesn’t check."), .refusal).letsFilesGo)
        #expect(revised(.failed("A wipe that couldn’t finish.")).letsFilesGo)
        #expect(revised(.wiped).letsFilesGo)
        #expect(revised(.waiting).letsFilesGo)
        #expect(revised(.unchecked).letsFilesGo)
        #expect(FamilySync.cause(of: GroupsAPIError(status: 503, code: nil, message: "Busy.")) == .noAnswer)
        #expect(FamilySync.cause(of: DriveAPIError.transport("offline")) == .noAnswer)
        #expect(FamilySync.cause(of: GroupsAPIError(status: 401, code: nil, message: "Sign in.")) == .session)
        #expect(FamilySync.cause(of: FamilyFailure(message: "The chain didn’t check.")) == .refusal)
    }

    /*
     * A let-go the store refused is kept with the session it came from: once that session ended (the
     * account signed in again), its retry writes nothing, and the new session's record stays. Fails if
     * a pending let-go is retried as whoever's and takes the next session's location.
     */
    @Test func aPendingLetGoOfAnEndedSessionIsDroppedNotWritten() async throws {
        let domains = self.domains
        let account = CopyEpoch()
        let old = TemporaryCopies.session(account)
        await domains.accepted(Self.group, name: "Lindqvist family", owner: Self.maya, observed: records.generation(Self.group), session: old).value
        let held = open(records.lockPath, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        #expect(flock(held, LOCK_EX | LOCK_NB) == 0)
        _ = domains.letGo(Self.group, owner: Self.maya, session: old)
        TemporaryCopies.endAccount(account)
        flock(held, LOCK_UN)
        close(held)
        #expect(!domains.revocationPending(Self.group))
        #expect(records.admission(Self.group, owner: Self.maya) == .admitted, "an ended session's pending let-go took the record")
        #expect(records.generation(Self.group) == 0)
    }

    /*
     * An old process's let-go of the family reaches its queued removal after another account added
     * the same family: that account's location stays. Fails if a removal doesn't ask whose the
     * family's record is by then.
     */
    @Test func aQueuedRemovalLeavesAnotherAccountsLocation() async throws {
        let old = FamilyFilesDomains(records: records, manager: manager)
        let session = TemporaryCopies.session(CopyEpoch())
        let (group, maya, sam, records, manager) = (Self.group, Self.maya, Self.sam, self.records, self.manager)
        await old.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: session).value
        // Keep the old process's queue busy until Sam's account has added the family (as the app would after the switch).
        let other = UUID().uuidString.lowercased()
        manager.duringDomains = {
            records.update { $0.records[group] = FamilyDomainRecord(owner: sam, name: "Lindqvist family") }
            manager.put(FamilyFileIds.domain(group), name: "Lindqvist family")
        }
        let busy = old.accepted(other, name: "Holm family", owner: maya, observed: records.generation(other), session: session)
        let removal = old.letGo(group, owner: maya)
        await busy.value
        await removal.value
        #expect(manager.names[FamilyFileIds.domain(group)] != nil, "the old account's let-go removed Sam's location")
        #expect(try records.read()[group]?.owner == sam)
    }

    /*
     * The extension's let-go of the family waits behind another of its calls while the app accepts
     * the family again (the member was let back in), at the generation that let-go moved it to: the
     * removal, when its turn comes, leaves the fresh location, whether the let-go was written at once
     * or left pending and written by a later call. Fails if a queued removal can't tell a record
     * written after its let-go from one written before.
     */
    @Test func anOldQueuedRemovalLeavesAFamilyAcceptedAfterIt() async throws {
        for pendingFirst in [false, true] {
            let app = self.domains
            let extensionProcess = FamilyFilesDomains(records: records, manager: manager)
            let session = TemporaryCopies.session(CopyEpoch())
            let (group, maya, records) = (UUID().uuidString.lowercased(), Self.maya, self.records)
            await app.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: session).value
            let held = pendingFirst ? open(records.lockPath, O_RDWR | O_CREAT | O_CLOEXEC, 0o600) : -1
            let (entered, enter) = AsyncStream<Void>.makeStream()
            let (letGoCalled, called) = AsyncStream<Void>.makeStream()
            // The extension's queue is busy until the app has accepted the family again.
            manager.duringAdd = {
                enter.yield()
                for await _ in letGoCalled { break }
                if pendingFirst {
                    flock(held, LOCK_UN)
                    close(held)
                    // The extension's next call writes the let-go it couldn't.
                    #expect(!extensionProcess.revocationPending(group))
                }
                await app.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: session).value
            }
            let busy = extensionProcess.accepted(UUID().uuidString.lowercased(), name: "Holm family", owner: maya, observed: 0, session: session)
            for await _ in entered { break }
            // The store refuses the let-go (its lock held elsewhere): it is left pending.
            if pendingFirst { #expect(flock(held, LOCK_EX | LOCK_NB) == 0) }
            let removal = extensionProcess.letGo(group, owner: maya, session: session)
            #expect(extensionProcess.revocationPending(group) == pendingFirst)
            called.yield()
            called.finish()
            await busy.value
            await removal.value
            #expect(records.admission(group, owner: maya) == .admitted)
            #expect(manager.names[FamilyFileIds.domain(group)] != nil, "an old let-go's removal took a location accepted after it (pending first: \(pendingFirst))")
        }
    }

    /*
     * An upload into a family folder finishes (in a background launch too): the family's location is
     * told, so Files shows it. Fails if a family upload only signals the drive's location.
     */
    @Test func aFamilyUploadThatLandsTellsItsFamilysLocation() async throws {
        let domains = self.domains
        FilesDomain.signalFor(folderId: UUID().uuidString.lowercased(), familyGroup: Self.group.uppercased(), families: domains)
        await domains.settled()
        #expect(manager.signals == [FamilyFileIds.domain(Self.group)])
    }

    /*
     * A location whose record a let-go took is asked for while nobody is signed in: it is let go of
     * (Files drops it), not another account's (which asks for the sign-in sheet for a family that is
     * gone). A record with nobody signed in is still refused as another account's. Fails if a missing
     * record is asked about only after who is signed in.
     */
    @Test func aLocationWithoutItsRecordIsLetGoEvenSignedOut() async throws {
        let session = TemporaryCopies.session(CopyEpoch())
        let kept = UUID().uuidString.lowercased()
        await domains.accepted(kept, name: "Holm family", owner: Self.maya, observed: records.generation(kept), session: session).value
        #expect(records.admission(Self.group, owner: nil) == .letGo)
        #expect(records.admission(kept, owner: nil) == .otherAccount)
        #expect(records.admission(kept, owner: Self.sam) == .otherAccount)
        #expect(records.admission(kept, owner: Self.maya) == .admitted)
    }

    /*
     * The app accepts the family again (the member let back in) while the system is still removing
     * the location an earlier let-go asked to go: the app found it there and added nothing, so once
     * the removal finishes the location comes back for the record that stands. Fails if a removal
     * deletes the location of an acceptance that landed while it ran.
     */
    @Test func anAcceptanceDuringTheRemovalGetsItsLocationBack() async throws {
        signIn(Self.maya)
        let app = self.domains
        let extensionProcess = domains
        let session = TemporaryCopies.session(CopyEpoch())
        let (group, maya, records) = (Self.group, Self.maya, self.records)
        await app.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: session).value
        manager.duringRemove = { await app.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: session).value }
        await extensionProcess.letGo(group, owner: maya).value
        #expect(manager.removals == [FamilyFileIds.domain(group)])
        #expect(records.admission(group, owner: maya) == .admitted)
        #expect(manager.names[FamilyFileIds.domain(group)] == "Lindqvist family", "the removal took the location of an acceptance that came after its let-go")
    }

    /*
     * Another process switches accounts (Sam in, every family location removed) while an old
     * process's acceptance for Maya is still queued, its own session never told: it adds no record
     * and no location, whether it began before the switch (the account change refuses it) or carries
     * Maya's session after it (the shared keychain refuses it), and a switch during its add takes the
     * location back. Fails if an acceptance asks only its own process whether its account still stands.
     */
    @Test func aLateAcceptanceAfterAnAccountSwitchElsewhereAddsNothing() async throws {
        let mayaSession = SharedKeychain.Session(origin: Self.maya.origin, token: "maya", userId: Self.maya.userId)
        let samSession = SharedKeychain.Session(origin: Self.sam.origin, token: "sam", userId: Self.sam.userId)
        for (began, carries, duringAdd) in [(true, false, false), (false, true, false), (false, true, true)] {
            let shared = OnFakeDrive.FamilyFilesSourceTests.Shared(mayaSession)
            let old = FamilyFilesDomains(records: records, manager: manager, sharedSession: { shared.session })
            let other = FamilyFilesDomains(records: records, manager: manager, sharedSession: { shared.session })
            let session = TemporaryCopies.session(CopyEpoch())
            let group = UUID().uuidString.lowercased()
            let early = records.generation(group)
            if duringAdd {
                // Sam signs in while the location is being added, before that process removes anything.
                manager.duringAdd = { shared.session = samSession }
            } else {
                shared.session = samSession
                await other.removeAll()
            }
            await old.accepted(group, name: "Lindqvist family", owner: Self.maya, observed: began ? early : records.generation(group), session: session,
                               signedIn: carries ? mayaSession : nil).value
            #expect(manager.names[FamilyFileIds.domain(group)] == nil, "the old account's location came back (began before: \(began), during the add: \(duringAdd))")
            if duringAdd { await other.removeAll() }
            #expect(try records.read()[group] == nil, "the old account's record came back (began before: \(began), during the add: \(duringAdd))")
        }
    }

    /*
     * The location an acceptance during the removal gets back is let go of again while it is being
     * added: once added it is taken back. Fails if the restoring add skips the check after it.
     */
    @Test func aRevocationDuringTheRestoringAddTakesTheLocationBack() async throws {
        signIn(Self.maya)
        let app = self.domains
        let extensionProcess = domains
        let third = domains
        let session = TemporaryCopies.session(CopyEpoch())
        let (group, maya, records) = (Self.group, Self.maya, self.records)
        await app.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: session).value
        manager.duringRemove = { await app.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: session).value }
        manager.duringAdd = { await third.letGo(group, owner: maya).value }
        await extensionProcess.letGo(group, owner: maya).value
        #expect(records.admission(group, owner: maya) == .letGo)
        #expect(manager.names[FamilyFileIds.domain(group)] == nil, "a location restored over a second let-go stayed")
    }

    /*
     * The removals that aren't a let-go meet an acceptance that lands while the system removes the
     * location (in a process that found it still there): a sign-in's reconcile of a location without
     * this account's record, and the refusal of another account's location once its record went. Each
     * gives the fresh acceptance its location back. Fails if any single-family removal skips the
     * reread after it.
     */
    @Test func everyRemovalGivesAnAcceptanceThatLandedDuringItItsLocationBack() async throws {
        signIn(Self.maya)
        for path in ["reconcile", "foreign"] {
            let lifecycle = domains
            let app = FamilyFilesDomains(records: records, manager: manager)
            let session = TemporaryCopies.session(CopyEpoch())
            let (group, maya, sam, records) = (UUID().uuidString.lowercased(), Self.maya, Self.sam, self.records)
            let identifier = FamilyFileIds.domain(group)
            // The location stands without Maya's record: none at all, or Sam's from before a switch.
            manager.put(identifier, name: "Lindqvist family")
            if path == "foreign" { records.update { $0.records[group] = FamilyDomainRecord(owner: sam, name: "Lindqvist family") } }
            manager.duringRemove = {
                // Elsewhere, Sam's leftover record goes, and Maya's sync accepts the family.
                records.update { $0.records[group] = nil }
                await app.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: session).value
            }
            if path == "reconcile" { await lifecycle.reconcile(owner: maya).value } else { await lifecycle.dropForeign(group, current: maya).value }
            #expect(records.admission(group, owner: maya) == .admitted, "\(path) took Maya's fresh record")
            #expect(manager.names[identifier] == "Lindqvist family", "\(path) took the location of an acceptance that landed during it")
        }
    }

    /*
     * Two of the extension's gates share the process's copy epoch, and one read the keychain just
     * before a new token landed: that stale read moves nothing back, and neither gate keeps serving
     * a value from an epoch that moved; a token that went and came back is made afresh too. Fails
     * if `follow` takes an older observation, or a gate's cache ignores the epoch it was made in.
     */
    @Test func gatesStraddlingATokenChangeServeTheSessionStoredNow() throws {
        final class Reads: @unchecked Sendable { var stale: SharedKeychain.Session? }
        let account = CopyEpoch()
        let owner = Self.maya
        let token = { (name: String) in SharedKeychain.Session(origin: owner.origin, token: name, userId: owner.userId) }
        let keychain = OnFakeDrive.FamilyFilesSourceTests.Shared(token("old"))
        let reads = Reads()
        let a = FilesGate<CopySession>(owner: { owner }, session: {
            if let stale = reads.stale { reads.stale = nil; return stale }
            return keychain.session
        }, account: account) { _ in TemporaryCopies.session(account) }
        let b = FilesGate<CopySession>(owner: { owner }, session: { keychain.session }, account: account) { _ in TemporaryCopies.session(account) }
        #expect(try b.open().stands)
        keychain.session = token("new")
        let fresh = try b.open()
        #expect(fresh.stands)
        // A read the old token before the new one landed; B already followed the new one.
        reads.stale = token("old")
        #expect(try a.open().stands)
        #expect(fresh.stands, "a stale read ended the session B already serves (its downloads and records)")
        #expect(try b.open().stands, "a stale read moved the epoch under the value B serves")

        // Another token in and then this one again: the epoch moved twice while B's value sat cached.
        keychain.session = token("other")
        _ = try a.open()
        keychain.session = token("new")
        _ = try a.open()
        #expect(try b.open().stands, "a gate served a value from an epoch that moved since")
    }

    /*
     * Maya's sign-in reconciles her family locations while the system answers slowly, and someone
     * signs in meanwhile (another process wipes Maya's and accepts the next account's family): the
     * paused reconcile removes and deletes nothing of that account's, whether it waited on the
     * system's list, on a removal with more to go, or on its last removal; nor, when Maya herself
     * signed out and in again, on the family she accepted since. Fails if a reconcile asks who is
     * signed in (and since which account change) only before it waits.
     */
    @Test func aReconcilePausedWhileAnotherAccountSignsInLeavesThatAccountAlone() async throws {
        let mayaSession = SharedKeychain.Session(origin: Self.maya.origin, token: "maya", userId: Self.maya.userId)
        let mayaAgain = SharedKeychain.Session(origin: Self.maya.origin, token: "maya-again", userId: Self.maya.userId)
        let samSession = SharedKeychain.Session(origin: Self.sam.origin, token: "sam", userId: Self.sam.userId)
        for pausedIn in ["domains", "removal", "last removal", "same account again"] {
            let manager = TestFamilyDomains()
            let records = FamilyDomainRecords(folder: FileManager.default.temporaryDirectory.appendingPathComponent("family-domains-\(UUID().uuidString)"), activity: .expired)
            let shared = OnFakeDrive.FamilyFilesSourceTests.Shared(mayaSession)
            let old = FamilyFilesDomains(records: records, manager: manager, sharedSession: { shared.session })
            let other = FamilyFilesDomains(records: records, manager: manager, sharedSession: { shared.session })
            let (next, nextSession) = pausedIn == "same account again" ? (Self.maya, mayaAgain) : (Self.sam, samSession)
            let tail = String(UUID().uuidString.lowercased().suffix(12))
            let orphan = "00000000-0000-4000-8000-\(tail)", theirs = "ffffffff-ffff-4fff-8fff-\(tail)"
            // A location without Maya's record, and (but for the last removal) the next account's from before or one
            // without a record: Maya's reconcile removes both while she stays in.
            manager.put(FamilyFileIds.domain(orphan), name: "Holm family")
            if pausedIn != "last removal" { manager.put(FamilyFileIds.domain(theirs), name: "Lindqvist family") }
            if pausedIn == "domains" || pausedIn == "removal" {
                records.update { $0.records[theirs] = FamilyDomainRecord(owner: next, name: "Lindqvist family", generation: $0.generation(theirs)) }
            }
            let session = TemporaryCopies.session(CopyEpoch())
            let signIn: @Sendable () async -> Void = {
                shared.session = nextSession
                await other.removeAll()
                await other.accepted(theirs, name: "Lindqvist family", owner: next, observed: records.generation(theirs), session: session, signedIn: nextSession).value
            }
            if pausedIn == "domains" { manager.duringDomains = signIn } else { manager.duringRemove = signIn }
            let removedBefore = { manager.removals.filter { $0 == FamilyFileIds.domain(theirs) }.count }
            await old.reconcile(owner: Self.maya).value
            #expect(try records.read()[theirs]?.owner == next, "a stale reconcile took the next sign-in's record (paused in \(pausedIn))")
            #expect(manager.names[FamilyFileIds.domain(theirs)] != nil, "a stale reconcile took the next sign-in's location (paused in \(pausedIn))")
            // The wipe removed it once at most (the next sign-in's own); the stale reconcile never.
            #expect(removedBefore() <= 1, "a stale reconcile removed the next sign-in's location, emptying what Files kept of it (paused in \(pausedIn))")
        }
    }

    /*
     * An acceptance's add loses to a revocation, and before its take-back finishes the family is
     * accepted again (a let-in after the let-go): the take-back leaves that fresher acceptance its
     * location. Fails if the add's rollback removes unconditionally.
     */
    @Test func anAddsRollbackLeavesAFresherAcceptancesLocation() async throws {
        signIn(Self.maya)
        // The add's own session ends while it adds: its record stays (whose the sign-out decides), its location doesn't.
        let ending = CopyEpoch()
        let endingSession = TemporaryCopies.session(ending)
        let endingGroup = UUID().uuidString.lowercased()
        manager.duringAdd = { TemporaryCopies.endAccount(ending) }
        await domains.accepted(endingGroup, name: "Holm family", owner: Self.maya, observed: records.generation(endingGroup), session: endingSession).value
        #expect(manager.names[FamilyFileIds.domain(endingGroup)] == nil, "the rollback gave an ended session's add its location back")

        let app = self.domains
        let again = domains
        let session = TemporaryCopies.session(CopyEpoch())
        let (group, maya, records, manager) = (UUID().uuidString.lowercased(), Self.maya, self.records, self.manager)
        manager.duringAdd = {
            // Another process's let-go lands while the location is added (its own removal comes later).
            records.update { stored in
                stored.revoked[group, default: 0] += 1
                stored.records[group] = nil
            }
            manager.duringRemove = { await again.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: session).value }
        }
        await app.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: session).value
        #expect(manager.removals.contains(FamilyFileIds.domain(group)), "the lost add wasn't taken back")
        #expect(records.admission(group, owner: maya) == .admitted)
        #expect(manager.names[FamilyFileIds.domain(group)] != nil, "the rollback took the location of an acceptance newer than the add")
    }

    /*
     * Sam's location met Maya signed in, and Sam signs in while it is being removed: Sam's record,
     * no longer foreign, stays. Fails if the foreign refusal asks who is signed in only before it waits.
     */
    @Test func aForeignRefusalLeavesTheRecordOfWhoeverSignedInMeanwhile() async throws {
        let samSession = SharedKeychain.Session(origin: Self.sam.origin, token: "sam", userId: Self.sam.userId)
        let shared = OnFakeDrive.FamilyFilesSourceTests.Shared(SharedKeychain.Session(origin: Self.maya.origin, token: "maya", userId: Self.maya.userId))
        let lifecycle = FamilyFilesDomains(records: records, manager: manager, sharedSession: { shared.session })
        let group = UUID().uuidString.lowercased()
        manager.put(FamilyFileIds.domain(group), name: "Lindqvist family")
        records.update { $0.records[group] = FamilyDomainRecord(owner: Self.sam, name: "Lindqvist family") }
        manager.duringRemove = { shared.session = samSession }
        await lifecycle.dropForeign(group, current: Self.maya).value
        #expect(try records.read()[group]?.owner == Self.sam, "the record of the account that signed in meanwhile went")

        // Sam already signed in by the time the refusal runs: nothing of Sam's is touched.
        let later = UUID().uuidString.lowercased()
        manager.put(FamilyFileIds.domain(later), name: "Lindqvist family")
        records.update { $0.records[later] = FamilyDomainRecord(owner: Self.sam, name: "Lindqvist family") }
        await lifecycle.dropForeign(later, current: Self.maya).value
        #expect(manager.names[FamilyFileIds.domain(later)] != nil, "a refusal for Maya removed the location of Sam, signed in by then")
    }

    /*
     * The next account's acceptance lands while a sign-out's wipe removes the last account's
     * locations: its record and location stay. Fails if the wipe drops records written after it began.
     */
    @Test func aWipeKeepsTheNextAccountsAcceptanceThatLandedDuringIt() async throws {
        let wipe = FamilyFilesDomains(records: records, manager: manager)
        let next = FamilyFilesDomains(records: records, manager: manager)
        let session = TemporaryCopies.session(CopyEpoch())
        let (old, fresh, records, sam) = (UUID().uuidString.lowercased(), UUID().uuidString.lowercased(), self.records, Self.sam)
        await wipe.accepted(old, name: "Holm family", owner: Self.maya, observed: records.generation(old), session: session).value
        manager.duringRemove = { await next.accepted(fresh, name: "Lindqvist family", owner: sam, observed: records.generation(fresh), session: session).value }
        await wipe.removeAll()
        #expect(try records.read()[old] == nil)
        #expect(try records.read()[fresh]?.owner == sam, "the wipe dropped a record written after it began")
        #expect(manager.names[FamilyFileIds.domain(fresh)] != nil)
    }

    /*
     * Maya's removal of a family location is paused on the system while Sam signs in and accepts the
     * same family (finding the location still there, adding nothing): once the removal finishes, Sam,
     * who holds the record and the keychain now, gets the location back, whichever removal it was. An
     * acceptance for an account not signed in gets nothing back. Fails if the restore only matches the
     * account that started the removal.
     */
    @Test func whoeverHoldsTheRecordNowGetsTheLocationBackAfterARemoval() async throws {
        let samSession = SharedKeychain.Session(origin: Self.sam.origin, token: "sam", userId: Self.sam.userId)
        for (path, switches) in [("let-go", true), ("reconcile", true), ("let-go", false)] {
            signIn(Self.maya)
            let remover = domains
            let sam = FamilyFilesDomains(records: records, manager: manager, sharedSession: { samSession })
            let session = TemporaryCopies.session(CopyEpoch())
            let (group, records, keychain) = (UUID().uuidString.lowercased(), self.records, self.keychain)
            if path == "let-go" {
                await remover.accepted(group, name: "Lindqvist family", owner: Self.maya, observed: records.generation(group), session: session).value
            } else {
                manager.put(FamilyFileIds.domain(group), name: "Lindqvist family")
            }
            manager.duringRemove = {
                if switches { keychain.session = samSession }
                await sam.accepted(group, name: "Lindqvist family", owner: Self.sam, observed: records.generation(group), session: session,
                                   signedIn: switches ? samSession : nil).value
            }
            if path == "let-go" { await remover.letGo(group, owner: Self.maya).value } else { await remover.reconcile(owner: Self.maya).value }
            #expect(try records.read()[group]?.owner == Self.sam)
            if switches {
                #expect(manager.names[FamilyFileIds.domain(group)] != nil, "Sam's acceptance during Maya's \(path) removal lost its location")
            } else {
                #expect(manager.names[FamilyFileIds.domain(group)] == nil, "a location came back for an account that isn't signed in")
            }
        }
    }

    /*
     * A location given back after a removal is superseded while it is being added: the family is let
     * go of and accepted again (in a process that found the location being added), so the record
     * the restore was for is gone and a newer one of the account signed in stands. The location
     * stays for that newer acceptance. Fails if a restoring add that lost to a newer acceptance of the
     * same account is rolled back.
     */
    @Test func aRestoringAddSupersededByANewerAcceptanceKeepsTheLocation() async throws {
        // The newer acceptance is the signed-in account's (the location stays) or another account's (it is taken back).
        for newerOwner in [Self.maya, Self.sam] {
            signIn(Self.maya)
            let remover = domains
            let app = domains
            let newer = domains
            let session = TemporaryCopies.session(CopyEpoch())
            let (group, maya, records, manager) = (UUID().uuidString.lowercased(), Self.maya, self.records, self.manager)
            await app.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: session).value
            manager.duringRemove = {
                await app.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: session).value
                // The restore's add: meanwhile the family is let go of and accepted again, by a sync that finds the location there.
                manager.duringAdd = {
                    records.update { stored in
                        stored.revoked[group, default: 0] += 1
                        stored.records[group] = nil
                    }
                    manager.put(FamilyFileIds.domain(group), name: "Lindqvist family")
                    await newer.accepted(group, name: "Lindqvist family", owner: newerOwner, observed: records.generation(group), session: session).value
                }
            }
            await remover.letGo(group, owner: maya).value
            #expect(try records.read()[group]?.owner == newerOwner)
            if newerOwner == maya {
                #expect(manager.names[FamilyFileIds.domain(group)] != nil, "a restoring add superseded by a newer acceptance was rolled back")
            } else {
                #expect(manager.names[FamilyFileIds.domain(group)] == nil, "a location stayed for an account that isn't signed in")
            }
        }
    }

    /*
     * Two locations without Maya's record, and her sync accepts the second while the system removes
     * the first: her reconcile reads that record again before deciding and keeps the second. Fails if
     * reconcile decides every location on the records it read before its first wait.
     */
    @Test func aFamilyAcceptedDuringAnEarlierRemovalOfTheReconcileStays() async throws {
        signIn(Self.maya)
        let lifecycle = domains
        let app = domains
        let session = TemporaryCopies.session(CopyEpoch())
        let tail = String(UUID().uuidString.lowercased().suffix(12))
        let (first, second) = ("00000000-0000-4000-8000-\(tail)", "ffffffff-ffff-4fff-8fff-\(tail)")
        let (records, maya) = (self.records, Self.maya)
        manager.put(FamilyFileIds.domain(first), name: "Holm family")
        manager.put(FamilyFileIds.domain(second), name: "Lindqvist family")
        manager.duringRemove = {
            await app.accepted(second, name: "Lindqvist family", owner: maya, observed: records.generation(second), session: session).value
        }
        await lifecycle.reconcile(owner: maya).value
        #expect(manager.names[FamilyFileIds.domain(first)] == nil)
        #expect(records.admission(second, owner: maya) == .admitted)
        #expect(manager.names[FamilyFileIds.domain(second)] != nil, "reconcile removed a family accepted while its earlier removal waited")
    }

    /*
     * Maya signs in again while her last session's acceptance adds the location: the old session's
     * add no longer holds, and the new session's acceptance wrote a record equal in every field but
     * which acceptance wrote it. The location stays for the new one. Fails if two acceptances of the
     * same account and generation can't be told apart.
     */
    @Test func aSameAccountSignInDuringTheAddKeepsTheLocation() async throws {
        signIn(Self.maya)
        let old = domains
        let new = domains
        let ending = CopyEpoch()
        let oldSession = TemporaryCopies.session(ending)
        let newSession = TemporaryCopies.session(CopyEpoch())
        let (group, maya, records) = (UUID().uuidString.lowercased(), Self.maya, self.records)
        manager.duringAdd = {
            TemporaryCopies.endAccount(ending)
            await new.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: newSession).value
        }
        await old.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: oldSession).value
        #expect(records.admission(group, owner: maya) == .admitted)
        #expect(manager.names[FamilyFileIds.domain(group)] != nil, "the old session's lost add took the new session's location")
    }

    /*
     * A let-go the store refused waits, its removal queued with no generation, while Maya signs in
     * again in another process and that process accepts the family (the pending let-go never written
     * there): the queued removal, of a session the keychain no longer holds, leaves the new session's
     * location. Fails if a removal without a generation asks only its own process's session.
     */
    @Test func aPendingLetGosRemovalLeavesTheLocationOfASignInSince() async throws {
        let oldSession = SharedKeychain.Session(origin: Self.maya.origin, token: "old", userId: Self.maya.userId)
        let newSession = SharedKeychain.Session(origin: Self.maya.origin, token: "new", userId: Self.maya.userId)
        keychain.session = oldSession
        let old = domains
        let elsewhere = domains
        let session = TemporaryCopies.session(CopyEpoch())
        let (group, maya, records, keychain) = (UUID().uuidString.lowercased(), Self.maya, self.records, self.keychain)
        await old.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: session).value
        let held = open(records.lockPath, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        let (entered, enter) = AsyncStream<Void>.makeStream()
        let (letGoCalled, called) = AsyncStream<Void>.makeStream()
        manager.duringAdd = {
            enter.yield()
            for await _ in letGoCalled { break }
            // The store frees; elsewhere Maya signs in again and accepts the family, knowing nothing of the pending let-go.
            flock(held, LOCK_UN)
            close(held)
            keychain.session = newSession
            await elsewhere.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: session,
                                     signedIn: newSession).value
        }
        // The old process's queue is busy with another family's add.
        let busy = old.accepted(UUID().uuidString.lowercased(), name: "Holm family", owner: maya, observed: 0, session: session)
        for await _ in entered { break }
        #expect(flock(held, LOCK_EX | LOCK_NB) == 0)
        let removal = old.letGo(group, owner: maya, session: session, signedIn: oldSession)
        called.yield()
        called.finish()
        await busy.value
        await removal.value
        #expect(records.admission(group, owner: maya) == .admitted)
        #expect(manager.names[FamilyFileIds.domain(group)] != nil, "a pending let-go of the old session removed the new session's location")
    }

    /*
     * An acceptance lands in another process just as a removal begins, after whatever authorised it:
     * the removal asks again in the same locked read that notes the record, and the location stays,
     * for a let-go's removal and for a sign-in's reconcile alike. Fails if a removal is decided apart
     * from the read it then trusts.
     */
    @Test func anAcceptanceLandingAsARemovalBeginsKeepsTheLocation() async throws {
        for path in ["let-go", "reconcile"] {
            signIn(Self.maya)
            let remover = domains
            let elsewhere = domains
            let session = TemporaryCopies.session(CopyEpoch())
            let (group, maya, records) = (UUID().uuidString.lowercased(), Self.maya, self.records)
            if path == "let-go" {
                await remover.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: session).value
            } else {
                manager.put(FamilyFileIds.domain(group), name: "Lindqvist family")
            }
            remover.beforeRemoval = {
                await elsewhere.accepted(group, name: "Lindqvist family", owner: maya, observed: records.generation(group), session: session).value
            }
            if path == "let-go" { await remover.letGo(group, owner: maya).value } else { await remover.reconcile(owner: maya).value }
            #expect(records.admission(group, owner: maya) == .admitted)
            #expect(!manager.removals.contains(FamilyFileIds.domain(group)), "a removal decided before an acceptance landed went ahead (\(path))")
            #expect(manager.names[FamilyFileIds.domain(group)] != nil)
            // Kept by a sign-in's reconcile: told the session is back, as every kept location is.
            if path == "reconcile" { #expect(manager.resolutions.contains(FamilyFileIds.domain(group))) }
        }
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

        signIn(Self.maya)
        await domains.reconcile(owner: Self.maya).value
        #expect(manager.names[FamilyFileIds.domain(Self.group)] != nil, "the same account's location went at its own sign-in")

        // A location left with no record (its revocation's removal never ran) goes too.
        let orphan = FamilyFileIds.domain(UUID().uuidString.lowercased())
        manager.put(orphan, name: "Old family")
        signIn(Self.sam)
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

        /* The session the shared keychain holds, as every process reads it. */
        final class Shared: @unchecked Sendable {
            var session: SharedKeychain.Session?
            init(_ session: SharedKeychain.Session?) { self.session = session }
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
            let shared: Shared
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
            // Every process reads the one shared keychain: the lifecycle and the source alike.
            let shared = Shared(nil)
            let domains = FamilyFilesDomains(records: records, manager: manager, sharedSession: { shared.session })
            let phone = try await family.phone(server, account: account, filesDomains: domains)
            shared.session = await phone.vault.session
            let owner = AccountOwner(userId: family.member.userId, origin: "https://family.test")
            await domains.accepted(family.groupId, name: "Lindqvist family", workspaces: [family.workspaceId], owner: owner, observed: records.generation(family.groupId),
                                   session: phone.vault.copySession).value
            let clock = Clock()
            let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("family-src-\(UUID().uuidString)", isDirectory: true)
            let source = FamilyFilesSource(groupId: family.groupId, vault: phone.vault, sync: phone.sync, records: records, temporary: temporary, now: { clock.now },
                                           sharedSession: { shared.session })
            return Source(family: family, server: server, phone: phone, domains: domains, manager: manager, records: records, clock: clock, source: source,
                          temporary: temporary, shared: shared)
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
         * A folder the family still lists stops opening here for a moment (a key change between the
         * member list and the folders): its feed and its items are asked again, never called deleted,
         * and come back where they were; once the family stops listing it, it goes. Fails if a
         * folder that can't open yet is taken for one the family dropped.
         */
        @Test func aFolderThatCantOpenYetKeepsItsPlaceAndOneNoLongerListedGoes() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            let workspace = s.family.workspaceId.lowercased()
            let root = NodeRef(workspaceId: s.family.workspaceId, nodeId: s.family.rootId)
            let anchor = try await s.source.anchor()
            #expect(anchor.folders[workspace] != nil)

            s.server.servedRootId = s.family.fileId
            s.clock.now = s.clock.now.addingTimeInterval(120)
            do {
                let changes = try await s.source.changes(since: anchor)
                Issue.record("a folder that can't open yet answered \(changes?.deleted ?? []) deleted")
            } catch {
                #expect(error as? FamilyFilesError == .keyChange)
            }
            // Open again: the next read checks the family first (no minute waited), and the folder is where it was.
            s.server.servedRootId = nil
            let again = try #require(try await s.source.changes(since: anchor))
            #expect(again.deleted.isEmpty, "the folder was deleted after it opened again")
            #expect(again.next.folders[workspace]?.root == anchor.folders[workspace]?.root)

            s.server.servedRootId = s.family.fileId
            s.clock.now = s.clock.now.addingTimeInterval(120)
            await #expect(throws: FamilyFilesError.keyChange) { _ = try await s.source.children(of: root) }
            await #expect(throws: FamilyFilesError.keyChange) { _ = try await s.source.item(s.family.photo.ref) }
            s.server.servedRootId = nil
            #expect(try await s.source.item(s.family.photo.ref).ref == s.family.photo.ref)

            s.server.areaListed = false
            s.clock.now = s.clock.now.addingTimeInterval(120)
            let gone = try #require(try await s.source.changes(since: anchor))
            #expect(gone.deleted.contains(FamilyFileIds.item(NodeRef(workspaceId: workspace, nodeId: s.family.rootId.lowercased()))),
                    "a folder the family no longer lists stayed")
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
         * Files lists the location from the start (its first look, or after its anchor expired) while
         * a folder it was shown is mid key change: the listing asks again rather than leave the folder
         * out, and answers it once it opens. A folder this source never showed open is left out, so it
         * holds nothing else back. Fails if a full listing drops a folder that only can't open yet.
         */
        @Test func aFullListingKeepsAFolderMidKeyChange() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            s.server.servedRootId = s.family.fileId
            #expect(try await s.source.folders().isEmpty, "a folder never shown open held the listing back")

            s.server.servedRootId = nil
            s.clock.now = s.clock.now.addingTimeInterval(120)
            #expect(try await s.source.folders().map(\.workspaceId) == [s.family.workspaceId])

            s.server.servedRootId = s.family.fileId
            s.clock.now = s.clock.now.addingTimeInterval(120)
            await #expect(throws: FamilyFilesError.keyChange) { _ = try await s.source.folders() }
            await #expect(throws: FamilyFilesError.keyChange) { _ = try await s.source.anchor() }
            s.server.servedRootId = nil
            #expect(try await s.source.folders().map(\.workspaceId) == [s.family.workspaceId])
            #expect(try await s.source.anchor().folders[s.family.workspaceId.lowercased()] != nil)
        }

        /*
         * A cold launch's index still holds the folder a file was in before it moved: asked for, the
         * file isn't in that folder, and the folder may be gone too. Neither is proof the file is gone,
         * so Files asks again (a real deletion reaches it through the feed). Fails if an item missing
         * from its indexed folder is answered as no such item.
         */
        @Test func aFileMissingFromItsIndexedFolderIsAskedAgainNotGone() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            let f = s.family
            _ = try await s.source.children(of: NodeRef(workspaceId: f.workspaceId, nodeId: f.rootId))
            s.server.put(f.photo.with(parentId: UUID().uuidString.lowercased()))
            await s.phone.vault.forget(f.photo.id)
            await #expect(throws: FamilyFilesError.unavailable) { _ = try await s.source.item(f.photo.ref) }

            await s.phone.vault.rememberParent(f.photo.id, parent: UUID().uuidString.lowercased())
            await #expect(throws: FamilyFilesError.unavailable) { _ = try await s.source.item(f.photo.ref) }
        }

        /*
         * A file moves out of its folder between the feed being read and that folder being listed: the
         * feed still names the old folder, which no longer holds it. The batch fails and is asked again
         * (its cursor where it was), never answering the file deleted. Fails if a row missing from its
         * named folder is taken for a deletion.
         */
        @Test func aFileMovedMidBatchFailsTheBatchNotDeletesIt() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            _ = try await s.source.folders()
            let (f, server) = (s.family, s.server)
            let moved = f.photo.with(parentId: UUID().uuidString.lowercased())
            server.lock.withLock {
                server.manage.beforeAnswer = { method, path in
                    guard method == "GET", path == "/api/drive/nodes/\(f.rootId)/children" else { return }
                    server.lock.withLock { server.manage.beforeAnswer = nil }
                    server.put(moved)
                }
            }
            do {
                let changes = try await s.source.changes(since: FamilyAnchor(folders: [f.workspaceId: .init(root: f.rootId, cursor: 0)]))
                Issue.record("a file moved mid-batch was answered: \(changes?.deleted ?? []) deleted")
            } catch {
                #expect(error as? FamilyFilesError == .unavailable, "a move mid-batch failed as \(error)")
            }
        }

        /*
         * A row the folder's listing names but that doesn't open here (its id clashes with one of the
         * phone's own rows) is a verdict about that row: it leaves the location, and the batch still
         * answers. Fails if a listed row that can't open is retried for ever like a missing one.
         */
        @Test func aListedRowThatCantOpenHereLeavesWithoutStallingTheBatch() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            _ = try await s.source.folders()
            let f = s.family
            _ = try await s.phone.vault.listChildren(of: f.personalRoot.id, in: f.personal)
            #expect(await s.phone.vault.item(NodeRef(workspaceId: f.personal, nodeId: f.personalRoot.id)) != nil, "the clash needs the phone's own row held")
            s.server.put(try FamilyFixture.node(id: f.personalRoot.id, in: f.workspaceId, parent: f.rootId, parentKey: f.rootKey, key: randomBytes(length: 32),
                                                kind: .file, name: "Clash.txt", writer: f.creator))
            let changes = try #require(try await s.source.changes(since: FamilyAnchor(folders: [f.workspaceId: .init(root: f.rootId, cursor: 0)])))
            #expect(changes.deleted.contains(FamilyFileIds.item(NodeRef(workspaceId: f.workspaceId, nodeId: f.personalRoot.id))))
            #expect(changes.updated.contains { $0.ref == f.photo.ref })
        }

        /*
         * A live file's row names a folder that can't be listed (gone, as the listing says): the batch is
         * asked again rather than call the file deleted, and a newer row (it moved back meanwhile) is read
         * from its folder now. The same row failing again on the retry is a verdict, so nothing stalls;
         * so is the folder's own trashed row in the same batch, at once. Fails if a failed folder listing
         * deletes a live file on sight, or retries it for ever.
         */
        @Test func aLiveFileWhoseFolderCantBeListedIsAskedAgainThenDecided() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            _ = try await s.source.folders()
            let f = s.family
            let anchor = FamilyAnchor(folders: [f.workspaceId: .init(root: f.rootId, cursor: 0)])
            let photo = FamilyFileIds.item(f.photo.ref)
            let ghost = UUID().uuidString.lowercased()
            s.server.put(f.photo.with(parentId: ghost))
            await #expect(throws: FamilyFilesError.unavailable) { _ = try await s.source.changes(since: anchor) }
            s.server.put(try #require(s.server.node(f.photo.id)).with(parentId: f.rootId))
            let back = try #require(try await s.source.changes(since: anchor))
            #expect(!back.deleted.contains(photo), "a file that moved back was deleted for the folder it left")
            #expect(back.updated.contains { $0.ref == f.photo.ref })

            s.server.put(try #require(s.server.node(f.photo.id)).with(parentId: ghost))
            await #expect(throws: FamilyFilesError.unavailable) { _ = try await s.source.changes(since: anchor) }
            let decided = try #require(try await s.source.changes(since: anchor), "the same row failing again stalled the feed")
            #expect(decided.deleted.contains(photo))

            // A folder trashed in this batch takes what's in it at once.
            let folderKey = try randomBytes(length: 32)
            let folderId = try newId(kind: .node, scopeId: f.workspaceId).id
            let childId = try newId(kind: .node, scopeId: f.workspaceId).id
            let folder = try FamilyFixture.node(id: folderId, in: f.workspaceId, parent: f.rootId, parentKey: f.rootKey, key: folderKey, kind: .folder,
                                                name: "Old", writer: f.creator)
            s.server.put(folder.with(trashedAt: "2026-11-04T00:00:00.000Z"),
                         try FamilyFixture.node(id: childId, in: f.workspaceId, parent: folderId, parentKey: folderKey, key: randomBytes(length: 32), kind: .file,
                                                name: "Inside.txt", writer: f.creator))
            s.server.put(try #require(s.server.node(f.photo.id)).with(parentId: f.rootId))
            let trashed = try #require(try await s.source.changes(since: anchor), "a child of a folder trashed in the batch was retried")
            #expect(trashed.deleted.contains(FamilyFileIds.item(NodeRef(workspaceId: f.workspaceId, nodeId: childId))))
        }

        /*
         * Ten files sit in a folder trashed elsewhere, and the folder's own trashed row comes on a later
         * page of the feed: each page's first read notes every one of them and fails once, and the second
         * decides them all, so no page needs more than two reads. Fails if a row decided on its second
         * sight is forgotten when a later row fails the batch (2^N reads, a stalled sync).
         */
        @Test func manyFilesUnderAFolderTrashedOnALaterPageSettleInTwoReadsAPage() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            _ = try await s.source.folders()
            let f = s.family
            let folderKey = try randomBytes(length: 32)
            let folderId = try newId(kind: .node, scopeId: f.workspaceId).id
            let folder = try FamilyFixture.node(id: folderId, in: f.workspaceId, parent: f.rootId, parentKey: f.rootKey, key: folderKey, kind: .folder,
                                                name: "Old", writer: f.creator)
            var children: [String] = []
            for index in 0 ..< 10 {
                let id = try newId(kind: .node, scopeId: f.workspaceId).id
                s.server.put(try FamilyFixture.node(id: id, in: f.workspaceId, parent: folderId, parentKey: folderKey, key: randomBytes(length: 32), kind: .file,
                                                    name: "Inside \(index).txt", writer: f.creator))
                children.append(id)
            }
            // Trashed after them: its row sorts after every child's.
            s.server.put(folder.with(trashedAt: "2026-11-04T00:00:00.000Z"))
            s.server.lock.withLock { s.server.rotations.changesPage = 6 }
            var anchor = FamilyAnchor(folders: [f.workspaceId: .init(root: f.rootId, cursor: 0)])
            var deleted: Set<String> = []
            for _ in 0 ..< 10 {
                var reads = 0
                var page: FamilyChanges?
                while page == nil, reads < 4 {
                    reads += 1
                    do {
                        page = try #require(try await s.source.changes(since: anchor))
                    } catch FamilyFilesError.unavailable {
                        continue
                    }
                }
                #expect(reads <= 2, "a page took \(reads) reads to settle")
                guard let page else { return }
                deleted.formUnion(page.deleted)
                anchor = page.next
                if !page.hasMore { break }
            }
            for id in children { #expect(deleted.contains(FamilyFileIds.item(NodeRef(workspaceId: f.workspaceId, nodeId: id)))) }
        }

        /*
         * A download lands where the day-old sweep looks: a version folder untouched for a day goes,
         * and a fresh one stays even under a node folder from days ago. Fails if downloads and the
         * sweep disagree on the layout (stale partials kept, fresh downloads deleted).
         */
        @Test func theDayOldSweepReadsTheDownloadsOwnLayout() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            _ = try await s.source.children(of: NodeRef(workspaceId: s.family.workspaceId, nodeId: s.family.rootId))
            let (file, _) = try await s.source.download(s.family.photo.ref)
            let version = file.deletingLastPathComponent()
            let node = version.deletingLastPathComponent()
            let versionId = try #require(s.family.photo.currentVersion?.id)
            #expect(version == TemporaryCopies.openedFolder(itemId: s.family.photo.id, version: versionId, familyWorkspace: s.family.workspaceId, in: s.temporary))
            let longAgo = Date().addingTimeInterval(-3 * 24 * 3600)

            // The node folder is days old, the version in it fresh (a download continued today): it stays.
            try FileManager.default.setAttributes([.modificationDate: longAgo], ofItemAtPath: node.path)
            TemporaryCopies.sweep(in: s.temporary)
            #expect(FileManager.default.fileExists(atPath: file.path), "the sweep deleted a fresh download")

            // The version itself untouched for days (a partial nobody continued): it goes.
            try FileManager.default.setAttributes([.modificationDate: longAgo], ofItemAtPath: version.path)
            try FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: node.path)
            TemporaryCopies.sweep(in: s.temporary)
            #expect(!FileManager.default.fileExists(atPath: version.path), "a day-old download outlived the sweep")
        }

        /*
         * A family folder made on the web while the app was closed is found and accepted first by the
         * extension (the record still names the app's older list of folders): the extension records it
         * before serving it, so another extension instance's start-up sweep leaves its download. Fails
         * if only the app's acceptances write the folders a sweep keeps.
         */
        @Test func aFolderTheExtensionAcceptsFirstKeepsItsCopiesThroughAnotherInstancesSweep() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            let (group, workspace) = (s.family.groupId, s.family.workspaceId.lowercased())
            // The app recorded the family before this folder existed.
            s.records.update { stored in stored.records[group]?.workspaces = [] }
            _ = try await s.source.children(of: NodeRef(workspaceId: s.family.workspaceId, nodeId: s.family.rootId))
            let (file, _) = try await s.source.download(s.family.photo.ref)
            #expect(try s.records.read()[group]?.workspaces == [workspace], "the extension served a folder it didn't record")
            let other = FamilyFilesDomains(records: s.records, manager: s.manager, temporary: s.temporary)
            #expect(other.sweepUnrecorded())
            #expect(FileManager.default.fileExists(atPath: file.path), "another instance's sweep deleted a download of a folder the extension accepted")

            // Signed in again elsewhere while the next check waits on the server: that check records nothing.
            s.records.update { stored in stored.records[group]?.workspaces = [] }
            let (server, shared) = (s.server, s.shared)
            let next = SharedKeychain.Session(origin: "https://family.test", token: "signed-in-again", userId: s.family.member.userId)
            server.lock.withLock {
                server.manage.beforeAnswer = { method, path in
                    guard method == "GET", path == "/api/groups" else { return }
                    server.lock.withLock { server.manage.beforeAnswer = nil }
                    shared.session = next
                }
            }
            s.clock.now = s.clock.now.addingTimeInterval(120)
            _ = try? await s.source.folders()
            #expect(try s.records.read()[group]?.workspaces == [], "a check whose session ended meanwhile wrote the record")
        }

        /*
         * The record can't be written when the extension accepts a folder it doesn't name (its lock held
         * elsewhere): that folder isn't served yet (Files asks again) while the record stays unwritten,
         * then is once it is; a folder the record already names is served as ever. Fails if a folder is
         * served whose copies a sweep would take.
         */
        @Test func aFolderTheRecordCouldntBeMadeToNameWaits() async throws {
            for named in [false, true] {
                let s = try await Self.source()
                defer { s.phone.done() }
                let group = s.family.groupId
                if !named { s.records.update { stored in stored.records[group]?.workspaces = [] } }
                let root = NodeRef(workspaceId: s.family.workspaceId, nodeId: s.family.rootId)
                let held = open(s.records.lockPath, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
                #expect(flock(held, LOCK_EX | LOCK_NB) == 0)
                if named {
                    #expect(try await s.source.children(of: root).contains { $0.ref == s.family.photo.ref }, "a folder the record names wasn't served")
                    flock(held, LOCK_UN)
                    close(held)
                    continue
                }
                await #expect(throws: FamilyFilesError.unavailable) { _ = try await s.source.children(of: root) }
                #expect(try await s.source.folders().isEmpty, "a folder the record doesn't name was listed")
                flock(held, LOCK_UN)
                close(held)
                #expect(try await s.source.children(of: root).contains { $0.ref == s.family.photo.ref })
                #expect(try s.records.read()[group]?.workspaces == [s.family.workspaceId.lowercased()])
            }
        }

        /*
         * Another member moved the photo from the top folder into Docs: Docs' listing opens the moved
         * row, then a listing of the top folder from before the move lands. The location shows the
         * photo in Docs alone. Fails if a family folder lists a row the vault holds as moved out.
         */
        @Test func aFamilyFileMovedBetweenFoldersShowsOnlyInTheNewOneInFiles() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            let f = s.family
            s.server.put(f.docs)
            let root = NodeRef(workspaceId: f.workspaceId, nodeId: f.rootId)
            #expect(try await s.source.children(of: root).contains { $0.ref == f.photo.ref })
            let version = try #require(f.photo.currentVersion)
            let moved = try FamilyFixture.node(id: f.photo.id, in: f.workspaceId, parent: f.docs.id, parentKey: f.docsKey, key: f.photoKey,
                                               kind: .file, name: "Beach.jpg", writer: f.creator, keyEpoch: 3, parentKeyEpoch: 2)
                .with(version: version).with(version: version)
            s.server.put(moved)
            #expect(try await s.source.children(of: NodeRef(workspaceId: f.workspaceId, nodeId: f.docs.id)).map(\.ref) == [f.photo.ref])
            // The top folder's listing from before the move lands now.
            s.server.put(f.photo)
            #expect(!(try await s.source.children(of: root).contains { $0.ref == f.photo.ref }), "a moved file showed in the folder it left")
        }

        /*
         * A batch lists the top folder (for Docs' own row), then Docs (for a note in it), by which time
         * another member moved the photo into Docs, so Docs' listing opens the photo's newer row; then
         * the photo's own feed row, from before the move, replays the top folder's kept listing. The
         * newer row stays: the photo is answered in Docs. Fails if a cached listing's older row
         * replaces a newer one held.
         */
        @Test func aCachedListingNeverReplacesANewerRowHeld() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            _ = try await s.source.folders()
            let f = s.family
            let noteId = try newId(kind: .node, scopeId: f.workspaceId).id
            let note = try FamilyFixture.node(id: noteId, in: f.workspaceId, parent: f.docs.id, parentKey: f.docsKey, key: randomBytes(length: 32), kind: .file,
                                              name: "Note.txt", writer: f.creator, parentKeyEpoch: 2).with()
            // Feed order: Docs (top folder's listing), then the note (Docs' listing), then the photo (the top folder's again).
            s.server.put(f.docs, note, try #require(s.server.node(f.photo.id)).with().with())
            let version = try #require(f.photo.currentVersion)
            let moved = try FamilyFixture.node(id: f.photo.id, in: f.workspaceId, parent: f.docs.id, parentKey: f.docsKey, key: f.photoKey,
                                               kind: .file, name: "Beach.jpg", writer: f.creator, keyEpoch: 3, parentKeyEpoch: 2)
                .with(version: version).with(version: version).with(version: version).with(version: version)
            let (server, docs) = (s.server, f.docs.id)
            server.lock.withLock {
                server.manage.beforeAnswer = { method, path in
                    guard method == "GET", path == "/api/drive/nodes/\(docs)/children" else { return }
                    server.lock.withLock { server.manage.beforeAnswer = nil }
                    server.put(moved)
                }
            }
            let changes = try #require(try await s.source.changes(since: FamilyAnchor(folders: [f.workspaceId: .init(root: f.rootId, cursor: 0)])))
            let photo = try #require(changes.updated.last { $0.ref == f.photo.ref })
            #expect(photo.node.parentId == f.docs.id, "a cached listing's older row replaced the newer one held")
            #expect(await s.phone.vault.item(f.photo.ref)?.node.parentId == f.docs.id)

            // Trashed since: answered deleted, and no longer held for a look-up to serve.
            s.server.put(try #require(s.server.node(f.photo.id)).with(trashedAt: "2026-11-04T00:00:00.000Z"))
            let trashed = try #require(try await s.source.changes(since: FamilyAnchor(folders: [f.workspaceId: .init(root: f.rootId, cursor: 0)])))
            #expect(trashed.deleted.contains(FamilyFileIds.item(f.photo.ref)))
            #expect(await s.phone.vault.item(f.photo.ref) == nil, "a trashed row stayed held")
        }

        /*
         * The same account signs in again in the app (a new token in the shared keychain) while the
         * extension's sync of the old session still runs: its late definite refusal, written at once
         * or left pending and written later, lets nothing of the new session's location go. Fails if
         * a let-go asks only its own process whether its session still stands.
         */
        @Test func aLateRefusalAfterASignInElsewhereKeepsTheNewSessionsLocation() async throws {
            for pendingFirst in [false, true] {
                let s = try await Self.source()
                defer { s.phone.done() }
                let group = s.family.groupId
                let old = try #require(s.shared.session)
                let held = pendingFirst ? open(s.records.lockPath, O_RDWR | O_CREAT | O_CLOEXEC, 0o600) : -1
                if pendingFirst {
                    #expect(flock(held, LOCK_EX | LOCK_NB) == 0)
                    s.phone.sync.releases.post(group, FamilySync.Revised(state: .wiped, revision: FamilySync.newestLook()))
                    await s.domains.settled()
                    #expect(s.domains.revocationPending(group), "the store took the let-go after all")
                }
                s.shared.session = SharedKeychain.Session(origin: old.origin, token: "signed-in-again-\(UUID().uuidString)", userId: old.userId)
                if pendingFirst {
                    flock(held, LOCK_UN)
                    close(held)
                    #expect(!s.domains.revocationPending(group), "a pending let-go of the old session was kept")
                } else {
                    s.phone.sync.releases.post(group, FamilySync.Revised(state: .wiped, revision: FamilySync.newestLook()))
                }
                await s.domains.settled()
                #expect(s.records.admission(group, owner: s.owner) == .admitted, "the old session's refusal took the new session's record (pending first: \(pendingFirst))")
                if !pendingFirst { #expect(s.manager.removals.isEmpty, "the old session's refusal removed the location") }
            }
        }

        /*
         * The family's folder is re-keyed while Files lists it: the read asks again (never a corrupt
         * file), and the next one checks the family first, without waiting out the minute, and
         * answers. Every read shares `serving`'s classifier, so this pins the look-ups too. Fails if
         * a key change on an ordinary read escapes raw or leaves the cached check standing.
         */
        @Test func aKeyChangeOnAnOrdinaryReadIsAskedAgainAndCheckedAtOnce() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            _ = try await s.source.folders()
            let root = NodeRef(workspaceId: s.family.workspaceId, nodeId: s.family.rootId)
            try s.server.replaceKeys()
            do {
                let children = try await s.source.children(of: root)
                Issue.record("a listing under keys this device hasn't followed answered \(children.count) items")
            } catch {
                #expect(error as? FamilyFilesError == .keyChange, "a key change escaped as \(error)")
            }
            #expect(try await s.source.children(of: root).contains { $0.ref == s.family.photo.ref })
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
         * A revocation from another process that lands during the last await of any read is caught
         * by the read's final check, and nothing it fetched is handed on: folders, items, children,
         * contents (and their copy), thumbnails, anchors, changes. Fails if any read returns family
         * data without asking the record after its last await.
         */
        @Test func everyReadAsksAgainAfterItsLastAwait() async throws {
            let reads: [(String, @Sendable (FamilyFilesSource, FamilyFixture) async throws -> Void)] = [
                ("admitted", { source, _ in _ = try await source.admitted() }),
                ("folders", { source, _ in _ = try await source.folders() }),
                ("isFolderRoot", { source, f in _ = try await source.isFolderRoot(NodeRef(workspaceId: f.workspaceId, nodeId: f.rootId)) }),
                ("children", { source, f in _ = try await source.children(of: NodeRef(workspaceId: f.workspaceId, nodeId: f.rootId)) }),
                ("item", { source, f in _ = try await source.item(f.photo.ref) }),
                ("download", { source, f in _ = try await source.download(f.photo.ref) }),
                ("thumbnail", { source, f in _ = try await source.thumbnail(f.photo.ref) }),
                ("anchor", { source, _ in _ = try await source.anchor() }),
                ("changes", { source, f in _ = try await source.changes(since: FamilyAnchor(folders: [f.workspaceId: .init(root: f.rootId, cursor: 0)])) }),
            ]
            for (name, read) in reads {
                let s = try await Self.source()
                defer { s.phone.done() }
                // Held from before: the read's own awaits are its lookups, not a first acceptance.
                _ = try await s.source.children(of: NodeRef(workspaceId: s.family.workspaceId, nodeId: s.family.rootId))
                let other = FamilyFilesDomains(records: s.records, manager: s.manager)
                let (group, owner) = (s.family.groupId, s.owner)
                await s.source.setLastAwait { _ = other.letGo(group, owner: owner) }
                do {
                    try await read(s.source, s.family)
                    Issue.record("\(name) handed on family data after a revocation in its last await")
                } catch {
                    #expect(error as? FamilyFilesError == .letGo, "\(name): \(error)")
                }
                let copies = s.temporary.appendingPathComponent("opened/family/\(s.family.workspaceId)")
                #expect(!FileManager.default.fileExists(atPath: copies.path), "\(name) left a copy behind")
            }
        }

        /*
         * The session ended on the server (401) while the extension checks the family again: that is
         * passed on, never answered with the folders held from before. Fails if anything but no answer
         * falls back to the cache, hiding the sign-in sheet.
         */
        @Test func aLostSessionIsPassedOnNotAnsweredFromTheCache() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            _ = try await s.source.folders()
            s.server.lock.withLock { s.server.unauthorized = true }
            s.clock.now = s.clock.now.addingTimeInterval(120)
            do {
                _ = try await s.source.folders()
                Issue.record("a 401 was answered from the cache")
            } catch {
                #expect(error as? FamilyFilesError == .signedOut, "\(error)")
            }
        }

        /*
         * The member list doesn't load mid-sync (a 503), or the session ends mid-sync (a 401 after
         * route 2 answered): the family's location and its record stay, the folders held from before
         * are kept on the first, and the second asks for the sign-in sheet. Fails if a recoverable
         * failure lets the location go.
         */
        @Test func aSyncThatFailsRecoverablyKeepsTheLocation() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            _ = try await s.source.folders()
            s.server.lock.withLock { s.server.rostersFail = true }
            s.clock.now = s.clock.now.addingTimeInterval(120)
            #expect(try await s.source.folders().count == 1, "a 503 mid-sync didn't keep the folders")
            #expect(s.records.admission(s.family.groupId, owner: s.owner) == .admitted, "a 503 mid-sync took the record")

            let server = s.server
            server.lock.withLock {
                server.rostersFail = false
                server.manage.beforeAnswer = { method, path in
                    guard method == "GET", path == "/api/groups" else { return }
                    server.lock.withLock {
                        server.manage.beforeAnswer = nil
                        server.unauthorized = true
                    }
                }
            }
            s.clock.now = s.clock.now.addingTimeInterval(120)
            await #expect(throws: FamilyFilesError.signedOut) { _ = try await s.source.folders() }
            #expect(s.records.admission(s.family.groupId, owner: s.owner) == .admitted, "a 401 mid-sync took the record")
            await s.domains.settled()
            #expect(s.manager.removals.isEmpty)
        }

        /*
         * A listing learns a newer version of the file while its older one comes down: Files is
         * handed the row the bytes are of. Fails if the bytes of one version go out under another's
         * metadata.
         */
        @Test func aDownloadReturnsTheVersionItsBytesAreOf() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            let root = NodeRef(workspaceId: s.family.workspaceId, nodeId: s.family.rootId)
            _ = try await s.source.children(of: root)
            let started = try #require(s.family.photo.currentVersion)
            let newer = s.family.photo.with(version: VersionView(id: UUID().uuidString.lowercased(), objectId: UUID().uuidString.lowercased(),
                                                                 contentKeyEnvelope: started.contentKeyEnvelope, status: "ready", contentSuite: started.contentSuite,
                                                                 chunkCount: started.chunkCount, contentNonce: started.contentNonce, plaintextSize: nil,
                                                                 ciphertextSize: started.ciphertextSize, readyAt: "2026-10-19T10:05:00.000Z"))
            let (server, vault, ws, rootId) = (s.server, s.phone.vault, s.family.workspaceId, s.family.rootId)
            await vault.setBeforeChunk { _ in
                server.put(newer)
                _ = try? await vault.listChildren(of: rootId, in: ws)
            }
            let (file, item) = try await s.source.download(s.family.photo.ref)
            #expect(await vault.item(s.family.photo.ref)?.node.currentVersion?.id == newer.currentVersion?.id, "the listing didn't learn the newer version")
            #expect(item.node.currentVersion?.id == started.id, "the bytes of one version were handed out under another's row")
            #expect(try Data(contentsOf: file) == s.family.photoBytes)
        }

        /*
         * A sibling that doesn't open sits beside a healthy file that changed: the feed keeps the
         * healthy file and deletes only the broken one. Fails if a listing's failure on any row is
         * blamed on the node being looked at.
         */
        @Test func aBrokenSiblingIsNotBlamedOnAHealthyChangedFile() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            _ = try await s.source.folders()
            let f = s.family
            let brokenId = try newId(kind: .node, scopeId: f.workspaceId).id
            let broken = try FamilyFixture.node(id: brokenId, in: f.workspaceId, parent: f.rootId, parentKey: f.rootKey, key: randomBytes(length: 32),
                                                kind: .file, name: "Broken.txt", writer: f.creator, keyEpoch: 3)
                .with(metadataEnvelope: base64urlEncode(bytes: try randomBytes(length: 80)))
            s.server.put(broken)
            let changes = try #require(try await s.source.changes(since: FamilyAnchor(folders: [f.workspaceId: .init(root: f.rootId, cursor: 0)])))
            #expect(!changes.deleted.contains(FamilyFileIds.item(f.photo.ref)), "a healthy file was deleted for a broken sibling")
            #expect(changes.updated.contains { $0.ref == f.photo.ref })
            #expect(changes.deleted.contains(FamilyFileIds.item(NodeRef(workspaceId: f.workspaceId, nodeId: brokenId))))
        }

        /*
         * Many files change in one folder at once (a bulk upload, a re-key): the batch lists that folder
         * once, and every file still comes back as itself. Fails if each changed sibling lists its
         * folder again (a folder's whole listing per row, squared over the batch).
         */
        @Test func aBatchListsEachFolderOnce() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            _ = try await s.source.folders()
            let f = s.family
            var added: [NodeRef] = []
            for index in 0 ..< 5 {
                let id = try newId(kind: .node, scopeId: f.workspaceId).id
                s.server.put(try FamilyFixture.node(id: id, in: f.workspaceId, parent: f.rootId, parentKey: f.rootKey, key: randomBytes(length: 32), kind: .file,
                                                    name: "Upload \(index).txt", writer: f.creator))
                added.append(NodeRef(workspaceId: f.workspaceId, nodeId: id))
            }
            let path = "/api/drive/nodes/\(f.rootId)/children"
            let before = s.server.count(path)
            let changes = try #require(try await s.source.changes(since: FamilyAnchor(folders: [f.workspaceId: .init(root: f.rootId, cursor: 0)])))
            #expect(s.server.count(path) - before == 1, "the folder was listed \(s.server.count(path) - before) times for one batch")
            for ref in added + [f.photo.ref] {
                #expect(changes.updated.contains { $0.ref == ref }, "a changed file didn't come back")
                #expect(await s.phone.vault.item(ref) != nil, "a changed file read from the batch's listing isn't held")
            }
            #expect(changes.deleted.isEmpty)
        }

        /*
         * The app signs out (or in again) while a read in the extension waits: the final check reads
         * the shared session, refuses, and leaves no copy. Fails if the extension trusts only its own
         * process's view of the session.
         */
        @Test func aSessionChangedByAnotherProcessIsRefusedAtTheFinalCheck() async throws {
            for next in [nil, SharedKeychain.Session(origin: "https://family.test", token: "new", userId: UUID().uuidString)] as [SharedKeychain.Session?] {
                let s = try await Self.source()
                defer { s.phone.done() }
                _ = try await s.source.children(of: NodeRef(workspaceId: s.family.workspaceId, nodeId: s.family.rootId))
                let shared = s.shared
                await s.source.setLastAwait { shared.session = next }
                await #expect(throws: FamilyFilesError.otherAccount) { _ = try await s.source.download(s.family.photo.ref) }
                let copies = s.temporary.appendingPathComponent("opened/family/\(s.family.workspaceId)")
                #expect(!FileManager.default.fileExists(atPath: copies.path), "a copy outlived the session another process ended")
                #expect(!s.phone.vault.copySession.stands, "the extension's session wasn't ended")
            }
        }

        /*
         * The server's cursors move after the folders were checked: the anchor Files gets is the one
         * read with the folders it was shown, so a change in between is still reported. Fails if an
         * anchor's cursors are read later than its folders.
         */
        @Test func anAnchorUsesTheCursorsReadWithTheFolders() async throws {
            let s = try await Self.source()
            defer { s.phone.done() }
            _ = try await s.source.folders()
            s.server.lock.withLock { s.server.areaChangeSeq = 7 }
            let anchor = try await s.source.anchor()
            #expect(anchor.folders[s.family.workspaceId]?.cursor == 2, "the anchor sat past changes the folders shown don't hold")
            // A folder new to Files is anchored the same way.
            let fresh = try #require(try await s.source.changes(since: FamilyAnchor()))
            #expect(fresh.next.folders[s.family.workspaceId]?.cursor == 2)
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
                let partial = copies.appendingPathComponent("\(s.family.photo.id)/partial/content.part")
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
