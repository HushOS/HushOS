import Foundation
import HushOSCore

/*
 * Approve on another device, as the second step (docs/two-step-design.md 12): the phone that asks
 * and the phone that answers. Everything cryptographic is the core's (`device_approval.rs`), and so
 * is every reply's reading; what is here is the order of things, which is the security of it:
 *
 * - the asking phone commits first, reveals its key and nonce only once another device has fixed
 *   its own value, and only once; it answers the step only with a request that was approved;
 * - the answering phone keeps the commitment as it stood before it opened the request, refuses a
 *   reveal that is not that commitment, and signs only after the code on the other screen was
 *   typed exactly, or its QR code scanned and found to be this very request.
 *
 * The screens are the app's (`App/DeviceApproval.swift`); nothing here draws anything, so all of
 * it is tested without one (`DeviceApprovalTests`).
 */

/* MARK: The requests */

/*
 * How an approval's requests go out. A sign-in has no session, only its step token; a change, and
 * the phone that answers, send the session's cookie. Tests put their own server here.
 */
public struct ApprovalWire: Sendable {
    public struct Reply: Sendable, Equatable {
        public let status: Int
        public let text: String

        public init(status: Int, text: String) {
            self.status = status
            self.text = text
        }

        var code: UInt16 { UInt16(clamping: status) }
    }

    /* The method, the path, the body as the core wrote it, and the step token where a read carries it (`x-step-token`). */
    public typealias Send = @Sendable (_ method: String, _ path: String, _ body: String?, _ stepToken: String?) async throws -> Reply

    let send: Send
    /* The session the requests go under, by its tag: what a 401 ends. Nil for a sign-in's. */
    let session: String?

    public init(session: String? = nil, send: @escaping Send) {
        self.session = session
        self.send = send
    }

    /* A sign-in's: no session yet, and the phones never send one to it. */
    public static func signIn(origin: String) -> ApprovalWire {
        ApprovalWire(send: transport(origin: origin, cookie: nil))
    }

    /* Under `session`, and no other: a request made for one account never goes out under another's. */
    public static func signedIn(_ session: SharedKeychain.Session) -> ApprovalWire {
        let name = session.origin.hasPrefix("https:") ? "__Host-hushos-session" : "hushos-session"
        return ApprovalWire(session: session.tag, send: transport(origin: session.origin, cookie: "\(name)=\(session.token)"))
    }

    /* Under the session this phone holds now; nil with nobody signed in. */
    public static var current: ApprovalWire? { Auth.currentSession.map(signedIn) }

    private static func transport(origin: String, cookie: String?) -> Send {
        { method, path, body, stepToken in
            guard let url = URL(string: origin + path) else { throw AuthError.message("Bad HushOS address.") }
            var request = URLRequest(url: url)
            request.httpMethod = method
            request.httpShouldHandleCookies = false
            request.setValue(origin, forHTTPHeaderField: "Origin")
            request.setValue(DriveAPI.clientHeader, forHTTPHeaderField: "HushOS-Client")
            if let cookie { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
            if let stepToken { request.setValue(stepToken, forHTTPHeaderField: "x-step-token") }
            if let body {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = Data(body.utf8)
            }
            request.timeoutInterval = 30
            do {
                let (data, response) = try await URLSession(configuration: Auth.testTransport ?? .ephemeral).data(for: request)
                return Reply(status: (response as? HTTPURLResponse)?.statusCode ?? 0, text: String(data: data, encoding: .utf8) ?? "")
            } catch {
                if ErrorWords.isCancellation(error) { throw CancellationError() }
                throw AuthError.message(AuthError.unreachable)
            }
        }
    }

    /* What a refusal is thrown as: an ended session as everywhere, anything else in the server's own words with its code. */
    func refused(_ reply: Reply, _ refusal: StepRefusal, _ message: String) -> Error {
        if reply.status == 401, refusal == .other, session != nil { return AuthError.sessionEnded(session: session) }
        return StepError.refused(refusal, message)
    }
}

/* A reply that was not the server's answer, to a request that changes nothing by being asked again. */
struct Unanswered: Error, WordedError {
    var errorDescription: String? { ErrorWords.generic }
}

/* MARK: The key a phone asks with */

/*
 * The device key a sign-in asks another device with (docs/two-step-design.md 12, "The asking
 * device's key"). A phone the account knows, which just proved its key to the server, asks with
 * that key. A phone signing in for the first time makes its device key now, before it has a
 * session, commits to it, and registers with it once it is in (`Auth.registerDevice(made:)`): the
 * key another device approved is the key the phone then has.
 */
public struct StepDeviceKey: Sendable, Equatable {
    /* The 32-byte public key, base64url: what is committed to, and later revealed. */
    public let publicKey: String
    /* Made for this sign-in; nil for the phone's own stored key. */
    let made: DeviceSigningKey?

