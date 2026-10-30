import Foundation
import HushOSCore

extension Auth {
    /* The account's earlier identities, oldest first, still sealed under the account key. */
    static func identityHistory(as owner: SharedKeychain.Session? = nil) async throws -> [IdentityEnvelope] {
        let reply = try await call("/api/auth/identity/history", as: owner)
        return (reply["identities"] as? [[String: Any]] ?? []).map { identityEnvelope(from: $0) }
    }

    /*
     * Replaces a version 1 identity by its version 2 form (the same keys, plus ML-DSA and the
     * keys statement) and returns what the server stored; 409 (`AuthError.conflict`) when
     * another device upgraded first.
     */
    static func upgradeIdentity(_ identity: IdentityEnvelope, as owner: SharedKeychain.Session? = nil) async throws -> IdentityEnvelope {
        let reply = try await call("/api/auth/identity/upgrade", method: "POST", body: ["identity": json(identity)], as: owner)
        guard let stored = reply["identity"] as? [String: Any] else { throw AuthError.message("HushOS returned no identity.") }
        return identityEnvelope(from: stored)
    }

    /* Installs a successor identity the current signing key vouched for; 409 when another device moved first. */
    static func succeedIdentity(_ succession: IdentitySuccession, as owner: SharedKeychain.Session? = nil) async throws {
        _ = try await call("/api/auth/identity/succession", method: "POST", body: [
            "identity": json(succession.identity), "signature": succession.signature,
        ], as: owner)
    }

    /*
     * A contact's whole succession chain, from their first identity to the current one. Always
     * the whole chain: asking from the pinned version would tell the server which version this
     * person pinned. The checker finds where the pin's keys join it.
     */
    static func succession(of userId: String, as owner: SharedKeychain.Session? = nil) async throws -> [SuccessionLink] {
        let reply = try await call("/api/auth/contacts/\(userId.lowercased())/succession?from=1", as: owner)
        return (reply["links"] as? [[String: Any]] ?? []).map { link in
            SuccessionLink(
                oldKeyVersion: (link["oldKeyVersion"] as? NSNumber)?.uint64Value ?? 0,
                newKeyVersion: (link["newKeyVersion"] as? NSNumber)?.uint64Value ?? 0,
                oldEncryptionPublicKey: link["oldEncryptionPublicKey"] as? String ?? "",
                oldSigningPublicKey: link["oldSigningPublicKey"] as? String ?? "",
                oldMlDsaPublicKey: link["oldMlDsaPublicKey"] as? String ?? "",
                newEncryptionPublicKey: link["newEncryptionPublicKey"] as? String ?? "",
                newSigningPublicKey: link["newSigningPublicKey"] as? String ?? "",
                newMlDsaPublicKey: link["newMlDsaPublicKey"] as? String ?? "",
                newKemPublicKey: link["newKemPublicKey"] as? String ?? "",
                signature: link["signature"] as? String ?? ""
            )
        }
    }
}

/*
 * How a write signs an envelope it sealed. Content this person wrote is their own. A record
 * sealed again in place (rotation, rename, a replacement's name) or copied is signed only
 * after it was checked as it was: ordinary when it verified, saved when it verified as saved
 * from a link, re-sealed otherwise, and refused when the check could not run. A copy saved
 * from a link is signed with the saved statement whatever it was: a visitor sees no
 * signatures, so it says where the copy came from and vouches for nothing more.
 */
public enum Signing: Sendable, Equatable {
    case own
    /* Sealed again in place; the record's verdict as it was. */
    case after(Integrity)
    /* A copy (in this drive, into another, or out of someone's share); the original's verdict. */
    case copy(Integrity)
    /* Saved from a link, and the folders such a save makes. */
    case savedFromLink
}

/*
 * The identity beyond opening it: the earlier ones a succession left (shares sealed to
 * them open only with them, and what they signed is still this account's), signing what
 * this account writes, the keys a reader trusts, and replacing the identity.
 */
