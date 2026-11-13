import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * Passkeys and security keys as the second step, and the default (docs/two-step-design.md 3, 6, 12).
 * What these hold: the step opens on what the server put first; a key is never offered where it
 * could only fail, and never asked before a press; a key that did not answer sends nothing and
 * leaves the step as it was; `twoStepMethods` goes only where it is read; what the system's sheet
 * hands back reaches the server as the bytes the browser sends (the fixture both the core and the
 * web hold themselves to); and the settings say Default, Add, Remove and Turn off where each is true.
 */

private let token = String(repeating: "t", count: 43)
private let keyRequest = StepKeyRequest(
    challenge: "Y2hhbGxlbmdl", rpId: "hushos.com",
    keys: [StepKey(id: "c2VjdXJpdHkta2V5LW9uZQ", transports: ["usb", "nfc"]), StepKey(id: "c3luY2VkLXBhc3NrZXktdHdv", transports: [])]
)
private let assertion = KeyAssertion(credentialId: "c2VjdXJpdHkta2V5LW9uZQ", clientDataJson: "ZGF0YQ", authenticatorData: "YXV0aA", signature: "c2ln")

private func step(
    _ methods: [StepMethod], key: StepKeyRequest? = keyRequest, withheld: Bool = false, defaultUnavailable: Bool = false
) -> StepChallenge {
    StepChallenge(
        token: token, methods: methods, expiresAt: "2026-11-13T10:00:00.000Z",
        phrase: StepPhrase(userId: "0b8f6f0e-6a53-4f0e-9d3b-2f1f5b2c7a11", recoveryVersion: 2, wrappingSalt: "c2FsdA"),
        keyRequest: methods.contains(.webauthn) ? key : nil, withheld: withheld, defaultUnavailable: defaultUnavailable
    )
}

/* A key, for the tests: it counts what it was asked, and answers, closes its sheet, or is cancelled. */
private final class Key: @unchecked Sendable {
    enum Does { case answers, closed, cancelled }
    struct SheetClosed: Error {}
    private let lock = NSLock()
    private var all: [StepKeyRequest] = []
    let does: Does

    init(_ does: Does = .answers) { self.does = does }

    var asked: [StepKeyRequest] { lock.withLock { all } }

    var asker: KeyAsker {
        { request in
            self.lock.withLock { self.all.append(request) }
            switch self.does {
            case .answers: return assertion
            case .closed: throw SheetClosed()
            case .cancelled: throw CancellationError()
            }
        }
    }
}

/* Which server this build can use a key for: one pure rule. */
@Suite struct PasskeysUsableTests {
    @Test func onlyTheAppsOwnHostOverHttpsCanUseAKey() {
        #expect(passkeysUsable(serverOrigin: "https://hushos.com", linkHost: "hushos.com"))
        #expect(passkeysUsable(serverOrigin: "https://HushOS.com", linkHost: "hushos.com"))
        #expect(passkeysUsable(serverOrigin: "https://hushos.com:443", linkHost: "hushos.com"))
        // A self-hosted build is associated with its own host, and only that one.
        #expect(passkeysUsable(serverOrigin: "https://drive.example.org", linkHost: "drive.example.org"))
        #expect(!passkeysUsable(serverOrigin: "https://hushos.com", linkHost: "drive.example.org"))
    }

