import Foundation

public struct StorageAllowance: Codable, Sendable {
    public let workspaceId: String
    public let quotaBytes: String
    public let usedBytes: String
    public let reservedBytes: String
    public let availableBytes: String
    public var quota: Int64 { Int64(quotaBytes) ?? 0 }
    public var used: Int64 { Int64(usedBytes) ?? 0 }
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
}

/*
 * The account beyond the drive: the name, the plan and its storage, the
 * password, and deletion. Password changes and deletion prove the password
 * with OPAQUE in the core; the account key is opened with the old password
 * and sealed again under the new one, so the server never sees either.
 */
extension Auth {
    private struct Reply2 { let body: [String: Any] }

    private static func session() throws -> SharedKeychain.Session {
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
        request.setValue("ios/2", forHTTPHeaderField: "HushOS-Client")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        request.timeoutInterval = 30
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        } catch {
            throw AuthError.message("Could not reach HushOS. Check your connection.")
        }
        let parsed = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        guard let http = response as? HTTPURLResponse, (200 ..< 300).contains(http.statusCode) else {
            if (response as? HTTPURLResponse)?.statusCode == 401 { throw AuthError.message("Your session ended. Sign in again.") }
            throw AuthError.message(parsed["message"] as? String ?? "Please try again.")
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
            throw AuthError.message("The current password is not right.")
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
            throw AuthError.message("The password is not right.")
        }
        _ = try await call("/api/auth/delete/finish", method: "POST", body: ["attemptToken": attemptToken, "finishLoginRequest": finish.request])
        SharedKeychain.delete(SharedKeychain.sessionAccount)
        SharedKeychain.delete(SharedKeychain.deviceAccount)
    }

    /* Recovery needs the recovery phrase and runs on the web for now. */
    public static func recoveryURL(origin: String) -> URL? { URL(string: origin + "/recover") }
    public static func billingURL(origin: String) -> URL? { URL(string: origin + "/app/billing") }

    // MARK: Key rotation

    static func identityEnvelope(from json: [String: Any]) -> IdentityEnvelope {
        let kem = (json["kem"] as? [String: Any]).map {
            IdentityKem(publicKey: $0["publicKey"] as? String ?? "", seedNonce: $0["seedNonce"] as? String ?? "",
                        encryptedSeed: $0["encryptedSeed"] as? String ?? "", signature: $0["signature"] as? String ?? "")
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
            kem: kem
        )
    }

    static func json(_ identity: IdentityEnvelope) -> [String: Any] {
        var out: [String: Any] = [
            "version": identity.version, "keyVersion": identity.keyVersion, "wrappingSalt": identity.wrappingSalt,
            "encryptionPublicKey": identity.encryptionPublicKey, "encryptionPrivateKeyNonce": identity.encryptionPrivateKeyNonce,
            "encryptedEncryptionPrivateKey": identity.encryptedEncryptionPrivateKey, "signingPublicKey": identity.signingPublicKey,
            "signingSeedNonce": identity.signingSeedNonce, "encryptedSigningSeed": identity.encryptedSigningSeed, "kem": NSNull(),
        ]
        if let kem = identity.kem {
            out["kem"] = ["publicKey": kem.publicKey, "seedNonce": kem.seedNonce, "encryptedSeed": kem.encryptedSeed, "signature": kem.signature]
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

    /* The recovery key envelope the server keeps, and whether the person confirmed saving the phrase. */
    public static func recoveryKey() async throws -> (envelope: RecoveryEnvelope, confirmed: Bool) {
        let reply = try await call("/api/auth/recovery-key")
        guard let json = reply["recovery"] as? [String: Any] else { throw AuthError.message("This account has no recovery key.") }
        return (recoveryEnvelope(from: json), reply["confirmed"] as? Bool ?? false)
    }

    /*
     * Rotates the master key, as the web's "Rotate keys" does: a fresh account
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
            throw AuthError.message("The password is not right.")
        }
        let old = envelope(from: envelopeJson)
        let oldRoot = try accountUnlock(userId: userId, exportKey: finish.exportKey, envelope: old)
        let newRoot = try randomBytes(length: 32)
        let keyVersion = old.keyVersion + 1
        let registered = try opaqueFinishRegistration(password: password, state: registration.state, registrationResponse: registrationResponse)
        let sealed = try accountSeal(userId: userId, exportKey: registered.exportKey, accountKey: newRoot, keyVersion: keyVersion, credentialVersion: old.credentialVersion + 1)
        let oldRecovery = recoveryEnvelope(from: recoveryJson)
        let recovery = try recoveryCreate(userId: userId, accountKey: newRoot, recoveryVersion: oldRecovery.recoveryVersion + 1, keyVersion: keyVersion)
        let identity = try identityRewrap(userId: userId, oldRoot: oldRoot, newRoot: newRoot, envelope: identityEnvelope(from: identityJson), keyVersion: keyVersion)
        let workspaces = try workspacesJson.map { try workspaceGrantRewrap(userId: userId, oldRoot: oldRoot, newRoot: newRoot, grant: grant(from: $0), keyVersion: keyVersion) }
        _ = try await call("/api/auth/security/finish", method: "POST", body: [
            "action": "master-key", "attemptToken": attemptToken, "finishLoginRequest": finish.request,
            "registrationRecord": registered.record,
            "envelope": [
                "envelopeVersion": sealed.envelopeVersion, "keyVersion": sealed.keyVersion, "credentialVersion": sealed.credentialVersion,
                "wrappingSalt": sealed.wrappingSalt, "wrappingNonce": sealed.wrappingNonce, "encryptedKey": sealed.encryptedKey,
            ],
            "recovery": json(recovery.envelope),
            "identity": json(identity),
            "workspaces": workspaces.map { json($0) },
        ])
        let memory = try deviceRemember(userId: userId, accountKey: newRoot, keyVersion: sealed.keyVersion, credentialVersion: sealed.credentialVersion, deviceKeyId: UUID().uuidString.lowercased())
        try SharedKeychain.write(SharedKeychain.deviceAccount, SharedKeychain.Device(memory: memory))
        return recovery.phrase
    }
}