extension Vault {
    /*
     * Every identity this account holds: the current one first, then the earlier ones, newest
     * first. The history read beside an identity forgotten meanwhile (a succession here, or
     * noticed from another device) may be the one before it: read both again rather than keep it.
     */
    func allIdentities() async throws -> [IdentityKeys] {
        while true {
            let generation = identityGeneration
            let current = try await identityKeys()
            if let earlierIdentities { return [current] + earlierIdentities }
            let accountKey = try unlockAccount()
            var earlier: [IdentityKeys] = []
            for envelope in try await Auth.identityHistory(as: session) {
                // Opening proves each is this account's own (sealed under its root, its keys matching), not one the server added.
                earlier.append(try identityOpen(userId: session.userId, accountKey: accountKey, envelope: envelope))
            }
            // A settings mark an earlier version kept under any of these keys becomes the account's, so a
            // device that saw version 7 before a succession still refuses 6 (identityKeys covers the current key).
            try await RollbackMarkStore.shared(session: session.token).adopt(userId: session.userId, encryptionPublicKeys: earlier.map(\.encryptionPublicKey), keys: marksKeys())
            guard generation == identityGeneration else { continue }
            earlier.sort { $0.keyVersion > $1.keyVersion }
            earlierIdentities = earlier
            return [current] + earlier
        }
    }

    /*
     * The signing seed of the identity in use: every write that sets a metadata or content-key
     * envelope is signed with it. The server checks against the account's current key, so an
     * identity another device replaced meanwhile is noticed (asked at most every few minutes)
     * and opened afresh, rather than every write failing until the app restarts. Any public
     * key, either version or the keys statement differing is another identity. One served
     * with a lower key version than the one in use is not taken: `identityKeys` refuses it.
     */
    private func signingSeed() async throws -> Data {
        if identity != nil, identityCheckedAt.map({ Date().timeIntervalSince($0) > 300 }) ?? true,
           let served = try? await Auth.identity(as: session) {
            identityCheckedAt = Date()
            if identityEnvelope.map({ !served.servesSameIdentity(as: $0) }) ?? true { forgetIdentity() }
        }
        do {
            return try await identityKeys().signingSeed
        } catch let error as DriveAPIError {
            throw error
        } catch AuthError.message(let text) where [IdentityMarks.downgraded, MarksWords.unreadable, MarksWords.unsaved].contains(text) {
            throw DriveAPIError.server(400, text)
        } catch {
            // Without the identity the server would refuse the write; say so rather than send it unsigned.
            throw DriveAPIError.server(400, "Your keys couldn’t be opened to sign this change. Try again.")
        }
    }

    /* `metadataSignature` for a metadata envelope at `version` (the version the server will store). */
    func signMetadata(workspaceId: String, nodeId: String, kind: NodeKind, version: UInt64, envelope: Data, signing: Signing = .own) async throws -> String {
        let statement = MetadataStatement(workspaceId: workspaceId, nodeId: nodeId, kind: kind, metadataVersion: version)
        let seed = try await signingSeed()
        let signature: Data
        switch signing {
        case .own: signature = try metadataSign(signingSeed: seed, statement: statement, metadataEnvelope: envelope)
        case .after(let prior): signature = try metadataResealSign(signingSeed: seed, prior: prior, statement: statement, metadataEnvelope: envelope)
        case .copy(let prior): signature = try metadataCopySign(signingSeed: seed, prior: prior, fromLink: false, statement: statement, metadataEnvelope: envelope)
        case .savedFromLink: signature = try metadataCopySign(signingSeed: seed, prior: .unchecked, fromLink: true, statement: statement, metadataEnvelope: envelope)
        }
        return base64urlEncode(bytes: signature)
    }

