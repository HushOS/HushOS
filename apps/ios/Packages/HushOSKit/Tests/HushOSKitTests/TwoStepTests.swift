import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * Two-step sign-in on the phone (docs/two-step-design.md 4 to 6). What these hold: a reply that is
 * not the server's answer is never a sign-in and never a dead end; each refusal does what its code
 * says, in the server's words; the answer that goes out is the one typed, to the right route; and
 * the recovery phrase leaves the phone only as a signature the account's recovery key verifies.
 */

private let token = String(repeating: "t", count: 43)

private func challenge(_ methods: [StepMethod] = [.totp, .backup, .phrase], phrase: StepPhrase? = nil) -> StepChallenge {
    StepChallenge(token: token, methods: methods, expiresAt: "2026-11-13T10:00:00.000Z", phrase: phrase)
}

/* What the step screen does after each way an answer can fail. */
@Suite struct StepOutcomeTests {
    let all: [StepMethod] = [.totp, .backup, .phrase]

    @Test func aWrongAnswerAsksAgainOnTheSameStepWithEveryMethodStillOffered() {
        let said = "That code didn’t work. Codes change every 30 seconds."
        #expect(StepOutcome.after(StepError.refused(.wrong, said), methods: all) == .again(message: said, field: true, methods: all))
    }

    @Test func anEndedStepGoesBackToThePasswordAndNeverAsksAgain() {
        // Asking again on a token that is over would refuse every answer: a screen nothing can finish.
        let said = "Too many wrong answers. Enter your password again."
        #expect(StepOutcome.after(StepError.refused(.expired, said), methods: all) == .over(message: said))
        #expect(StepOutcome.after(StepError.refused(.updateRequired, "Update HushOS to sign in. This account asks for a second step."), methods: all)
            == .over(message: "Update HushOS to sign in. This account asks for a second step."))
        // Something the server said that this build has no rule for ends the step too, with its words.
        #expect(StepOutcome.after(StepError.refused(.other, "This account is suspended."), methods: all) == .over(message: "This account is suspended."))
        #expect(StepOutcome.after(StepError.refused(.other, ""), methods: all) == .over(message: StepWords.over))
    }

    @Test func aPausedAppIsNoLongerOfferedButTheOtherMethodsAre() {
        let said = "Your authenticator app is paused on this device. Use a backup code or your recovery phrase."
        #expect(StepOutcome.after(StepError.refused(.frozen, said), methods: all) == .again(message: said, field: false, methods: [.backup, .phrase]))
    }

    @Test func aSpentBudgetOrAServerThatCannotCheckCodesLeavesThePhrase() {
        let limited = "Too many wrong codes. Try again in 15 minutes, or use your recovery phrase."
        #expect(StepOutcome.after(StepError.refused(.limited, limited), methods: all) == .again(message: limited, field: false, methods: [.phrase]))
        let unavailable = "Two-step sign-in is unavailable on this server right now. Use your recovery phrase, or try again later."
        #expect(StepOutcome.after(StepError.refused(.unavailable, unavailable), methods: all) == .again(message: unavailable, field: false, methods: [.phrase]))
        // With no phrase to fall back on, what was offered stays: waiting is the only way, and the field must not vanish.
        #expect(StepOutcome.after(StepError.refused(.limited, limited), methods: [.totp, .backup]) == .again(message: limited, field: false, methods: [.totp, .backup]))
    }

    @Test func theAddresssOwnLimitTakesNoMethodAway() {
        // A 429 without the step's code says nothing about the step: a code that was fine is still worth sending.
        let said = "Too many attempts. Please try again in 15 minutes."
        #expect(StepOutcome.after(StepError.refused(.busy, said), methods: all) == .again(message: said, field: false, methods: all))
    }

    @Test func aLostReplyOffersTheSameAnswerAgainAndIsNeitherASignInNorTheEnd() {
        #expect(StepOutcome.after(StepError.lost(StepWords.lostStep), methods: all) == .retry(message: StepWords.lostStep))
    }

    @Test func noAnswerAtAllKeepsTheStepAndACancellationSaysNothing() {
        #expect(StepOutcome.after(AuthError.message(AuthError.unreachable), methods: all) == .again(message: AuthError.unreachable, field: false, methods: all))
        #expect(StepOutcome.after(CancellationError(), methods: all) == nil)
    }
}