    @Test func aSelfHostedServerLocalhostAndAnythingThatOnlyLooksLikeTheHostCannot() {
        let refused = [
            "http://hushos.com", "http://localhost:5173", "https://localhost", "https://drive.example.org", "https://app.hushos.com",
            "https://hushos.com.example.org", "https://example.org/hushos.com", "https://hushos.com@example.org", "https://user:pass@hushos.com",
            // Another port is another origin to the server, and the system's sheet signs for the host alone.
            "https://hushos.com:8443", "hushos.com", "", "https://",
        ]
        for origin in refused { #expect(!passkeysUsable(serverOrigin: origin, linkHost: "hushos.com"), "\(origin)") }
    }

    @Test func aBuildThatNamesNoHostCanUseNone() {
        // The extensions and the tests carry no link host; a build setting left unexpanded is none either.
        for host in [nil, "", "  "] as [String?] { #expect(!passkeysUsable(serverOrigin: "https://hushos.com", linkHost: host)) }
        #expect(Passkeys.host(in: "$(HUSHOS_LINK_HOST)") == nil)
        #expect(Passkeys.host(in: "") == nil)
        #expect(Passkeys.host(in: nil) == nil)
        #expect(Passkeys.host(in: 7) == nil)
        #expect(Passkeys.host(in: "hushos.com") == "hushos.com")
    }
}

/* What the step's screen offers and says above its fields. */
@Suite struct StepOfferTests {
    @Test func theStepOpensOnWhatTheServerPutFirstInEitherOrder() {
        // The default is the server's to honour: the screen opens on its first method and keeps the rest in its order.
        let keyFirst = SignInStep(challenge: step([.webauthn, .totp, .backup, .phrase]), passkeys: true)
        #expect(keyFirst.shown == .webauthn)
        #expect(keyFirst.others == [.totp, .backup, .phrase])
        let appFirst = SignInStep(challenge: step([.totp, .webauthn, .backup, .phrase]), passkeys: true)
        #expect(appFirst.shown == .totp)
        #expect(appFirst.others == [.webauthn, .backup, .phrase])
        // Inside a change, the same.
        var change = StepUp(purpose: .password)
        change.take(step([.webauthn, .totp, .backup, .phrase]), passkeys: true)
        #expect(change.shown == .webauthn)
        #expect(change.others == [.totp, .backup, .phrase])
        change.take(step([.totp, .webauthn, .backup, .phrase]), passkeys: true)
        #expect(change.shown == .totp)
        #expect(change.others == [.webauthn, .backup, .phrase])
    }

    @Test func usingAnotherWayIsForThisStepOnlyAndNeverAWayThatIsNotOffered() {
        var asked = SignInStep(challenge: step([.webauthn, .totp, .backup, .phrase]), passkeys: true)
        asked.choose(.backup)
        #expect(asked.shown == .backup)
        #expect(asked.others == [.webauthn, .totp, .phrase])
        // Not offered on this step: the choice is not taken.
        var codes = SignInStep(challenge: step([.totp, .backup]), passkeys: true)
        codes.choose(.webauthn)
        #expect(codes.shown == .totp)
    }

    @Test func aKeyIsNeverOfferedWithoutWhatItIsAskedOrWhereThisPhoneCannotAskIt() {
        // Listed with nothing to ask it: a button that could only fail is not shown.
        var bare = step([.webauthn, .totp, .backup])
        bare.keyRequest = nil
        #expect(StepOffer.methods(bare, passkeys: true) == [.totp, .backup])
        #expect(SignInStep(challenge: bare, passkeys: true).shown == .totp)
        // A server this phone cannot use a key for (it named none, so this is a server that listed one anyway).
        let listed = step([.webauthn, .totp, .backup])
        #expect(StepOffer.methods(listed, passkeys: false) == [.totp, .backup])
        var change = StepUp(purpose: .delete)
        change.take(listed, passkeys: false)
        #expect(change.methods == [.totp, .backup])
        // Either way the usual way was first and is not on offer: said, with no reason.
        #expect(StepOffer.note(bare, passkeys: true, flow: .signIn) == "Your usual way isn’t available for this sign-in.")
        #expect(StepOffer.note(listed, passkeys: false, flow: .change) == "Your usual way isn’t available for this change.")
        // With what it is asked, on a phone that can ask it, it is offered.
        #expect(StepOffer.methods(listed, passkeys: true) == [.webauthn, .totp, .backup])
        // Left with a key as the only way it knew and no request for it: this build cannot answer at all.
        #expect(SignInStep(challenge: step([.webauthn], key: nil), passkeys: true).nothingLeft == StepWords.cannotAnswer)
    }

    @Test func theLineAboveTheFieldsIsOneOrTheOtherAndNeverBoth() {
        let update = "Update HushOS to use your passkey or another device."
        let signIn = "Your usual way isn’t available for this sign-in."
        let change = "Your usual way isn’t available for this change."
        // Nothing was left out and the usual way is first: nothing is said.
        #expect(StepOffer.note(step([.webauthn, .totp]), passkeys: true, flow: .signIn) == "")
        // A way was left out though this phone named every kind it knows: a newer HushOS has it.
        #expect(StepOffer.note(step([.totp, .backup], withheld: true), passkeys: true, flow: .signIn) == update)
        // Both flags: still one line, the update one.
        for flow in [StepFlow.signIn, .change] {
            #expect(StepOffer.note(step([.totp, .backup], withheld: true, defaultUnavailable: true), passkeys: true, flow: flow) == update)
        }
        // This phone held the key back itself (a server it cannot use one for): updating would not help, so only the usual-way line.
        #expect(StepOffer.note(step([.totp, .backup], withheld: true, defaultUnavailable: true), passkeys: false, flow: .signIn) == signIn)
        #expect(StepOffer.note(step([.totp, .backup], withheld: true), passkeys: false, flow: .signIn) == "")
        // The usual way is not first, whyever: the words follow where the step is asked.
        #expect(StepOffer.note(step([.totp, .backup], defaultUnavailable: true), passkeys: true, flow: .signIn) == signIn)
        #expect(StepOffer.note(step([.totp, .backup], defaultUnavailable: true), passkeys: true, flow: .change) == change)
        // The models say the same line.
        #expect(SignInStep(challenge: step([.totp], defaultUnavailable: true), passkeys: true).note == signIn)
        var form = StepUp(purpose: .password)
        #expect(form.note == "")
        form.take(step([.totp], defaultUnavailable: true), passkeys: true)
        #expect(form.note == change)
    }

    @Test func aSpentCodeBudgetLeavesTheKeyAndThePhraseAndOtherRefusalsTakeOnlyWhatTheyAreAbout() {
        let all: [StepMethod] = [.webauthn, .totp, .backup, .phrase]
        // The budget covers the app's codes and the backup codes; a key and the phrase have none.
        #expect(StepOutcome.left(all, after: .limited, tried: .totp) == [.webauthn, .phrase])
        #expect(StepOutcome.left(all, after: .frozen, tried: .totp) == [.webauthn, .backup, .phrase])
        #expect(StepOutcome.left(all, after: .unavailable, tried: .webauthn) == [.totp, .backup, .phrase])
        #expect(StepOutcome.left(all, after: .unavailable, tried: .backup) == [.webauthn, .totp, .phrase])
        // A wrong key answer keeps everything, in the server's words.
        let wrong = "That passkey or security key didn’t work. Try again, or use another way."
        #expect(StepOutcome.after(StepError.refused(.wrong, wrong), methods: all, tried: .webauthn) == .again(message: wrong, field: true, methods: all))
        // On the sign-in screen and inside a form alike.
        var screen = SignInStep(challenge: step(all), passkeys: true)
        screen.choose(.totp)
        #expect(screen.failed(StepError.refused(.limited, "Too many wrong codes."), tried: .totp, answer: nil) == nil)
        #expect(screen.methods == [.webauthn, .phrase])
        #expect(screen.shown == .webauthn)
        var form = StepUp(purpose: .password)
        form.take(step(all), passkeys: true)
        form.choose(.totp)
        #expect(form.failed(StepError.refused(.limited, "Too many wrong codes.")) == .again)
        #expect(form.methods == [.webauthn, .phrase])
    }
}

/* The key is asked on the press, and a key that did not answer changes nothing. */
@Suite struct KeyPressTests {
    @Test func nothingAsksTheKeyWhenTheStepAppearsOnlySendingWhatAPressReturnedDoes() async throws {
        let key = Key()
        var screen = SignInStep(challenge: step([.webauthn, .totp, .backup, .phrase]), passkeys: true)
        // Everything a screen reads to draw itself.
        _ = (screen.shown, screen.others, screen.note, screen.methods, screen.draft.problem(for: .webauthn), screen.nothingLeft)
        #expect(key.asked.isEmpty)
        // The press decides what goes: for a key, the request to ask, and still no sheet.
        let sendingPressed = screen.press()
        let sending = try #require(sendingPressed)
        #expect(sending == .key(token: token, request: keyRequest))
        #expect(sending.method == .webauthn)
        #expect(key.asked.isEmpty)
        // Sending it asks the key, once, exactly what the server's step asked.
        let answer = try await sending.answer(key: key.asker)
        #expect(key.asked == [keyRequest])
        #expect(answer == StepAnswer(token: token, proof: .webauthn(assertion: assertion)))
        #expect(answer.method == .webauthn)
        // Inside a form, the same: `prove` returns the request, and asks nothing.
        let other = Key()
        var form = StepUp(purpose: .twoStep)
        form.take(step([.webauthn, .totp]), passkeys: true)
        _ = (form.shown, form.others, form.note, form.problem)
        let proving = try form.prove()
        #expect(proving == .key(token: token, request: keyRequest))
        #expect(other.asked.isEmpty)
        // A typed method never asks a key at all.
        form.choose(.totp)
        form.draft.totp = "123456"
        let typedPressed = try form.prove()
        let typed = try #require(typedPressed)
        let code = try await typed.answer(key: other.asker)
        #expect(code == StepAnswer(token: token, proof: .totp(code: "123456")))
        #expect(other.asked.isEmpty)
    }

    @Test func aKeysAnswerIsTheJsonTheRoutesTake() throws {
        let sent = try StepAnswer(token: token, proof: .webauthn(assertion: assertion)).json()
        #expect(sent["token"] as? String == token)
        let proof = try #require(sent["proof"] as? [String: Any])
        #expect(proof["kind"] as? String == "webauthn")
        let response = try #require(proof["response"] as? [String: Any])
        #expect(response["id"] as? String == "c2VjdXJpdHkta2V5LW9uZQ")
        #expect((response["response"] as? [String: String]) == ["clientDataJSON": "ZGF0YQ", "authenticatorData": "YXV0aA", "signature": "c2ln"])
    }

    @Test func aClosedSheetInsideAChangeKeepsTheSameStepAndSaysSo() async throws {
        var form = StepUp(purpose: .twoStep)
        form.take(step([.webauthn, .totp, .backup]), passkeys: true)
        let sendingPressed = try form.prove()
        let sending = try #require(sendingPressed)
        let key = Key(.closed)
        var thrown: Error?
        do { _ = try await sending.answer(key: key.asker) } catch { thrown = error }
        // Whatever the sheet said, the step hears one thing: the key was not used.
        #expect(thrown as? KeyUnused == .atStep)
        let failure = try #require(thrown)
        #expect(form.failed(failure) == .again)
        #expect(form.problem == "Your passkey or security key wasn’t used. Try again, or use another way.")
        // The same step, every way still offered, and the key can be asked again.
        #expect(form.challenge?.token == token)
        #expect(form.methods == [.webauthn, .totp, .backup])
        #expect(form.shown == .webauthn)
        let again = try form.prove()
        #expect(again == .key(token: token, request: keyRequest))
        // The next press clears what the last one came to.
        #expect(form.problem == "")
        // With no step asked, a key's failure is not the step's.
        var none = StepUp(purpose: .password)
        #expect(none.failed(KeyUnused.atStep) == .notStep)
    }
}

/* What the system's sheet is asked and hands back, against the fixture the core and the web share. */
@Suite struct KeyBytesTests {
    static func fixture() throws -> [String: Any] {
        let here = URL(fileURLWithPath: #filePath)
        let file = here.deletingLastPathComponent().appendingPathComponent("../../../../../../crates/hushos-core/fixtures/two-step-keys.json").standardized
        return try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
    }

    static func text(_ value: Any?) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: try #require(value)), as: UTF8.self)
    }

    /* Base64url read by Foundation, not by the code under test. */
    static func bytes(_ base64url: Any?) throws -> Data {
        var text = try #require(base64url as? String).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while text.count % 4 != 0 { text += "=" }
        return try #require(Data(base64Encoded: text))
    }

    static func same(_ sent: [String: Any], _ expected: Any?) -> Bool {
        guard let expected = expected as? [String: Any] else { return false }
        return NSDictionary(dictionary: sent).isEqual(to: expected)
    }

    @Test func aStepsRequestReachesTheSheetAsTheServersBytes() throws {
        let fixture = try Self.fixture()
        guard case .step(let challenge) = signInReplyRead(status: 200, body: try Self.text(["twoStep": fixture["step"]])) else {
            Issue.record("The fixture's step was not read as one.")
            return
        }
        #expect(challenge.methods == [.webauthn, .totp, .backup, .phrase])
        let request = try #require(challenge.keyRequest)
        let ask = try #require(KeyAsk(request))
        let web = try #require(fixture["request"] as? [String: Any])
        let allowed = try #require(web["allowCredentials"] as? [[String: Any]])
        #expect(ask.rpId == web["rpId"] as? String)
        #expect(ask.challenge == (try Self.bytes(web["challenge"])))
        #expect(ask.keys.map(\.id) == (try allowed.map { try Self.bytes($0["id"]) }))
        // A security key is named with the transports it reported; one that reported none, with all a security key uses.
        #expect(ask.securityKeys.map(\.transports) == [["usb", "nfc"], ["usb", "nfc", "ble"]])
        #expect(ask.securityKeys.map(\.id) == ask.keys.map(\.id))
    }

    @Test func aPasskeyIsLeftOutOfTheSecurityKeyRequestAndARequestThatIsNotBytesIsNotAsked() {
        // `internal` and `hybrid` are a passkey's: the platform's own request covers it, and a security-key request that
        // named no key would take any.
        #expect(Passkeys.securityKeyTransports(["internal", "hybrid"]) == nil)
        #expect(Passkeys.securityKeyTransports(["hybrid", "nfc", "usb"]) == ["usb", "nfc"])
        #expect(Passkeys.securityKeyTransports([]) == ["usb", "nfc", "ble"])
        let passkeyOnly = StepKeyRequest(challenge: "Y2g", rpId: "hushos.com", keys: [StepKey(id: "a2V5", transports: ["internal", "hybrid"])])
        #expect(KeyAsk(passkeyOnly)?.securityKeys.isEmpty == true)
        #expect(KeyAsk(passkeyOnly)?.keys.count == 1)
        // A request cut short is not asked in part: the sheet would then take a key the server did not name.
        #expect(KeyAsk(StepKeyRequest(challenge: "not base64url!", rpId: "hushos.com", keys: keyRequest.keys)) == nil)
        #expect(KeyAsk(StepKeyRequest(challenge: "Y2g", rpId: "hushos.com", keys: [StepKey(id: "a2V5", transports: []), StepKey(id: "***", transports: [])])) == nil)
        #expect(KeyAsk(StepKeyRequest(challenge: "Y2g", rpId: "hushos.com", keys: [])) == nil)
        #expect(KeyAsk(StepKeyRequest(challenge: "Y2g", rpId: "", keys: keyRequest.keys)) == nil)
    }

    @Test func whatTheSheetHandsBackGoesOutAsTheAnswerTheBrowserSends() throws {
        let fixture = try Self.fixture()
        let handed = try #require(fixture["handedAssertion"] as? [String: Any])
        let response = try #require(handed["response"] as? [String: Any])
        // The raw bytes, as ASAuthorization's assertion carries them.
        let made = KeyAssertion(
            credentialID: try Self.bytes(handed["rawId"]), rawClientDataJSON: try Self.bytes(response["clientDataJSON"]),
            rawAuthenticatorData: try Self.bytes(response["authenticatorData"]), signature: try Self.bytes(response["signature"])
        )
        // The same four fields the core cuts the browser's JSON down to.
        #expect(made == keyAssertionRead(handed: try Self.text(handed)))
        let sent = try StepAnswer(token: try #require(fixture["token"] as? String), proof: .webauthn(assertion: made)).json()
        #expect(Self.same(sent, fixture["answer"]))
    }

    @Test func aNewKeyIsAskedForWhatThisPhoneCanMakeAndItsAnswerIsTheBodyTheBrowserSends() throws {
        let fixture = try Self.fixture()
        guard case .options(let creation) = keyOptionsReplyRead(status: 200, body: try Self.text(fixture["options"])) else {
            Issue.record("The fixture's options were not read.")
            return
        }
        let options = try #require((fixture["options"] as? [String: Any])?["options"] as? [String: Any])
        let user = try #require(options["user"] as? [String: Any])
        let make = try #require(KeyMake(creation))
        #expect(make.rpId == "hushos.com")
        #expect(make.challenge == (try Self.bytes(options["challenge"])))
        #expect(make.userId == (try Self.bytes(user["id"])))
        #expect(make.userName == "maya@example.org")
        // The server prefers EdDSA and also takes RS256; Apple's providers make ES256 only.
        #expect(creation.algorithms == [-8, -7, -257])
        #expect(make.algorithms == [-7])
        #expect(make.exclude.map(\.id) == [try Self.bytes("c2VjdXJpdHkta2V5LW9uZQ")])
        #expect(make.securityKeysExcluded.map(\.transports) == [["usb", "nfc"]])
        // A server that offers nothing this phone can make is not asked for a key it would refuse.
        var edOnly = creation
        edOnly.algorithms = [-8]
        #expect(KeyMake(edOnly) == nil)

        let handed = try #require(fixture["handedRegistration"] as? [String: Any])
        let response = try #require(handed["response"] as? [String: Any])
        let made = KeyRegistration(
            credentialID: try Self.bytes(handed["rawId"]), rawClientDataJSON: try Self.bytes(response["clientDataJSON"]),
            rawAttestationObject: try Self.bytes(response["attestationObject"]), transports: Passkeys.platformTransports
        )
        #expect(made == keyRegistrationRead(handed: try Self.text(handed)))
        let body = keyRegistrationJson(registrationToken: creation.registrationToken, name: fixture["registrationName"] as? String, registration: made)
        let sent = try #require(try JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any])
        #expect(Self.same(sent, fixture["registrationBody"]))
    }

    @Test func bytesGoOutAsBase64urlWithoutPaddingWhateverTheirLength() {
        // 0xfb 0xff: `+/` in plain base64, `-_` here; lengths one and two would be padded there.
        let made = KeyAssertion(credentialID: Data([0xFB]), rawClientDataJSON: Data([0xFB, 0xFF]), rawAuthenticatorData: Data([0xFB, 0xFF, 0xFE]), signature: Data([0, 0, 0, 0]))
        #expect(made == KeyAssertion(credentialId: "-w", clientDataJson: "-_8", authenticatorData: "-__-", signature: "AAAAAA"))
        let added = KeyRegistration(credentialID: Data([0xFB]), rawClientDataJSON: Data([0xFB, 0xFF]), rawAttestationObject: Data([0xFF, 0xFF, 0xFF, 0xFF]), transports: [])
        #expect(added == KeyRegistration(credentialId: "-w", clientDataJson: "-_8", attestationObject: "_____w", transports: []))
    }
}

/* `twoStepMethods`: sent only where it is read, asked once more without it when refused. */
@Suite struct StepMethodsFieldTests {
    /* A server that answers each request it is sent, in turn, and keeps what it was sent. */
    final class Asked: @unchecked Sendable {
        var bodies: [[String: Any]] = []
        var answers: [Int]
        init(_ answers: [Int]) { self.answers = answers }
        func send(_ body: [String: Any]) -> Int {
            bodies.append(body)
            return answers.isEmpty ? 200 : answers.removeFirst()
        }
    }

    let body: [String: Any] = ["attemptToken": "attempt", "finishLoginRequest": "ke3", "twoStep": 1]

    func send(_ advert: StepAdvert, _ server: Asked, named: [String] = ["webauthn"]) async throws -> StepMethodsField.Sent<Int> {
        try await StepMethodsField.send(advert: advert, named: named, body: body, status: { $0 }) { server.send($0) }
    }

    @Test func theFieldGoesOnlyToAServerThatReadsItOrWasNeverHeardEitherWay() async throws {
        for advert in [StepAdvert.advertised, .neverSeen] {
            let server = Asked([200])
            let sent = try await send(advert, server)
            #expect(server.bodies.count == 1)
            #expect(server.bodies.first?["twoStepMethods"] as? [String] == ["webauthn"])
            // `twoStep: 1` is still there: an older schema takes nothing else in that field.
            #expect(server.bodies.first?["twoStep"] as? Int == 1)
            #expect(!sent.unread)
        }
        // A server that did not say so never sees the field, and a 400 from it is its own answer: nothing is asked twice.
        let old = Asked([400])
        let sent = try await send(.notAdvertised, old)
        #expect(old.bodies.count == 1)
        #expect(old.bodies.first?["twoStepMethods"] == nil)
        #expect(sent.reply == 400)
        #expect(!sent.unread)
        // A phone that can use no key for this server still says so, with an empty list.
        let none = Asked([200])
        _ = try await send(.advertised, none, named: [])
        #expect((none.bodies.first?["twoStepMethods"] as? [String])?.isEmpty == true)
    }

    @Test func aSchemaRefusalIsAskedOnceMoreWithoutTheFieldOnTheSameAttempt() async throws {
        for status in [400, 422] {
            let server = Asked([status, 200])
            let sent = try await send(.advertised, server)
            #expect(server.bodies.count == 2, "\(status)")
            #expect(server.bodies[0]["twoStepMethods"] != nil)
            #expect(server.bodies[1]["twoStepMethods"] == nil)
            // The same request otherwise: the attempt was not used up, and it is not started over.
            #expect(NSDictionary(dictionary: server.bodies[1]).isEqual(to: body))
            #expect(server.bodies[0]["attemptToken"] as? String == "attempt")
            #expect(sent.reply == 200)
            #expect(sent.unread)
        }
        // Any other refusal is the request's own answer: a wrong password is not sent twice.
        for status in [401, 403, 409, 429, 500] {
            let server = Asked([status, 200])
            let sent = try await send(.advertised, server)
            #expect(server.bodies.count == 1, "\(status)")
            #expect(sent.reply == status)
        }
        // Refused without the field too: it was never the field. Once more only, and nothing is learnt about the server.
        let broken = Asked([400, 400, 200])
        let sent = try await send(.neverSeen, broken)
        #expect(broken.bodies.count == 2)
        #expect(sent.reply == 400)
        #expect(!sent.unread)
    }

    @Test func whatEachServerSaidIsKeptByItsOrigin() {
        let memory = AdvertMemory()
        let adverts = memory.adverts
        #expect(adverts.state(for: "https://hushos.com") == .neverSeen)
        adverts.remember(true, for: "https://hushos.com")
        adverts.remember(false, for: "https://drive.example.org")
        #expect(adverts.state(for: "https://hushos.com") == .advertised)
        #expect(adverts.state(for: "https://drive.example.org") == .notAdvertised)
        // Another server was never heard: one server's answer says nothing of it.
        #expect(adverts.state(for: "https://other.example.org") == .neverSeen)
        adverts.remember(false, for: "https://hushos.com")
        #expect(adverts.state(for: "https://hushos.com") == .notAdvertised)
        #expect(adverts.state(for: "https://drive.example.org") == .notAdvertised)
        // What a later launch reads is what was kept, not what this object remembers.
        #expect(memory.adverts.state(for: "https://hushos.com") == .notAdvertised)
        #expect(memory.kept.mapValues(\.advertised) == ["https://hushos.com": false, "https://drive.example.org": false])
    }

    @Test func aServerThatDidNotReadTheFieldIsBelievedForADayAndThenAskedAgain() {
        let memory = AdvertMemory()
        let heard = Date(timeIntervalSince1970: 1_800_000_000)
        memory.adverts(at: heard).remember(false, for: "https://hushos.com")
        memory.adverts(at: heard).remember(true, for: "https://drive.example.org")
        // Within the day the answer stands, and hearing it again does not stretch the day.
        let nearly = heard.addingTimeInterval(StepAdverts.noFor - 1)
        #expect(memory.adverts(at: nearly).state(for: "https://hushos.com") == .notAdvertised)
        memory.adverts(at: nearly).remember(false, for: "https://hushos.com")
        #expect(memory.kept["https://hushos.com"]?.at == heard)
        // A day on, the server may have been updated: never heard again, so the field is tried once
        // more. Believed for ever, a session's passkey would never be offered at a change.
        let later = heard.addingTimeInterval(StepAdverts.noFor)
        #expect(memory.adverts(at: later).state(for: "https://hushos.com") == .neverSeen)
        // "It reads the field" has no such end: every sign-in says it again.
        #expect(memory.adverts(at: later.addingTimeInterval(30 * 24 * 60 * 60)).state(for: "https://drive.example.org") == .advertised)
        // Refused again after the day: remembered again, from now.
        memory.adverts(at: later).remember(false, for: "https://hushos.com")
        #expect(memory.kept["https://hushos.com"]?.at == later)
        #expect(memory.adverts(at: later.addingTimeInterval(60)).state(for: "https://hushos.com") == .notAdvertised)
        // A clock set back does not stretch the day: a time from the future is not believed.
        #expect(memory.adverts(at: heard).state(for: "https://hushos.com") == .neverSeen)
    }
}

/* A key's sheet can outlast the session it was opened under: what it hands back then is not sent. */
struct KeySessionTests {
    /* The session in use, as the keychain would say it: changed by the test while the sheet is "open". */
    final class Current: @unchecked Sendable {
        private let lock = NSLock()
        private var tag: String?
        init(_ tag: String?) { self.tag = tag }
        var now: String? { lock.withLock { tag } }
        func become(_ next: String?) { lock.withLock { tag = next } }
    }

    @Test func aKeyThatAnswersAfterASignOutIsNotHandedOn() async throws {
        for after in [nil, "another-session"] as [String?] {
            let current = Current("the-session")
            await #expect(throws: KeyUnused.adding) {
                _ = try await KeySession.held(unused: .adding, session: { current.now }) {
                    // The device is removed, or someone else signs in, while the sheet is up.
                    current.become(after)
                    return "a registration"
                }
            }
        }
        // A sign-in that completed while a step's sheet was up is another session too.
        let signedOut = Current(nil)
        await #expect(throws: KeyUnused.atStep) {
            _ = try await KeySession.held(unused: .atStep, session: { signedOut.now }) {
                signedOut.become("a-session")
                return "an assertion"
            }
        }
    }

    @Test func underTheSameSessionOrNoneTheKeysAnswerIsHandedOn() async throws {
        let current = Current("the-session")
        #expect(try await KeySession.held(unused: .adding, session: { current.now }) { "a registration" } == "a registration")
        // A sign-in's step has no session yet, before or after.
        let none = Current(nil)
        #expect(try await KeySession.held(unused: .atStep, session: { none.now }) { "an assertion" } == "an assertion")
        // The sheet's own failure is the sheet's: thrown on as it was.
        await #expect(throws: KeyUnused.atStep) {
            _ = try await KeySession.held(unused: .adding, session: { current.now }) { () async throws -> String in throw KeyUnused.atStep }
        }
    }
}