    /* `versionSignature` for a content-key envelope where it lands: the node and version it is stored as. */
    func signVersion(workspaceId: String, nodeId: String, versionId: String, objectId: String, suite: UInt32, envelope: Data, signing: Signing = .own) async throws -> String {
        let statement = VersionStatement(workspaceId: workspaceId, nodeId: nodeId, versionId: versionId, objectId: objectId, contentSuite: suite)
        let seed = try await signingSeed()
        let signature: Data
        switch signing {
        case .own: signature = try versionSign(signingSeed: seed, statement: statement, contentKeyEnvelope: envelope)
        case .after(let prior): signature = try versionResealSign(signingSeed: seed, prior: prior, statement: statement, contentKeyEnvelope: envelope)
        case .copy(let prior): signature = try versionCopySign(signingSeed: seed, prior: prior, fromLink: false, statement: statement, contentKeyEnvelope: envelope)
        case .savedFromLink: signature = try versionCopySign(signingSeed: seed, prior: .unchecked, fromLink: true, statement: statement, contentKeyEnvelope: envelope)
        }
        return base64urlEncode(bytes: signature)
    }

    /*
     * Whose signatures count: this account's own identities (the current key, and the earlier
     * ones as retired), and every verified pin's signing key with the earlier ones its
     * succession chain vouched for as retired. Kept until the pins or the identity change.
     * Throws when any part can't load (the history, the settings, settings refused as rolled
     * back, a key that doesn't read): the caller marks everything "Couldn't check", and a
     * rotation or copy stops rather than re-sign blind.
     */
    public func signers() async throws -> TrustedSigners {
        while true {
            if let trustedSigners { return trustedSigners }
            let generation = signersGeneration
            // Every pin as this phone's guard allows (2.8): read under the guard's turn, acts left pending settled first.
            let trusted = try TrustedSigners(userId: session.userId, identities: try await allIdentities(), pins: try await effectivePins())
            // Forgotten while it loaded (a succession, a pin saved): built from what that replaced, so built again.
            guard generation == signersGeneration else { continue }
            trustedSigners = trusted
            return trusted
        }
    }

    /* Forgets the trusted keys, so the next read builds them again (a pin added elsewhere, say), and a build under way isn't kept. */
    public func forgetSigners() {
        signersGeneration &+= 1
        trustedSigners = nil
    }

    /* Tests: whom to trust, without the network. */
    func adopt(signers: TrustedSigners) { trustedSigners = signers }

    // MARK: - Replacing the identity

    /*
     * Replaces this account's sharing keys with a successor vouched for by the current
     * signing key (docs/integrity-design.md, "Identity succession"): people who checked the
     * old keys follow the chain instead of comparing words from scratch. The old identity
     * stays openable through the history, so shares sealed to it still open; every share
     * the ledger holds is sealed again in suite 4 under the new signing keys.
     */
    public func replaceSharingKeys() async throws -> RotationOutcome {
        // Settings sealed under the identity (version 1) would be stranded with it: sealed under the settings key first.
        try await ensureSettingsKeyed()
        // Opened (and upgraded to version 2, which a succession needs) before the served one is read back.
        let opened = try await identityKeys()
        let current = try await Auth.identity(as: session)
        // Signed over exactly the identity opened: all four keys, the key version and the identity version.
        guard opened.encryptionPublicKey == current.encryptionPublicKey, opened.signingPublicKey == current.signingPublicKey,
              opened.mlDsaPublicKey == current.mlDsa?.publicKey, opened.kemPublicKey == current.kem?.publicKey,
              opened.keyVersion == current.keyVersion, opened.identityVersion == current.version else {
            forgetIdentity()
            throw AuthError.message("Your keys changed on another device. Try again.")
        }
        let succession = try identitySucceed(userId: session.userId, accountKey: try unlockAccount(), current: current)
        try await Auth.succeedIdentity(succession, as: session)
        // From here the keys are replaced: what is left is re-sealing, which the next Drive open finishes if this one can't.
        ResealPending.set(for: succession.identity.signingPublicKey)
        forgetIdentity()
        _ = try await allIdentities()
        return try await upgradeShares()
    }

