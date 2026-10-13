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
 * someone checked (or itself) under their current key, and never verified for a record
 * someone else could have made, re-locked, or signed with keys since replaced.
 */
struct IntegrityDecisionTests {
    let workspace = UUID().uuidString.lowercased()
    let me = UUID().uuidString.lowercased()
    let maya = UUID().uuidString.lowercased()

    var mayaSigner: Signer { Signer(id: maya) }

    /* A file node whose metadata and current version `writer` signed (or nobody, for nil); `resealed` signs the re-sealed statement. */
    func file(signedBy writer: IdentityKeys?, as signer: Signer?, versionBy versionWriter: IdentityKeys? = nil, resealed: Bool = false) throws -> NodeView {
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
        let metadataStatement = MetadataStatement(workspaceId: workspace, nodeId: id, kind: .file, metadataVersion: 3)
        let versionStatement = VersionStatement(workspaceId: workspace, nodeId: id, versionId: versionId, objectId: objectId, contentSuite: 3)
        if let writer {
            node.metadataSigner = signer
            node.metadataSignature = base64urlEncode(bytes: resealed
                ? try metadataResealedSign(signingSeed: writer.signingSeed, statement: metadataStatement, metadataEnvelope: metadata)
                : try metadataSign(signingSeed: writer.signingSeed, statement: metadataStatement, metadataEnvelope: metadata))
        }
        if let versionWriter = versionWriter ?? writer {
            version.signer = signer
            version.signature = base64urlEncode(bytes: resealed
                ? try versionResealedSign(signingSeed: versionWriter.signingSeed, statement: versionStatement, contentKeyEnvelope: contentKey)
                : try versionSign(signingSeed: versionWriter.signingSeed, statement: versionStatement, contentKeyEnvelope: contentKey))
        }
        return NodeView(id: node.id, workspaceId: node.workspaceId, parentId: node.parentId, kind: node.kind, keyEpoch: 1, parentKeyEpoch: 1, keyEnvelope: "",
                        metadataVersion: 3, metadataEnvelope: node.metadataEnvelope, currentVersion: version, trashedAt: nil, changeSeq: 1, createdAt: nil, updatedAt: nil,
                        metadataSigner: node.metadataSigner, metadataSignature: node.metadataSignature)
    }

    @Test func aCheckedContactsSignatureIsVerifiedAndAStrangersIsNot() throws {
        let mayaKeys = try makeIdentity(maya).keys
        let node = try file(signedBy: mayaKeys, as: mayaSigner)
        let trusting = try TrustedSigners(userId: me, identities: [], pins: [try pinned(maya, mayaKeys)])
        #expect(trusting.provenance(of: node) == nil)
        // Nobody checked Maya: the same bytes are an unknown signer, and nothing names her.
        #expect(TrustedSigners().provenance(of: node) == .unknownSigner(signerId: maya))
        #expect(TrustedSigners().writer(mayaSigner) == .unchecked)
    }

    @Test func aPinThatNeedsItsWordsCheckedAgainVouchesForNobodyAndNamesNobody() throws {
        let mayaKeys = try makeIdentity(maya).keys
        let pin = try pinned(maya, mayaKeys)
        let stale = ContactPin(userId: pin.userId, email: pin.email, name: pin.name, encryptionPublicKey: pin.encryptionPublicKey,
                               signingPublicKey: pin.signingPublicKey, fingerprint: "0000 0000 0000 0000 0000 0000 0000 0000 0000 0000",
                               pinnedAt: pin.pinnedAt, kemPublicKeyHash: nil)
        let trusted = try TrustedSigners(userId: me, identities: [], pins: [stale])
        #expect(trusted.provenance(of: try file(signedBy: mayaKeys, as: mayaSigner)) == .unknownSigner(signerId: maya))
        #expect(trusted.writer(mayaSigner) == .unchecked)
    }

    @Test func aRecordInACheckedContactsNameSignedByAnotherKeyIsABadSignature() throws {
        let mayaKeys = try makeIdentity(maya).keys
        let impostor = try makeIdentity(maya).keys
        let trusted = try TrustedSigners(userId: me, identities: [], pins: [try pinned(maya, mayaKeys)])
        #expect(trusted.provenance(of: try file(signedBy: impostor, as: mayaSigner)) == .badSignature(.contact("Maya")))
        // Metadata fine, content key swapped in by someone else: the version's verdict is the worse one and wins.
        #expect(trusted.provenance(of: try file(signedBy: mayaKeys, as: mayaSigner, versionBy: impostor)) == .badSignature(.contact("Maya")))
    }

