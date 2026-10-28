import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * The settings document is shared with the web and later versions: a save that drops a field
 * it doesn't know (the sharing ledger first of all) would let the next rotation forget who
 * the owner shared with. The ledger decides what a rotation seals again; the marks refuse a
 * server handing back older settings.
 */
struct SettingsDocumentTests {
    let written = #"""
    {"contacts":{"ana":{"userId":"ana","email":"ana@example.com","name":"Ana","encryptionPublicKey":"e","signingPublicKey":"s",
    "fingerprint":"f","pinnedAt":"2026-10-01T00:00:00Z","kemPublicKeyHash":null,"note":"met at the conference"}},
    "future":{"kept":true},"sharing":{"shares":{"node-a":["ana"]},"links":{"link-1":"node-a"},"also":1},"version":1}
    """#

    func reread(_ settings: Settings) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: Data(try settings.json().utf8)) as? [String: Any] ?? [:]
    }

    @Test func fieldsThisVersionDoesNotKnowSurviveEveryEdit() throws {
        var settings = try Settings(json: written, version: 4)
        let pin = try #require(settings.contacts["ana"])
        var renamed = pin
        renamed.kemPublicKeyHash = "digest"
        renamed.mlDsaPublicKeyHash = "ml-dsa-digest"
        settings.setPin(renamed)
        settings.setPin(ContactPin(userId: "bo", email: "bo@example.com", name: "Bo", encryptionPublicKey: "e2", signingPublicKey: "s2",
                                   fingerprint: "f2", pinnedAt: "2026-10-02T00:00:00Z", kemPublicKeyHash: nil))
        settings.removePin("bo")
        settings.ledger.addLink("link-2", node: "node-b")

        let document = try reread(settings)
        #expect((document["future"] as? [String: Any])?["kept"] as? Bool == true)
        let ana = try #require((document["contacts"] as? [String: Any])?["ana"] as? [String: Any])
        #expect(ana["note"] as? String == "met at the conference")
        #expect(ana["kemPublicKeyHash"] as? String == "digest")
        #expect(ana["mlDsaPublicKeyHash"] as? String == "ml-dsa-digest")
        let sharing = try #require(document["sharing"] as? [String: Any])
        #expect(sharing["also"] as? Int == 1)
        #expect((sharing["shares"] as? [String: [String]])?["node-a"] == ["ana"])
        #expect((sharing["links"] as? [String: String]) == ["link-1": "node-a", "link-2": "node-b"])
        // Read as version 1, always written as version 2: the only document version that may hold version 3 pins.
        #expect(document["version"] as? Int == 2)
        #expect(try Settings(json: try settings.json(), version: 5).contacts["ana"]?.mlDsaPublicKeyHash == "ml-dsa-digest")
    }

    @Test func aGroupsWordOnAPinIsReadKeptWhenFollowedAndClearedByAWordsCheck() throws {
        let group = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
        var settings = try Settings(
            json: written.replacingOccurrences(of: #""kemPublicKeyHash":null"#, with: #""kemPublicKeyHash":null,"trustedVia":"\#(group)""#),
            version: 1)
        var pin = try #require(settings.contacts["ana"])
        #expect(pin.trustedVia == group)
        // A followed pin carries the origin on (set here as follow sets it).
        pin.keysReplacedAt = "2026-10-03T00:00:00Z"
        settings.setPin(pin)
        #expect(try Settings(json: try settings.json(), version: 1).contacts["ana"]?.trustedVia == group)
        // A words check writes a pin with no origin: the group's word is gone.
        settings.setPin(ContactPin(userId: "ana", email: "ana@example.com", name: "Ana", encryptionPublicKey: "e", signingPublicKey: "s",
                                   fingerprint: "f", pinnedAt: "2026-10-04T00:00:00Z", kemPublicKeyHash: nil))
        let ana = try #require((try reread(settings)["contacts"] as? [String: Any])?["ana"] as? [String: Any])
        #expect(ana["trustedVia"] == nil)
    }

    @Test func pinningAgainWithoutAPostQuantumKeyClearsTheOldDigest() throws {
        // Writing null, not leaving the field out: a merge would otherwise keep the old digest.
        var settings = try Settings(json: written.replacingOccurrences(of: #""kemPublicKeyHash":null"#, with: #""kemPublicKeyHash":"old""#), version: 1)
        var pin = try #require(settings.contacts["ana"])
        pin.kemPublicKeyHash = nil
        settings.setPin(pin)
        #expect(try Settings(json: try settings.json(), version: 1).contacts["ana"]?.kemPublicKeyHash == nil)
    }

    @Test func theLedgerAddsOnceAndDropsEmptyNodes() {
        var ledger = SharingLedger()
        ledger.addShare(node: "Node-A", grantee: "ana")
        ledger.addShare(node: "node-a", grantee: "ANA")
        ledger.addShare(node: "node-a", grantee: "bo")
        #expect(ledger.shares == ["node-a": ["ana", "bo"]])
        ledger.removeShare(node: "node-a", grantee: "ana")
        #expect(ledger.holdsShare(node: "node-a", grantee: "bo"))
        #expect(!ledger.holdsShare(node: "node-a", grantee: "ana"))
        ledger.removeShare(node: "node-a", grantee: "bo")
        #expect(ledger.shares.isEmpty)
        ledger.addLink("link-1", node: "node-a")
        #expect(ledger.holdsLink("link-1", node: "node-a"))
        #expect(!ledger.holdsLink("link-1", node: "node-b"))
        ledger.removeLink("LINK-1")
        #expect(ledger.links.isEmpty)
    }
}

struct RotationLedgerTests {
    /* One node of rotation work as the server serves it, with the shares and links it claims. */
    func work(node: String, shares: [(id: String, grantee: String)], links: [String]) throws -> RotationWorkNode {
        let row: [String: Any] = [
            "id": node, "workspaceId": "ws", "parentId": "p", "kind": "folder", "keyEpoch": 1, "parentKeyEpoch": 1,
            "keyEnvelope": "", "metadataVersion": 1, "metadataEnvelope": "", "depth": 1, "versions": [],
            "shares": shares.map { ["id": $0.id, "granteeUserId": $0.grantee, "grantee": ["encryptionPublicKey": "e", "signingPublicKey": "s"]] },
            "links": links.map { ["id": $0, "hasPassword": false, "secretEnvelope": "x"] },
        ]
        return try JSONDecoder().decode(RotationWorkNode.self, from: JSONSerialization.data(withJSONObject: row))
    }

    @Test func onlySharesAndLinksTheOwnerRecordedAreSealedAgain() throws {
        var ledger = SharingLedger()
        ledger.addShare(node: "node-a", grantee: "ana")
        ledger.addLink("link-mine", node: "node-a")
        // Bo's share and the second link are the server's own additions; the third link is mine, but for another node.
        ledger.addLink("link-elsewhere", node: "node-b")
        let entry = try work(node: "node-a", shares: [("s1", "ana"), ("s2", "bo")], links: ["link-mine", "link-added", "link-elsewhere"])
        #expect(entry.ledgerShares(ledger).map(\.id) == ["s1"])
        #expect(entry.ledgerLinks(ledger).map(\.id) == ["link-mine"])
        #expect(entry.ledgerShares(SharingLedger()).isEmpty)
    }
}

/*
 * The rollback marks, sealed under a key from the settings key (RollbackMarks.swift): what the
 * phone keeps names neither the account nor what it counts, a record that does not open is
 * refused (never read as "nothing seen"), a mark is never lowered, and a mark that could not be
 * kept fails the step it guards.
 */
struct RollbackMarkStoreTests {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("marks-\(UUID().uuidString)/local/marks", isDirectory: true)
    let me = UUID().uuidString.lowercased()
    let floor = MarkFloor()
    var store: RollbackMarkStore { RollbackMarkStore(folder: folder, floor: floor) }
    static let envelope = SettingsKeyEnvelope(nonce: "kept-nonce", ciphertext: "kept-ciphertext")

    static func key(_ byte: UInt8) -> MarksKeys {
        { _, _ in MarksKey(key: Data(repeating: byte, count: 32), envelope: envelope) }
    }

    static let noKey: MarksKeys = { _, _ in nil }

    func marks(settings: UInt64 = 0, identity: UInt64 = 0, version: UInt64 = 0) -> RollbackMarks {
        RollbackMarks(settings: settings, settingsDocument: false, identity: identity, identityVersion: version)
    }

    func cleanUp() { try? FileManager.default.removeItem(at: folder.deletingLastPathComponent().deletingLastPathComponent()) }

    func files() -> [URL] { (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] }

    @Test func whatIsKeptIsSealedAndOpensOnlyUnderItsKey() async throws {
        defer { cleanUp() }
        try await store.raise(userId: me.uppercased(), to: marks(settings: 7, identity: 3, version: 2), keys: Self.key(1))
        let kept = try #require(files().first { $0.pathExtension == "json" })
        let text = try String(contentsOf: kept, encoding: .utf8)
        #expect(!text.contains(me) && !text.contains("\"settings\"") && !text.contains("identity"), "the record names the account or its marks")
        #expect(try await store.read(userId: me, keys: Self.key(1)) == marks(settings: 7, identity: 3, version: 2))
        // A fresh process (no marks in memory) under another settings key, or with none served: refused, never none.
        let fresh = RollbackMarkStore(folder: folder, floor: MarkFloor())
        await #expect(throws: AuthError.message(MarksWords.unreadable)) { _ = try await fresh.read(userId: me, keys: Self.key(2)) }
        await #expect(throws: AuthError.message(MarksWords.unreadable)) { _ = try await fresh.read(userId: me, keys: Self.noKey) }
        // Nor sealed over under the other key (what it asked for counts in that process only).
        await #expect(throws: AuthError.message(MarksWords.unreadable)) { try await fresh.raise(userId: me, to: marks(settings: 9), keys: Self.key(2)) }
        #expect(try await RollbackMarkStore(folder: folder, floor: MarkFloor()).read(userId: me, keys: Self.key(1)) == marks(settings: 7, identity: 3, version: 2))
    }

    @Test func aDamagedOrSwappedRecordIsRefused() async throws {
        defer { cleanUp() }
        let other = UUID().uuidString.lowercased()
        try await store.raise(userId: me, to: marks(settings: 4), keys: Self.key(1))
        try await store.raise(userId: other, to: marks(settings: 1), keys: Self.key(1))
        let mine = try #require(files().first { $0.lastPathComponent == "\(try rollbackMarksSlot(userId: me)).json" })
        let theirs = folder.appendingPathComponent("\(try rollbackMarksSlot(userId: other)).json")
        let fresh = RollbackMarkStore(folder: folder, floor: MarkFloor())
        // Another account's record in this account's slot: bound to its account, so it does not open.
        try FileManager.default.removeItem(at: mine)
        try FileManager.default.copyItem(at: theirs, to: mine)
        await #expect(throws: AuthError.message(MarksWords.unreadable)) { _ = try await fresh.read(userId: me, keys: Self.key(1)) }
        try Data("not a record".utf8).write(to: mine)
        await #expect(throws: AuthError.message(MarksWords.unreadable)) { _ = try await fresh.read(userId: me, keys: Self.key(1)) }
    }

    @Test func nothingKeptReadsAsNoneAndAsksForNoKey() async throws {
        defer { cleanUp() }
        #expect(try await store.read(userId: me, keys: { _, _ in Issue.record("asked for a key"); return nil }) == .none)
        // Raising nothing makes no record (and no settings key for one).
        try await store.raise(userId: me, to: .none, keys: { _, _ in Issue.record("asked for a key"); return nil })
        #expect(files().isEmpty)
    }

    @Test func aMarkIsNeverLoweredAndOlderCopiesAreRefused() async throws {
        defer { cleanUp() }
        try await store.raise(userId: me, to: marks(settings: 5, identity: 3, version: 2), keys: Self.key(1))
        try await store.raise(userId: me, to: marks(settings: 2, identity: 1, version: 1), keys: Self.key(1))
        let seen = try await RollbackMarkStore(folder: folder, floor: MarkFloor()).read(userId: me, keys: Self.key(1))
        #expect(seen == marks(settings: 5, identity: 3, version: 2))
        try SettingsMarks.check(seen, served: 5)
        #expect(throws: ContactError.message(SettingsMarks.rolledBack)) { try SettingsMarks.check(seen, served: 4) }
        // No document at all is a rollback only below the mark (a version 1 row is served as none at its sequence).
        #expect(throws: ContactError.message(SettingsMarks.rolledBack)) { try SettingsMarks.check(seen, served: 0) }
        try IdentityMarks.check(seen, keyVersion: 3, identityVersion: 2)
        #expect(throws: AuthError.message(IdentityMarks.downgraded)) { try IdentityMarks.check(seen, keyVersion: 2, identityVersion: 2) }
        // The version 1 form once version 2 was opened, at the same key version or above.
        #expect(throws: AuthError.message(IdentityMarks.downgraded)) { try IdentityMarks.check(seen, keyVersion: 3, identityVersion: 1) }
        #expect(throws: AuthError.message(IdentityMarks.downgraded)) { try IdentityMarks.check(seen, keyVersion: 4, identityVersion: 1) }
    }

    /*
     * The app and its extensions raise the same record at once. Each raise opens, raises and seals
     * the whole record, so without the lock a raise written over another's loses it.
     */
    @Test func raisesFromSeparateWritersAtOnceAreAllKept() async throws {
        defer { cleanUp() }
        let writers = 8
        let raises = 10
        await withTaskGroup(of: Void.self) { group in
            for writer in 0..<writers {
                group.addTask { [folder, me] in
                    for step in 1...raises {
                        // Each its own process: nothing raised in memory reaches another.
                        let store = RollbackMarkStore(folder: folder, floor: MarkFloor())
                        let value = UInt64(writer * raises + step)
                        _ = try? await store.raise(userId: me, to: writer % 2 == 0
                            ? RollbackMarks(settings: value, settingsDocument: false, identity: 0, identityVersion: 0)
                            : RollbackMarks(settings: 0, settingsDocument: false, identity: value, identityVersion: 0), keys: Self.key(1))
                    }
                }
            }
        }
        let kept = try await RollbackMarkStore(folder: folder, floor: MarkFloor()).read(userId: me, keys: Self.key(1))
        #expect(kept.settings == UInt64((writers - 2) * raises + raises))
        #expect(kept.identity == UInt64(writers * raises))
    }

    /* Another process holding the lock, from a descriptor of its own, until the returned closure lets go. */
    func holdLock() throws -> () -> Void {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let other = open(folder.path + ".lock", O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        guard other >= 0, flock(other, LOCK_EX) == 0 else { throw CocoaError(.fileLocking) }
        return { flock(other, LOCK_UN); close(other) }
    }

    /*
     * In the background the system may grant no time, and the record may be locked: the mark is
     * then not written, and the step it guards fails. It still counts in this process (or the
     * version 1 form served next is opened and upgraded again, minting a second ML-DSA key), and
     * lands with the next write.
     */
    @Test func aRaiseThatCouldNotBeKeptFailsYetCountsHereAndLandsWithTheNextWrite() async throws {
        defer { cleanUp() }
        let release = try holdLock()
        let hurried = RollbackMarkStore(folder: folder, activity: .expired, floor: floor)
        await #expect(throws: AuthError.message(MarksWords.unsaved)) {
            try await hurried.raise(userId: me, to: marks(identity: 3, version: 2), keys: Self.key(1))
        }
        #expect(try await RollbackMarkStore(folder: folder, floor: MarkFloor()).read(userId: me, keys: Self.key(1)) == .none, "nothing was written")
        let here = try await store.read(userId: me, keys: Self.key(1))
        #expect(throws: AuthError.message(IdentityMarks.downgraded)) { try IdentityMarks.check(here, keyVersion: 3, identityVersion: 1) }
        release()
        try await store.raise(userId: me, to: marks(settings: 1), keys: Self.key(1))
        #expect(try await RollbackMarkStore(folder: folder, floor: MarkFloor()).read(userId: me, keys: Self.key(1)) == marks(settings: 1, identity: 3, version: 2))
    }

    /*
     * A raise still waiting for the settings key when the person signs out: the wipe deletes the
     * marks, and the raise, finding its session gone, must not write them back.
     */
    @Test(arguments: [3, 2])
    func aRaiseThatWaitedThroughASignOutWritesNothingBack(settings: UInt64) async throws {
        defer { cleanUp() }
        let current = CurrentSession("first")
        var signedIn = RollbackMarkStore(folder: folder, floor: floor)
        signedIn.signedIn = { current.token == "first" }
        let store = signedIn
        try await store.raise(userId: me, to: marks(settings: 2), keys: Self.key(1))
        // A higher mark (written under the lock) and one already held (no write at all) alike.
        await #expect(throws: AuthError.message(MarksWords.unsaved)) {
            try await store.raise(userId: me, to: marks(settings: settings)) { _, _ in
                // Signed out while the key was being fetched, and another session signed in: the wipe ran between.
                current.token = nil
                store.deleteAll()
                current.token = "second"
                return MarksKey(key: Data(repeating: 1, count: 32), envelope: Self.envelope)
            }
        }
        #expect(!FileManager.default.fileExists(atPath: folder.path), "the marks came back after sign-out")
        // Nothing of the last session, in the files or in this process.
        #expect(try await store.read(userId: me, keys: Self.key(1)) == .none)
    }

    /* A raise with nothing to write still answers with what another process wrote while it waited for the key. */
    @Test func aRaiseThatNeedsNoWriteAnswersWithWhatWasWrittenMeanwhile() async throws {
        defer { cleanUp() }
        try await store.raise(userId: me, to: marks(identity: 3, version: 2), keys: Self.key(1))
        let kept = try await store.raise(userId: me, to: marks(identity: 3, version: 2)) { _, _ in
            // The Files extension opens a newer identity meanwhile.
            _ = try? await RollbackMarkStore(folder: folder, floor: MarkFloor()).raise(userId: me, to: marks(identity: 4, version: 2), keys: Self.key(1))
            return MarksKey(key: Data(repeating: 1, count: 32), envelope: Self.envelope)
        }
        #expect(kept.identity == 4)
    }

    /* A read answers with what another process wrote while it waited for the key, not what it found before. */
    @Test func aReadAnswersWithWhatWasWrittenMeanwhile() async throws {
        defer { cleanUp() }
        try await store.raise(userId: me, to: marks(identity: 3, version: 1), keys: Self.key(1))
        let seen = try await RollbackMarkStore(folder: folder, floor: MarkFloor()).read(userId: me) { _, _ in
            // The Files extension opens the upgraded identity meanwhile.
            _ = try? await RollbackMarkStore(folder: folder, floor: MarkFloor()).raise(userId: me, to: marks(identity: 3, version: 2), keys: Self.key(1))
            return MarksKey(key: Data(repeating: 1, count: 32), envelope: Self.envelope)
        }
        #expect(throws: AuthError.message(IdentityMarks.downgraded)) { try IdentityMarks.check(seen, keyVersion: 3, identityVersion: 1) }
    }

    /* A raise that couldn't be kept while another waited for its key goes into that one's write, never lost. */
    @Test func aRaiseThatFailedMeanwhileLandsWithTheWriteInFlight() async throws {
        defer { cleanUp() }
        let hurried = RollbackMarkStore(folder: folder, activity: .expired, floor: floor)
        try await store.raise(userId: me, to: marks(settings: 3)) { _, _ in
            let release = try holdLock()
            _ = try? await hurried.raise(userId: me, to: marks(settings: 9), keys: Self.key(1))
            release()
            return MarksKey(key: Data(repeating: 1, count: 32), envelope: Self.envelope)
        }
        #expect(try await RollbackMarkStore(folder: folder, floor: MarkFloor()).read(userId: me, keys: Self.key(1)).settings == 9)
    }

    /* What one session raised in this process (an extension that outlived a sign-out) is not another session's. */
    @Test func whatAProcessRaisedBelongsToItsSession() async throws {
        defer { cleanUp() }
        var first = RollbackMarkStore(folder: folder, activity: .expired, floor: floor)
        first.scope = "first"
        let release = try holdLock()
        await #expect(throws: AuthError.message(MarksWords.unsaved)) { try await first.raise(userId: me, to: marks(identity: 3, version: 2), keys: Self.key(1)) }
        release()
        #expect(try await first.read(userId: me, keys: Self.key(1)).identity == 3)
        var second = RollbackMarkStore(folder: folder, floor: floor)
        second.scope = "second"
        #expect(try await second.read(userId: me, keys: Self.key(1)) == .none)
    }

    /* A writer that stalled holding the lock past a sign-out finds its session gone after writing, and takes its record back. */
    @Test func aWriteThatOutlastedASignOutIsTakenBack() async throws {
        defer { cleanUp() }
        let checks = CurrentSession("0")
        var stalled = RollbackMarkStore(folder: folder, floor: floor)
        // Signed in for the checks before the write, signed out by the one after it.
        stalled.signedIn = {
            let seen = Int(checks.token ?? "0") ?? 0
            checks.token = String(seen + 1)
            return seen < 2
        }
        let store = stalled
        await #expect(throws: AuthError.message(MarksWords.unsaved)) { try await store.raise(userId: me, to: marks(settings: 4), keys: Self.key(1)) }
        #expect(files().allSatisfy { $0.pathExtension != "json" }, "a record outlived the sign-out")
    }

    /* A record that is there but can't be read is never "nothing seen", and never written over. */
    @Test func aRecordThatCannotBeReadIsRefused() async throws {
        defer { cleanUp() }
        try await store.raise(userId: me, to: marks(settings: 5), keys: Self.key(1))
        let mine = folder.appendingPathComponent("\(try rollbackMarksSlot(userId: me)).json")
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: mine.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: mine.path) }
        let fresh = RollbackMarkStore(folder: folder, floor: MarkFloor())
        await #expect(throws: AuthError.message(MarksWords.unreadable)) { _ = try await fresh.read(userId: me, keys: Self.key(1)) }
        await #expect(throws: AuthError.message(MarksWords.unreadable)) { try await fresh.raise(userId: me, to: marks(settings: 1), keys: Self.key(1)) }
    }

    final class CurrentSession: @unchecked Sendable {
        private let lock = NSLock()
        private var value: String?
        init(_ token: String?) { value = token }
        var token: String? {
            get { lock.withLock { value } }
            set { lock.withLock { value = newValue } }
        }
    }

    @Test func aKeyThatCannotBeHadFailsTheRaise() async throws {
        defer { cleanUp() }
        struct Offline: Error {}
        await #expect(throws: AuthError.message(MarksWords.unsaved)) {
            try await store.raise(userId: me, to: marks(settings: 2), keys: { _, _ in throw Offline() })
        }
        await #expect(throws: AuthError.message(MarksWords.unsaved)) { try await store.raise(userId: me, to: marks(settings: 2), keys: Self.noKey) }
    }

    /* The envelope that opened them is kept beside the marks, and offered first next time. */
    @Test func theSettingsKeyEnvelopeIsKeptBeside() async throws {
        defer { cleanUp() }
        try await store.raise(userId: me, to: marks(settings: 3), keys: Self.key(1))
        let offered = OfferedKeys()
        _ = try await RollbackMarkStore(folder: folder, floor: MarkFloor()).read(userId: me) { kept, create in
            offered.add(kept, create)
            return MarksKey(key: Data(repeating: 1, count: 32), envelope: Self.envelope)
        }
        #expect(offered.all == [OfferedKeys.Offer(kept: Self.envelope, create: false)])
    }

    final class OfferedKeys: @unchecked Sendable {
        struct Offer: Equatable { let kept: SettingsKeyEnvelope?; let create: Bool }
        private let lock = NSLock()
        private var offers: [Offer] = []
        func add(_ kept: SettingsKeyEnvelope?, _ create: Bool) { lock.withLock { offers.append(Offer(kept: kept, create: create)) } }
        var all: [Offer] { lock.withLock { offers } }
    }

    /* What an earlier version kept in the clear, by digest, beside the folder. */
    func writeLegacy(_ name: String, _ marks: [String: UInt64]) throws {
        let url = folder.deletingLastPathComponent().appendingPathComponent(name)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(marks).write(to: url)
    }

    @Test func plaintextMarksOfEarlierVersionsAreSealedAndRemoved() async throws {
        defer { cleanUp() }
        let other = UUID().uuidString.lowercased()
        try writeLegacy("settings-marks.json", [
            RollbackMarkStore.legacySettingsKey(me): 7,
            RollbackMarkStore.legacySettingsKey(me, encryptionPublicKey: "old-key"): 9,
            RollbackMarkStore.legacySettingsKey(other): 2,
        ])
        try writeLegacy("identity-marks.json", [RollbackMarkStore.legacyIdentityKey(me): 3, RollbackMarkStore.legacyIdentityVersionKey(me): 2])
        // The first read counts them and seals them.
        #expect(try await store.read(userId: me, keys: Self.key(1)) == marks(settings: 7, identity: 3, version: 2))
        let local = folder.deletingLastPathComponent()
        #expect(!FileManager.default.fileExists(atPath: local.appendingPathComponent("identity-marks.json").path))
        let left = try JSONDecoder().decode([String: UInt64].self, from: Data(contentsOf: local.appendingPathComponent("settings-marks.json")))
        #expect(Set(left.keys) == [RollbackMarkStore.legacySettingsKey(me, encryptionPublicKey: "old-key"), RollbackMarkStore.legacySettingsKey(other)])
        // A mark kept per identity key moves in once that identity opens: a succession never resets it.
        try await store.adopt(userId: me, encryptionPublicKeys: ["old-key"], keys: Self.key(1))
        let fresh = try await RollbackMarkStore(folder: folder, floor: MarkFloor()).read(userId: me, keys: Self.key(1))
        #expect(fresh.settings == 9)
        #expect(throws: ContactError.message(SettingsMarks.rolledBack)) { try SettingsMarks.check(fresh, served: 8) }
    }
}

struct LinkKdfTests {
    @Test func aLinkFromAnotherKeyDerivationIsRefused() throws {
        #expect(throws: DriveAPIError.self) { try LinkKdf.check(nil) }
        #expect(throws: DriveAPIError.self) { try LinkKdf.check(1) }
        try LinkKdf.check(Int(linkKdfVersion()))
    }
}