/* What a person typed, and what goes out for it. */
@Suite struct StepDraftTests {
    @Test func aCodeIsSentOnlyWhenItIsSixDigits() {
        var draft = StepDraft(methods: [.totp])
        for typed in ["", "12345", "1234567", "12345a", "１２３４５６"] {
            draft.totp = typed
            #expect(draft.problem(for: .totp) == "Enter the 6-digit code from your authenticator app.", "\(typed)")
        }
        // As an autofill or a person spaces it.
        draft.totp = "123 456"
        #expect(draft.problem(for: .totp) == nil)
    }

    @Test func aBackupCodeIsReadAsTheServerReadsIt() {
        var draft = StepDraft(methods: [.backup])
        draft.backup = "7kq2m-9xd4p"
        #expect(draft.problem(for: .backup) == nil)
        draft.backup = "7KQ2M-9XD4"
        #expect(draft.problem(for: .backup) == "Enter one of your backup codes, 10 characters.")
    }

    @Test func thePhraseSaysHowManyWordsItHasSoFar() {
        var draft = StepDraft(methods: [.phrase])
        draft.phrase = " abandon  ability\nable "
        #expect(draft.problem(for: .phrase) == "Enter all 24 words of your recovery phrase. 3 so far.")
    }

    @Test func aMethodNoLongerOfferedGivesWayToTheNextAndNoneIsNone() {
        var draft = StepDraft(methods: [.totp, .backup, .phrase])
        #expect(draft.shown(among: [.totp, .backup, .phrase]) == .totp)
        // The app was paused: the field becomes the backup code's, not an authenticator field nothing accepts.
        #expect(draft.shown(among: [.backup, .phrase]) == .backup)
        draft.method = .phrase
        #expect(draft.shown(among: [.backup, .phrase]) == .phrase)
        #expect(draft.shown(among: []) == nil)
    }

    @Test func thePhraseGoesOutOnlyAsASignatureTheAccountsRecoveryKeyVerifies() throws {
        let user = UUID().uuidString.lowercased()
        let made = try recoveryCreate(userId: user, accountKey: try randomBytes(length: 32), recoveryVersion: 1, keyVersion: 1)
        let signing = StepPhrase(userId: user, recoveryVersion: 1, wrappingSalt: made.envelope.wrappingSalt)
        var draft = StepDraft(methods: [.phrase])
        // Typed as people type: capitals, line breaks, stray spaces.
        draft.phrase = "  " + made.phrase.uppercased().replacingOccurrences(of: " ", with: "\n ") + " "
        let answer = try draft.answer(to: challenge(phrase: signing), method: .phrase)
        guard case .phrase(let signature) = answer.proof else { Issue.record("not a phrase proof"); return }
        let publicKey = try base64urlDecode(value: made.envelope.publicKey)
        #expect(twoStepPhraseVerify(publicKey: publicKey, userId: user, tokenDigest: stepTokenDigest(stepToken: token), signature: try base64urlDecode(value: signature)))
        // For this step only: the same signature proves nothing for another token.
        #expect(!twoStepPhraseVerify(publicKey: publicKey, userId: user, tokenDigest: stepTokenDigest(stepToken: String(repeating: "u", count: 43)), signature: try base64urlDecode(value: signature)))
        // Not one word of the phrase is in what is sent.
        let sent = String(data: try JSONSerialization.data(withJSONObject: try answer.json()), encoding: .utf8) ?? ""
        for word in made.phrase.split(separator: " ") where word.count > 3 { #expect(!sent.lowercased().contains(word), "\(word)") }
    }

    @Test func aMistypedPhraseIsRefusedHereAndAPhraseWithNothingToSignWithIsNotSent() throws {
        let user = UUID().uuidString.lowercased()
        let made = try recoveryCreate(userId: user, accountKey: try randomBytes(length: 32), recoveryVersion: 1, keyVersion: 1)
        var words = made.phrase.split(separator: " ").map(String.init)
        words[3] = words[3] == "zoo" ? "abandon" : "zoo"
        var draft = StepDraft(methods: [.phrase])
        draft.phrase = words.joined(separator: " ")
        let signing = StepPhrase(userId: user, recoveryVersion: 1, wrappingSalt: made.envelope.wrappingSalt)
        #expect(throws: CoreError.self) { try draft.answer(to: challenge(phrase: signing), method: .phrase) }
        draft.phrase = made.phrase
        #expect(throws: AuthError.message(StepWords.cannotAnswer)) { try draft.answer(to: challenge(phrase: nil), method: .phrase) }
    }

    @Test func theAnswerIsTheJsonTheRoutesTake() throws {
        var draft = StepDraft(methods: [.totp])
        draft.totp = "123 456"
        let sent = try draft.answer(to: challenge(), method: .totp).json()
        #expect(sent["token"] as? String == token)
        #expect((sent["proof"] as? [String: String]) == ["kind": "totp", "code": "123456"])
    }
}

/* The step inside a form that changes the account. */
@Suite struct StepUpTests {
    func asked() -> StepUp {
        var step = StepUp(purpose: .password)
        step.take(challenge())
        return step
    }

