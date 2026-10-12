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
        let sharing = try #require(document["sharing"] as? [String: Any])
        #expect(sharing["also"] as? Int == 1)
        #expect((sharing["shares"] as? [String: [String]])?["node-a"] == ["ana"])
        #expect((sharing["links"] as? [String: String]) == ["link-1": "node-a", "link-2": "node-b"])
        #expect(document["version"] as? Int == 1)
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
    let marks = SettingsMarks(file: FileManager.default.temporaryDirectory.appendingPathComponent("marks-\(UUID().uuidString).json"))
    let key = SettingsMarks.key(userId: "User-1", encryptionPublicKey: "key")

    @Test func olderOrMissingSettingsAfterANewerOneAreRefused() throws {
        defer { try? FileManager.default.removeItem(at: marks.file) }
        // Nothing seen yet: no document and any version are fine.
        try marks.check(key, served: nil)
        try marks.check(key, served: 1)
        marks.record(key, version: 5)
        try marks.check(key, served: 5)
        try marks.check(key, served: 6)
        #expect(throws: ContactError.message(SettingsMarks.rolledBack)) { try marks.check(key, served: 4) }
        #expect(throws: ContactError.message(SettingsMarks.rolledBack)) { try marks.check(key, served: nil) }
        // Never lowered, and per account and identity key.
        marks.record(key, version: 2)
        #expect(marks.mark(key) == 5)
        #expect(SettingsMarks.key(userId: "user-1", encryptionPublicKey: "key") == key)
        try marks.check(SettingsMarks.key(userId: "user-1", encryptionPublicKey: "rotated"), served: 1)
    }
}

/*
 * A pin vouches for keys only when it was made after a words check over both keys. And a
 * share is never sealed to X25519 alone: a missing, changed or unsigned post-quantum key is
 * refused with the person's name, not quietly downgraded.
 */
struct PinTrustTests {
    let encryption = try! randomBytes(length: 32)
    let signing = try! randomBytes(length: 32)
    /* An ML-KEM-768 public key's length; the core hands out at most 1024 random bytes at a time. */
    static func kemSized() throws -> Data { try randomBytes(length: 1024) + randomBytes(length: 160) }
    let kem = try! kemSized()

    func pin(fingerprint: String? = nil, signingKey: String? = nil, kemHash: String? = nil) -> ContactPin {
        let print = fingerprint ?? (try! identityFingerprint(encryptionPublicKey: encryption, signingPublicKey: signing))
        return ContactPin(userId: "ana", email: "ana@example.com", name: "Ana", encryptionPublicKey: base64urlEncode(bytes: encryption),
                          signingPublicKey: signingKey ?? base64urlEncode(bytes: signing), fingerprint: print,
                          pinnedAt: "2026-10-01T00:00:00Z", kemPublicKeyHash: kemHash)
    }

    var served: String { base64urlEncode(bytes: encryption) }

    @Test func aPinWithoutTheCurrentFingerprintOverBothKeysIsNotVerified() {
        #expect(pin().verified)
        #expect(!pin(signingKey: "").verified)
        #expect(!pin(fingerprint: "0000 0000 0000 0000 0000 0000 0000 0000 0000 0000").verified)
        // A fingerprint over another signing key than the one pinned.
        let other = try! identityFingerprint(encryptionPublicKey: encryption, signingPublicKey: try! randomBytes(length: 32))
        #expect(!pin(fingerprint: other).verified)
    }

    @Test func nothingIsSealedToAnUnverifiedPinOrWithoutAVouchedPostQuantumKey() throws {
        let kemKey = base64urlEncode(bytes: kem)
        #expect(throws: ContactError.recheck("Ana")) {
            try pin(signingKey: "").sealKeys(encryptionPublicKey: served, kemPublicKey: kemKey, kemSignature: nil)
        }
        #expect(throws: ContactError.changed) {
            try pin().sealKeys(encryptionPublicKey: base64urlEncode(bytes: try randomBytes(length: 32)), kemPublicKey: kemKey, kemSignature: nil)
        }
        #expect(throws: ContactError.noKem("Ana")) { try pin().sealKeys(encryptionPublicKey: served, kemPublicKey: nil, kemSignature: nil) }
        // First seen and not signed by the pinned signing key (a forged signature, or none).
        #expect(throws: ContactError.kemUnsigned("Ana")) {
            try pin().sealKeys(encryptionPublicKey: served, kemPublicKey: kemKey, kemSignature: base64urlEncode(bytes: Data(repeating: 7, count: 64)))
        }
        #expect(throws: ContactError.kemUnsigned("Ana")) { try pin().sealKeys(encryptionPublicKey: served, kemPublicKey: kemKey, kemSignature: nil) }
        // Remembered before: a different one is refused, the same one is used.
        #expect(throws: ContactError.kemChanged("Ana")) {
            try pin(kemHash: keyDigest(publicKey: try Self.kemSized())).sealKeys(encryptionPublicKey: served, kemPublicKey: kemKey, kemSignature: nil)
        }
        let sealing = try pin(kemHash: keyDigest(publicKey: kem)).sealKeys(encryptionPublicKey: served, kemPublicKey: kemKey, kemSignature: nil)
        #expect(sealing.kem == kem && sealing.publicKey == encryption && sealing.newDigest == nil)
    }

    @Test func aLinkFromAnotherKeyDerivationIsRefused() throws {
        #expect(throws: DriveAPIError.self) { try LinkKdf.check(nil) }
        #expect(throws: DriveAPIError.self) { try LinkKdf.check(1) }
        try LinkKdf.check(Int(linkKdfVersion()))
    }
}