    /* `identity`: the stored key whose proof this sign-in sent; nil when it sent none. Nil back when no key could be had: nothing is asked then. */
    static func forSignIn(proved identity: SharedKeychain.DeviceIdentity?) -> StepDeviceKey? {
        if let identity {
            return DeviceApprovals.publicKey(of: identity).map { StepDeviceKey(publicKey: $0, made: nil) }
        }
        guard let made = try? deviceSigningCreate() else { return nil }
        return StepDeviceKey(publicKey: base64urlEncode(bytes: made.publicKey), made: made)
    }
}

/* MARK: The phone that asks */

/*
 * One request to another device, from the phone that holds the step token. Made with the
 * commitment and nothing else; the key and the nonce behind it are revealed once a device has
 * opened the request (the server then holds that device's own value, fixed), and only once.
 */
public actor DeviceAsk {
    /* Where the request stands, as the asking screen shows it. */
    public enum State: Sendable, Equatable {
        /* No device has opened it: there is no code yet, only the QR code. */
        case waiting
        /* A device opened it: the code to type there. */
        case code(String)
        /* Approved: the step can be answered with this request. */
        case approved
        /* Over without an approval. */
        case ended(ApprovalEnded)
    }

    public nonisolated let requestId: String
    /* What a camera on the other device reads, in place of typing the code. */
    public nonisolated let qr: String
    /* The step token the request was made for. */
    public nonisolated let token: String
    private let wire: ApprovalWire
    private let step: DeviceStep
    private let nonce: String
    private var revealed = false
    private var code: String?
    /* On the clock nobody can set: the request ends with its token, whatever the phone's date says. */
    private let began: ContinuousClock.Instant = .now

    private init(wire: ApprovalWire, token: String, qr: String, step: DeviceStep, nonce: String) {
        self.wire = wire
        self.token = token
        self.qr = qr
        self.step = step
        self.nonce = nonce
        requestId = step.requestId
    }

    /* What a step answered with this request carries. */
    public nonisolated var answer: StepAnswer { StepAnswer(token: token, proof: .device(requestId: requestId)) }

    /*
     * Makes the request for `stepToken`. `purpose` is what the token is for (`login`, a change's own
     * purpose, or `device-approval` when the method is being turned on); `deviceSigningKey` this
     * phone's device key, base64url. `name` is what the phone calls itself, used only by a server
     * that does not know it yet. A refusal is thrown in the server's words (`StepError.refused`).
     */
    public static func start(
        wire: ApprovalWire, stepToken: String, purpose: String, deviceSigningKey: String, name: String, kind: String = "ios"
    ) async throws -> DeviceAsk {
        let digest = stepTokenDigest(stepToken: stepToken)
        let nonce = base64urlEncode(bytes: try randomBytes(length: 32))
        let commitment = try deviceStepCommitment(purpose: purpose, tokenDigest: digest, deviceSigningKey: deviceSigningKey, nonce: nonce)
        let reply = try await wire.send("POST", "/api/auth/approvals", approvalStartJson(stepToken: stepToken, commitment: commitment, kind: kind, name: name), nil)
        switch approvalStartReplyRead(status: reply.code, body: reply.text) {
        case .started(let requestId, let userId, _):
            let step = DeviceStep(userId: userId, requestId: requestId, purpose: purpose, tokenDigest: digest, deviceSigningKey: deviceSigningKey)
            return DeviceAsk(wire: wire, token: stepToken, qr: try approvalQr(requestId: requestId, commitment: commitment), step: step, nonce: nonce)
        case .refused(let refusal, let message):
            throw wire.refused(reply, refusal, message)
        case .lost:
            throw Unanswered()
        }
    }

    /*
     * Asks where the request stands, and reveals once it may. Before a device opened it nothing is
     * revealed: the commitment is all the server and the other device hold. The code is worked out
     * from the first value the other device fixed, and stays that one.
     */
    public func poll() async throws -> State {
        let reply = try await wire.send("GET", "/api/auth/approvals/\(requestId)", nil, token)
        switch approvalStatusReplyRead(status: reply.code, body: reply.text) {
        case .lost:
            throw Unanswered()
        case .refused(let refusal, let message):
            throw wire.refused(reply, refusal, message)
        case .status(let state, let approverKey, let ended):
            switch state {
            case .waiting:
                return .waiting
            case .ended:
                return .ended(ended ?? .refused)
            case .opened, .revealed, .approved:
                // The core reads none of these without the other device's value.
                guard let approverKey else { throw Unanswered() }
                let shown: String
                if let code { shown = code } else {
                    shown = try deviceStepCode(step: step, approverKey: approverKey, nonce: nonce)
                    code = shown
                }
                if state == .opened { try await reveal() }
                return state == .approved ? .approved : .code(shown)
            }
        }
    }

    /* Once: marked before the request goes, so a second look that overlaps it never sends another; unmarked only when nothing says the server took it. */
    private func reveal() async throws {
        guard !revealed else { return }
        revealed = true
        do {
            let body = approvalRevealJson(stepToken: token, deviceSigningKey: step.deviceSigningKey, nonce: nonce)
            let reply = try await wire.send("POST", "/api/auth/approvals/\(requestId)/reveal", body, nil)
            switch approvalAckReplyRead(status: reply.code, body: reply.text) {
            case .done:
                return
            case .refused(let refusal, let message):
                // `device-mismatch` ended the request; any refusal here is the server's last word on this reveal.
                throw wire.refused(reply, refusal, message)
            case .lost:
                throw Unanswered()
            }
        } catch let refusal as StepError {
            throw refusal
        } catch {
            // No answer: the server says `revealed` at the next look if it took this one, and nothing is sent again then.
            revealed = false
            throw error
        }
    }

    /*
     * Looks every `interval` until the request is approved or over, telling `shown` each state on
     * the way. A look that got no answer is made again; a refusal in the server's words is thrown.
     * A request nothing was heard of for as long as a step lasts is over.
     */
    public func wait(every interval: Duration = .seconds(2), shown: @Sendable (State) async -> Void = { _ in }) async throws -> State {
        while true {
            try Task.checkCancellation()
            if began.duration(to: .now) > PendingSignIn.life {
                await shown(.ended(.over))
                return .ended(.over)
            }
            do {
                let state = try await poll()
                await shown(state)
                switch state {
                case .approved, .ended: return state
                case .waiting, .code: break
                }
            } catch let refusal as StepError {
                throw refusal
            } catch let ended as AuthError {
                if case .sessionEnded = ended { throw ended }
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                // Nothing came back: asked again.
            }
            try await Task.sleep(for: interval)
        }
    }

    /*
     * Waits for the approval, then hands `answer` what the step is answered with. Never before the
     * request is approved. `step-pending` from `answer` is not a wrong answer and not an error: the
     * approval had not landed where the answer went, nothing was counted, and the wait goes on.
     * Nil when the request ended without an approval: `answer` was never called.
     */
    public func answered<Done: Sendable>(
        every interval: Duration = .seconds(2), shown: @Sendable (State) async -> Void = { _ in }, answer: @Sendable (StepAnswer) async throws -> Done
    ) async throws -> Done? {
        while true {
            guard case .approved = try await wait(every: interval, shown: shown) else { return nil }
            do {
                return try await answer(self.answer)
            } catch StepError.refused(.pending, _) {
                try await Task.sleep(for: interval)
            }
        }
    }
}

/* MARK: The phone that answers */

/*
 * The approving phone's own limit on prompts (docs/two-step-design.md 12): at most five a day for
 * each class of request, whatever the server lists, counted by the core (`approvalPromptsAllowed`).
 * What it counted is kept with the account's state on this phone and goes with it at sign-out.
 */
public struct PromptLimit: Sendable {
    let load: @Sendable () -> String
    let save: @Sendable (String) -> Void

