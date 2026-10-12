import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/* An identity as the web mints one, opened: what signs, seals and opens below. */
private func makeIdentity(_ userId: String, root: Data? = nil, version: UInt64 = 1) throws -> (envelope: IdentityEnvelope, keys: IdentityKeys, root: Data) {
    let root = try root ?? randomBytes(length: 32)
    let envelope = try identityCreate(userId: userId, accountKey: root, keyVersion: version)
    return (envelope, try identityOpen(userId: userId, accountKey: root, envelope: envelope), root)
}

/* A pin made after a words check over these keys. */
private func pinned(_ userId: String, _ keys: IdentityKeys, name: String = "Maya", keyVersion: UInt64? = 1) throws -> ContactPin {
    var pin = ContactPin(
        userId: userId, email: "\(name.lowercased())@example.com", name: name, encryptionPublicKey: keys.encryptionPublicKey,
        signingPublicKey: keys.signingPublicKey,
        fingerprint: try identityFingerprint(encryptionPublicKey: try base64urlDecode(value: keys.encryptionPublicKey), signingPublicKey: try base64urlDecode(value: keys.signingPublicKey)),
        pinnedAt: "2026-10-01T00:00:00Z", kemPublicKeyHash: nil
    )
    pin.keyVersion = keyVersion
    return pin
}

/*
 * What a reader shows for a node, from the keys it trusts: verified only for a signature by
 * someone checked (or itself), and never verified for a record someone else could have made.
 */
struct IntegrityDecisionTests {
    let workspace = UUID().uuidString.lowercased()
    let me = UUID().uuidString.lowercased()
    let maya = UUID().uuidString.lowercased()

    var mayaSigner: Signer { Signer(id: maya, name: "Maya Lindqvist", email: "maya@example.com") }

    /* A file node whose metadata and current version `writer` signed (or nobody, for nil). */
    func file(signedBy writer: IdentityKeys?, as signer: Signer?, versionBy versionWriter: IdentityKeys? = nil) throws -> NodeView {
        let id = UUID().uuidString.lowercased()
        let versionId = UUID().uuidString.lowercased()
        let objectId = UUID().uuidString.lowercased()
        let metadata = try randomBytes(length: 64)
        let contentKey = try randomBytes(length: 84)
        var version = VersionView(id: versionId, objectId: objectId, contentKeyEnvelope: base64urlEncode(bytes: contentKey), status: "ready",
                                  contentSuite: 3, chunkCount: 1, contentNonce: "", plaintextSize: nil, ciphertextSize: nil, readyAt: nil)
        var node = NodeView(id: id, workspaceId: workspace, parentId: "p", kind: "file", keyEpoch: 1, parentKeyEpoch: 1, keyEnvelope: "",
                            metadataVersion: 3, metadataEnvelope: base64urlEncode(bytes: metadata), currentVersion: nil, trashedAt: nil,
                            changeSeq: 1, createdAt: nil, updatedAt: nil)
        if let writer {
            node.metadataSigner = signer
            node.metadataSignature = base64urlEncode(bytes: try metadataSign(
                signingSeed: writer.signingSeed, statement: MetadataStatement(workspaceId: workspace, nodeId: id, kind: .file, metadataVersion: 3), metadataEnvelope: metadata))
        }
        if let versionWriter = versionWriter ?? writer {
            version.signer = signer
            version.signature = base64urlEncode(bytes: try versionSign(
                signingSeed: versionWriter.signingSeed,
                statement: VersionStatement(workspaceId: workspace, nodeId: id, versionId: versionId, objectId: objectId, contentSuite: 3), contentKeyEnvelope: contentKey))
        }
        node = NodeView(id: node.id, workspaceId: node.workspaceId, parentId: node.parentId, kind: node.kind, keyEpoch: 1, parentKeyEpoch: 1, keyEnvelope: "",
                        metadataVersion: 3, metadataEnvelope: node.metadataEnvelope, currentVersion: version, trashedAt: nil, changeSeq: 1, createdAt: nil, updatedAt: nil,
                        metadataSigner: node.metadataSigner, metadataSignature: node.metadataSignature)
        return node
    }

