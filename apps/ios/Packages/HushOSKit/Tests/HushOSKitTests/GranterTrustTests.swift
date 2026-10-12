import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * A received share opens only under a key the person checked. Taking the server's word for
 * the granter's key would let a server fake a share "from" anyone, sealed with a key of its own.
 */
struct GranterTrustTests {
    let pinnedKey = base64urlEncode(bytes: Data(repeating: 1, count: 32))
    let serverKey = base64urlEncode(bytes: Data(repeating: 2, count: 32))

    func granter(key: String) -> SharedWithMeView.Granter {
        SharedWithMeView.Granter(id: "user-ana", name: "Ana Lima", email: "ana@example.com", encryptionPublicKey: key)
    }

    /* A pin made after a words check: its fingerprint is the current one over both keys. */
    func pins(fingerprint: String? = nil) -> [String: ContactPin] {
        let signing = Data(repeating: 3, count: 32)
        let print = fingerprint ?? (try! identityFingerprint(encryptionPublicKey: Data(repeating: 1, count: 32), signingPublicKey: signing))
        return ["user-ana": ContactPin(userId: "user-ana", email: "ana@example.com", name: "Ana Lima", encryptionPublicKey: pinnedKey,
                                       signingPublicKey: base64urlEncode(bytes: signing), fingerprint: print,
                                       pinnedAt: "2026-10-01T00:00:00Z", kemPublicKeyHash: nil)]
    }
    var pins: [String: ContactPin] { pins() }

    @Test func aGranterNobodyPinnedIsRefusedAndNotPinned() {
        #expect(throws: GranterTrust.unverified(name: "Ana Lima")) { try ContactPin.granterKey(granter(key: serverKey), pins: [:]) }
    }

    @Test func aServedKeyOtherThanThePinnedOneIsRefused() {
        #expect(throws: GranterTrust.changed(name: "Ana Lima")) { try ContactPin.granterKey(granter(key: serverKey), pins: pins) }
    }

    @Test func aPinThatWasNeverCheckedOverBothKeysOpensNothing() {
        // Made before the fingerprint covered the signing key (or edited): the right X25519 key is not enough.
        #expect(throws: GranterTrust.recheck(name: "Ana Lima")) { try ContactPin.granterKey(granter(key: pinnedKey), pins: pins(fingerprint: "")) }
        #expect(GranterTrust.recheck(name: "Ana Lima").unverified)
    }

    @Test func aMatchingPinOpensWithThePinnedKey() throws {
        let key = try ContactPin.granterKey(granter(key: pinnedKey), pins: pins)
        #expect(key == Data(repeating: 1, count: 32))
    }
}