    public init(load: @escaping @Sendable () -> String, save: @escaping @Sendable (String) -> Void) {
        self.load = load
        self.save = save
    }

    private struct Kept: Codable { let record: String }
    static let file = "approval-prompts.json"
    public static let stored = PromptLimit(load: { Unbacked.read(Kept.self, file)?.record ?? "" }, save: { Unbacked.write(Kept(record: $0), file) })

    /* Today as this phone writes it ("2026-11-14"): the day the count is for. */
    public static func day(_ date: Date = Date(), calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /* The requests to show of those the server lists, in its order. */
    public func shown(_ listed: [ApprovalPrompt], day: String = PromptLimit.day()) -> [ApprovalPrompt] {
        // Nothing listed is nothing to count: the list is looked at every few seconds, and mostly empty.
        guard !listed.isEmpty else { return [] }
        let kept = load()
        let allowed = approvalPromptsAllowed(record: kept, day: day, requests: listed.map { PromptRequest(id: $0.id, class: $0.class) })
        if allowed.record != kept { save(allowed.record) }
        return listed.filter { allowed.shown.contains($0.id) }
    }
}

public enum DeviceApprovals {
    /* This phone's device key, when it is the signed-in account's: what it asks with at a change, and signs approvals with. */
    public static func identity(for session: SharedKeychain.Session?, stored: SharedKeychain.DeviceIdentity? = SharedKeychain.deviceIdentity) -> SharedKeychain.DeviceIdentity? {
        guard let session, let stored, stored.userId.lowercased() == session.userId.lowercased() else { return nil }
        return stored
    }