    @Test func aChangeOnAnAccountWithoutTheStepCarriesNone() throws {
        var step = StepUp(purpose: .password)
        #expect(try step.prove() == nil)
        #expect(!step.asked)
    }

    @Test func nothingIsSentUntilTheFieldCanBeAndThenTheFieldSaysWhy() {
        var step = asked()
        #expect(step.problem == "")
        #expect(throws: StepUp.Unready.self) { try step.prove() }
        #expect(step.problem == "Enter the 6-digit code from your authenticator app.")
        step.draft.totp = "123456"
        #expect((try? step.prove()) == StepAnswer(token: token, proof: .totp(code: "123456")))
    }

    @Test func aChangeRefusedForWantOfTheStepAsksForOneAndSaysNothingYet() {
        var step = StepUp(purpose: .delete)
        #expect(step.failed(StepError.refused(.required, "This needs your second step.")) == .renew)
        #expect(step.error == "")
    }

    @Test func aWrongAnswerStaysOnTheStepAndAnEndedOneAsksForANewOneKeepingWhatWasTyped() {
        var step = asked()
        step.draft.totp = "123456"
        #expect(step.failed(StepError.refused(.wrong, "That code didn’t work. Codes change every 30 seconds.")) == .again)
        #expect(step.problem == "That code didn’t work. Codes change every 30 seconds.")
        #expect(step.failed(StepError.refused(.expired, "This confirmation timed out. Start again.")) == .renew)
        #expect(step.error == "This confirmation timed out. Start again.")
        var next = challenge()
        next.token = String(repeating: "n", count: 43)
        step.take(next, keep: true)
        #expect(step.draft.totp == "123456")
        #expect((try? step.prove())?.token == next.token)
    }

    @Test func aPausedAppAndASpentBudgetNarrowWhatTheFormOffers() {
        var step = asked()
        #expect(step.failed(StepError.refused(.frozen, "Paused.")) == .again)
        #expect(step.methods == [.backup, .phrase])
        #expect(step.shown == .backup)
        #expect(step.failed(StepError.refused(.limited, "Too many.")) == .again)
        #expect(step.methods == [.phrase])
    }

