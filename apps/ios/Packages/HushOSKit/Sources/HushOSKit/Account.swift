import Foundation

/*
 * `/api/auth/storage`. While the account's own files draw from a family's pool
 * (docs/families-shared-pool.md 3.1) the figures are the pool's, counted part by
 * part in whole GiB so they give away no one member's usage (3.9), and `pool`
 * names the family; on the account's own allowance, or on a server older than
 * the pool or without billing, `pool` is null or absent.
 */
public struct StorageAllowance: Codable, Sendable {
    public let workspaceId: String
    public let quotaBytes: String
    public let usedBytes: String
    public let reservedBytes: String
    public let availableBytes: String
    public let pool: StoragePool?
    public var quota: Int64 { Int64(quotaBytes) ?? 0 }
    public var used: Int64 { Int64(usedBytes) ?? 0 }
    /*
     * What an upload can still take, as the server checks it. Never quota less used: in a pool
     * the server leaves other members' uploads in flight out of `usedBytes` (they would give
     * away one member's activity) and takes them off `availableBytes` only.
     */
    public var free: Int64 { max(0, Int64(availableBytes) ?? 0) }

    private enum CodingKeys: String, CodingKey { case workspaceId, quotaBytes, usedBytes, reservedBytes, availableBytes, pool }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        workspaceId = try container.decode(String.self, forKey: .workspaceId)
        quotaBytes = try container.decode(String.self, forKey: .quotaBytes)
        usedBytes = try container.decode(String.self, forKey: .usedBytes)
        reservedBytes = try container.decode(String.self, forKey: .reservedBytes)
        availableBytes = try container.decode(String.self, forKey: .availableBytes)
        // A pool this build can't read is no pool: the figures still show, under today's words,
        // rather than the whole allowance failing to decode and the card going blank.
        pool = (try? container.decodeIfPresent(StoragePool.self, forKey: .pool)) ?? nil
    }
}

/* The family whose pool the storage figures are. Both fields must be there and not empty. */
public struct StoragePool: Codable, Sendable, Equatable {
    public let groupId: String
    public let name: String

    private enum CodingKeys: String, CodingKey { case groupId, name }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        groupId = try container.decode(String.self, forKey: .groupId)
        name = try container.decode(String.self, forKey: .name)
        guard !groupId.isEmpty, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: container.codingPath, debugDescription: "A pool names its family."))
        }
    }
}

public struct BillingSubscription: Codable, Sendable {
    public let productName: String
    public let status: String
    public let recurringInterval: String
    public let quotaBytes: String
    public let currentPeriodEnd: String
    public let cancelAtPeriodEnd: Bool
}

public struct BillingSummary: Codable, Sendable {
    public let enabled: Bool
    public let subscription: BillingSubscription?
    /* The family whose plan the storage comes from while pooled; absent on older servers. */
    public let family: BillingFamily?

    private enum CodingKeys: String, CodingKey { case enabled, subscription, family }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try container.decode(Bool.self, forKey: .enabled)
        subscription = try container.decodeIfPresent(BillingSubscription.self, forKey: .subscription)
        family = (try? container.decodeIfPresent(BillingFamily.self, forKey: .family)) ?? nil
    }
}

/* The family whose plan a pooled person's storage comes from: a name that isn't blank, as for a pool. */
public struct BillingFamily: Codable, Sendable, Equatable {
    public let name: String
    public let planName: String?

    private enum CodingKeys: String, CodingKey { case name, planName }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        planName = try container.decodeIfPresent(String.self, forKey: .planName)
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: container.codingPath, debugDescription: "A family has a name."))
        }
    }
}

/*
 * What Account says about the plan (docs/families-shared-pool.md 9). Read only,
 * as all billing on the phone is: no way to buy or change a plan here (App
 * Review 3.1.3(f), and Google Play the same).
 *
 * While the storage figures are a family's pool, the plan is the family's: its
 * name from `/api/billing`'s `family` ("Family plan" until that answers) and
 * the line "Shared with <family>" (no possessive: "The Lindqvists’s" reads badly). A personal subscription is never shown then,
 * since the person no longer draws from it (billing ends it, 5.1). Without a
 * readable `pool` it is today's display: the personal plan, or Free.
 */