    /*
     * The upgrade pass, run when Drive opens, after a words check and right after a succession:
     * every share the ledger holds in an older suite is sealed again in suite 4 (once a version
     * 3 pin vouches for the grantee), and every one is under the identity in use when this device's own
     * succession left re-sealing unfinished, or when this person followed the grantee's
     * succession ("Check again") and their shares still hold the old keys. Sealed only to keys
     * the pin vouches for; a grantee whose served keys differ from the pin is not followed here
     * (that asks the server for their chain, which only the person does) and is named in the
     * outcome. A failure the network caused is tried on the next pass.
     */
    @discardableResult
    public func upgradeShares() async throws -> RotationOutcome {
        var outcome = RotationOutcome()
        // The re-seals asked for so far: only these are acknowledged at the end, never one asked for while this pass ran.
        let requested = ResealTo.requests
        // The keys this pass seals under, read first: a key replacement begun while it runs is left for its own pass.
        let keys = try await identityKeys()
        let reply = try await api.performPublic(try api.requestPublic("/shares/mine"), as: SharedByMeResponse.self)
        if reply.shares.isEmpty && requested.isEmpty { ResealPending.clear(for: keys.signingPublicKey); return outcome }
        let settings = try await loadSettings()
        let ledger = settings.ledger
        let pending = ResealPending.isSet(for: keys.signingPublicKey)
        var looked: [String: Contact] = [:]
        var sealed: [String: (publicKey: Data, kem: Data)] = [:]
        var unfinished = false
        var resealedTo: Set<String> = []
        var failedFor: Set<String> = []
        for share in reply.shares where ledger.holdsShare(node: share.node.id, grantee: share.grantee.id) {
            let grantee = share.grantee.id.lowercased()
            let followed = requested[grantee] != nil
            guard pending || share.suite != 4 || followed else { continue }
            guard let pin = settings.pin(of: share.grantee.id) else {
                outcome.note(ContactError.unpinned)
                continue
            }
            do {
                let contact: Contact
                if let identity = share.granteeIdentity {
                    contact = Contact(userId: share.grantee.id, served: identity, name: pin.name, email: pin.email)
                } else if let known = looked[grantee] {
                    contact = known
                } else {
                    // An older server serves no grantee identity here: look them up, once.
                    contact = try await Auth.lookupContact(email: pin.email, as: session)
                    guard contact.userId.lowercased() == pin.userId.lowercased() else { throw ContactError.changed }
                    looked[grantee] = contact
                }
                // Checked before anything is opened: only keys the pin holds, agreeing with this phone's guard, are sealed to.
                let sealing: (publicKey: Data, kem: Data)
                // Reused only for these very keys: a share serving other keys for them is judged again (a change pauses it).
                if let known = sealed[contact.trustKey] { sealing = known } else {
                    sealing = try await trustGrantee(contact, follow: false)
                    sealed[contact.trustKey] = sealing
                }
                guard let item = await openAnywhere(share.node), let nodeKey = nodeKey(of: item) else {
                    throw DriveAPIError.notFound("A shared item couldn’t be opened to seal it again.")
                }
                let ctx = ShareContext(workspaceId: item.node.workspaceId, nodeId: item.id, keyEpoch: item.node.keyEpoch, granteeUserId: pin.userId, granterUserId: session.userId)
                let envelope = try shareSeal(ctx: ctx, nodeKey: nodeKey, granter: keys, granteePublicKey: sealing.publicKey, granteeKemPublicKey: sealing.kem)
                try await api.resealShare(share.id, workspaceId: item.node.workspaceId, keyEpoch: item.node.keyEpoch, envelope: envelope)
                outcome.rotated += 1
                if followed { resealedTo.insert(grantee) }
            } catch let error as ContactError {
                // The pin doesn't vouch for the keys served: no amount of retrying changes that until the person acts.
                outcome.note(error)
                failedFor.insert(grantee)
            } catch let error as AccountChangedError {
                // Paused for them until Continue or a check (2.4): nothing is sealed to keys nobody accepted.
                outcome.note(error)
                failedFor.insert(grantee)
            } catch {
                unfinished = true
                failedFor.insert(grantee)
                outcome.note(error)
            }
        }
        // Done, or nothing of theirs left to seal: either way they leave the queue.
        let held = Set(reply.shares.filter { ledger.holdsShare(node: $0.node.id, grantee: $0.grantee.id) }.map { $0.grantee.id.lowercased() })
        let unheld = await withNothingInTheTrash(Set(requested.keys).subtracting(held), ledger: ledger)
        let done = resealedTo.subtracting(failedFor).union(unheld)
        ResealTo.acknowledge(requested.filter { done.contains($0.key) })
        if !unfinished { ResealPending.clear(for: keys.signingPublicKey) }
        return outcome
    }