    static func publicKey(of identity: SharedKeychain.DeviceIdentity) -> String? {
        guard let seed = try? base64urlDecode(value: identity.seed), let key = try? deviceSigningPublicKey(seed: seed) else { return nil }
        return base64urlEncode(bytes: key)
    }

    /* The public half, base64url, for the session given; nil on a phone that has no device key for it. */
    public static func ownKey(for session: SharedKeychain.Session?) -> String? { identity(for: session).flatMap(publicKey) }
    /* For the session this phone holds now. */
    public static var ownKey: String? { ownKey(for: Auth.currentSession) }

    /*
     * The requests this phone may answer now, after its own limit. A phone with no device key can
     * approve nothing and asks nothing.
     */
    public static func list(wire: ApprovalWire, limit: PromptLimit = .stored, day: String = PromptLimit.day()) async throws -> [ApprovalPrompt] {
        limit.shown(try await listed(wire: wire), day: day)
    }

    /* Everything the server lists for this phone, uncounted: for a request already on screen. */
    static func listed(wire: ApprovalWire) async throws -> [ApprovalPrompt] {
        let reply = try await wire.send("GET", "/api/auth/approvals", nil, nil)
        switch approvalsReplyRead(status: reply.code, body: reply.text) {
        case .listed(let approvals): return approvals
        case .refused(let refusal, let message): throw wire.refused(reply, refusal, message)
        case .lost: throw Unanswered()
        }
    }
}

/* Why an approval did not happen, in words for the person who was answering. */
public enum ApprovalProblem: Error, WordedError, Equatable, Sendable {
    /* The other screen's code, or what the other device revealed, is not the request this phone saw: ended, nothing signed. */
    case mismatch
    /* The typed code was not the code: ended, nothing signed. */
    case wrongCode
    /* The request is over, or another device has it: the server's words. */
    case over(String)

