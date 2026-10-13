import Foundation
import HushOSCore

extension Auth {
    /* The account's earlier identities, oldest first, still sealed under the account key. */
    static func identityHistory() async throws -> [IdentityEnvelope] {
        let reply = try await call("/api/auth/identity/history")
        return (reply["identities"] as? [[String: Any]] ?? []).map { identityEnvelope(from: $0) }
    }

    /* Installs a successor identity the current signing key vouched for; 409 when another device moved first. */
    static func succeedIdentity(_ succession: IdentitySuccession) async throws {
        _ = try await call("/api/auth/identity/succession", method: "POST", body: [
            "identity": json(succession.identity), "signature": succession.signature,
        ])
    }

    /*
     * A contact's whole succession chain, from their first identity to the current one. Always
     * the whole chain: asking from the pinned version would tell the server which version this
     * person pinned. The checker finds where the pin's keys join it.
     */
    static func succession(of userId: String) async throws -> [SuccessionLink] {
        let reply = try await call("/api/auth/contacts/\(userId.lowercased())/succession?from=1")
        return (reply["links"] as? [[String: Any]] ?? []).map { link in
            SuccessionLink(
                oldKeyVersion: (link["oldKeyVersion"] as? NSNumber)?.uint64Value ?? 0,
                newKeyVersion: (link["newKeyVersion"] as? NSNumber)?.uint64Value ?? 0,
                oldEncryptionPublicKey: link["oldEncryptionPublicKey"] as? String ?? "",
                oldSigningPublicKey: link["oldSigningPublicKey"] as? String ?? "",
                newEncryptionPublicKey: link["newEncryptionPublicKey"] as? String ?? "",
                newSigningPublicKey: link["newSigningPublicKey"] as? String ?? "",
                newKemPublicKey: link["newKemPublicKey"] as? String ?? "",
                signature: link["signature"] as? String ?? ""
            )
        }
    }
}

/*
 * How a write signs an envelope it sealed. Content this person wrote is their own; a record
 * sealed again (rotation, a copy) is signed only after it was checked as it was, ordinary
 * when it verified and re-sealed otherwise; a copy saved from a link or someone's share is
 * always re-sealed, since its signatures were never this person's to vouch for.
 */
public enum Signing: Sendable, Equatable {
    case own
    case after(Integrity)
    case resealed
}

/*
 * The identity beyond opening it: the earlier ones a succession left (shares sealed to
 * them open only with them, and what they signed is still this account's), signing what
 * this account writes, the keys a reader trusts, and replacing the identity.
 */
extension Vault {
    /* Every identity this account holds: the current one first, then the earlier ones, newest first. */
    func allIdentities() async throws -> [IdentityKeys] {
        let current = try await identityKeys()
        if let earlierIdentities { return [current] + earlierIdentities }
        let accountKey = try unlockAccount()
        var earlier: [IdentityKeys] = []
        for envelope in try await Auth.identityHistory() {
            // Opening proves each is this account's own (sealed under its root, its keys matching), not one the server added.
            earlier.append(try identityOpen(userId: session.userId, accountKey: accountKey, envelope: envelope))
        }
        earlier.sort { $0.keyVersion > $1.keyVersion }
        earlierIdentities = earlier
        // A settings mark an earlier version kept under any of these keys becomes the account's, so a
        // device that saw version 7 before a succession still refuses 6 (identityKeys covers the current key).
        SettingsMarks.shared.adopt(userId: session.userId, encryptionPublicKeys: earlier.map(\.encryptionPublicKey))
        return [current] + earlier
    }

