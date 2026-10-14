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

struct SettingsMarksTests {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("marks-\(UUID().uuidString).json")
    var marks: SettingsMarks { SettingsMarks(file: file) }

    @Test func olderSettingsAfterANewerOneAreRefused() throws {
        defer { try? FileManager.default.removeItem(at: file) }
        // Nothing seen yet: no row and any version are fine.
        try marks.check(userId: "User-1", served: 0)
        try marks.check(userId: "User-1", served: 1)
        marks.record(userId: "User-1", version: 5)
        try marks.check(userId: "user-1", served: 5)
        try marks.check(userId: "user-1", served: 6)
        #expect(throws: ContactError.message(SettingsMarks.rolledBack)) { try marks.check(userId: "user-1", served: 4) }
        // Never lowered, and per account.
        marks.record(userId: "user-1", version: 2)
        #expect(marks.mark(userId: "user-1") == 5)
        try marks.check(userId: "user-2", served: 1)
    }

    /*
     * The server reports the stored sequence with or without a document: a version 1 row is
     * served as none at its sequence. That is no rollback while the sequence is at the mark;
     * none at a lower sequence (no row, say) after the mark is.
     */
    @Test func noDocumentIsARollbackOnlyBelowTheMark() throws {
        defer { try? FileManager.default.removeItem(at: file) }
        marks.record(userId: "user-1", version: 7)
        try marks.check(userId: "user-1", served: 7)
        #expect(throws: ContactError.message(SettingsMarks.rolledBack)) { try marks.check(userId: "user-1", served: 0) }
        #expect(throws: ContactError.message(SettingsMarks.rolledBack)) { try marks.check(userId: "user-1", served: 6) }
        #expect(marks.mark(userId: "user-1") == 7)
    }

    @Test func theMarkSurvivesASuccessionAndTakesOverOneKeptPerIdentityKey() throws {
        defer { try? FileManager.default.removeItem(at: file) }
        // An earlier version kept the mark under the account and its identity key: 7 seen under the old keys.
        HighWaterMarks(file: file).raise(SettingsMarks.legacyKey(userId: "user-1", encryptionPublicKey: "old-key"), to: 7)
        marks.adopt(userId: "user-1", encryptionPublicKeys: ["old-key"])
        #expect(throws: ContactError.message(SettingsMarks.rolledBack)) { try marks.check(userId: "user-1", served: 6) }
        // A succession changes the identity key; the mark is the account's and still refuses the older document.
        marks.adopt(userId: "user-1", encryptionPublicKeys: ["new-key"])
        #expect(throws: ContactError.message(SettingsMarks.rolledBack)) { try marks.check(userId: "user-1", served: 6) }
        // Taken over, never lowered by it: a higher mark already kept stays.
        marks.record(userId: "user-1", version: 9)
        HighWaterMarks(file: file).raise(SettingsMarks.legacyKey(userId: "user-1", encryptionPublicKey: "other-key"), to: 3)
        marks.adopt(userId: "user-1", encryptionPublicKeys: ["other-key"])
        #expect(marks.mark(userId: "user-1") == 9)
    }
}

/*
 * The highest own identity key version and identity version this device opened: an identity
 * served as current with a lower key version (keys the account replaced), or the version 1
 * form once version 2 was opened (which would be upgraded again into a second ML-DSA key), is
 * refused.
 */
struct IdentityMarksTests {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("identity-marks-\(UUID().uuidString).json")
    var marks: IdentityMarks { IdentityMarks(file: file) }

    @Test func anIdentityServedBelowTheHighestOpenedHereIsRefused() throws {
        defer { try? FileManager.default.removeItem(at: file) }
        try marks.check(userId: "user-1", keyVersion: 1, identityVersion: 2)
        marks.record(userId: "User-1", keyVersion: 3, identityVersion: 2)
        try marks.check(userId: "user-1", keyVersion: 3, identityVersion: 2)
        try marks.check(userId: "user-1", keyVersion: 4, identityVersion: 2)
        #expect(throws: AuthError.message(IdentityMarks.downgraded)) { try marks.check(userId: "user-1", keyVersion: 2, identityVersion: 2) }
        // Never lowered by a later, lower record, and per account.
        marks.record(userId: "user-1", keyVersion: 1, identityVersion: 1)
        #expect(throws: AuthError.message(IdentityMarks.downgraded)) { try marks.check(userId: "user-1", keyVersion: 2, identityVersion: 2) }
        try marks.check(userId: "user-2", keyVersion: 1, identityVersion: 1)
    }

    @Test func theVersionOneFormIsRefusedOnceVersionTwoWasOpenedEvenAtTheSameKeyVersion() throws {
        defer { try? FileManager.default.removeItem(at: file) }
        // Before the upgrade: version 1 at key version 3 is what the account has.
        marks.record(userId: "user-1", keyVersion: 3, identityVersion: 1)
        try marks.check(userId: "user-1", keyVersion: 3, identityVersion: 1)
        // Upgraded in place: the key version stays 3, so only the identity version tells the forms apart.
        marks.record(userId: "user-1", keyVersion: 3, identityVersion: 2)
        #expect(throws: AuthError.message(IdentityMarks.downgraded)) { try marks.check(userId: "user-1", keyVersion: 3, identityVersion: 1) }
        // Nor at a higher key version: every identity made since the release is version 2.
        #expect(throws: AuthError.message(IdentityMarks.downgraded)) { try marks.check(userId: "user-1", keyVersion: 4, identityVersion: 1) }
        try marks.check(userId: "user-1", keyVersion: 4, identityVersion: 2)
    }
}

struct LinkKdfTests {
    @Test func aLinkFromAnotherKeyDerivationIsRefused() throws {
        #expect(throws: DriveAPIError.self) { try LinkKdf.check(nil) }
        #expect(throws: DriveAPIError.self) { try LinkKdf.check(1) }
        try LinkKdf.check(Int(linkKdfVersion()))
    }
}