    /*
     * Of the people queued with nothing served to seal, those with nothing of theirs in the Trash
     * either: /shares/mine leaves a trashed item out as it does a deleted one, but restored it would
     * still hold their old keys, so they stay queued until it is restored (and sealed) or deleted
     * for good. When the Trash can't be read, everyone the ledger still names stays queued.
     */
    func withNothingInTheTrash(_ people: Set<String>, ledger: SharingLedger) async -> Set<String> {
        let named = ledger.shares.filter { !$0.value.isEmpty && !Set($0.value.map { $0.lowercased() }).isDisjoint(with: people) }
        guard !named.isEmpty else { return people }
        guard let trashed = try? await trashedIds() else {
            return people.subtracting(named.values.flatMap { $0.map { $0.lowercased() } })
        }
        return people.subtracting(named.filter { trashed.contains($0.key.lowercased()) }.values.flatMap { $0.map { $0.lowercased() } })
    }

    /* The ids of this drive's items in the Trash, as the server lists them (a folder's listing leaves them out). */
    func trashedIds() async throws -> Set<String> {
        let workspaceId = try await loadWorkspace().workspaceId
        var ids: Set<String> = []
        var after: String?
        repeat {
            let page = try await api.trashListing(workspaceId: workspaceId, after: after)
            ids.formUnion(page.items.map { $0.node.id.lowercased() })
            after = page.nextCursor
        } while after != nil
        return ids
    }
}

/*
 * A succession this device made whose re-sealing hasn't finished: kept on this phone (in
 * `state/`, out of backups and wiped on sign-out) so the next Drive open finishes it, rather
 * than replacing the keys again.
 */
enum ResealPending {
    static let file = "reseal-pending.json"

    static func set(for signingPublicKey: String) { Unbacked.write(signingPublicKey, file) }
    static func isSet(for signingPublicKey: String) -> Bool { Unbacked.read(String.self, file) == signingPublicKey }
    static func clear() { Unbacked.write(String?.none, file) }
    /* Finished for these keys only: a replacement begun since (other keys) keeps waiting for its own pass. */
    static func clear(for signingPublicKey: String) { if isSet(for: signingPublicKey) { clear() } }
}

extension IdentityEnvelope {
    /*
     * Whether this is `other` as served: the four public keys, the key version, the identity
     * version and the keys statement (the KEM key's own binding too, on version 1). The sealed
     * halves are left out: a master-key rotation wraps them again without changing the identity.
     */
    func servesSameIdentity(as other: IdentityEnvelope) -> Bool {
        version == other.version && keyVersion == other.keyVersion
            && encryptionPublicKey == other.encryptionPublicKey && signingPublicKey == other.signingPublicKey
            && mlDsa?.publicKey == other.mlDsa?.publicKey && kem?.publicKey == other.kem?.publicKey
            && kem?.signature == other.kem?.signature && keysSignature == other.keysSignature
    }
}

extension RotationOutcome {
    /* Each reason once, in the words the person reads. */
    mutating func note(_ error: Error) {
        let reason = ErrorWords.say(error, otherwise: "Their keys couldn’t be checked.") ?? "Their keys couldn’t be checked."
        if !skipped.contains(reason) { skipped.append(reason) }
    }
}

extension DriveAPI {
    /* Replaces a live share's envelope at the node's current epoch; suite 4 only. */
    func resealShare(_ shareId: String, workspaceId: String, keyEpoch: UInt64, envelope: Data) async throws {
        struct Resealed: Decodable {}
        _ = try await performPublic(try mutationPublic("/shares/\(shareId)/envelope", method: "PUT", body: [
            "workspaceId": workspaceId, "keyEpoch": keyEpoch, "shareEnvelope": base64urlEncode(bytes: envelope),
        ]), as: Resealed.self)
    }
}
