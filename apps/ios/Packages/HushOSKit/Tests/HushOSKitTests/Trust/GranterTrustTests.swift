import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * A received share opens under the pinned Ed25519 key and the served ML-DSA key only when its
 * digest is the pin's (`granterKeysOf` in trust.ts): a share is signed with both, and taking the
 * server's word for either would let it fake a share "from" a contact with a key of its own.
 */
struct GranterTrustTests {
    let ana = "user-ana"
    let identity: (envelope: IdentityEnvelope, keys: IdentityKeys, root: Data)
    let other: (envelope: IdentityEnvelope, keys: IdentityKeys, root: Data)

    init() throws {
        identity = try makeIdentity(ana)
        other = try makeIdentity(ana)
    }

    @Test func aMatchingPinOpensWithThePinnedEd25519AndTheServedMlDsaKey() throws {
        for pin in [try pinned(ana, identity.keys, name: "Ana Lima"), try firstSeenPin()] {
            let opened = try #require(pin.granterKeys(servedOf(identity.envelope)))
            #expect(opened.signingPublicKey == (try base64urlDecode(value: identity.keys.signingPublicKey)))
            #expect(opened.mlDsaPublicKey == (try base64urlDecode(value: identity.keys.mlDsaPublicKey!)))
            #expect(!opened.replacedKeys)
        }
    }

    func firstSeenPin() throws -> ContactPin {
        ContactPin(userId: ana, email: "ana@example.com", name: "Ana Lima", keys: try firstSeen(identity.envelope), pinnedAt: "2026-10-01T00:00:00Z",
                   firstSeen: "added")
    }

    @Test func anMlDsaKeyOtherThanThePinnedOneOpensNothing() throws {
        let pin = try firstSeenPin()
        let swapped = HushOSKit.ServedContactKeys(keyVersion: 1, encryptionPublicKey: identity.keys.encryptionPublicKey, signingPublicKey: identity.keys.signingPublicKey,
                                                  mlDsaPublicKey: other.keys.mlDsaPublicKey, kemPublicKey: identity.keys.kemPublicKey)
        #expect(pin.granterKeys(swapped) == nil)
        // No ML-DSA key at all (the version 1 form served again): nothing, not a pass.
        #expect(pin.granterKeys(servedOf(identity.envelope, mlDsa: false)) == nil)
        #expect(pinnedBeforeTheRelease(try pinned(ana, identity.keys)).granterKeys(servedOf(identity.envelope)) == nil)
    }
}

/*
 * Version 3 pins: only one written after a words check over all four keys trusts anything,
 * and a share is sealed only to the keys it names, never to X25519 alone.
 */
struct PinTrustTests {
    let ana = "ana"
    let identity: (envelope: IdentityEnvelope, keys: IdentityKeys, root: Data)
    let other: (envelope: IdentityEnvelope, keys: IdentityKeys, root: Data)

    init() throws {
        identity = try makeIdentity(ana)
        other = try makeIdentity(ana)
    }

    func pin() throws -> ContactPin { try pinned(ana, identity.keys, name: "Ana") }

    func keys(encryption: String? = nil, signing: String? = nil, mlDsa: String?? = nil, kem: String?? = nil, version: UInt64 = 1) -> HushOSKit.ServedContactKeys {
        HushOSKit.ServedContactKeys(keyVersion: version, encryptionPublicKey: encryption ?? identity.keys.encryptionPublicKey,
                          signingPublicKey: signing ?? identity.keys.signingPublicKey,
                          mlDsaPublicKey: mlDsa ?? identity.keys.mlDsaPublicKey, kemPublicKey: kem ?? identity.keys.kemPublicKey)
    }

    @Test func onlyAVersionThreePinWithItsOwnFingerprintIsVerified() throws {
        let good = try pin()
        #expect(good.verified)
        // From before the release: no ML-DSA digest, whatever its words.
        #expect(!pinnedBeforeTheRelease(good).verified)
        var stripped = good
        stripped.mlDsaPublicKeyHash = nil
        #expect(!stripped.verified)
        // Digests swapped for another identity's: the words were not compared over them.
        var otherMlDsa = good
        otherMlDsa.mlDsaPublicKeyHash = keyDigest(publicKey: try base64urlDecode(value: other.keys.mlDsaPublicKey!))
        #expect(!otherMlDsa.verified)
        var otherKem = good
        otherKem.kemPublicKeyHash = keyDigest(publicKey: try base64urlDecode(value: other.keys.kemPublicKey!))
        #expect(!otherKem.verified)
    }