    public var errorDescription: String? {
        switch self {
        case .mismatch: StepWords.approvalMismatch
        case .wrongCode: StepWords.approvalWrongCode
        case .over(let message): message
        }
    }
}

/*
 * One request, on the phone that answers it. It holds the request as it was listed before this
 * phone opened it: the purpose, the token's digest and the commitment are those, whatever the
 * server lists afterwards. The account id in what is signed is this phone's own.
 */
public actor ApprovalAnswering {
    /* Why the request is ended from here. `mismatch` is not a failed step; the others are. */
    public enum Ending: String, Sendable {
        case denied, wrongCode = "wrong-code", notMe = "not-me", mismatch
    }

    public nonisolated let id: String
    /* "Sign-in on Chrome on Windows, near Lyon, France": what is asked, by which device, and roughly from where when the server was told. */
    public nonisolated let asks: String
    private let asked: ApprovalPrompt
    private let wire: ApprovalWire
    private let userId: String
    private let seed: Data
    /* This phone's own value, once it opened the request: the first one, if it opened it before. */
    private var approverKey: String?
    /* The code this phone expects, and what it signs, once the other device revealed what it committed to. */
    private var ready: (code: String, step: DeviceStep)?
    /* The other screen's QR code was read, and it was this request: the commitment was the check, and no code is typed. */
    public private(set) var scanned = false

    /* `prompt`: the request as listed before this phone opened it. `userId` and `seed`: this phone's own account id and device key. */
    public init(prompt: ApprovalPrompt, wire: ApprovalWire, userId: String, seed: Data) {
        id = prompt.id
        asks = approvalAsks(purpose: prompt.purpose, deviceName: prompt.deviceName, location: prompt.location)
        asked = prompt
        self.wire = wire
        self.userId = userId
        self.seed = seed
    }

    private func post(_ action: String, _ body: String) async throws -> ApprovalAckReply {
        let reply = try await wire.send("POST", "/api/auth/approvals/\(id)/\(action)", body, nil)
        let read = approvalAckReplyRead(status: reply.code, body: reply.text)
        if case .refused(let refusal, let message) = read {
            if reply.status == 401, refusal == .other { throw AuthError.sessionEnded(session: wire.session) }
            // Over, taken by another device, or a signature that did not verify: the server's own sentence.
            throw ApprovalProblem.over(message)
        }
        return read
    }

    /*
     * What a camera read from the other screen. False for anything that is not an approval's code
     * (another QR code in view): nothing happens. A code for another request, or with another
     * commitment than the server listed for this one, is not the request on that screen: this one
     * is ended (`mismatch`) and nothing is opened. Otherwise the request is opened.
     */
    public func open(scanned text: String) async throws -> Bool {
        guard let read = approvalQrRead(text: text) else { return false }
        guard read.requestId == asked.id, read.commitment == asked.commitment else {
            try? await end(.mismatch)
            throw ApprovalProblem.mismatch
        }
        try await open()
        scanned = true
        return true
    }

    /* Opens the request: this phone's own 32 fresh bytes go in, and only then does the other device reveal. */
    public func open() async throws {
        guard approverKey == nil else { return }
        let own = try asked.approverKey ?? base64urlEncode(bytes: randomBytes(length: 32))
        guard case .done(let key?) = try await post("open", approvalOpenJson(ephemeralKey: own)) else { throw Unanswered() }
        approverKey = key
    }

    /*
     * One look for what the other device revealed. False while it has not. What it revealed must be
     * what it committed to before this phone opened the request, for the purpose and token listed
     * then: if it is not, no honest device is on the other side, the request is ended (`mismatch`)
     * and nothing is ever signed for it. A request that left the list is over.
     */
    public func revealed() async throws -> Bool {
        if ready != nil { return true }
        guard let approverKey else { return false }
        guard let now = try await DeviceApprovals.listed(wire: wire).first(where: { $0.id == id }) else { throw ApprovalProblem.over(StepWords.approvalOver) }
        guard let key = now.revealKey, let nonce = now.revealNonce else { return false }
        let step = DeviceStep(userId: userId, requestId: id, purpose: asked.purpose, tokenDigest: asked.tokenDigest, deviceSigningKey: key)
        do {
            ready = (try approvalCodeExpected(step: step, commitment: asked.commitment, approverKey: approverKey, nonce: nonce), step)
            return true
        } catch {
            try? await end(.mismatch)
            throw ApprovalProblem.mismatch
        }
    }

    /* Looks every `interval` until the other device revealed. A look that got no answer is made again. */
    public func awaitReveal(every interval: Duration = .seconds(2)) async throws {
        let began = ContinuousClock.now
        while true {
            try Task.checkCancellation()
            do {
                if try await revealed() { return }
            } catch let problem as ApprovalProblem {
                throw problem
            } catch let ended as AuthError {
                if case .sessionEnded = ended { throw ended }
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                // Nothing came back: asked again.
            }
            if began.duration(to: .now) > PendingSignIn.life { throw ApprovalProblem.over(StepWords.approvalOver) }
            try await Task.sleep(for: interval)
        }
    }

    /*
     * Approves. After a scan the commitment was the check and nothing is typed (`typed` nil).
     * Otherwise only the exact code is approved: anything else ends the request (`wrong-code`),
     * and nothing is signed. The signature is this phone's device key's, over the statement that
     * names this phone's own account, the request, its purpose, its token and the asking device.
     */
    public func approve(typed: String?) async throws {
        guard let ready else { throw Unanswered() }
        if !(scanned && typed == nil) {
            guard let typed, approvalCodeNormalize(typed: typed) == ready.code else {
                try? await end(.wrongCode)
                throw ApprovalProblem.wrongCode
            }
        }
        let signature = try deviceStepSign(seed: seed, step: ready.step)
        guard case .done = try await post("approve", approvalApproveJson(signature: signature)) else { throw StepError.lost(StepWords.lostChange) }
    }

    /* Deny, or This wasn’t me: the request ends, and is counted as a failed step. */
    public func end(_ why: Ending) async throws {
        guard case .done = try await post("deny", approvalDenyJson(reason: why.rawValue)) else { throw StepError.lost(StepWords.lostChange) }
    }
}

/* MARK: Turning the method on */

/* A pending Approve on another device: its id, and the step token its one approval runs from (purpose `device-approval`). */
public struct DeviceEnrolment: Sendable, Equatable {
    public static let purpose = "device-approval"
    public let id: String
    public let token: String
}

public extension TwoStep {
    /*
     * Starts turning on Approve on another device: the password again and, once the step is on, the
     * step. Another device then approves the request made from the token this answers.
     */
    static func startDevice(password: String, twoStep: StepAnswer? = nil) async throws -> DeviceEnrolment {
        try await PasswordTurn.take()
        defer { PasswordTurn.shared.leaveSoon() }
        let reply = try await Auth.request("/api/auth/two-step/device", method: "POST", body: try await change(password, twoStep))
        switch deviceEnrolmentReplyRead(status: UInt16(clamping: reply.status), body: reply.text) {
        case .started(let id, let token, _): return DeviceEnrolment(id: id, token: token)
        case .refused, .lost: throw Auth.refusal(reply, whole: true, lost: StepWords.lostSetup) ?? StepError.lost(StepWords.lostSetup)
        }
    }