public struct PlanDisplay: Sendable {
    /* The plan's name, the card's heading. */
    public let name: String
    /* "Shared with Lindqvist family" while pooled, else nil. */
    public let source: String?
    /* The family's name while pooled, for labels that would otherwise read as the person's own. */
    public let family: String?
    /* The personal plan whose renewal and status the card shows; nil while pooled. */
    public let subscription: BillingSubscription?

    public init(allowance: StorageAllowance?, billing: BillingSummary?) {
        // The storage answer decides; the billing one only when storage didn't answer at all,
        // so a failed read never puts back a personal plan the person no longer draws from.
        let family = allowance.map { $0.pool?.name } ?? billing?.family?.name
        if let family {
            let planName = billing?.family?.planName?.trimmingCharacters(in: .whitespacesAndNewlines)
            name = planName.flatMap { $0.isEmpty ? nil : $0 } ?? "Family plan"
            source = "Shared with \(family)"
            self.family = family
            subscription = nil
        } else {
            name = billing?.subscription?.productName ?? "Free"
            source = nil
            self.family = nil
            subscription = billing?.subscription
        }
    }
}

/*
 * The account beyond the drive: the name, the plan and its storage, the
 * password, and deletion. Password changes and deletion prove the password
 * with OPAQUE in the core; the account key is opened with the old password
 * and sealed again under the new one, so the server never sees either.
 */
extension Auth {
    private struct Reply2 { let body: [String: Any] }

    /* Tests: a session and transport in place of the keychain's and the network. */
    nonisolated(unsafe) static var testSession: SharedKeychain.Session?
    nonisolated(unsafe) static var testTransport: URLSessionConfiguration?

    private static func session() throws -> SharedKeychain.Session {
        if let testSession { return testSession }
        guard let session = SharedKeychain.session else { throw AuthError.message("Sign in first.") }
        return session
    }