    @Test func whatIsNotTheStepsIsTheFormsOwnError() {
        var step = asked()
        #expect(step.failed(AuthError.message("That isn’t your current password.")) == .notStep)
        #expect(step.failed(StepError.refused(.setupRequired, "Finish setting up your account first.")) == .notStep)
        #expect(step.failed(StepError.lost(StepWords.lostChange)) == .notStep)
        #expect(step.methods == [.totp, .backup, .phrase])
    }
}

/* What Account shows. */
@Suite struct TwoStepSettingsTests {
    @Test func onlyAnAuthenticatorAddressIsEverOpened() {
        let key = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
        #expect(TotpEnrolment(id: "a", secret: key, uri: "otpauth://totp/HushOS:maya@example.org?secret=\(key)&issuer=HushOS").link != nil)
        // A server that answers with any other address gets nothing opened by the app.
        for uri in ["https://example.org/otp", "otpauth://hotp/x?secret=\(key)", "tel:112", "javascript:alert(1)", ""] {
            #expect(TotpEnrolment(id: "a", secret: key, uri: uri).link == nil, "\(uri)")
        }
        #expect(TotpEnrolment(id: "a", secret: key, uri: "").grouped == "JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP")
        #expect(TotpEnrolment(id: "a", secret: "ABCDE", uri: "").grouped == "ABCD E")
    }

    @Test func theCodesLeftSayWhenToMakeMore() throws {
        func status(_ left: Int) throws -> TwoStepStatus {
            try #require(TwoStepStatus(["on": true, "methods": [["id": "m", "kind": "totp", "name": NSNull(), "createdAt": "2026-11-12T09:30:00.000Z", "lastUsedAt": NSNull(), "synced": false]], "backupCodesLeft": left, "totpFrozen": false]))
        }
        #expect(try status(10).codesLeft == "10 of 10 left")
        #expect(try status(3).codesLeft == "3 of 10 left")
        #expect(try status(2).codesLeft == "2 of 10 left. Make a new set soon.")
        #expect(try status(0).codesLeft == "None left. Make a new set.")
        let read = try status(7)
        #expect(read.app?.id == "m")
        #expect(read.app?.createdAt != nil)
        #expect(read.app?.lastUsedAt == nil)
        // Not the settings' shape: nothing is shown as "off" on a guess.
        #expect(TwoStepStatus(["message": "nope"]) == nil)
    }

    @Test func theLogSaysWhatHappenedAndStillListsAKindItDoesNotKnow() {
        func words(_ kind: String, _ method: String? = nil) -> String { SecurityEvent(id: "e", kind: kind, method: method, deviceKind: nil, createdAt: nil).words }
        #expect(words("sign-in", "totp") == "Signed in with your password and an authenticator code")
        #expect(words("sign-in", "phrase") == "Signed in with your password and your recovery phrase")
        #expect(words("sign-in") == "Signed in")
        #expect(words("step-failed", "backup") == "Wrong answer to the second step, with a backup code")
        #expect(words("two-step-off") == "Two-step sign-in turned off")
        #expect(words("something-new") == "Security change")
        #expect(SecurityEvent(id: "e", kind: "sign-in", method: nil, deviceKind: "ios", createdAt: nil).device == "iPhone or iPad")
    }
}

/* The server, for the requests below: one answer for every request, and what was asked. */
final class StepServer: @unchecked Sendable {
    nonisolated(unsafe) static var current: StepServer?
    var status = 200
    var body = Data()
    private(set) var requests: [(method: String, path: String, headers: [String: String], body: [String: Any])] = []
    private let lock = NSLock()

    init(_ status: Int, _ body: String) {
        self.status = status
        self.body = Data(body.utf8)
    }

    convenience init(_ status: Int, json: [String: Any]) {
        self.init(status, String(data: try! JSONSerialization.data(withJSONObject: json), encoding: .utf8)!)
    }

    func asked(_ request: URLRequest, _ body: Data?) -> (Int, Data) {
        lock.lock()
        defer { lock.unlock() }
        let parsed = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        requests.append((request.httpMethod ?? "", request.url?.path() ?? "", request.allHTTPHeaderFields ?? [:], parsed))
        return (status, self.body)
    }
}

final class StepServerProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            stream.close()
            body = data
        }
        let (status, data) = StepServer.current?.asked(request, body) ?? (500, Data())
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

extension OnFakeDrive {
    /* The requests themselves, against a server that answers as the real one does, or as something in the way does. */
    @Suite struct TwoStepRequestTests {
        let origin = "https://step.test"

