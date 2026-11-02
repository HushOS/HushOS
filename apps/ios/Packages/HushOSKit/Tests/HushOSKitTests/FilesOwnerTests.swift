import FileProvider
import Foundation
import Testing
@testable import HushOSKit

/*
 * Every account shares one Files location, and the location keeps what Files cached and has
 * not synced. On the simulator a sign-in to a second account without signing out kept the
 * first account's location, and its extension re-created the first account's folders in the
 * second account's drive. These hold the rules that stop that: the location is replaced for
 * another account, the extension refuses another account's location, the queue drops another
 * account's transfers, and decrypted copies are kept per account.
 */
@Suite final class FilesOwnerTests {
    let base: URL
    let alice = AccountOwner(userId: "5C7C6B89-26A2-4484-8921-04978891699F", origin: "https://hushos.com")
    let bob = AccountOwner(userId: "a71e7fed-fb84-4a3e-ba2c-3d3359a9dabe", origin: "https://hushos.com")
    /* Alice's user id on another server: a staging copy of production's database. */
    let aliceOnStaging = AccountOwner(userId: "5c7c6b89-26a2-4484-8921-04978891699f", origin: "https://staging.hushos.com")

    init() {
        base = FileManager.default.temporaryDirectory.appendingPathComponent("files-owner-" + UUID().uuidString, isDirectory: true)
    }

    deinit { try? FileManager.default.removeItem(at: base) }

    func session(_ owner: AccountOwner, origin: String? = nil) -> SharedKeychain.Session {
        SharedKeychain.Session(origin: origin ?? owner.origin, token: "token-\(owner.userId)", userId: owner.userId)
    }

    // MARK: - Signing in: keep or replace the location

    @Test func theSameAccountKeepsItsLocation() {
        // Kept downloads and anything not synced yet are its own.
        let typed = AccountOwner(userId: alice.userId.uppercased(), origin: "https://HushOS.com/")
        #expect(FilesDomainOwner.plan(domainExists: true, recorded: alice, signingIn: typed) == .keep)
    }

    @Test func anotherAccountOrServerReplacesTheLocation() {
        #expect(FilesDomainOwner.plan(domainExists: true, recorded: alice, signingIn: bob) == .replace)
        #expect(FilesDomainOwner.plan(domainExists: true, recorded: alice, signingIn: aliceOnStaging) == .replace)
    }

    @Test func aLocationNobodyIsRecordedAsOwningIsReplaced() {
        // Added by a version that recorded no owner, or left by an uninstall (the app group goes, the domain does not).
        #expect(FilesDomainOwner.plan(domainExists: true, recorded: nil, signingIn: alice) == .replace)
    }

    @Test func noLocationIsAdded() {
        #expect(FilesDomainOwner.plan(domainExists: false, recorded: bob, signingIn: alice) == .add)
        #expect(FilesDomainOwner.plan(domainExists: false, recorded: nil, signingIn: alice) == .add)
    }

    @Test func theOwnerRecordReadsBackWhatWasWrittenAndNothingElse() throws {
        let record = FilesDomainOwner(file: base.appendingPathComponent("local/files-domain-owner.json"))
        #expect(record.read() == nil)
        try record.write(alice)
        #expect(record.read() == alice)
        // A damaged record is no owner, never someone's.
        try Data("5c7c6b89-26a2-4484-8921-04978891699f".utf8).write(to: record.file)
        #expect(record.read() == nil)
        try record.write(bob)
        record.clear()
        #expect(record.read() == nil)
    }

    // MARK: - The Files extension's gate

    /* A gate over a stand-in vault, counting the vaults made: a vault is the only way to the server. */
    final class Harness: @unchecked Sendable {
        var owner: AccountOwner?
        var session: SharedKeychain.Session?
        var made: [SharedKeychain.Session] = []
        var served: [AccountOwner?] = []
        lazy var gate = FilesGate<String>(
            owner: { [unowned self] in owner },
            session: { [unowned self] in session },
            changed: { [unowned self] in served.append($0) },
            make: { [unowned self] in made.append($0); return "vault for \($0.userId)" }
        )
    }

    func refused(_ harness: Harness) -> Bool {
        do {
            _ = try harness.gate.open()
            return false
        } catch let error as NSFileProviderError {
            return error.code == .notAuthenticated
        } catch {
            return false
        }
    }