    @Test func aSignatureMovedToAnotherNodeOrEnvelopeDoesNotHold() throws {
        let mayaKeys = try makeIdentity(maya).keys
        let trusted = try TrustedSigners(userId: me, identities: [], pins: [try pinned(maya, mayaKeys)])
        let a = try file(signedBy: mayaKeys, as: mayaSigner)
        let b = try file(signedBy: mayaKeys, as: mayaSigner)
        let swapped = NodeView(id: a.id, workspaceId: a.workspaceId, parentId: a.parentId, kind: a.kind, keyEpoch: 1, parentKeyEpoch: 1, keyEnvelope: "",
                               metadataVersion: 3, metadataEnvelope: b.metadataEnvelope, currentVersion: a.currentVersion, trashedAt: nil, changeSeq: 1,
                               createdAt: nil, updatedAt: nil, metadataSigner: mayaSigner, metadataSignature: a.metadataSignature)
        #expect(trusted.provenance(of: swapped) == .badSignature(.contact("Maya")))
        // A folder's name is never a file's: the kind is signed.
        let asFolder = NodeView(id: a.id, workspaceId: a.workspaceId, parentId: a.parentId, kind: "folder", keyEpoch: 1, parentKeyEpoch: 1, keyEnvelope: "",
                                metadataVersion: 3, metadataEnvelope: a.metadataEnvelope, currentVersion: nil, trashedAt: nil, changeSeq: 1,
                                createdAt: nil, updatedAt: nil, metadataSigner: mayaSigner, metadataSignature: a.metadataSignature)
        #expect(trusted.provenance(of: asFolder) == .badSignature(.contact("Maya")))
    }

    @Test func ownRecordsUnderAnEarlierIdentityAreRetiredNeverVerified() throws {
        let root = try randomBytes(length: 32)
        let old = try makeIdentity(me, root: root).keys
        let now = try makeIdentity(me, root: root, version: 2).keys
        let self_ = Signer(id: me.uppercased())
        let signedBefore = try file(signedBy: old, as: self_)
        // Keys replaced because they may have been exposed vouch for nothing: retired, said in this person's own words.
        #expect(try TrustedSigners(userId: me, identities: [now, old], pins: []).provenance(of: signedBefore) == .retiredKey(.you))
        #expect(try TrustedSigners(userId: me, identities: [now, old], pins: []).provenance(of: try file(signedBy: now, as: self_)) == nil)
        // Without the earlier identity, the server's say-so that it was me is not enough.
        #expect(try TrustedSigners(userId: me, identities: [now], pins: []).provenance(of: signedBefore) == .badSignature(.you))
        #expect(try TrustedSigners(userId: me, identities: [now], pins: []).provenance(of: try file(signedBy: nil, as: nil)) == .unsigned)
    }

    @Test func aContactsEarlierKeyIsRetiredOnlyWhenTheirChainVouchedForIt() throws {
        let before = try makeIdentity(maya).keys
        let after = try makeIdentity(maya, version: 2).keys
        var pin = try pinned(maya, after, keyVersion: 2)
        let node = try file(signedBy: before, as: mayaSigner)
        #expect(try TrustedSigners(userId: me, identities: [], pins: [pin]).provenance(of: node) == .badSignature(.contact("Maya")))
        pin.previousSigningKeys = [before.signingPublicKey]
        #expect(try TrustedSigners(userId: me, identities: [], pins: [pin]).provenance(of: node) == .retiredKey(.contact("Maya")))
    }

    @Test func aReLockedRecordIsNeverVerifiedAndNamesWhoReLockedIt() throws {
        let mine = try makeIdentity(me).keys
        let mayaKeys = try makeIdentity(maya).keys
        let trusted = try TrustedSigners(userId: me, identities: [mine], pins: [try pinned(maya, mayaKeys)])
        #expect(trusted.provenance(of: try file(signedBy: mine, as: Signer(id: me), resealed: true)) == .resealed(.you))
        #expect(trusted.provenance(of: try file(signedBy: mayaKeys, as: mayaSigner, resealed: true)) == .resealed(.contact("Maya")))
        // Re-sealed by a stranger is still just a stranger.
        #expect(TrustedSigners().provenance(of: try file(signedBy: mayaKeys, as: mayaSigner, resealed: true)) == .unknownSigner(signerId: maya))
    }