    /*
     * The signing seed of the identity in use: every write that sets a metadata or content-key
     * envelope is signed with it. The server checks against the account's current key, so an
     * identity another device replaced meanwhile is noticed (asked at most every few minutes)
     * and opened afresh, rather than every write failing until the app restarts. One served
     * with a lower key version than the one in use is not taken: `identityKeys` refuses it.
     */
    private func signingSeed() async throws -> Data {
        if identity != nil, identityCheckedAt.map({ Date().timeIntervalSince($0) > 300 }) ?? true,
           let served = try? await Auth.identity() {
            identityCheckedAt = Date()
            if served.signingPublicKey != identity?.signingPublicKey || served.keyVersion != identity?.keyVersion {
                identity = nil
                earlierIdentities = nil
                trustedSigners = nil
            }
        }
        do {
            return try await identityKeys().signingSeed
        } catch let error as DriveAPIError {
            throw error
        } catch AuthError.message(let text) where text == IdentityMarks.downgraded {
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
        case .resealed: signature = try metadataResealedSign(signingSeed: seed, statement: statement, metadataEnvelope: envelope)
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
        case .resealed: signature = try versionResealedSign(signingSeed: seed, statement: statement, contentKeyEnvelope: envelope)
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
        if let trustedSigners { return trustedSigners }
        let trusted = try TrustedSigners(userId: session.userId, identities: try await allIdentities(), pins: try await loadSettings().contacts.values)
        trustedSigners = trusted
        return trusted
    }

    /* Forgets the trusted keys, so the next read builds them again (a pin added elsewhere, say). */
    public func forgetSigners() { trustedSigners = nil }

    /* Tests: whom to trust, without the network. */
    func adopt(signers: TrustedSigners) { trustedSigners = signers }

    // MARK: - Replacing the identity

    /*
     * Replaces this account's sharing keys with a successor vouched for by the current
     * signing key (docs/integrity-design.md, "Identity succession"): people who checked the
     * old keys follow the chain instead of comparing words from scratch. The old identity
     * stays openable through the history, so shares sealed to it still open; every share
     * the ledger holds is sealed again in suite 3 under the new signing key.
     */
    public func replaceSharingKeys() async throws -> RotationOutcome {
        // Settings sealed under the identity (version 1) would be stranded with it: sealed under the settings key first.
        try await ensureSettingsKeyed()
        let current = try await Auth.identity()
        let opened = try await identityKeys()
        guard opened.signingPublicKey == current.signingPublicKey, opened.keyVersion == current.keyVersion else {
            identity = nil
            earlierIdentities = nil
            throw AuthError.message("Your keys changed on another device. Try again.")
        }
        let succession = try identitySucceed(userId: session.userId, accountKey: try unlockAccount(), current: current)
        try await Auth.succeedIdentity(succession)
        // From here the keys are replaced: what is left is re-sealing, which the next Drive open finishes if this one can't.
        ResealPending.set(for: succession.identity.signingPublicKey)
        identity = nil
        earlierIdentities = nil
        trustedSigners = nil
        _ = try await allIdentities()
        return try await upgradeShares()
    }

    /*
     * The upgrade pass, run when Drive opens and right after a succession: every share the
     * ledger holds is sealed again in suite 3 under the identity in use when this device's own
     * succession left re-sealing unfinished, or when this person followed the grantee's
     * succession ("Check again") and their shares still hold the old keys. Sealed only to keys
     * the pin vouches for; a grantee whose served keys differ from the pin is not followed here
     * (that asks the server for their chain, which only the person does) and is named in the
     * outcome. A failure the network caused is tried on the next pass.
     */
    @discardableResult
    public func upgradeShares() async throws -> RotationOutcome {
        var outcome = RotationOutcome()
        let reply = try await api.performPublic(try api.requestPublic("/shares/mine"), as: SharedByMeResponse.self)
        if reply.shares.isEmpty { ResealPending.clear(); ResealTo.remove(ResealTo.all); return outcome }
        let settings = try await loadSettings()
        let ledger = settings.ledger
        let pins = settings.contacts
        let keys = try await identityKeys()
        let pending = ResealPending.isSet(for: keys.signingPublicKey)
        var looked: [String: (keys: ServedContactKeys, kemSignature: String?)] = [:]
        var unfinished = false
        var resealedTo: Set<String> = []
        var failedFor: Set<String> = []
        for share in reply.shares where ledger.holdsShare(node: share.node.id, grantee: share.grantee.id) {
            let grantee = share.grantee.id.lowercased()
            let followed = ResealTo.contains(grantee)
            guard pending || share.suite != 3 || followed else { continue }
            guard let pin = pins[share.grantee.id] else {
                outcome.note(ContactError.unpinned)
                continue
            }
            do {
                var served: ServedContactKeys
                var kemSignature: String?
                if let identity = share.granteeIdentity {
                    served = identity.served
                    kemSignature = identity.kem?.signature
                } else if let known = looked[grantee] {
                    (served, kemSignature) = known
                } else {
                    // An older server serves no grantee identity here: look them up, once.
                    let contact = try await Auth.lookupContact(email: pin.email)
                    guard contact.userId == pin.userId else { throw ContactError.changed }
                    served = contact.served
                    kemSignature = contact.kem?.signature
                    looked[grantee] = (served, kemSignature)
                }
                guard pin.matches(served) else { throw ContactError.changed }
                guard let item = await openAnywhere(share.node), let nodeKey = nodeKey(of: item) else {
                    throw DriveAPIError.notFound("A shared item couldn’t be opened to seal it again.")
                }
                let sealing = try pin.sealKeys(encryptionPublicKey: served.encryptionPublicKey, kemPublicKey: served.kemPublicKey, kemSignature: kemSignature)
                if let digest = sealing.newDigest { try await rememberKem(digest, for: pin.userId) }
                let ctx = ShareContext(workspaceId: item.node.workspaceId, nodeId: item.id, keyEpoch: item.node.keyEpoch, granteeUserId: pin.userId, granterUserId: session.userId)
                let envelope = try shareSeal(ctx: ctx, nodeKey: nodeKey, granter: keys, granteePublicKey: sealing.publicKey, granteeKemPublicKey: sealing.kem)
                try await api.resealShare(share.id, workspaceId: item.node.workspaceId, keyEpoch: item.node.keyEpoch, envelope: envelope)
                outcome.rotated += 1
                if followed { resealedTo.insert(grantee) }
            } catch let error as ContactError {
                // The pin doesn't vouch for the keys served: no amount of retrying changes that until the person acts.
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
        ResealTo.remove(resealedTo.subtracting(failedFor).union(ResealTo.all.subtracting(held)))
        if !unfinished { ResealPending.clear() }
        return outcome
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
}

extension RotationOutcome {
    /* Each reason once, in the words the person reads. */
    mutating func note(_ error: Error) {
        let reason = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        if !skipped.contains(reason) { skipped.append(reason) }
    }
}

extension DriveAPI {
    /* Replaces a live share's envelope at the node's current epoch; suite 3 only. */
    func resealShare(_ shareId: String, workspaceId: String, keyEpoch: UInt64, envelope: Data) async throws {
        struct Resealed: Decodable {}
        _ = try await performPublic(try mutationPublic("/shares/\(shareId)/envelope", method: "PUT", body: [
            "workspaceId": workspaceId, "keyEpoch": keyEpoch, "shareEnvelope": base64urlEncode(bytes: envelope),
        ]), as: Resealed.self)
    }
}