/* What a launch keeps of the adverts, in memory. */
final class AdvertMemory: @unchecked Sendable {
    private let lock = NSLock()
    private var all: [String: StepAdverts.Kept]
    init(_ kept: [String: Bool] = [:], at: Date = Date()) { all = kept.mapValues { StepAdverts.Kept(advertised: $0, at: at) } }
    var kept: [String: StepAdverts.Kept] { lock.withLock { all } }
    var adverts: StepAdverts {
        StepAdverts(load: { self.lock.withLock { self.all } }, save: { next in self.lock.withLock { self.all = next } })
    }
    /* The same memory, read and written as at `moment`. */
    func adverts(at moment: Date) -> StepAdverts {
        StepAdverts(load: { self.lock.withLock { self.all } }, save: { next in self.lock.withLock { self.all = next } }, now: { moment })
    }
}

/* Account › Two-step sign-in: what each row says and offers. */
@Suite struct KeySettingsTests {
    func status(keys: Int = 0, app: Bool = false, synced: Bool = false, defaultKind: String? = nil) throws -> TwoStepStatus {
        var methods: [[String: Any]] = (0 ..< keys).map { index in
            ["id": "k\(index)", "kind": "webauthn", "name": "Key \(index)", "createdAt": "2026-11-14T09:30:00.000Z", "lastUsedAt": NSNull(), "synced": synced && index == 0]
        }
        if app { methods.append(["id": "app", "kind": "totp", "name": NSNull(), "createdAt": "2026-11-12T09:30:00.000Z", "lastUsedAt": NSNull(), "synced": false]) }
        let json: [String: Any] = ["on": !methods.isEmpty, "methods": methods, "backupCodesLeft": 10, "totpFrozen": false, "defaultKind": defaultKind ?? NSNull()]
        return try #require(TwoStepStatus(json))
    }