    @Test func aCheckedContactsSignatureIsVerifiedAndAStrangersIsNot() throws {
        let mayaKeys = try makeIdentity(maya).keys
        let node = try file(signedBy: mayaKeys, as: mayaSigner)
        let trusting = TrustedSigners(userId: me, identities: [], pins: [try pinned(maya, mayaKeys)])
        #expect(trusting.provenance(of: node) == nil)
        // Nobody checked Maya: the same bytes are an unknown signer, named as the server names them.
        #expect(TrustedSigners().provenance(of: node) == .unknownSigner(mayaSigner))
    }

    @Test func aPinThatNeedsItsWordsCheckedAgainVouchesForNobody() throws {
        let mayaKeys = try makeIdentity(maya).keys
        var stale = try pinned(maya, mayaKeys)
        stale = ContactPin(userId: stale.userId, email: stale.email, name: stale.name, encryptionPublicKey: stale.encryptionPublicKey,
                           signingPublicKey: stale.signingPublicKey, fingerprint: "0000 0000 0000 0000 0000 0000 0000 0000 0000 0000",
                           pinnedAt: stale.pinnedAt, kemPublicKeyHash: nil)
        let trusted = TrustedSigners(userId: me, identities: [], pins: [stale])
        #expect(trusted.provenance(of: try file(signedBy: mayaKeys, as: mayaSigner)) == .unknownSigner(mayaSigner))
    }

    @Test func aRecordInACheckedContactsNameSignedByAnotherKeyIsABadSignature() throws {
        let mayaKeys = try makeIdentity(maya).keys
        let impostor = try makeIdentity(maya).keys
        let trusted = TrustedSigners(userId: me, identities: [], pins: [try pinned(maya, mayaKeys)])
        #expect(trusted.provenance(of: try file(signedBy: impostor, as: mayaSigner)) == .badSignature(mayaSigner))
        // Metadata fine, content key swapped in by someone else: the version's verdict is the worse one and wins.
        #expect(trusted.provenance(of: try file(signedBy: mayaKeys, as: mayaSigner, versionBy: impostor)) == .badSignature(mayaSigner))
    }

    @Test func aSignatureMovedToAnotherNodeOrEnvelopeDoesNotHold() throws {
        let mayaKeys = try makeIdentity(maya).keys
        let trusted = TrustedSigners(userId: me, identities: [], pins: [try pinned(maya, mayaKeys)])
        let a = try file(signedBy: mayaKeys, as: mayaSigner)
        let b = try file(signedBy: mayaKeys, as: mayaSigner)
        let swapped = NodeView(id: a.id, workspaceId: a.workspaceId, parentId: a.parentId, kind: a.kind, keyEpoch: 1, parentKeyEpoch: 1, keyEnvelope: "",
                               metadataVersion: 3, metadataEnvelope: b.metadataEnvelope, currentVersion: a.currentVersion, trashedAt: nil, changeSeq: 1,
                               createdAt: nil, updatedAt: nil, metadataSigner: mayaSigner, metadataSignature: a.metadataSignature)
        #expect(trusted.provenance(of: swapped) == .badSignature(mayaSigner))
        // A folder's name is never a file's: the kind is signed.
        let asFolder = NodeView(id: a.id, workspaceId: a.workspaceId, parentId: a.parentId, kind: "folder", keyEpoch: 1, parentKeyEpoch: 1, keyEnvelope: "",
                                metadataVersion: 3, metadataEnvelope: a.metadataEnvelope, currentVersion: nil, trashedAt: nil, changeSeq: 1,
                                createdAt: nil, updatedAt: nil, metadataSigner: mayaSigner, metadataSignature: a.metadataSignature)
        #expect(trusted.provenance(of: asFolder) == .badSignature(mayaSigner))
    }

    @Test func ownRecordsVerifyUnderEarlierIdentitiesAndUnsignedOnesSaySo() throws {
        let root = try randomBytes(length: 32)
        let old = try makeIdentity(me, root: root).keys
        let now = try makeIdentity(me, root: root, version: 2).keys
        let self_ = Signer(id: me.uppercased(), name: "Me", email: "me@example.com")
        let signedBefore = try file(signedBy: old, as: self_)
        #expect(TrustedSigners(userId: me, identities: [now, old], pins: []).provenance(of: signedBefore) == nil)
        // Without the earlier identity, the server's say-so that it was me is not enough.
        #expect(TrustedSigners(userId: me, identities: [now], pins: []).provenance(of: signedBefore) == .badSignature(self_))
        #expect(TrustedSigners(userId: me, identities: [now], pins: []).provenance(of: try file(signedBy: nil, as: nil)) == .unsigned)
    }