    @Test func aTrustSetWithAKeyThatDoesNotReadIsRefusedWhole() throws {
        let mayaKeys = try makeIdentity(maya).keys
        var pin = try pinned(maya, mayaKeys)
        pin.previousSigningKeys = ["not a key"]
        // Checking against the rest would pass records off against a partial set: nothing is checked instead.
        #expect(throws: SignersError.unreadableKey) { try TrustedSigners(userId: me, identities: [], pins: [pin]) }
    }

    @Test func aStrippedSignatureReadsLikeAnyOtherUnconfirmedRecord() {
        // A server stripping a signature must not get a milder warning than a stranger's signature.
        let unsigned = Provenance.unsigned.explanation
        #expect(unsigned == "HushOS can’t confirm who wrote this.")
        #expect(Provenance.unknownSigner(signerId: maya).explanation.hasPrefix(unsigned.dropLast()))
        #expect(!Provenance.unknownSigner(signerId: maya).explanation.contains(maya))
        #expect(Provenance.resealed(.you).explanation == "Re-locked by you; HushOS couldn’t confirm who wrote it before.")
        #expect(Provenance.retiredKey(.contact("Maya")).explanation == "Signed with keys Maya has since replaced.")
        #expect(Provenance.unchecked.explanation == "HushOS couldn’t check who wrote this. Try again later.")
    }
}

/*
 * Failing closed: when whom to trust can't load, or a check can't run, every record is marked
 * "Couldn't check", never left unmarked as if it were clean.
 */
struct FailClosedTests {
    let me = UUID().uuidString.lowercased()

    func signedFolder(by keys: IdentityKeys?, workspace: String = UUID().uuidString.lowercased(), envelope: Data? = nil) throws -> NodeView {
        let id = UUID().uuidString.lowercased()
        let metadata = try envelope ?? randomBytes(length: 64)
        var node = NodeView(id: id, workspaceId: workspace, parentId: "p", kind: "folder", keyEpoch: 1, parentKeyEpoch: 1, keyEnvelope: "",
                            metadataVersion: 1, metadataEnvelope: base64urlEncode(bytes: metadata), currentVersion: nil, trashedAt: nil,
                            changeSeq: 1, createdAt: nil, updatedAt: nil)
        if let keys {
            node.metadataSigner = Signer(id: me)
            node.metadataSignature = base64urlEncode(bytes: try metadataSign(
                signingSeed: keys.signingSeed, statement: MetadataStatement(workspaceId: workspace, nodeId: id, kind: .folder, metadataVersion: 1), metadataEnvelope: metadata))
        }
        return node
    }

    @Test func aTrustLoadThatThrowsMarksEveryRecordCouldNotCheck() async throws {
        let mine = try makeIdentity(me).keys
        let clean = try signedFolder(by: mine)
        let unsigned = try signedFolder(by: nil)
        struct Offline: Error {}
        let failed = await TrustState.load { throw Offline() }
        guard case .failed = failed else { Issue.record("A throwing load was taken as loaded"); return }
        var cache = VerdictCache()
        #expect(cache.provenance(of: clean, under: failed) == .unchecked)
        #expect(cache.provenance(of: unsigned, under: failed) == .unchecked)
        // Loaded, the same record is clean: the mark above came from the failure, not the record.
        let loaded = await TrustState.load { [me] in try TrustedSigners(userId: me, identities: [mine], pins: []) }
        #expect(cache.provenance(of: clean, under: loaded) == nil)
        #expect(cache.provenance(of: unsigned, under: loaded) == .unsigned)
    }

    @Test func theVerdictCacheChecksAgainWhenAnEnvelopeChanges() throws {
        let mine = try makeIdentity(me).keys
        let signers = try TrustedSigners(userId: me, identities: [mine], pins: [])
        let node = try signedFolder(by: mine)
        var cache = VerdictCache()
        #expect(cache.provenance(of: node, under: .loaded(signers)) == nil)
        // The server swaps the sealed metadata under the same signature, versions and ids: the cached "clean" must not stand.
        let swapped = NodeView(id: node.id, workspaceId: node.workspaceId, parentId: node.parentId, kind: node.kind, keyEpoch: 1, parentKeyEpoch: 1, keyEnvelope: "",
                               metadataVersion: node.metadataVersion, metadataEnvelope: base64urlEncode(bytes: try randomBytes(length: 64)), currentVersion: nil,
                               trashedAt: nil, changeSeq: 1, createdAt: nil, updatedAt: nil, metadataSigner: node.metadataSigner, metadataSignature: node.metadataSignature)
        #expect(cache.provenance(of: swapped, under: .loaded(signers)) == .badSignature(.you))
    }