    @Test func thePinComparesEveryServedKey() throws {
        let good = try pin()
        #expect(good.compare(keys()) == .same)
        #expect(pinnedBeforeTheRelease(good).compare(keys()) == .recheck)
        // Beside the pinned X25519 and Ed25519 keys: no ML-DSA key, or another ML-DSA or ML-KEM key, is a change.
        #expect(good.compare(keys(mlDsa: .some(nil))) == .changed)
        #expect(good.compare(keys(mlDsa: other.keys.mlDsaPublicKey)) == .changed)
        #expect(good.compare(keys(kem: other.keys.kemPublicKey)) == .changed)
        #expect(good.compare(keys(kem: .some(nil))) == .changed)
        // Other keys at a higher version: a chain may explain them, only from a version 3 pin.
        let newer = keys(encryption: other.keys.encryptionPublicKey, signing: other.keys.signingPublicKey, mlDsa: other.keys.mlDsaPublicKey,
                         kem: other.keys.kemPublicKey, version: 2)
        #expect(good.compare(newer) == .succession)
        #expect(pinnedBeforeTheRelease(good).compare(newer) == .changed)
        // Other keys at the same version: no succession, a change.
        #expect(good.compare(keys(encryption: other.keys.encryptionPublicKey, signing: other.keys.signingPublicKey,
                                  mlDsa: other.keys.mlDsaPublicKey, kem: other.keys.kemPublicKey)) == .changed)
    }

    @Test func aFirstSeenPinIsHeldButNeverVerifiedAndComparesLikeAVerifiedOne() throws {
        let seen = ContactPin(userId: ana, email: "ana@example.com", name: "Ana", keys: try firstSeen(identity.envelope), pinnedAt: "2026-10-01T00:00:00Z",
                              firstSeen: "added")
        #expect(seen.trust == .seen && !seen.verified)
        #expect(seen.compare(keys()) == .same)
        #expect(seen.compare(keys(kem: other.keys.kemPublicKey)) == .changed)
        #expect(seen.compare(keys(mlDsa: other.keys.mlDsaPublicKey)) == .changed)
        // Its empty fingerprint replaced by the words over other keys: not verified, and not first-seen either.
        var forged = seen
        forged.fingerprint = try pin().fingerprint
        forged.mlDsaPublicKeyHash = keyDigest(publicKey: try base64urlDecode(value: other.keys.mlDsaPublicKey!))
        #expect(forged.trust == .invalid && !forged.verified)
        // Two first-seen pins of different keys are never the same keys, though both fingerprints are "".
        let another = ContactPin(userId: ana, email: "ana@example.com", name: "Ana", keys: try firstSeen(other.envelope), pinnedAt: "2026-10-01T00:00:00Z",
                                 firstSeen: "added")
        #expect(!ContactPin.sameKeys(seen, another))
    }

    @Test func comparingWordsPinsTheSameWordsTheirOwnDeviceShows() throws {
        // What People shows the owner: words over the four keys their device re-derived when it opened them.
        let own = try identityFingerprintOfKeys(
            encryptionPublicKey: try base64urlDecode(value: identity.keys.encryptionPublicKey),
            signingPublicKey: try base64urlDecode(value: identity.keys.signingPublicKey),
            mlDsaPublicKey: try base64urlDecode(value: identity.keys.mlDsaPublicKey!), kemPublicKey: try base64urlDecode(value: identity.keys.kemPublicKey!)
        )
        // What a contact pins from the served envelope.
        let pinnedFromServed = try ContactPin.of(servedOf(identity.envelope), userId: ana, email: "ana@example.com", name: "Ana", pinnedAt: "2026-10-15T00:00:00Z")
        #expect(pinnedFromServed.fingerprint == own)
        #expect(pinnedFromServed.verified)
        // The version 1 form has no words to compare.
        #expect(throws: ContactError.notUpgraded("Ana")) {
            try ContactPin.of(servedOf(identity.envelope, mlDsa: false), userId: ana, email: "ana@example.com", name: "Ana", pinnedAt: "2026-10-15T00:00:00Z")
        }
    }

    @Test func wordsAreOfferedOnlyOverAnIdentityWhoseKeysStatementHolds() throws {
        let envelope = identity.envelope
        let keys = servedOf(envelope)
        #expect(keysHold(userId: ana, keys, identityVersion: 2, keysSignature: envelope.keysSignature))
        // The statement names the account: someone else's keys under Ana's id do not hold.
        #expect(!keysHold(userId: "someone-else", keys, identityVersion: 2, keysSignature: envelope.keysSignature))
        // Another identity's statement beside these keys, or another ML-KEM key beside this statement.
        #expect(!keysHold(userId: ana, keys, identityVersion: 2, keysSignature: other.envelope.keysSignature))
        let swappedKem = HushOSKit.ServedContactKeys(keyVersion: keys.keyVersion, encryptionPublicKey: keys.encryptionPublicKey, signingPublicKey: keys.signingPublicKey,
                                           mlDsaPublicKey: keys.mlDsaPublicKey, kemPublicKey: other.keys.kemPublicKey)
        #expect(!keysHold(userId: ana, swappedKem, identityVersion: 2, keysSignature: envelope.keysSignature))
        // A version 1 identity is never upgraded in the server's word alone.
        #expect(!keysHold(userId: ana, keys, identityVersion: 1, keysSignature: envelope.keysSignature))
    }
}