    /*
     * The first download after the extension claims its folder for the account (a new session, a
     * relaunch): opening the vault claims, and the download's own copy, kept to that vault's
     * session, goes on. A sign-out after still stops it. Fails if the vault is made before the claim.
     */
    @Test func aDownloadThatClaimsTheFolderStillCompletes() async throws {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("claim-\(UUID().uuidString)", isDirectory: true)
        let account = CopyEpoch()
        let (owner, signedIn) = (alice, session(alice))
        let gate = FilesGate<Vault>(owner: { owner }, session: { signedIn },
                                    changed: { TemporaryCopies.claim($0, in: temporary, account: account) },
                                    make: { Vault(api: DriveAPI(session: $0), session: $0, account: account) })
        let copies = try gate.open().copyGate(familyWorkspace: nil)
        let copy = temporary.appendingPathComponent("downloads/node-a/version-1/content")
        try await Resumable.download(to: copy, count: 1, chunkBytes: 4, gate: copies) { _ in Data("abcd".utf8) }
        #expect(FileManager.default.fileExists(atPath: copy.path), "the claim refused the download that made it")

        let later = try gate.open().copyGate(familyWorkspace: nil)
        TemporaryCopies.endAccount(account)
        let other = temporary.appendingPathComponent("downloads/node-b/version-1/content")
        await #expect(throws: (any Error).self) {
            try await Resumable.download(to: other, count: 1, chunkBytes: 4, gate: later) { _ in Data("abcd".utf8) }
        }
    }

    @Test func theExtensionRefusesAnotherAccountsLocation() {
        // Bob signed in while Alice's location, with her pending folders, is still there.
        let harness = Harness()
        harness.owner = alice
        harness.session = session(bob)
        #expect(refused(harness))
        #expect(harness.made.isEmpty, "a vault was made for another account's location")
    }

    @Test func theExtensionRefusesTheSameUserIdOnAnotherServer() {
        let harness = Harness()
        harness.owner = alice
        harness.session = session(aliceOnStaging)
        #expect(refused(harness))
        #expect(harness.made.isEmpty)
    }

    @Test func theExtensionRefusesALocationWithoutAnOwnerOrASession() {
        let harness = Harness()
        harness.session = session(alice)
        #expect(refused(harness), "a location nobody owns was served")
        harness.owner = alice
        harness.session = nil
        #expect(refused(harness), "served with nobody signed in")
        #expect(harness.made.isEmpty)
    }

    @Test func aVaultMadeForOneAccountIsNotHandedOutOnceAnotherSignsIn() throws {
        let harness = Harness()
        harness.owner = alice
        harness.session = session(alice)
        #expect(try harness.gate.open() == "vault for \(alice.userId)")
        #expect(try harness.gate.open() == "vault for \(alice.userId)")
        #expect(harness.made.count == 1)
        // From the Files sheet: Bob's session lands, Alice's location stays until the app replaces it.
        harness.session = session(bob)
        #expect(refused(harness), "Alice's vault was handed out under Bob's session")
        // The app replaced the location for Bob: served again, by a vault made for Bob.
        harness.owner = bob
        #expect(try harness.gate.open() == "vault for \(bob.userId)")
        #expect(harness.made.map(\.userId) == [alice.userId, bob.userId])
        // Every change of account told the extension, so it dropped what it decrypted for the last one.
        #expect(harness.served == [alice, nil, bob])
    }

    // MARK: - The queue

    @Test func aTransferQueuedForAnotherAccountIsDroppedNotRun() {
        #expect(TransferOwnership.of(alice, signedIn: bob) == .drop)
        #expect(TransferOwnership.of(alice, signedIn: aliceOnStaging) == .drop)
        // Queued by a version that did not say whose: nobody can vouch it is this account's.
        #expect(TransferOwnership.of(nil, signedIn: bob) == .drop)
    }

    @Test func aTransferRunsForItsOwnAccountAndWaitsWhileNobodyIsSignedIn() {
        #expect(TransferOwnership.of(alice, signedIn: AccountOwner(userId: alice.userId.lowercased(), origin: "https://hushos.com/")) == .run)
        // Alice's session ended; she may sign back in, so her queue is kept, not run.
        #expect(TransferOwnership.of(alice, signedIn: nil) == .wait)
    }

    @Test func aSaveToHushOSNoteKeepsItsOwnerAndAnOlderOneHasNone() throws {
        let sealed = Vault.SealedUpload(uploadId: "u", workspaceId: "w", nodeId: "n", parentId: "p", partCount: 1, replacing: false,
                                        name: "Scan.pdf", mime: "application/pdf", size: 3, modified: nil, urls: [1: "https://store/part-1"])
        let note = ShareHandoff(id: UUID(), name: "Scan.pdf", folderId: "p", mime: "application/pdf", size: 3, sealed: sealed, owner: alice)
        let written = try JSONEncoder().encode(note)
        #expect(try JSONDecoder().decode(ShareHandoff.self, from: written).owner == alice)
        // A note written before notes said whose: still read, then dropped by the queue's rule.
        var fields = try #require(try JSONSerialization.jsonObject(with: written) as? [String: Any])
        fields["owner"] = nil
        let older = try JSONDecoder().decode(ShareHandoff.self, from: JSONSerialization.data(withJSONObject: fields))
        #expect(older.owner == nil)
        #expect(TransferOwnership.of(older.owner, signedIn: alice) == .drop)
    }

    // MARK: - Decrypted copies per account

    @Test func decryptedCopiesGoWhenAnotherAccountIsServed() throws {
        let temporary = base.appendingPathComponent("tmp", isDirectory: true)
        let copy = temporary.appendingPathComponent("downloads/node-a/version-1/content")
        // Alice is served, then Files downloads one of her files.
        TemporaryCopies.claim(alice, in: temporary, account: CopyEpoch())
        try FileManager.default.createDirectory(at: copy.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("decrypted".utf8).write(to: copy)

        TemporaryCopies.claim(AccountOwner(userId: alice.userId, origin: "https://hushos.com/"), in: temporary, account: CopyEpoch())
        #expect(FileManager.default.fileExists(atPath: copy.path), "the same account lost its copies")

        TemporaryCopies.claim(aliceOnStaging, in: temporary, account: CopyEpoch())
        #expect(!FileManager.default.fileExists(atPath: copy.path), "Alice's copy survived the same user id on another server")

        try FileManager.default.createDirectory(at: copy.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("decrypted".utf8).write(to: copy)
        TemporaryCopies.claim(nil, in: temporary, account: CopyEpoch())
        #expect(!FileManager.default.fileExists(atPath: copy.path), "a copy survived with nobody signed in")
    }

    /*
     * Files serves another account while one of Alice's files comes down (the extension saw the
     * change, not a sign-out): her download writes nothing into the folder emptied for the next,
     * while the same account served again lets its own go on. Fails if a claim that empties the
     * folder doesn't end what was begun before it.
     */
    @Test func aDownloadBegunForAnotherAccountWritesNothing() async throws {
        let temporary = base.appendingPathComponent("tmp-switch", isDirectory: true)
        let account = CopyEpoch()
        TemporaryCopies.claim(alice, in: temporary, account: account)
        let copy = temporary.appendingPathComponent("downloads/node-a/version-1/content")
        let gate = TemporaryCopies.copyGate(familyWorkspace: nil, account: account)
        TemporaryCopies.claim(alice, in: temporary, account: account)
        try await Resumable.download(to: copy, count: 1, chunkBytes: 4, gate: gate) { _ in Data("abcd".utf8) }
        #expect(FileManager.default.fileExists(atPath: copy.path), "the same account's download was stopped")

        let other = temporary.appendingPathComponent("downloads/node-b/version-1/content")
        let begun = TemporaryCopies.copyGate(familyWorkspace: nil, account: account)
        TemporaryCopies.claim(aliceOnStaging, in: temporary, account: account)
        await #expect(throws: (any Error).self) {
            try await Resumable.download(to: other, count: 1, chunkBytes: 4, gate: begun) { _ in Data("abcd".utf8) }
        }
        #expect(!FileManager.default.fileExists(atPath: other.path))
        #expect(!FileManager.default.fileExists(atPath: other.appendingPathExtension("part").path))
    }

    @Test func copiesUnderAnOlderVersionsMarkerAreNobodys() throws {
        // The extension once wrote the bare user id; it says nothing about the server.
        let temporary = base.appendingPathComponent("tmp-legacy", isDirectory: true)
        let copy = temporary.appendingPathComponent("downloads/node-a/version-1/content")
        try FileManager.default.createDirectory(at: copy.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("decrypted".utf8).write(to: copy)
        try Data(alice.userId.utf8).write(to: temporary.appendingPathComponent("account-owner"))
        TemporaryCopies.claim(alice, in: temporary, account: CopyEpoch())
        #expect(!FileManager.default.fileExists(atPath: copy.path))
    }
}
