import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * A received share opens only under keys the person checked. Taking the server's word for
 * the granter's keys would let a server fake a share "from" anyone, sealed with keys of its
 * own; and since a share is signed with both Ed25519 and ML-DSA, the served ML-DSA key is
 * used only when its digest is the version 3 pin's.
 */
struct GranterTrustTests {
    let ana = "user-ana"
    let identity: (envelope: IdentityEnvelope, keys: IdentityKeys, root: Data)
    let other: (envelope: IdentityEnvelope, keys: IdentityKeys, root: Data)

    init() throws {
        identity = try makeIdentity(ana)
        other = try makeIdentity(ana)
    }

    /* The granter as the server serves them on a received share. */
    func granter(_ keys: ServedContactKeys) -> SharedWithMeView.Granter {
        var granter = SharedWithMeView.Granter(id: ana, name: "Ana Lima", email: "ana@example.com", encryptionPublicKey: keys.encryptionPublicKey)
        granter.signingPublicKey = keys.signingPublicKey
        granter.keyVersion = keys.keyVersion
        granter.identityVersion = keys.mlDsaPublicKey == nil ? 1 : 2
        granter.mlDsaPublicKey = keys.mlDsaPublicKey
        granter.kemPublicKey = keys.kemPublicKey
        return granter
    }

    func pins(_ pin: ContactPin) -> [String: ContactPin] { [ana: pin] }

    @Test func aGranterNobodyPinnedIsRefusedAndNotPinned() {
        #expect(throws: GranterTrust.unverified(name: "Ana Lima")) { try ContactPin.granter(granter(servedOf(identity.envelope)), pins: [:]) }
    }

    @Test func aMatchingVersionThreePinOpensWithThePinnedEd25519AndTheServedMlDsaKey() throws {
        let pin = try pinned(ana, identity.keys, name: "Ana Lima")
        let opened = try ContactPin.granter(granter(servedOf(identity.envelope)), pins: pins(pin))
        #expect(opened.signingPublicKey == (try base64urlDecode(value: identity.keys.signingPublicKey)))
        #expect(opened.mlDsaPublicKey == (try base64urlDecode(value: identity.keys.mlDsaPublicKey!)))
        #expect(!opened.replacedKeys)
    }

    @Test func aPinFromBeforeTheReleaseOpensNothingUntilWordsAreComparedAgain() throws {
        // The same X25519 and Ed25519 keys and their upgraded identity: still "check words again", never opened.
        let old = pinnedBeforeTheRelease(try pinned(ana, identity.keys, name: "Ana Lima"))
        #expect(throws: GranterTrust.recheck(name: "Ana Lima")) { try ContactPin.granter(granter(servedOf(identity.envelope)), pins: pins(old)) }
        // Nor when the server serves the version 1 form beside those keys.
        #expect(throws: GranterTrust.recheck(name: "Ana Lima")) {
            try ContactPin.granter(granter(servedOf(identity.envelope, mlDsa: false)), pins: pins(old))
        }
        #expect(GranterTrust.recheck(name: "Ana Lima").unverified)
    }

    @Test func anMlDsaKeyOtherThanThePinnedOneBesideTheSameClassicalKeysIsAChange() throws {
        let pin = try pinned(ana, identity.keys, name: "Ana Lima")
        let swapped = ServedContactKeys(keyVersion: 1, encryptionPublicKey: identity.keys.encryptionPublicKey, signingPublicKey: identity.keys.signingPublicKey,
                                        mlDsaPublicKey: other.keys.mlDsaPublicKey, kemPublicKey: identity.keys.kemPublicKey)
        #expect(throws: GranterTrust.changed(name: "Ana Lima")) { try ContactPin.granter(granter(swapped), pins: pins(pin)) }
        // No ML-DSA key at all (the version 1 form served again): a change, not a pass.
        #expect(throws: GranterTrust.changed(name: "Ana Lima")) {
            try ContactPin.granter(granter(servedOf(identity.envelope, mlDsa: false)), pins: pins(pin))
        }
    }

    @Test func otherKeysServedAreAChangeNotFollowedQuietly() throws {
        let pin = try pinned(ana, identity.keys, name: "Ana Lima")
        // Someone else's keys under Ana's name, at a higher version: nothing is followed until the person checks again.
        var newer = servedOf(other.envelope)
        newer = ServedContactKeys(keyVersion: 2, encryptionPublicKey: newer.encryptionPublicKey, signingPublicKey: newer.signingPublicKey,
                                  mlDsaPublicKey: newer.mlDsaPublicKey, kemPublicKey: newer.kemPublicKey)
        #expect(throws: GranterTrust.changed(name: "Ana Lima")) { try ContactPin.granter(granter(newer), pins: pins(pin)) }
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

    func keys(encryption: String? = nil, signing: String? = nil, mlDsa: String?? = nil, kem: String?? = nil, version: UInt64 = 1) -> ServedContactKeys {
        ServedContactKeys(keyVersion: version, encryptionPublicKey: encryption ?? identity.keys.encryptionPublicKey,
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

    @Test func nothingIsSealedExceptToTheKeysTheVersionThreePinNames() throws {
        let good = try pin()
        let sealing = try good.sealKeys(keys())
        #expect(sealing.publicKey == (try base64urlDecode(value: identity.keys.encryptionPublicKey)))
        #expect(sealing.kem == (try base64urlDecode(value: identity.keys.kemPublicKey!)))
        #expect(throws: ContactError.recheck("Ana")) { try pinnedBeforeTheRelease(good).sealKeys(keys()) }
        #expect(throws: ContactError.changed) { try good.sealKeys(keys(kem: other.keys.kemPublicKey)) }
        #expect(throws: ContactError.changed) { try good.sealKeys(keys(kem: .some(nil))) }
        #expect(throws: ContactError.changed) { try good.sealKeys(keys(encryption: other.keys.encryptionPublicKey)) }
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
        let swappedKem = ServedContactKeys(keyVersion: keys.keyVersion, encryptionPublicKey: keys.encryptionPublicKey, signingPublicKey: keys.signingPublicKey,
                                           mlDsaPublicKey: keys.mlDsaPublicKey, kemPublicKey: other.keys.kemPublicKey)
        #expect(!keysHold(userId: ana, swappedKem, identityVersion: 2, keysSignature: envelope.keysSignature))
        // A version 1 identity is never upgraded in the server's word alone.
        #expect(!keysHold(userId: ana, keys, identityVersion: 1, keysSignature: envelope.keysSignature))
    }
}