        func serve(_ server: StepServer) {
            StepServer.current = server
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [StepServerProtocol.self]
            Auth.testTransport = configuration
            Auth.testSession = SharedKeychain.Session(origin: origin, token: "session-token", userId: "u")
        }

        func done() { Auth.testSession = nil; Auth.testTransport = nil; StepServer.current = nil }

        var pending: PendingSignIn { PendingSignIn(origin: origin, email: "maya@example.org", challenge: challenge(), exportKey: Data(repeating: 1, count: 64)) }

        func answer(_ server: StepServer) async -> Error? {
            serve(server)
            defer { done() }
            do {
                _ = try await Auth.answerStep(pending, proof: .totp(code: "123 456"))
                return nil
            } catch {
                return error
            }
        }

        @Test func theAnswerGoesToTheStepRouteWithItsTokenAndNoSessionCookie() async {
            let server = StepServer(401, json: ["message": "That code didn’t work. Codes change every 30 seconds.", "code": "step-wrong"])
            _ = await answer(server)
            #expect(server.requests.count == 1)
            let sent = server.requests.first
            #expect(sent?.method == "POST")
            #expect(sent?.path == "/api/auth/login/two-step")
            #expect(sent?.body["token"] as? String == token)
            #expect((sent?.body["proof"] as? [String: String]) == ["kind": "totp", "code": "123456"])
            // A sign-in has no session yet, and the phones never send one to it.
            #expect(sent?.headers["Cookie"] == nil)
            #expect(sent?.headers["Origin"] == origin)
        }

        @Test func eachRefusalIsThrownWithItsCodeAndTheServersWords() async {
            let cases: [(Int, String, StepRefusal)] = [
                (401, "step-wrong", .wrong), (401, "step-expired", .expired), (403, "step-frozen", .frozen),
                (429, "step-limited", .limited), (409, "update-required", .updateRequired),
            ]
            for (status, code, refusal) in cases {
                let error = await answer(StepServer(status, json: ["message": "The server’s words for \(code).", "code": code]))
                #expect(error as? StepError == .refused(refusal, "The server’s words for \(code)."), "\(code)")
            }
            // A row the server cannot read is its fault (503 `step-unavailable`): said as it says it, nothing changed, and the phrase is still offered.
            let words = "Two-step sign-in is unavailable on this server right now. Use your recovery phrase, or try again later."
            let unavailable = await answer(StepServer(503, json: ["message": words, "code": "step-unavailable"]))
            #expect(unavailable as? StepError == .refused(.unavailable, words))
            #expect(unavailable.flatMap { StepOutcome.after($0, methods: [.totp, .backup, .phrase]) } == .again(message: words, field: false, methods: [.phrase]))
        }

        @Test func aFiveHundredWithoutTheStepsCodeIsALostReplyNeverAnAnswer() async {
            // The server's catch-all 503, or a gateway's: sent again, never read as "codes can't be checked" (which
            // would take the code field away) and never as a wrong answer.
            for (status, body) in [(503, "{\"message\":\"Authentication is temporarily unavailable. Please try again.\"}"), (500, "{\"message\":\"Something broke.\"}"), (503, "{\"message\":\"Try later.\",\"code\":\"other\"}")] {
                let error = await answer(StepServer(status, body))
                #expect(error as? StepError == .lost(StepWords.lostStep), "\(status) \(body)")
            }
            // At a change too: it may have gone through, so it is not reported either way.
            serve(StepServer(503, json: ["message": "Authentication is temporarily unavailable. Please try again."]))
            defer { done() }
            await #expect(throws: StepError.lost(StepWords.lostChange)) { _ = try await Auth.call("/api/auth/security/finish", method: "POST", body: [:], whole: true) }
            // And with the code, a change is refused as the step's, with nothing changed: the form keeps the phrase.
            StepServer.current = StepServer(503, json: ["message": "Unavailable.", "code": "step-unavailable"])
            await #expect(throws: StepError.refused(.unavailable, "Unavailable.")) { _ = try await Auth.call("/api/auth/security/finish", method: "POST", body: [:], whole: true) }
        }

