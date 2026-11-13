import AuthenticationServices
import HushOSCore
import HushOSKit
import UIKit

/*
 * The system's sheet for a passkey or security key (docs/two-step-design.md 3, 6, 12), for the host
 * this build is associated with (`webcredentials:` in its entitlements). Two ceremonies: a step's
 * assertion and a new key's registration, each with a passkey request and a security-key request
 * in one controller, so the sheet offers either. What a key is asked comes from the server through
 * the core; HushOSKit turns it into the bytes the providers take (`KeyAsk`, `KeyMake`) and the
 * key's answer back into what the server checks, so those are tested without a sheet.
 *
 * The sheet opens only from `assert` and `make`, and those are called only from a button's press
 * (`StepSending.answer`, the Add button). Both are held to the session they were asked under
 * (`KeySession.held`): signed out while the sheet was open, the key's answer is not sent. Whatever stops it (the person closed it, no key answered,
 * the system refused the request) is `KeyUnused`: nothing was sent, and the step or setup stands.
 */
enum PasskeySheet {
    /* A step's key. */
    static let assert: KeyAsker = { request in try await KeySession.held(unused: .atStep) { try await assertion(request) } }
    /* A new key for the account. */
    static let make: KeyMaker = { creation in try await KeySession.held(unused: .adding) { try await registration(creation) } }