    @Test func theSettingsListKeysWithWhereTheyLiveAndWhenTheyWereUsed() throws {
        let read = try #require(TwoStepStatus([
            "on": true, "backupCodesLeft": 8, "totpFrozen": false, "defaultKind": "webauthn",
            "methods": [
                ["id": "k1", "kind": "webauthn", "name": "Desk key", "createdAt": "2026-11-14T09:30:00.000Z", "lastUsedAt": NSNull(), "synced": false],
                ["id": "k2", "kind": "webauthn", "name": "iCloud Keychain", "createdAt": "2026-11-14T09:30:00.000Z", "lastUsedAt": "2026-11-14T18:00:00.000Z", "synced": true],
                ["id": "a", "kind": "totp", "name": NSNull(), "createdAt": "2026-11-12T09:30:00.000Z", "lastUsedAt": NSNull(), "synced": false],
            ],
        ]))
        #expect(read.keys.map(\.id) == ["k1", "k2"])
        #expect(read.app?.id == "a")
        #expect(read.defaultKind == "webauthn")
        let day: (Date) -> String = { _ in "14 Nov" }
        #expect(read.keys[0].line(day: day) == "Added 14 Nov")
        #expect(read.keys[1].line(day: day) == "Saved in a password manager · Added 14 Nov · Last used 14 Nov")
        #expect(read.keys[0].shownName == "Desk key")
        #expect(TwoStepStatus.Method(id: "k", kind: "webauthn", name: nil, createdAt: nil, lastUsedAt: nil).shownName == "Security key")
        // A server from before the default names none; nothing is guessed.
        #expect(try status(app: true).defaultKind == nil)
    }

    @Test func theDefaultBadgeFollowsTheServersDefaultAndIsThereOnlyWithBothKinds() throws {
        let keyFirst = try status(keys: 1, app: true, defaultKind: "webauthn")
        #expect(keyFirst.isDefault(.webauthn) && !keyFirst.isDefault(.totp))
        #expect(keyFirst.canMakeDefault(.totp) && !keyFirst.canMakeDefault(.webauthn))
        let appFirst = try status(keys: 2, app: true, defaultKind: "totp")
        #expect(appFirst.isDefault(.totp) && !appFirst.isDefault(.webauthn))
        #expect(appFirst.canMakeDefault(.webauthn) && !appFirst.canMakeDefault(.totp))
        // One kind: nothing to choose, so neither a badge nor a button, whatever the default says.
        for one in [try status(keys: 2, defaultKind: "webauthn"), try status(app: true, defaultKind: "totp")] {
            #expect(!one.choosing)
            for kind in [StepKind.webauthn, .totp] { #expect(!one.isDefault(kind) && !one.canMakeDefault(kind)) }
        }
        // A default this build cannot show (another device): no badge here, and either kind can be made the default.
        let device = try status(keys: 1, app: true, defaultKind: "device")
        for kind in [StepKind.webauthn, .totp] { #expect(!device.isDefault(kind) && device.canMakeDefault(kind)) }
        #expect(StepKind.webauthn.nowFirst == "Passkey or security key is now asked for first.")
        #expect(StepKind.totp.nowFirst == "Authenticator app is now asked for first.")
    }

    @Test func theLastMethodIsTurnedOffAndAnyOtherIsRemoved() throws {
        #expect(try status(keys: 1).removeWords == "Turn off")
        #expect(try status(app: true).removeWords == "Turn off")
        #expect(try status(keys: 1, app: true).removeWords == "Remove")
        #expect(try status(keys: 2).removeWords == "Remove")
        #expect(try status(keys: 1).removesLast)
        #expect(try !status(keys: 2).removesLast)
        // What is said afterwards follows the server's answer, not the guess made before.
        #expect(TwoStep.removedWords(kind: "webauthn", on: true) == "Passkey or security key removed.")
        #expect(TwoStep.removedWords(kind: "totp", on: true) == "Authenticator app removed.")
        #expect(TwoStep.removedWords(kind: "webauthn", on: false) == "Two-step sign-in is off.")
    }

    @Test func addIsOfferedOnlyWhereThisPhoneCanMakeAKeyAndBelowTen() throws {
        #expect(try status().canAddKey(passkeys: true))
        #expect(try status(keys: 9, app: true).canAddKey(passkeys: true))
        #expect(try !status(keys: 10).canAddKey(passkeys: true))
        // A self-hosted server: its keys are listed, renamed and removed here, never added.
        #expect(try !status().canAddKey(passkeys: false))
        #expect(try !status(keys: 1).canAddKey(passkeys: false))
        let browser = "Passkeys and security keys are added in a browser on this server. You can rename or remove them here."
        #expect(try status().keyNotes(passkeys: false) == [browser])
        #expect(try status().keyNotes(passkeys: true) == [])
    }

    @Test func eachNoteUnderTheKeysIsThereOnlyWhileItIsTrue() throws {
        let synced = "A passkey saved in the same password manager as your password is one factor, not two: whoever opens the manager has both."
        let another = "A passkey stops a fake sign-in page only when you use it. A fake page can ask you to use another way instead."
        let second = "Add a second key and keep it somewhere else, in case this one is lost."
        let ten = "You have ten, the most an account can have."
        #expect(try status(keys: 1).keyNotes(passkeys: true) == [second])
        #expect(try status(keys: 2).keyNotes(passkeys: true) == [])
        #expect(try status(keys: 1, synced: true).keyNotes(passkeys: true) == [synced, second])
        #expect(try status(keys: 2, app: true).keyNotes(passkeys: true) == [another])
        // The app alone: a fake page has no key to steer anyone away from.
        #expect(try status(app: true).keyNotes(passkeys: true) == [])
        #expect(try status(keys: 10).keyNotes(passkeys: true) == [ten])
        #expect(try status(keys: 1, app: true, synced: true).keyNotes(passkeys: false) == [synced, another, second, StepWords.keysInBrowser])
    }

    @Test func aKeysNameIsCheckedHereAsTheServerCountsIt() {
        #expect(TwoStep.nameProblem("", required: true) == "Enter a name.")
        #expect(TwoStep.nameProblem("   ", required: true) == "Enter a name.")
        // Adding a key, the name is optional: the server names it otherwise.
        #expect(TwoStep.nameProblem("  ", required: false) == nil)
        #expect(TwoStep.nameProblem(String(repeating: "k", count: 40), required: true) == nil)
        #expect(TwoStep.nameProblem(" " + String(repeating: "k", count: 40) + " ", required: true) == nil)
        #expect(TwoStep.nameProblem(String(repeating: "k", count: 41), required: false) == "Use no more than 40 characters.")
    }
}

extension OnFakeDrive {
    /* The requests themselves, against a server that answers as the real one does. */
    @Suite struct PasskeyRequestTests {
        let origin = "https://hushos.com"
        let stepReply = "{\"token\":\"\(token)\",\"methods\":[\"webauthn\",\"totp\",\"backup\"],\"expiresAt\":\"2026-11-13T10:00:00.000Z\",\"webauthn\":{\"challenge\":\"Y2hhbGxlbmdl\",\"rpId\":\"hushos.com\",\"allowCredentials\":[{\"id\":\"a2V5\",\"type\":\"public-key\",\"transports\":[\"usb\"]}]}}"

        func serve(_ server: StepServer, origin: String? = nil) {
            StepServer.current = server
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [StepServerProtocol.self]
            Auth.testTransport = configuration
            Auth.testSession = SharedKeychain.Session(origin: origin ?? self.origin, token: "session-token", userId: "u")
        }

        func done() { Auth.testSession = nil; Auth.testTransport = nil; StepServer.current = nil }

        var pending: PendingSignIn {
            PendingSignIn(origin: origin, email: "maya@example.org", challenge: step([.webauthn, .totp, .backup, .phrase]), exportKey: Data(repeating: 1, count: 64))
        }

        @Test func aClosedSheetSendsNothingAndTheStepCanStillBeAnswered() async throws {
            let server = StepServer(401, json: ["message": "That code didn’t work. Codes change every 30 seconds.", "code": "step-wrong"])
            serve(server)
            defer { done() }
            var screen = SignInStep(challenge: pending.challenge, passkeys: true)
            let sendingPressed = screen.press()
            let sending = try #require(sendingPressed)
            let key = Key(.closed)
            var made: [StepAnswer] = []
            var thrown: Error?
            do { _ = try await Auth.answerStep(pending, sending: sending, key: key.asker) { made.append($0) } } catch { thrown = error }
            // The key was asked, said no, and nothing left the phone: no request, and no answer to send again.
            #expect(key.asked.count == 1)
            #expect(server.requests.isEmpty)
            #expect(made.isEmpty)
            #expect(thrown as? KeyUnused == .atStep)
            // The step is as it was, with why under its label.
            let failure = try #require(thrown)
            #expect(screen.failed(failure, tried: sending.method, answer: made.last) == nil)
            #expect(screen.fieldError == "Your passkey or security key wasn’t used. Try again, or use another way.")
            #expect(screen.notice == "")
            #expect(screen.lost == nil)
            #expect(screen.methods == [.webauthn, .totp, .backup, .phrase])
            #expect(screen.shown == .webauthn)
            // Another way on the same step reaches the server, under the same token.
            screen.choose(.totp)
            #expect(screen.fieldError == "")
            screen.draft.totp = "123456"
            let typedPressed = screen.press()
            let typed = try #require(typedPressed)
            do { _ = try await Auth.answerStep(pending, sending: typed, key: key.asker) } catch { thrown = error }
            #expect(key.asked.count == 1)
            #expect(server.requests.count == 1)
            #expect(server.requests.first?.path == "/api/auth/login/two-step")
            #expect(server.requests.first?.body["token"] as? String == token)
            #expect(thrown as? StepError == .refused(.wrong, "That code didn’t work. Codes change every 30 seconds."))
        }

        @Test func aCancelledTaskSendsNothingAndSaysNothing() async throws {
            let server = StepServer(200, "{}")
            serve(server)
            defer { done() }
            var screen = SignInStep(challenge: pending.challenge, passkeys: true)
            let sendingPressed = screen.press()
            let sending = try #require(sendingPressed)
            var thrown: Error?
            do { _ = try await Auth.answerStep(pending, sending: sending, key: Key(.cancelled).asker) } catch { thrown = error }
            #expect(thrown is CancellationError)
            #expect(server.requests.isEmpty)
            let failure = try #require(thrown)
            #expect(screen.failed(failure, tried: .webauthn, answer: nil) == nil)
            #expect(screen.fieldError == "" && screen.notice == "")
            #expect(screen.methods == [.webauthn, .totp, .backup, .phrase])
        }

        @Test func aKeysAnswerGoesToTheStepRouteAndALostReplySendsTheSameOneAgainWithoutAskingTwice() async throws {
            let server = StepServer(502, "<html>Bad gateway</html>")
            serve(server)
            defer { done() }
            var screen = SignInStep(challenge: pending.challenge, passkeys: true)
            let sendingPressed = screen.press()
            let sending = try #require(sendingPressed)
            let key = Key()
            var made: [StepAnswer] = []
            var thrown: Error?
            do { _ = try await Auth.answerStep(pending, sending: sending, key: key.asker) { made.append($0) } } catch { thrown = error }
            #expect(server.requests.count == 1)
            let proof = try #require(server.requests.first?.body["proof"] as? [String: Any])
            #expect(proof["kind"] as? String == "webauthn")
            #expect(((proof["response"] as? [String: Any])?["response"] as? [String: String])?["signature"] == "c2ln")
            // The reply was lost: the key's answer is kept, and the next press sends it as it is.
            let failure = try #require(thrown)
            #expect(screen.failed(failure, tried: .webauthn, answer: made.last) == nil)
            #expect(screen.notice == StepWords.lostStep)
            #expect(screen.lost == StepAnswer(token: token, proof: .webauthn(assertion: assertion)))
            let againPressed = screen.press()
            let again = try #require(againPressed)
            #expect(again == .ready(StepAnswer(token: token, proof: .webauthn(assertion: assertion))))
            _ = try? await Auth.answerStep(pending, sending: again, key: key.asker)
            #expect(key.asked.count == 1)
            #expect(server.requests.count == 2)
        }

        @Test func aStepForAChangeNamesAKeyOnlyToTheAppsOwnServer() async throws {
            serve(StepServer(200, stepReply))
            defer { done() }
            // The app's own server, never heard either way (a session from before this build): the key is named.
            let asked = try await TwoStep.challenge(.password, adverts: AdvertMemory().adverts, linkHost: "hushos.com")
            #expect(asked?.methods == [.webauthn, .totp, .backup])
            #expect(asked?.keyRequest?.rpId == "hushos.com")
            #expect(StepServer.current?.requests.last?.body["twoStepMethods"] as? [String] == ["webauthn"])
            #expect(StepServer.current?.requests.last?.body["purpose"] as? String == "password")
            // A self-hosted server, though it reads the field: this phone names no key, so it is never listed one.
            for (origin, host) in [("https://drive.example.org", "hushos.com"), ("http://localhost:5173", "hushos.com"), ("https://hushos.com", nil)] as [(String, String?)] {
                serve(StepServer(200, stepReply), origin: origin)
                _ = try await TwoStep.challenge(.password, adverts: AdvertMemory([origin: true]).adverts, linkHost: host)
                let named = StepServer.current?.requests.last?.body["twoStepMethods"] as? [String]
                #expect(named?.isEmpty == true, "\(origin)")
            }
        }

        @Test func aServerThatDoesNotReadTheFieldIsAskedWithoutItAndRemembered() async throws {
            // A server rolled back since the sign-in: its schema refuses the field, and takes the request without it.
            let refuses = StepServer(200, stepReply)
            refuses.script = { body in body["twoStepMethods"] == nil ? nil : (400, "{\"message\":\"Invalid request.\"}") }
            for start in [true, nil] as [Bool?] {
                serve(refuses)
                let memory = AdvertMemory(start.map { [origin: $0] } ?? [:])
                let before = refuses.requests.count
                #expect(try await TwoStep.challenge(.masterKey, adverts: memory.adverts, linkHost: "hushos.com")?.token == token)
                #expect(refuses.requests.count == before + 2)
                #expect(refuses.requests[before].body["twoStepMethods"] != nil)
                #expect(refuses.requests[before + 1].body["twoStepMethods"] == nil)
                #expect(refuses.requests[before + 1].body["purpose"] as? String == "master-key")
                #expect(memory.adverts.state(for: origin) == .notAdvertised)
                // From then on it is asked once, without.
                _ = try await TwoStep.challenge(.masterKey, adverts: memory.adverts, linkHost: "hushos.com")
                #expect(refuses.requests.count == before + 3)
                #expect(refuses.requests[before + 2].body["twoStepMethods"] == nil)
            }
            done()
            // A server that said it does not read it is never sent it.
            let old = StepServer(200, "{\"token\":\"\(token)\",\"methods\":[\"totp\"],\"expiresAt\":\"2026-11-13T10:00:00.000Z\"}")
            serve(old)
            defer { done() }
            _ = try await TwoStep.challenge(.delete, adverts: AdvertMemory([origin: false]).adverts, linkHost: "hushos.com")
            #expect(old.requests.count == 1)
            #expect(old.requests.first?.body["twoStepMethods"] == nil)
            // An account without the step (409) is not a refusal of the field: nothing is asked twice or remembered.
            let memory = AdvertMemory([origin: true])
            StepServer.current = StepServer(409, json: ["message": "Two-step sign-in is off for this account."])
            #expect(try await TwoStep.challenge(.password, adverts: memory.adverts, linkHost: "hushos.com") == nil)
            #expect(StepServer.current?.requests.count == 1)
            #expect(memory.adverts.state(for: origin) == .advertised)
            // A request refused with or without the field was never about the field: the server is still one that reads it.
            StepServer.current = StepServer(400, json: ["message": "Invalid request."])
            await #expect(throws: (any Error).self) { _ = try await TwoStep.challenge(.password, adverts: memory.adverts, linkHost: "hushos.com") }
            #expect(StepServer.current?.requests.count == 2)
            #expect(memory.adverts.state(for: origin) == .advertised)
        }

        @Test func theSettingsAlwaysNameTheKindsThisBuildCanList() async throws {
            serve(StepServer(200, json: [
                "on": true, "backupCodesLeft": 9, "totpFrozen": false, "defaultKind": "webauthn",
                "methods": [["id": "k", "kind": "webauthn", "name": "Desk key", "createdAt": "2026-11-14T09:30:00.000Z", "lastUsedAt": NSNull(), "synced": true]],
            ]), origin: "https://drive.example.org")
            defer { done() }
            // On every server, a self-hosted one included: a key added in a browser is listed here.
            let read = try await TwoStep.status()
            let sent = StepServer.current?.requests.first
            #expect(sent?.method == "GET")
            #expect(sent?.path == "/api/auth/two-step")
            #expect(sent?.query == "methods=webauthn")
            #expect(read?.keys.first?.name == "Desk key")
            #expect(read?.keys.first?.synced == true)
            #expect(read?.defaultKind == "webauthn")
        }

        @Test func aNewKeyIsAddedOnlyWhenTheServersOwnAnswerSaysSo() async throws {
            let fixture = try KeyBytesTests.fixture()
            guard case .options(let creation) = keyOptionsReplyRead(status: 200, body: try KeyBytesTests.text(fixture["options"])) else {
                Issue.record("The fixture's options were not read.")
                return
            }
            let registration = try #require(keyRegistrationRead(handed: try KeyBytesTests.text(fixture["handedRegistration"])))
            let method: [String: Any] = ["id": "f1", "kind": "webauthn", "name": "Desk key", "createdAt": "2026-11-14T09:30:00.000Z", "lastUsedAt": NSNull(), "synced": false]
            serve(StepServer(200, json: ["method": method, "backupCodes": ["7KQ2M-9XD4P", "AAAAA-BBBBB"]]))
            defer { done() }
            // The account's first method: the key, and the backup codes that turning the step on makes.
            let first = try await TwoStep.addKey(creation, name: "Desk key", registration: registration)
            #expect(first == KeyAdded(id: "f1", name: "Desk key", synced: false, backupCodes: ["7KQ2M-9XD4P", "AAAAA-BBBBB"]))
            let sent = try #require(StepServer.current?.requests.first)
            #expect(sent.method == "POST")
            #expect(sent.path == "/api/auth/two-step/keys")
            #expect(sent.headers["Cookie"] == "__Host-hushos-session=session-token")
            #expect(KeyBytesTests.same(sent.body, fixture["registrationBody"]))
            // Beside another method: no codes.
            StepServer.current = StepServer(200, json: ["method": method])
            #expect(try await TwoStep.addKey(creation, name: nil, registration: registration).backupCodes.isEmpty)
            #expect(StepServer.current?.requests.first?.body["name"] == nil)
            // A 200 that is not the server's answer says nothing either way.
            for body in ["{\"success\":true}", "{}", "<html>", "{\"method\":{\"id\":\"f1\",\"kind\":\"totp\",\"name\":\"x\"}}", "{\"method\":{\"id\":\"f1\",\"kind\":\"webauthn\",\"name\":\"x\"},\"backupCodes\":[]}"] {
                StepServer.current = StepServer(200, body)
                await #expect(throws: StepError.lost(StepWords.lostKeyAdded), "\(body)") { _ = try await TwoStep.addKey(creation, name: nil, registration: registration) }
            }
            #expect(StepWords.lostKeyAdded == "The server’s answer didn’t arrive, so HushOS can’t tell whether your passkey or security key was added. Check before you try again.")
            // A gateway's error may hide a key that was added.
            StepServer.current = StepServer(502, "<html>Bad gateway</html>")
            await #expect(throws: StepError.lost(StepWords.lostKeyAdded)) { _ = try await TwoStep.addKey(creation, name: nil, registration: registration) }
            // Each refusal ends the setup with the server's words: the registration is good for one answer.
            let refusals: [(Int, String, String)] = [
                (409, "limit", "You have ten passkeys and security keys, the most an account can have."), (409, "exists", "This passkey or security key is already added."),
                (400, "key-refused", "That passkey or security key couldn’t be added. Start again."), (404, "", "This setup timed out. Start again."),
            ]
            for (status, code, message) in refusals {
                StepServer.current = StepServer(status, json: code.isEmpty ? ["message": message] : ["message": message, "code": code])
                await #expect(throws: TwoStep.KeyRefused(message: message), "\(status) \(code)") { _ = try await TwoStep.addKey(creation, name: nil, registration: registration) }
            }
            StepServer.current = StepServer(401, json: ["message": "Sign in to change two-step sign-in."])
            await #expect { _ = try await TwoStep.addKey(creation, name: nil, registration: registration) } throws: { endsSession($0) }
        }

        @Test func renamingAndTheDefaultAskForNoPasswordAndSayOnlyWhatTheServerAnswered() async throws {
            serve(StepServer(200, json: ["method": ["id": "k1", "kind": "webauthn", "name": "Desk key"]]))
            defer { done() }
            try await TwoStep.renameMethod("k1", name: "  Desk key ")
            var sent = try #require(StepServer.current?.requests.first)
            #expect(sent.method == "PUT")
            #expect(sent.path == "/api/auth/two-step/methods/k1")
            #expect(NSDictionary(dictionary: sent.body).isEqual(to: ["name": "Desk key"]))
            // The server's rules are the server's to say.
            StepServer.current = StepServer(400, json: ["message": "Use letters, numbers and spaces."])
            await #expect(throws: AuthError.message("Use letters, numbers and spaces.")) { try await TwoStep.renameMethod("k1", name: "\u{7}") }
            StepServer.current = StepServer(200, "{\"error\":\"upstream\"}")
            await #expect(throws: StepError.lost(StepWords.lostSaved)) { try await TwoStep.renameMethod("k1", name: "Desk key") }

            StepServer.current = StepServer(200, json: ["defaultKind": "totp"])
            #expect(try await TwoStep.makeDefault(.totp) == "totp")
            sent = try #require(StepServer.current?.requests.first)
            #expect(sent.method == "PUT")
            #expect(sent.path == "/api/auth/two-step/default")
            #expect(NSDictionary(dictionary: sent.body).isEqual(to: ["kind": "totp"]))
            // A session that never passed the step, and an account without that kind: the server's words.
            for (status, message) in [(403, "Sign in with your second step to change this."), (404, "This account has no passkey or security key.")] {
                StepServer.current = StepServer(status, json: ["message": message])
                await #expect(throws: AuthError.message(message), "\(status)") { _ = try await TwoStep.makeDefault(.webauthn) }
            }
            // Not the server's answer: the default is not said to have moved.
            for body in ["{}", "{\"success\":true}", "<html>", "{\"defaultKind\":7}"] {
                StepServer.current = StepServer(200, body)
                await #expect(throws: StepError.lost(StepWords.lostSaved), "\(body)") { _ = try await TwoStep.makeDefault(.webauthn) }
            }
        }
    }
}
