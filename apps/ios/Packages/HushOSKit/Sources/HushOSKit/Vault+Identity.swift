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

    /* How a contact's identity got from key version `from` to the current one, link by link. */
    static func succession(of userId: String, from: UInt64) async throws -> [SuccessionLink] {
        let reply = try await call("/api/auth/contacts/\(userId.lowercased())/succession?from=\(max(from, 1))")
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
        return [current] + earlier
    }

    /*
     * The signing seed of the identity in use: every write that sets a metadata or content-key
     * envelope is signed with it. The server checks against the account's current key, so an
     * identity another device replaced meanwhile is noticed (asked at most every few minutes)
     * and opened afresh, rather than every write failing until the app restarts.
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
        } catch {
            // Without the identity the server would refuse the write; say so rather than send it unsigned.
            throw DriveAPIError.server(400, "Your keys couldn’t be opened to sign this change. Try again.")
        }
    }

    /* `metadataSignature` for a metadata envelope at `version` (the version the server will store). */
    func signMetadata(workspaceId: String, nodeId: String, kind: NodeKind, version: UInt64, envelope: Data) async throws -> String {
        let statement = MetadataStatement(workspaceId: workspaceId, nodeId: nodeId, kind: kind, metadataVersion: version)
        return base64urlEncode(bytes: try metadataSign(signingSeed: try await signingSeed(), statement: statement, metadataEnvelope: envelope))
    }

    /* `versionSignature` for a content-key envelope where it lands: the node and version it is stored as. */
    func signVersion(workspaceId: String, nodeId: String, versionId: String, objectId: String, suite: UInt32, envelope: Data) async throws -> String {
        let statement = VersionStatement(workspaceId: workspaceId, nodeId: nodeId, versionId: versionId, objectId: objectId, contentSuite: suite)
        return base64urlEncode(bytes: try versionSign(signingSeed: try await signingSeed(), statement: statement, contentKeyEnvelope: envelope))
    }

    /*
     * Whose signatures count: this account's own identities, and every verified pin's signing
     * key with the earlier ones its succession chain vouched for. Kept until the pins or the
     * identity change.
     */
    public func signers() async throws -> TrustedSigners {
        if let trustedSigners { return trustedSigners }
        let trusted = TrustedSigners(userId: session.userId, identities: try await allIdentities(), pins: try await loadSettings().contacts.values)
        trustedSigners = trusted
        return trusted
    }

    /* Forgets the trusted keys, so the next read builds them again (a pin added elsewhere, say). */
    public func forgetSigners() { trustedSigners = nil }

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
     * ledger holds is sealed again in suite 3 under the identity in use when it is still in an
     * older suite, when this device's own succession left re-sealing unfinished, or when the
     * grantee replaced their keys (their chain from the pin checked first: sealed only to keys
     * it vouches for, and the pin moved along). People the pins no longer vouch for are left as
     * they are and named in the outcome; a failure the network caused is tried on the next pass.
     */
    @discardableResult
    public func upgradeShares() async throws -> RotationOutcome {
        var outcome = RotationOutcome()
        let reply = try await api.performPublic(try api.requestPublic("/shares/mine"), as: SharedByMeResponse.self)
        if reply.shares.isEmpty { ResealPending.clear(); return outcome }
        let settings = try await loadSettings()
        let ledger = settings.ledger
        var pins = settings.contacts
        let keys = try await identityKeys()
        let pending = ResealPending.isSet(for: keys.signingPublicKey)
        var looked: [String: ServedContactKeys] = [:]
        var unfinished = false
        for share in reply.shares where ledger.holdsShare(node: share.node.id, grantee: share.grantee.id) {
            guard var pin = pins[share.grantee.id] else {
                if pending || share.suite != 3 { outcome.note(ContactError.unpinned) }
                continue
            }
            let served = share.granteeIdentity?.served
            let moved = served.map { pin.mayFollow($0) } ?? false
            guard pending || share.suite != 3 || moved else { continue }
            do {
                var keysNow: ServedContactKeys
                var kemSignature: String?
                if let served, let identity = share.granteeIdentity {
                    keysNow = served
                    kemSignature = identity.kem?.signature
                } else if let known = looked[pin.userId] {
                    keysNow = known
                } else {
                    // An older server serves no grantee identity here: look them up, once.
                    let contact = try await Auth.lookupContact(email: pin.email)
                    guard contact.userId == pin.userId else { throw ContactError.changed }
                    keysNow = contact.served
                    kemSignature = contact.kem?.signature
                    looked[pin.userId] = keysNow
                }
                pin = await follow(pin, served: keysNow)
                pins[pin.userId] = pin
                guard let item = await openAnywhere(share.node), let nodeKey = nodeKey(of: item) else {
                    throw DriveAPIError.notFound("A shared item couldn’t be opened to seal it again.")
                }
                let sealing = try pin.sealKeys(encryptionPublicKey: keysNow.encryptionPublicKey, kemPublicKey: keysNow.kemPublicKey, kemSignature: kemSignature)
                if let digest = sealing.newDigest { try await rememberKem(digest, for: pin.userId) }
                let ctx = ShareContext(workspaceId: item.node.workspaceId, nodeId: item.id, keyEpoch: item.node.keyEpoch, granteeUserId: pin.userId, granterUserId: session.userId)
                let envelope = try shareSeal(ctx: ctx, nodeKey: nodeKey, granter: keys, granteePublicKey: sealing.publicKey, granteeKemPublicKey: sealing.kem)
                try await api.resealShare(share.id, workspaceId: item.node.workspaceId, keyEpoch: item.node.keyEpoch, envelope: envelope)
                outcome.rotated += 1
            } catch let error as ContactError {
                // The pin doesn't vouch for the keys served: no amount of retrying changes that until the person acts.
                outcome.note(error)
            } catch {
                unfinished = true
                outcome.note(error)
            }
        }
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
