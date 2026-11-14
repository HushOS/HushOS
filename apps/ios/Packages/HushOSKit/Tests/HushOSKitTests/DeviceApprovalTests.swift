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
 * - it shows at most five prompts a day for each class, whatever the server lists;
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
            return (200, json(["approverKey": approverKey ?? ""]))
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
        #expect(approvalQrRead(text: ask.qr) == ApprovalQr(requestId: server.requestId, commitment: try #require(made.body["commitment"] as? String)))
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

@Suite struct ApprovalAnsweringTests {
    /* The answering phone: its own account id and device key, and the request as first listed. */
    private struct Phone {
        let key: DeviceSigningKey
        let flow: ApprovalAnswering
    }

    private func answering(_ server: ApprovalServer) async throws -> Phone {
        let key = try deviceSigningCreate()
        let listed = try await DeviceApprovals.listed(wire: server.wire())
        let prompt = try #require(listed.first { $0.id == server.requestId })
        return Phone(key: key, flow: ApprovalAnswering(prompt: prompt, wire: server.wire(), userId: account, seed: key.seed))
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
                id: try text("requestId"), purpose: purpose, class: "unknown", deviceKind: "web", deviceName: "Chrome on Windows",
                createdAt: "2026-11-14T10:00:00.000Z", expiresAt: "2026-11-14T10:05:00.000Z", tokenDigest: try text("tokenDigest"), commitment: try text("commitment"),
                approverKey: nil, revealKey: nil, revealNonce: nil
            )
            let signed = Seen<String>()
            let approver = try text("approverKey")
            let entry: [String: Any] = [
                "id": prompt.id, "purpose": purpose, "class": "unknown", "device": ["kind": "web", "name": "Chrome on Windows"],
                "createdAt": prompt.createdAt, "expiresAt": prompt.expiresAt, "tokenDigest": prompt.tokenDigest, "commitment": prompt.commitment,
                "approverKey": approver, "reveal": ["deviceSigningKey": try text("deviceSigningKey"), "nonce": try text("nonce")],
            ]
            let listed = json(["userId": "u", "approvals": [entry]])
            let wire = ApprovalWire(session: "tag") { method, path, body, _ in
                if method == "GET" { return ApprovalWire.Reply(status: 200, text: listed) }
                if path.hasSuffix("/open") { return ApprovalWire.Reply(status: 200, text: json(["approverKey": approver])) }
                if path.hasSuffix("/approve"), let body, let sent = (try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any])?["signature"] as? String {
                    signed.add(sent)
                    return ApprovalWire.Reply(status: 200, text: json(["approved": true]))
                }
                return ApprovalWire.Reply(status: 200, text: json(["ended": true]))
            }
            let flow = ApprovalAnswering(prompt: prompt, wire: wire, userId: try text("userId"), seed: key.seed)
            // The browser's QR code is this request's.
            #expect(try await flow.open(scanned: try text("qr")), "\(purpose)")
            #expect(try await flow.revealed(), "\(purpose)")
            // The browser's code is the code; one that is not it would have ended the request instead.
            let other = ApprovalAnswering(prompt: prompt, wire: wire, userId: try text("userId"), seed: key.seed)
            try await other.open()
            #expect(try await other.revealed())
            try await other.approve(typed: try text("code"))
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

@Suite struct DeviceMethodSettingsTests {
    private func status(_ methods: [[String: Any]], on: Bool = true, defaultKind: String? = nil, otherDevice: Any? = nil) throws -> TwoStepStatus {
        var body: [String: Any] = ["on": on, "methods": methods, "backupCodesLeft": 10, "totpFrozen": false, "defaultKind": defaultKind as Any? ?? NSNull()]
        if let otherDevice { body["otherDevice"] = otherDevice }
        return try #require(TwoStepStatus(body))
    }

    private let app: [String: Any] = ["id": "a", "kind": "totp"]
    private let device: [String: Any] = ["id": "d", "kind": "device"]

    @Test func theRowSaysOnOffOrThatItNeedsAnotherDeviceAndOffersOnlyWhatCanBeDone() throws {
        // A server that does not know the method says nothing of it: no row at all.
        #expect(try !status([app]).showsDevice)
        // Off, with another device that could approve: Turn on, on a phone with a key of its own to ask with.
        let off = try status([app], otherDevice: true)
        #expect(off.showsDevice && off.deviceValue == "Off")
        #expect(off.canTurnOnDevice(ownKey: true))
        #expect(!off.canTurnOnDevice(ownKey: false))
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

    @Test func theDefaultIsOfferedAmongWhateverKindsTheAccountHas() throws {
        let both = try status([app, device], defaultKind: "totp", otherDevice: true)
        #expect(both.choosing)
        #expect(both.isDefault(.totp) && !both.isDefault(.device))
        #expect(both.canMakeDefault(.device) && !both.canMakeDefault(.totp))
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
                "methods": [["id": "d", "kind": "device", "name": NSNull(), "createdAt": "2026-11-14T09:30:00.000Z", "lastUsedAt": NSNull()], ["id": "a", "kind": "totp"]],
            ]))
            defer { done() }
            let read = try #require(try await TwoStep.status())
            #expect(StepServer.current?.requests.first?.query == "methods=webauthn,device")
            #expect(read.device?.id == "d" && read.otherDevice == true)
            #expect(read.isDefault(.device))
        }

        @Test func turningItOnIsConfirmedOnlyByTheServersOwnTwoAnswers() async throws {
            let started = DeviceEnrolment(id: "5b1c0d9e-8f7a-4c3b-9a2d-1e0f2a3b4c5d", token: token)
            let request = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
            defer { done() }
            serve(StepServer(200, json: ["backupCodes": ["7KQ2M-9XD4P", "AAAAA-BBBBB"]]))
            #expect(try await TwoStep.confirmDevice(started, requestId: request) == .turnedOn(["7KQ2M-9XD4P", "AAAAA-BBBBB"]))
            let sent = try #require(StepServer.current?.requests.first)
            #expect(sent.method == "POST" && sent.path == "/api/auth/two-step/device/5b1c0d9e-8f7a-4c3b-9a2d-1e0f2a3b4c5d/confirm")
            #expect(sent.body["token"] as? String == token && sent.body["requestId"] as? String == request)
            serve(StepServer(200, json: ["added": true]))
            #expect(try await TwoStep.confirmDevice(started, requestId: request) == .added)
            // Not approved yet: nothing changed, and the wait goes on.
            serve(StepServer(409, json: ["message": "Waiting for your other device.", "code": "step-pending"]))
            await #expect(throws: StepError.refused(.pending, "Waiting for your other device.")) { _ = try await TwoStep.confirmDevice(started, requestId: request) }
            // Anything else with a 200 says nothing either way.
            for body in ["{}", "{\"added\":false}", "{\"error\":\"proxy\"}", "{\"backupCodes\":[]}", "<html>"] {
                serve(StepServer(200, body))
                await #expect(throws: StepError.lost(StepWords.lostDeviceOn), "\(body)") { _ = try await TwoStep.confirmDevice(started, requestId: request) }
            }
        }
    }
}