        @Test func aReplyThatIsNotTheServersAnswerIsLostNeverASignIn() async {
            // A 200 with neither an account nor a step, a proxy's page, a cut-off body, a gateway's error,
            // and a second step in place of the session: none signs anyone in, and each offers the answer again.
            let replies: [(Int, String)] = [
                (200, "{}"), (200, ""), (200, "<html><body>Sign in to Wi-Fi</body></html>"), (200, "{\"user\":{\"id\":\"u\""),
                (200, "{\"user\":{\"id\":\"u\",\"email\":\"maya@example.org\"}}"), (502, "<html>Bad gateway</html>"), (503, ""),
                (200, "{\"twoStep\":{\"token\":\"\(token)\",\"methods\":[\"totp\"],\"expiresAt\":\"2026-11-13T10:00:00.000Z\"}}"),
            ]
            for (status, body) in replies {
                let error = await answer(StepServer(status, body))
                #expect(error as? StepError == .lost(StepWords.lostStep), "\(status) \(body)")
                #expect(error.flatMap { StepOutcome.after($0, methods: [.totp]) } == .retry(message: StepWords.lostStep), "\(status) \(body)")
            }
        }

        @Test func aStepForAChangeIsAskedForUnderTheSessionAndAnAccountWithoutOneGetsNone() async throws {
            serve(StepServer(200, json: ["token": token, "methods": ["totp", "backup"], "expiresAt": "2026-11-13T10:00:00.000Z"]))
            defer { done() }
            let asked = try await TwoStep.challenge(.masterKey)
            #expect(asked?.token == token)
            #expect(asked?.methods == [.totp, .backup])
            let sent = StepServer.current?.requests.first
            #expect(sent?.path == "/api/auth/two-step/challenge")
            #expect(sent?.body["purpose"] as? String == "master-key")
            #expect(sent?.headers["Cookie"] == "__Host-hushos-session=session-token")
            // The step is off for this account (409), or this server has two-step off and it never had one (501).
            for status in [409, 501] {
                StepServer.current = StepServer(status, json: ["message": "Two-step sign-in is off for this account."])
                #expect(try await TwoStep.challenge(.password) == nil, "\(status)")
            }
            // Something in the way: not "no step", or the change would go without one and be refused again and again.
            StepServer.current = StepServer(200, "<html>")
            await #expect(throws: StepError.lost(StepWords.lostChange)) { _ = try await TwoStep.challenge(.password) }
        }

        @Test func aChangesRefusalIsTheStepsOnlyWhenTheServerNamesOneOfItsCodes() async {
            serve(StepServer(403, json: ["message": "This needs your second step.", "code": "two-step"]))
            defer { done() }
            await #expect(throws: StepError.refused(.required, "This needs your second step.")) { _ = try await Auth.call("/api/auth/security/finish", method: "POST", body: [:], whole: true) }
            StepServer.current = StepServer(429, json: ["message": "Too many wrong codes. Try again in 15 minutes, or use your recovery phrase.", "code": "step-limited"])
            await #expect(throws: StepError.refused(.limited, "Too many wrong codes. Try again in 15 minutes, or use your recovery phrase.")) {
                _ = try await Auth.call("/api/auth/delete/finish", method: "POST", body: [:], whole: true)
            }
            // The password limiter's 429 is not the step's: the form shows it as its own error and keeps every method.
            StepServer.current = StepServer(429, json: ["message": "Too many attempts. Please try again in 15 minutes."])
            await #expect(throws: AuthError.message("Too many attempts. Please try again in 15 minutes.")) { _ = try await Auth.call("/api/auth/security/finish", method: "POST", body: [:], whole: true) }
            // A session that ended is still a session that ended, whatever else the body says.
            StepServer.current = StepServer(401, json: ["message": "Sign in to change your password."])
            await #expect { _ = try await Auth.call("/api/auth/security/finish", method: "POST", body: [:], whole: true) } throws: { endsSession($0) }
        }

