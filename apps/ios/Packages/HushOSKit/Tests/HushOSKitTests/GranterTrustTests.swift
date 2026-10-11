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

    var pins: [String: ContactPin] {
        ["user-ana": ContactPin(userId: "user-ana", email: "ana@example.com", name: "Ana Lima", encryptionPublicKey: pinnedKey,
                                signingPublicKey: base64urlEncode(bytes: Data(repeating: 3, count: 32)), fingerprint: "",
                                pinnedAt: "2026-10-01T00:00:00Z", kemPublicKeyHash: nil)]
    }

    @Test func aGranterNobodyPinnedIsRefusedAndNotPinned() {
        #expect(throws: GranterTrust.unverified(name: "Ana Lima")) { try ContactPin.granterKey(granter(key: serverKey), pins: [:]) }
    }

    @Test func aServedKeyOtherThanThePinnedOneIsRefused() {
        #expect(throws: GranterTrust.changed(name: "Ana Lima")) { try ContactPin.granterKey(granter(key: serverKey), pins: pins) }
    }

    @Test func aMatchingPinOpensWithThePinnedKey() throws {
        let key = try ContactPin.granterKey(granter(key: pinnedKey), pins: pins)
        #expect(key == Data(repeating: 1, count: 32))
    }
}