    @Test func aContactsEarlierKeyCountsOnlyWhenTheirChainVouchedForIt() throws {
        let before = try makeIdentity(maya).keys
        let after = try makeIdentity(maya, version: 2).keys
        var pin = try pinned(maya, after, keyVersion: 2)
        let node = try file(signedBy: before, as: mayaSigner)
        #expect(TrustedSigners(userId: me, identities: [], pins: [pin]).provenance(of: node) == .badSignature(mayaSigner))
        pin.previousSigningKeys = [before.signingPublicKey]
        #expect(TrustedSigners(userId: me, identities: [], pins: [pin]).provenance(of: node) == nil)
    }

    @Test func theExplanationNamesTheWriterAsTheServerDoes() {
        #expect(Provenance.unknownSigner(mayaSigner).explanation == "Added or last changed by Maya Lindqvist (maya@example.com), whom you haven’t checked yet.")
        #expect(Provenance.badSignature(mayaSigner).explanation == "The signature doesn’t match Maya Lindqvist’s keys. Don’t trust this item.")
        #expect(Provenance.unsigned.explanation == "Made before HushOS signed changes.")
    }
}

/*
 * A pinned person who replaced their keys: the pin follows only a chain their pinned keys
 * signed, link by link, to exactly the keys served; anything else is a changed key.
 */
struct SuccessionFollowTests {
    let maya = UUID().uuidString.lowercased()

    func link(from old: IdentityEnvelope, to succession: IdentitySuccession) -> SuccessionLink {
        SuccessionLink(
            oldKeyVersion: old.keyVersion, newKeyVersion: succession.identity.keyVersion,
            oldEncryptionPublicKey: old.encryptionPublicKey, oldSigningPublicKey: old.signingPublicKey,
            newEncryptionPublicKey: succession.identity.encryptionPublicKey, newSigningPublicKey: succession.identity.signingPublicKey,
            newKemPublicKey: succession.identity.kem?.publicKey ?? "", signature: succession.signature
        )
    }

    func served(_ envelope: IdentityEnvelope, kem: Bool = true) -> ServedContactKeys {
        ServedContactKeys(keyVersion: envelope.keyVersion, encryptionPublicKey: envelope.encryptionPublicKey,
                          signingPublicKey: envelope.signingPublicKey, kemPublicKey: kem ? envelope.kem?.publicKey : nil)
    }

    @Test func aChainThePinnedKeysSignedMovesThePinToTheServedKeys() throws {
        let first = try makeIdentity(maya)
        let second = try identitySucceed(userId: maya, accountKey: first.root, current: first.envelope)
        let third = try identitySucceed(userId: maya, accountKey: first.root, current: second.identity)
        let pin = try pinned(maya, first.keys)
        let links = [link(from: first.envelope, to: second), link(from: second.identity, to: third)]
        let now = Date(timeIntervalSince1970: 1_800_000_000)

        guard case .followed(let next) = pin.follow(served(third.identity), links: links, at: now) else {
            Issue.record("A valid chain was not followed")
            return
        }
        #expect(next.encryptionPublicKey == third.identity.encryptionPublicKey)
        #expect(next.signingPublicKey == third.identity.signingPublicKey)
        #expect(next.keyVersion == 3)
        #expect(next.verified, "the fingerprint is the v2 one over the new keys")
        #expect(next.kemPublicKeyHash == keyDigest(publicKey: try base64urlDecode(value: third.identity.kem!.publicKey)))
        #expect(next.previousSigningKeys == [first.envelope.signingPublicKey, second.identity.signingPublicKey])
        #expect(next.keysReplacedAt != nil && next.pinnedAt == pin.pinnedAt)
        // A share's granter carries no KEM key: the chain's last link names it, signed.
        #expect(pin.follow(served(third.identity, kem: false), links: links, at: now) == .followed(next))
        // Keys that didn't change are no succession.
        #expect(pin.follow(served(first.envelope), links: []) == .same)
    }