    /*
     * Confirms it with the request another device approved. `StepError.refused(.pending, …)` until
     * one has: nothing changed. Only the server's own two answers say it is on: the backup codes
     * when this turned the step on (`turnedOn`), or `replaced` never: `added` beside other methods.
     */
    static func confirmDevice(_ started: DeviceEnrolment, requestId: String) async throws -> DeviceConfirmed {
        let json = deviceConfirmJson(token: started.token, requestId: requestId)
        guard let body = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { throw AuthError.message(ErrorWords.generic) }
        let reply: Auth.SessionReply
        do {
            reply = try await Auth.request("/api/auth/two-step/device/\(started.id)/confirm", method: "POST", body: body)
        } catch AuthError.message(AuthError.unreachable) {
            throw StepError.lost(StepWords.lostDeviceOn)
        }
        switch deviceConfirmedReplyRead(status: UInt16(clamping: reply.status), body: reply.text) {
        case .turnedOn(let codes): return .turnedOn(codes)
        case .added: return .added
        case .refused(let refusal, let message):
            if reply.status == 401, refusal == .other { throw AuthError.sessionEnded(session: reply.session.tag) }
            throw StepError.refused(refusal, message)
        case .lost:
            throw StepError.lost(StepWords.lostDeviceOn)
        }
    }

    /* What confirming did: it turned the step on (the ten backup codes, shown once), or added the method beside the account's others. */
    enum DeviceConfirmed: Sendable, Equatable {
        case turnedOn([String])
        case added
    }
}