    @Test func theVerdictCacheChecksAgainWhenAContentKeyEnvelopeChanges() throws {
        let mine = try makeIdentity(me).keys
        let signers = try TrustedSigners(userId: me, identities: [mine], pins: [])
        let workspace = UUID().uuidString.lowercased()
        let id = UUID().uuidString.lowercased()
        let envelope = try randomBytes(length: 84)
        func file(contentKeyEnvelope: Data) throws -> NodeView {
            let statement = VersionStatement(workspaceId: workspace, nodeId: id, versionId: "v1", objectId: "o1", contentSuite: 3)
            var version = VersionView(id: "v1", objectId: "o1", contentKeyEnvelope: base64urlEncode(bytes: contentKeyEnvelope), status: "ready", contentSuite: 3,
                                      chunkCount: 1, contentNonce: "", plaintextSize: nil, ciphertextSize: nil, readyAt: nil)
            version.signer = Signer(id: me)
            version.signature = base64urlEncode(bytes: try versionSign(signingSeed: mine.signingSeed, statement: statement, contentKeyEnvelope: envelope))
            let metadata = try randomBytes(length: 32)
            return NodeView(id: id, workspaceId: workspace, parentId: "p", kind: "file", keyEpoch: 1, parentKeyEpoch: 1, keyEnvelope: "", metadataVersion: 1,
                            metadataEnvelope: base64urlEncode(bytes: metadata), currentVersion: version, trashedAt: nil, changeSeq: 1, createdAt: nil, updatedAt: nil,
                            metadataSigner: Signer(id: me),
                            metadataSignature: base64urlEncode(bytes: try metadataSign(signingSeed: mine.signingSeed,
                                                                                         statement: MetadataStatement(workspaceId: workspace, nodeId: id, kind: .file, metadataVersion: 1),
                                                                                         metadataEnvelope: metadata)))
        }
        var cache = VerdictCache()
        let honest = try file(contentKeyEnvelope: envelope)
        #expect(cache.provenance(of: honest, under: .loaded(signers)) == nil)
        // Same node, metadata and signatures; only the content key's envelope swapped (and the metadata re-signed alike).
        var swapped = try file(contentKeyEnvelope: try randomBytes(length: 84))
        swapped = NodeView(id: id, workspaceId: workspace, parentId: "p", kind: "file", keyEpoch: 1, parentKeyEpoch: 1, keyEnvelope: "", metadataVersion: 1,
                           metadataEnvelope: honest.metadataEnvelope, currentVersion: swapped.currentVersion, trashedAt: nil, changeSeq: 1, createdAt: nil, updatedAt: nil,
                           metadataSigner: honest.metadataSigner, metadataSignature: honest.metadataSignature)
        #expect(cache.provenance(of: swapped, under: .loaded(signers)) == .badSignature(.you))
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
 * A suite 3 share opens only under a signature by the granter's current pinned signing key,
 * and with whichever of this account's identities it was sealed to. A key the granter has
 * since replaced opens nothing: the share waits for their re-seal.
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

    func pinnedGranter(_ keys: IdentityKeys, replaced: Bool = false) throws -> PinnedGranter {
        PinnedGranter(signingPublicKey: try base64urlDecode(value: keys.signingPublicKey), replacedKeys: replaced, name: "Alice")
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

    @Test func aShareSignedWithKeysTheGranterReplacedWaitsForTheirReseal() throws {
        let alice = try makeIdentity(granter)
        let bob = try makeIdentity(grantee)
        let nodeKey = try randomBytes(length: 32)
        let ctx = context()
        let envelope = try seal(nodeKey, ctx: ctx, by: alice.keys, to: bob.keys)
        // Alice replaced her keys and Bob's pin followed: her earlier key no longer opens anything, and Bob is told to ask her.
        let aliceNext = try identityOpen(userId: granter, accountKey: alice.root, envelope: try identitySucceed(userId: granter, accountKey: alice.root, current: alice.envelope).identity)
        #expect(throws: GranterTrust.reseal(name: "Alice")) {
            try ShareOpener.open(envelope, ctx: ctx, granter: try pinnedGranter(aliceNext, replaced: true), identities: [bob.keys])
        }
        // Once she seals it again under her current key, it opens.
        let resealed = try seal(nodeKey, ctx: ctx, by: aliceNext, to: bob.keys)
        #expect(try ShareOpener.open(resealed, ctx: ctx, granter: try pinnedGranter(aliceNext, replaced: true), identities: [bob.keys]) == nodeKey)
    }

    @Test func aShareSealedBeforeTheGranteesOwnSuccessionStillOpens() throws {
        let alice = try makeIdentity(granter)
        let bob = try makeIdentity(grantee)
        let nodeKey = try randomBytes(length: 32)
        let ctx = context()
        let envelope = try seal(nodeKey, ctx: ctx, by: alice.keys, to: bob.keys)
        let bobNext = try identityOpen(userId: grantee, accountKey: bob.root, envelope: try identitySucceed(userId: grantee, accountKey: bob.root, current: bob.envelope).identity)
        #expect(try ShareOpener.open(envelope, ctx: ctx, granter: try pinnedGranter(alice.keys), identities: [bobNext, bob.keys]) == nodeKey)
        #expect(throws: (any Error).self) { try ShareOpener.open(envelope, ctx: ctx, granter: try pinnedGranter(alice.keys), identities: [bobNext]) }
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
        let reopened = try Settings.opened(userId: user, envelope: sealed, settingsKey: made.key)
        #expect(reopened.contacts[pin.userId] == pin)
        #expect(reopened.ledger.holdsShare(node: "node-a", grantee: pin.userId))

        // Version 2 needs its key, and another account's id doesn't open it: refused, never read as empty settings.
        #expect(throws: (any Error).self) { try Settings.opened(userId: user, envelope: sealed, settingsKey: nil) }
        #expect(throws: (any Error).self) { try Settings.opened(userId: user, envelope: sealed, settingsKey: try randomBytes(length: 32)) }
        #expect(throws: (any Error).self) { try Settings.opened(userId: UUID().uuidString.lowercased(), envelope: sealed, settingsKey: made.key) }

        // A master-key rotation rewraps the settings key: the new root opens the same key, the old one no longer opens the new envelope.
        let newRoot = try randomBytes(length: 32)
        let rewrapped = try settingsKeyRewrap(userId: user, oldRoot: root, newRoot: newRoot, envelope: made.envelope)
        #expect(try settingsKeyOpen(userId: user, accountKey: newRoot, envelope: rewrapped) == made.key)
        #expect(throws: (any Error).self) { try settingsKeyOpen(userId: user, accountKey: root, envelope: rewrapped) }
    }

    @Test func aVersionOneDocumentReadsAsEmptyAndIsWrittenOverAsVersionTwo() throws {
        // Sealed under the identity, which a stolen identity key reproduces: never opened, whatever it holds.
        let v1 = SettingsEnvelope(version: 1, settingsVersion: 4, nonce: base64urlEncode(bytes: try randomBytes(length: 24)),
                                  ciphertext: base64urlEncode(bytes: Data((0..<1040).map { _ in UInt8.random(in: 0...255) })))
        let settings = try Settings.opened(userId: user, envelope: v1, settingsKey: nil)
        #expect(settings.contacts.isEmpty && settings.ledger == SharingLedger())
        #expect(settings.version == 4 && settings.envelopeVersion == 1)
        // The next save goes one version up from what the server holds, sealed as version 2.
        let made = try settingsKeyCreate(userId: user, accountKey: try randomBytes(length: 32))
        let next = try settingsSeal(userId: user, settingsKey: made.key, settingsVersion: settings.version + 1, json: try settings.json())
        #expect(next.version == 2 && next.settingsVersion == 5)
        #expect(try Settings.opened(userId: user, envelope: next, settingsKey: made.key).envelopeVersion == 2)
    }
}

extension OnFakeDrive {
    /* The vault's own trust set, when the settings with the pins can't be read: no set at all, so nothing reads as checked. */
    @Suite struct TrustLoadTests {
        @Test func aVaultThatCannotLoadItsSettingsGivesNoTrustSet() async throws {
            let me = UUID().uuidString.lowercased()
            let session = SharedKeychain.Session(origin: "https://unreachable.test", token: "t", userId: me)
            FakeDrive.current = nil
            Auth.testSession = session
            Auth.testTransport = FakeDrive.configuration
            defer { Auth.testSession = nil; Auth.testTransport = nil }
            let vault = Vault(api: DriveAPI(session: session, configuration: FakeDrive.configuration), session: session)
            let mine = try makeIdentity(me).keys
            await vault.adopt(identity: mine)
            let state = await TrustState.load { try await vault.signers() }
            guard case .failed = state else { Issue.record("Signers loaded without settings"); return }
            // A record this person signed themselves still reads "Couldn't check": the failure decides, not the record.
            let node = try FailClosedTests().signedFolder(by: mine)
            var cache = VerdictCache()
            #expect(cache.provenance(of: node, under: state) == .unchecked)
        }
    }
}