    @MainActor
    private static func assertion(_ request: StepKeyRequest) async throws -> KeyAssertion {
        guard let ask = KeyAsk(request) else { throw KeyUnused.atStep }
        // No user verification is asked of either: the password was the knowledge factor.
        let passkey = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: ask.rpId)
            .createCredentialAssertionRequest(challenge: ask.challenge)
        passkey.allowedCredentials = ask.keys.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0.id) }
        passkey.userVerificationPreference = .discouraged
        var requests: [ASAuthorizationRequest] = [passkey]
        // Left out when every key is a passkey: a security-key request that named no key would take any.
        let securityKeys = ask.securityKeys
        if !securityKeys.isEmpty {
            let key = ASAuthorizationSecurityKeyPublicKeyCredentialProvider(relyingPartyIdentifier: ask.rpId)
                .createCredentialAssertionRequest(challenge: ask.challenge)
            key.allowedCredentials = securityKeys.map(descriptor)
            key.userVerificationPreference = .discouraged
            requests.append(key)
        }
        guard case .assertion(let made) = try await Ceremony(unused: .atStep).perform(requests) else { throw KeyUnused.atStep }
        return made
    }

    @MainActor
    private static func registration(_ creation: KeyCreation) async throws -> KeyRegistration {
        guard let make = KeyMake(creation) else { throw KeyUnused.adding }
        // No attestation, no resident key and no user verification, whatever a reply says: a second step needs none.
        let passkey = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: make.rpId)
            .createCredentialRegistrationRequest(challenge: make.challenge, name: make.userName, userID: make.userId)
        passkey.displayName = make.userDisplayName
        passkey.attestationPreference = .none
        passkey.userVerificationPreference = .discouraged
        passkey.excludedCredentials = make.exclude.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0.id) }
        let key = ASAuthorizationSecurityKeyPublicKeyCredentialProvider(relyingPartyIdentifier: make.rpId)
            .createCredentialRegistrationRequest(challenge: make.challenge, displayName: make.userDisplayName, name: make.userName, userID: make.userId)
        key.credentialParameters = make.algorithms.map { ASAuthorizationPublicKeyCredentialParameters(algorithm: ASCOSEAlgorithmIdentifier(rawValue: $0)) }
        key.attestationPreference = .none
        key.residentKeyPreference = .discouraged
        key.userVerificationPreference = .discouraged
        key.excludedCredentials = make.securityKeysExcluded.map(descriptor)
        guard case .registration(let made) = try await Ceremony(unused: .adding).perform([passkey, key]) else { throw KeyUnused.adding }
        return made
    }

    /* WebAuthn's names for what a security key connects over, as Apple's descriptors take them. */
    private static func transport(_ name: String) -> ASAuthorizationSecurityKeyPublicKeyCredentialDescriptor.Transport? {
        switch name {
        case "usb": .usb
        case "nfc": .nfc
        case "ble": .bluetooth
        default: nil
        }
    }

    /* And back, for what a new security key reports. */
    private static func name(_ transport: ASAuthorizationSecurityKeyPublicKeyCredentialDescriptor.Transport) -> String? {
        switch transport {
        case .usb: "usb"
        case .nfc: "nfc"
        case .bluetooth: "ble"
        default: nil
        }
    }

    private static func descriptor(_ key: KeyDescriptor) -> ASAuthorizationSecurityKeyPublicKeyCredentialDescriptor {
        ASAuthorizationSecurityKeyPublicKeyCredentialDescriptor(credentialID: key.id, transports: key.transports.compactMap(transport))
    }

    /* What a ceremony hands back, already cut down to what the server checks. */
    private enum Handed: Sendable {
        case assertion(KeyAssertion)
        case registration(KeyRegistration)
    }

    /* One run of the system's sheet, as async/await: its delegate, and where it is presented. */
    @MainActor
    private final class Ceremony: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
        private let unused: KeyUnused
        private var waiting: CheckedContinuation<Handed, Error>?
        private var controller: ASAuthorizationController?
        /* The window the press came from, found before the sheet is asked for. */
        private let anchor: UIWindow

        /* Throws `unused` with no window to present over (the app left the screen between the press and here): nothing is asked. */
        init(unused: KeyUnused) throws {
            let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
            guard let window = windows.first(where: \.isKeyWindow) ?? windows.first else { throw unused }
            self.unused = unused
            anchor = window
        }

        func perform(_ requests: [ASAuthorizationRequest]) async throws -> Handed {
            let controller = ASAuthorizationController(authorizationRequests: requests)
            controller.delegate = self
            controller.presentationContextProvider = self
            self.controller = controller
            return try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    waiting = continuation
                    // Every credential the account may hold, not only those on this phone: a security key is never "immediately available".
                    controller.performRequests()
                }
            } onCancel: {
                Task { @MainActor in self.controller?.cancel() }
            }
        }

        private func finish(_ result: Result<Handed, Error>) {
            let continuation = waiting
            waiting = nil
            controller = nil
            continuation?.resume(with: result)
        }

        func authorizationController(controller _: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
            switch authorization.credential {
            case let credential as ASAuthorizationPublicKeyCredentialAssertion:
                guard let authenticatorData = credential.rawAuthenticatorData, let signature = credential.signature else { return finish(.failure(unused)) }
                finish(.success(.assertion(KeyAssertion(
                    credentialID: credential.credentialID, rawClientDataJSON: credential.rawClientDataJSON, rawAuthenticatorData: authenticatorData, signature: signature
                ))))
            case let credential as ASAuthorizationPublicKeyCredentialRegistration:
                guard let attestation = credential.rawAttestationObject else { return finish(.failure(unused)) }
                // A passkey is reached on this phone or through another device; a security key says what it connects over.
                let transports = (credential as? ASAuthorizationSecurityKeyPublicKeyCredentialRegistration)
                    .map { $0.transports.compactMap(PasskeySheet.name) } ?? Passkeys.platformTransports
                finish(.success(.registration(KeyRegistration(
                    credentialID: credential.credentialID, rawClientDataJSON: credential.rawClientDataJSON, rawAttestationObject: attestation, transports: transports
                ))))
            default:
                finish(.failure(unused))
            }
        }

        /* Closed by the person (`ASAuthorizationError.canceled`), no key that answers, a request the system refused: all the same to the step. */
        func authorizationController(controller _: ASAuthorizationController, didCompleteWithError _: Error) {
            finish(.failure(unused))
        }

        func presentationAnchor(for _: ASAuthorizationController) -> ASPresentationAnchor { anchor }
    }
}