        @Test func aChangeWhoseReplyWasLostIsNotReportedAsDone() async {
            serve(StepServer(200, "<html>Maintenance</html>"))
            defer { done() }
            await #expect(throws: StepError.lost(StepWords.lostChange)) { _ = try await Auth.call("/api/auth/security/finish", method: "POST", body: [:], whole: true) }
            StepServer.current = StepServer(200, "")
            await #expect(throws: StepError.lost(StepWords.lostAppAdded)) { _ = try await TwoStep.confirmAuthenticator(id: "f", code: "123456") }
        }

        @Test func aServerWithTwoStepOffShowsNothingAndOneThatFailsIsNotReadAsOff() async throws {
            serve(StepServer(501, json: ["message": "Two-step sign-in isn’t available on this server."]))
            defer { done() }
            #expect(try await TwoStep.status() == nil)
            StepServer.current = StepServer(200, json: ["on": true, "methods": [["id": "m", "kind": "totp", "name": NSNull(), "createdAt": "2026-11-12T09:30:00.000Z", "lastUsedAt": NSNull(), "synced": false]], "backupCodesLeft": 9, "totpFrozen": true])
            let on = try await TwoStep.status()
            #expect(on?.on == true)
            #expect(on?.totpFrozen == true)
            #expect(on?.backupCodesLeft == 9)
            for (status, body) in [(500, "{\"message\":\"Authentication is temporarily unavailable. Please try again.\"}"), (200, "<html>"), (502, "")] {
                StepServer.current = StepServer(status, body)
                await #expect(throws: AuthError.self) { _ = try await TwoStep.status() }
            }
        }

        @Test func confirmingTheAppIsOnlyEverOneOfTheServersTwoAnswers() async throws {
            serve(StepServer(200, json: ["backupCodes": ["7KQ2M-9XD4P", "AAAAA-BBBBB"]]))
            defer { done() }
            #expect(try await TwoStep.confirmAuthenticator(id: "factor", code: "123 456") == .turnedOn(["7KQ2M-9XD4P", "AAAAA-BBBBB"]))
            let sent = StepServer.current?.requests.first
            #expect(sent?.path == "/api/auth/two-step/totp/factor/confirm")
            #expect(sent?.body["code"] as? String == "123456")
            StepServer.current = StepServer(200, "{\"replaced\":true}")
            #expect(try await TwoStep.confirmAuthenticator(id: "factor", code: "123456") == .replaced)
            // Anything else with a 200 says nothing: told "replaced" (or shown an empty list of codes), someone would
            // believe their new app is on when the server never said so.
            let notAnswers = [
                "{}", "{\"replaced\":false}", "{\"replaced\":1}", "{\"replaced\":\"true\"}", "{\"backupCodes\":[]}", "{\"backupCodes\":[\"\"]}",
                "{\"backupCodes\":\"7KQ2M-9XD4P\"}", "{\"backupCodes\":[\"7KQ2M-9XD4P\"],\"replaced\":true}", "{\"error\":\"upstream\"}", "{\"success\":true}",
            ]
            for body in notAnswers {
                StepServer.current = StepServer(200, body)
                await #expect(throws: StepError.lost(StepWords.lostAppAdded), "\(body)") { _ = try await TwoStep.confirmAuthenticator(id: "factor", code: "123456") }
            }
            #expect(StepWords.lostAppAdded == "The server’s answer didn’t arrive, so HushOS can’t tell whether your authenticator app was added. Check before you try again.")
            StepServer.current = StepServer(400, json: ["message": "That code didn’t work. Codes change every 30 seconds.", "code": "step-wrong"])
            await #expect(throws: StepError.refused(.wrong, "That code didn’t work. Codes change every 30 seconds.")) { _ = try await TwoStep.confirmAuthenticator(id: "factor", code: "000000") }
            StepServer.current = StepServer(404, json: ["message": "This setup timed out. Start again."])
            await #expect(throws: TwoStep.SetupTimedOut(message: "This setup timed out. Start again.")) { _ = try await TwoStep.confirmAuthenticator(id: "factor", code: "123456") }
        }
    }
}