    static func call(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> [String: Any] {
        let session = try session()
        guard let url = URL(string: session.origin + path) else { throw AuthError.message("Bad HushOS address.") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        let cookieName = session.origin.hasPrefix("https:") ? "__Host-hushos-session" : "hushos-session"
        request.setValue("\(cookieName)=\(session.token)", forHTTPHeaderField: "Cookie")
        request.setValue(session.origin, forHTTPHeaderField: "Origin")
        request.setValue(DriveAPI.clientHeader, forHTTPHeaderField: "HushOS-Client")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        request.timeoutInterval = 30
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession(configuration: testTransport ?? .ephemeral).data(for: request)
        } catch {
            // Left (the sheet closed, the task ended): a cancellation, never "couldn't reach".
            if ErrorWords.isCancellation(error) { throw CancellationError() }
            throw AuthError.message(AuthError.unreachable)
        }
        let parsed = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        guard let http = response as? HTTPURLResponse, (200 ..< 300).contains(http.statusCode) else {
            if (response as? HTTPURLResponse)?.statusCode == 401 { throw AuthError.sessionEnded }
            if (response as? HTTPURLResponse)?.statusCode == 409 { throw AuthError.conflict(parsed["message"] as? String ?? "This changed on another device. Try again.") }
            throw AuthError.message(parsed["message"] as? String ?? "Something went wrong on HushOS. Try again in a moment.")
        }
        return parsed
    }

    public static func updateName(_ name: String) async throws -> SessionUser {
        let reply = try await call("/api/auth/profile", method: "POST", body: ["name": name])
        guard let user = reply["user"] as? [String: Any] else { throw AuthError.message("HushOS returned no account.") }
        return try JSONDecoder().decode(SessionUser.self, from: JSONSerialization.data(withJSONObject: user))
    }

    public static func storage() async throws -> StorageAllowance {
        let reply = try await call("/api/auth/storage")
        guard let storage = reply["storage"] as? [String: Any] else { throw AuthError.message("HushOS returned no storage allowance.") }
        return try JSONDecoder().decode(StorageAllowance.self, from: JSONSerialization.data(withJSONObject: storage))
    }

    public static func billing() async throws -> BillingSummary {
        let reply = try await call("/api/billing")
        return try JSONDecoder().decode(BillingSummary.self, from: JSONSerialization.data(withJSONObject: reply))
    }

    private static func envelope(from json: [String: Any]) -> AccountKeyEnvelope {
        AccountKeyEnvelope(
            envelopeVersion: UInt32((json["envelopeVersion"] as? NSNumber)?.intValue ?? 0),
            keyVersion: (json["keyVersion"] as? NSNumber)?.uint64Value ?? 0,
            credentialVersion: (json["credentialVersion"] as? NSNumber)?.uint64Value ?? 0,
            wrappingSalt: json["wrappingSalt"] as? String ?? "",
            wrappingNonce: json["wrappingNonce"] as? String ?? "",
            encryptedKey: json["encryptedKey"] as? String ?? ""
        )
    }

    /* The old password opens the account key; the new one seals it again one credential version up. */
    public static func changePassword(current: String, new: String) async throws {
        let login = try opaqueStartLogin(password: current)
        let registration = try opaqueStartRegistration(password: new)
        let challenge = try await call("/api/auth/security/start", method: "POST", body: [
            "action": "password", "startLoginRequest": login.request, "registrationRequest": registration.request,
        ])
        guard let attemptToken = challenge["attemptToken"] as? String, let loginResponse = challenge["loginResponse"] as? String,
              let registrationResponse = challenge["registrationResponse"] as? String, let userId = challenge["userId"] as? String,
              let envelopeJson = challenge["envelope"] as? [String: Any]
        else { throw AuthError.message("Unexpected reply from HushOS.") }
        guard let finish = try opaqueFinishLogin(password: current, state: login.state, loginResponse: loginResponse) else {
            throw AuthError.message("That isn’t your current password.")
        }
        let old = envelope(from: envelopeJson)
        let accountKey = try accountUnlock(userId: userId, exportKey: finish.exportKey, envelope: old)
        let registered = try opaqueFinishRegistration(password: new, state: registration.state, registrationResponse: registrationResponse)
        let sealed = try accountSeal(userId: userId, exportKey: registered.exportKey, accountKey: accountKey, keyVersion: old.keyVersion, credentialVersion: old.credentialVersion + 1)
        _ = try await call("/api/auth/security/finish", method: "POST", body: [
            "action": "password", "attemptToken": attemptToken, "finishLoginRequest": finish.request,
            "registrationRecord": registered.record,
            "envelope": [
                "envelopeVersion": sealed.envelopeVersion, "keyVersion": sealed.keyVersion, "credentialVersion": sealed.credentialVersion,
                "wrappingSalt": sealed.wrappingSalt, "wrappingNonce": sealed.wrappingNonce, "encryptedKey": sealed.encryptedKey,
            ],
        ])
        // The device memory names the credential version; remember the account key under the new one.
        let memory = try deviceRemember(userId: userId, accountKey: accountKey, keyVersion: sealed.keyVersion, credentialVersion: sealed.credentialVersion, deviceKeyId: UUID().uuidString.lowercased())
        try SharedKeychain.write(SharedKeychain.deviceAccount, SharedKeychain.Device(memory: memory))
    }

    /* Proves the password once more, then the server removes the account; every local trace goes with it. */
    public static func deleteAccount(password: String) async throws {
        let login = try opaqueStartLogin(password: password)
        let started = try await call("/api/auth/delete/start", method: "POST", body: ["startLoginRequest": login.request])
        guard let attemptToken = started["attemptToken"] as? String, let loginResponse = started["loginResponse"] as? String else {
            throw AuthError.message("Unexpected reply from HushOS.")
        }
        guard let finish = try opaqueFinishLogin(password: password, state: login.state, loginResponse: loginResponse) else {
            throw AuthError.message("That isn’t your password.")
        }
        _ = try await call("/api/auth/delete/finish", method: "POST", body: ["attemptToken": attemptToken, "finishLoginRequest": finish.request])
        SharedKeychain.delete(SharedKeychain.sessionAccount)
        SharedKeychain.delete(SharedKeychain.deviceAccount)
    }

    /* Recovery needs the recovery phrase and runs on the web for now. */
    public static func recoveryURL(origin: String) -> URL? { URL(string: origin + "/recover") }
    /* The signed-in server's policies (hushos.com's for the hosted service), opened in Safari; app=1 drops the site's links to plans. */
    public static func privacyURL(origin: String) -> URL? { URL(string: origin + "/privacy?app=1") }
    public static func termsURL(origin: String) -> URL? { URL(string: origin + "/terms?app=1") }

    // MARK: Key rotation

    /*
     * An identity envelope as the server stores it: version 1 (X25519 and Ed25519, an ML-KEM key
     * with its Ed25519 binding on most) or version 2 (all four halves and the keys statement's
     * hybrid signature, no binding).
     */
    static func identityEnvelope(from json: [String: Any]) -> IdentityEnvelope {
        let kem = (json["kem"] as? [String: Any]).map {
            IdentityKem(publicKey: $0["publicKey"] as? String ?? "", seedNonce: $0["seedNonce"] as? String ?? "",
                        encryptedSeed: $0["encryptedSeed"] as? String ?? "", signature: $0["signature"] as? String)
        }
        let mlDsa = (json["mlDsa"] as? [String: Any]).map {
            IdentityMlDsa(publicKey: $0["publicKey"] as? String ?? "", seedNonce: $0["seedNonce"] as? String ?? "",
                          encryptedSeed: $0["encryptedSeed"] as? String ?? "")
        }
        return IdentityEnvelope(
            version: UInt32((json["version"] as? NSNumber)?.intValue ?? 0),
            keyVersion: (json["keyVersion"] as? NSNumber)?.uint64Value ?? 0,
            wrappingSalt: json["wrappingSalt"] as? String ?? "",
            encryptionPublicKey: json["encryptionPublicKey"] as? String ?? "",
            encryptionPrivateKeyNonce: json["encryptionPrivateKeyNonce"] as? String ?? "",
            encryptedEncryptionPrivateKey: json["encryptedEncryptionPrivateKey"] as? String ?? "",
            signingPublicKey: json["signingPublicKey"] as? String ?? "",
            signingSeedNonce: json["signingSeedNonce"] as? String ?? "",
            encryptedSigningSeed: json["encryptedSigningSeed"] as? String ?? "",
            kem: kem,
            mlDsa: mlDsa,
            keysSignature: json["keysSignature"] as? String
        )
    }

    /* The envelope as the API takes it: a version 2 one carries no KEM binding, a version 1 one no ML-DSA half. */
    static func json(_ identity: IdentityEnvelope) -> [String: Any] {
        var out: [String: Any] = [
            "version": identity.version, "keyVersion": identity.keyVersion, "wrappingSalt": identity.wrappingSalt,
            "encryptionPublicKey": identity.encryptionPublicKey, "encryptionPrivateKeyNonce": identity.encryptionPrivateKeyNonce,
            "encryptedEncryptionPrivateKey": identity.encryptedEncryptionPrivateKey, "signingPublicKey": identity.signingPublicKey,
            "signingSeedNonce": identity.signingSeedNonce, "encryptedSigningSeed": identity.encryptedSigningSeed, "kem": NSNull(),
        ]
        if let kem = identity.kem {
            var half: [String: Any] = ["publicKey": kem.publicKey, "seedNonce": kem.seedNonce, "encryptedSeed": kem.encryptedSeed]
            if identity.version == 1, let signature = kem.signature { half["signature"] = signature }
            out["kem"] = half
        }
        if identity.version >= 2 {
            if let mlDsa = identity.mlDsa {
                out["mlDsa"] = ["publicKey": mlDsa.publicKey, "seedNonce": mlDsa.seedNonce, "encryptedSeed": mlDsa.encryptedSeed]
            }
            if let signature = identity.keysSignature { out["keysSignature"] = signature }
        }
        return out
    }

    static func recoveryEnvelope(from json: [String: Any]) -> RecoveryEnvelope {
        RecoveryEnvelope(
            version: UInt32((json["version"] as? NSNumber)?.intValue ?? 0),
            keyVersion: (json["keyVersion"] as? NSNumber)?.uint64Value ?? 0,
            recoveryVersion: (json["recoveryVersion"] as? NSNumber)?.uint64Value ?? 0,
            wrappingSalt: json["wrappingSalt"] as? String ?? "", wrappingNonce: json["wrappingNonce"] as? String ?? "",
            encryptedKey: json["encryptedKey"] as? String ?? "", backupNonce: json["backupNonce"] as? String ?? "",
            encryptedRecoveryKey: json["encryptedRecoveryKey"] as? String ?? "", publicKey: json["publicKey"] as? String ?? ""
        )
    }

    static func json(_ recovery: RecoveryEnvelope) -> [String: Any] {
        [
            "version": recovery.version, "keyVersion": recovery.keyVersion, "recoveryVersion": recovery.recoveryVersion,
            "wrappingSalt": recovery.wrappingSalt, "wrappingNonce": recovery.wrappingNonce, "encryptedKey": recovery.encryptedKey,
            "backupNonce": recovery.backupNonce, "encryptedRecoveryKey": recovery.encryptedRecoveryKey, "publicKey": recovery.publicKey,
        ]
    }

    static func grant(from json: [String: Any]) -> WorkspaceGrant {
        WorkspaceGrant(
            version: UInt32((json["version"] as? NSNumber)?.intValue ?? 0), workspaceId: json["workspaceId"] as? String ?? "",
            keyVersion: (json["keyVersion"] as? NSNumber)?.uint64Value ?? 0, workspaceKeyVersion: (json["workspaceKeyVersion"] as? NSNumber)?.uint64Value ?? 0,
            wrappingSalt: json["wrappingSalt"] as? String ?? "", wrappingNonce: json["wrappingNonce"] as? String ?? "", encryptedKey: json["encryptedKey"] as? String ?? ""
        )
    }

    static func json(_ grant: WorkspaceGrant) -> [String: Any] {
        [
            "version": grant.version, "workspaceId": grant.workspaceId, "keyVersion": grant.keyVersion, "workspaceKeyVersion": grant.workspaceKeyVersion,
            "wrappingSalt": grant.wrappingSalt, "wrappingNonce": grant.wrappingNonce, "encryptedKey": grant.encryptedKey,
        ]
    }

    /*
     * Every grant a rotation's challenge serves, under the new root. A family folder's self-grant
     * opens only as its family's, so it is rewrapped as one: the server names the family
     * (`groupId`), and a wrong or missing one makes the core refuse, never guess.
     */
    static func rewrapGrants(_ served: [[String: Any]], userId: String, oldRoot: Data, newRoot: Data, keyVersion: UInt64) throws -> [WorkspaceGrant] {
        try served.map { row in
            if let groupId = row["groupId"] as? String {
                return try areaSelfGrantRewrap(userId: userId, groupId: groupId, oldRoot: oldRoot, newRoot: newRoot, grant: grant(from: row), keyVersion: keyVersion)
            }
            return try workspaceGrantRewrap(userId: userId, oldRoot: oldRoot, newRoot: newRoot, grant: grant(from: row), keyVersion: keyVersion)
        }
    }

    /* The recovery key envelope the server keeps, and whether the person confirmed saving the phrase. */
    public static func recoveryKey() async throws -> (envelope: RecoveryEnvelope, confirmed: Bool) {
        let reply = try await call("/api/auth/recovery-key")
        guard let json = reply["recovery"] as? [String: Any] else { throw AuthError.message("This account has no recovery key.") }
        return (recoveryEnvelope(from: json), reply["confirmed"] as? Bool ?? false)
    }

    /*
     * Rotates the master key, as the web's "Rotate account key" does: a fresh account
     * key replaces the old one under the same password, the identity and every
     * workspace grant are sealed again under it, and a new recovery phrase is
     * minted. Files and shares do not change; the server ends every session,
     * so the caller signs in again. Returns the phrase to show once.
     */
    public static func rotateKeys(password: String) async throws -> String {
        let login = try opaqueStartLogin(password: password)
        let registration = try opaqueStartRegistration(password: password)
        let challenge = try await call("/api/auth/security/start", method: "POST", body: [
            "action": "master-key", "startLoginRequest": login.request, "registrationRequest": registration.request,
        ])
        guard let attemptToken = challenge["attemptToken"] as? String, let loginResponse = challenge["loginResponse"] as? String,
              let registrationResponse = challenge["registrationResponse"] as? String, let userId = challenge["userId"] as? String,
              let envelopeJson = challenge["envelope"] as? [String: Any], let recoveryJson = challenge["recovery"] as? [String: Any],
              let identityJson = challenge["identity"] as? [String: Any], let workspacesJson = challenge["workspaces"] as? [[String: Any]]
        else { throw AuthError.message("Unexpected reply from HushOS.") }
        guard let finish = try opaqueFinishLogin(password: password, state: login.state, loginResponse: loginResponse) else {
            throw AuthError.message("That isn’t your password.")
        }
        let old = envelope(from: envelopeJson)
        let oldRoot = try accountUnlock(userId: userId, exportKey: finish.exportKey, envelope: old)
        let newRoot = try randomBytes(length: 32)
        let keyVersion = old.keyVersion + 1
        let registered = try opaqueFinishRegistration(password: password, state: registration.state, registrationResponse: registrationResponse)
        let sealed = try accountSeal(userId: userId, exportKey: registered.exportKey, accountKey: newRoot, keyVersion: keyVersion, credentialVersion: old.credentialVersion + 1)
        let oldRecovery = recoveryEnvelope(from: recoveryJson)
        let recovery = try recoveryCreate(userId: userId, accountKey: newRoot, recoveryVersion: oldRecovery.recoveryVersion + 1, keyVersion: keyVersion)
        // Each identity keeps its own key version: contacts' pins and the succession chain name it.
        let identity = try identityRewrap(userId: userId, oldRoot: oldRoot, newRoot: newRoot, envelope: identityEnvelope(from: identityJson))
        // The earlier identities and the settings key go to the new root too, or what they open dies with the old one.
        let history = try (challenge["identityHistory"] as? [[String: Any]] ?? []).map {
            try identityRewrap(userId: userId, oldRoot: oldRoot, newRoot: newRoot, envelope: identityEnvelope(from: $0))
        }
        let settingsKey = try (challenge["settingsKey"] as? [String: Any]).map {
            try settingsKeyRewrap(userId: userId, oldRoot: oldRoot, newRoot: newRoot, envelope: settingsKeyEnvelope(from: $0))
        }
        let workspaces = try rewrapGrants(workspacesJson, userId: userId, oldRoot: oldRoot, newRoot: newRoot, keyVersion: keyVersion)
        var body: [String: Any] = [
            "action": "master-key", "attemptToken": attemptToken, "finishLoginRequest": finish.request,
            "registrationRecord": registered.record,
            "envelope": [
                "envelopeVersion": sealed.envelopeVersion, "keyVersion": sealed.keyVersion, "credentialVersion": sealed.credentialVersion,
                "wrappingSalt": sealed.wrappingSalt, "wrappingNonce": sealed.wrappingNonce, "encryptedKey": sealed.encryptedKey,
            ],
            "recovery": json(recovery.envelope),
            "identity": json(identity),
            "identityHistory": history.map { json($0) },
            "workspaces": workspaces.map { json($0) },
        ]
        if let settingsKey { body["settingsKey"] = json(settingsKey) }
        _ = try await call("/api/auth/security/finish", method: "POST", body: body)
        let memory = try deviceRemember(userId: userId, accountKey: newRoot, keyVersion: sealed.keyVersion, credentialVersion: sealed.credentialVersion, deviceKeyId: UUID().uuidString.lowercased())
        try SharedKeychain.write(SharedKeychain.deviceAccount, SharedKeychain.Device(memory: memory))
        return recovery.phrase
    }
}