    @Test func aChainThatDoesNotHoldIsAChangedKey() throws {
        let first = try makeIdentity(maya)
        let second = try identitySucceed(userId: maya, accountKey: first.root, current: first.envelope)
        let pin = try pinned(maya, first.keys)
        let good = link(from: first.envelope, to: second)

        // Signed by anyone but the pinned key: a server minting keys of its own and vouching for them itself.
        let stranger = try makeIdentity(maya)
        let forged = try identitySucceed(userId: maya, accountKey: stranger.root, current: stranger.envelope)
        var spliced = link(from: first.envelope, to: forged)
        #expect(pin.follow(served(forged.identity), links: [spliced], at: Date()) == .changed)
        spliced = good
        spliced.signature = forged.signature
        #expect(pin.follow(served(second.identity), links: [spliced]) == .changed)

        // A valid chain that ends somewhere other than the served keys.
        #expect(pin.follow(served(stranger.envelope), links: [good]) == .changed)
        // No chain at all (a reset, not a succession).
        #expect(pin.follow(served(second.identity), links: []) == .changed)
        // Served at a version no higher than the pin's: nothing to follow.
        var ahead = pin
        ahead.keyVersion = 5
        #expect(ahead.follow(served(second.identity), links: [good]) == .changed)
        // A pin whose words were never checked over both keys follows nothing.
        let unverified = ContactPin(userId: pin.userId, email: pin.email, name: pin.name, encryptionPublicKey: pin.encryptionPublicKey,
                                    signingPublicKey: pin.signingPublicKey, fingerprint: "", pinnedAt: pin.pinnedAt, kemPublicKeyHash: nil)
        #expect(unverified.follow(served(second.identity), links: [good]) == .changed)
        // The chain is someone else's: the statement names the user.
        let other = ContactPin(userId: UUID().uuidString.lowercased(), email: pin.email, name: pin.name, encryptionPublicKey: pin.encryptionPublicKey,
                               signingPublicKey: pin.signingPublicKey, fingerprint: pin.fingerprint, pinnedAt: pin.pinnedAt, kemPublicKeyHash: nil)
        #expect(other.follow(served(second.identity), links: [good]) == .changed)
    }
}

/*
 * A suite 3 share opens only under a signature by the granter's pinned signing key, and with
 * whichever of this account's identities it was sealed to.
 */
struct SignedShareTests {
    let granter = UUID().uuidString.lowercased()
    let grantee = UUID().uuidString.lowercased()

    func context() -> ShareContext {
        ShareContext(workspaceId: UUID().uuidString.lowercased(), nodeId: UUID().uuidString.lowercased(), keyEpoch: 4, granteeUserId: grantee, granterUserId: granter)
    }

    func seal(_ nodeKey: Data, ctx: ShareContext, by granterKeys: IdentityKeys, to granteeKeys: IdentityKeys) throws -> Data {
        try shareSeal(ctx: ctx, nodeKey: nodeKey, granter: granterKeys, granteePublicKey: try base64urlDecode(value: granteeKeys.encryptionPublicKey),
                      granteeKemPublicKey: try base64urlDecode(value: granteeKeys.kemPublicKey!))
    }

    func pinnedGranter(_ keys: IdentityKeys...) throws -> PinnedGranter {
        PinnedGranter(encryptionPublicKey: try base64urlDecode(value: keys[0].encryptionPublicKey), signingPublicKeys: try keys.map { try base64urlDecode(value: $0.signingPublicKey) })
    }

    @Test func aShareNotSignedByThePinnedGranterDoesNotOpen() throws {
        let alice = try makeIdentity(granter).keys
        let bob = try makeIdentity(grantee).keys
        let mallory = try makeIdentity(granter).keys
        let nodeKey = try randomBytes(length: 32)
        let ctx = context()
        let envelope = try seal(nodeKey, ctx: ctx, by: alice, to: bob)
        #expect(envelope.count == 1256)
        #expect(try ShareOpener.open(envelope, ctx: ctx, granter: try pinnedGranter(alice), identities: [bob]) == nodeKey)
        // Sealed by someone holding a key in Alice's name, but not the one Bob checked: refused, nothing decapsulated.
        let forged = try seal(try randomBytes(length: 32), ctx: ctx, by: mallory, to: bob)
        #expect(throws: (any Error).self) { try ShareOpener.open(forged, ctx: ctx, granter: try pinnedGranter(alice), identities: [bob]) }
        // A signature lifted onto another node or epoch doesn't hold either.
        var moved = ctx
        moved.keyEpoch = 5
        #expect(throws: (any Error).self) { try ShareOpener.open(envelope, ctx: moved, granter: try pinnedGranter(alice), identities: [bob]) }
    }

