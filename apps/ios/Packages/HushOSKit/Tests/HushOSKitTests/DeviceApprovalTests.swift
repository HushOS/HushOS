import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * Approve on another device as the second step (docs/two-step-design.md 12). What these hold:
 *
 * - the asking phone posts only its commitment, reveals nothing before another device opened the
 *   request, reveals once, and answers the step only with an approved request (`step-pending`
 *   keeps it waiting and is never an error);
 * - a phone with no device key commits to the very key it then registers with;
 * - the answering phone refuses a reveal that is not the commitment it saw before opening, and a
 *   scanned code for another request or commitment, signs only on the exact code, and ends the
 *   request (`wrong-code`) on anything else;
 * - its half of the code is its own: an open the server answers with another value, and a request
 *   already opened that this run holds no value for, are ended with nothing opened or signed;
 * - it shows at most five prompts a day for each class, whatever the server lists;
 * - its list does not follow the settings route's 501, and holds nothing of a session that is gone;
 * - turning the method on asks only the device the person chose and never chooses one for them,
 *   sends nothing before one is, shows no code and no QR code, confirms nothing on the approval
 *   alone, sends the confirmation only with the code the approving device shows (typed here and
 *   checked here first; a wrong one drops the request unsent), does not close over a confirmation
 *   that is out, and removes every other device but that one;
 * - the answering phone signs such a request on a press, with nothing typed, never after a scan,
 *   and hands back the code the asking phone expects; no other request is approved untyped;
 * - the answer sheet is held only by an approval or an ending that is out, never by its wait for
 *   the other device, and a cancel while it waits ends the request;
 * - a list that came back for a session since left is not counted in the next account's limit;
 * - `twoStepMethods` names `device`, the settings ask for it, and the settings' row says what is true.
 *
 * The server here is a small one in memory that does what the real one does with each route, and
 * can be made to lie where a test needs a server that lies.
 */

private let token = String(repeating: "t", count: 43)
private let account = "0f8fad5b-d9cb-469f-a165-70867728950e"

private func json(_ value: Any) -> String { String(decoding: try! JSONSerialization.data(withJSONObject: value), as: UTF8.self) }
private func random32() -> String { base64urlEncode(bytes: try! randomBytes(length: 32)) }

/* The approvals routes, in memory. */
private final class ApprovalServer: @unchecked Sendable {
    struct Call {
        let method: String
        let path: String
        let body: [String: Any]
        let stepToken: String?
    }

    private let lock = NSLock()
    private var all: [Call] = []
    let requestId = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
    /* The account the server says the request is for. */
    var userId = account
    var purpose = "login"
    var klass = "unknown"
    var deviceName: String? = "Chrome on Windows"
    var stepToken: String?
    var tokenDigest: String?
    var commitment: String?
    var approverKey: String?
    var reveal: (key: String, nonce: String)?
    var state = "none"
    var ended = "refused"
    var signature: String?
    var deniedFor: String?
    /* A server that lies to the answering phone: what it lists in place of what was posted. */
    var listedCommitment: String?
    var listedReveal: (key: String, nonce: String)?
    /* Takes the next reveal and answers it with a gateway's page. */
    var loseRevealReply = false
    /* Says `opened` however often it is asked, even after the reveal. */
    var staysOpened = false
    /* Other requests in the list, as `(id, class)`. */
    var others: [(String, String)] = []
    /* Whether the server knows the asking device (`false`), or the name is its own words; nil leaves the field out, as an older server does. */
    var selfNamed: Bool? = false
    /* The asking device named this phone to answer; nil leaves the field out. */
    var chosen: Bool? = false
    /* A server that answers an open with a value of its own choosing. */
    var echo: String?

    var calls: [Call] { lock.withLock { all } }
    func calls(_ suffix: String) -> [Call] { calls.filter { $0.path.hasSuffix(suffix) } }

    func wire(session: String? = "session-tag") -> ApprovalWire {
        ApprovalWire(session: session) { method, path, body, stepToken in
            let parsed = body.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] } ?? [:]
            return self.lock.withLock {
                self.all.append(Call(method: method, path: path, body: parsed, stepToken: stepToken))
                let (status, text) = self.answer(method, path, parsed, stepToken)
                return ApprovalWire.Reply(status: status, text: text)
            }
        }
    }

    /* A request as an asking device made it, for the tests that only answer. */
    func asked(purpose: String = "login", key: String = random32(), nonce: String = random32()) -> (key: String, nonce: String) {
        self.purpose = purpose
        stepToken = token
        tokenDigest = stepTokenDigest(stepToken: token)
        commitment = try! deviceStepCommitment(purpose: purpose, tokenDigest: tokenDigest!, deviceSigningKey: key, nonce: nonce)
        state = "waiting"
        return (key, nonce)
    }

    private func entry(_ id: String, _ klass: String) -> [String: Any] {
        var entry: [String: Any] = [
            "id": id, "purpose": purpose, "class": klass, "device": ["kind": "web", "name": deviceName as Any? ?? NSNull()],
            "createdAt": "2026-11-14T10:00:00.000Z", "expiresAt": "2026-11-14T10:05:00.000Z",
            "tokenDigest": tokenDigest ?? random32(), "commitment": (id == requestId ? listedCommitment ?? commitment : nil) ?? random32(),
        ]
        if let selfNamed { entry["selfNamed"] = selfNamed }
        if let chosen { entry["chosen"] = chosen }
        guard id == requestId else { return entry }
        if let approverKey { entry["approverKey"] = approverKey }
        if let shown = listedReveal ?? reveal { entry["reveal"] = ["deviceSigningKey": shown.key, "nonce": shown.nonce] }
        return entry
    }

    private func answer(_ method: String, _ path: String, _ body: [String: Any], _ header: String?) -> (Int, String) {
        let own = "/api/auth/approvals/\(requestId)"
        switch (method, path) {
        case ("POST", "/api/auth/approvals"):
            stepToken = body["stepToken"] as? String
            tokenDigest = stepToken.map { stepTokenDigest(stepToken: $0) }
            commitment = body["commitment"] as? String
            state = "waiting"
            return (200, json(["requestId": requestId, "userId": userId, "expiresAt": "2026-11-14T10:05:00.000Z"]))
        case ("GET", own):
            guard header == stepToken else { return (401, json(["message": "This sign-in timed out.", "code": "step-expired"])) }
            var status: [String: Any] = ["state": staysOpened && state == "revealed" ? "opened" : state]
            if let approverKey, state != "waiting", state != "ended" { status["approverKey"] = approverKey }
            if state == "ended" { status["ended"] = ended }
            return (200, json(status))
        case ("POST", own + "/reveal"):
            guard state == "opened", let key = body["deviceSigningKey"] as? String, let nonce = body["nonce"] as? String,
                  (try? deviceStepCommitment(purpose: purpose, tokenDigest: tokenDigest ?? "", deviceSigningKey: key, nonce: nonce)) == commitment
            else {
                state = "ended"
                return (400, json(["message": "That didn’t match the request.", "code": "device-mismatch"]))
            }
            reveal = (key, nonce)
            state = "revealed"
            if loseRevealReply {
                loseRevealReply = false
                return (502, "<html>Bad gateway</html>")
            }
            return (200, json(["revealed": true]))
        case ("GET", "/api/auth/approvals"):
            let live = ["waiting", "opened", "revealed"].contains(state)
            return (200, json(["userId": "someone-else", "approvals": (live ? [entry(requestId, klass)] : []) + others.map { entry($0.0, $0.1) }]))
        case ("POST", own + "/open"):
            guard state == "waiting" || state == "opened" || state == "revealed" else { return (404, json(["message": "This request is over.", "code": "approval-over"])) }
            approverKey = approverKey ?? body["ephemeralKey"] as? String
            if state == "waiting" { state = "opened" }
            return (200, json(["approverKey": echo ?? approverKey ?? ""]))
        case ("POST", own + "/approve"):
            signature = body["signature"] as? String
            state = "approved"
            return (200, json(["approved": true]))
        case ("POST", own + "/deny"):
            deniedFor = body["reason"] as? String
            state = "ended"
            return (200, json(["ended": true]))
        default:
            return (404, json(["message": "Not found."]))
        }
    }

    /* The other device opens the request, as the server records it. */
    func open(with key: String = random32()) { lock.withLock { approverKey = key; state = "opened" } }
    func set(_ next: String, ended why: String = "refused") { lock.withLock { state = next; ended = why } }
    var current: String { lock.withLock { state } }
}

/* What a test collects from another task. */
private final class Seen<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var all: [Value] = []
    func add(_ value: Value) { lock.withLock { all.append(value) } }
    var values: [Value] { lock.withLock { all } }
}

@Suite struct DeviceAskTests {
    private func begin(_ server: ApprovalServer, key: String = random32(), purpose: String = "login") async throws -> DeviceAsk {
        try await DeviceAsk.start(wire: server.wire(session: nil), stepToken: token, purpose: purpose, deviceSigningKey: key, name: "iPhone 16 Pro")
    }