    @Test func aShareSealedBeforeEitherSidesSuccessionStillOpens() throws {
        let alice = try makeIdentity(granter)
        let bob = try makeIdentity(grantee)
        let nodeKey = try randomBytes(length: 32)
        let ctx = context()
        let envelope = try seal(nodeKey, ctx: ctx, by: alice.keys, to: bob.keys)
        // Both replaced their keys since: Bob's pin of Alice moved on, and Bob holds a new identity.
        let aliceNext = try identityOpen(userId: granter, accountKey: alice.root, envelope: try identitySucceed(userId: granter, accountKey: alice.root, current: alice.envelope).identity)
        let bobNext = try identityOpen(userId: grantee, accountKey: bob.root, envelope: try identitySucceed(userId: grantee, accountKey: bob.root, current: bob.envelope).identity)
        // The earlier signing key the chain vouched for still opens what it signed, with Bob's earlier identity.
        #expect(try ShareOpener.open(envelope, ctx: ctx, granter: try pinnedGranter(aliceNext, alice.keys), identities: [bobNext, bob.keys]) == nodeKey)
        // Without either earlier key it stays shut.
        #expect(throws: (any Error).self) { try ShareOpener.open(envelope, ctx: ctx, granter: try pinnedGranter(aliceNext), identities: [bobNext, bob.keys]) }
        #expect(throws: (any Error).self) { try ShareOpener.open(envelope, ctx: ctx, granter: try pinnedGranter(aliceNext, alice.keys), identities: [bobNext]) }
    }
}

/*
 * Settings version 2: sealed under a settings key kept apart from the identity, so they
 * survive a succession, and carried to a new root by a master-key rotation.
 */
struct SettingsKeyTests {
    let user = UUID().uuidString.lowercased()

    @Test func settingsRoundTripUnderTheSettingsKeyAndSurviveARotation() throws {
        let root = try randomBytes(length: 32)
        let made = try settingsKeyCreate(userId: user, accountKey: root)
        var settings = Settings(version: 4)
        let maya = try makeIdentity(UUID().uuidString.lowercased()).keys
        var pin = try pinned(UUID().uuidString.lowercased(), maya, keyVersion: 3)
        pin.previousSigningKeys = ["earlier"]
        pin.keysReplacedAt = "2026-10-12T00:00:00Z"
        settings.setPin(pin)
        settings.ledger.addShare(node: "node-a", grantee: pin.userId)

        let sealed = try settingsSeal(userId: user, settingsKey: made.key, settingsVersion: 5, json: try settings.json())
        #expect(sealed.version == 2 && sealed.settingsVersion == 5)
        let reopened = try Settings(json: try settingsOpen(userId: user, settingsKey: made.key, identityPrivateKey: nil, envelope: sealed), version: 5)
        #expect(reopened.contacts[pin.userId] == pin)
        #expect(reopened.ledger.holdsShare(node: "node-a", grantee: pin.userId))

        // The identity's key opens nothing of version 2, and another account's id doesn't either.
        #expect(throws: (any Error).self) { try settingsOpen(userId: user, settingsKey: nil, identityPrivateKey: maya.encryptionPrivateKey, envelope: sealed) }
        #expect(throws: (any Error).self) { try settingsOpen(userId: UUID().uuidString.lowercased(), settingsKey: made.key, identityPrivateKey: nil, envelope: sealed) }

        // A master-key rotation rewraps the settings key: the new root opens the same key, the old one no longer opens the new envelope.
        let newRoot = try randomBytes(length: 32)
        let rewrapped = try settingsKeyRewrap(userId: user, oldRoot: root, newRoot: newRoot, envelope: made.envelope)
        #expect(try settingsKeyOpen(userId: user, accountKey: newRoot, envelope: rewrapped) == made.key)
        #expect(throws: (any Error).self) { try settingsKeyOpen(userId: user, accountKey: root, envelope: rewrapped) }
    }
}