    @Test func onlyTheCommitmentGoesOutUntilAnotherDeviceOpensTheRequestAndThenTheRevealGoesOnce() async throws {
        let server = ApprovalServer()
        let key = random32()
        let ask = try await begin(server, key: key)
        // The request itself: the token, the commitment and what the phone calls itself. Never the key or the nonce.
        let made = try #require(server.calls.first)
        #expect(made.method == "POST" && made.path == "/api/auth/approvals")
        #expect(Set(made.body.keys) == ["stepToken", "commitment", "kind", "name"])
        #expect(made.body["stepToken"] as? String == token)
        #expect(made.body["kind"] as? String == "ios")
        #expect(!json(made.body).contains(key))
        // Nobody has opened it: looked at as often as you like, nothing is revealed and there is no code.
        for _ in 0 ..< 3 { #expect(try await ask.poll() == .waiting) }
        #expect(server.calls("/reveal").isEmpty)
        // Each look carries the token in its header, never in the address.
        #expect(server.calls.filter { $0.method == "GET" }.allSatisfy { $0.stepToken == token && !$0.path.contains(token) })
        // Another device opens it with its own value: now, and only now, the key and the nonce go.
        let approver = random32()
        server.open(with: approver)
        let shown = try await ask.poll()
        let revealed = try #require(server.calls("/reveal").first)
        #expect(revealed.body["deviceSigningKey"] as? String == key)
        #expect(revealed.body["stepToken"] as? String == token)
        let nonce = try #require(revealed.body["nonce"] as? String)
        // What was revealed is what was committed to, and the code is the one the other device works out from it.
        let digest = stepTokenDigest(stepToken: token)
        #expect(try deviceStepCommitment(purpose: "login", tokenDigest: digest, deviceSigningKey: key, nonce: nonce) == made.body["commitment"] as? String)
        let step = DeviceStep(userId: account, requestId: server.requestId, purpose: "login", tokenDigest: digest, deviceSigningKey: key)
        #expect(shown == .code(try deviceStepCode(step: step, approverKey: approver, nonce: nonce)))
        // Looked at again, revealed or (a server slow to say so) still opened: never a second reveal.
        #expect(try await ask.poll() == shown)
        server.staysOpened = true
        for _ in 0 ..< 3 { #expect(try await ask.poll() == shown) }
        #expect(server.calls("/reveal").count == 1)
        // The QR code names this request and its commitment.
        #expect(approvalQrRead(text: try #require(ask.qr)) == ApprovalQr(requestId: server.requestId, commitment: try #require(made.body["commitment"] as? String)))
    }

    @Test func aRequestThatTurnsTheMethodOnShowsNoCodeAndNoQrCodeAndTakesTheOtherDevicesCodeTyped() async throws {
        let server = ApprovalServer()
        server.purpose = DeviceEnrolment.purpose
        let key = random32()
        let ask = try await DeviceAsk.start(
            wire: server.wire(), stepToken: token, purpose: DeviceEnrolment.purpose, deviceSigningKey: key, name: "iPhone 16 Pro", approver: "5b1c0d9e-8f7a-4c3b-9a2d-1e0f2a3b4c5d"
        )
        // Nothing for a camera: a scan is the approving device's own word, and that device is the one in doubt.
        #expect(ask.turnsOn && ask.qr == nil)
        var seen: [DeviceAsk.State] = [try await ask.poll()]
        // Nothing typed is the code before a device opened the request.
        #expect(await ask.typed("47 river") == nil)
        let approver = random32()
        server.open(with: approver)
        // Opened, revealed (the reveal still goes, once), approved: at no point is there a code to show here.
        seen.append(try await ask.poll())
        seen.append(try await ask.poll())
        #expect(server.calls("/reveal").count == 1)
        #expect(server.current == "revealed")
        server.set("approved")
        seen.append(try await ask.poll())
        #expect(seen == [.waiting, .opened, .opened, .approved])
        // The code is the one both devices work out, and it is the approving device's to show. Typed here as people
        // type, it comes back as it is written; anything else is not it.
        let nonce = try #require(server.calls("/reveal").first?.body["nonce"] as? String)
        let step = DeviceStep(userId: account, requestId: server.requestId, purpose: DeviceEnrolment.purpose, tokenDigest: stepTokenDigest(stepToken: token), deviceSigningKey: key)
        let code = try deviceStepCode(step: step, approverKey: approver, nonce: nonce)
        #expect(await ask.typed(loosely(code)) == code)
        #expect(await ask.typed(wrong(code)) == nil)
        #expect(await ask.typed("") == nil)
        // A sign-in's code is typed on the other device, never here: its request checks nothing typed.
        let signIn = ApprovalServer()
        let other = try await begin(signIn)
        signIn.open()
        guard case .code(let shown) = try await other.poll() else {
            Issue.record("A sign-in shows its code once the request is opened.")
            return
        }
        #expect(!other.turnsOn)
        #expect(await other.typed(shown) == nil)
    }

    @Test func aRequestThatNamesNoDeviceToTurnTheMethodOnIsRefusedInTheServersWords() async throws {
        // 409 `device-choice`: what the server says is what the sheet shows, and nothing else is taken away.
        let wire = ApprovalWire(session: "tag") { _, _, _, _ in
            ApprovalWire.Reply(status: 409, text: json(["message": "Choose which of your devices will approve.", "code": "device-choice"]))
        }
        var thrown: Error?
        do { _ = try await DeviceAsk.start(wire: wire, stepToken: token, purpose: DeviceEnrolment.purpose, deviceSigningKey: random32(), name: "iPhone") } catch { thrown = error }
        #expect(thrown as? StepError == .refused(.deviceChoice, "Choose which of your devices will approve."))
        #expect(ErrorWords.say(try #require(thrown)) == "Choose which of your devices will approve.")
        // Not the session's end, and not a reason to withdraw any way of answering a step.
        #expect(StepOutcome.left([.device, .totp], after: .deviceChoice, tried: .device) == [.device, .totp])
    }

    @Test func aRevealWhoseReplyWasLostIsNotSentAgainOnceTheServerSaysItHasIt() async throws {
        let server = ApprovalServer()
        let ask = try await begin(server)
        server.open()
        server.loseRevealReply = true
        // The server took the reveal and a gateway ate the answer: this look has no answer.
        await #expect(throws: (any Error).self) { _ = try await ask.poll() }
        #expect(server.calls("/reveal").count == 1)
        // The next look says `revealed`: the code is shown, and nothing is revealed twice.
        guard case .code = try await ask.poll() else {
            Issue.record("The code is shown once the server has the reveal.")
            return
        }
        #expect(server.calls("/reveal").count == 1)
    }

    @Test func theStepIsAnsweredOnlyOnceApprovedAndAPendingAnswerKeepsWaitingWithoutAnError() async throws {
        let server = ApprovalServer()
        let ask = try await begin(server)
        let states = Seen<DeviceAsk.State>()
        let answers = Seen<(StepAnswer, String)>()
        // The other device opens it after a few looks and approves after a few more.
        let other = Task {
            try await Task.sleep(for: .milliseconds(30))
            server.open()
            try await Task.sleep(for: .milliseconds(30))
            server.set("approved")
        }
        let done = try await ask.answered(every: .milliseconds(5), shown: { states.add($0) }) { answer -> String in
            answers.add((answer, server.current))
            // The approval has not landed where the answer went, twice: 409 `step-pending`, counted nowhere.
            if answers.values.count < 3 { throw StepError.refused(.pending, "Waiting for your other device.") }
            return "signed in"
        }
        try await other.value
        #expect(done == "signed in")
        // Never before the server said approved, whatever was on screen meanwhile.
        #expect(states.values.contains(.waiting))
        #expect(answers.values.count == 3)
        #expect(answers.values.allSatisfy { $0.1 == "approved" })
        // The same answer each time: this request, for this token.
        #expect(answers.values.allSatisfy { $0.0 == StepAnswer(token: token, proof: .device(requestId: server.requestId)) })
        #expect(states.values.last == .approved)
    }

    @Test func aRequestThatEndedAnswersNothingAndSaysWhy() async throws {
        for (why, read, words) in [
            ("refused", ApprovalEnded.refused, "Your other device didn’t approve this."),
            ("replaced", .replaced, "Another sign-in replaced this request."),
            ("over", .over, "This request timed out."),
        ] {
            let server = ApprovalServer()
            let ask = try await begin(server)
            server.open()
            server.set("ended", ended: why)
            let answers = Seen<StepAnswer>()
            let done = try await ask.answered(every: .milliseconds(5)) { answer -> Bool in
                answers.add(answer)
                return true
            }
            #expect(done == nil, "\(why)")
            #expect(answers.values.isEmpty, "\(why)")
            #expect(try await ask.poll() == .ended(read))
            #expect(StepWords.ended(read) == words)
        }
    }

    @Test func aRefusalToAskIsTheServersOwnWordsAndWithdrawsOnlyTheOtherDevice() async throws {
        let refusals: [(Int, String, StepRefusal)] = [(409, "device-unavailable", .deviceUnavailable), (409, "device-busy", .deviceBusy), (429, "device-limited", .deviceLimited)]
        for (status, code, refusal) in refusals {
            let wire = ApprovalWire { _, _, _, _ in ApprovalWire.Reply(status: status, text: json(["message": "Said by the server.", "code": code])) }
            var thrown: Error?
            do { _ = try await DeviceAsk.start(wire: wire, stepToken: token, purpose: "login", deviceSigningKey: random32(), name: "iPhone") } catch { thrown = error }
            #expect(thrown as? StepError == .refused(refusal, "Said by the server."), "\(code)")
            // On the step's screen: the server's words, the other device no longer offered, every other way still there.
            let outcome = StepOutcome.after(try #require(thrown), methods: [.device, .webauthn, .totp, .backup, .phrase], tried: .device)
            #expect(outcome == .again(message: "Said by the server.", field: false, methods: [.webauthn, .totp, .backup, .phrase]), "\(code)")
            // Inside a change, the same.
            var change = StepUp(purpose: .password)
            change.take(StepChallenge(token: token, methods: [.device, .totp, .backup], expiresAt: "2026-11-14T10:05:00.000Z", phrase: nil, keyRequest: nil, withheld: false, defaultUnavailable: false))
            #expect(change.failed(try #require(thrown)) == .again)
            #expect(change.methods == [.totp, .backup])
            #expect(change.problem == "Said by the server.")
        }
        // A step that is over is over: back to the password, as for any other way.
        let over = StepOutcome.after(StepError.refused(.expired, "This sign-in timed out."), methods: [.device, .totp], tried: .device)
        #expect(over == .over(message: "This sign-in timed out."))
    }

    @Test func aPendingAnswerIsNeverAWrongAnswerOnTheScreenOrInAForm() throws {
        // At sign-in: nothing is said, nothing is withdrawn, and the step is not over.
        var screen = SignInStep(challenge: step([.device, .totp, .backup]), passkeys: false)
        #expect(screen.shown == .device)
        let pending = StepError.refused(.pending, "Waiting for your other device.")
        #expect(screen.failed(pending, tried: .device, answer: nil) == nil)
        #expect(screen.notice == "" && screen.fieldError == "" && screen.lost == nil)
        #expect(screen.methods == [.device, .totp, .backup])
        // In a form: the approval it carried is no longer its answer, and the same step still stands.
        var change = StepUp(purpose: .delete)
        change.take(step([.device, .totp]))
        change.approved(ApprovedRequest(token: token, requestId: "7c9e6679-7425-40de-944b-e07fc1f90ae7"))
        #expect(change.deviceApproved)
        #expect(change.failed(pending) == .again)
        #expect(!change.deviceApproved)
        #expect(change.problem == "")
        #expect(change.methods == [.device, .totp])
    }

    @Test func aChangeCarriesOnlyARequestApprovedForItsOwnStep() throws {
        var change = StepUp(purpose: .password)
        change.take(step([.device, .totp, .backup]))
        // Nothing approved yet: there is nothing to send.
        #expect(throws: StepUp.Unready.self) { _ = try change.prove() }
        // An approval for another token is not taken.
        change.approved(ApprovedRequest(token: String(repeating: "x", count: 43), requestId: "7c9e6679-7425-40de-944b-e07fc1f90ae7"))
        #expect(!change.deviceApproved)
        change.approved(ApprovedRequest(token: token, requestId: "7c9e6679-7425-40de-944b-e07fc1f90ae7"))
        let sending = try #require(try change.prove())
        #expect(sending == .ready(StepAnswer(token: token, proof: .device(requestId: "7c9e6679-7425-40de-944b-e07fc1f90ae7"))))
        // The JSON the routes take.
        guard case .ready(let answer) = sending else { return }
        #expect((try answer.json()["proof"] as? [String: String]) == ["kind": "device", "requestId": "7c9e6679-7425-40de-944b-e07fc1f90ae7"])
        // A new step (the old one ran out) keeps what was typed and drops the approval: it was for the token before.
        change.draft.totp = "123456"
        var next = step([.device, .totp, .backup])
        next.token = String(repeating: "n", count: 43)
        change.take(next, keep: true)
        #expect(change.draft.totp == "123456")
        #expect(!change.deviceApproved)
        #expect(throws: StepUp.Unready.self) { _ = try change.prove() }
    }

    @Test func anotherDeviceIsOfferedOnlyToAPhoneWithAKeyToAskItWith() {
        let listed = step([.device, .totp, .backup])
        #expect(SignInStep(challenge: listed, passkeys: false, device: true).shown == .device)
        let without = SignInStep(challenge: listed, passkeys: false, device: false)
        #expect(without.methods == [.totp, .backup])
        // The usual way was first and is not on offer: said, with no reason.
        #expect(without.note == "Your usual way isn’t available for this sign-in.")
        var change = StepUp(purpose: .twoStep)
        change.take(listed, device: false)
        #expect(change.methods == [.totp, .backup])
    }

    @Test func aPhoneWithNoDeviceKeyCommitsToTheKeyItThenRegistersWith() async throws {
        // No key was proved at sign-in: one is made now, before there is a session.
        let asking = try #require(StepDeviceKey.forSignIn(proved: nil))
        let made = try #require(asking.made)
        let pending = PendingSignIn(origin: "https://step.test", email: "maya@example.org", challenge: step([.device, .totp]), exportKey: Data(repeating: 1, count: 64), deviceKey: asking)
        let server = ApprovalServer()
        let ask = try await begin(server, key: try #require(pending.deviceKey).publicKey)
        server.open()
        _ = try await ask.poll()
        let revealed = try #require(server.calls("/reveal").first?.body["deviceSigningKey"] as? String)
        // The server took the reveal: it was the commitment's key.
        #expect(server.current == "revealed")
        // Signed in: the phone describes itself with that very key, and keeps its seed.
        let registered = Seen<String>()
        let stored = Seen<SharedKeychain.DeviceIdentity>()
        try await Auth.registerDevice(
            if: SessionDevice(id: "d", registered: false), userId: account, email: "maya@example.org", made: pending.deviceKey?.made, name: "iPhone 16 Pro",
            register: { _, key in registered.add(key); return "5b1c0d9e-8f7a-4c3b-9a2d-1e0f2a3b4c5d" }, store: { stored.add($0) }
        )
        #expect(registered.values == [revealed])
        let kept = try #require(stored.values.first)
        #expect(kept.seed == base64urlEncode(bytes: made.seed))
        #expect(base64urlEncode(bytes: try deviceSigningPublicKey(seed: try base64urlDecode(value: kept.seed))) == revealed)
        #expect(kept.deviceId == "5b1c0d9e-8f7a-4c3b-9a2d-1e0f2a3b4c5d")
        // A phone the account knows asks with the key it proved, and makes none.
        let own = try deviceSigningCreate()
        let identity = SharedKeychain.DeviceIdentity(userId: account, emailHash: deviceEmailHash(email: "maya@example.org"), deviceId: "d", seed: base64urlEncode(bytes: own.seed))
        let known = try #require(StepDeviceKey.forSignIn(proved: identity))
        #expect(known.publicKey == base64urlEncode(bytes: own.publicKey))
        #expect(known.made == nil)
        // And a device that already described itself registers nothing.
        try await Auth.registerDevice(
            if: SessionDevice(id: "d", registered: true), userId: account, email: "maya@example.org", made: nil, name: "iPhone",
            register: { _, key in registered.add(key); return "x" }, store: { stored.add($0) }
        )
        #expect(registered.values.count == 1)
    }

    @Test func thisPhonesOwnKeyIsOnlyEverTheSignedInAccounts() throws {
        let own = try deviceSigningCreate()
        let identity = SharedKeychain.DeviceIdentity(userId: account.uppercased(), emailHash: "h", deviceId: "d", seed: base64urlEncode(bytes: own.seed))
        let session = SharedKeychain.Session(origin: "https://step.test", token: "s", userId: account)
        #expect(DeviceApprovals.identity(for: session, stored: identity) == identity)
        #expect(DeviceApprovals.identity(for: nil, stored: identity) == nil)
        #expect(DeviceApprovals.identity(for: session, stored: nil) == nil)
        // Another account signed in on the phone: the key kept for the last one asks and approves nothing.
        let other = SharedKeychain.Session(origin: "https://step.test", token: "s", userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7")
        #expect(DeviceApprovals.identity(for: other, stored: identity) == nil)
    }

    @Test func aSignInAlwaysNamesAnotherDeviceBesideWhateverElseThisPhoneCanAnswer() {
        #expect(Auth.namedAtSignIn(origin: "https://hushos.com", linkHost: "hushos.com") == ["webauthn", "device"])
        // A self-hosted server, and the extensions (no link host): no key, and still another device.
        #expect(Auth.namedAtSignIn(origin: "https://drive.example.org", linkHost: "hushos.com") == ["device"])
        #expect(Auth.namedAtSignIn(origin: "https://hushos.com", linkHost: nil) == ["device"])
    }
}

private func step(_ methods: [StepMethod]) -> StepChallenge {
    StepChallenge(token: token, methods: methods, expiresAt: "2026-11-14T10:05:00.000Z", phrase: nil, keyRequest: nil, withheld: false, defaultUnavailable: false)
}

/* A code as people type it: spaces around it, a hyphen, a capital ("47 river" as " 47-River "). */
private func loosely(_ code: String) -> String {
    let parts = code.split(separator: " ")
    return " \(parts[0])-\(parts[1].prefix(1).uppercased())\(parts[1].dropFirst()) "
}

/* Another code: the same word under other digits. */
private func wrong(_ code: String) -> String {
    let parts = code.split(separator: " ")
    return "\(parts[0] == "00" ? "01" : "00") \(parts[1])"
}

/* Waits for what another task is about to do. */
@MainActor private func until(_ what: String, _ met: @MainActor () -> Bool) async throws {
    for _ in 0 ..< 1500 where !met() { try await Task.sleep(for: .milliseconds(2)) }
    #expect(met(), "\(what)")
}

@Suite struct ApprovalAnsweringTests {
    /* The answering phone: its own account id and device key, and the request as first listed. */
    private struct Phone {
        let key: DeviceSigningKey
        let flow: ApprovalAnswering
    }

    /* `memory`: what this run of the app opened. A new one is an app that opened nothing yet. */
    private func answering(_ server: ApprovalServer, memory: ApprovalMemory = ApprovalMemory(), key: DeviceSigningKey? = nil) async throws -> Phone {
        let key = try key ?? deviceSigningCreate()
        let listed = try await DeviceApprovals.listed(wire: server.wire())
        let prompt = try #require(listed.first { $0.id == server.requestId })
        return Phone(key: key, flow: ApprovalAnswering(prompt: prompt, wire: server.wire(), userId: account, seed: key.seed, memory: memory))
    }

    /* The asking device reveals, as the real server records it. */
    private func reveal(_ server: ApprovalServer, _ asked: (key: String, nonce: String)) {
        server.reveal = asked
        server.set("revealed")
    }

    private func signedStep(_ server: ApprovalServer, _ asked: (key: String, nonce: String), userId: String = account) -> DeviceStep {
        DeviceStep(userId: userId, requestId: server.requestId, purpose: server.purpose, tokenDigest: server.tokenDigest ?? "", deviceSigningKey: asked.key)
    }

    @Test func aRevealThatIsNotTheCommitmentSeenBeforeOpeningEndsTheRequestAndNothingIsSigned() async throws {
        // A server that swaps the request under the phone once it has opened it: another key and nonce, with a
        // commitment to match, all consistent with each other and none of it what the phone first saw.
        let server = ApprovalServer()
        _ = server.asked()
        let phone = try await answering(server)
        try await phone.flow.open()
        let digest = try #require(server.tokenDigest)
        let swapped = (key: random32(), nonce: random32())
        server.listedCommitment = try deviceStepCommitment(purpose: "login", tokenDigest: digest, deviceSigningKey: swapped.key, nonce: swapped.nonce)
        server.listedReveal = swapped
        await #expect(throws: ApprovalProblem.mismatch) { _ = try await phone.flow.revealed() }
        #expect(server.deniedFor == "mismatch")
        // Whatever is typed afterwards, nothing is signed for this request.
        await #expect(throws: (any Error).self) { try await phone.flow.approve(typed: "47 river") }
        #expect(server.calls("/approve").isEmpty)
        #expect(server.signature == nil)
        #expect(ApprovalProblem.mismatch.errorDescription == "The other device didn’t match its request, so nothing was approved.")
    }

    @Test func aRevealOfAnotherKeyUnderTheSameCommitmentIsRefusedToo() async throws {
        let server = ApprovalServer()
        let asked = server.asked()
        let phone = try await answering(server)
        try await phone.flow.open()
        // The nonce that was committed to, with a key that was not.
        server.listedReveal = (random32(), asked.nonce)
        await #expect(throws: ApprovalProblem.mismatch) { try await phone.flow.awaitReveal(every: .milliseconds(5)) }
        #expect(server.deniedFor == "mismatch")
        #expect(server.calls("/approve").isEmpty)
    }

    @Test func nothingIsLookedForUntilThisPhoneOpenedTheRequestAndTheRevealIsWaitedFor() async throws {
        let server = ApprovalServer()
        let asked = server.asked()
        let phone = try await answering(server)
        #expect(try await phone.flow.revealed() == false)
        try await phone.flow.open()
        // Opened with 32 bytes of this phone's own; the asking device has not revealed yet.
        let own = try #require(server.calls("/open").first?.body["ephemeralKey"] as? String)
        #expect(try base64urlDecode(value: own).count == 32)
        #expect(try await phone.flow.revealed() == false)
        reveal(server, asked)
        #expect(try await phone.flow.revealed())
    }

    @Test func anOpenTheServerAnswersWithAnotherValueEndsTheRequestAndNothingIsSigned() async throws {
        // The reply to `open` echoes the value the request was opened with. A server that answers another chose this
        // phone's half of the code itself, after it had seen the commitment, and could have chosen it to steer the code.
        let server = ApprovalServer()
        let asked = server.asked()
        let memory = ApprovalMemory()
        let phone = try await answering(server, memory: memory)
        let forced = random32()
        server.echo = forced
        await #expect(throws: ApprovalProblem.changed) { try await phone.flow.open() }
        #expect(server.deniedFor == "mismatch")
        // The value was this phone's own, and the server's was never taken in its place.
        let sent = try #require(server.calls("/open").first?.body["ephemeralKey"] as? String)
        #expect(sent != forced)
        #expect(memory.held(server.requestId) == nil)
        // The other device reveals honestly; this request is over here all the same: nothing is looked for or signed.
        reveal(server, asked)
        await #expect(throws: ApprovalProblem.changed) { _ = try await phone.flow.revealed() }
        let code = try deviceStepCode(step: signedStep(server, asked), approverKey: forced, nonce: asked.nonce)
        await #expect(throws: ApprovalProblem.changed) { try await phone.flow.approve(typed: code) }
        #expect(server.calls("/approve").isEmpty)
        #expect(server.signature == nil)
        #expect(ApprovalProblem.changed.errorDescription == "The server changed this device’s part of the code, so nothing was approved. Ask again on the other device.")
    }

    @Test func aRequestAlreadyOpenedThatThisRunHoldsNoValueForIsEndedWithoutOpeningIt() async throws {
        // The list says this phone opened the request, with a value. The app was restarted since, or the server made
        // the value up: either way it is not one this run made, and it is not adopted.
        for scanned in [false, true] {
            let server = ApprovalServer()
            let asked = server.asked()
            let listedValue = random32()
            server.open(with: listedValue)
            let phone = try await answering(server)
            if scanned {
                let code = try approvalQr(requestId: server.requestId, commitment: try #require(server.commitment))
                await #expect(throws: ApprovalProblem.restarted) { _ = try await phone.flow.open(scanned: code) }
            } else {
                await #expect(throws: ApprovalProblem.restarted) { try await phone.flow.open() }
            }
            #expect(server.calls("/open").isEmpty, "scanned: \(scanned)")
            #expect(server.deniedFor == "mismatch", "scanned: \(scanned)")
            // Even with the right code for the listed value, nothing is signed.
            server.listedReveal = asked
            let code = try deviceStepCode(step: signedStep(server, asked), approverKey: listedValue, nonce: asked.nonce)
            await #expect(throws: ApprovalProblem.restarted) { try await phone.flow.approve(typed: code) }
            #expect(server.calls("/approve").isEmpty, "scanned: \(scanned)")
        }
        #expect(ApprovalProblem.restarted.errorDescription == "This request was opened before HushOS was restarted. Ask again on the other device.")
    }

    @Test func openingAgainInTheSameRunSendsTheSameValueAndKeepsTheCommitmentSeenBeforeTheFirst() async throws {
        let server = ApprovalServer()
        let asked = server.asked()
        let memory = ApprovalMemory()
        let key = try deviceSigningCreate()
        let first = try await answering(server, memory: memory, key: key)
        try await first.flow.open()
        let own = try #require(server.calls("/open").first?.body["ephemeralKey"] as? String)
        // The sheet was closed and the request is answered afresh from the list as it reads now: opened, by this
        // phone. The same run holds its value, and sends that one again.
        let again = try await answering(server, memory: memory, key: key)
        try await again.flow.open()
        #expect(server.calls("/open").count == 2)
        #expect(server.calls("/open").last?.body["ephemeralKey"] as? String == own)
        // The honest reveal is checked against the commitment seen before the first open, and the code is this phone's own value's.
        reveal(server, asked)
        #expect(try await again.flow.revealed())
        try await again.flow.approve(typed: try deviceStepCode(step: signedStep(server, asked), approverKey: own, nonce: asked.nonce))
        #expect(deviceStepVerify(publicKey: key.publicKey, step: signedStep(server, asked), signature: try base64urlDecode(value: try #require(server.signature))))

        // A server that swaps the request once this phone has opened it: another commitment in the list, and a reveal
        // that matches it. A phone that took the listed commitment on reopening would find nothing wrong.
        let lying = ApprovalServer()
        _ = lying.asked()
        let kept = ApprovalMemory()
        let before = try await answering(lying, memory: kept)
        try await before.flow.open()
        let mine = try #require(lying.calls("/open").first?.body["ephemeralKey"] as? String)
        let swapped = (key: random32(), nonce: random32())
        lying.listedCommitment = try deviceStepCommitment(purpose: "login", tokenDigest: try #require(lying.tokenDigest), deviceSigningKey: swapped.key, nonce: swapped.nonce)
        lying.listedReveal = swapped
        let after = try await answering(lying, memory: kept)
        try await after.flow.open()
        #expect(lying.calls("/open").last?.body["ephemeralKey"] as? String == mine)
        await #expect(throws: ApprovalProblem.mismatch) { _ = try await after.flow.revealed() }
        #expect(lying.deniedFor == "mismatch")
        #expect(lying.calls("/approve").isEmpty)
    }

    @Test func aNameTheServerDoesNotVouchForIsSaidAsTheAskingDevicesOwnWords() async throws {
        // A stranger with the password can call their browser anything, the owner's laptop included.
        func asks(selfNamed: Bool?) async throws -> String {
            let server = ApprovalServer()
            server.deviceName = "Maya’s Laptop"
            server.selfNamed = selfNamed
            _ = server.asked()
            return try await answering(server).flow.asks
        }
        #expect(try await asks(selfNamed: true) == "Sign-in on a new device calling itself “Maya’s Laptop”")
        // Only the server's plain word that it knows the device shows the bare name; a reply that does not say is not one.
        #expect(try await asks(selfNamed: false) == "Sign-in on Maya’s Laptop")
        #expect(try await asks(selfNamed: nil) == "Sign-in on a new device calling itself “Maya’s Laptop”")
    }

    @Test func aRequestThatNamedThisPhoneSaysSoUnderItsTitle() async throws {
        func line(chosen: Bool?) async throws -> String? {
            let server = ApprovalServer()
            server.chosen = chosen
            _ = server.asked(purpose: "device-approval")
            return try await answering(server).flow.chosenLine
        }
        #expect(try await line(chosen: true) == "The other device asked for this device to approve.")
        #expect(try await line(chosen: false) == nil)
        #expect(try await line(chosen: nil) == nil)
    }

    @Test func aScannedCodeForAnotherRequestOrAnotherCommitmentEndsThisOneUnopened() async throws {
        let stranger = "0b8f6f0e-6a53-4f0e-9d3b-2f1f5b2c7a11"
        for wrong in ["request", "commitment"] {
            let server = ApprovalServer()
            _ = server.asked()
            let phone = try await answering(server)
            let commitment = try #require(server.commitment)
            let scanned = wrong == "request" ? try approvalQr(requestId: stranger, commitment: commitment) : try approvalQr(requestId: server.requestId, commitment: random32())
            await #expect(throws: ApprovalProblem.mismatch, "\(wrong)") { _ = try await phone.flow.open(scanned: scanned) }
            #expect(server.calls("/open").isEmpty, "\(wrong)")
            #expect(server.deniedFor == "mismatch", "\(wrong)")
            #expect(await phone.flow.scanned == false, "\(wrong)")
        }
        // Something else in view (another QR code, a web address): passed over, and nothing is ended.
        let server = ApprovalServer()
        _ = server.asked()
        let phone = try await answering(server)
        for other in ["https://hushos.com", "hushos-approve:", "hushos-approve:AAAA", ""] {
            #expect(try await phone.flow.open(scanned: other) == false, "\(other)")
        }
        #expect(server.calls.filter { $0.method == "POST" }.isEmpty)
        #expect(server.current == "waiting")
    }

    @Test func afterAScanOfThisVeryRequestTheApprovalIsSignedWithNothingTyped() async throws {
        let server = ApprovalServer()
        let asked = server.asked(purpose: "password")
        let phone = try await answering(server)
        #expect(phone.flow.asks == "Change your password on Chrome on Windows")
        let scanned = try approvalQr(requestId: server.requestId, commitment: try #require(server.commitment))
        #expect(try await phone.flow.open(scanned: " \(scanned)\n"))
        #expect(server.calls("/open").count == 1)
        reveal(server, asked)
        try await phone.flow.awaitReveal(every: .milliseconds(5))
        try await phone.flow.approve(typed: nil)
        let signature = try base64urlDecode(value: try #require(server.signature))
        #expect(deviceStepVerify(publicKey: phone.key.publicKey, step: signedStep(server, asked), signature: signature))
        // For this purpose, and no other.
        var login = signedStep(server, asked)
        login.purpose = "login"
        #expect(!deviceStepVerify(publicKey: phone.key.publicKey, step: login, signature: signature))
    }

    @Test func onlyTheExactCodeIsSignedAndAnythingElseEndsTheRequest() async throws {
        let wrongs: [String?] = ["00 abandon", "river", "", nil]
        for typed in wrongs {
            let server = ApprovalServer()
            let asked = server.asked()
            let phone = try await answering(server)
            try await phone.flow.open()
            reveal(server, asked)
            #expect(try await phone.flow.revealed())
            let code = try deviceStepCode(step: signedStep(server, asked), approverKey: try #require(server.approverKey), nonce: asked.nonce)
            // "00 abandon" could be the code one time in two hundred thousand: then this round proves nothing, and is skipped.
            if typed == code { continue }
            await #expect(throws: ApprovalProblem.wrongCode, "\(typed ?? "nothing")") { try await phone.flow.approve(typed: typed) }
            #expect(server.deniedFor == "wrong-code", "\(typed ?? "nothing")")
            #expect(server.calls("/approve").isEmpty, "\(typed ?? "nothing")")
        }
        #expect(ApprovalProblem.wrongCode.errorDescription == "That code didn’t match, so nothing was approved.")
        // The code itself, typed as people type (capitals, a hyphen, spaces around it): approved.
        let server = ApprovalServer()
        let asked = server.asked()
        let phone = try await answering(server)
        try await phone.flow.open()
        reveal(server, asked)
        try await phone.flow.awaitReveal(every: .milliseconds(5))
        let code = try deviceStepCode(step: signedStep(server, asked), approverKey: try #require(server.approverKey), nonce: asked.nonce)
        let parts = code.split(separator: " ")
        try await phone.flow.approve(typed: "  \(parts[0])-\(parts[1].uppercased()) ")
        #expect(server.deniedFor == nil)
        let signature = try base64urlDecode(value: try #require(server.signature))
        // Signed with this phone's key, over this phone's own account id: never the one the list reply carries.
        #expect(deviceStepVerify(publicKey: phone.key.publicKey, step: signedStep(server, asked), signature: signature))
        #expect(!deviceStepVerify(publicKey: phone.key.publicKey, step: signedStep(server, asked, userId: "7c9e6679-7425-40de-944b-e07fc1f90ae8"), signature: signature))
    }

    @Test func aRequestThatTurnsTheMethodOnIsSignedOnAPressAndHandsBackTheCodeTheAskingPhoneExpects() async throws {
        // Both halves against one server. The code runs the other way: nothing is typed on the phone that approves.
        let server = ApprovalServer()
        server.purpose = DeviceEnrolment.purpose
        let asking = try deviceSigningCreate()
        let key = base64urlEncode(bytes: asking.publicKey)
        let ask = try await DeviceAsk.start(
            wire: server.wire(), stepToken: token, purpose: DeviceEnrolment.purpose, deviceSigningKey: key, name: "iPhone 16 Pro", approver: "5b1c0d9e-8f7a-4c3b-9a2d-1e0f2a3b4c5d"
        )
        let phone = try await answering(server)
        #expect(phone.flow.turnsOn)
        try await phone.flow.open()
        #expect(try await ask.poll() == .opened)
        try await phone.flow.awaitReveal(every: .milliseconds(5))
        // The press: signed with nothing typed and nothing scanned, and the code comes back to be shown.
        let shown = try #require(try await phone.flow.approve(typed: nil))
        #expect(server.deniedFor == nil)
        let step = DeviceStep(userId: account, requestId: ask.requestId, purpose: DeviceEnrolment.purpose, tokenDigest: stepTokenDigest(stepToken: token), deviceSigningKey: key)
        #expect(deviceStepVerify(publicKey: phone.key.publicKey, step: step, signature: try base64urlDecode(value: try #require(server.signature))))
        // It is the code the asking side works out from the same values, and the one its own check takes.
        let nonce = try #require(server.calls("/reveal").first?.body["nonce"] as? String)
        #expect(shown == (try deviceStepCode(step: step, approverKey: try #require(server.approverKey), nonce: nonce)))
        #expect(try await ask.poll() == .approved)
        #expect(await ask.typed(shown) == shown)
    }

    @Test func aRequestThatTurnsTheMethodOnIsNeverAnsweredByAScan() async throws {
        let server = ApprovalServer()
        _ = server.asked(purpose: DeviceEnrolment.purpose)
        let phone = try await answering(server)
        // Its very own QR code, as a device that should show none might draw it: not opened, not marked, nothing sent.
        let own = try approvalQr(requestId: server.requestId, commitment: try #require(server.commitment))
        #expect(try await phone.flow.open(scanned: own) == false)
        #expect(await phone.flow.scanned == false)
        #expect(server.calls.filter { $0.method == "POST" }.isEmpty)
        #expect(server.current == "waiting")
    }

    @Test func noOtherRequestIsApprovedWithNothingTypedAndNothingScanned() async throws {
        // Every purpose but the one that turns the method on: opened and revealed, with no scan, nothing typed signs nothing.
        for purpose in ["login", "password", "two-step", "delete"] {
            let server = ApprovalServer()
            let asked = server.asked(purpose: purpose)
            let phone = try await answering(server)
            #expect(!phone.flow.turnsOn, "\(purpose)")
            try await phone.flow.open()
            reveal(server, asked)
            try await phone.flow.awaitReveal(every: .milliseconds(5))
            await #expect(throws: ApprovalProblem.wrongCode, "\(purpose)") { _ = try await phone.flow.approve(typed: nil) }
            #expect(server.calls("/approve").isEmpty && server.signature == nil, "\(purpose)")
            #expect(server.deniedFor == "wrong-code", "\(purpose)")
        }
        // A server that lists a sign-in as the request that turns the method on, to have it signed on a bare press:
        // the commitment was made for a sign-in, so the reveal is not this request's, and nothing is signed.
        let server = ApprovalServer()
        let asked = server.asked(purpose: "login")
        server.purpose = DeviceEnrolment.purpose
        let phone = try await answering(server)
        #expect(phone.flow.turnsOn)
        try await phone.flow.open()
        reveal(server, asked)
        await #expect(throws: ApprovalProblem.mismatch) { try await phone.flow.awaitReveal(every: .milliseconds(5)) }
        await #expect(throws: ApprovalProblem.mismatch) { _ = try await phone.flow.approve(typed: nil) }
        #expect(server.calls("/approve").isEmpty && server.signature == nil)
        #expect(server.deniedFor == "mismatch")
    }

    @Test func denyAndThisWasntMeEndTheRequestWithTheirOwnReasons() async throws {
        for (why, reason) in [(ApprovalAnswering.Ending.denied, "denied"), (.notMe, "not-me")] {
            let server = ApprovalServer()
            _ = server.asked()
            let phone = try await answering(server)
            try await phone.flow.end(why)
            #expect(server.deniedFor == reason)
            #expect(server.calls("/approve").isEmpty)
        }
    }

    @Test func aRequestThatIsOverOrTakenSaysSoInTheServersWords() async throws {
        let server = ApprovalServer()
        _ = server.asked()
        let phone = try await answering(server)
        server.set("ended")
        await #expect(throws: ApprovalProblem.over("This request is over.")) { try await phone.flow.open() }
        // Opened, then gone from the list before the reveal came: over, never waited on for ever.
        let gone = ApprovalServer()
        _ = gone.asked()
        let second = try await answering(gone)
        try await second.flow.open()
        gone.set("ended")
        await #expect(throws: ApprovalProblem.over("This request is over.")) { try await second.flow.awaitReveal(every: .milliseconds(5)) }
    }

    @Test func theAskingAndTheAnsweringPhoneAgreeOnTheCodeAndTheServerCanCheckTheApproval() async throws {
        // Both halves against one server: what the asking phone shows is what the answering phone expects, and what
        // it signs verifies under its key for the request the asking phone made.
        let server = ApprovalServer()
        let asking = try deviceSigningCreate()
        let ask = try await DeviceAsk.start(
            wire: server.wire(session: nil), stepToken: token, purpose: "login", deviceSigningKey: base64urlEncode(bytes: asking.publicKey), name: "iPhone 16 Pro"
        )
        let phone = try await answering(server)
        try await phone.flow.open()
        guard case .code(let shown) = try await ask.poll() else {
            Issue.record("The asking phone shows its code once the request is opened.")
            return
        }
        try await phone.flow.awaitReveal(every: .milliseconds(5))
        try await phone.flow.approve(typed: shown)
        #expect(try await ask.poll() == .approved)
        let step = DeviceStep(
            userId: account, requestId: ask.requestId, purpose: "login", tokenDigest: stepTokenDigest(stepToken: token), deviceSigningKey: base64urlEncode(bytes: asking.publicKey)
        )
        #expect(deviceStepVerify(publicKey: phone.key.publicKey, step: step, signature: try base64urlDecode(value: try #require(server.signature))))
    }

    /* The web's own requests (the fixture the core holds itself to): this phone expects the web's code and signs the web's statement. */
    @Test func aRequestMadeInABrowserIsAnsweredToTheBrowsersBytes() async throws {
        let here = URL(fileURLWithPath: #filePath)
        let file = here.deletingLastPathComponent().appendingPathComponent("../../../../../../crates/hushos-core/fixtures/web-device-approval.json").standardized
        let fixture = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        let cases = try #require(fixture["cases"] as? [[String: Any]])
        #expect(!cases.isEmpty)
        for made in cases {
            func text(_ key: String) throws -> String { try #require(made[key] as? String) }
            let purpose = try text("purpose")
            let key = try deviceSigningCreate()
            let prompt = ApprovalPrompt(
                id: try text("requestId"), purpose: purpose, class: "unknown", deviceKind: "web", deviceName: "Chrome on Windows", location: "near Lyon, France",
                selfNamed: false, chosen: false,
                createdAt: "2026-11-14T10:00:00.000Z", expiresAt: "2026-11-14T10:05:00.000Z", tokenDigest: try text("tokenDigest"), commitment: try text("commitment"),
                approverKey: nil, revealKey: nil, revealNonce: nil
            )
            let signed = Seen<String>()
            // The fixture's approving value stands for the one this phone made: this run holds it, as if it had opened
            // the request with it. It is never taken from the server's reply.
            let approver = try text("approverKey")
            let memory = ApprovalMemory()
            memory.keep(ApprovalMemory.Opened(value: approver, prompt: prompt), for: prompt.id)
            let opened = Seen<String>()
            let entry: [String: Any] = [
                "id": prompt.id, "purpose": purpose, "class": "unknown", "device": ["kind": "web", "name": "Chrome on Windows"],
                "createdAt": prompt.createdAt, "expiresAt": prompt.expiresAt, "tokenDigest": prompt.tokenDigest, "commitment": prompt.commitment,
                "approverKey": approver, "reveal": ["deviceSigningKey": try text("deviceSigningKey"), "nonce": try text("nonce")],
            ]
            let listed = json(["userId": "u", "approvals": [entry]])
            let wire = ApprovalWire(session: "tag") { method, path, body, _ in
                if method == "GET" { return ApprovalWire.Reply(status: 200, text: listed) }
                if path.hasSuffix("/open"), let body, let sent = (try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any])?["ephemeralKey"] as? String {
                    opened.add(sent)
                    return ApprovalWire.Reply(status: 200, text: json(["approverKey": sent]))
                }
                if path.hasSuffix("/approve"), let body, let sent = (try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any])?["signature"] as? String {
                    signed.add(sent)
                    return ApprovalWire.Reply(status: 200, text: json(["approved": true]))
                }
                return ApprovalWire.Reply(status: 200, text: json(["ended": true]))
            }
            let flow = ApprovalAnswering(prompt: prompt, wire: wire, userId: try text("userId"), seed: key.seed, memory: memory)
            // The sheet says what is asked, by which device, and the place the server gave for it.
            #expect(flow.asks.hasSuffix(" on Chrome on Windows, near Lyon, France"), "\(purpose)")
            let other = ApprovalAnswering(prompt: prompt, wire: wire, userId: try text("userId"), seed: key.seed, memory: memory)
            if approvalTurnsOn(purpose: purpose) {
                // The request that turns the method on: a QR code for it, were one drawn, opens nothing.
                #expect(try await flow.open(scanned: try text("qr")) == false, "\(purpose)")
                #expect(opened.values.isEmpty, "\(purpose)")
                // Approved on a press, the code this phone then shows is the browser's code for it.
                try await other.open()
                #expect(try await other.revealed())
                #expect(try await other.approve(typed: nil) == (try text("code")), "\(purpose)")
            } else {
                // The browser's QR code is this request's.
                #expect(try await flow.open(scanned: try text("qr")), "\(purpose)")
                #expect(opened.values == [approver], "\(purpose)")
                #expect(try await flow.revealed(), "\(purpose)")
                // The browser's code is the code; one that is not it would have ended the request instead.
                try await other.open()
                #expect(try await other.revealed())
                #expect(try await other.approve(typed: try text("code")) == nil, "\(purpose)")
            }
            // What is signed is the statement the browser and the server build.
            let step = DeviceStep(userId: try text("userId"), requestId: prompt.id, purpose: purpose, tokenDigest: prompt.tokenDigest, deviceSigningKey: try text("deviceSigningKey"))
            #expect(base64urlEncode(bytes: try deviceStepStatement(step: step)) == (try text("statement")), "\(purpose)")
            #expect(deviceStepVerify(publicKey: key.publicKey, step: step, signature: try base64urlDecode(value: try #require(signed.values.first))), "\(purpose)")
        }
    }
}

@Suite struct ApprovalPromptsTests {
    /* What the phone keeps between looks: here, a box. */
    private final class Box: @unchecked Sendable {
        private let lock = NSLock()
        private var kept = ""
        var limit: PromptLimit { PromptLimit(load: { self.lock.withLock { self.kept } }, save: { next in self.lock.withLock { self.kept = next } }) }
        var record: String { lock.withLock { kept } }
    }

    private func id(_ number: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", number) }

    @Test func noMoreThanFivePromptsADayForEachClassWhateverTheServerLists() async throws {
        let server = ApprovalServer()
        _ = server.asked()
        server.set("ended")
        let box = Box()
        // Eight sign-ins this phone does not know, and one request of the owner's own device.
        server.others = (0 ..< 8).map { (id($0), "unknown") } + [(id(100), "known")]
        let first = try await DeviceApprovals.list(wire: server.wire(), limit: box.limit, day: "2026-11-14")
        #expect(first.map(\.id) == (0 ..< 5).map(id) + [id(100)])
        // Later the same day, eight more strangers: none is shown, on a phone that kept its count (a new look, the same store).
        server.others = (10 ..< 18).map { (id($0), "unknown") } + [(id(3), "unknown"), (id(100), "known"), (id(200), "change")]
        let second = try await DeviceApprovals.list(wire: server.wire(), limit: box.limit, day: "2026-11-14")
        // What was shown stays shown while it is listed; the owner's own classes still have all their room.
        #expect(second.map(\.id) == [id(3), id(100), id(200)])
        // The next day each class starts again.
        let tomorrow = try await DeviceApprovals.list(wire: server.wire(), limit: box.limit, day: "2026-11-15")
        #expect(tomorrow.filter { $0.class == "unknown" }.count == 5)
        // A phone that lost its count (the account's state wiped at sign-out) starts again too: the count is the store's.
        let wiped = try await DeviceApprovals.list(wire: server.wire(), limit: Box().limit, day: "2026-11-14")
        #expect(wiped.filter { $0.class == "unknown" }.map(\.id) == (10 ..< 15).map(id))
        #expect(!box.record.isEmpty)
    }

    @Test func theDayIsThisPhonesOwnDate() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Kolkata")!
        // 20:00 UTC on the 14th is already the 15th in Kolkata.
        let late = Date(timeIntervalSince1970: 1_794_686_400)
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        #expect(PromptLimit.day(late, calendar: utc) == "2026-11-14")
        #expect(PromptLimit.day(late, calendar: calendar) == "2026-11-15")
    }

    @Test func anEndedSessionIsSaidAsOneAndAServersRefusalInItsWords() async {
        let ended = ApprovalWire(session: "tag") { _, _, _, _ in ApprovalWire.Reply(status: 401, text: json(["message": "Sign in first."])) }
        await #expect(throws: AuthError.sessionEnded(session: "tag")) { _ = try await DeviceApprovals.list(wire: ended, limit: Box().limit) }
        let gateway = ApprovalWire(session: "tag") { _, _, _, _ in ApprovalWire.Reply(status: 502, text: "<html>") }
        await #expect(throws: (any Error).self) { _ = try await DeviceApprovals.list(wire: gateway, limit: Box().limit) }
    }
}

/* What a test holds a request at, until it lets it through. */
private actor Gate {
    private var closed = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func close() { closed = true }
    func open() {
        closed = false
        waiting.forEach { $0.resume() }
        waiting = []
    }

    func pass() async {
        guard closed else { return }
        await withCheckedContinuation { waiting.append($0) }
    }

    /* Returns once something is held here. */
    func reached() async throws {
        while waiting.isEmpty { try await Task.sleep(for: .milliseconds(2)) }
    }
}

/* What the phone keeps between looks: here, a box. */
private final class LimitBox: @unchecked Sendable {
    private let lock = NSLock()
    private var kept = ""
    private var written = 0
    var limit: PromptLimit {
        PromptLimit(load: { self.lock.withLock { self.kept } }, save: { next in self.lock.withLock { self.kept = next; self.written += 1 } })
    }
    var record: String { lock.withLock { kept } }
    /* How often the count was written. */
    var saves: Int { lock.withLock { written } }
}

@MainActor @Suite struct ApprovalInboxTests {
    /* The session the phone holds, which a test changes under the inbox. */
    private final class Held: @unchecked Sendable {
        private let lock = NSLock()
        private var session: SharedKeychain.Session?
        init(_ session: SharedKeychain.Session?) { self.session = session }
        var current: SharedKeychain.Session? {
            get { lock.withLock { session } }
            set { lock.withLock { session = newValue } }
        }
    }

    private let maya = SharedKeychain.Session(origin: "https://step.test", token: "maya-session", userId: account)
    private let sam = SharedKeychain.Session(origin: "https://step.test", token: "sam-session", userId: "7c9e6679-7425-40de-944b-e07fc1f90ae8")

    /* An inbox over `wire`, on a phone that holds a device key for whoever is signed in. */
    private func makeInbox(_ held: Held, limit: LimitBox = LimitBox(), wire: @escaping @Sendable (SharedKeychain.Session) -> ApprovalWire) throws -> ApprovalInbox {
        let seed = base64urlEncode(bytes: try deviceSigningCreate().seed)
        return ApprovalInbox(source: ApprovalInbox.Source(
            session: { held.current },
            identity: { SharedKeychain.DeviceIdentity(userId: $0.userId, emailHash: "h", deviceId: "d", seed: seed) },
            wire: wire, limit: limit.limit
        ))
    }

    @Test func aRequestIsListedAndAnsweredOnAServerThatHasTwoStepSetupOff() async throws {
        // TWO_STEP_ENABLED off: the settings route answers 501, and an account that already has the step is still
        // asked for it. The list is the approvals routes' alone.
        let server = ApprovalServer()
        _ = server.asked()
        let settings = Seen<String>()
        let wire = ApprovalWire(session: maya.tag) { method, path, body, stepToken in
            if path.hasPrefix("/api/auth/two-step") {
                settings.add(path)
                return ApprovalWire.Reply(status: 501, text: json(["message": "Two-step sign-in is not available on this server.", "code": "off"]))
            }
            return try await server.wire().send(method, path, body, stepToken)
        }
        let inbox = try makeInbox(Held(maya)) { _ in wire }
        await inbox.load()
        #expect(inbox.prompts.map(\.id) == [server.requestId])
        let asked = try #require(inbox.prompts.first)
        inbox.answer(asked)
        let flow = try #require(inbox.answering?.flow)
        try await flow.open()
        #expect(server.current == "opened")
        // Nothing asked the settings whether it may.
        #expect(settings.values.isEmpty)
    }

    @Test func aListReplyForTheLastSessionThatArrivesAfterTheSwitchShowsNothing() async throws {
        let mayas = ApprovalServer()
        _ = mayas.asked()
        let sams = ApprovalServer()
        let gate = Gate()
        let held = Held(maya)
        let mayaSession = maya
        // What this phone counted of the prompts it showed: one store, the signed-in account's (wiped with it at sign-out).
        let counted = LimitBox()
        let inbox = try makeInbox(held, limit: counted) { session in
            guard session == mayaSession else { return sams.wire(session: session.tag) }
            return ApprovalWire(session: session.tag) { method, path, body, stepToken in
                if method == "GET" { await gate.pass() }
                return try await mayas.wire(session: session.tag).send(method, path, body, stepToken)
            }
        }
        await inbox.load()
        let asked = try #require(inbox.prompts.first)
        #expect(asked.id == mayas.requestId)
        inbox.answer(asked)
        // Maya opens it: this run now holds her value for it.
        try await #require(inbox.answering?.flow).open()
        #expect(inbox.holds(asked.id))
        // A look for Maya's session is out, unanswered, when someone else signs in on the phone. What it will bring
        // back lists a request this phone has not counted yet.
        mayas.others = [("00000000-0000-4000-8000-000000000001", "unknown")]
        let before = (counted.record, counted.saves)
        #expect(before.1 == 1)
        await gate.close()
        let late = Task { await inbox.load() }
        try await gate.reached()
        held.current = sam
        // Hers no longer, from the moment the phone holds another session: before any look says so.
        #expect(!inbox.holds(asked.id))
        await inbox.load()
        // At once, before the look that was out comes back: nothing of Maya's on Sam's screens.
        #expect(inbox.prompts.isEmpty)
        #expect(inbox.answering == nil)
        // The reply for Maya's session arrives now, listing her requests. It is shown nowhere.
        await gate.open()
        await late.value
        #expect(inbox.prompts.isEmpty)
        #expect(inbox.answering == nil)
        // And counted nowhere: the count is kept in what is Sam's storage now, and nothing of Maya's list is written there.
        #expect(counted.saves == before.1)
        #expect(counted.record == before.0)
        // And a row still on screen from before answers nothing under Sam's session.
        inbox.answer(asked)
        #expect(inbox.answering == nil)
        #expect(sams.calls.allSatisfy { $0.method == "GET" })
        // Maya signs back in. Her request is listed again, but what the run held for her went with her session: the
        // value it opened with is not sent again, and the request is ended.
        held.current = maya
        await inbox.load()
        let again = try #require(inbox.prompts.first)
        inbox.answer(again)
        let opens = mayas.calls("/open").count
        let flow = try #require(inbox.answering?.flow)
        await #expect(throws: ApprovalProblem.restarted) { try await flow.open() }
        #expect(mayas.calls("/open").count == opens)
    }

    @Test func aPhoneWithNoDeviceKeyForTheAccountAsksAndShowsNothing() async throws {
        let server = ApprovalServer()
        _ = server.asked()
        let session = maya
        let inbox = ApprovalInbox(source: ApprovalInbox.Source(session: { session }, identity: { _ in nil }, wire: { _ in server.wire() }, limit: LimitBox().limit))
        await inbox.load()
        #expect(inbox.prompts.isEmpty)
        #expect(server.calls.isEmpty)
    }
}

/* The answer sheet's own order (`ApprovalAnswer`): what holds it, what a cancel does, and a request that turns the method on. */
@MainActor @Suite struct ApprovalAnswerTests {
    /* Whether the request is still the signed-in session's, which a test changes under the sheet. */
    private final class Standing: @unchecked Sendable {
        private let lock = NSLock()
        private var stands = true
        var value: Bool {
            get { lock.withLock { stands } }
            set { lock.withLock { stands = newValue } }
        }
    }

    private struct Sheet {
        let answer: ApprovalAnswer
        let key: DeviceSigningKey
        /* The notices the app was told to show, and the requests it was told have left the list. */
        let said: Seen<String>
        let finished: Seen<String>
        let standing: Standing
    }

    /* The sheet for the server's request, as the list shows it now. `wire`: the same server behind a gate, where a test holds a request. */
    private func makeSheet(_ server: ApprovalServer, wire: ApprovalWire? = nil) async throws -> Sheet {
        let key = try deviceSigningCreate()
        let listed = try await DeviceApprovals.listed(wire: server.wire())
        let prompt = try #require(listed.first { $0.id == server.requestId })
        let flow = ApprovalAnswering(prompt: prompt, wire: wire ?? server.wire(), userId: account, seed: key.seed, memory: ApprovalMemory())
        let said = Seen<String>()
        let finished = Seen<String>()
        let standing = Standing()
        let around = ApprovalAnswer.Around(say: { words, _ in said.add(words) }, finished: { finished.add($0) }, stands: { _ in standing.value })
        return Sheet(answer: ApprovalAnswer(flow: flow, around: around, every: .milliseconds(5)), key: key, said: said, finished: finished, standing: standing)
    }

    private func looks(_ server: ApprovalServer) -> Int { server.calls.filter { $0.method == "GET" && $0.path == "/api/auth/approvals" }.count }

    /* The sheet has opened the request and looks for the reveal, again and again, with none to find. */
    private func waiting(_ sheet: Sheet, _ server: ApprovalServer) async throws {
        try await until("opened") { server.calls("/open").count == 1 }
        let seen = looks(server)
        try await until("looking for the reveal") { looks(server) >= seen + 3 }
        #expect(sheet.answer.phase == .waiting)
    }

    @Test func waitingForTheOtherDeviceAfterAScanHoldsNothingAndDenyGoesThrough() async throws {
        let server = ApprovalServer()
        _ = server.asked()
        let sheet = try await makeSheet(server)
        sheet.answer.scan()
        #expect(sheet.answer.phase == .scanning)
        sheet.answer.scanned(try approvalQr(requestId: server.requestId, commitment: try #require(server.commitment)))
        // Opened; the other device reveals nothing, and may not for minutes.
        try await waiting(sheet, server)
        // Nothing is out: Cancel, a swipe, Deny and This wasn’t me are all there.
        #expect(!sheet.answer.held && !sheet.answer.sending)
        sheet.answer.end(.denied)
        // Now a request is out, and that does hold the sheet until its answer is in.
        #expect(sheet.answer.held)
        #expect(sheet.answer.cancel() == false && !sheet.answer.closed)
        try await until("denied") { sheet.answer.closed }
        #expect(server.deniedFor == "denied")
        #expect(sheet.said.values == ["Denied"] && sheet.finished.values == [server.requestId])
        #expect(server.calls("/approve").isEmpty)
        // The wait is over with it: nothing looks for the reveal any more.
        let seen = looks(server)
        try await Task.sleep(for: .milliseconds(40))
        #expect(looks(server) == seen)
    }

    @Test func thisWasntMeGoesThroughWhileTheTypedPathWaits() async throws {
        let server = ApprovalServer()
        _ = server.asked()
        let sheet = try await makeSheet(server)
        sheet.answer.type()
        try await waiting(sheet, server)
        #expect(!sheet.answer.held)
        sheet.answer.end(.notMe)
        try await until("ended") { sheet.answer.closed }
        #expect(server.deniedFor == "not-me")
    }

    @Test func cancellingWhileItWaitsEndsTheRequestAndAnywhereElseSendsNothing() async throws {
        // Waiting: this phone opened the request, and the other screen would wait on a phone that put it down.
        let server = ApprovalServer()
        _ = server.asked()
        let sheet = try await makeSheet(server)
        sheet.answer.scan()
        sheet.answer.scanned(try approvalQr(requestId: server.requestId, commitment: try #require(server.commitment)))
        try await waiting(sheet, server)
        #expect(sheet.answer.cancel())
        // Closed at once, without waiting for the server; the ending goes by itself.
        #expect(sheet.answer.closed)
        try await until("ended") { server.deniedFor == "denied" }
        try await until("left the list") { sheet.finished.values == [server.requestId] }
        #expect(sheet.said.values == ["Denied"])
        #expect(server.calls("/approve").isEmpty)

        // Before anything was opened: Cancel only closes, and the request stays in the list.
        let untouched = ApprovalServer()
        _ = untouched.asked()
        let unopened = try await makeSheet(untouched)
        #expect(unopened.answer.cancel() && unopened.answer.closed)
        // With the field up (the other device revealed): the same.
        let revealed = ApprovalServer()
        let asked = revealed.asked()
        let typing = try await makeSheet(revealed)
        typing.answer.type()
        try await until("opened") { revealed.calls("/open").count == 1 }
        revealed.reveal = asked
        revealed.set("revealed")
        try await until("the field") { typing.answer.phase == .typing }
        #expect(typing.answer.cancel() && typing.answer.closed)
        // Waiting, on a phone that has since left the account (the sheet went with its session): nothing is ended for it.
        let left = ApprovalServer()
        _ = left.asked()
        let gone = try await makeSheet(left)
        gone.answer.type()
        try await waiting(gone, left)
        gone.standing.value = false
        gone.answer.gone()
        #expect(gone.answer.closed)
        try await Task.sleep(for: .milliseconds(40))
        for (name, server, sheet) in [("unopened", untouched, unopened), ("typing", revealed, typing), ("left", left, gone)] {
            #expect(server.calls("/deny").isEmpty, "\(name)")
            #expect(server.current != "ended", "\(name)")
            #expect(sheet.said.values.isEmpty && sheet.finished.values.isEmpty, "\(name)")
        }
    }

    @Test func anApprovalThatIsOutHoldsTheSheetUntilItsAnswerIsIn() async throws {
        let server = ApprovalServer()
        let asked = server.asked()
        let gate = Gate()
        let wire = ApprovalWire(session: "session-tag") { method, path, body, stepToken in
            if path.hasSuffix("/approve") { await gate.pass() }
            return try await server.wire().send(method, path, body, stepToken)
        }
        let sheet = try await makeSheet(server, wire: wire)
        sheet.answer.type()
        try await until("opened") { server.calls("/open").count == 1 }
        server.reveal = asked
        server.set("revealed")
        try await until("the field") { sheet.answer.phase == .typing }
        let step = DeviceStep(userId: account, requestId: server.requestId, purpose: "login", tokenDigest: try #require(server.tokenDigest), deviceSigningKey: asked.key)
        let code = try deviceStepCode(step: step, approverKey: try #require(server.approverKey), nonce: asked.nonce)
        await gate.close()
        sheet.answer.approve(typed: code)
        try await gate.reached()
        // The signature is on its way: nothing closes the sheet, and nothing ends the request from under it.
        #expect(sheet.answer.held)
        #expect(sheet.answer.cancel() == false)
        sheet.answer.end(.denied)
        sheet.answer.end(.notMe)
        #expect(!sheet.answer.closed)
        await gate.open()
        try await until("approved") { sheet.answer.closed }
        #expect(server.calls("/deny").isEmpty)
        #expect(server.current == "approved")
        #expect(sheet.said.values == ["Approved"] && sheet.finished.values == [server.requestId])
        #expect(!sheet.answer.held)
    }

    @Test func aRequestThatTurnsTheMethodOnOffersNoScanAndNoFieldAndShowsItsCodeUntilDone() async throws {
        let server = ApprovalServer()
        let asked = server.asked(purpose: DeviceEnrolment.purpose)
        let sheet = try await makeSheet(server)
        #expect(sheet.answer.turnsOn)
        // Nothing to choose: no scan, no field, and no camera's word is taken.
        #expect(sheet.answer.phase == .waiting)
        sheet.answer.scan()
        sheet.answer.type()
        sheet.answer.scanned(try approvalQr(requestId: server.requestId, commitment: try #require(server.commitment)))
        #expect(sheet.answer.phase == .waiting)
        #expect(server.calls.filter { $0.method == "POST" }.isEmpty)
        // The sheet came up: the request is opened, and the reveal waited for. Approve does nothing before it is in.
        sheet.answer.appeared()
        try await waiting(sheet, server)
        sheet.answer.approve()
        #expect(!sheet.answer.sending)
        server.reveal = asked
        server.set("revealed")
        try await until("the reveal") { sheet.answer.phase == .confirm }
        // The press signs with nothing typed, and the code comes up.
        sheet.answer.approve()
        try await until("the code") { if case .shown = sheet.answer.phase { true } else { false } }
        let step = DeviceStep(userId: account, requestId: server.requestId, purpose: DeviceEnrolment.purpose, tokenDigest: try #require(server.tokenDigest), deviceSigningKey: asked.key)
        let code = try deviceStepCode(step: step, approverKey: try #require(server.approverKey), nonce: asked.nonce)
        #expect(sheet.answer.phase == .shown(code))
        #expect(deviceStepVerify(publicKey: sheet.key.publicKey, step: step, signature: try base64urlDecode(value: try #require(server.signature))))
        // It left the list at once. The server no longer lists it either; the code stays all the same: the sheet
        // does not close by itself, says nothing of a request that is over, and has nothing left to deny.
        #expect(sheet.finished.values == [server.requestId])
        #expect(server.current == "approved")
        try await Task.sleep(for: .milliseconds(60))
        sheet.answer.end(.denied)
        sheet.answer.end(.notMe)
        #expect(sheet.answer.phase == .shown(code))
        #expect(!sheet.answer.closed && !sheet.answer.held && sheet.answer.error.isEmpty)
        #expect(sheet.said.values.isEmpty)
        #expect(server.calls("/deny").isEmpty)
        sheet.answer.done()
        #expect(sheet.answer.closed)
        #expect(StepWords.askCode == "Code for your other device" && StepWords.done == "Done")
    }
}

/* Two of the account's devices that could approve, a pending method, and the backup codes turning the step on answers with. */
private let laptop = TwoStepStatus.Approver(id: "5b1c0d9e-8f7a-4c3b-9a2d-1e0f2a3b4c5d", kind: "web", name: "Maya’s Laptop", createdAt: nil)
private let tablet = TwoStepStatus.Approver(id: "9a2d1e0f-2a3b-4c5d-8f7a-5b1c0d9e4c3b", kind: "android", name: nil, createdAt: nil)
private let enrolment = DeviceEnrolment(id: "0f2a3b4c-5d5b-4c0d-9e8f-7a4c3b9a2d1e", token: token)
private let codes = ["7KQ2M-9XD4P", "AAAAA-BBBBB"]

/*
 * The setup's request to its chosen device, opened and approved there, as this phone then holds
 * it; and the code that device shows, worked out from the same values. Nothing here tells the
 * setup about the approval: a test does.
 */
@MainActor private func approvedAsk(_ setup: DeviceSetup, on server: ApprovalServer = ApprovalServer()) async throws -> (ask: DeviceAsk, code: String) {
    server.purpose = DeviceEnrolment.purpose
    let key = random32()
    let ask = try await setup.request(wire: server.wire(), key: key).start(name: "iPhone 16 Pro")
    let approver = random32()
    server.open(with: approver)
    #expect(try await ask.poll() == .opened)
    let nonce = try #require(server.calls("/reveal").last?.body["nonce"] as? String)
    server.set("approved")
    #expect(try await ask.poll() == .approved)
    let step = DeviceStep(userId: account, requestId: server.requestId, purpose: DeviceEnrolment.purpose, tokenDigest: stepTokenDigest(stepToken: token), deviceSigningKey: key)
    return (ask, try deviceStepCode(step: step, approverKey: approver, nonce: nonce))
}

@MainActor @Suite struct DeviceSetupTests {

    @Test func nothingIsSentUntilADeviceIsChosenAndEveryRequestNamesIt() async throws {
        // Two devices could approve, one of them perhaps opened by someone else with the password: the person says which.
        let setup = DeviceSetup(first: true, approvers: [laptop, tablet])
        #expect(setup.chosen == nil)
        let server = ApprovalServer()
        let started = Seen<String>()
        let start: DeviceSetup.Start = { password, _ in
            started.add(password)
            return enrolment
        }
        // The confirm button, with none chosen: the words, and nothing out. Not the pending method, not a request.
        var thrown: Error?
        do { try await setup.begin(password: "a password", twoStep: nil, start: start) } catch { thrown = error }
        #expect(thrown is DeviceSetup.Unchosen)
        #expect(ErrorWords.say(try #require(thrown)) == "Choose the device that will approve.")
        #expect(started.values.isEmpty && setup.started == nil)
        var asked = true
        do { _ = try setup.request(wire: server.wire(), key: random32()) } catch is DeviceSetup.Unchosen { asked = false }
        #expect(!asked)
        #expect(server.calls.isEmpty)
        // A device the settings did not list cannot be chosen.
        setup.choose("7c9e6679-7425-40de-944b-e07fc1f90ae7")
        #expect(setup.chosen == nil)
        setup.choose(tablet.id)
        #expect(setup.chosen == tablet)
        try await setup.begin(password: "a password", twoStep: nil, start: start)
        #expect(started.values == ["a password"])
        // The request carries the chosen id, and so does every Ask again.
        for _ in 0 ..< 2 {
            let ask = try await setup.request(wire: server.wire(), key: random32()).start(name: "iPhone 16 Pro")
            #expect(ask.token == token)
        }
        let made = server.calls.filter { $0.method == "POST" && $0.path == "/api/auth/approvals" }
        #expect(made.count == 2)
        #expect(made.allSatisfy { $0.body["approverDeviceId"] as? String == tablet.id })
        #expect(made.allSatisfy { $0.body["stepToken"] as? String == token })
        // Once the pending method is out, the choice stands: the device that is asked is the one on screen.
        setup.choose(laptop.id)
        #expect(setup.chosen == tablet)
        // The panel and the title name it: an unnamed device as the list of devices calls one.
        #expect(StepWords.askOpen(on: setup.chosen?.shownName) == "Open HushOS on Unknown device and choose Answer.")
        #expect(StepWords.approveOn(laptop.shownName) == "Approve on Maya’s Laptop")
        #expect(StepWords.askOpen(on: nil) == "Open HushOS on another device and choose Answer.")
        #expect(StepWords.approverHeading == "Device that will approve")
    }

    @Test func aSoleDeviceIsNeverChosenForThePersonAndASignInOrAChangeNamesNone() async throws {
        // One device could approve. Its name is its own word: someone with the password can sign in as "Maya’s Laptop"
        // and be the only entry, so a list that chose for the person would choose the intruder.
        for first in [true, false] {
            let setup = DeviceSetup(first: first, approvers: [laptop])
            #expect(setup.chosen == nil && setup.chosenId == nil, "first: \(first)")
            let server = ApprovalServer()
            let started = Seen<String>()
            let start: DeviceSetup.Start = { password, _ in
                started.add(password)
                return enrolment
            }
            // The confirm button says to choose, and nothing goes out: not the pending method, not a request.
            await #expect(throws: DeviceSetup.Unchosen.self, "first: \(first)") { try await setup.begin(password: "a password", twoStep: nil, start: start) }
            #expect(throws: DeviceSetup.Unchosen.self, "first: \(first)") { _ = try setup.request(wire: server.wire(), key: random32()) }
            #expect(started.values.isEmpty && setup.started == nil && server.calls.isEmpty, "first: \(first)")
            // Chosen by the person: now it is asked, by its id.
            setup.choose(laptop.id)
            try await setup.begin(password: "a password", twoStep: nil, start: start)
            _ = try await setup.request(wire: server.wire(), key: random32()).start(name: "iPhone 16 Pro")
            #expect(started.values == ["a password"], "first: \(first)")
            #expect(server.calls.first?.body["approverDeviceId"] as? String == laptop.id, "first: \(first)")
        }
        // Only turning the method on names a device: a sign-in's request, and a change's, are for any device that may answer.
        let server = ApprovalServer()
        _ = try await DeviceAsk.Request(wire: server.wire(session: nil), token: token, purpose: "login", key: random32()).start(name: "iPhone")
        #expect(server.calls.first?.body["approverDeviceId"] == nil)
    }

    @Test func aCodeThatIsNotTheApprovingDevicesDropsTheRequestAndSendsNothing() async throws {
        let setup = DeviceSetup(first: true, approvers: [laptop, tablet])
        setup.choose(tablet.id)
        try await setup.begin(password: "a password", twoStep: nil) { _, _ in enrolment }
        let server = ApprovalServer()
        let (ask, code) = try await approvedAsk(setup, on: server)
        // Nothing typed is confirmed before the setup was told of an approval, the right code included.
        let sent = Seen<String>()
        let send: DeviceSetup.Confirm = { _, _, code in
            sent.add(code)
            return .turnedOn(codes)
        }
        await #expect(throws: CancellationError.self) { _ = try await setup.confirm(typed: code, password: "a password", send: send) }
        // An approval of some other request is not this setup's: a sign-in's, or one made for another token.
        let signIn = ApprovalServer()
        let other = try await DeviceAsk.start(wire: signIn.wire(session: nil), stepToken: token, purpose: "login", deviceSigningKey: random32(), name: "iPhone")
        setup.approved(by: other)
        #expect(!setup.awaitsCode)
        let elsewhere = ApprovalServer()
        let stray = try await DeviceAsk.start(
            wire: elsewhere.wire(), stepToken: String(repeating: "x", count: 43), purpose: DeviceEnrolment.purpose, deviceSigningKey: random32(), name: "iPhone", approver: tablet.id
        )
        setup.approved(by: stray)
        #expect(!setup.awaitsCode)
        setup.approved(by: ask)
        #expect(setup.awaitsCode)
        // One try. Another code, well formed and wrong: the words, the request dropped here, and nothing sent anywhere.
        let calls = server.calls.count
        var thrown: Error?
        do { _ = try await setup.confirm(typed: wrong(code), password: "a password", send: send) } catch { thrown = error }
        #expect(thrown is DeviceSetup.WrongCode)
        #expect(ErrorWords.say(try #require(thrown)) == "That code didn’t match, so nothing was turned on.")
        #expect(sent.values.isEmpty && server.calls.count == calls)
        #expect(!setup.awaitsCode && !setup.confirming && setup.codes == nil)
        // The right code afterwards is too late for that request.
        await #expect(throws: CancellationError.self) { _ = try await setup.confirm(typed: code, password: "a password", send: send) }
        #expect(sent.values.isEmpty)
        // The setup still stands, and may be closed: Ask again makes a new request to the same device.
        #expect(setup.started == enrolment && setup.mayClose)
        let again = ApprovalServer()
        let (next, shown) = try await approvedAsk(setup, on: again)
        #expect(again.calls.first?.body["approverDeviceId"] as? String == tablet.id)
        setup.approved(by: next)
        #expect(try await setup.confirm(typed: loosely(shown), password: "a password", send: send) == .turnedOn)
        // What goes with the confirmation is the code as it is written, however it was typed.
        #expect(sent.values == [shown])
        #expect(StepWords.codeOn(tablet.shownName) == "Code on Unknown device" && StepWords.codeOn(laptop.shownName) == "Code on Maya’s Laptop")
        #expect(StepWords.turnOn == "Turn on" && StepWords.add == "Add" && StepWords.askAgain == "Ask again")
    }

    @Test func theSheetDoesNotCloseOverAConfirmationThatIsOutAndTheCodesOutliveAnAttemptToCloseIt() async throws {
        let setup = DeviceSetup(first: true, approvers: [laptop])
        setup.choose(laptop.id)
        setup.removeOthers = false
        try await setup.begin(password: "a password", twoStep: nil) { _, _ in enrolment }
        let (ask, code) = try await approvedAsk(setup)
        setup.approved(by: ask)
        // The other device approved and its code is not typed yet: nothing is out, and the sheet may still be closed.
        #expect(setup.mayClose)
        let gate = Gate()
        await gate.close()
        let pendingWhenSent = Seen<Bool>()
        let confirming = Task {
            try await setup.confirm(typed: code, password: "a password", send: { _, _, _ in
                // The state is set before the request goes, not when its answer comes.
                pendingWhenSent.add(await setup.confirming)
                await gate.pass()
                return .turnedOn(codes)
            })
        }
        try await gate.reached()
        #expect(pendingWhenSent.values == [true])
        // The server has the confirmation and has not answered. Cancel, a swipe and the sheet going away are all refused.
        #expect(setup.confirming && !setup.mayClose)
        #expect(setup.close() == false)
        #expect(setup.started != nil)
        // Whoever was waiting for the answer is cancelled (the screen's own task): the answer is taken all the same.
        confirming.cancel()
        await gate.open()
        #expect(try await confirming.value == .turnedOn)
        #expect(setup.codes == codes)
        #expect(!setup.confirming)
        // The codes are up: still nothing but their own Done closes the sheet, and an attempt costs nothing.
        #expect(!setup.mayClose)
        #expect(setup.close() == false)
        #expect(setup.codes == codes)
        setup.done()
        #expect(setup.codes == nil && setup.mayClose)
    }

    @Test func aConfirmationSentBeforeTheApprovalLandedChangesNothingAndALostOneSaysSo() async throws {
        let setup = DeviceSetup(first: true, approvers: [laptop])
        setup.choose(laptop.id)
        try await setup.begin(password: "a password", twoStep: nil) { _, _ in enrolment }
        let (ask, code) = try await approvedAsk(setup)
        setup.approved(by: ask)
        // 409 `step-pending`: nothing changed, the same setup stands and may be closed while it waits.
        let pending = StepError.refused(.pending, "Waiting for your other device.")
        await #expect(throws: pending) { _ = try await setup.confirm(typed: code, password: "a password", send: { _, _, _ in throw pending }) }
        #expect(setup.started == enrolment && !setup.confirming && setup.mayClose && setup.codes == nil)
        // The approval and its code still stand: the same confirmation goes again.
        #expect(setup.awaitsCode)
        // The reply never arrived: HushOS can't tell whether it was turned on, says so, and this setup is over.
        let lost = StepError.lost(StepWords.lostDeviceOn)
        let sent = Seen<String>()
        await #expect(throws: lost) {
            _ = try await setup.confirm(typed: code, password: "a password", send: { _, id, code in
                sent.add("\(id) \(code)")
                throw lost
            })
        }
        #expect(sent.values == ["\(ask.requestId) \(code)"])
        #expect(lost.errorDescription == "The server’s answer didn’t arrive, so HushOS can’t tell whether approving on another device was turned on. Check before you try again.")
        #expect(setup.started == nil && !setup.confirming && setup.codes == nil && !setup.awaitsCode)
        // The server's own refusal of a code (409 `device-code`) is the end of the setup too, in its words.
        try await setup.begin(password: "a password", twoStep: nil) { _, _ in enrolment }
        let (second, secondCode) = try await approvedAsk(setup)
        setup.approved(by: second)
        let refused = StepError.refused(.other, "That code didn’t match, so nothing was turned on.")
        await #expect(throws: refused) { _ = try await setup.confirm(typed: secondCode, password: "a password", send: { _, _, _ in throw refused }) }
        #expect(setup.started == nil && !setup.awaitsCode && setup.codes == nil)
        // Turning the step on always comes back with the codes: an answer without them claims nothing.
        try await setup.begin(password: "a password", twoStep: nil) { _, _ in enrolment }
        let (third, thirdCode) = try await approvedAsk(setup)
        setup.approved(by: third)
        await #expect(throws: StepError.lost(StepWords.lostTurnedOn)) { _ = try await setup.confirm(typed: thirdCode, password: "a password", send: { _, _, _ in .added }) }
        #expect(setup.codes == nil)
        // Beside other methods, `added` is the answer.
        let beside = DeviceSetup(first: false, approvers: [laptop])
        beside.choose(laptop.id)
        try await beside.begin(password: "a password", twoStep: nil) { _, _ in enrolment }
        let (fourth, fourthCode) = try await approvedAsk(beside)
        beside.approved(by: fourth)
        #expect(try await beside.confirm(typed: fourthCode, password: "a password", send: { _, _, _ in .added }) == .added)
    }

    @Test func aSetupThatWasClosedConfirmsNothing() async throws {
        // Cancel was pressed just as the other device approved: the approval is heard of after the sheet let go.
        let setup = DeviceSetup(first: true, approvers: [laptop])
        setup.choose(laptop.id)
        try await setup.begin(password: "a password", twoStep: nil) { _, _ in enrolment }
        let (ask, code) = try await approvedAsk(setup)
        setup.approved(by: ask)
        #expect(setup.close())
        #expect(!setup.awaitsCode)
        let sent = Seen<String>()
        let send: DeviceSetup.Confirm = { _, id, _ in
            sent.add(id)
            return .turnedOn(codes)
        }
        await #expect(throws: CancellationError.self) { _ = try await setup.confirm(typed: code, password: "a password", send: send) }
        // Nor does an approval heard of after the sheet let go bring the field back.
        setup.approved(by: ask)
        #expect(!setup.awaitsCode)
        await #expect(throws: CancellationError.self) { _ = try await setup.confirm(typed: code, password: "a password", send: send) }
        #expect(sent.values.isEmpty)
        #expect(setup.codes == nil)
    }
}

@Suite struct DeviceMethodSettingsTests {
    private func status(
        _ methods: [[String: Any]], on: Bool = true, defaultKind: String? = nil, otherDevice: Any? = nil, approvers: [[String: Any]]? = nil
    ) throws -> TwoStepStatus {
        var body: [String: Any] = ["on": on, "methods": methods, "backupCodesLeft": 10, "totpFrozen": false, "defaultKind": defaultKind as Any? ?? NSNull()]
        if let otherDevice { body["otherDevice"] = otherDevice }
        if let approvers { body["approvers"] = approvers }
        return try #require(TwoStepStatus(body))
    }

    private let laptopRow: [String: Any] = ["id": "5b1c0d9e-8f7a-4c3b-9a2d-1e0f2a3b4c5d", "kind": "web", "name": "Maya’s Laptop", "createdAt": "2026-11-02T09:00:00.000Z"]

    private let app: [String: Any] = ["id": "a", "kind": "totp"]
    private let device: [String: Any] = ["id": "d", "kind": "device"]

    @Test func theRowSaysOnOffOrThatItNeedsAnotherDeviceAndOffersOnlyWhatCanBeDone() throws {
        // A server that does not know the method says nothing of it: no row at all.
        #expect(try !status([app]).showsDevice)
        // Off, with another device that could approve: Turn on, on a phone with a key of its own to ask with.
        let off = try status([app], otherDevice: true, approvers: [laptopRow])
        #expect(off.showsDevice && off.deviceValue == "Off")
        #expect(off.canTurnOnDevice(ownKey: true))
        #expect(!off.canTurnOnDevice(ownKey: false))
        // A server that names no device to choose: there is nothing the sheet could ask, so it is not offered.
        #expect(try !status([app], otherDevice: true).canTurnOnDevice(ownKey: true))
        // No other device signed in: said, and nothing to press.
        let alone = try status([], on: false, otherDevice: false)
        #expect(alone.showsDevice && alone.deviceValue == "Needs another device")
        #expect(!alone.canTurnOnDevice(ownKey: true))
        // A 1 is not the server's yes.
        #expect(try !status([app], otherDevice: 1).showsDevice)
        // On: its value, and never Turn on beside it.
        let on = try status([app, device], defaultKind: "totp", otherDevice: true)
        #expect(on.deviceValue == "On" && on.device?.id == "d")
        #expect(!on.canTurnOnDevice(ownKey: true))
    }

    @Test func theDevicesThatCouldApproveAreListedAsThePersonKnowsThem() throws {
        let read = try status([], on: false, otherDevice: true, approvers: [
            laptopRow,
            ["id": "9a2d1e0f-2a3b-4c5d-8f7a-5b1c0d9e4c3b", "kind": "android", "name": NSNull(), "createdAt": "2026-10-30T18:00:00.000Z"],
            ["id": "0f2a3b4c-5d5b-4c0d-9e8f-7a4c3b9a2d1e", "kind": NSNull(), "name": "   ", "createdAt": "never"],
            // No id: nothing could be asked of it.
            ["kind": "ios", "name": "iPhone", "createdAt": "2026-11-02T09:00:00.000Z"],
        ])
        #expect(read.approvers.map(\.id) == ["5b1c0d9e-8f7a-4c3b-9a2d-1e0f2a3b4c5d", "9a2d1e0f-2a3b-4c5d-8f7a-5b1c0d9e4c3b", "0f2a3b4c-5d5b-4c0d-9e8f-7a4c3b9a2d1e"])
        #expect(read.approvers.map(\.shownName) == ["Maya’s Laptop", "Unknown device", "Unknown device"])
        // Its kind in the Devices list's words, and when it was added.
        let day: (Date) -> String = { _ in "2 Nov" }
        #expect(read.approvers[0].line(day: day) == "A web browser · Added 2 Nov")
        #expect(read.approvers[1].line(day: day) == "Android phone · Added 2 Nov")
        #expect(read.approvers[2].line(day: day) == "")
        // A server that lists none (an older one): none.
        #expect(try status([], on: false, otherDevice: true).approvers.isEmpty)
    }

    @Test func theDefaultIsOfferedAmongWhateverKindsTheAccountHas() throws {
        let both = try status([app, device], defaultKind: "totp", otherDevice: true)
        #expect(both.choosing)
        #expect(both.isDefault(.totp) && !both.isDefault(.device))
        #expect(both.canMakeDefault(.device) && !both.canMakeDefault(.totp))
        // A kind the account has no method of cannot be made the default: the server refuses it.
        #expect(!both.canMakeDefault(.webauthn))
        #expect(StepKind.device.rawValue == "device")
        // The only method: nothing to choose, and turning it off is turning the step off.
        let only = try status([device], defaultKind: "device", otherDevice: true)
        #expect(!only.choosing && !only.isDefault(.device) && !only.canMakeDefault(.device))
        #expect(only.removesLast)
        #expect(!both.removesLast)
    }

    @Test func turningItOffSaysWhatTheServerSaidHappened() {
        #expect(TwoStep.removedWords(kind: "device", on: true) == "Approve on another device is off")
        #expect(TwoStep.removedWords(kind: "device", on: false) == "Two-step sign-in is off.")
    }

    @Test func theLogNamesAnotherDevice() {
        func words(_ kind: String, _ method: String? = nil) -> String { SecurityEvent(id: "e", kind: kind, method: method, deviceKind: nil, createdAt: nil).words }
        #expect(words("sign-in", "device") == "Signed in with your password and another device")
        #expect(words("step-failed", "device") == "Wrong answer to the second step, with another device")
        #expect(words("method-added", "device") == "Approve on another device turned on")
        #expect(words("method-removed", "device") == "Approve on another device turned off")
        #expect(words("default-changed", "device") == "Default changed to another device")
    }
}

extension OnFakeDrive {
    /* The requests themselves, against the stub server the other two-step requests use. */
    @Suite struct DeviceStepRequestTests {
        let origin = "https://step.test"

        func serve(_ server: StepServer) {
            StepServer.current = server
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [StepServerProtocol.self]
            Auth.testTransport = configuration
            Auth.testSession = SharedKeychain.Session(origin: origin, token: "session-token", userId: account)
        }

        func done() { Auth.testSession = nil; Auth.testTransport = nil; StepServer.current = nil }

        @Test func anAnswerSentBeforeTheApprovalLandedIsPendingNeverWrongAndNamesItsRequest() async throws {
            let server = StepServer(409, json: ["message": "Waiting for your other device.", "code": "step-pending"])
            serve(server)
            defer { done() }
            let pending = PendingSignIn(origin: origin, email: "maya@example.org", challenge: step([.device, .totp]), exportKey: Data(repeating: 1, count: 64))
            var thrown: Error?
            do { _ = try await Auth.answerStep(pending, proof: .device(requestId: "7C9E6679-7425-40DE-944B-E07FC1F90AE7")) } catch { thrown = error }
            #expect(thrown as? StepError == .refused(.pending, "Waiting for your other device."))
            let sent = try #require(server.requests.first)
            #expect(sent.path == "/api/auth/login/two-step")
            #expect(sent.body["token"] as? String == token)
            #expect((sent.body["proof"] as? [String: String]) == ["kind": "device", "requestId": "7c9e6679-7425-40de-944b-e07fc1f90ae7"])
            #expect(sent.headers["Cookie"] == nil)
        }

        @Test func aSignInsRequestsCarryNoSessionAndAChangesCarryItsOwn() async throws {
            let server = StepServer(200, json: ["state": "waiting"])
            server.script = { body in body["commitment"] == nil ? nil : (200, json(["requestId": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "userId": account, "expiresAt": "2026-11-14T10:05:00.000Z"])) }
            serve(server)
            defer { done() }
            let signingIn = try await DeviceAsk.start(wire: .signIn(origin: origin), stepToken: token, purpose: "login", deviceSigningKey: random32(), name: "iPhone")
            #expect(try await signingIn.poll() == .waiting)
            #expect(server.requests.count == 2)
            #expect(server.requests.allSatisfy { $0.headers["Cookie"] == nil && $0.headers["Origin"] == origin })
            #expect(server.requests[0].method == "POST" && server.requests[0].path == "/api/auth/approvals")
            #expect(server.requests[1].method == "GET" && server.requests[1].path == "/api/auth/approvals/7c9e6679-7425-40de-944b-e07fc1f90ae7")
            #expect(server.requests[1].headers["x-step-token"] == token)
            #expect(server.requests[1].query == nil)
            // Signed in (a change, or turning the method on): the same routes, under this session and no other.
            let session = try #require(Auth.currentSession)
            let changing = try await DeviceAsk.start(wire: .signedIn(session), stepToken: token, purpose: "password", deviceSigningKey: random32(), name: "iPhone")
            _ = try await changing.poll()
            #expect(server.requests.suffix(2).allSatisfy { $0.headers["Cookie"] == "__Host-hushos-session=session-token" })
        }

        @Test func aStepForAChangeNamesAnotherDeviceOnlyWithAKeyToAskItWith() async throws {
            let reply = "{\"token\":\"\(token)\",\"methods\":[\"device\",\"totp\",\"backup\"],\"expiresAt\":\"2026-11-14T10:05:00.000Z\"}"
            serve(StepServer(200, reply))
            defer { done() }
            let memory = AdvertMemory([origin: true])
            let asked = try await TwoStep.challenge(.password, adverts: memory.adverts, linkHost: nil, device: true)
            #expect(asked?.methods == [.device, .totp, .backup])
            #expect(StepServer.current?.requests.last?.body["twoStepMethods"] as? [String] == ["device"])
            _ = try await TwoStep.challenge(.password, adverts: memory.adverts, linkHost: "step.test", device: true)
            #expect(StepServer.current?.requests.last?.body["twoStepMethods"] as? [String] == ["webauthn", "device"])
            // No device key for this account on the phone: it names none, so the server never lists it one.
            _ = try await TwoStep.challenge(.password, adverts: memory.adverts, linkHost: nil, device: false)
            #expect((StepServer.current?.requests.last?.body["twoStepMethods"] as? [String])?.isEmpty == true)
        }

        @Test func theSettingsAskForAnotherDeviceAndReadWhetherItCanBeTurnedOn() async throws {
            serve(StepServer(200, json: [
                "on": true, "backupCodesLeft": 9, "totpFrozen": false, "defaultKind": "device", "otherDevice": true,
                "approvers": [["id": "5b1c0d9e-8f7a-4c3b-9a2d-1e0f2a3b4c5d", "kind": "web", "name": "Maya’s Laptop", "createdAt": "2026-11-02T09:00:00.000Z"]],
                "methods": [["id": "d", "kind": "device", "name": NSNull(), "createdAt": "2026-11-14T09:30:00.000Z", "lastUsedAt": NSNull()], ["id": "a", "kind": "totp"]],
            ]))
            defer { done() }
            let read = try #require(try await TwoStep.status())
            #expect(StepServer.current?.requests.first?.query == "methods=webauthn,device")
            #expect(read.device?.id == "d" && read.otherDevice == true)
            #expect(read.approvers.map(\.shownName) == ["Maya’s Laptop"])
            #expect(read.isDefault(.device))
        }

        @MainActor @Test func turningTheStepOnRemovesEveryOtherDeviceButTheOneThatApproved() async throws {
            // The password proof is an OPAQUE exchange with a real server; here it is given, and the request it goes in is the app's own.
            let remove: DeviceSetup.Remove = { password, keep in
                try await Devices.removeOthers(password: password, keep: keep, proof: { _ in ["attemptToken": "attempt", "finishLoginRequest": "finish"] })
            }
            func turnOn(first: Bool, ticked: Bool) async throws -> (StepServer, DeviceSetup, [Bool]) {
                let server = StepServer(200, json: ["removed": 2])
                server.script = { body in body["requestId"] == nil ? nil : (200, json(first ? ["backupCodes": codes] : ["added": true])) }
                serve(server)
                let setup = DeviceSetup(first: first, approvers: [laptop, tablet])
                setup.choose(tablet.id)
                setup.removeOthers = ticked
                try await setup.begin(password: "a password", twoStep: nil) { _, _ in enrolment }
                let (ask, code) = try await approvedAsk(setup)
                setup.approved(by: ask)
                let ended = Seen<Bool>()
                _ = try await setup.confirm(typed: code, password: "a password", remove: remove, removal: { ended.add($0) })
                // The codes are there before the removal has answered: it runs behind them.
                if first { #expect(setup.codes == codes) }
                for _ in 0 ..< 500 where setup.removing == .running { try await Task.sleep(for: .milliseconds(2)) }
                return (server, setup, ended.values)
            }
            defer { done() }
            let (server, setup, ended) = try await turnOn(first: true, ticked: true)
            let sent = try #require(server.requests.last)
            #expect(sent.method == "DELETE" && sent.path == "/api/auth/devices/others")
            // Every other device but the chosen one: it approved, and it is the method.
            #expect(sent.body["keep"] as? String == tablet.id)
            #expect(sent.body["attemptToken"] as? String == "attempt" && sent.body["finishLoginRequest"] as? String == "finish")
            #expect(sent.headers["Cookie"] == "__Host-hushos-session=session-token")
            #expect(ended == [true] && setup.removing == .no)
            // Unticked, nothing is removed; and a method added beside others never removes a device, whatever the box said.
            let (unticked, _, _) = try await turnOn(first: true, ticked: false)
            #expect(unticked.requests.allSatisfy { $0.method != "DELETE" })
            let (beside, _, _) = try await turnOn(first: false, ticked: true)
            #expect(beside.requests.allSatisfy { $0.method != "DELETE" })
            // A removal that fails is a notice, and never costs the codes.
            let failing = DeviceSetup(first: true, approvers: [laptop])
            failing.choose(laptop.id)
            try await failing.begin(password: "a password", twoStep: nil) { _, _ in enrolment }
            let (ask, code) = try await approvedAsk(failing)
            failing.approved(by: ask)
            let failed = Seen<Bool>()
            _ = try await failing.confirm(typed: code, password: "a password", send: { _, _, _ in .turnedOn(codes) }, remove: { _, _ in throw AuthError.message("no") }, removal: { failed.add($0) })
            for _ in 0 ..< 500 where failing.removing == .running { try await Task.sleep(for: .milliseconds(2)) }
            #expect(failed.values == [false] && failing.removing == .failed && failing.codes == codes)
            // Without a device to keep, the plain removal carries none.
            let plain = StepServer(200, json: ["removed": 1])
            serve(plain)
            _ = try await Devices.removeOthers(password: "a password", keep: nil, proof: { _ in ["attemptToken": "attempt", "finishLoginRequest": "finish"] })
            #expect(plain.requests.last?.body["keep"] == nil)
            #expect(StepWords.othersButApprover == "All but this one and the one that approves. They’ll need to sign in again.")
        }

        @MainActor @Test func theApprovalAloneSendsNoConfirmationAndTheTypedCodeGoesWithIt() async throws {
            // The requests as the app itself makes them: the stub answers what would turn the step on, if it were asked.
            let server = StepServer(200, json: ["backupCodes": codes])
            serve(server)
            defer { done() }
            let setup = DeviceSetup(first: true, approvers: [laptop])
            setup.choose(laptop.id)
            setup.removeOthers = false
            try await setup.begin(password: "a password", twoStep: nil) { _, _ in enrolment }
            let (ask, code) = try await approvedAsk(setup)
            // The chosen device approved, and the setup hears of it. Someone with the password, signed in under the
            // name of the owner's device, can get this far: it turns nothing on, and nothing is sent.
            setup.approved(by: ask)
            try await Task.sleep(for: .milliseconds(40))
            #expect(server.requests.isEmpty)
            #expect(setup.awaitsCode && !setup.confirming && setup.codes == nil && setup.started == enrolment)
            // The code that device shows, typed here as people type: now the confirmation goes, once, with the code as written.
            #expect(try await setup.confirm(typed: loosely(code), password: "a password") == .turnedOn)
            #expect(server.requests.count == 1)
            let sent = try #require(server.requests.first)
            #expect(sent.method == "POST" && sent.path == "/api/auth/two-step/device/\(enrolment.id)/confirm")
            #expect(Set(sent.body.keys) == ["token", "requestId", "code"])
            #expect(sent.body["token"] as? String == token && sent.body["requestId"] as? String == ask.requestId)
            #expect(sent.body["code"] as? String == code)
            #expect(setup.codes == codes)
        }

        @Test func turningItOnIsConfirmedOnlyByTheServersOwnTwoAnswers() async throws {
            let started = DeviceEnrolment(id: "5b1c0d9e-8f7a-4c3b-9a2d-1e0f2a3b4c5d", token: token)
            let request = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
            defer { done() }
            serve(StepServer(200, json: ["backupCodes": ["7KQ2M-9XD4P", "AAAAA-BBBBB"]]))
            #expect(try await TwoStep.confirmDevice(started, requestId: request, code: "47 river") == .turnedOn(["7KQ2M-9XD4P", "AAAAA-BBBBB"]))
            let sent = try #require(StepServer.current?.requests.first)
            #expect(sent.method == "POST" && sent.path == "/api/auth/two-step/device/5b1c0d9e-8f7a-4c3b-9a2d-1e0f2a3b4c5d/confirm")
            #expect(sent.body["token"] as? String == token && sent.body["requestId"] as? String == request)
            #expect(sent.body["code"] as? String == "47 river")
            serve(StepServer(200, json: ["added": true]))
            #expect(try await TwoStep.confirmDevice(started, requestId: request, code: "47 river") == .added)
            // Not approved yet: nothing changed, and the wait goes on.
            serve(StepServer(409, json: ["message": "Waiting for your other device.", "code": "step-pending"]))
            await #expect(throws: StepError.refused(.pending, "Waiting for your other device.")) { _ = try await TwoStep.confirmDevice(started, requestId: request, code: "47 river") }
            // The server worked the code out again and disagreed: its own words, as any other refusal.
            serve(StepServer(409, json: ["message": "That code didn’t match, so nothing was turned on.", "code": "device-code"]))
            await #expect(throws: StepError.refused(.other, "That code didn’t match, so nothing was turned on.")) { _ = try await TwoStep.confirmDevice(started, requestId: request, code: "47 river") }
            // Anything else with a 200 says nothing either way.
            for body in ["{}", "{\"added\":false}", "{\"error\":\"proxy\"}", "{\"backupCodes\":[]}", "<html>"] {
                serve(StepServer(200, body))
                await #expect(throws: StepError.lost(StepWords.lostDeviceOn), "\(body)") { _ = try await TwoStep.confirmDevice(started, requestId: request, code: "47 river") }
            }
        }
    }
}
